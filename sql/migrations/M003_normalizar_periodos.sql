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
--     - Registros con cuota sin año (quedan ambiguos, solo se anotan)
--
-- TABLA DE AUDITORÍA _auditoria_periodos_m003:
--   Incluye entity_type ('pago' o 'plan_pago') para distinguir la entidad
--   y pago_id que contiene el ID de la fila correspondiente en su tabla.
--
-- REVERSIÓN SEGURA (delimita por cuenta, entidad y ejecución):
--   -- Revertir solo pagos:
--   UPDATE pagos p
--      SET periodo = a.periodo_original
--     FROM _auditoria_periodos_m003 a
--    WHERE a.entity_type = 'pago'
--      AND a.pago_id     = p.id
--      AND a.cuenta_id   = p.cuenta_id   -- delimitar por cuenta (evita IDs repetidos legacy)
--      AND a.estado      = 'actualizado'
--      AND p.periodo     = a.periodo_nuevo   -- PROTECCIÓN HISTÓRICA: solo revertir si el
--                                            --   período actual sigue siendo el valor migrado.
--                                            --   Si fue modificado después de M003, NO revertir.
--      AND a.migrado_en  >= '<timestamp_ejecucion>';  -- delimitar por ejecución específica
--
--   -- Revertir solo planes_pago:
--   UPDATE planes_pago pp
--      SET periodo = a.periodo_original
--     FROM _auditoria_periodos_m003 a
--    WHERE a.entity_type = 'plan_pago'
--      AND a.pago_id     = pp.id
--      AND a.cuenta_id   = pp.cuenta_id
--      AND a.estado      = 'actualizado'
--      AND pp.periodo    = a.periodo_nuevo   -- PROTECCIÓN HISTÓRICA: ídem para planes_pago
--      AND a.migrado_en  >= '<timestamp_ejecucion>';
--
--   ADVERTENCIA: el filtro AND p.periodo = a.periodo_nuevo es OBLIGATORIO.
--   Sin él, si un período fue modificado después de M003 (por corrección manual
--   u otro proceso), la reversión lo sobrescribiría con el valor anterior a M003,
--   ignorando los cambios posteriores y creando inconsistencia silenciosa.
--   El filtro por cuenta_id es OBLIGATORIO para evitar afectar IDs de otra cuenta
--   que coincidan por reutilización histórica de identificadores.
--   El filtro por migrado_en delimita la ejecución: si M003 se ejecutó varias
--   veces (p.ej. en staging de pruebas), cada ejecución queda aislada.
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
-- entity_type distingue si el registro es un 'pago' o un 'plan_pago'.
-- Este campo es OBLIGATORIO para la reversión segura: sin él no se puede
-- delimitar a qué tabla pertenece pago_id, ni aplicar el WHERE correcto.
CREATE TABLE IF NOT EXISTS _auditoria_periodos_m003 (
  cuenta_id        UUID,
  -- ID del registro en su tabla de origen (pagos.id o planes_pago.id)
  pago_id          TEXT,
  -- Tipo de entidad: 'pago' o 'plan_pago'
  -- CRÍTICO para reversión: evita actualizar pagos con IDs de planes_pago y viceversa
  entity_type      TEXT NOT NULL DEFAULT 'pago',
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

  RAISE NOTICE 'M003 diagnóstico [pagos]: % con período no-nulo', v_total;
  RAISE NOTICE '  - ya tienen año (xxxx al final):              %', v_con_anio;
  RAISE NOTICE '  - mes canónico sin año (candidatos):          %', v_mes_sin_anio;
  RAISE NOTICE '  - históricos/no-mes (NO se tocarán):         %', v_historicos;
  RAISE NOTICE '  - mes canónico sin año Y cuota sin anio:      % (ambiguos)', v_ambiguos;
END;
$$;

-- ── 3. Registrar auditoría para pagos candidatos ──────────────────────────────
-- entity_type = 'pago' — identifica la tabla de origen para reversión segura.
INSERT INTO _auditoria_periodos_m003
  (cuenta_id, pago_id, entity_type, alumno_id, cuota_id,
   periodo_original, periodo_nuevo, anio_cuota, estado)
SELECT
  p.cuenta_id,
  p.id,
  'pago'                       AS entity_type,
  p.alumno_id,
  p.cuota_id,
  p.periodo                    AS periodo_original,
  CASE
    WHEN cu.anio IS NOT NULL
      THEN p.periodo || ' ' || cu.anio::TEXT
    ELSE NULL
  END                          AS periodo_nuevo,
  cu.anio                      AS anio_cuota,
  CASE
    WHEN cu.anio IS NOT NULL THEN 'actualizado'
    ELSE                          'ambiguo'
  END                          AS estado
FROM pagos p
JOIN _meses_reconocidos mr ON mr.mes = p.periodo    -- solo meses canónicos exactos
LEFT JOIN cuotas cu
  ON cu.cuenta_id = p.cuenta_id
  AND cu.id = p.cuota_id
WHERE p.periodo !~ '\d{4}$';   -- sin año al final

-- ── 4. Actualizar solo los pagos que tienen cuota con año conocido ────────────
-- NOTA: en UPDATE … FROM, no se puede referenciar la tabla objetivo (p) dentro
-- de un JOIN de la cláusula FROM. El filtro de meses va en WHERE para evitar
-- "invalid reference to FROM-clause entry for table p".
UPDATE pagos p
   SET periodo = p.periodo || ' ' || cu.anio::TEXT
  FROM cuotas cu, _meses_reconocidos mr
 WHERE cu.cuenta_id = p.cuenta_id
   AND cu.id        = p.cuota_id
   AND mr.mes       = p.periodo   -- solo meses canónicos (en WHERE, no en JOIN)
   AND p.periodo    !~ '\d{4}$'   -- sin año al final
   AND cu.anio IS NOT NULL;       -- solo si cuota tiene año autoritativo

-- ── 5. Migrar también planes_pago.periodo si existe la tabla ─────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'planes_pago') THEN
    -- Registrar auditoría de planes_pago — entity_type = 'plan_pago'
    -- pago_id contiene planes_pago.id (nomenclatura histórica del campo)
    INSERT INTO _auditoria_periodos_m003
      (cuenta_id, pago_id, entity_type, alumno_id, cuota_id,
       periodo_original, periodo_nuevo, anio_cuota, estado)
    SELECT
      pp.cuenta_id,
      pp.id,
      'plan_pago'              AS entity_type,
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
    -- (igual que pagos: filtro de meses en WHERE, no en JOIN, para evitar
    -- "invalid reference to FROM-clause entry for table pp")
    UPDATE planes_pago pp
       SET periodo = pp.periodo || ' ' || cu.anio::TEXT
      FROM cuotas cu, _meses_reconocidos mr
     WHERE cu.cuenta_id = pp.cuenta_id
       AND cu.id        = pp.cuota_id
       AND mr.mes       = pp.periodo   -- filtro en WHERE
       AND pp.periodo   !~ '\d{4}$'
       AND cu.anio IS NOT NULL;

    RAISE NOTICE 'M003: planes_pago.periodo también normalizado (entity_type=plan_pago en auditoría).';
  ELSE
    RAISE NOTICE 'M003: tabla planes_pago no existe, se omite.';
  END IF;
END;
$$;

-- ── 6. Reporte de resultados ─────────────────────────────────────────────────
DO $$
DECLARE
  v_actualizados_pago      BIGINT;
  v_actualizados_plan      BIGINT;
  v_ambiguos               BIGINT;
  r                        RECORD;
BEGIN
  SELECT COUNT(*) INTO v_actualizados_pago
    FROM _auditoria_periodos_m003 WHERE estado = 'actualizado' AND entity_type = 'pago';

  SELECT COUNT(*) INTO v_actualizados_plan
    FROM _auditoria_periodos_m003 WHERE estado = 'actualizado' AND entity_type = 'plan_pago';

  SELECT COUNT(*) INTO v_ambiguos
    FROM _auditoria_periodos_m003 WHERE estado = 'ambiguo';

  RAISE NOTICE 'M003 resultado: % pago(s) actualizados, % plan(es) actualizados',
    v_actualizados_pago, v_actualizados_plan;

  IF v_ambiguos > 0 THEN
    RAISE WARNING 'M003: % registro(s) AMBIGUOS — mes reconocido pero cuota sin año, NO modificados:', v_ambiguos;
    FOR r IN
      SELECT a.entity_type, a.pago_id, a.cuota_id, a.periodo_original, a.alumno_id
        FROM _auditoria_periodos_m003 a
       WHERE a.estado = 'ambiguo'
       LIMIT 20
    LOOP
      RAISE WARNING '  [%] id=% cuota=% alumno=% periodo="%"',
        r.entity_type, r.pago_id, r.cuota_id, r.alumno_id, r.periodo_original;
    END LOOP;
    RAISE WARNING '  → Consultar _auditoria_periodos_m003 WHERE estado=''ambiguo'' para lista completa.';
  END IF;

  RAISE NOTICE '-- REVERSIÓN SEGURA (siempre delimitar por cuenta, entity_type Y ejecución):';
  RAISE NOTICE '-- UPDATE pagos p SET periodo = a.periodo_original';
  RAISE NOTICE '--   FROM _auditoria_periodos_m003 a';
  RAISE NOTICE '--   WHERE a.entity_type = ''pago''';
  RAISE NOTICE '--     AND a.pago_id     = p.id';
  RAISE NOTICE '--     AND a.cuenta_id   = p.cuenta_id';
  RAISE NOTICE '--     AND a.estado      = ''actualizado''';
  RAISE NOTICE '--     AND p.periodo     = a.periodo_nuevo   -- CRÍTICO: protege cambios post-M003';
  RAISE NOTICE '--     AND a.migrado_en >= ''<timestamp_ejecucion>'';  -- delimita ejecución';
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
  RAISE NOTICE 'Tabla _auditoria_periodos_m003 disponible para auditoría y reversión segura.';
  RAISE NOTICE 'Usar siempre: WHERE entity_type=''pago'' AND cuenta_id=... para acotar el UPDATE de reversión.';
END;
$$;

COMMIT;
