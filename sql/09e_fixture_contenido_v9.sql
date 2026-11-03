-- ============================================================
-- El Tesorero — "El Gran Cambio" v9
-- Archivo: sql/09e_fixture_contenido_v9.sql
-- Propósito: Datos adicionales para pruebas de contenido correcto.
--
-- Depende de: 08_seed_staging.sql, 09d_fixture_apoderado_v9.sql
-- No modifica seed base ni fixture 09d.
-- Solo agrega registros necesarios para verificar que los RPC
-- retornan el contenido correcto (no solo arrays vacíos).
--
-- Datos que agrega:
--   pagos:
--     pago-a-02: alu-a-02, cuota-a-01 → NO debe aparecer en pagos de alu-a-01
--   movimientos (cur-a-01):
--     mov-a-01: visible=TRUE,  comprobante=URL  → DEBE aparecer en comprobantes
--     mov-a-02: visible=FALSE, comprobante=URL  → NO debe aparecer
--     mov-a-03: visible=TRUE,  comprobante=NULL → NO debe aparecer
--   planes_pago:
--     plan-a-09e: alu-a-01, cuota-a-02 → debe aparecer en planes
--   abonos:
--     abono-a-09e: plan-a-09e, monto=5000, pagado=TRUE → monto_abonado=5000
--
--   ─── Datos exclusivos para prueba de estado por período ────────
--   cuotas:
--     cuota-a-tst: cuota nueva exclusiva de test (cur-a-01, activa=TRUE)
--       NO depende de cuota-a-02 (que en staging puede tener pagos de Sofía)
--   pagos:
--     pago-a-tst-mar: alu-a-01, cuota-a-tst, Marzo 2025, estado=pagado
--     pago-a-tst-abr: alu-a-01, cuota-a-tst, Abril 2025, estado=pendiente
--   Esto permite probar PC-PERIOD: misma cuota, mismo alumno → un período
--   aparece como pagado y otro como pendiente (formato LEFT JOIN por período).
-- ============================================================

BEGIN;

SET search_path = public, extensions;

-- ── Pago de alu-a-02 (NO debe aparecer en respuesta de alu-a-01) ──
INSERT INTO pagos (cuenta_id, id, alumno_id, cuota_id, monto, fecha, medio, estado, periodo)
VALUES (
  '00000000-0000-0000-aaaa-000000000001'::uuid,
  'pago-a-02', 'alu-a-02', 'cuota-a-01',
  15000, '2025-03-15', 'transferencia', 'pagado', '2025-03'
)
ON CONFLICT (cuenta_id, id) DO NOTHING;

-- ── Movimientos del curso cur-a-01 ──────────────────────────────
-- mov-a-01: visible + con comprobante → APARECE en comprobantes
INSERT INTO movimientos (cuenta_id, id, curso_id, tipo, monto, "desc", fecha, visible, comprobante)
VALUES (
  '00000000-0000-0000-aaaa-000000000001'::uuid,
  'mov-a-01', 'cur-a-01', 'gasto', 8000,
  'Impresión circular marzo', '2025-03-10',
  TRUE, 'https://example.com/comprobante-1.pdf'
)
ON CONFLICT (cuenta_id, id) DO NOTHING;

-- mov-a-02: visible=FALSE + con comprobante → NO aparece (oculto)
INSERT INTO movimientos (cuenta_id, id, curso_id, tipo, monto, "desc", fecha, visible, comprobante)
VALUES (
  '00000000-0000-0000-aaaa-000000000001'::uuid,
  'mov-a-02', 'cur-a-01', 'gasto', 3000,
  'Gasto interno no publicado', '2025-03-12',
  FALSE, 'https://example.com/comprobante-oculto.pdf'
)
ON CONFLICT (cuenta_id, id) DO NOTHING;

-- mov-a-03: visible=TRUE pero sin URL de comprobante → NO aparece
INSERT INTO movimientos (cuenta_id, id, curso_id, tipo, monto, "desc", fecha, visible, comprobante)
VALUES (
  '00000000-0000-0000-aaaa-000000000001'::uuid,
  'mov-a-03', 'cur-a-01', 'ingreso', 15000,
  'Pago recibido sin comprobante adjunto', '2025-03-20',
  TRUE, NULL
)
ON CONFLICT (cuenta_id, id) DO NOTHING;

-- ── Plan de pago y abono para alu-a-01 ──────────────────────────
-- Nota: el seed ya tiene 'plan-a-01' para alu-a-02; se usa 'plan-a-09e'
-- para evitar conflicto. La cuota-a-01 tiene pago pagado (pago-a-01),
-- aquí usamos cuota-a-02 (pendiente) para probar plan sobre cuota distinta.
INSERT INTO planes_pago (cuenta_id, id, alumno_id, cuota_id, periodo, monto_total, activo, creado_en)
VALUES (
  '00000000-0000-0000-aaaa-000000000001'::uuid,
  'plan-a-09e', 'alu-a-01', 'cuota-a-02',
  '2025-04', 15000, TRUE, '2025-04-01'
)
ON CONFLICT (cuenta_id, id) DO NOTHING;

INSERT INTO abonos (cuenta_id, id, alumno_id, cuota_id, plan_id, monto, fecha, pagado, estado)
VALUES (
  '00000000-0000-0000-aaaa-000000000001'::uuid,
  'abono-a-09e', 'alu-a-01', 'cuota-a-02', 'plan-a-09e',
  5000, '2025-04-05', TRUE, 'pagado'
)
ON CONFLICT (cuenta_id, id) DO NOTHING;

-- ── Cuota exclusiva para test de estado por período (calendario) ─
--
-- cuota-a-tst: mensual, Marzo 2025 (mes_inicio=2) a Abril 2025 (mes_termino=3).
--   El RPC debe generar ambos períodos del calendario aunque no haya fila
--   en pagos para uno de ellos.
--
-- Escenario:
--   pago-a-tst-mar: Marzo 2025, estado=pagado  (fila en pagos → pagado)
--   Abril 2025: SIN fila en pagos              → el RPC lo genera como 'pendiente'
--
-- Esto verifica que el cálculo por calendario funciona correctamente
-- (antes de este fix, Abril no aparecía si no había fila en pagos).
--
-- NOTA: pago-a-tst-abr fue ELIMINADO del fixture intencionalmente
-- para probar la generación de período pendiente sin fila en BD.

INSERT INTO cuotas (cuenta_id, id, curso_id, nombre, monto, tipo, activa, mes_inicio, mes_termino, anio)
VALUES (
  '00000000-0000-0000-aaaa-000000000001'::uuid,
  'cuota-a-tst', 'cur-a-01', 'Cuota test períodos', 15000, 'mensual', TRUE,
  2, 3, 2025   -- mes 2=Marzo, mes 3=Abril (0-based)
)
ON CONFLICT (cuenta_id, id) DO UPDATE SET
  mes_inicio  = EXCLUDED.mes_inicio,
  mes_termino = EXCLUDED.mes_termino,
  anio        = EXCLUDED.anio;

-- pago-a-tst-mar: Marzo 2025 PAGADO (tiene fila → estado debe ser 'pagado')
INSERT INTO pagos (cuenta_id, id, alumno_id, cuota_id, monto, fecha, medio, estado, periodo)
VALUES (
  '00000000-0000-0000-aaaa-000000000001'::uuid,
  'pago-a-tst-mar', 'alu-a-01', 'cuota-a-tst',
  15000, '2025-03-10', 'transferencia', 'pagado', 'Marzo 2025'
)
ON CONFLICT (cuenta_id, id) DO NOTHING;

-- Eliminamos pago-a-tst-abr si existe de una carga anterior
-- (el test verifica que Abril aparezca pendiente SIN fila en pagos)
DELETE FROM pagos
WHERE cuenta_id = '00000000-0000-0000-aaaa-000000000001'::uuid
  AND id = 'pago-a-tst-abr';

-- ── Fixtures de exclusión para P17b ────────────────────────────
-- Estos registros NO deben sumarse en el balance_curso de cur-a-01.

-- (E1) Pago PENDIENTE de alu-a-01 → excluido por estado <> 'pagado'
-- Usamos cuota-a-01 con periodo Febrero 2025 (no existe en calendarios de test)
-- para no interferir con PC2 que verifica cuota-a-02 sin fila de pago.
INSERT INTO pagos (cuenta_id, id, alumno_id, cuota_id, monto, fecha, medio, estado, periodo)
VALUES (
  '00000000-0000-0000-aaaa-000000000001'::uuid,
  'pago-a-excl-pendiente', 'alu-a-01', 'cuota-a-01',
  9999, '2025-02-10', 'transferencia', 'pendiente', 'Febrero 2025'
)
ON CONFLICT (cuenta_id, id) DO NOTHING;

-- (E2) Plan INACTIVO con abono pagado → excluido por planes_pago.activo = FALSE
INSERT INTO planes_pago (cuenta_id, id, alumno_id, cuota_id, periodo, monto_total, activo, creado_en)
VALUES (
  '00000000-0000-0000-aaaa-000000000001'::uuid,
  'plan-a-inactivo', 'alu-a-01', 'cuota-a-01',
  '2025-03', 7000, FALSE, '2025-03-01'
)
ON CONFLICT (cuenta_id, id) DO NOTHING;

INSERT INTO abonos (cuenta_id, id, alumno_id, cuota_id, plan_id, monto, fecha, pagado, estado)
VALUES (
  '00000000-0000-0000-aaaa-000000000001'::uuid,
  'abono-a-inactivo', 'alu-a-01', 'cuota-a-01', 'plan-a-inactivo',
  7777, '2025-03-05', TRUE, 'pagado'
)
ON CONFLICT (cuenta_id, id) DO NOTHING;

-- (E3) Movimiento de OTRO CURSO (cur-a-02) → excluido por curso_id <> cur-a-01
INSERT INTO movimientos (cuenta_id, id, curso_id, tipo, monto, "desc", fecha, visible)
VALUES (
  '00000000-0000-0000-aaaa-000000000001'::uuid,
  'mov-a-otro-curso', 'cur-a-02', 'ingreso', 11111,
  'Ingreso de otro curso — no debe sumar', '2025-03-15',
  TRUE
)
ON CONFLICT (cuenta_id, id) DO NOTHING;

-- ── Verificación ────────────────────────────────────────────────
DO $$
DECLARE errores INT := 0;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pagos WHERE cuenta_id='00000000-0000-0000-aaaa-000000000001' AND id='pago-a-02') THEN
    RAISE WARNING 'pago-a-02 no insertado'; errores := errores + 1;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM movimientos WHERE cuenta_id='00000000-0000-0000-aaaa-000000000001' AND id='mov-a-01' AND visible=TRUE AND comprobante IS NOT NULL) THEN
    RAISE WARNING 'mov-a-01 incorrecto'; errores := errores + 1;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM movimientos WHERE cuenta_id='00000000-0000-0000-aaaa-000000000001' AND id='mov-a-02' AND visible=FALSE) THEN
    RAISE WARNING 'mov-a-02 incorrecto'; errores := errores + 1;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM movimientos WHERE cuenta_id='00000000-0000-0000-aaaa-000000000001' AND id='mov-a-03' AND visible=TRUE AND comprobante IS NULL) THEN
    RAISE WARNING 'mov-a-03 incorrecto'; errores := errores + 1;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM planes_pago WHERE cuenta_id='00000000-0000-0000-aaaa-000000000001' AND id='plan-a-09e' AND alumno_id='alu-a-01') THEN
    RAISE WARNING 'plan-a-09e no insertado'; errores := errores + 1;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM abonos WHERE cuenta_id='00000000-0000-0000-aaaa-000000000001' AND id='abono-a-09e' AND pagado=TRUE) THEN
    RAISE WARNING 'abono-a-09e incorrecto'; errores := errores + 1;
  END IF;

  -- Verificar cuota-a-tst: mensual con calendario Marzo-Abril 2025
  IF NOT EXISTS(SELECT 1 FROM cuotas
                WHERE cuenta_id='00000000-0000-0000-aaaa-000000000001'
                  AND id='cuota-a-tst' AND activa=TRUE
                  AND mes_inicio=2 AND mes_termino=3 AND anio=2025) THEN
    RAISE WARNING 'cuota-a-tst no insertada o sin mes_inicio/mes_termino/anio'; errores := errores + 1;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pagos WHERE cuenta_id='00000000-0000-0000-aaaa-000000000001' AND id='pago-a-tst-mar' AND estado='pagado' AND periodo='Marzo 2025') THEN
    RAISE WARNING 'pago-a-tst-mar incorrecto'; errores := errores + 1;
  END IF;
  -- pago-a-tst-abr NO debe existir (se verifica que el período sea generado por calendario)
  IF EXISTS(SELECT 1 FROM pagos WHERE cuenta_id='00000000-0000-0000-aaaa-000000000001' AND id='pago-a-tst-abr') THEN
    RAISE WARNING 'pago-a-tst-abr no debería existir (prueba de calendario sin fila en pagos)'; errores := errores + 1;
  END IF;

  IF errores > 0 THEN
    RAISE EXCEPTION 'Fixture 09e falló con % error(es). ROLLBACK.', errores;
  END IF;

  RAISE NOTICE 'Fixture 09e OK: pagos, movimientos, plan, abono, cuota-a-tst con calendario verificados.';
END;
$$;

COMMIT;
