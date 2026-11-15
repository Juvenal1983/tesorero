-- ============================================================
-- El Tesorero — B2: Planes de pago y abonos
-- Archivo: sql/11_rpc_b2_planes.sql
--
-- Reemplaza sql/11_rpc_planes_abonos.sql (eliminar el archivo anterior).
--
-- Propósito: RPCs SECURITY DEFINER para operaciones atómicas sobre
-- planes_pago y abonos. Se necesitan porque:
--
--   • planes_update / planes_delete (RLS 02_rls.sql): solo es_dueno.
--     El tesorero no puede hacer PATCH/DELETE directo en planes_pago.
--   • abonos_delete (RLS): solo es_dueno.
--     El tesorero no puede borrar abonos directamente.
--   • Atomicidad: crear plan + abonos, marcar pagado + cerrar plan,
--     revertir + reabrir, deben ser transacciones únicas para evitar
--     estados parciales ante fallo de red o reintento.
--
-- Tipos de ID:
--   cuenta_id  → UUID (tesorero_cuentas.id)
--   plan_id,
--   abono_id,
--   alumno_id,
--   cuota_id   → TEXT (IDs generados por uid() en el cliente)
--
-- Funciones:
--   crear_plan_con_abonos   — INSERT atómico plan + N abonos
--   pagar_abono             — PATCH abono pagado; cierra plan si completo
--   revertir_abono          — PATCH abono no-pagado; reabre plan
--   editar_abono            — PATCH monto/fecha en abono no pagado
--   eliminar_plan           — DELETE plan solo si sin abonos pagados
--
-- G05: NINGUNA función inserta en tabla `pagos`. Los RPCs de saldos
-- (10_codigo_compartido_v9.sql) cuentan abonos vía abonos_por_periodo /
-- abonos_por_cuota CTEs. Insertar en pagos duplicaría.
--
-- ⚠️ Ejecutar solo en staging (rucgmytyxpfowznowxwd).
--    NO ejecutar en producción (tmjqzaakzhecbldebyeg).
-- ============================================================

BEGIN;

SET search_path = public;

-- Eliminar versiones anteriores de funciones que ya no se usan
DROP FUNCTION IF EXISTS cerrar_plan_si_completo(UUID, UUID);
DROP FUNCTION IF EXISTS reabrir_plan_pago(UUID, UUID);
-- Versiones TEXT por si se crearon en alguna iteración anterior
DROP FUNCTION IF EXISTS cerrar_plan_si_completo(UUID, TEXT);
DROP FUNCTION IF EXISTS reabrir_plan_pago(UUID, TEXT);

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. crear_plan_con_abonos
--
-- Crea un plan de pago con todos sus abonos en una única transacción.
-- Protección ante reintentos: si ya existe un plan activo para la misma
-- (cuenta, alumno, cuota, periodo), devuelve ese plan sin duplicar.
-- Locking: FOR UPDATE en la fila de cuota para serializar creaciones
-- concurrentes del mismo plan.
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS crear_plan_con_abonos(UUID, TEXT, TEXT, TEXT, INT, JSONB);
DROP FUNCTION IF EXISTS crear_plan_con_abonos(UUID, TEXT, TEXT, TEXT, INT, JSONB, TEXT);

CREATE OR REPLACE FUNCTION crear_plan_con_abonos(
  p_cuenta_id   UUID,
  p_alumno_id   TEXT,
  p_cuota_id    TEXT,
  p_periodo     TEXT,     -- NULL para cuotas no-mensuales
  p_monto_total INT,
  p_abonos      JSONB,    -- [{id: TEXT (opcional), monto: INT, fecha: "YYYY-MM-DD"}]
  p_obs         TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_curso_id    TEXT;
  v_plan_id     TEXT;
  v_ab          JSONB;
  v_abono_id    TEXT;
  v_plan_row    RECORD;
  v_abonos_json JSONB;
  v_existing_id TEXT;
BEGIN
  -- ── 1. Verificar que la cuota existe y pertenece a la cuenta ──────────────
  SELECT cu.curso_id INTO v_curso_id
    FROM cuotas cu
   WHERE cu.id = p_cuota_id AND cu.cuenta_id = p_cuenta_id
   FOR SHARE;                                      -- evitar DROP concurrente

  IF NOT FOUND THEN
    RAISE EXCEPTION 'cuota_not_found'
      USING HINT = p_cuota_id;
  END IF;

  -- ── 2. Verificar autorización ─────────────────────────────────────────────
  IF NOT (
    es_dueno(p_cuenta_id) OR
    tiene_rol_en_curso(p_cuenta_id, v_curso_id, ARRAY['admin','tesorero'])
  ) THEN
    RAISE EXCEPTION 'permission_denied';
  END IF;

  -- ── 3. Verificar que el alumno pertenece al curso ─────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM alumnos
     WHERE id = p_alumno_id
       AND cuenta_id = p_cuenta_id
       AND curso_id  = v_curso_id
  ) THEN
    RAISE EXCEPTION 'alumno_not_in_curso'
      USING HINT = p_alumno_id;
  END IF;

  -- ── 4. Validar al menos 2 abonos ──────────────────────────────────────────
  IF p_abonos IS NULL OR jsonb_array_length(p_abonos) < 2 THEN
    RAISE EXCEPTION 'min_dos_abonos';
  END IF;

  -- ── 5. Idempotencia: plan activo existente para (alumno, cuota, periodo) ──
  --    FOR UPDATE serializa inserciones concurrentes del mismo plan.
  SELECT id INTO v_existing_id
    FROM planes_pago
   WHERE cuenta_id = p_cuenta_id
     AND alumno_id = p_alumno_id
     AND cuota_id  = p_cuota_id
     AND periodo   IS NOT DISTINCT FROM p_periodo
     AND activo    = TRUE
   LIMIT 1
   FOR UPDATE;

  IF FOUND THEN
    -- Retornar el plan existente sin crear duplicado
    SELECT row_to_json(pp.*)::JSONB INTO v_plan_row FROM planes_pago pp WHERE pp.id = v_existing_id;
    SELECT jsonb_agg(row_to_json(ab.*)::JSONB ORDER BY ab.fecha) INTO v_abonos_json
      FROM abonos ab
     WHERE ab.plan_id    = v_existing_id
       AND ab.cuenta_id  = p_cuenta_id;

    RETURN jsonb_build_object(
      'plan',        v_plan_row,
      'abonos',      COALESCE(v_abonos_json, '[]'::JSONB),
      'idempotente', TRUE
    );
  END IF;

  -- ── 6. Generar ID del plan ────────────────────────────────────────────────
  v_plan_id := gen_random_uuid()::TEXT;

  -- ── 7. INSERT plan_pago ───────────────────────────────────────────────────
  INSERT INTO planes_pago(
    id, cuenta_id, alumno_id, cuota_id,
    periodo, monto_total, activo, creado_en, obs
  )
  VALUES (
    v_plan_id, p_cuenta_id, p_alumno_id, p_cuota_id,
    p_periodo, p_monto_total, TRUE, CURRENT_DATE, p_obs
  );

  -- ── 8. INSERT abonos en un único bloque ───────────────────────────────────
  FOR v_ab IN SELECT value FROM jsonb_array_elements(p_abonos)
  LOOP
    v_abono_id := COALESCE(
      NULLIF(TRIM(v_ab->>'id'), ''),
      gen_random_uuid()::TEXT
    );

    INSERT INTO abonos(
      id, cuenta_id, alumno_id, cuota_id,
      plan_id, monto, fecha,
      pagado, fecha_pago, estado
    )
    VALUES (
      v_abono_id, p_cuenta_id, p_alumno_id, p_cuota_id,
      v_plan_id,
      (v_ab->>'monto')::INT,
      (v_ab->>'fecha')::DATE,
      FALSE, NULL, 'registrado'
    );
  END LOOP;

  -- ── 9. Retornar plan + abonos recién insertados ───────────────────────────
  SELECT row_to_json(pp.*)::JSONB INTO v_plan_row FROM planes_pago pp WHERE pp.id = v_plan_id;
  SELECT jsonb_agg(row_to_json(ab.*)::JSONB ORDER BY ab.fecha) INTO v_abonos_json
    FROM abonos ab
   WHERE ab.plan_id   = v_plan_id
     AND ab.cuenta_id = p_cuenta_id;

  RETURN jsonb_build_object(
    'plan',        v_plan_row,
    'abonos',      COALESCE(v_abonos_json, '[]'::JSONB),
    'idempotente', FALSE
  );
END;
$$;

REVOKE ALL ON FUNCTION crear_plan_con_abonos(UUID, TEXT, TEXT, TEXT, INT, JSONB, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION crear_plan_con_abonos(UUID, TEXT, TEXT, TEXT, INT, JSONB, TEXT) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. pagar_abono
--
-- Atómica: marca el abono como pagado y, si todos los abonos del plan
-- están pagados, cierra el plan (activo=FALSE).
--
-- G05: NO inserta en tabla `pagos`. Los RPCs de saldos cuentan abonos
-- directamente vía abonos_por_periodo / abonos_por_cuota.
--
-- Idempotente: si el abono ya está pagado, devuelve el estado actual
-- sin error (seguro para reintentos).
--
-- Concurrencia: FOR UPDATE en el abono y en el plan serializa pagos
-- simultáneos del mismo abono.
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS pagar_abono(UUID, TEXT, TEXT);

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
  v_curso_id      TEXT;
  v_abono         RECORD;
  v_plan          RECORD;
  v_total_abonos  INT;
  v_pagados       INT;
  v_plan_cerrado  BOOLEAN := FALSE;
BEGIN
  -- ── 1. Cargar el abono con lock ───────────────────────────────────────────
  SELECT ab.*, cu.curso_id
    INTO v_abono
    FROM abonos ab
    JOIN cuotas cu
      ON  cu.id         = ab.cuota_id
      AND cu.cuenta_id  = ab.cuenta_id
   WHERE ab.id         = p_abono_id
     AND ab.cuenta_id  = p_cuenta_id
     AND ab.plan_id    = p_plan_id      -- valida pertenencia del abono al plan
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'abono_not_found'
      USING HINT = p_abono_id;
  END IF;

  v_curso_id := v_abono.curso_id;

  -- ── 2. Verificar autorización ─────────────────────────────────────────────
  IF NOT (
    es_dueno(p_cuenta_id) OR
    tiene_rol_en_curso(p_cuenta_id, v_curso_id, ARRAY['admin','tesorero'])
  ) THEN
    RAISE EXCEPTION 'permission_denied';
  END IF;

  -- ── 3. Idempotencia: abono ya pagado ──────────────────────────────────────
  IF v_abono.pagado = TRUE THEN
    -- Verificar si el plan está cerrado
    SELECT activo INTO v_plan FROM planes_pago
     WHERE id = p_plan_id AND cuenta_id = p_cuenta_id;
    RETURN jsonb_build_object(
      'abono_id',     p_abono_id,
      'plan_cerrado', NOT COALESCE((v_plan).activo, TRUE),
      'ya_pagado',    TRUE
    );
  END IF;

  -- ── 4. Marcar abono como pagado ───────────────────────────────────────────
  UPDATE abonos
     SET pagado    = TRUE,
         fecha_pago = CURRENT_DATE,
         estado    = 'pagado'
   WHERE id        = p_abono_id
     AND cuenta_id = p_cuenta_id;

  -- ── 5. Bloquear el plan para conteo consistente ───────────────────────────
  SELECT * INTO v_plan
    FROM planes_pago
   WHERE id = p_plan_id AND cuenta_id = p_cuenta_id
   FOR UPDATE;

  -- ── 6. Contar abonos del plan tras el update ──────────────────────────────
  SELECT COUNT(*), COUNT(*) FILTER (WHERE pagado = TRUE)
    INTO v_total_abonos, v_pagados
    FROM abonos
   WHERE plan_id    = p_plan_id
     AND cuenta_id  = p_cuenta_id;

  -- ── 7. Cerrar plan si todos están pagados ─────────────────────────────────
  --    G05: NO insertar en tabla pagos.
  IF v_total_abonos > 0 AND v_total_abonos = v_pagados THEN
    UPDATE planes_pago
       SET activo = FALSE
     WHERE id        = p_plan_id
       AND cuenta_id = p_cuenta_id;
    v_plan_cerrado := TRUE;
  END IF;

  RETURN jsonb_build_object(
    'abono_id',     p_abono_id,
    'plan_cerrado', v_plan_cerrado,
    'ya_pagado',    FALSE,
    'total',        v_total_abonos,
    'pagados',      v_pagados
  );
END;
$$;

REVOKE ALL ON FUNCTION pagar_abono(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION pagar_abono(UUID, TEXT, TEXT) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. revertir_abono
--
-- Atómica: marca el abono como no-pagado y reabre el plan si estaba cerrado.
-- Idempotente: si el abono ya no está pagado, devuelve estado actual sin error.
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS revertir_abono(UUID, TEXT, TEXT);

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
  v_abono    RECORD;
BEGIN
  -- ── 1. Cargar el abono con lock ───────────────────────────────────────────
  SELECT ab.*, cu.curso_id
    INTO v_abono
    FROM abonos ab
    JOIN cuotas cu
      ON  cu.id        = ab.cuota_id
      AND cu.cuenta_id = ab.cuenta_id
   WHERE ab.id        = p_abono_id
     AND ab.cuenta_id = p_cuenta_id
     AND ab.plan_id   = p_plan_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'abono_not_found'
      USING HINT = p_abono_id;
  END IF;

  v_curso_id := v_abono.curso_id;

  -- ── 2. Verificar autorización ─────────────────────────────────────────────
  IF NOT (
    es_dueno(p_cuenta_id) OR
    tiene_rol_en_curso(p_cuenta_id, v_curso_id, ARRAY['admin','tesorero'])
  ) THEN
    RAISE EXCEPTION 'permission_denied';
  END IF;

  -- ── 3. Idempotencia: abono ya no está pagado ──────────────────────────────
  IF v_abono.pagado = FALSE THEN
    RETURN jsonb_build_object(
      'abono_id',    p_abono_id,
      'ya_no_pagado', TRUE
    );
  END IF;

  -- ── 4. Revertir abono ─────────────────────────────────────────────────────
  UPDATE abonos
     SET pagado     = FALSE,
         fecha_pago = NULL,
         estado     = 'registrado'
   WHERE id        = p_abono_id
     AND cuenta_id = p_cuenta_id;

  -- ── 5. Reabrir plan (bloquear primero para evitar race con pagar_abono) ───
  UPDATE planes_pago
     SET activo = TRUE
   WHERE id        = p_plan_id
     AND cuenta_id = p_cuenta_id;

  RETURN jsonb_build_object(
    'abono_id',    p_abono_id,
    'ya_no_pagado', FALSE
  );
END;
$$;

REVOKE ALL ON FUNCTION revertir_abono(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION revertir_abono(UUID, TEXT, TEXT) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. editar_abono
--
-- Actualiza monto y/o fecha de vencimiento de un abono NO pagado.
-- Rechaza modificar abonos ya pagados (historial inmutable).
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS editar_abono(UUID, TEXT, INT, TEXT);

CREATE OR REPLACE FUNCTION editar_abono(
  p_cuenta_id UUID,
  p_abono_id  TEXT,
  p_monto     INT  DEFAULT NULL,
  p_fecha     TEXT DEFAULT NULL   -- "YYYY-MM-DD"
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_curso_id TEXT;
  v_abono    RECORD;
BEGIN
  -- ── 1. Cargar abono con lock ──────────────────────────────────────────────
  SELECT ab.*, cu.curso_id
    INTO v_abono
    FROM abonos ab
    JOIN cuotas cu
      ON  cu.id        = ab.cuota_id
      AND cu.cuenta_id = ab.cuenta_id
   WHERE ab.id        = p_abono_id
     AND ab.cuenta_id = p_cuenta_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'abono_not_found'
      USING HINT = p_abono_id;
  END IF;

  v_curso_id := v_abono.curso_id;

  -- ── 2. Verificar autorización ─────────────────────────────────────────────
  IF NOT (
    es_dueno(p_cuenta_id) OR
    tiene_rol_en_curso(p_cuenta_id, v_curso_id, ARRAY['admin','tesorero'])
  ) THEN
    RAISE EXCEPTION 'permission_denied';
  END IF;

  -- ── 3. Rechazar edición de abono ya pagado ────────────────────────────────
  IF v_abono.pagado = TRUE THEN
    RAISE EXCEPTION 'abono_ya_pagado'
      USING HINT = p_abono_id;
  END IF;

  -- ── 4. Actualizar solo los campos provistos ───────────────────────────────
  UPDATE abonos
     SET monto = COALESCE(p_monto, monto),
         fecha = COALESCE(p_fecha::DATE, fecha)
   WHERE id        = p_abono_id
     AND cuenta_id = p_cuenta_id;

  -- ── 5. Retornar fila actualizada ──────────────────────────────────────────
  SELECT row_to_json(ab.*)::JSONB INTO v_abono
    FROM abonos ab
   WHERE ab.id = p_abono_id AND ab.cuenta_id = p_cuenta_id;

  RETURN jsonb_build_object('abono', v_abono);
END;
$$;

REVOKE ALL ON FUNCTION editar_abono(UUID, TEXT, INT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION editar_abono(UUID, TEXT, INT, TEXT) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. eliminar_plan
--
-- Elimina un plan de pago y sus abonos no pagados SOLO si no tiene abonos
-- pagados. Los abonos pagados representan dinero recibido; eliminarlos
-- borraría historial contable y rompe los cálculos de saldo.
--
-- Si hay abonos pagados: lanza 'plan_con_abonos_pagados'. El tesorero
-- debe primero revertir todos los abonos pagados antes de eliminar.
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS eliminar_plan(UUID, TEXT);

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
  -- ── 1. Cargar plan con lock ───────────────────────────────────────────────
  SELECT cu.curso_id INTO v_curso_id
    FROM planes_pago pp
    JOIN cuotas cu
      ON  cu.id        = pp.cuota_id
      AND cu.cuenta_id = pp.cuenta_id
   WHERE pp.id        = p_plan_id
     AND pp.cuenta_id = p_cuenta_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan_not_found'
      USING HINT = p_plan_id;
  END IF;

  -- ── 2. Verificar autorización ─────────────────────────────────────────────
  IF NOT (
    es_dueno(p_cuenta_id) OR
    tiene_rol_en_curso(p_cuenta_id, v_curso_id, ARRAY['admin','tesorero'])
  ) THEN
    RAISE EXCEPTION 'permission_denied';
  END IF;

  -- ── 3. Bloquear contra abonos pagados ─────────────────────────────────────
  SELECT COUNT(*) INTO v_pagados_cnt
    FROM abonos
   WHERE plan_id   = p_plan_id
     AND cuenta_id = p_cuenta_id
     AND pagado    = TRUE;

  IF v_pagados_cnt > 0 THEN
    -- Preservar historial: no eliminar si hay dinero recibido
    RAISE EXCEPTION 'plan_con_abonos_pagados'
      USING HINT = v_pagados_cnt::TEXT;
  END IF;

  -- ── 4. Eliminar abonos no pagados (todos, ya que pagados = 0) ────────────
  DELETE FROM abonos
   WHERE plan_id   = p_plan_id
     AND cuenta_id = p_cuenta_id;

  -- ── 5. Eliminar plan ──────────────────────────────────────────────────────
  DELETE FROM planes_pago
   WHERE id        = p_plan_id
     AND cuenta_id = p_cuenta_id;

  RETURN jsonb_build_object(
    'plan_id',   p_plan_id,
    'eliminado', TRUE
  );
END;
$$;

REVOKE ALL ON FUNCTION eliminar_plan(UUID, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION eliminar_plan(UUID, TEXT) TO authenticated;


COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- Verificación post-ejecución (ejecutar por separado en staging):
-- ═══════════════════════════════════════════════════════════════════════════
--
-- SELECT routine_name, routine_type
--   FROM information_schema.routines
--  WHERE routine_schema = 'public'
--    AND routine_name IN (
--      'crear_plan_con_abonos','pagar_abono','revertir_abono',
--      'editar_abono','eliminar_plan'
--    );
--
-- Resultado esperado: 5 filas con routine_type = 'FUNCTION'.
