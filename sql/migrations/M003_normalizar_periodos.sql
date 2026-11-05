-- ============================================================
-- Migración M003: normalizar pagos.periodo al formato "Mes AAAA"
-- Propósito (B1): Pagos históricos tienen periodo="Marzo" (sin año).
--   Los RPC v9 generan periodo="Marzo 2025" usando cuotas.anio.
--   La incompatibilidad hace que pagos no se encuentren en lookups.
--
-- REGLAS DE TRANSFORMACIÓN (revisadas):
--   Solo se transforma un período cuando TODAS estas condiciones se cumplen:
--     1. El valor es exactamente uno de los 12 meses en español del array MESES
--        (Enero, Febrero, Marzo, Abril, Mayo, Junio, Julio, Agosto,
--         Septiembre, Octubre, Noviembre, Diciembre) — coincidencia exacta.
--     2. No termina en 4 dígitos (sin año ya incluido).
--     3. La cuota asociada tiene cuotas.anio NOT NULL.
--
--   NO se tocan:
--     - Períodos como "Anual 2025", "Extraordinaria", "Matrícula 2024"
--     - Períodos con año ya incluido: "Marzo 2025"
--     - Meses con typos, espacios o sufijos: "Marzo (atrasado)"
--     - Registros de planes_pago.periodo (se migran por separado)
--     - Registros con cuota sin año (quedan ambiguos, solo se anotan)
--
-- REVERSIÓN:
--   La tabla _auditoria_periodos_m003 guarda periodo_original de cada fila
--   modificada. Si se requiere revertir:
--     UPDATE pagos p
--        SET periodo = a.periodo_original
--       FROM _auditoria_periodos_m003 a
--      WHERE a.pago_id = p.id
--        AND a.estado  = 'actualizado';
--   ADVERTENCIA: si después de M003 se agregaron pagos con el formato nuevo
--   (Mes AAAA), la reversión crearía inconsistencia. Revisar antes de revertir.
--
-- Pre-condición: ejecutar SOLO en staging (rucgmytyxpfowznowxwd).
-- NUNCA ejecutar en producción (tmjqzaakzhecbldebyeg).
-- ============================================================

BEGIN;

-- ── 0. Lista canónica de meses en español (debe coincidir con JS MESES[]) ────
-- Esta tabla temporal sirve como filtro de meses reconocidos.
CREATE TEMP TABLE _meses_reconocidos (mes TEXT PRIMARY KEY) ON COMMIT DROP;
INSERT INTO _meses_reconocidos VALUES
  ('Enero'),('Febrero'),('Marzo'),('Abril'),
  ('Mayo'),('Junio'),('Julio'),('Agosto'),
  ('Septiembre'),('Octubre'),('Noviembre'),('Diciembre');

-- ── 1. Respaldo / auditoría ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS _auditoria_periodos_m003 (
  cuenta_id        UUID,
  pago_id          TEXT,
  alumno_id        TEXT,
  cuota_id         TEXT,
  periodo_original TEXT,
  periodo_nuevo    TEXT,
  anio_cuota       INT,
  -- Estado:
  --   'actualizado'  — transformado de "Mes" a "Mes AAAA"
  --   'ambiguo'      — mes reconocido pero cuota sin año, no modificado
  --   'ya_correcto'  — ya tenía año, no modificado
  --   'sin_periodo'  — periodo NULL o vacío, no modificado
  --   'historico'    — periodo con contenido que no es un mes canónico, no modificado
  estado           TEXT,
  migrado_en       TIMESTAMPTZ DEFAULT NOW()
);

-- ── 2. Diagnóstico previo ─────────────────────────────────────────────────────
DO $$
DECLARE
  v_total         BIGINT;
  v_con_anio      BIGINT;
  v_mes_sin_anio  BIGINT;
  v_historicos    BIGINT;
  v_ambiguos      BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_total FROM pagos WHERE periodo IS NOT NULL AND periodo != '';
  SELECT COUNT(*) INTO v_con_anio FROM pagos WHERE periodo ~ '\d{4}$';
  SELECT COUNT(*) INTO v_mes_sin_anio
    FROM pagos p
    JOIN _meses_reconocidos mr ON mr.mes = p.periodo   -- coincidencia exacta
   WHERE p.periodo !~ '\d{4}$';
  SELECT COUNT(*) INTO v_historicos
    FROM pagos p
   WHERE p.periodo IS NOT NULL AND p.periodo != ''
     AND p.periodo !~ '\d{4}$'
     AND NOT EXISTS (SELECT 1 FROM _meses_reconocidos WHERE mes = p.periodo);
  SELECT COUNT(*) INTO v_ambiguos
    FROM pagos p
    JOIN _meses_reconocidos mr ON mr.mes = p.periodo
    LEFT JOIN cuotas cu ON cu.cuenta_id = p.cuenta_id AND cu.id = p.cuota_id
   WHERE cu.anio IS NULL;

  RAISE NOTICE 'M003 diagnóstico: % pagos con período no-nulo', v_total;
  RAISE NOTICE '  - ya tienen año (xxxx al final):              %', v_con_anio;
  RAISE NOTICE '  - mes canónico sin año (candidatos):          %', v_mes_sin_anio;
  RAISE NOTICE '  - históricos/no-mes (NO se tocarán):         %', v_historicos;
  RAISE NOTICE '  - mes canónico sin año Y cuota sin anio:      % (ambiguos)', v_ambiguos;
END;
$$;

-- ── 3. Registrar auditoría para todos los candidatos ─────────────────────────
-- Solo para filas que son un mes canónico sin año.
INSERT INTO _auditoria_periodos_m003
  (cuenta_id, pago_id, alumno_id, cuota_id, periodo_original, periodo_nuevo, anio_cuota, estado)
SELECT
  p.cuenta_id,
  p.id,
  p.alumno_id,
  p.cuota_id,
  p.periodo AS periodo_original,
  CASE
    WHEN cu.anio IS NOT NULL
      THEN p.periodo || ' ' || cu.anio::TEXT   -- forma canónica "Mes AAAA"
    ELSE NULL                                  -- ambiguo, no modificar
  END AS periodo_nuevo,
  cu.anio AS anio_cuota,
  CASE
    WHEN cu.anio IS NOT NULL THEN 'actualizado'
    ELSE                          'ambiguo'
  END AS estado
FROM pagos p
JOIN _meses_reconocidos mr ON mr.mes = p.periodo    -- solo meses canónicos exactos
LEFT JOIN cuotas cu
  ON cu.cuenta_id = p.cuenta_id
  AND cu.id = p.cuota_id
WHERE p.periodo !~ '\d{4}$';   -- sin año al final

-- ── 4. Actualizar solo los que tienen cuota con año conocido ─────────────────
UPDATE pagos p
   SET periodo = p.periodo || ' ' || cu.anio::TEXT
  FROM cuotas cu
  JOIN _meses_reconocidos mr ON mr.mes = p.periodo   -- solo meses canónicos
 WHERE cu.cuenta_id = p.cuenta_id
   AND cu.id = p.cuota_id
   AND p.periodo !~ '\d{4}$'    -- sin año al final
   AND cu.anio IS NOT NULL;     -- solo si cuota tiene año autoritativo
-- Nota: la condición JOIN con _meses_reconocidos protege períodos históricos
-- como "Extraordinaria", "Matrícula 2024", "Abono Marzo", etc.

-- ── 5. Migrar también planes_pago.periodo si existe la tabla ─────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'planes_pago') THEN
    -- Registrar auditoría de planes_pago en la misma tabla (pago_id = plan_id)
    INSERT INTO _auditoria_periodos_m003
      (cuenta_id, pago_id, alumno_id, cuota_id, periodo_original, periodo_nuevo, anio_cuota, estado)
    SELECT
      pp.cuenta_id,
      pp.id,
      pp.alumno_id,
      pp.cuota_id,
      pp.periodo,
      CASE WHEN cu.anio IS NOT NULL THEN pp.periodo || ' ' || cu.anio::TEXT ELSE NULL END,
      cu.anio,
      CASE WHEN cu.anio IS NOT NULL THEN 'actualizado' ELSE 'ambiguo' END
    FROM planes_pago pp
    JOIN _meses_reconocidos mr ON mr.mes = pp.periodo
    LEFT JOIN cuotas cu ON cu.cuenta_id = pp.cuenta_id AND cu.id = pp.cuota_id
    WHERE pp.periodo IS NOT NULL
      AND pp.periodo !~ '\d{4}$';

    -- Actualizar planes_pago
    UPDATE planes_pago pp
       SET periodo = pp.periodo || ' ' || cu.anio::TEXT
      FROM cuotas cu
      JOIN _meses_reconocidos mr ON mr.mes = pp.periodo
     WHERE cu.cuenta_id = pp.cuenta_id
       AND cu.id = pp.cuota_id
       AND pp.periodo !~ '\d{4}$'
       AND cu.anio IS NOT NULL;

    RAISE NOTICE 'M003: planes_pago.periodo también normalizado.';
  ELSE
    RAISE NOTICE 'M003: tabla planes_pago no existe, se omite.';
  END IF;
END;
$$;

-- ── 6. Reporte de resultados ─────────────────────────────────────────────────
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
    RAISE WARNING 'M003: % pago(s)/plan(es) AMBIGUOS — mes reconocido pero cuota sin año, NO modificados:', v_ambiguos;
    FOR r IN
      SELECT a.pago_id, a.cuota_id, a.periodo_original, a.alumno_id
        FROM _auditoria_periodos_m003 a
       WHERE a.estado = 'ambiguo'
       LIMIT 20
    LOOP
      RAISE WARNING '  id=% cuota=% alumno=% periodo="%"',
        r.pago_id, r.cuota_id, r.alumno_id, r.periodo_original;
    END LOOP;
    RAISE WARNING '  → Consultar _auditoria_periodos_m003 WHERE estado=''ambiguo'' para lista completa.';
    RAISE WARNING '  → Estos registros requieren revisión manual para definir el año correcto.';
  END IF;

  RAISE NOTICE '-- Para revertir la migración:';
  RAISE NOTICE '-- UPDATE pagos p SET periodo = a.periodo_original';
  RAISE NOTICE '--   FROM _auditoria_periodos_m003 a WHERE a.pago_id = p.id AND a.estado = ''actualizado'';';
END;
$$;

-- ── 7. Verificación: no deben quedar meses canónicos sin año ─────────────────
DO $$
DECLARE
  v_pendientes BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_pendientes
    FROM pagos p
    JOIN _meses_reconocidos mr ON mr.mes = p.periodo
    JOIN cuotas cu ON cu.cuenta_id = p.cuenta_id AND cu.id = p.cuota_id
   WHERE p.periodo !~ '\d{4}$'
     AND cu.anio IS NOT NULL;

  IF v_pendientes > 0 THEN
    RAISE EXCEPTION 'M003: % pago(s) con mes canónico Y cuota.anio conocido siguen sin año tras UPDATE', v_pendientes;
  END IF;

  RAISE NOTICE 'M003 verificación: 0 meses canónicos actualizables quedan sin año ✓';
  RAISE NOTICE 'Tabla _auditoria_periodos_m003 disponible para auditoría y reversión.';
END;
$$;

COMMIT;
