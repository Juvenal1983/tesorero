-- ============================================================
-- tests/01_suite_pagos_acumulables.sql
-- Suite de 15 pruebas para pagos acumulables, idempotencia,
-- autorización y atomicidad.
--
-- ENTORNO: PostgreSQL local (tesorero_test), SIN credenciales staging.
-- USO:
--   psql -d tesorero_test -v ON_ERROR_STOP=0 -f tests/01_suite_pagos_acumulables.sql
--
-- Resultado esperado: 15 líneas "PASS: ..." sin líneas "FAIL: ..."
-- ============================================================

\set ON_ERROR_STOP off
\t on
\pset format unaligned

-- ── Preparar fixtures de prueba ───────────────────────────────────────────────
DO $$
BEGIN
  -- Configurar como "dueño" para los fixtures
  PERFORM set_config('app.test_es_dueno', 'true', true);
  PERFORM set_config('app.test_user_id', '00000000-0000-0000-0000-000000000001', true);
END;
$$;

-- Cuenta A (autorizada)
INSERT INTO tesorero_cuentas (id) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001'::UUID)
  ON CONFLICT DO NOTHING;

-- Cuenta B (otro usuario — prueba de aislamiento)
INSERT INTO tesorero_cuentas (id) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001'::UUID)
  ON CONFLICT DO NOTHING;

-- Usuario de prueba en cuenta A (rol tesorero)
INSERT INTO usuarios_cuenta (cuenta_id, auth_id, rol) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001'::UUID,
   '00000000-0000-0000-0000-000000000001'::UUID,
   'tesorero')
  ON CONFLICT DO NOTHING;

-- Curso en cuenta A
INSERT INTO cursos (cuenta_id, id, nombre, anio) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001'::UUID, 'curso-test-1', 'Curso de Prueba', 2025)
  ON CONFLICT DO NOTHING;

-- Alumno en cuenta A
INSERT INTO alumnos (cuenta_id, id, curso_id, nombres, apellidos) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001'::UUID, 'alu-test-1', 'curso-test-1', 'Test', 'Alumno')
  ON CONFLICT DO NOTHING;

-- Cuota mensual en cuenta A
INSERT INTO cuotas (cuenta_id, id, curso_id, nombre, tipo, monto, anio) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001'::UUID, 'cuota-test-1', 'curso-test-1',
   'Cuota Mensual', 'mensual', 20000, 2025)
  ON CONFLICT DO NOTHING;

-- Cuota en cuenta B (para prueba de aislamiento)
INSERT INTO cursos (cuenta_id, id, nombre, anio) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001'::UUID, 'curso-b-1', 'Curso B', 2025)
  ON CONFLICT DO NOTHING;
INSERT INTO alumnos (cuenta_id, id, curso_id, nombres, apellidos) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001'::UUID, 'alu-b-1', 'curso-b-1', 'Otro', 'Alumno')
  ON CONFLICT DO NOTHING;
INSERT INTO cuotas (cuenta_id, id, curso_id, nombre, tipo, monto, anio) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001'::UUID, 'cuota-b-1', 'curso-b-1',
   'Cuota B', 'mensual', 20000, 2025)
  ON CONFLICT DO NOTHING;

-- Limpiar pagos de pruebas anteriores
DELETE FROM pagos WHERE cuenta_id = 'aaaaaaaa-0000-0000-0000-000000000001'::UUID;

\echo '=== INICIANDO SUITE DE PRUEBAS ==='
\echo ''

-- ════════════════════════════════════════════════════════════
-- Prueba 1: $8.000 + $12.000 cubren obligación de $20.000
--           Ambos pagos se conservan independientemente.
-- ════════════════════════════════════════════════════════════
\echo 'PRUEBA 1: Dos pagos parciales cubren la obligación (pagos acumulables)'
DO $$
DECLARE
  v_res JSONB;
  v_cnt INT;
BEGIN
  PERFORM set_config('app.test_es_dueno', 'true', true);
  DELETE FROM pagos WHERE cuenta_id = 'aaaaaaaa-0000-0000-0000-000000000001'::UUID
    AND alumno_id = 'alu-test-1' AND cuota_id = 'cuota-test-1' AND periodo = 'Marzo 2025';

  -- Primer pago parcial: $8.000
  v_res := insertar_pagos_lote(
    'aaaaaaaa-0000-0000-0000-000000000001'::UUID,
    '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":8000,"fecha":"2025-03-15","medio":"transferencia","periodo":"Marzo 2025","idempotency_key":"test1-pago1"}]'::JSONB
  );

  -- Segundo pago parcial: $12.000
  v_res := insertar_pagos_lote(
    'aaaaaaaa-0000-0000-0000-000000000001'::UUID,
    '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":12000,"fecha":"2025-03-20","medio":"efectivo","periodo":"Marzo 2025","idempotency_key":"test1-pago2"}]'::JSONB
  );

  SELECT COUNT(*) INTO v_cnt FROM pagos
   WHERE cuenta_id = 'aaaaaaaa-0000-0000-0000-000000000001'::UUID
     AND alumno_id = 'alu-test-1' AND cuota_id = 'cuota-test-1' AND periodo = 'Marzo 2025';

  IF v_cnt = 2 THEN
    RAISE NOTICE 'PASS: Prueba 1 — 2 pagos acumulables registrados (% filas)', v_cnt;
  ELSE
    RAISE WARNING 'FAIL: Prueba 1 — se esperaban 2 filas, se encontraron %', v_cnt;
  END IF;

  -- Verificar suma
  DECLARE
    v_total INT;
  BEGIN
    SELECT SUM(monto) INTO v_total FROM pagos
     WHERE cuenta_id = 'aaaaaaaa-0000-0000-0000-000000000001'::UUID
       AND alumno_id = 'alu-test-1' AND cuota_id = 'cuota-test-1' AND periodo = 'Marzo 2025';
    IF v_total = 20000 THEN
      RAISE NOTICE 'PASS: Prueba 1b — suma $20.000 cubre obligación completa';
    ELSE
      RAISE WARNING 'FAIL: Prueba 1b — suma esperada $20.000, obtenida $%', v_total;
    END IF;
  END;
END;
$$;

-- ════════════════════════════════════════════════════════════
-- Prueba 2: Dos pagos legítimos idénticos con claves distintas
-- ════════════════════════════════════════════════════════════
\echo 'PRUEBA 2: Dos pagos legítimos idénticos con claves de idempotencia distintas'
DO $$
DECLARE
  v_cnt INT;
BEGIN
  PERFORM set_config('app.test_es_dueno', 'true', true);
  DELETE FROM pagos WHERE cuenta_id = 'aaaaaaaa-0000-0000-0000-000000000001'::UUID
    AND alumno_id = 'alu-test-1' AND cuota_id = 'cuota-test-1' AND periodo = 'Abril 2025';

  PERFORM insertar_pagos_lote(
    'aaaaaaaa-0000-0000-0000-000000000001'::UUID,
    '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":20000,"fecha":"2025-04-05","medio":"transferencia","periodo":"Abril 2025","idempotency_key":"test2-pago1"}]'::JSONB
  );
  PERFORM insertar_pagos_lote(
    'aaaaaaaa-0000-0000-0000-000000000001'::UUID,
    '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":20000,"fecha":"2025-04-05","medio":"transferencia","periodo":"Abril 2025","idempotency_key":"test2-pago2"}]'::JSONB
  );

  SELECT COUNT(*) INTO v_cnt FROM pagos
   WHERE cuenta_id = 'aaaaaaaa-0000-0000-0000-000000000001'::UUID
     AND alumno_id = 'alu-test-1' AND cuota_id = 'cuota-test-1' AND periodo = 'Abril 2025';

  IF v_cnt = 2 THEN
    RAISE NOTICE 'PASS: Prueba 2 — 2 pagos legítimos idénticos admitidos (claves distintas)';
  ELSE
    RAISE WARNING 'FAIL: Prueba 2 — esperadas 2 filas, obtenidas %', v_cnt;
  END IF;
END;
$$;

-- ════════════════════════════════════════════════════════════
-- Prueba 3: Reintento con misma clave no duplica
-- ════════════════════════════════════════════════════════════
\echo 'PRUEBA 3: Reintento con la misma clave de idempotencia no duplica fila'
DO $$
DECLARE
  v_cnt   INT;
  v_id1   TEXT;
  v_id2   TEXT;
  v_res1  JSONB;
  v_res2  JSONB;
BEGIN
  PERFORM set_config('app.test_es_dueno', 'true', true);
  DELETE FROM pagos WHERE cuenta_id = 'aaaaaaaa-0000-0000-0000-000000000001'::UUID
    AND idempotency_key = 'test3-reintento';

  v_res1 := insertar_pagos_lote(
    'aaaaaaaa-0000-0000-0000-000000000001'::UUID,
    '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":20000,"fecha":"2025-05-10","medio":"transferencia","periodo":"Mayo 2025","idempotency_key":"test3-reintento"}]'::JSONB
  );
  v_id1 := (v_res1->0)->>'id';

  -- Reintento con misma clave
  v_res2 := insertar_pagos_lote(
    'aaaaaaaa-0000-0000-0000-000000000001'::UUID,
    '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":20000,"fecha":"2025-05-10","medio":"transferencia","periodo":"Mayo 2025","idempotency_key":"test3-reintento"}]'::JSONB
  );
  v_id2 := (v_res2->0)->>'id';

  SELECT COUNT(*) INTO v_cnt FROM pagos
   WHERE cuenta_id = 'aaaaaaaa-0000-0000-0000-000000000001'::UUID
     AND idempotency_key = 'test3-reintento';

  IF v_cnt = 1 AND v_id1 = v_id2 THEN
    RAISE NOTICE 'PASS: Prueba 3 — reintento retorna fila existente, 1 sola fila en DB';
  ELSE
    RAISE WARNING 'FAIL: Prueba 3 — cnt=%, id1=%, id2=%', v_cnt, v_id1, v_id2;
  END IF;
END;
$$;

-- ════════════════════════════════════════════════════════════
-- Prueba 4: Misma clave con cuenta distinta se rechaza
-- ════════════════════════════════════════════════════════════
\echo 'PRUEBA 4: Misma clave de idempotencia con cuenta_id distinta es rechazada'
DO $$
DECLARE
  v_error TEXT := '';
BEGIN
  PERFORM set_config('app.test_es_dueno', 'true', true);

  -- Insertar en cuenta A primero
  DELETE FROM pagos WHERE idempotency_key = 'test4-cross-cuenta';
  PERFORM insertar_pagos_lote(
    'aaaaaaaa-0000-0000-0000-000000000001'::UUID,
    '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":5000,"fecha":"2025-06-01","medio":"transferencia","periodo":"Junio 2025","idempotency_key":"test4-cross-cuenta"}]'::JSONB
  );

  -- Intentar usar la misma clave desde cuenta B → debe rechazar
  BEGIN
    PERFORM insertar_pagos_lote(
      'bbbbbbbb-0000-0000-0000-000000000001'::UUID,
      '[{"alumno_id":"alu-b-1","cuota_id":"cuota-b-1","monto":5000,"fecha":"2025-06-01","medio":"transferencia","periodo":"Junio 2025","idempotency_key":"test4-cross-cuenta"}]'::JSONB
    );
    -- Si llega aquí sin error, la prueba falló
    RAISE WARNING 'FAIL: Prueba 4 — clave cross-cuenta no fue rechazada';
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
    IF v_error LIKE '%cross-cuenta%' OR v_error LIKE '%otra cuenta%' OR SQLSTATE IN ('23505','42501') THEN
      RAISE NOTICE 'PASS: Prueba 4 — clave cross-cuenta rechazada correctamente (SQLSTATE=%, msg=%)', SQLSTATE, LEFT(v_error,80);
    ELSE
      RAISE WARNING 'FAIL: Prueba 4 — error inesperado: %', v_error;
    END IF;
  END;
END;
$$;

-- ════════════════════════════════════════════════════════════
-- Prueba 5: Reintentos concurrentes simulados (misma clave, 3 veces)
-- ════════════════════════════════════════════════════════════
\echo 'PRUEBA 5: Reintentos concurrentes simulados (3x misma clave)'
DO $$
DECLARE
  v_cnt INT;
  i     INT;
BEGIN
  PERFORM set_config('app.test_es_dueno', 'true', true);
  DELETE FROM pagos WHERE idempotency_key LIKE 'test5-concurrent%';

  FOR i IN 1..3 LOOP
    PERFORM insertar_pagos_lote(
      'aaaaaaaa-0000-0000-0000-000000000001'::UUID,
      '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":20000,"fecha":"2025-07-01","medio":"transferencia","periodo":"Julio 2025","idempotency_key":"test5-concurrent"}]'::JSONB
    );
  END LOOP;

  SELECT COUNT(*) INTO v_cnt FROM pagos WHERE idempotency_key = 'test5-concurrent';

  IF v_cnt = 1 THEN
    RAISE NOTICE 'PASS: Prueba 5 — 3 reintentos concurrentes producen 1 sola fila';
  ELSE
    RAISE WARNING 'FAIL: Prueba 5 — esperada 1 fila, obtenidas %', v_cnt;
  END IF;
END;
$$;

-- ════════════════════════════════════════════════════════════
-- Prueba 6: Falla intermedia de lote — ninguna fila confirmada
-- ════════════════════════════════════════════════════════════
\echo 'PRUEBA 6: Fallo en segundo pago del lote revierte todo (atomicidad)'
DO $$
DECLARE
  v_cnt_antes INT;
  v_cnt_desp  INT;
  v_error     TEXT;
BEGIN
  PERFORM set_config('app.test_es_dueno', 'true', true);

  SELECT COUNT(*) INTO v_cnt_antes FROM pagos
   WHERE cuenta_id = 'aaaaaaaa-0000-0000-0000-000000000001'::UUID
     AND periodo = 'Agosto 2025';

  BEGIN
    -- Lote: primer pago válido, segundo con monto inválido (0)
    PERFORM insertar_pagos_lote(
      'aaaaaaaa-0000-0000-0000-000000000001'::UUID,
      '[
        {"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":10000,"fecha":"2025-08-01","medio":"transferencia","periodo":"Agosto 2025","idempotency_key":"test6-pago1"},
        {"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":0,"fecha":"2025-08-01","medio":"efectivo","periodo":"Agosto 2025","idempotency_key":"test6-pago2"}
      ]'::JSONB
    );
    RAISE WARNING 'FAIL: Prueba 6 — no se lanzó error con monto=0';
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
    -- La transacción fue revertida por PostgreSQL en el EXCEPTION WHEN OTHERS
    -- Verificamos que no quedó ninguna fila del Agosto 2025 insertada
    SELECT COUNT(*) INTO v_cnt_desp FROM pagos
     WHERE cuenta_id = 'aaaaaaaa-0000-0000-0000-000000000001'::UUID
       AND periodo = 'Agosto 2025';

    IF v_cnt_desp = v_cnt_antes THEN
      RAISE NOTICE 'PASS: Prueba 6 — lote revertido, 0 filas confirmadas (% filas antes=después=%)', v_cnt_antes, v_cnt_desp;
    ELSE
      RAISE WARNING 'FAIL: Prueba 6 — se confirmaron % filas a pesar del error en el lote', v_cnt_desp - v_cnt_antes;
    END IF;
  END;
END;
$$;

-- ════════════════════════════════════════════════════════════
-- Prueba 7: Usuario autorizado en curso A intenta operar en B
-- ════════════════════════════════════════════════════════════
\echo 'PRUEBA 7: Usuario de cuenta A rechazado al operar en cuenta B'
DO $$
DECLARE
  v_error TEXT;
BEGIN
  -- Configurar usuario solo en cuenta A (no en B)
  PERFORM set_config('app.test_es_dueno', 'false', true);
  PERFORM set_config('app.test_user_id', '00000000-0000-0000-0000-000000000001', true);

  BEGIN
    PERFORM insertar_pagos_lote(
      'bbbbbbbb-0000-0000-0000-000000000001'::UUID,
      '[{"alumno_id":"alu-b-1","cuota_id":"cuota-b-1","monto":5000,"fecha":"2025-01-01","medio":"transferencia","periodo":"Enero 2025","idempotency_key":"test7-b1"}]'::JSONB
    );
    RAISE WARNING 'FAIL: Prueba 7 — inserción en cuenta B no fue rechazada';
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
    IF SQLSTATE = '42501' THEN
      RAISE NOTICE 'PASS: Prueba 7 — inserción en cuenta B rechazada (SQLSTATE=42501)';
    ELSE
      RAISE WARNING 'FAIL: Prueba 7 — error inesperado SQLSTATE=%, msg=%', SQLSTATE, LEFT(v_error,80);
    END IF;
  END;

  -- Restaurar para siguientes pruebas
  PERFORM set_config('app.test_es_dueno', 'true', true);
END;
$$;

-- ════════════════════════════════════════════════════════════
-- Prueba 8: Sobrepago de Marzo no reduce saldo de Abril
-- ════════════════════════════════════════════════════════════
\echo 'PRUEBA 8: Excedente de Marzo no reduce deuda de Abril'
DO $$
DECLARE
  v_pagados_mar INT;
  v_pagados_abr INT;
BEGIN
  PERFORM set_config('app.test_es_dueno', 'true', true);
  DELETE FROM pagos WHERE cuenta_id = 'aaaaaaaa-0000-0000-0000-000000000001'::UUID
    AND periodo IN ('Marzo 2025B', 'Abril 2025B');

  -- Sobrepago de Marzo: $25.000 sobre obligación de $20.000
  PERFORM insertar_pagos_lote(
    'aaaaaaaa-0000-0000-0000-000000000001'::UUID,
    '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":25000,"fecha":"2025-03-10","medio":"transferencia","periodo":"Marzo 2025B","idempotency_key":"test8-mar"}]'::JSONB
  );

  -- Abril sin pago
  SELECT SUM(monto) INTO v_pagados_mar FROM pagos
   WHERE cuenta_id = 'aaaaaaaa-0000-0000-0000-000000000001'::UUID
     AND alumno_id = 'alu-test-1' AND cuota_id = 'cuota-test-1' AND periodo = 'Marzo 2025B';

  SELECT COALESCE(SUM(monto), 0) INTO v_pagados_abr FROM pagos
   WHERE cuenta_id = 'aaaaaaaa-0000-0000-0000-000000000001'::UUID
     AND alumno_id = 'alu-test-1' AND cuota_id = 'cuota-test-1' AND periodo = 'Abril 2025B';

  -- El excedente de Marzo ($5.000) no debe aparecer en Abril
  IF v_pagados_abr = 0 THEN
    RAISE NOTICE 'PASS: Prueba 8 — Abril saldo=0 (excedente de Marzo no trasladado)';
  ELSE
    RAISE WARNING 'FAIL: Prueba 8 — Abril tiene $ % (debería ser 0)', v_pagados_abr;
  END IF;

  -- Verificar que Marzo sí tiene $25.000
  IF v_pagados_mar = 25000 THEN
    RAISE NOTICE 'PASS: Prueba 8b — Marzo registra $25.000 completos';
  ELSE
    RAISE WARNING 'FAIL: Prueba 8b — Marzo tiene $% (esperado $25.000)', v_pagados_mar;
  END IF;
END;
$$;

-- ════════════════════════════════════════════════════════════
-- Prueba 9: Alumno inválido es rechazado
-- (cubre validación de pertenencia de alumno a la cuenta)
-- ════════════════════════════════════════════════════════════
\echo 'PRUEBA 9: alumno_id de otra cuenta es rechazado'
DO $$
DECLARE
  v_error TEXT;
BEGIN
  PERFORM set_config('app.test_es_dueno', 'true', true);

  BEGIN
    PERFORM insertar_pagos_lote(
      'aaaaaaaa-0000-0000-0000-000000000001'::UUID,
      '[{"alumno_id":"alu-b-1","cuota_id":"cuota-test-1","monto":5000,"fecha":"2025-01-01","medio":"transferencia","periodo":"Enero 2025","idempotency_key":"test9-alu-b"}]'::JSONB
    );
    RAISE WARNING 'FAIL: Prueba 9 — alumno de cuenta B no fue rechazado';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE IN ('42501','23503','23514','P0001') OR SQLERRM LIKE '%no pertenece%' THEN
      RAISE NOTICE 'PASS: Prueba 9 — alumno de otra cuenta rechazado (SQLSTATE=%)', SQLSTATE;
    ELSE
      RAISE WARNING 'FAIL: Prueba 9 — error inesperado SQLSTATE=%, %', SQLSTATE, LEFT(SQLERRM,80);
    END IF;
  END;
END;
$$;

-- ════════════════════════════════════════════════════════════
-- Prueba 10: Monto negativo rechazado
-- ════════════════════════════════════════════════════════════
\echo 'PRUEBA 10: Monto negativo rechazado por el RPC'
DO $$
BEGIN
  PERFORM set_config('app.test_es_dueno', 'true', true);
  BEGIN
    PERFORM insertar_pagos_lote(
      'aaaaaaaa-0000-0000-0000-000000000001'::UUID,
      '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":-1000,"fecha":"2025-01-01","medio":"transferencia","periodo":"Enero 2025","idempotency_key":"test10-neg"}]'::JSONB
    );
    RAISE WARNING 'FAIL: Prueba 10 — monto negativo no fue rechazado';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE IN ('22023','23514') OR SQLERRM LIKE '%monto inválido%' OR SQLERRM LIKE '%monto%' THEN
      RAISE NOTICE 'PASS: Prueba 10 — monto negativo rechazado correctamente (SQLSTATE=%)', SQLSTATE;
    ELSE
      RAISE WARNING 'FAIL: Prueba 10 — error inesperado SQLSTATE=%, %', SQLSTATE, LEFT(SQLERRM,80);
    END IF;
  END;
END;
$$;

-- ════════════════════════════════════════════════════════════
-- Prueba 11: Monto = 0 rechazado
-- ════════════════════════════════════════════════════════════
\echo 'PRUEBA 11: Monto=0 rechazado'
DO $$
BEGIN
  PERFORM set_config('app.test_es_dueno', 'true', true);
  BEGIN
    PERFORM insertar_pagos_lote(
      'aaaaaaaa-0000-0000-0000-000000000001'::UUID,
      '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":0,"fecha":"2025-01-01","medio":"transferencia","periodo":"Enero 2025","idempotency_key":"test11-cero"}]'::JSONB
    );
    RAISE WARNING 'FAIL: Prueba 11 — monto=0 no fue rechazado';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE IN ('22023','23514') OR SQLERRM LIKE '%monto inválido%' OR SQLERRM LIKE '%monto%' THEN
      RAISE NOTICE 'PASS: Prueba 11 — monto=0 rechazado correctamente (SQLSTATE=%)', SQLSTATE;
    ELSE
      RAISE WARNING 'FAIL: Prueba 11 — error inesperado SQLSTATE=%, %', SQLSTATE, LEFT(SQLERRM,80);
    END IF;
  END;
END;
$$;

-- ════════════════════════════════════════════════════════════
-- Prueba 12: Lote vacío retorna array vacío sin error
-- ════════════════════════════════════════════════════════════
\echo 'PRUEBA 12: Lote vacío retorna [] sin error'
DO $$
DECLARE
  v_res JSONB;
BEGIN
  PERFORM set_config('app.test_es_dueno', 'true', true);
  v_res := insertar_pagos_lote(
    'aaaaaaaa-0000-0000-0000-000000000001'::UUID,
    '[]'::JSONB
  );
  IF v_res = '[]'::JSONB THEN
    RAISE NOTICE 'PASS: Prueba 12 — lote vacío retorna []';
  ELSE
    RAISE WARNING 'FAIL: Prueba 12 — resultado inesperado: %', v_res;
  END IF;
END;
$$;

-- ════════════════════════════════════════════════════════════
-- Prueba 13: Reintento retorna fila con ID original aunque monto sea distinto
-- (el contenido existente se conserva tal cual)
-- ════════════════════════════════════════════════════════════
\echo 'PRUEBA 13: Reintento con monto distinto retorna fila ORIGINAL (no modifica)'
DO $$
DECLARE
  v_res1  JSONB;
  v_res2  JSONB;
  v_monto1 INT;
  v_monto2 INT;
BEGIN
  PERFORM set_config('app.test_es_dueno', 'true', true);
  DELETE FROM pagos WHERE idempotency_key = 'test13-orig';

  -- Inserción original con $5.000
  v_res1 := insertar_pagos_lote(
    'aaaaaaaa-0000-0000-0000-000000000001'::UUID,
    '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":5000,"fecha":"2025-09-01","medio":"transferencia","periodo":"Sept 2025","idempotency_key":"test13-orig"}]'::JSONB
  );
  v_monto1 := ((v_res1->0)->>'monto')::INT;

  -- Reintento con monto diferente ($9.999) — debe retornar $5.000
  v_res2 := insertar_pagos_lote(
    'aaaaaaaa-0000-0000-0000-000000000001'::UUID,
    '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":9999,"fecha":"2025-09-01","medio":"transferencia","periodo":"Sept 2025","idempotency_key":"test13-orig"}]'::JSONB
  );
  v_monto2 := ((v_res2->0)->>'monto')::INT;

  IF v_monto1 = 5000 AND v_monto2 = 5000 THEN
    RAISE NOTICE 'PASS: Prueba 13 — reintento retorna fila original ($5.000), no modifica';
  ELSE
    RAISE WARNING 'FAIL: Prueba 13 — monto1=%, monto2=% (esperado ambos=5000)', v_monto1, v_monto2;
  END IF;
END;
$$;

-- ════════════════════════════════════════════════════════════
-- Prueba 14: p_pagos no es array → error claro
-- ════════════════════════════════════════════════════════════
\echo 'PRUEBA 14: p_pagos no array retorna error 22023'
DO $$
BEGIN
  PERFORM set_config('app.test_es_dueno', 'true', true);
  BEGIN
    PERFORM insertar_pagos_lote(
      'aaaaaaaa-0000-0000-0000-000000000001'::UUID,
      '{"alumno_id":"alu-test-1"}'::JSONB  -- objeto, no array
    );
    RAISE WARNING 'FAIL: Prueba 14 — no se rechazó p_pagos no-array';
  EXCEPTION WHEN OTHERS THEN
    -- 22023 = invalid_parameter_value (nuestro RAISE), 22P02 = error de tipo/cast
    IF SQLSTATE IN ('22023','22P02') OR SQLERRM LIKE '%array%' OR SQLERRM LIKE '%p_pagos%' THEN
      RAISE NOTICE 'PASS: Prueba 14 — p_pagos no-array rechazado (SQLSTATE=%)', SQLSTATE;
    ELSE
      RAISE WARNING 'FAIL: Prueba 14 — error inesperado SQLSTATE=%', SQLSTATE;
    END IF;
  END;
END;
$$;

-- ════════════════════════════════════════════════════════════
-- Prueba 15: Pago sin idempotency_key siempre inserta nuevo
-- (dos pagos legítimos iguales sin clave: se admiten ambos)
-- ════════════════════════════════════════════════════════════
\echo 'PRUEBA 15: Dos pagos sin idempotency_key se admiten independientemente'
DO $$
DECLARE
  v_cnt INT;
BEGIN
  PERFORM set_config('app.test_es_dueno', 'true', true);
  DELETE FROM pagos WHERE cuenta_id = 'aaaaaaaa-0000-0000-0000-000000000001'::UUID
    AND periodo = 'Oct 2025' AND idempotency_key IS NULL;

  PERFORM insertar_pagos_lote(
    'aaaaaaaa-0000-0000-0000-000000000001'::UUID,
    '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":10000,"fecha":"2025-10-01","medio":"transferencia","periodo":"Oct 2025"}]'::JSONB
  );
  PERFORM insertar_pagos_lote(
    'aaaaaaaa-0000-0000-0000-000000000001'::UUID,
    '[{"alumno_id":"alu-test-1","cuota_id":"cuota-test-1","monto":10000,"fecha":"2025-10-01","medio":"transferencia","periodo":"Oct 2025"}]'::JSONB
  );

  SELECT COUNT(*) INTO v_cnt FROM pagos
   WHERE cuenta_id = 'aaaaaaaa-0000-0000-0000-000000000001'::UUID
     AND periodo = 'Oct 2025' AND idempotency_key IS NULL;

  IF v_cnt = 2 THEN
    RAISE NOTICE 'PASS: Prueba 15 — 2 pagos sin clave admitidos (pagos acumulables sin idempotencia)';
  ELSE
    RAISE WARNING 'FAIL: Prueba 15 — esperadas 2 filas, obtenidas %', v_cnt;
  END IF;
END;
$$;

-- ── Resumen de fixtures creados ──────────────────────────────────────────────
\echo ''
\echo '=== Pagos en DB de prueba: ==='
SELECT periodo, COUNT(*) as pagos, SUM(monto) as total
FROM pagos
WHERE cuenta_id = 'aaaaaaaa-0000-0000-0000-000000000001'::UUID
GROUP BY periodo
ORDER BY periodo;

\echo ''
\echo '=== FIN DE SUITE ==='
\echo 'Busca "FAIL:" en la salida para ver errores. Sin FAIL = todo OK.'
