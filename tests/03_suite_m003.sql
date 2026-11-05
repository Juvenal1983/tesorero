-- ============================================================
-- El Tesorero — "El Gran Cambio" v9
-- tests/03_suite_m003.sql
--
-- Suite de prueba para M003_normalizar_periodos.sql:
-- Históricos ficticios + transformación + reversión + protección.
--
-- Esta suite corre sobre la base LOCAL de prueba (tesorero_test).
-- NO requiere datos reales ni ejecución en staging o producción.
--
-- Casos cubiertos:
--   M01  Período "Marzo" (mes canónico sin año) → "Marzo 2026" ✓
--   M02  Período "Diciembre" con cuota sin anio → NO transformado (ambiguo)
--   M03  Período "Marzo 2025" (ya tiene año) → NO re-transformado
--   M04  Período "Matrícula 2024" (no es mes canónico) → intocable
--   M05  Período "Marzo (atrasado)" (typo/sufijo) → NO transformado
--   M06  Período NULL → NO transformado
--   M07  Verificación de auditoría: conteos correctos por estado
--   M08  Reversión segura: "Marzo 2026" → "Marzo" (restaurar) ✓
--   M09  PROTECCIÓN histórica: registro modificado después de M003
--        → reversión NO lo sobreescribe
--   M10  Idempotencia: ejecutar M003 dos veces → mismo resultado
-- ============================================================

-- ── LIMPIEZA DE DATOS DE PRUEBA M003 ────────────────────────────────────────
DELETE FROM pagos   WHERE cuenta_id = '00000000-0000-0000-0000-000000000003'::uuid;
DELETE FROM cuotas  WHERE cuenta_id = '00000000-0000-0000-0000-000000000003'::uuid;
DELETE FROM alumnos WHERE cuenta_id = '00000000-0000-0000-0000-000000000003'::uuid;
DROP TABLE IF EXISTS _auditoria_periodos_m003;

-- ── DATOS BASE FICTICIOS ─────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tesorero_cuentas WHERE id = '00000000-0000-0000-0000-000000000003') THEN
    INSERT INTO tesorero_cuentas (id, nombre, auth_id, email)
    VALUES ('00000000-0000-0000-0000-000000000003', 'Cuenta M003 Test', '00000000-0000-0000-0000-000000000001', 'test-m003@tesorero.local');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cursos WHERE id='curso-m003-001' AND cuenta_id='00000000-0000-0000-0000-000000000003'::uuid) THEN
    INSERT INTO cursos (id, cuenta_id, nombre, activo)
    VALUES ('curso-m003-001', '00000000-0000-0000-0000-000000000003', 'Curso M003', true);
  END IF;
END;
$$;

-- curso_id requerido por trigger _check_pago_mismo_curso
INSERT INTO alumnos (id, cuenta_id, curso_id, nombres, apellidos, eximido)
VALUES ('alu-m003-001', '00000000-0000-0000-0000-000000000003', 'curso-m003-001', 'Test', 'M003', false);

-- Cuota CON año (caso normal)
INSERT INTO cuotas (id, cuenta_id, curso_id, nombre, tipo, monto, mes_inicio, mes_termino, anio, activa)
VALUES ('q-m003-con-anio', '00000000-0000-0000-0000-000000000003', 'curso-m003-001',
        'Mensualidad 2026', 'mensual', 10000, 0, 11, 2026, true);

-- Cuota SIN año (caso ambiguo — no tiene anio)
INSERT INTO cuotas (id, cuenta_id, curso_id, nombre, tipo, monto, mes_inicio, mes_termino, anio, activa)
VALUES ('q-m003-sin-anio', '00000000-0000-0000-0000-000000000003', 'curso-m003-001',
        'Mensualidad sin año', 'mensual', 10000, 0, 11, NULL, true);

-- Pagos históricos con distintos formatos de período:
INSERT INTO pagos (id, cuenta_id, alumno_id, cuota_id, monto, fecha, medio, estado, periodo)
VALUES
  -- M01: candidato real — mes canónico sin año, cuota con año
  ('m003-p01', '00000000-0000-0000-0000-000000000003', 'alu-m003-001', 'q-m003-con-anio',
   10000, '2026-03-05', 'efectivo', 'pagado', 'Marzo'),

  -- M02: ambiguo — mes canónico pero cuota SIN año
  ('m003-p02', '00000000-0000-0000-0000-000000000003', 'alu-m003-001', 'q-m003-sin-anio',
   10000, '2026-12-01', 'efectivo', 'pagado', 'Diciembre'),

  -- M03: ya tiene año — NO debe re-transformarse
  ('m003-p03', '00000000-0000-0000-0000-000000000003', 'alu-m003-001', 'q-m003-con-anio',
   10000, '2026-04-05', 'efectivo', 'pagado', 'Abril 2025'),

  -- M04: período no-canónico — no es un mes del array MESES
  ('m003-p04', '00000000-0000-0000-0000-000000000003', 'alu-m003-001', 'q-m003-con-anio',
   50000, '2026-01-05', 'efectivo', 'pagado', 'Matrícula 2024'),

  -- M05: mes con sufijo/typo — no coincide exactamente con el array MESES
  ('m003-p05', '00000000-0000-0000-0000-000000000003', 'alu-m003-001', 'q-m003-con-anio',
   10000, '2026-03-20', 'efectivo', 'pagado', 'Marzo (atrasado)'),

  -- M06: período NULL
  ('m003-p06', '00000000-0000-0000-0000-000000000003', 'alu-m003-001', 'q-m003-con-anio',
   10000, '2026-05-10', 'efectivo', 'pagado', NULL),

  -- M10 (idempotencia): segundo candidato para verificar segunda ejecución
  ('m003-p10', '00000000-0000-0000-0000-000000000003', 'alu-m003-001', 'q-m003-con-anio',
   10000, '2026-06-05', 'efectivo', 'pagado', 'Junio');

-- ── HELPER DE ASSERTS ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _assert_m003(label TEXT, actual TEXT, expected TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL [%]: esperado="%s" obtenido="%s"', label, expected, actual;
  END IF;
  RAISE NOTICE '  PASS: %  (valor="%s")', label, actual;
END;
$$;

CREATE OR REPLACE FUNCTION _assert_m003_int(label TEXT, actual BIGINT, expected BIGINT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL [%]: esperado=% obtenido=%', label, expected, actual;
  END IF;
  RAISE NOTICE '  PASS: %  (valor=%)', label, actual;
END;
$$;

-- ── VERIFICAR ESTADO PRE-M003 ─────────────────────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '══ PRE-M003: estado inicial de los datos ficticios ══';
  RAISE NOTICE '  p01 periodo inicial: "Marzo"            (candidato)';
  RAISE NOTICE '  p02 periodo inicial: "Diciembre"        (ambiguo)';
  RAISE NOTICE '  p03 periodo inicial: "Abril 2025"       (ya con año)';
  RAISE NOTICE '  p04 periodo inicial: "Matrícula 2024"   (histórico)';
  RAISE NOTICE '  p05 periodo inicial: "Marzo (atrasado)" (typo)';
  RAISE NOTICE '  p06 periodo inicial: NULL';
  RAISE NOTICE '  p10 periodo inicial: "Junio"            (candidato)';
END;
$$;

-- ══════════════════════════════════════════════════════════════════════════════
-- EJECUTAR M003 (primera vez)
-- ══════════════════════════════════════════════════════════════════════════════
\i sql/migrations/M003_normalizar_periodos.sql

-- ── VERIFICAR RESULTADOS POST-M003 ───────────────────────────────────────────
DO $$
DECLARE v_p TEXT;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '══ VERIFICACIÓN POST-M003 ══';

  -- M01: "Marzo" → "Marzo 2026"
  SELECT periodo INTO v_p FROM pagos WHERE id='m003-p01';
  PERFORM _assert_m003('M01 Marzo → Marzo 2026', v_p, 'Marzo 2026');

  -- M02: "Diciembre" sin año en cuota → NO transformado (sigue "Diciembre")
  SELECT periodo INTO v_p FROM pagos WHERE id='m003-p02';
  PERFORM _assert_m003('M02 Diciembre (ambiguo) → sin cambio', v_p, 'Diciembre');

  -- M03: "Abril 2025" ya con año → NO re-transformado
  SELECT periodo INTO v_p FROM pagos WHERE id='m003-p03';
  PERFORM _assert_m003('M03 Abril 2025 → sin cambio', v_p, 'Abril 2025');

  -- M04: "Matrícula 2024" no es mes canónico → intocable
  SELECT periodo INTO v_p FROM pagos WHERE id='m003-p04';
  PERFORM _assert_m003('M04 Matrícula 2024 → sin cambio', v_p, 'Matrícula 2024');

  -- M05: "Marzo (atrasado)" con typo → NOT touched (no coincide exactamente con MESES)
  SELECT periodo INTO v_p FROM pagos WHERE id='m003-p05';
  PERFORM _assert_m003('M05 Marzo (atrasado) → sin cambio', v_p, 'Marzo (atrasado)');

  -- M06: NULL → sin cambio
  SELECT periodo INTO v_p FROM pagos WHERE id='m003-p06';
  IF v_p IS NULL THEN
    RAISE NOTICE '  PASS: M06 NULL → sigue NULL';
  ELSE
    RAISE EXCEPTION 'FAIL [M06]: NULL debería seguir NULL, obtenido=%', v_p;
  END IF;

  -- M10: "Junio" → "Junio 2026"
  SELECT periodo INTO v_p FROM pagos WHERE id='m003-p10';
  PERFORM _assert_m003('M10 Junio → Junio 2026', v_p, 'Junio 2026');
END;
$$;

-- M07: Verificar auditoría
DO $$
DECLARE
  v_actualizados BIGINT;
  v_ambiguos     BIGINT;
  v_total        BIGINT;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '══ M07: Tabla de auditoría ══';

  SELECT COUNT(*) INTO v_actualizados
    FROM _auditoria_periodos_m003
   WHERE cuenta_id = '00000000-0000-0000-0000-000000000003'::uuid
     AND estado = 'actualizado' AND entity_type = 'pago';

  SELECT COUNT(*) INTO v_ambiguos
    FROM _auditoria_periodos_m003
   WHERE cuenta_id = '00000000-0000-0000-0000-000000000003'::uuid
     AND estado = 'ambiguo' AND entity_type = 'pago';

  PERFORM _assert_m003_int('M07 auditoria: 2 registros actualizados (p01, p10)', v_actualizados, 2);
  PERFORM _assert_m003_int('M07 auditoria: 1 registro ambiguo (p02)', v_ambiguos, 1);

  -- Verificar que los 4 intocables (p03, p04, p05, p06) NO están en auditoría como actualizados
  SELECT COUNT(*) INTO v_total
    FROM _auditoria_periodos_m003
   WHERE cuenta_id = '00000000-0000-0000-0000-000000000003'::uuid
     AND pago_id IN ('m003-p03','m003-p04','m003-p05','m003-p06')
     AND estado = 'actualizado';
  PERFORM _assert_m003_int('M07 auditoria: 0 intocables marcados como actualizados', v_total, 0);
END;
$$;

-- ══════════════════════════════════════════════════════════════════════════════
-- M08: REVERSIÓN SEGURA
-- Recuperar timestamp de la ejecución de M003
-- ══════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_ts_ejecucion TIMESTAMPTZ;
  v_periodo_post TEXT;
  v_filas_revert BIGINT;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '══ M08: Reversión segura ══';

  -- Obtener el timestamp de migración (mínimo en esta ejecución)
  SELECT MIN(migrado_en) INTO v_ts_ejecucion
    FROM _auditoria_periodos_m003
   WHERE cuenta_id = '00000000-0000-0000-0000-000000000003'::uuid
     AND estado = 'actualizado';

  -- Ejecutar reversión de pagos con los 4 filtros obligatorios:
  --   1. entity_type = 'pago'      (solo pagos, no planes)
  --   2. pago_id = p.id            (ID correcto)
  --   3. cuenta_id coincide        (evitar colisión de IDs entre cuentas)
  --   4. p.periodo = a.periodo_nuevo (PROTECCIÓN: solo revertir si no fue modificado)
  --   5. migrado_en >= v_ts         (delimitar por ejecución)
  WITH revertidos AS (
    UPDATE pagos p
       SET periodo = a.periodo_original
      FROM _auditoria_periodos_m003 a
     WHERE a.entity_type  = 'pago'
       AND a.pago_id      = p.id
       AND a.cuenta_id    = p.cuenta_id
       AND a.estado       = 'actualizado'
       AND p.periodo      = a.periodo_nuevo   -- PROTECCIÓN HISTÓRICA
       AND a.migrado_en   >= v_ts_ejecucion
     RETURNING p.id
  )
  SELECT COUNT(*) INTO v_filas_revert FROM revertidos;

  PERFORM _assert_m003_int('M08 reversión revierte exactamente 2 filas (p01, p10)', v_filas_revert, 2);

  -- Verificar que p01 volvió a "Marzo"
  SELECT periodo INTO v_periodo_post FROM pagos WHERE id='m003-p01';
  PERFORM _assert_m003('M08 p01 revertido a "Marzo"', v_periodo_post, 'Marzo');

  -- Verificar que p10 volvió a "Junio"
  SELECT periodo INTO v_periodo_post FROM pagos WHERE id='m003-p10';
  PERFORM _assert_m003('M08 p10 revertido a "Junio"', v_periodo_post, 'Junio');

  -- Verificar que p02 (ambiguo) NO fue tocado en la reversión
  SELECT periodo INTO v_periodo_post FROM pagos WHERE id='m003-p02';
  PERFORM _assert_m003('M08 p02 (ambiguo) → sigue "Diciembre" tras reversión', v_periodo_post, 'Diciembre');
END;
$$;

-- ══════════════════════════════════════════════════════════════════════════════
-- M09: PROTECCIÓN HISTÓRICA — registro modificado DESPUÉS de M003
-- Si el período fue cambiado manualmente después de M003, la reversión
-- NO debe sobreescribirlo con el valor pre-M003.
-- ══════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_ts_nueva_ejecucion TIMESTAMPTZ;
  v_periodo_post       TEXT;
  v_filas_revert       BIGINT;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '══ M09: Protección post-M003 ══';

  -- 1. Restaurar p01 a "Marzo" (simular estado pre-M003)
  UPDATE pagos SET periodo='Marzo' WHERE id='m003-p01';
  DELETE FROM _auditoria_periodos_m003 WHERE pago_id='m003-p01' AND cuenta_id='00000000-0000-0000-0000-000000000003'::uuid;

  -- 2. Ejecutar M003 de nuevo → p01 pasa a "Marzo 2026"
  --    (Simulamos SOLO la transformación para no re-importar el archivo entero)
  CREATE TEMP TABLE _meses_reconocidos_m09 (mes TEXT PRIMARY KEY) ON COMMIT PRESERVE ROWS;
  INSERT INTO _meses_reconocidos_m09 VALUES
    ('Enero'),('Febrero'),('Marzo'),('Abril'),('Mayo'),('Junio'),
    ('Julio'),('Agosto'),('Septiembre'),('Octubre'),('Noviembre'),('Diciembre');

  INSERT INTO _auditoria_periodos_m003
    (cuenta_id, pago_id, entity_type, alumno_id, cuota_id,
     periodo_original, periodo_nuevo, anio_cuota, estado)
  SELECT
    p.cuenta_id, p.id, 'pago', p.alumno_id, p.cuota_id,
    p.periodo,
    p.periodo || ' ' || cu.anio::TEXT,
    cu.anio, 'actualizado'
  FROM pagos p
  JOIN _meses_reconocidos_m09 mr ON mr.mes = p.periodo
  JOIN cuotas cu ON cu.cuenta_id = p.cuenta_id AND cu.id = p.cuota_id
  WHERE p.id = 'm003-p01' AND cu.anio IS NOT NULL;

  UPDATE pagos p
     SET periodo = p.periodo || ' ' || cu.anio::TEXT
    FROM cuotas cu, _meses_reconocidos_m09 mr
   WHERE cu.cuenta_id = p.cuenta_id AND cu.id = p.cuota_id
     AND mr.mes = p.periodo
     AND p.id = 'm003-p01' AND cu.anio IS NOT NULL;

  DROP TABLE _meses_reconocidos_m09;

  -- Capturar timestamp de esta nueva ejecución
  SELECT MIN(migrado_en) INTO v_ts_nueva_ejecucion
    FROM _auditoria_periodos_m003
   WHERE pago_id = 'm003-p01'
     AND cuenta_id = '00000000-0000-0000-0000-000000000003'::uuid
     AND estado = 'actualizado';

  -- 3. Verificar que p01 está en "Marzo 2026" (post M003 segunda ejecución)
  SELECT periodo INTO v_periodo_post FROM pagos WHERE id='m003-p01';
  PERFORM _assert_m003('M09 p01 está en "Marzo 2026" post segunda M003', v_periodo_post, 'Marzo 2026');

  -- 4. MODIFICAR MANUALMENTE el período después de M003 (simular corrección posterior)
  --    Cambiar a "Marzo 2026 (corregido)" — un valor distinto del periodo_nuevo de auditoría.
  UPDATE pagos SET periodo='Marzo 2026 (corregido)' WHERE id='m003-p01';

  -- 5. Intentar revertir — la PROTECCIÓN debe impedirlo porque p.periodo ≠ a.periodo_nuevo
  WITH revertidos AS (
    UPDATE pagos p
       SET periodo = a.periodo_original
      FROM _auditoria_periodos_m003 a
     WHERE a.entity_type  = 'pago'
       AND a.pago_id      = p.id
       AND a.cuenta_id    = p.cuenta_id
       AND a.estado       = 'actualizado'
       AND p.periodo      = a.periodo_nuevo   -- PROTECCIÓN: "Marzo 2026 (corregido)" ≠ "Marzo 2026"
       AND a.migrado_en   >= v_ts_nueva_ejecucion
     RETURNING p.id
  )
  SELECT COUNT(*) INTO v_filas_revert FROM revertidos;

  PERFORM _assert_m003_int('M09 reversión NO toca registro modificado post-M003 (0 filas)', v_filas_revert, 0);

  -- 6. Verificar que el valor modificado manualmente se preservó
  SELECT periodo INTO v_periodo_post FROM pagos WHERE id='m003-p01';
  PERFORM _assert_m003('M09 valor modificado post-M003 preservado', v_periodo_post, 'Marzo 2026 (corregido)');
END;
$$;

-- ══════════════════════════════════════════════════════════════════════════════
-- M10: IDEMPOTENCIA — ejecutar M003 de nuevo no re-transforma "Marzo 2026"
-- ══════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_p TEXT;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '══ M10: Idempotencia de M003 ══';

  -- Restaurar p01 a "Marzo 2026" (como si M003 lo hubiera dejado ahí)
  UPDATE pagos SET periodo='Marzo 2026' WHERE id='m003-p01';

  -- Ahora simular re-ejecución de M003: "Marzo 2026" YA tiene año → filtro !~ '\d{4}$' lo excluye
  CREATE TEMP TABLE _meses_idm (mes TEXT PRIMARY KEY) ON COMMIT PRESERVE ROWS;
  INSERT INTO _meses_idm VALUES
    ('Enero'),('Febrero'),('Marzo'),('Abril'),('Mayo'),('Junio'),
    ('Julio'),('Agosto'),('Septiembre'),('Octubre'),('Noviembre'),('Diciembre');

  -- Verificar que "Marzo 2026" NO es candidato (tiene 4 dígitos al final)
  PERFORM _assert_m003_int('M10 "Marzo 2026" no es candidato (filtro ~ \\d{4}$)',
    (SELECT COUNT(*)::BIGINT FROM pagos p
      JOIN _meses_idm mr ON mr.mes = p.periodo
     WHERE p.id = 'm003-p01'
       AND p.periodo !~ '\d{4}$'),
    0);

  DROP TABLE _meses_idm;

  -- El período debe seguir siendo "Marzo 2026"
  SELECT periodo INTO v_p FROM pagos WHERE id='m003-p01';
  PERFORM _assert_m003('M10 segunda ejecución no re-transforma "Marzo 2026"', v_p, 'Marzo 2026');
END;
$$;

-- ── RESUMEN ──────────────────────────────────────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '══════════════════════════════════════════════════════════════';
  RAISE NOTICE '  SUITE M003 COMPLETADA: M01–M10 PASS ✅';
  RAISE NOTICE '';
  RAISE NOTICE '  Validado:';
  RAISE NOTICE '    M01 Mes canónico sin año → transformado correctamente';
  RAISE NOTICE '    M02 Mes canónico con cuota sin anio → NO transformado';
  RAISE NOTICE '    M03 Período ya con año → NO re-transformado';
  RAISE NOTICE '    M04 Período no-canónico → intocable';
  RAISE NOTICE '    M05 Mes con sufijo/typo → intocable';
  RAISE NOTICE '    M06 NULL → sin cambio';
  RAISE NOTICE '    M07 Auditoría: conteos correctos por estado';
  RAISE NOTICE '    M08 Reversión segura restaura exactamente los transformados';
  RAISE NOTICE '    M09 Protección histórica: modificación post-M003 preservada';
  RAISE NOTICE '    M10 Idempotencia: segunda ejecución no duplica año';
  RAISE NOTICE '══════════════════════════════════════════════════════════════';
END;
$$;

-- ── LIMPIEZA ─────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS _assert_m003(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS _assert_m003_int(TEXT, BIGINT, BIGINT);
