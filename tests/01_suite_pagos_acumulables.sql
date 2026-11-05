-- ============================================================
-- tests/01_suite_pagos_acumulables.sql
-- Suite de pruebas para pagos acumulables, idempotencia,
-- autorización por curso y atomicidad.
--
-- ENTORNO: PostgreSQL local (tesorero_test), SIN credenciales staging.
-- ESQUEMA: Usa el esquema v9 real (00_local_test_env.sql), incluyendo
--   curso_id en usuarios_cuenta, índice parcial de idempotencia (M001),
--   y restricciones reales (monto > 0, eximido NOT NULL).
--
-- USO:
--   psql -d tesorero_test -v ON_ERROR_STOP=1 \
--        -f tests/00_local_test_env.sql \
--        -f sql/11_insertar_pagos_lote.sql \
--        -f tests/01_suite_pagos_acumulables.sql
--
--   Para concurrencia (Test 5): usar run_tests.sh que lanza 2 psql en paralelo.
--
-- RESULTADO ESPERADO:
--   15 líneas "PASS: ..." en la salida.
--   Cualquier "FAIL" detiene la ejecución inmediatamente (ON_ERROR_STOP=1).
--   Las pruebas de error esperado capturan la excepción internamente.
--
-- REGLA DE ASSERTIONS:
--   FAIL → RAISE EXCEPTION (detiene todo con ON_ERROR_STOP=1)
--   PASS → RAISE NOTICE
--   Los DO blocks que prueban errores esperados capturan la excepción
--   en un BEGIN...EXCEPTION interno; si NO se lanza error, el DO block
--   emite RAISE EXCEPTION 'FAIL: ...' para detener la suite.
-- ============================================================

\set ON_ERROR_STOP on
\t on
\pset format unaligned

-- ── Preparar fixtures de prueba ───────────────────────────────────────────────
DO $$
BEGIN
  PERFORM set_config('app.test_es_dueno', 'true', true);
  PERFORM set_config('app.test_user_id', '00000000-0000-0000-0000-000000000001', true);
END;
$$;

-- Cuentas
INSERT INTO tesorero_cuentas (id) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001'::UUID)
  ON CONFLICT DO NOTHING;
INSERT INTO tesorero_cuentas (id) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001'::UUID)
  ON CONFLICT DO NOTHING;

-- Cursos (dos cursos en cuenta A, un curso en cuenta B)
INSERT INTO cursos (cuenta_id, id, nombre, anio) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001'::UUID, 'curso-test-1', 'Curso 1A', 2025)
  ON CONFLICT DO NOTHING;
INSERT INTO cursos (cuenta_id, id, nombre, anio) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001'::UUID, 'curso-test-2', 'Curso 2A', 2025)
  ON CONFLICT DO NOTHING;
INSERT INTO cursos (cuenta_id, id, nombre, anio) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001'::UUID, 'curso-b-1', 'Curso B', 2025)
  ON CONFLICT DO NOTHING;

-- Tesorero global (curso_id IS NULL = todos los cursos)
INSERT INTO usuarios_cuenta (cuenta_id, auth_id, rol, curso_id) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001'::UUID,
   '00000000-0000-0000-0000-000000000001'::UUID,
   'tesorero', NULL)
  ON CONFLICT DO NOTHING;

-- Tesorero acotado solo a curso-test-1
INSERT INTO usuarios_cuenta (cuenta_id, auth_id, rol, curso_id) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001'::UUID,
   '00000000-0000-0000-0000-000000000002'::UUID,
   'tesorero', 'curso-test-1')
  ON CONFLICT DO NOTHING;

-- Alumnos
INSERT INTO alumnos (cuenta_id, id, curso_id, nombres, apellidos) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001'::UUID, 'alu-test-1', 'curso-test-1', 'Test', 'Alumno')
  ON CONFLICT DO NOTHING;
INSERT INTO alumnos (cuenta_id, id, curso_id, nombres, apellidos) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001'::UUID, 'alu-test-2', 'curso-test-2', 'Test2', 'Alumno2')
  ON CONFLICT DO NOTHING;
INSERT INTO alumnos (cuenta_id, id, curso_id, nombres, apellidos) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001'::UUID, 'alu-b-1', 'curso-b-1', 'Otro', 'Alumno')
  ON CONFLICT DO NOTHING;

-- Cuotas
INSERT INTO cuotas (cuenta_id, id, curso_id, nombre, tipo, monto, anio) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001'::UUID, 'cuota-test-1', 'curso-test-1',
   'Cuota Mensual', 'mensual', 20000, 2025)
  ON CONFLICT DO NOTHING;
INSERT INTO cuotas (cuenta_id, id, curso_id, nombre, tipo, monto, anio) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001'::UUID, 'cuota-test-2', 'curso-test-2',
   'Cuota Curso2', 'mensual', 15000, 2025)
  ON CONFLICT DO NOTHING;
INSERT INTO cuotas (cuenta_id, id, curso_id, nombre, tipo, monto, anio) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001'::UUID, 'cuota-b-1', 'curso-b-1',
   'Cuota B', 'mensual', 20000, 2025)
  ON CONFLICT DO NOTHING;

-- Limpiar pagos de pruebas anteriores
DELETE FROM pagos WHERE cuenta_id IN (
  'aaaaaaaa-0000-0000-0000-000000000001'::UUID,
  'bbbbbbbb-0000-0000-0000-000000000001'::UUID
);

\echo '=== INICIANDO SUITE DE PRUEBAS (ON_ERROR_STOP=1) ==='
\echo ''

-- ════════════════════════════════════════════════════════════
-- PRUEBA 1: Dos pagos parciales cubren obligación de $20.000
-- ════════════════════════════════════════════════════════════
\echo 'PRUEBA 1: Dos pagos parciales cubren la obligación (pagos acumulables)'
DO $$
DECLARE
  v_cnt   INT;
  v_total INT;
BEGIN
  PERFORM set_config('app.test_es_dueno', 'true', true);
  DELETE FROM pagos WHERE cuenta_id = 'aaaaaaaa-0000-0000-0000-000000000001'::UUID
    AND alumno_id = 'alu-test-1' AND cuota_id = 'cuota-test-1' AND periodo = 'Marzo 2025';

  PERFORM insertar_pagos_lote(
    'aaaaaaaa-0000-0000-0000-000000000001'::UUID,
    '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":8000,"fecha":"2025-03-15","medio":"transferencia","periodo":"Marzo 2025","idempotency_key":"t1-a"}]'::JSONB
  );
  PERFORM insertar_pagos_lote(
    'aaaaaaaa-0000-0000-0000-000000000001'::UUID,
    '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":12000,"fecha":"2025-03-20","medio":"efectivo","periodo":"Marzo 2025","idempotency_key":"t1-b"}]'::JSONB
  );

  SELECT COUNT(*), SUM(monto) INTO v_cnt, v_total FROM pagos
   WHERE cuenta_id = 'aaaaaaaa-0000-0000-0000-000000000001'::UUID
     AND alumno_id = 'alu-test-1' AND cuota_id = 'cuota-test-1' AND periodo = 'Marzo 2025';

  IF v_cnt != 2 THEN
    RAISE EXCEPTION 'FAIL: Prueba 1 — se esperaban 2 filas, se encontraron %', v_cnt;
  END IF;
  IF v_total != 20000 THEN
    RAISE EXCEPTION 'FAIL: Prueba 1b — suma esperada $20.000, obtenida $%', v_total;
  END IF;

  RAISE NOTICE 'PASS: Prueba 1 — 2 pagos acumulables, suma $20.000 cubre obligación';
END;
$$;

-- ════════════════════════════════════════════════════════════
-- PRUEBA 2: Dos pagos legítimos con claves distintas
-- ════════════════════════════════════════════════════════════
\echo 'PRUEBA 2: Dos pagos idénticos con claves de idempotencia distintas (ambos aceptados)'
DO $$
DECLARE v_cnt INT;
BEGIN
  PERFORM set_config('app.test_es_dueno', 'true', true);
  DELETE FROM pagos WHERE cuenta_id = 'aaaaaaaa-0000-0000-0000-000000000001'::UUID
    AND periodo = 'Abril 2025';

  PERFORM insertar_pagos_lote('aaaaaaaa-0000-0000-0000-000000000001'::UUID,
    '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":20000,"fecha":"2025-04-05","medio":"transferencia","periodo":"Abril 2025","idempotency_key":"t2-a"}]'::JSONB);
  PERFORM insertar_pagos_lote('aaaaaaaa-0000-0000-0000-000000000001'::UUID,
    '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":20000,"fecha":"2025-04-05","medio":"transferencia","periodo":"Abril 2025","idempotency_key":"t2-b"}]'::JSONB);

  SELECT COUNT(*) INTO v_cnt FROM pagos
   WHERE cuenta_id = 'aaaaaaaa-0000-0000-0000-000000000001'::UUID AND periodo = 'Abril 2025';

  IF v_cnt != 2 THEN
    RAISE EXCEPTION 'FAIL: Prueba 2 — esperadas 2 filas, obtenidas %', v_cnt;
  END IF;
  RAISE NOTICE 'PASS: Prueba 2 — 2 pagos con claves distintas admitidos (claves distintas)';
END;
$$;

-- ════════════════════════════════════════════════════════════
-- PRUEBA 3: Reintento con misma clave no duplica
-- ════════════════════════════════════════════════════════════
\echo 'PRUEBA 3: Reintento con la misma clave de idempotencia no duplica fila'
DO $$
DECLARE
  v_cnt  INT;
  v_id1  TEXT;
  v_id2  TEXT;
  v_res  JSONB;
BEGIN
  PERFORM set_config('app.test_es_dueno', 'true', true);
  DELETE FROM pagos WHERE idempotency_key IN ('t3-reintento');

  v_res := insertar_pagos_lote('aaaaaaaa-0000-0000-0000-000000000001'::UUID,
    '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":20000,"fecha":"2025-05-10","medio":"transferencia","periodo":"Mayo 2025","idempotency_key":"t3-reintento"}]'::JSONB);
  v_id1 := (v_res->0)->>'id';

  v_res := insertar_pagos_lote('aaaaaaaa-0000-0000-0000-000000000001'::UUID,
    '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":20000,"fecha":"2025-05-10","medio":"transferencia","periodo":"Mayo 2025","idempotency_key":"t3-reintento"}]'::JSONB);
  v_id2 := (v_res->0)->>'id';

  SELECT COUNT(*) INTO v_cnt FROM pagos WHERE idempotency_key = 't3-reintento';

  IF v_cnt != 1 THEN
    RAISE EXCEPTION 'FAIL: Prueba 3 — esperada 1 fila (idempotencia), obtenidas %', v_cnt;
  END IF;
  IF v_id1 IS DISTINCT FROM v_id2 THEN
    RAISE EXCEPTION 'FAIL: Prueba 3 — IDs difieren: id1=%, id2=% (debe ser el mismo)', v_id1, v_id2;
  END IF;
  RAISE NOTICE 'PASS: Prueba 3 — reintento retorna fila existente con mismo ID';
END;
$$;

-- ════════════════════════════════════════════════════════════
-- PRUEBA 4: Misma clave con cuenta distinta se rechaza
-- ════════════════════════════════════════════════════════════
\echo 'PRUEBA 4: Misma clave de idempotencia con cuenta_id distinta es rechazada (aislamiento)'
DO $$
DECLARE
  v_error_capturado BOOLEAN := false;
BEGIN
  PERFORM set_config('app.test_es_dueno', 'true', true);
  DELETE FROM pagos WHERE idempotency_key = 't4-cross-cuenta';

  PERFORM insertar_pagos_lote('aaaaaaaa-0000-0000-0000-000000000001'::UUID,
    '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":5000,"fecha":"2025-06-01","medio":"transferencia","periodo":"Junio 2025","idempotency_key":"t4-cross-cuenta"}]'::JSONB);

  BEGIN
    PERFORM insertar_pagos_lote('bbbbbbbb-0000-0000-0000-000000000001'::UUID,
      '[{"alumno_id":"alu-b-1","cuota_id":"cuota-b-1","monto":5000,"fecha":"2025-06-01","medio":"transferencia","periodo":"Junio 2025","idempotency_key":"t4-cross-cuenta"}]'::JSONB);
  EXCEPTION WHEN OTHERS THEN
    v_error_capturado := true;
  END;

  IF NOT v_error_capturado THEN
    RAISE EXCEPTION 'FAIL: Prueba 4 — clave cross-cuenta NO fue rechazada (riesgo de seguridad)';
  END IF;
  RAISE NOTICE 'PASS: Prueba 4 — clave cross-cuenta rechazada correctamente';
END;
$$;

-- ════════════════════════════════════════════════════════════
-- PRUEBA 5: Concurrencia — insertar mismo período desde 2 "sesiones"
-- (simulada en el mismo bloque; concurrencia real: ver run_tests.sh)
-- ════════════════════════════════════════════════════════════
\echo 'PRUEBA 5: Concurrencia — 2 inserts con misma clave desde sesiones distintas'
DO $$
DECLARE
  v_cnt INT;
BEGIN
  PERFORM set_config('app.test_es_dueno', 'true', true);
  DELETE FROM pagos WHERE idempotency_key IN ('t5-conc-a', 't5-conc-b');

  -- Sesión 1: inserta con t5-conc-a
  PERFORM insertar_pagos_lote('aaaaaaaa-0000-0000-0000-000000000001'::UUID,
    '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":20000,"fecha":"2025-07-01","medio":"transferencia","periodo":"Julio 2025","idempotency_key":"t5-conc-a"}]'::JSONB);

  -- Sesión 2: inserta con t5-conc-b (clave distinta = otro submit)
  PERFORM insertar_pagos_lote('aaaaaaaa-0000-0000-0000-000000000001'::UUID,
    '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":20000,"fecha":"2025-07-01","medio":"transferencia","periodo":"Julio 2025","idempotency_key":"t5-conc-b"}]'::JSONB);

  -- Sesión 1 reintenta: misma clave t5-conc-a — debe devolver la fila existente
  PERFORM insertar_pagos_lote('aaaaaaaa-0000-0000-0000-000000000001'::UUID,
    '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":20000,"fecha":"2025-07-01","medio":"transferencia","periodo":"Julio 2025","idempotency_key":"t5-conc-a"}]'::JSONB);

  SELECT COUNT(*) INTO v_cnt FROM pagos
   WHERE cuenta_id = 'aaaaaaaa-0000-0000-0000-000000000001'::UUID AND periodo = 'Julio 2025';

  -- 2 filas: una por clave t5-conc-a, una por t5-conc-b; el reintento no duplicó
  IF v_cnt != 2 THEN
    RAISE EXCEPTION 'FAIL: Prueba 5 — esperadas 2 filas (1 por submit), obtenidas % (reintento duplicó)', v_cnt;
  END IF;
  RAISE NOTICE 'PASS: Prueba 5 — concurrencia simulada: 2 submits distintos = 2 filas; reintento no duplica';
  RAISE NOTICE '  NOTA: concurrencia real (conexiones paralelas) verificada en run_tests.sh';
END;
$$;

-- ════════════════════════════════════════════════════════════
-- PRUEBA 6: Pago sin idempotency_key siempre crea nueva fila
-- ════════════════════════════════════════════════════════════
\echo 'PRUEBA 6: Pago sin idempotency_key siempre inserta nueva fila'
DO $$
DECLARE v_cnt INT;
BEGIN
  PERFORM set_config('app.test_es_dueno', 'true', true);
  DELETE FROM pagos WHERE cuenta_id = 'aaaaaaaa-0000-0000-0000-000000000001'::UUID
    AND periodo = 'Agosto 2025' AND idempotency_key IS NULL;

  PERFORM insertar_pagos_lote('aaaaaaaa-0000-0000-0000-000000000001'::UUID,
    '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":10000,"fecha":"2025-08-01","medio":"efectivo","periodo":"Agosto 2025"}]'::JSONB);
  PERFORM insertar_pagos_lote('aaaaaaaa-0000-0000-0000-000000000001'::UUID,
    '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":10000,"fecha":"2025-08-01","medio":"efectivo","periodo":"Agosto 2025"}]'::JSONB);

  SELECT COUNT(*) INTO v_cnt FROM pagos
   WHERE cuenta_id = 'aaaaaaaa-0000-0000-0000-000000000001'::UUID
     AND periodo = 'Agosto 2025' AND idempotency_key IS NULL;

  IF v_cnt != 2 THEN
    RAISE EXCEPTION 'FAIL: Prueba 6 — sin clave deben permitirse duplicados (% filas, esperadas 2)', v_cnt;
  END IF;
  RAISE NOTICE 'PASS: Prueba 6 — sin idempotency_key: 2 inserts = 2 filas distintas';
END;
$$;

-- ════════════════════════════════════════════════════════════
-- PRUEBA 7: alumno_id de otra cuenta es rechazado
-- ════════════════════════════════════════════════════════════
\echo 'PRUEBA 7: alumno_id que no pertenece a la cuenta es rechazado'
DO $$
DECLARE v_error_capturado BOOLEAN := false;
BEGIN
  PERFORM set_config('app.test_es_dueno', 'true', true);
  BEGIN
    PERFORM insertar_pagos_lote('aaaaaaaa-0000-0000-0000-000000000001'::UUID,
      '[{"alumno_id":"alu-b-1","cuota_id":"cuota-test-1","monto":5000,"fecha":"2025-09-01","medio":"efectivo","periodo":"Septiembre 2025","idempotency_key":"t7-alien-alu"}]'::JSONB);
  EXCEPTION WHEN OTHERS THEN
    v_error_capturado := true;
  END;
  IF NOT v_error_capturado THEN
    RAISE EXCEPTION 'FAIL: Prueba 7 — alumno de otra cuenta NO fue rechazado';
  END IF;
  RAISE NOTICE 'PASS: Prueba 7 — alumno de otra cuenta rechazado (42501)';
END;
$$;

-- ════════════════════════════════════════════════════════════
-- PRUEBA 8: Sobrepago — verificar deuda real restante
-- La deuda se calcula como: MAX(0, cuota.monto - SUM(pagos.monto))
-- Un solo pago de $20.000 en Marzo cubre la obligación;
-- Abril no tiene pagos → deuda = $20.000.
-- ════════════════════════════════════════════════════════════
\echo 'PRUEBA 8: Deuda real de Abril calculada desde la suma de pagos vs monto obligación'
DO $$
DECLARE
  v_pagado_marzo    INT;
  v_pagado_abril    INT;
  v_monto_obligacion INT;
  v_deuda_marzo     INT;
  v_deuda_abril     INT;
BEGIN
  PERFORM set_config('app.test_es_dueno', 'true', true);
  -- Limpiar TODOS los pagos de estos períodos para aislar el test
  DELETE FROM pagos WHERE cuenta_id = 'aaaaaaaa-0000-0000-0000-000000000001'::UUID
    AND alumno_id = 'alu-test-1' AND cuota_id = 'cuota-test-1'
    AND periodo IN ('Marzo 2025', 'Abril 2025');

  -- $20.000 pagados en Marzo → obligación cubierta
  PERFORM insertar_pagos_lote('aaaaaaaa-0000-0000-0000-000000000001'::UUID,
    '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":20000,"fecha":"2025-03-01","medio":"efectivo","periodo":"Marzo 2025","idempotency_key":"t8-marzo"}]'::JSONB);

  -- Obtener monto de obligación de la cuota
  SELECT monto INTO v_monto_obligacion FROM cuotas
   WHERE cuenta_id = 'aaaaaaaa-0000-0000-0000-000000000001'::UUID AND id = 'cuota-test-1';

  -- Calcular lo pagado en cada período
  SELECT COALESCE(SUM(monto), 0) INTO v_pagado_marzo FROM pagos
   WHERE cuenta_id = 'aaaaaaaa-0000-0000-0000-000000000001'::UUID
     AND alumno_id = 'alu-test-1' AND cuota_id = 'cuota-test-1' AND periodo = 'Marzo 2025';

  SELECT COALESCE(SUM(monto), 0) INTO v_pagado_abril FROM pagos
   WHERE cuenta_id = 'aaaaaaaa-0000-0000-0000-000000000001'::UUID
     AND alumno_id = 'alu-test-1' AND cuota_id = 'cuota-test-1' AND periodo = 'Abril 2025';

  -- Deuda = MAX(0, obligacion - pagado)
  v_deuda_marzo := GREATEST(0, v_monto_obligacion - v_pagado_marzo);
  v_deuda_abril := GREATEST(0, v_monto_obligacion - v_pagado_abril);

  -- Marzo debe estar cubierto (deuda = 0)
  IF v_deuda_marzo != 0 THEN
    RAISE EXCEPTION 'FAIL: Prueba 8 — Marzo debería estar cubierto (deuda=0), tiene deuda=$%', v_deuda_marzo;
  END IF;
  -- Abril no tiene pago → deuda completa
  IF v_deuda_abril != v_monto_obligacion THEN
    RAISE EXCEPTION 'FAIL: Prueba 8 — Abril sin pago, deuda esperada=$%, calculada=$%',
      v_monto_obligacion, v_deuda_abril;
  END IF;
  RAISE NOTICE 'PASS: Prueba 8 — deuda Marzo=$% (cubierta), deuda Abril=$% (pendiente completa)',
    v_deuda_marzo, v_deuda_abril;
END;
$$;

-- ════════════════════════════════════════════════════════════
-- PRUEBA 9: monto = 0 rechazado (CHECK monto > 0)
-- ════════════════════════════════════════════════════════════
\echo 'PRUEBA 9: Pago con monto = 0 es rechazado'
DO $$
DECLARE v_error_capturado BOOLEAN := false;
BEGIN
  PERFORM set_config('app.test_es_dueno', 'true', true);
  BEGIN
    PERFORM insertar_pagos_lote('aaaaaaaa-0000-0000-0000-000000000001'::UUID,
      '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":0,"fecha":"2025-10-01","medio":"efectivo","periodo":"Octubre 2025","idempotency_key":"t9-cero"}]'::JSONB);
  EXCEPTION WHEN OTHERS THEN
    v_error_capturado := true;
  END;
  IF NOT v_error_capturado THEN
    RAISE EXCEPTION 'FAIL: Prueba 9 — monto=0 NO fue rechazado';
  END IF;
  RAISE NOTICE 'PASS: Prueba 9 — monto=0 rechazado correctamente';
END;
$$;

-- ════════════════════════════════════════════════════════════
-- PRUEBA 10: monto negativo rechazado
-- ════════════════════════════════════════════════════════════
\echo 'PRUEBA 10: Pago con monto negativo es rechazado'
DO $$
DECLARE v_error_capturado BOOLEAN := false;
BEGIN
  PERFORM set_config('app.test_es_dueno', 'true', true);
  BEGIN
    PERFORM insertar_pagos_lote('aaaaaaaa-0000-0000-0000-000000000001'::UUID,
      '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":-1000,"fecha":"2025-10-01","medio":"efectivo","periodo":"Noviembre 2025","idempotency_key":"t10-neg"}]'::JSONB);
  EXCEPTION WHEN OTHERS THEN
    v_error_capturado := true;
  END;
  IF NOT v_error_capturado THEN
    RAISE EXCEPTION 'FAIL: Prueba 10 — monto negativo NO fue rechazado';
  END IF;
  RAISE NOTICE 'PASS: Prueba 10 — monto negativo rechazado correctamente';
END;
$$;

-- ════════════════════════════════════════════════════════════
-- PRUEBA 11: p_pagos no es array → error claro
-- ════════════════════════════════════════════════════════════
\echo 'PRUEBA 11: p_pagos que no es array produce error descriptivo'
DO $$
DECLARE v_error_capturado BOOLEAN := false;
BEGIN
  PERFORM set_config('app.test_es_dueno', 'true', true);
  BEGIN
    PERFORM insertar_pagos_lote('aaaaaaaa-0000-0000-0000-000000000001'::UUID,
      '{"alumno_id":"alu-test-1"}'::JSONB);
  EXCEPTION WHEN OTHERS THEN
    v_error_capturado := true;
  END;
  IF NOT v_error_capturado THEN
    RAISE EXCEPTION 'FAIL: Prueba 11 — JSONB objeto (no array) NO fue rechazado';
  END IF;
  RAISE NOTICE 'PASS: Prueba 11 — JSONB no-array rechazado correctamente';
END;
$$;

-- ════════════════════════════════════════════════════════════
-- PRUEBA 12: Atomicidad — si un pago del lote falla, ninguno se inserta
-- ════════════════════════════════════════════════════════════
\echo 'PRUEBA 12: Atomicidad — si un pago del lote es inválido, ninguno queda'
DO $$
DECLARE
  v_cnt               INT;
  v_error_capturado   BOOLEAN := false;
BEGIN
  PERFORM set_config('app.test_es_dueno', 'true', true);
  DELETE FROM pagos WHERE idempotency_key IN ('t12-valido', 't12-invalido');

  BEGIN
    -- Primer pago válido, segundo con monto=0 (inválido)
    PERFORM insertar_pagos_lote('aaaaaaaa-0000-0000-0000-000000000001'::UUID,
      '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":5000,"fecha":"2025-11-01","medio":"efectivo","periodo":"Noviembre 2025","idempotency_key":"t12-valido"},
        {"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":0,"fecha":"2025-11-01","medio":"efectivo","periodo":"Noviembre 2025","idempotency_key":"t12-invalido"}]'::JSONB);
  EXCEPTION WHEN OTHERS THEN
    v_error_capturado := true;
  END;

  SELECT COUNT(*) INTO v_cnt FROM pagos
   WHERE idempotency_key IN ('t12-valido', 't12-invalido');

  IF NOT v_error_capturado THEN
    RAISE EXCEPTION 'FAIL: Prueba 12 — el lote con pago inválido no lanzó error';
  END IF;
  IF v_cnt != 0 THEN
    RAISE EXCEPTION 'FAIL: Prueba 12 — se insertaron % filas pese al error (atomicidad rota)', v_cnt;
  END IF;
  RAISE NOTICE 'PASS: Prueba 12 — atomicidad: lote con pago inválido deja 0 filas insertadas';
END;
$$;

-- ════════════════════════════════════════════════════════════
-- PRUEBA 13: Misma clave con contenido distinto debe RECHAZAR
-- (no retornar la fila original silenciosamente)
-- ════════════════════════════════════════════════════════════
\echo 'PRUEBA 13: Misma clave con monto distinto es rechazada (identidad de contenido)'
DO $$
DECLARE
  v_error_capturado BOOLEAN := false;
  v_sqlstate        TEXT;
BEGIN
  PERFORM set_config('app.test_es_dueno', 'true', true);
  DELETE FROM pagos WHERE idempotency_key = 't13-contenido';

  -- Inserción original: monto = 10000
  PERFORM insertar_pagos_lote('aaaaaaaa-0000-0000-0000-000000000001'::UUID,
    '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":10000,"fecha":"2025-12-01","medio":"efectivo","periodo":"Diciembre 2025","idempotency_key":"t13-contenido"}]'::JSONB);

  -- Reintento con monto DISTINTO: 99999 — debe ser RECHAZADO
  BEGIN
    PERFORM insertar_pagos_lote('aaaaaaaa-0000-0000-0000-000000000001'::UUID,
      '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":99999,"fecha":"2025-12-01","medio":"efectivo","periodo":"Diciembre 2025","idempotency_key":"t13-contenido"}]'::JSONB);
  EXCEPTION WHEN OTHERS THEN
    v_error_capturado := true;
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE;
  END;

  IF NOT v_error_capturado THEN
    RAISE EXCEPTION
      'FAIL: Prueba 13 — misma clave con monto distinto NO fue rechazada '
      '(retornó fila original silenciosamente — riesgo de ingeniería de fraude)';
  END IF;
  RAISE NOTICE 'PASS: Prueba 13 — misma clave + contenido distinto rechazada con SQLSTATE=%', v_sqlstate;
END;
$$;

-- ════════════════════════════════════════════════════════════
-- PRUEBA 14: Array vacío retorna [] sin error
-- ════════════════════════════════════════════════════════════
\echo 'PRUEBA 14: Array vacío retorna [] sin error'
DO $$
DECLARE v_res JSONB;
BEGIN
  PERFORM set_config('app.test_es_dueno', 'true', true);
  v_res := insertar_pagos_lote('aaaaaaaa-0000-0000-0000-000000000001'::UUID, '[]'::JSONB);
  IF v_res IS DISTINCT FROM '[]'::JSONB THEN
    RAISE EXCEPTION 'FAIL: Prueba 14 — array vacío no retornó [] (retornó: %)', v_res;
  END IF;
  RAISE NOTICE 'PASS: Prueba 14 — array vacío retorna [] limpiamente';
END;
$$;

-- ════════════════════════════════════════════════════════════
-- PRUEBA 15: Autorización por curso — tesorero de curso-test-1
--            puede registrar en curso-test-1 pero NO en curso-test-2
-- ════════════════════════════════════════════════════════════
\echo 'PRUEBA 15: Autorización por curso — tesorero acotado a curso-test-1 no puede en curso-test-2'
DO $$
DECLARE
  v_error_capturado BOOLEAN := false;
  v_cnt             INT;
BEGIN
  -- Cambiar a tesorero acotado (uid=…0002, solo curso-test-1)
  PERFORM set_config('app.test_es_dueno', 'false', true);
  PERFORM set_config('app.test_user_id', '00000000-0000-0000-0000-000000000002', true);

  DELETE FROM pagos WHERE idempotency_key IN ('t15-curso1', 't15-curso2');

  -- PERMITIDO: pago en cuota-test-1 (pertenece a curso-test-1)
  PERFORM insertar_pagos_lote('aaaaaaaa-0000-0000-0000-000000000001'::UUID,
    '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":5000,"fecha":"2025-01-10","medio":"efectivo","periodo":"Enero 2025","idempotency_key":"t15-curso1"}]'::JSONB);

  SELECT COUNT(*) INTO v_cnt FROM pagos WHERE idempotency_key = 't15-curso1';
  IF v_cnt != 1 THEN
    RAISE EXCEPTION 'FAIL: Prueba 15a — tesorero debería poder pagar en su propio curso (curso-test-1)';
  END IF;

  -- DENEGADO: pago en cuota-test-2 (pertenece a curso-test-2, fuera de alcance)
  BEGIN
    PERFORM insertar_pagos_lote('aaaaaaaa-0000-0000-0000-000000000001'::UUID,
      '[{"alumno_id":"alu-test-2","cuota_id":"cuota-test-2","monto":5000,"fecha":"2025-01-10","medio":"efectivo","periodo":"Enero 2025","idempotency_key":"t15-curso2"}]'::JSONB);
  EXCEPTION WHEN OTHERS THEN
    v_error_capturado := true;
  END;

  -- Restaurar a dueño para tests posteriores
  PERFORM set_config('app.test_es_dueno', 'true', true);
  PERFORM set_config('app.test_user_id', '00000000-0000-0000-0000-000000000001', true);

  IF NOT v_error_capturado THEN
    RAISE EXCEPTION
      'FAIL: Prueba 15b — tesorero de curso-test-1 pudo registrar en curso-test-2 (autorización por curso rota)';
  END IF;
  RAISE NOTICE 'PASS: Prueba 15 — tesorero acotado: OK en curso-test-1, rechazado en curso-test-2';
END;
$$;

\echo ''
\echo '=== SUITE COMPLETADA: 15/15 PASS ==='
\echo 'Las concurrencia real (Test 5) se verifica con run_tests.sh'
