-- ============================================================
-- Migración M001: idempotency_key en tabla pagos
-- Propósito: Permitir pagos acumulables por (alumno, cuota, período)
--            eliminando el UNIQUE index que solo permitía uno.
--            Sustituye la unicidad por clave de idempotencia por operación.
--
-- Decisión de diseño (B2):
--   • Dos pagos legítimos pueden compartir el mismo (alumno, cuota, período)
--     → pagos acumulables. El UNIQUE parcial anterior lo impedía.
--   • En su lugar, cada operación de registro genera un UUID único.
--     Reintentos del mismo envío usan el mismo UUID → ON CONFLICT DO NOTHING.
--   • No es un bloqueo por ventana de tiempo: dos pagos legítimos de igual
--     monto y período están permitidos siempre que tengan distinto UUID.
--
-- Pasos:
--   1. DROP del UNIQUE index anterior (pagos_alumno_cuota_periodo_unico)
--   2. ADD COLUMN idempotency_key TEXT (nullable para retrocompatibilidad)
--   3. CREATE UNIQUE INDEX en idempotency_key WHERE IS NOT NULL
--
-- Pre-condición: ejecutar SOLO en staging (rucgmytyxpfowznowxwd).
-- NUNCA ejecutar en producción (tmjqzaakzhecbldebyeg).
-- ============================================================

BEGIN;

-- Paso 1: eliminar el UNIQUE index de período único por pago
-- Este índice impedía múltiples pagos para el mismo (alumno, cuota, período).
DROP INDEX IF EXISTS pagos_alumno_cuota_periodo_unico;

-- Paso 2: agregar columna idempotency_key (nullable para rows existentes)
ALTER TABLE pagos
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Paso 3: UNIQUE parcial en idempotency_key — solo si tiene valor
-- Esto garantiza que dos envíos con el mismo UUID (reintento de red)
-- NO insertan una fila duplicada. El ON CONFLICT del RPC retorna la fila existente.
CREATE UNIQUE INDEX IF NOT EXISTS pagos_idempotency_key_unico
  ON pagos (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Verificación post-migración
DO $$
DECLARE
  v_col_exists BOOLEAN;
  v_idx_exists BOOLEAN;
  v_old_idx    BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pagos' AND column_name = 'idempotency_key'
  ) INTO v_col_exists;

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'pagos_idempotency_key_unico'
  ) INTO v_idx_exists;

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'pagos_alumno_cuota_periodo_unico'
  ) INTO v_old_idx;

  IF NOT v_col_exists THEN
    RAISE EXCEPTION 'M001: columna idempotency_key no fue creada';
  END IF;
  IF NOT v_idx_exists THEN
    RAISE EXCEPTION 'M001: índice pagos_idempotency_key_unico no fue creado';
  END IF;
  IF v_old_idx THEN
    RAISE EXCEPTION 'M001: índice antiguo pagos_alumno_cuota_periodo_unico sigue existiendo';
  END IF;

  RAISE NOTICE 'M001 verificada: idempotency_key ✓, índice nuevo ✓, índice viejo eliminado ✓';
END;
$$;

COMMIT;
