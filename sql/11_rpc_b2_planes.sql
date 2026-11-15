-- ============================================================
-- El Tesorero — B2: Planes de pago y abonos
-- Archivo: sql/11_rpc_b2_planes.sql  (revisión 3)
--
-- ⚠️ Ejecutar solo en staging (rucgmytyxpfowznowxwd).
--    NO ejecutar en producción (tmjqzaakzhecbldebyeg).
-- ============================================================

BEGIN;

SET search_path = public;

-- Eliminar versiones anteriores
DROP FUNCTION IF EXISTS cerrar_plan_si_completo(UUID, UUID);
DROP FUNCTION IF EXISTS cerrar_plan_si_completo(UUID, TEXT);
DROP FUNCTION IF EXISTS reabrir_plan_pago(UUID, UUID);
DROP FUNCTION IF EXISTS reabrir_plan_pago(UUID, TEXT);
DROP FUNCTION IF EXISTS crear_plan_con_abonos(UUID, TEXT, TEXT, TEXT, INT, JSONB, TEXT);
DROP FUNCTION IF EXISTS crear_plan_con_abonos(UUID, TEXT, TEXT, TEXT, TEXT, INT, JSONB, TEXT);
DROP FUNCTION IF EXISTS pagar_abono(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS revertir_abono(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS editar_abono(UUID, TEXT, INT, TEXT);
DROP FUNCTION IF EXISTS eliminar_plan(UUID, TEXT);

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. crear_plan_con_abonos
--
-- Clave de idempotencia explícita: p_plan_id
-- ─── El cliente genera p_plan_id antes de enviar la petición y lo persiste
--     localmente antes de llamar al servidor. En un reintento envía el mismo
--     p_plan_id; la función lo reconoce y devuelve el plan ya creado.
--
-- Seguridad (SECURITY DEFINER):
--   La autorización se comprueba ANTES de devolver cualquier dato,
--   incluso en la ruta de idempotencia temprana (bloque 0) y en el
--   re-chequeo posterior al advisory lock (bloque 6).
--   Flujo: idenfificar plan existente → autorizar → devolver / crear.
--
-- Verificación de identidad completa en reintentos:
--   Compara alumno_id, cuota_id, periodo, monto_total y el calendario de
--   abonos (N abonos con sus montos y fechas) contra lo almacenado. Una
--   discrepancia en cualquiera de esos campos lanza idempotency_conflict.
--   Los abonos almacenados se leen desde la DB (no desde lo que envió el
--   cliente), así que ediciones posteriores a los abonos no alteran la
--   verificación.
--
-- Serialización concurrente: pg_advisory_xact_lock sobre el hash del
-- natural key (cuenta+alumno+cuota+periodo).
--
-- Validaciones financieras:
--   • monto_total > 0  • al menos 2 abonos
--   • cada abono con monto > 0 y fecha parseable
--   • suma de abonos = monto_total
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION crear_plan_con_abonos(
  p_cuenta_id   UUID,
  p_plan_id     TEXT,          -- clave de idempotencia; generada por el cliente
  p_alumno_id   TEXT,
  p_cuota_id    TEXT,
  p_periodo     TEXT,          -- ej. "Marzo 2026"; NULL para cuotas no-mensuales
  p_monto_total INT,
  p_abonos      JSONB,         -- [{monto:INT, fecha:"YYYY-MM-DD"}, …]  ≥ 2 elementos
  p_obs         TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_curso_id      TEXT;
  v_plan_json     JSONB;
  v_abonos_json   JSONB;
  v_existing_id   TEXT;
  v_ab            JSONB;
  v_ab_stored     JSONB;
  v_abono_id      TEXT;
  v_suma_abonos   INT := 0;
  v_n_abonos      INT;
  v_n_stored      INT;
  v_i             INT;
  v_stored_montos INT[];
  v_stored_fechas TEXT[];
BEGIN

  -- ════════════════════════════════════════════════════════════════════════════
  -- BLOQUE 0 — Idempotencia temprana (antes del advisory lock)
  -- Si p_plan_id ya existe, autorizar PRIMERO y luego devolver.
  -- ════════════════════════════════════════════════════════════════════════════
  SELECT row_to_json(pp.*)::JSONB
    INTO v_plan_json
    FROM planes_pago pp
   WHERE pp.id = p_plan_id AND pp.cuenta_id = p_cuenta_id
   FOR UPDATE;

  IF FOUND THEN

    -- ── 0a. Obtener curso_id del plan para autorizar ───────────────────────
    SELECT cu.curso_id INTO v_curso_id
      FROM cuotas cu
     WHERE cu.id = (v_plan_json->>'cuota_id') AND cu.cuenta_id = p_cuenta_id;

    -- ── 0b. Autorizar ANTES de devolver datos ─────────────────────────────
    IF NOT (
      es_dueno(p_cuenta_id) OR
      tiene_rol_en_curso(p_cuenta_id, v_curso_id, ARRAY['admin','tesorero'])
    ) THEN
      RAISE EXCEPTION 'permission_denied';
    END IF;

    -- ── 0c. Verificar identidad completa del reintento ─────────────────────
    --    Compara contra lo ALMACENADO en la DB (snapshot inmutable).
    --    Un reintento legítimo envía exactamente los mismos valores.

    IF (v_plan_json->>'alumno_id') <> p_alumno_id THEN
      RAISE EXCEPTION 'idempotency_conflict'
        USING HINT = format('alumno_id almacenado=%s, enviado=%s',
                             v_plan_json->>'alumno_id', p_alumno_id);
    END IF;

    IF (v_plan_json->>'cuota_id') <> p_cuota_id THEN
      RAISE EXCEPTION 'idempotency_conflict'
        USING HINT = format('cuota_id almacenada=%s, enviada=%s',
                             v_plan_json->>'cuota_id', p_cuota_id);
    END IF;

    IF (v_plan_json->>'periodo') IS DISTINCT FROM p_periodo THEN
      RAISE EXCEPTION 'idempotency_conflict'
        USING HINT = format('periodo almacenado=%s, enviado=%s',
                             v_plan_json->>'periodo', p_periodo);
    END IF;

    IF (v_plan_json->>'monto_total')::INT <> p_monto_total THEN
      RAISE EXCEPTION 'idempotency_conflict'
        USING HINT = format('monto_total almacenado=%s, enviado=%s',
                             v_plan_json->>'monto_total', p_monto_total);
    END IF;

    -- Verificar calendario de abonos: N, montos y fechas (orden ascendente)
    SELECT jsonb_agg(row_to_json(ab.*)::JSONB ORDER BY ab.fecha, ab.monto)
      INTO v_abonos_json
      FROM abonos ab
     WHERE ab.plan_id = p_plan_id AND ab.cuenta_id = p_cuenta_id;

    v_n_stored := COALESCE(jsonb_array_length(v_abonos_json), 0);
    v_n_abonos := COALESCE(jsonb_array_length(p_abonos), 0);

    IF v_n_stored <> v_n_abonos THEN
      RAISE EXCEPTION 'idempotency_conflict'
        USING HINT = format('numero de abonos almacenados=%s, enviados=%s',
                             v_n_stored, v_n_abonos);
    END IF;

    -- Comparar cada abono en orden (almacenados ordenados por fecha,monto)
    -- Reordenar también los enviados para comparación consistente.
    -- Usamos arrays temporales para iterar sin cursor adicional.
    SELECT  array_agg((val->>'monto')::INT  ORDER BY (val->>'fecha')::DATE, (val->>'monto')::INT),
            array_agg((val->>'fecha')       ORDER BY (val->>'fecha')::DATE, (val->>'monto')::INT)
      INTO v_stored_montos, v_stored_fechas
      FROM jsonb_array_elements(v_abonos_json) AS val;

    -- Reordenar p_abonos de entrada
    FOR v_i IN 1 .. v_n_abonos LOOP
      v_ab := (
        SELECT val FROM jsonb_array_elements(p_abonos) AS val
         ORDER BY (val->>'fecha')::DATE, (val->>'monto')::INT
         LIMIT 1 OFFSET v_i - 1
      );
      IF (v_ab->>'monto')::INT <> v_stored_montos[v_i] THEN
        RAISE EXCEPTION 'idempotency_conflict'
          USING HINT = format('abono %s: monto almacenado=%s, enviado=%s',
                               v_i, v_stored_montos[v_i], v_ab->>'monto');
      END IF;
      IF (v_ab->>'fecha')::DATE <> v_stored_fechas[v_i]::DATE THEN
        RAISE EXCEPTION 'idempotency_conflict'
          USING HINT = format('abono %s: fecha almacenada=%s, enviada=%s',
                               v_i, v_stored_fechas[v_i], v_ab->>'fecha');
      END IF;
    END LOOP;

    RETURN jsonb_build_object(
      'plan',       v_plan_json,
      'abonos',     COALESCE(v_abonos_json, '[]'::JSONB),
      'idempotente', TRUE
    );
  END IF;

  -- ════════════════════════════════════════════════════════════════════════════
  -- BLOQUE 1 — Validaciones financieras (p_plan_id no existe aún)
  -- ════════════════════════════════════════════════════════════════════════════
  IF p_monto_total <= 0 THEN
    RAISE EXCEPTION 'monto_invalido'
      USING HINT = 'monto_total debe ser mayor que 0';
  END IF;

  v_n_abonos := COALESCE(jsonb_array_length(p_abonos), 0);
  IF v_n_abonos < 2 THEN
    RAISE EXCEPTION 'min_dos_abonos'
      USING HINT = format('se recibieron %s abonos, se requieren al menos 2', v_n_abonos);
  END IF;

  FOR v_ab IN SELECT value FROM jsonb_array_elements(p_abonos) LOOP
    IF COALESCE((v_ab->>'monto')::INT, 0) <= 0 THEN
      RAISE EXCEPTION 'abono_monto_invalido'
        USING HINT = format('cada abono debe tener monto > 0; recibido: %s', v_ab->>'monto');
    END IF;
    BEGIN
      PERFORM (v_ab->>'fecha')::DATE;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'abono_fecha_invalida'
        USING HINT = format('fecha no parseable: %s', v_ab->>'fecha');
    END;
    v_suma_abonos := v_suma_abonos + (v_ab->>'monto')::INT;
  END LOOP;

  IF v_suma_abonos <> p_monto_total THEN
    RAISE EXCEPTION 'suma_abonos_invalida'
      USING HINT = format('suma de abonos=%s, monto_total=%s; deben coincidir',
                           v_suma_abonos, p_monto_total);
  END IF;

  -- ════════════════════════════════════════════════════════════════════════════
  -- BLOQUE 2 — Verificar cuota, autorizar y verificar alumno
  -- ════════════════════════════════════════════════════════════════════════════
  SELECT cu.curso_id INTO v_curso_id
    FROM cuotas cu
   WHERE cu.id = p_cuota_id AND cu.cuenta_id = p_cuenta_id
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'cuota_not_found' USING HINT = p_cuota_id;
  END IF;

  IF NOT (
    es_dueno(p_cuenta_id) OR
    tiene_rol_en_curso(p_cuenta_id, v_curso_id, ARRAY['admin','tesorero'])
  ) THEN
    RAISE EXCEPTION 'permission_denied';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM alumnos
     WHERE id = p_alumno_id AND cuenta_id = p_cuenta_id AND curso_id = v_curso_id
  ) THEN
    RAISE EXCEPTION 'alumno_not_in_curso' USING HINT = p_alumno_id;
  END IF;

  -- ════════════════════════════════════════════════════════════════════════════
  -- BLOQUE 3 — Advisory lock + re-chequeo completo
  -- ════════════════════════════════════════════════════════════════════════════
  PERFORM pg_advisory_xact_lock(
    hashtext(p_cuenta_id::TEXT || '|' || p_alumno_id || '|' || p_cuota_id || '|'
             || COALESCE(p_periodo, ''))
  );

  -- Re-chequeo tras el lock: mismo plan_id (autorizado como en bloque 0)
  SELECT row_to_json(pp.*)::JSONB
    INTO v_plan_json
    FROM planes_pago pp
   WHERE pp.id = p_plan_id AND pp.cuenta_id = p_cuenta_id
   FOR UPDATE;

  IF FOUND THEN
    -- Autorizar antes de devolver (ya tenemos v_curso_id del bloque 2)
    IF NOT (
      es_dueno(p_cuenta_id) OR
      tiene_rol_en_curso(p_cuenta_id, v_curso_id, ARRAY['admin','tesorero'])
    ) THEN
      RAISE EXCEPTION 'permission_denied';
    END IF;

    -- Verificar identidad completa (misma lógica que bloque 0)
    IF (v_plan_json->>'alumno_id') <> p_alumno_id OR
       (v_plan_json->>'cuota_id')  <> p_cuota_id  OR
       (v_plan_json->>'periodo')   IS DISTINCT FROM p_periodo OR
       (v_plan_json->>'monto_total')::INT <> p_monto_total THEN
      RAISE EXCEPTION 'idempotency_conflict'
        USING HINT = 'El plan existente no coincide con los parámetros enviados';
    END IF;

    SELECT jsonb_agg(row_to_json(ab.*)::JSONB ORDER BY ab.fecha, ab.monto)
      INTO v_abonos_json
      FROM abonos ab
     WHERE ab.plan_id = p_plan_id AND ab.cuenta_id = p_cuenta_id;

    v_n_stored := COALESCE(jsonb_array_length(v_abonos_json), 0);
    IF v_n_stored <> jsonb_array_length(p_abonos) THEN
      RAISE EXCEPTION 'idempotency_conflict'
        USING HINT = format('numero de abonos: almacenados=%s, enviados=%s',
                             v_n_stored, jsonb_array_length(p_abonos));
    END IF;

    RETURN jsonb_build_object(
      'plan',       v_plan_json,
      'abonos',     COALESCE(v_abonos_json, '[]'::JSONB),
      'idempotente', TRUE
    );
  END IF;

  -- ════════════════════════════════════════════════════════════════════════════
  -- BLOQUE 4 — Verificar que no existe plan activo con otro plan_id
  -- ════════════════════════════════════════════════════════════════════════════
  SELECT id INTO v_existing_id
    FROM planes_pago
   WHERE cuenta_id = p_cuenta_id
     AND alumno_id = p_alumno_id
     AND cuota_id  = p_cuota_id
     AND periodo   IS NOT DISTINCT FROM p_periodo
     AND activo    = TRUE
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'duplicate_active_plan'
      USING HINT = format('ya existe plan activo %s para esta obligación', v_existing_id);
  END IF;

  -- ════════════════════════════════════════════════════════════════════════════
  -- BLOQUE 5 — Crear plan y abonos
  -- ════════════════════════════════════════════════════════════════════════════
  INSERT INTO planes_pago(id, cuenta_id, alumno_id, cuota_id, periodo, monto_total, activo, creado_en, obs)
  VALUES (p_plan_id, p_cuenta_id, p_alumno_id, p_cuota_id, p_periodo, p_monto_total,
          TRUE, CURRENT_DATE, p_obs);

  FOR v_ab IN SELECT value FROM jsonb_array_elements(p_abonos) LOOP
    v_abono_id := gen_random_uuid()::TEXT;
    INSERT INTO abonos(id, cuenta_id, alumno_id, cuota_id, plan_id, monto, fecha, pagado, fecha_pago, estado)
    VALUES (v_abono_id, p_cuenta_id, p_alumno_id, p_cuota_id, p_plan_id,
            (v_ab->>'monto')::INT, (v_ab->>'fecha')::DATE,
            FALSE, NULL, 'registrado');
  END LOOP;

  SELECT row_to_json(pp.*)::JSONB
    INTO v_plan_json
    FROM planes_pago pp
   WHERE pp.id = p_plan_id AND pp.cuenta_id = p_cuenta_id;

  SELECT jsonb_agg(row_to_json(ab.*)::JSONB ORDER BY ab.fecha)
    INTO v_abonos_json
    FROM abonos ab
   WHERE ab.plan_id = p_plan_id AND ab.cuenta_id = p_cuenta_id;

  RETURN jsonb_build_object(
    'plan',       v_plan_json,
    'abonos',     COALESCE(v_abonos_json, '[]'::JSONB),
    'idempotente', FALSE
  );
END;
$$;

REVOKE ALL ON FUNCTION crear_plan_con_abonos(UUID, TEXT, TEXT, TEXT, TEXT, INT, JSONB, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION crear_plan_con_abonos(UUID, TEXT, TEXT, TEXT, TEXT, INT, JSONB, TEXT) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. pagar_abono
--
-- Orden de bloqueos: PLAN primero, ABONO después.
-- Esto evita el deadlock con eliminar_plan (que también bloquea plan primero).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION pagar_abono(
  p_cuenta_id UUID,
  p_plan_id   TEXT,
  p_abono_id  TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_curso_id     TEXT;
  v_plan         RECORD;
  v_abono        RECORD;
  v_total        INT;
  v_pagados      INT;
  v_plan_cerrado BOOLEAN := FALSE;
BEGIN
  -- ── 1. Bloquear PLAN primero (orden determinístico) ───────────────────────
  SELECT pp.*, cu.curso_id
    INTO v_plan
    FROM planes_pago pp
    JOIN cuotas cu
      ON  cu.id        = pp.cuota_id
      AND cu.cuenta_id = pp.cuenta_id
   WHERE pp.id        = p_plan_id
     AND pp.cuenta_id = p_cuenta_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan_not_found' USING HINT = p_plan_id;
  END IF;

  v_curso_id := v_plan.curso_id;

  -- ── 2. Verificar autorización ─────────────────────────────────────────────
  IF NOT (
    es_dueno(p_cuenta_id) OR
    tiene_rol_en_curso(p_cuenta_id, v_curso_id, ARRAY['admin','tesorero'])
  ) THEN
    RAISE EXCEPTION 'permission_denied';
  END IF;

  -- ── 3. Bloquear ABONO (después del plan) ──────────────────────────────────
  SELECT *
    INTO v_abono
    FROM abonos
   WHERE id        = p_abono_id
     AND cuenta_id = p_cuenta_id
     AND plan_id   = p_plan_id      -- valida pertenencia al plan
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'abono_not_found' USING HINT = p_abono_id;
  END IF;

  -- ── 4. Idempotencia: abono ya pagado ──────────────────────────────────────
  IF v_abono.pagado = TRUE THEN
    RETURN jsonb_build_object(
      'abono_id',    p_abono_id,
      'plan_cerrado', NOT COALESCE(v_plan.activo, TRUE),
      'ya_pagado',   TRUE
    );
  END IF;

  -- ── 5. Marcar abono como pagado ───────────────────────────────────────────
  UPDATE abonos
     SET pagado    = TRUE,
         fecha_pago = CURRENT_DATE,
         estado    = 'pagado'
   WHERE id = p_abono_id AND cuenta_id = p_cuenta_id;

  -- ── 6. Contar abonos y cerrar plan si todos están pagados ─────────────────
  --    (ya tenemos el lock del plan desde paso 1)
  SELECT COUNT(*), COUNT(*) FILTER (WHERE pagado = TRUE)
    INTO v_total, v_pagados
    FROM abonos
   WHERE plan_id = p_plan_id AND cuenta_id = p_cuenta_id;

  -- G05: NO insertar en tabla pagos.
  IF v_total > 0 AND v_total = v_pagados THEN
    UPDATE planes_pago
       SET activo = FALSE
     WHERE id = p_plan_id AND cuenta_id = p_cuenta_id;
    v_plan_cerrado := TRUE;
  END IF;

  RETURN jsonb_build_object(
    'abono_id',    p_abono_id,
    'plan_cerrado', v_plan_cerrado,
    'ya_pagado',   FALSE,
    'total',       v_total,
    'pagados',     v_pagados
  );
END;
$$;

REVOKE ALL ON FUNCTION pagar_abono(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION pagar_abono(UUID, TEXT, TEXT) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. revertir_abono
--
-- Orden de bloqueos: PLAN primero, ABONO después (igual que pagar_abono).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION revertir_abono(
  p_cuenta_id UUID,
  p_plan_id   TEXT,
  p_abono_id  TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_curso_id TEXT;
  v_plan     RECORD;
  v_abono    RECORD;
BEGIN
  -- ── 1. Bloquear PLAN primero ──────────────────────────────────────────────
  SELECT pp.*, cu.curso_id
    INTO v_plan
    FROM planes_pago pp
    JOIN cuotas cu
      ON  cu.id        = pp.cuota_id
      AND cu.cuenta_id = pp.cuenta_id
   WHERE pp.id        = p_plan_id
     AND pp.cuenta_id = p_cuenta_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan_not_found' USING HINT = p_plan_id;
  END IF;

  v_curso_id := v_plan.curso_id;

  -- ── 2. Verificar autorización ─────────────────────────────────────────────
  IF NOT (
    es_dueno(p_cuenta_id) OR
    tiene_rol_en_curso(p_cuenta_id, v_curso_id, ARRAY['admin','tesorero'])
  ) THEN
    RAISE EXCEPTION 'permission_denied';
  END IF;

  -- ── 3. Bloquear ABONO (después del plan) ──────────────────────────────────
  SELECT *
    INTO v_abono
    FROM abonos
   WHERE id        = p_abono_id
     AND cuenta_id = p_cuenta_id
     AND plan_id   = p_plan_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'abono_not_found' USING HINT = p_abono_id;
  END IF;

  -- ── 4. Idempotencia: abono ya no está pagado ──────────────────────────────
  IF v_abono.pagado = FALSE THEN
    RETURN jsonb_build_object('abono_id', p_abono_id, 'ya_no_pagado', TRUE);
  END IF;

  -- ── 5. Revertir abono ─────────────────────────────────────────────────────
  UPDATE abonos
     SET pagado    = FALSE,
         fecha_pago = NULL,
         estado    = 'registrado'
   WHERE id = p_abono_id AND cuenta_id = p_cuenta_id;

  -- ── 6. Reabrir plan (ya tenemos el lock desde paso 1) ─────────────────────
  UPDATE planes_pago
     SET activo = TRUE
   WHERE id = p_plan_id AND cuenta_id = p_cuenta_id;

  RETURN jsonb_build_object('abono_id', p_abono_id, 'ya_no_pagado', FALSE);
END;
$$;

REVOKE ALL ON FUNCTION revertir_abono(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION revertir_abono(UUID, TEXT, TEXT) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. editar_abono
--
-- Actualiza monto y/o fecha de un abono NO pagado.
-- Mantiene coherente planes_pago.monto_total cuando cambia el monto.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION editar_abono(
  p_cuenta_id UUID,
  p_abono_id  TEXT,
  p_monto     INT  DEFAULT NULL,   -- NULL = no cambiar
  p_fecha     TEXT DEFAULT NULL    -- NULL = no cambiar  ("YYYY-MM-DD")
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_curso_id  TEXT;
  v_plan      RECORD;
  v_abono     RECORD;
  v_delta     INT := 0;
  v_abono_json JSONB;
BEGIN
  -- Validar monto si se provee
  IF p_monto IS NOT NULL AND p_monto <= 0 THEN
    RAISE EXCEPTION 'abono_monto_invalido'
      USING HINT = 'el monto del abono debe ser mayor que 0';
  END IF;

  IF p_fecha IS NOT NULL THEN
    BEGIN
      PERFORM p_fecha::DATE;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'abono_fecha_invalida' USING HINT = p_fecha;
    END;
  END IF;

  -- ── 1. Cargar abono (sin lock todavía para obtener plan_id) ───────────────
  SELECT ab.*, cu.curso_id
    INTO v_abono
    FROM abonos ab
    JOIN cuotas cu
      ON  cu.id        = ab.cuota_id
      AND cu.cuenta_id = ab.cuenta_id
   WHERE ab.id        = p_abono_id
     AND ab.cuenta_id = p_cuenta_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'abono_not_found' USING HINT = p_abono_id;
  END IF;

  v_curso_id := v_abono.curso_id;

  -- ── 2. Verificar autorización ─────────────────────────────────────────────
  IF NOT (
    es_dueno(p_cuenta_id) OR
    tiene_rol_en_curso(p_cuenta_id, v_curso_id, ARRAY['admin','tesorero'])
  ) THEN
    RAISE EXCEPTION 'permission_denied';
  END IF;

  -- ── 3. Bloquear PLAN primero (si existe plan_id) ──────────────────────────
  IF v_abono.plan_id IS NOT NULL THEN
    SELECT * INTO v_plan
      FROM planes_pago
     WHERE id = v_abono.plan_id AND cuenta_id = p_cuenta_id
     FOR UPDATE;
  END IF;

  -- ── 4. Bloquear ABONO ─────────────────────────────────────────────────────
  SELECT * INTO v_abono
    FROM abonos
   WHERE id = p_abono_id AND cuenta_id = p_cuenta_id
   FOR UPDATE;

  -- ── 5. Rechazar si ya está pagado ─────────────────────────────────────────
  IF v_abono.pagado = TRUE THEN
    RAISE EXCEPTION 'abono_ya_pagado' USING HINT = p_abono_id;
  END IF;

  -- ── 6. Calcular delta del monto ───────────────────────────────────────────
  IF p_monto IS NOT NULL THEN
    v_delta := p_monto - v_abono.monto;
  END IF;

  -- ── 7. Actualizar abono ───────────────────────────────────────────────────
  UPDATE abonos
     SET monto = COALESCE(p_monto,        monto),
         fecha = COALESCE(p_fecha::DATE,  fecha)
   WHERE id = p_abono_id AND cuenta_id = p_cuenta_id;

  -- ── 8. Mantener coherencia de monto_total en el plan ─────────────────────
  IF v_delta <> 0 AND v_abono.plan_id IS NOT NULL THEN
    UPDATE planes_pago
       SET monto_total = monto_total + v_delta
     WHERE id = v_abono.plan_id AND cuenta_id = p_cuenta_id;
  END IF;

  -- ── 9. Devolver abono actualizado ─────────────────────────────────────────
  SELECT row_to_json(ab.*)::JSONB
    INTO v_abono_json
    FROM abonos ab
   WHERE ab.id = p_abono_id AND ab.cuenta_id = p_cuenta_id;

  RETURN jsonb_build_object('abono', v_abono_json);
END;
$$;

REVOKE ALL ON FUNCTION editar_abono(UUID, TEXT, INT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION editar_abono(UUID, TEXT, INT, TEXT) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. eliminar_plan
--
-- Bloquea el plan primero (FOR UPDATE).
-- Después verifica abonos pagados (consulta sin lock adicional, ya tenemos
-- el lock del plan que impide a pagar_abono modificar esos abonos).
-- Orden: PLAN → comprobar abonos → DELETE abonos → DELETE plan.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION eliminar_plan(
  p_cuenta_id UUID,
  p_plan_id   TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_curso_id    TEXT;
  v_pagados_cnt INT;
BEGIN
  -- ── 1. Bloquear PLAN primero ──────────────────────────────────────────────
  SELECT cu.curso_id INTO v_curso_id
    FROM planes_pago pp
    JOIN cuotas cu
      ON  cu.id        = pp.cuota_id
      AND cu.cuenta_id = pp.cuenta_id
   WHERE pp.id        = p_plan_id
     AND pp.cuenta_id = p_cuenta_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan_not_found' USING HINT = p_plan_id;
  END IF;

  -- ── 2. Verificar autorización ─────────────────────────────────────────────
  IF NOT (
    es_dueno(p_cuenta_id) OR
    tiene_rol_en_curso(p_cuenta_id, v_curso_id, ARRAY['admin','tesorero'])
  ) THEN
    RAISE EXCEPTION 'permission_denied';
  END IF;

  -- ── 3. Bloquear ABONOS para evitar pago concurrente ──────────────────────
  --    Con el lock del plan ya adquirido, pagar_abono que intente el mismo plan
  --    esperará; pero otros cursores con acceso directo a abonos podrían competir.
  --    Bloquear todos los abonos del plan con FOR UPDATE garantiza la lectura
  --    consistente del flag pagado.
  PERFORM id FROM abonos
   WHERE plan_id = p_plan_id AND cuenta_id = p_cuenta_id
   FOR UPDATE;

  -- ── 4. Verificar que no hay abonos pagados ────────────────────────────────
  SELECT COUNT(*) INTO v_pagados_cnt
    FROM abonos
   WHERE plan_id = p_plan_id AND cuenta_id = p_cuenta_id AND pagado = TRUE;

  IF v_pagados_cnt > 0 THEN
    RAISE EXCEPTION 'plan_con_abonos_pagados'
      USING HINT = v_pagados_cnt::TEXT;
  END IF;

  -- ── 5. Eliminar abonos y plan ─────────────────────────────────────────────
  DELETE FROM abonos    WHERE plan_id    = p_plan_id AND cuenta_id = p_cuenta_id;
  DELETE FROM planes_pago WHERE id       = p_plan_id AND cuenta_id = p_cuenta_id;

  RETURN jsonb_build_object('plan_id', p_plan_id, 'eliminado', TRUE);
END;
$$;

REVOKE ALL ON FUNCTION eliminar_plan(UUID, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION eliminar_plan(UUID, TEXT) TO authenticated;


COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- Verificación post-ejecución (ejecutar por separado en staging):
-- ═══════════════════════════════════════════════════════════════════════════
--
-- SELECT routine_name
--   FROM information_schema.routines
--  WHERE routine_schema = 'public'
--    AND routine_name IN (
--      'crear_plan_con_abonos','pagar_abono','revertir_abono',
--      'editar_abono','eliminar_plan'
--    )
--  ORDER BY routine_name;
-- -- Resultado esperado: 5 filas.
