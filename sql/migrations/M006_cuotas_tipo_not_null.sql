-- ============================================================
-- M006: restricción NOT NULL + CHECK en cuotas.tipo
--
-- PROBLEMA:
--   cuotas.tipo TEXT sin restricción permite NULL y valores
--   arbitrarios. Con tipo=NULL el motor de períodos cae al
--   branch else y genera un único período "Anual AAAA",
--   haciendo invisibles los pagos con período mensual real.
--   El fallback anterior en crearCuotaV9 usaba 'unica', que
--   tampoco es un valor reconocido.
--
-- SOLUCIÓN:
--   1. Verificar que no hay filas con tipo IS NULL ni tipo no válido
--      antes de agregar la restricción.
--   2. Agregar NOT NULL + CHECK en la misma transacción.
--
-- PRERREQUISITO:
--   Ejecutar la reparación de datos (propuesta en sesión 2026-11-18)
--   y confirmar que SELECT COUNT(*) FROM cuotas WHERE tipo IS NULL = 0
--   antes de correr este script.
--
-- NUNCA ejecutar en producción (tmjqzaakzhecbldebyeg) hasta
-- completar la reparación y recibir aprobación explícita.
-- ============================================================

BEGIN;

-- 1. Verificar estado previo (falla si hay nulos sin reparar)
DO $$
DECLARE
  n_nulos   INT;
  n_invalidos INT;
BEGIN
  SELECT COUNT(*) INTO n_nulos     FROM cuotas WHERE tipo IS NULL;
  SELECT COUNT(*) INTO n_invalidos FROM cuotas WHERE tipo NOT IN ('mensual','anual','extraordinaria');

  IF n_nulos > 0 THEN
    RAISE EXCEPTION 'Hay % cuotas con tipo IS NULL — repara los datos primero.', n_nulos;
  END IF;

  IF n_invalidos > 0 THEN
    RAISE EXCEPTION 'Hay % cuotas con tipo no válido (no mensual/anual/extraordinaria) — revísalas primero.', n_invalidos;
  END IF;

  RAISE NOTICE 'Verificación OK — ninguna cuota con tipo inválido.';
END;
$$;

-- 2. Agregar CHECK constraint (antes de NOT NULL para mensaje claro)
ALTER TABLE cuotas
  ADD CONSTRAINT cuotas_tipo_check
  CHECK (tipo IN ('mensual', 'anual', 'extraordinaria'));

-- 3. Agregar NOT NULL
ALTER TABLE cuotas
  ALTER COLUMN tipo SET NOT NULL;

COMMIT;

-- Verificación post-migración
SELECT
  tipo,
  COUNT(*) AS n
FROM cuotas
GROUP BY tipo
ORDER BY tipo;
