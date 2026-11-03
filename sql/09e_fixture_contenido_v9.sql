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
--     plan-a-01: alu-a-01, cuota-a-01 → debe aparecer en planes
--   abonos:
--     abono-a-01: plan-a-01, monto=5000, pagado=TRUE → monto_abonado=5000
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

  IF errores > 0 THEN
    RAISE EXCEPTION 'Fixture 09e falló con % error(es). ROLLBACK.', errores;
  END IF;

  RAISE NOTICE 'Fixture 09e OK: pagos, movimientos, plan y abono verificados.';
END;
$$;

COMMIT;
