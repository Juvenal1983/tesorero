-- ============================================================
-- Migración M003: normalizar pagos.periodo al formato "Mes AAAA"
-- Propósito (B1): Pagos históricos tienen periodo="Marzo" (sin año).
--   Los RPC v9 generan periodo="Marzo 2025" usando cuotas.anio.
--   La incompatibilidad hace que pagos no se encuentren en lookups.
--
-- Estrategia:
--   1. Respaldo en tabla temporal
--   2. Diagnóstico: identificar filas con período sin año
--   3. Actualizar usando cuotas.anio como fuente autoritativa
--   4. Flaggear registros ambiguos para revisión manual
--   5. Verificación post-migración
--
-- IMPORTANTE: La fuente del año es cuotas.anio, NO pagos.fecha.
--   Si cuotas.anio es NULL, el registro se marca como AMBIGUO
--   (campo periodo_original preservado en tabla de auditoría).
--   Los ambiguos NO se modifican — requieren revisión manual.
--
-- Pre-condición: ejecutar SOLO en staging (rucgmytyxpfowznowxwd).
-- NUNCA ejecutar en producción (tmjqzaakzhecbldebyeg).
-- ============================================================

BEGIN;

-- ── 1. Respaldo ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS _auditoria_periodos_m003 (
  cuenta_id       UUID,
  pago_id         TEXT,
  alumno_id       TEXT,
  cuota_id        TEXT,
  periodo_original TEXT,
  periodo_nuevo    TEXT,
  anio_cuota      INT,
  estado          TEXT,  -- 'actualizado', 'ambiguo', 'ya_correcto', 'sin_periodo'
  migrado_en      TIMESTAMPTZ DEFAULT NOW()
);

-- ── 2. Diagnóstico ───────────────────────────────────────────────────────────
DO $$
DECLARE
  v_sin_anio     BIGINT;
  v_con_anio     BIGINT;
  v_sin_periodo  BIGINT;
  v_total        BIGINT;
BEGIN
  -- Períodos que parecen "solo mes" (1-14 chars, sin espacio-dígito al final)
  SELECT COUNT(*) INTO v_total
    FROM pagos WHERE periodo IS NOT NULL AND periodo != '';

  SELECT COUNT(*) INTO v_con_anio
    FROM pagos
   WHERE periodo IS NOT NULL
     AND periodo ~ '\d{4}$';

  SELECT COUNT(*) INTO v_sin_anio
    FROM pagos
   WHERE periodo IS NOT NULL
     AND periodo != ''
     AND periodo !~ '\d{4}$';

  SELECT COUNT(*) INTO v_sin_periodo
    FROM pagos WHERE periodo IS NULL OR periodo = '';

  RAISE NOTICE 'M003 diagnóstico: % pagos con período no-nulo', v_total;
  RAISE NOTICE '  - ya tienen año (xxxx al final): %', v_con_anio;
  RAISE NOTICE '  - sin año (candidatos a migrar): %', v_sin_anio;
  RAISE NOTICE '  - sin período (NULL o vacío):    %', v_sin_periodo;
END;
$$;

-- ── 3. Registrar auditoría para todos los candidatos ─────────────────────────
INSERT INTO _auditoria_periodos_m003
  (cuenta_id, pago_id, alumno_id, cuota_id, periodo_original, periodo_nuevo, anio_cuota, estado)
SELECT
  p.cuenta_id,
  p.id,
  p.alumno_id,
  p.cuota_id,
  p.periodo AS periodo_original,
  CASE
    WHEN p.periodo IS NULL OR p.periodo = ''
      THEN NULL                               -- sin_periodo
    WHEN p.periodo ~ '\d{4}$'
      THEN p.periodo                          -- ya_correcto
    WHEN cu.anio IS NOT NULL
      THEN p.periodo || ' ' || cu.anio::TEXT  -- actualizable
    ELSE NULL                                 -- ambiguo (cuota sin año)
  END AS periodo_nuevo,
  cu.anio AS anio_cuota,
  CASE
    WHEN p.periodo IS NULL OR p.periodo = ''  THEN 'sin_periodo'
    WHEN p.periodo ~ '\d{4}$'                 THEN 'ya_correcto'
    WHEN cu.anio IS NOT NULL                  THEN 'actualizado'
    ELSE                                           'ambiguo'
  END AS estado
FROM pagos p
LEFT JOIN cuotas cu
  ON cu.cuenta_id = p.cuenta_id
  AND cu.id = p.cuota_id
WHERE p.periodo IS NOT NULL
  AND p.periodo != ''
  AND p.periodo !~ '\d{4}$';

-- ── 4. Actualizar períodos donde cuota tiene año conocido ────────────────────
UPDATE pagos p
   SET periodo = p.periodo || ' ' || cu.anio::TEXT
  FROM cuotas cu
 WHERE cu.cuenta_id = p.cuenta_id
   AND cu.id = p.cuota_id
   AND p.periodo IS NOT NULL
   AND p.periodo != ''
   AND p.periodo !~ '\d{4}$'   -- sin año al final
   AND cu.anio IS NOT NULL;    -- solo si cuota tiene año autoritativo

-- ── 5. Reporte de ambiguos ───────────────────────────────────────────────────
DO $$
DECLARE
  v_actualizados BIGINT;
  v_ambiguos     BIGINT;
  r              RECORD;
BEGIN
  SELECT COUNT(*) INTO v_actualizados
    FROM _auditoria_periodos_m003 WHERE estado = 'actualizado';

  SELECT COUNT(*) INTO v_ambiguos
    FROM _auditoria_periodos_m003 WHERE estado = 'ambiguo';

  RAISE NOTICE 'M003 resultado: % período(s) actualizado(s) a formato "Mes AAAA"', v_actualizados;

  IF v_ambiguos > 0 THEN
    RAISE WARNING 'M003: % pago(s) AMBIGUO(S) — cuota sin año, NO modificados. Revisar manualmente:', v_ambiguos;
    FOR r IN
      SELECT a.pago_id, a.cuota_id, a.periodo_original, a.alumno_id
        FROM _auditoria_periodos_m003 a
       WHERE a.estado = 'ambiguo'
       LIMIT 20
    LOOP
      RAISE WARNING '  pago_id=% cuota=% alumno=% periodo="%"',
        r.pago_id, r.cuota_id, r.alumno_id, r.periodo_original;
    END LOOP;
    RAISE WARNING '  → Consultar tabla _auditoria_periodos_m003 WHERE estado=''ambiguo'' para lista completa.';
  END IF;
END;
$$;

-- ── 6. Verificación: no deben quedar períodos sin año (excepto ambiguos/nulls) ─
DO $$
DECLARE
  v_pendientes BIGINT;
BEGIN
  -- Estos son pagos con periodo sin año Y cuota con año conocido
  -- (deberían haber sido actualizados en el paso 4)
  SELECT COUNT(*) INTO v_pendientes
    FROM pagos p
    JOIN cuotas cu ON cu.cuenta_id = p.cuenta_id AND cu.id = p.cuota_id
   WHERE p.periodo IS NOT NULL
     AND p.periodo != ''
     AND p.periodo !~ '\d{4}$'
     AND cu.anio IS NOT NULL;

  IF v_pendientes > 0 THEN
    RAISE EXCEPTION 'M003: % pago(s) actualizables siguen sin año tras UPDATE', v_pendientes;
  END IF;

  RAISE NOTICE 'M003 verificación: 0 pagos actualizables sin año ✓';
  RAISE NOTICE 'Tabla _auditoria_periodos_m003 disponible para revisión de ambiguos.';
END;
$$;

COMMIT;
