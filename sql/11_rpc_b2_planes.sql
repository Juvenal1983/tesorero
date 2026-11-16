-- ============================================================
-- El Tesorero — B2: Planes de pago y abonos
-- Archivo: sql/11_rpc_b2_planes.sql  (revisión 4)
--
-- ⚠️ Ejecutar solo en staging (rucgmytyxpfowznowxwd).
--    NO ejecutar en producción (tmjqzaakzhecbldebyeg).
--
-- Rev 4: snapshot inmutable (solicitud_json) + helpers compartidos
--   • _sort_abonos(JSONB): ordena el arreglo de abonos de forma canónica
--   • _cmp_solicitud_plan(...): compara parámetros contra el snapshot usando
--     IS DISTINCT FROM en todos los campos (NULL-safe)
--   • crear_plan_con_abonos: almacena solicitud_json en el INSERT; los bloques
--     0 y 6 (re-chequeo post-lock) llaman a _cmp_solicitud_plan en lugar de
--     comparar contra el estado mutable actual.  Tras un editar_abono, el
--     snapshot original permanece inalterado y el reintento lo reconoce.
-- ============================================================

BEGIN;

SET search_path = public;

-- ─── Eliminar versiones anteriores ──────────────────────────────────────────
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
DROP FUNCTION IF EXISTS _sort_abonos(JSONB);
DROP FUNCTION IF EXISTS _cmp_solicitud_plan(JSONB, TEXT, TEXT, TEXT, INT, JSONB);

-- ─── Columna inmutable para el snapshot de creación ─────────────────────────
-- Idempotente: solo añade la columna si no existe.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'planes_pago'
       AND column_name  = 'solicitud_json'
  ) THEN
    ALTER TABLE planes_pago ADD COLUMN solicitud_json JSONB;
  END IF;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Helper privado 1: _sort_abonos
-- Devuelve el arreglo ordenado por (fecha ASC, monto ASC) para comparación
-- canónica.  IMMUTABLE porque no lee tablas.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _sort_abonos(p_abonos JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE STRICT
SET search_path = public
AS $$
  SELECT COALESCE(
    jsonb_agg(val ORDER BY (val->>'fecha')::DATE, (val->>'monto')::INT),
    '[]'::JSONB
  )
  FROM jsonb_array_elements(p_abonos) val
$$;

REVOKE ALL ON FUNCTION _sort_abonos(JSONB) FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────────
-- Helper privado 2: _cmp_solicitud_plan
-- Compara los parámetros del reintento contra el snapshot inmutable almacenado
-- en planes_pago.solicitud_json.  Lanza idempotency_conflict si difieren.
-- Usa IS DISTINCT FROM en todos los campos (NULL-safe).
-- Recibe p_abonos_sent ya ordenado con _sort_abonos.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _cmp_solicitud_plan(
  p_snap        JSONB,
  p_alumno_id   TEXT,
  p_cuota_id    TEXT,
  p_periodo     TEXT,
  p_monto_total INT,
  p_abonos_sent JSONB   -- ya ordenado por _sort_abonos
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_n INT;
  v_i INT;
BEGIN
  IF (p_snap->>'alumno_id') IS DISTINCT FROM p_alumno_id THEN
    RAISE EXCEPTION 'idempotency_conflict'
      USING HINT = format('alumno_id almacenado=%s enviado=%s',
                           p_snap->>'alumno_id', p_alumno_id);
  END IF;

  IF (p_snap->>'cuota_id') IS DISTINCT FROM p_cuota_id THEN
    RAISE EXCEPTION 'idempotency_conflict'
      USING HINT = format('cuota_id almacenado=%s enviado=%s',
                           p_snap->>'cuota_id', p_cuota_id);
  END IF;

  IF (p_snap->>'periodo') IS DISTINCT FROM p_periodo THEN
    RAISE EXCEPTION 'idempotency_conflict'
      USING HINT = format('periodo almacenado=%s enviado=%s',
                           p_snap->>'periodo', p_periodo);
  END IF;

  IF (p_snap->>'monto_total')::INT IS DISTINCT FROM p_monto_total THEN
    RAISE EXCEPTION 'idempotency_conflict'
      USING HINT = format('monto_total almacenado=%s enviado=%s',
                           p_snap->>'monto_total', p_monto_total);
  END IF;

  v_n := jsonb_array_length(p_snap->'abonos');
  IF v_n IS DISTINCT FROM jsonb_array_length(p_abonos_sent) THEN
    RAISE EXCEPTION 'idempotency_conflict'
      USING HINT = format('n_abonos almacenados=%s enviados=%s',
                           v_n, jsonb_array_length(p_abonos_sent));
  END IF;

  FOR v_i IN 0 .. v_n - 1 LOOP
    IF ((p_snap->'abonos'->v_i->>'monto')::INT)
         IS DISTINCT FROM ((p_abonos_sent->v_i->>'monto')::INT) THEN
      RAISE EXCEPTION 'idempotency_conflict'
        USING HINT = format('abono %s monto almacenado=%s enviado=%s',
                             v_i + 1,
                             p_snap->'abonos'->v_i->>'monto',
                             p_abonos_sent->v_i->>'monto');
    END IF;

    IF ((p_snap->'abonos'->v_i->>'fecha')::DATE)
         IS DISTINCT FROM ((p_abonos_sent->v_i->>'fecha')::DATE) THEN
      RAISE EXCEPTION 'idempotency_conflict'
        USING HINT = format('abono %s fecha almacenada=%s enviada=%s',
                             v_i + 1,
                             p_snap->'abonos'->v_i->>'fecha',
                             p_abonos_sent->v_i->>'fecha');
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION _cmp_solicitud_plan(JSONB, TEXT, TEXT, TEXT, INT, JSONB) FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. crear_plan_con_abonos
--
-- Clave de idempotencia explícita: p_plan_id
--   El cliente genera p_plan_id antes de enviar la petición y lo persiste
--   localmente antes de llamar al servidor.  En un reintento envía el mismo
--   p_plan_id; la función lo reconoce y devuelve el plan ya creado.
--
-- Snapshot inmutable (rev 4):
--   Al crear el plan se almacena solicitud_json con la identidad original de
--   la petición (alumno, cuota, periodo, monto_total, abonos ordenados).
--   Ese snapshot NUNCA se modifica, ni siquiera tras editar_abono.  Los
--   bloques de idempotencia (0 y post-lock) comparan contra él usando
--   _cmp_solicitud_plan, no contra el estado mutable actual.
--
-- Seguridad (SECURITY DEFINER):
--   La autorización se comprueba ANTES de devolver cualquier dato,
--   incluso en la ruta de idempotencia temprana (bloque 0) y en el
--   re-chequeo posterior al advisory lock (bloque 3).
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
  v_abonos_sorted JSONB;        -- p_abonos ordenados canónicamente
  v_snap          JSONB;        -- snapshot inmutable a usar en comparación
  v_existing_id   TEXT;
  v_ab            JSONB;
  v_abono_id      TEXT;
  v_suma_abonos   INT := 0;
  v_n_abonos      INT;
BEGIN

  -- Ordenar abonos entrantes (canónico: fecha ASC, monto ASC)
  v_abonos_sorted := _sort_abonos(p_abonos);

  -- ════════════════════════════════════════════════════════════════════════════
  -- BLOQUE 0 — Idempotencia temprana (antes del advisory lock)
  -- Si p_plan_id ya existe: autorizar PRIMERO, luego comparar snapshot.
  -- ════════════════════════════════════════════════════════════════════════════
  SELECT row_to_json(pp.*)::JSONB
    INTO v_plan_json
    FROM planes_pago pp
   WHERE pp.id = p_plan_id AND pp.cuenta_id = p_cuenta_id
   FOR UPDATE;

  IF FOUND THEN

    -- ── 0a. Obtener curso_id para autorizar ───────────────────────────────
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

    -- ── 0c. Comparar contra snapshot inmutable ────────────────────────────
    --    solicitud_json se almacenó al crear el plan y no se toca después.
    --    Si es NULL (plan creado antes de la migración rev 4), reconstruir
    --    desde el estado actual como mejor esfuerzo.
    v_snap := v_plan_json->'solicitud_json';
    IF v_snap IS NULL THEN
      SELECT jsonb_agg(
               jsonb_build_object('monto', ab.monto, 'fecha', ab.fecha::TEXT)
               ORDER BY ab.fecha, ab.monto
             )
        INTO v_abonos_json
        FROM abonos ab
       WHERE ab.plan_id = p_plan_id AND ab.cuenta_id = p_cuenta_id;

      v_snap := jsonb_build_object(
        'alumno_id',   v_plan_json->>'alumno_id',
        'cuota_id',    v_plan_json->>'cuota_id',
        'periodo',     v_plan_json->>'periodo',
        'monto_total', (v_plan_json->>'monto_total')::INT,
        'abonos',      COALESCE(v_abonos_json, '[]'::JSONB)
      );
    END IF;

    PERFORM _cmp_solicitud_plan(
      v_snap, p_alumno_id, p_cuota_id, p_periodo, p_monto_total, v_abonos_sorted
    );

    SELECT jsonb_agg(row_to_json(ab.*)::JSONB ORDER BY ab.fecha)
      INTO v_abonos_json
      FROM abonos ab
     WHERE ab.plan_id = p_plan_id AND ab.cuenta_id = p_cuenta_id;

    RETURN jsonb_build_object(
      'plan',        v_plan_json,
      'abonos',      COALESCE(v_abonos_json, '[]'::JSONB),
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
  -- BLOQUE 3 — Advisory lock + re-chequeo completo con snapshot
  -- ════════════════════════════════════════════════════════════════════════════
  PERFORM pg_advisory_xact_lock(
    hashtext(p_cuenta_id::TEXT || '|' || p_alumno_id || '|' || p_cuota_id || '|'
             || COALESCE(p_periodo, ''))
  );

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

    -- Misma función compartida que bloque 0: snapshot + calendario completo
    v_snap := v_plan_json->'solicitud_json';
    IF v_snap IS NULL THEN
      SELECT jsonb_agg(
               jsonb_build_object('monto', ab.monto, 'fecha', ab.fecha::TEXT)
               ORDER BY ab.fecha, ab.monto
             )
        INTO v_abonos_json
        FROM abonos ab
       WHERE ab.plan_id = p_plan_id AND ab.cuenta_id = p_cuenta_id;

      v_snap := jsonb_build_object(
        'alumno_id',   v_plan_json->>'alumno_id',
        'cuota_id',    v_plan_json->>'cuota_id',
        'periodo',     v_plan_json->>'periodo',
        'monto_total', (v_plan_json->>'monto_total')::INT,
        'abonos',      COALESCE(v_abonos_json, '[]'::JSONB)
      );
    END IF;

    PERFORM _cmp_solicitud_plan(
      v_snap, p_alumno_id, p_cuota_id, p_periodo, p_monto_total, v_abonos_sorted
    );

    SELECT jsonb_agg(row_to_json(ab.*)::JSONB ORDER BY ab.fecha)
      INTO v_abonos_json
      FROM abonos ab
     WHERE ab.plan_id = p_plan_id AND ab.cuenta_id = p_cuenta_id;

    RETURN jsonb_build_object(
      'plan',        v_plan_json,
      'abonos',      COALESCE(v_abonos_json, '[]'::JSONB),
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
  -- BLOQUE 5 — Crear plan con snapshot inmutable y sus abonos
  -- ════════════════════════════════════════════════════════════════════════════
  v_snap := jsonb_build_object(
    'alumno_id',   p_alumno_id,
    'cuota_id',    p_cuota_id,
    'periodo',     p_periodo,
    'monto_total', p_monto_total,
    'abonos',      v_abonos_sorted
  );

  INSERT INTO planes_pago(
    id, cuenta_id, alumno_id, cuota_id, periodo, monto_total,
    activo, creado_en, obs, solicitud_json
  )
  VALUES (
    p_plan_id, p_cuenta_id, p_alumno_id, p_cuota_id, p_periodo, p_monto_total,
    TRUE, CURRENT_DATE, p_obs, v_snap
  );

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
    'plan',        v_plan_json,
    'abonos',      COALESCE(v_abonos_json, '[]'::JSONB),
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
--      '_sort_abonos','_cmp_solicitud_plan',
--      'crear_plan_con_abonos','pagar_abono','revertir_abono',
--      'editar_abono','eliminar_plan'
--    )
--  ORDER BY routine_name;
-- -- Resultado esperado: 7 filas.
--
-- -- Verificar que columna solicitud_json existe en planes_pago:
-- SELECT column_name, data_type
--   FROM information_schema.columns
--  WHERE table_schema = 'public'
--    AND table_name   = 'planes_pago'
--    AND column_name  = 'solicitud_json';
-- -- Resultado esperado: 1 fila, data_type = 'jsonb'.
