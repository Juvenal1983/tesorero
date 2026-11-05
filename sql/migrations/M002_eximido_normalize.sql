-- ============================================================
-- Migración M002: normalizar alumnos.eximido (NULL → false) + NOT NULL
-- Propósito (B12): La columna eximido BOOLEAN DEFAULT false no tiene NOT NULL,
--   lo que permite filas con NULL. Las expresiones SQL `AND NOT b.eximido`
--   producen UNKNOWN para NULL (ni TRUE ni FALSE), excluyendo silenciosamente
--   al alumno del cálculo de obligaciones.
--
-- Pasos:
--   1. Diagnóstico previo: contar NULLs existentes
--   2. Normalizar NULLs existentes → false
--   3. Agregar restricción NOT NULL DEFAULT false
--
-- Pre-condición: ejecutar SOLO en staging (rucgmytyxpfowznowxwd).
-- NUNCA ejecutar en producción (tmjqzaakzhecbldebyeg).
-- ============================================================

BEGIN;

-- Paso 1: Diagnóstico — cuántos alumnos tienen eximido IS NULL
DO $$
DECLARE
  v_nulls BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_nulls FROM alumnos WHERE eximido IS NULL;
  RAISE NOTICE 'M002 diagnóstico: % fila(s) con eximido IS NULL encontrada(s)', v_nulls;
END;
$$;

-- Paso 2: Normalizar NULLs → false (un alumno sin flag de exención no está eximido)
UPDATE alumnos
   SET eximido = false
 WHERE eximido IS NULL;

-- Verificar que no quedan NULLs antes de agregar la restricción
DO $$
DECLARE
  v_nulls BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_nulls FROM alumnos WHERE eximido IS NULL;
  IF v_nulls > 0 THEN
    RAISE EXCEPTION 'M002: aún quedan % fila(s) con eximido IS NULL tras UPDATE', v_nulls;
  END IF;
  RAISE NOTICE 'M002: 0 NULLs restantes — procede a agregar NOT NULL';
END;
$$;

-- Paso 3: Agregar restricción NOT NULL (safe: ya no hay NULLs)
ALTER TABLE alumnos
  ALTER COLUMN eximido SET NOT NULL,
  ALTER COLUMN eximido SET DEFAULT false;

-- Verificación final
DO $$
DECLARE
  v_nullable TEXT;
BEGIN
  SELECT is_nullable INTO v_nullable
    FROM information_schema.columns
   WHERE table_name = 'alumnos' AND column_name = 'eximido';

  IF v_nullable = 'YES' THEN
    RAISE EXCEPTION 'M002: ALTER TABLE no aplicó NOT NULL en eximido';
  END IF;

  RAISE NOTICE 'M002 verificada: alumnos.eximido NOT NULL DEFAULT false ✓';
END;
$$;

COMMIT;
