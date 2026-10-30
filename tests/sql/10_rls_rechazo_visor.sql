-- ============================================================
-- El Tesorero — "El Gran Cambio" v9
-- Archivo: tests/sql/10_rls_rechazo_visor.sql
-- Propósito: Confirmar que el rol 'visor' (usuario C) no puede
--            ejecutar INSERT, UPDATE ni DELETE, sin modificar
--            registros existentes. Todo dentro de BEGIN/ROLLBACK.
--
-- Requiere: 08_seed_staging.sql + 09_fixture_usuario_c.sql ejecutados.
-- UUID de C: cccccccc-cccc-cccc-cccc-cccccccccccc
-- C es visor en Cuenta A, asignado a cur-a-01.
--
-- Convención de resultado:
--   'OK RECHAZADO'  → RLS bloqueó la operación (error capturado)
--   'FALLO: permitio escritura' → política deficiente (no debe ocurrir)
-- ============================================================

BEGIN;

-- ── Simular identidad de C ────────────────────────────────────
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}',
  true
);
SET LOCAL ROLE authenticated;

-- ── Verificar que C puede leer (SELECT) ──────────────────────
DO $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM alumnos
  WHERE cuenta_id = '00000000-0000-0000-aaaa-000000000001';

  RAISE NOTICE 'C ve % alumno(s) en Cuenta A (esperado ≥1)', v_count;
END $$;

-- ── TEST 1: INSERT en pagos ───────────────────────────────────
DO $$
BEGIN
  BEGIN
    INSERT INTO pagos (cuenta_id, id, alumno_id, cuota_id, monto, fecha, medio, estado, periodo)
    VALUES (
      '00000000-0000-0000-aaaa-000000000001'::uuid,
      'pago-visor-test',
      'alu-a-01',
      'cuota-a-01',
      1, '2025-01-01', 'efectivo', 'pagado', 'Test'
    );
    RAISE NOTICE 'TEST 1 INSERT pagos: FALLO — permitio escritura (visor no debe poder insertar pagos)';
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'TEST 1 INSERT pagos: OK RECHAZADO (%)', SQLERRM;
  END;
END $$;

-- ── TEST 2: UPDATE en pagos ───────────────────────────────────
DO $$
BEGIN
  BEGIN
    UPDATE pagos
    SET monto = 99999
    WHERE cuenta_id = '00000000-0000-0000-aaaa-000000000001'
      AND id = 'pago-a-01';
    RAISE NOTICE 'TEST 2 UPDATE pagos: FALLO — permitio escritura';
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'TEST 2 UPDATE pagos: OK RECHAZADO (%)', SQLERRM;
  END;
END $$;

-- ── TEST 3: DELETE en pagos ───────────────────────────────────
DO $$
BEGIN
  BEGIN
    DELETE FROM pagos
    WHERE cuenta_id = '00000000-0000-0000-aaaa-000000000001'
      AND id = 'pago-a-01';
    RAISE NOTICE 'TEST 3 DELETE pagos: FALLO — permitio escritura';
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'TEST 3 DELETE pagos: OK RECHAZADO (%)', SQLERRM;
  END;
END $$;

-- ── TEST 4: INSERT en alumnos ─────────────────────────────────
DO $$
BEGIN
  BEGIN
    INSERT INTO alumnos (cuenta_id, id, curso_id, nombres, apellidos, activo)
    VALUES (
      '00000000-0000-0000-aaaa-000000000001'::uuid,
      'alu-visor-test',
      'cur-a-01',
      'Test', 'Visor', true
    );
    RAISE NOTICE 'TEST 4 INSERT alumnos: FALLO — permitio escritura';
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'TEST 4 INSERT alumnos: OK RECHAZADO (%)', SQLERRM;
  END;
END $$;

-- ── TEST 5: UPDATE en alumnos ─────────────────────────────────
DO $$
BEGIN
  BEGIN
    UPDATE alumnos
    SET nombres = 'HackeadoPorVisor'
    WHERE cuenta_id = '00000000-0000-0000-aaaa-000000000001'
      AND id = 'alu-a-01';
    RAISE NOTICE 'TEST 5 UPDATE alumnos: FALLO — permitio escritura';
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'TEST 5 UPDATE alumnos: OK RECHAZADO (%)', SQLERRM;
  END;
END $$;

-- ── TEST 6: INSERT en cuotas ──────────────────────────────────
DO $$
BEGIN
  BEGIN
    INSERT INTO cuotas (cuenta_id, id, curso_id, nombre, tipo, monto, anio, activa)
    VALUES (
      '00000000-0000-0000-aaaa-000000000001'::uuid,
      'cuota-visor-test',
      'cur-a-01',
      'Cuota Visor', 'mensual', 1, 2025, true
    );
    RAISE NOTICE 'TEST 6 INSERT cuotas: FALLO — permitio escritura';
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'TEST 6 INSERT cuotas: OK RECHAZADO (%)', SQLERRM;
  END;
END $$;

-- ── TEST 7: INSERT en abonos ──────────────────────────────────
DO $$
BEGIN
  BEGIN
    INSERT INTO abonos (cuenta_id, id, plan_id, monto, fecha, pagado)
    VALUES (
      '00000000-0000-0000-aaaa-000000000001'::uuid,
      'abono-visor-test',
      'plan-a-01',
      1, '2025-01-01', false
    );
    RAISE NOTICE 'TEST 7 INSERT abonos: FALLO — permitio escritura';
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'TEST 7 INSERT abonos: OK RECHAZADO (%)', SQLERRM;
  END;
END $$;

-- ── Verificar que ningún registro fue modificado ──────────────
DO $$
DECLARE
  v_pago_monto int;
  v_alu_nombre text;
BEGIN
  SELECT monto INTO v_pago_monto
  FROM pagos
  WHERE cuenta_id = '00000000-0000-0000-aaaa-000000000001' AND id = 'pago-a-01';

  SELECT nombres INTO v_alu_nombre
  FROM alumnos
  WHERE cuenta_id = '00000000-0000-0000-aaaa-000000000001' AND id = 'alu-a-01';

  IF v_pago_monto = 15000 THEN
    RAISE NOTICE 'Integridad OK: pago-a-01 mantiene monto=$', v_pago_monto;
  ELSE
    RAISE NOTICE 'ALERTA: pago-a-01 tiene monto=% (esperado 15000)', v_pago_monto;
  END IF;

  IF v_alu_nombre <> 'HackeadoPorVisor' THEN
    RAISE NOTICE 'Integridad OK: alu-a-01 nombres no fue modificado';
  ELSE
    RAISE NOTICE 'ALERTA: alu-a-01.nombres fue modificado (RLS fallida)';
  END IF;
END $$;

ROLLBACK;
-- ════════════════════════════════════════════════════════════════
-- Resultado esperado en NOTICE:
--   TEST 1 INSERT pagos:   OK RECHAZADO (new row violates row-level security...)
--   TEST 2 UPDATE pagos:   OK RECHAZADO (...)
--   TEST 3 DELETE pagos:   OK RECHAZADO (...)
--   TEST 4 INSERT alumnos: OK RECHAZADO (...)
--   TEST 5 UPDATE alumnos: OK RECHAZADO (...)
--   TEST 6 INSERT cuotas:  OK RECHAZADO (...)
--   TEST 7 INSERT abonos:  OK RECHAZADO (...)
--   Integridad OK: pago-a-01 mantiene monto=15000
--   Integridad OK: alu-a-01 nombres no fue modificado
-- ════════════════════════════════════════════════════════════════
