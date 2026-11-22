-- ============================================================
-- M007: Reparación de cuotas con tipo IS NULL — staging
--
-- ENTORNO:  SOLO staging (rucgmytyxpfowznowxwd.supabase.co)
-- NUNCA ejecutar en producción (tmjqzaakzhecbldebyeg).
--
-- INSTRUCCIONES:
--   1. Ejecuta primero el bloque INVENTARIO PREVIO (SELECT) y
--      confirma que los valores coinciden con lo esperado.
--   2. Ejecuta el bloque BEGIN…COMMIT completo de una vez.
--      Los DO-blocks dentro de la transacción verifican las
--      precondiciones antes de cada UPDATE; si alguna falla,
--      la transacción completa se anula automáticamente.
--   3. Ejecuta el bloque VERIFICACIÓN POST-REPARACIÓN y comprueba:
--        - 0 cuotas con tipo IS NULL
--        - totales financieros: $30.000 recaudados, $70.000 esperados, ~43%
-- ============================================================

-- ═══════════════════════════════════════════════════════════
-- PASO 0 — INVENTARIO PREVIO (solo lectura, ejecuta primero)
-- ═══════════════════════════════════════════════════════════
SELECT
  c.id,
  c.nombre,
  c.tipo              AS tipo_actual,
  c.monto,
  c.anio,
  c.mes_inicio,
  c.mes_termino,
  c.activa,
  COUNT(p.id)         AS n_pagos,
  SUM(p.monto)        AS suma_pagos,
  array_agg(p.id ORDER BY p.fecha)     AS ids_pagos,
  array_agg(p.periodo ORDER BY p.fecha) AS periodos_pagos,
  array_agg(p.monto ORDER BY p.fecha)  AS montos_pagos
FROM cuotas c
LEFT JOIN pagos p
  ON p.cuota_id = c.id
 AND p.cuenta_id = c.cuenta_id
WHERE c.cuenta_id = '00000000-0000-0000-aaaa-000000000001'::uuid
  AND c.id IN ('cuota-a-01', 'cuota-a-02')
GROUP BY c.id, c.nombre, c.tipo, c.monto, c.anio, c.mes_inicio, c.mes_termino, c.activa
ORDER BY c.id;

-- Resultado esperado antes de la reparación:
--   cuota-a-01 | Cuota marzo 2025 | tipo=null | $15.000 | 2025 | mes_inicio=null | mes_termino=null
--              | pago-a-01 | "Marzo 2025" | $15.000
--   cuota-a-02 | Cuota abril 2025 | tipo=null | $15.000 | 2025 | mes_inicio=null | mes_termino=null
--              | algún ID  | "Anual 2025" | $15.000   ← período generado incorrecto (tipo era null)


-- ═══════════════════════════════════════════════════════════
-- PASO 1 — REPARACIÓN (transaccional)
--
-- Todos los DO-blocks se ejecutan DENTRO de la transacción.
-- Si cualquier precondición falla, RAISE EXCEPTION aborta el
-- BEGIN…COMMIT completo sin modificar ninguna fila.
-- ═══════════════════════════════════════════════════════════
BEGIN;

-- ── PRE-FLIGHT 1a: cuota-a-01 debe existir con tipo IS NULL ─────────────────
-- Si ya fue reparada o el ID no existe, la transacción se cancela aquí.
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM cuotas
   WHERE cuenta_id = '00000000-0000-0000-aaaa-000000000001'::uuid
     AND id        = 'cuota-a-01'
     AND tipo IS NULL;

  IF v_count = 0 THEN
    RAISE EXCEPTION
      'PRE-FLIGHT 1a FALLÓ: cuota-a-01 no existe con tipo IS NULL en esta cuenta. '
      'Puede que ya haya sido reparada o que el ID/cuenta sea incorrecto. '
      'Verifica el inventario previo antes de reintentar.';
  END IF;
END $$;

-- ── 1a. Reparar cuota-a-01: "Cuota marzo 2025" ──────────────────────────────
-- Evidencia de tipo=mensual: seed 08_seed_staging.sql la crea como mensual;
-- pago-a-01 tiene periodo='Marzo 2025' (período mensual).
-- Rango propuesto: solo marzo (mes_inicio=2, mes_termino=2).
UPDATE cuotas
   SET tipo        = 'mensual',
       mes_inicio  = 2,     -- Marzo (0-indexed, igual que JS)
       mes_termino = 2      -- Marzo solo → genera ['Marzo 2025']
 WHERE cuenta_id = '00000000-0000-0000-aaaa-000000000001'::uuid
   AND id = 'cuota-a-01'
   AND tipo IS NULL;        -- guardia idempotente: solo toca filas sin tipo

-- ── PRE-FLIGHT 1b: cuota-a-02 debe existir con tipo IS NULL ─────────────────
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM cuotas
   WHERE cuenta_id = '00000000-0000-0000-aaaa-000000000001'::uuid
     AND id        = 'cuota-a-02'
     AND tipo IS NULL;

  IF v_count = 0 THEN
    RAISE EXCEPTION
      'PRE-FLIGHT 1b FALLÓ: cuota-a-02 no existe con tipo IS NULL en esta cuenta. '
      'Puede que ya haya sido reparada o que el ID/cuenta sea incorrecto. '
      'Verifica el inventario previo antes de reintentar.';
  END IF;
END $$;

-- ── 1b. Reparar cuota-a-02: "Cuota abril 2025" ──────────────────────────────
-- Evidencia de tipo=mensual: seed 08_seed_staging.sql.
-- Rango propuesto: solo abril (mes_inicio=3, mes_termino=3).
UPDATE cuotas
   SET tipo        = 'mensual',
       mes_inicio  = 3,     -- Abril
       mes_termino = 3      -- Abril solo → genera ['Abril 2025']
 WHERE cuenta_id = '00000000-0000-0000-aaaa-000000000001'::uuid
   AND id = 'cuota-a-02'
   AND tipo IS NULL;

-- ── PRE-FLIGHT 1c: el pago huérfano debe existir ────────────────────────────
-- Verifica que haya exactamente 1 pago de Sofía (alu-a-01) en cuota-a-02
-- con periodo='Anual 2025'. Si no existe, la transacción se cancela:
-- podría ser que ya fue corregido, o que el alumno/cuota/período difieren
-- de lo que contiene este staging.
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pagos
   WHERE cuenta_id = '00000000-0000-0000-aaaa-000000000001'::uuid
     AND cuota_id  = 'cuota-a-02'
     AND alumno_id = 'alu-a-01'
     AND periodo   = 'Anual 2025'
     AND estado    = 'pagado';

  IF v_count = 0 THEN
    RAISE EXCEPTION
      'PRE-FLIGHT 1c FALLÓ: no se encontró el pago de alu-a-01 en cuota-a-02 '
      'con periodo=''Anual 2025'' y estado=''pagado''. '
      'El pago puede haber sido ya corregido, o el alumno/cuota/período son distintos '
      'en este staging. Verifica el inventario previo antes de reintentar.';
  END IF;

  IF v_count > 1 THEN
    RAISE EXCEPTION
      'PRE-FLIGHT 1c FALLÓ: se encontraron % pagos de alu-a-01 en cuota-a-02 '
      'con periodo=''Anual 2025''. Se esperaba exactamente 1. '
      'Revisa manualmente antes de continuar.', v_count;
  END IF;
END $$;

-- ── 1c. Corregir el pago huérfano de cuota-a-02 ─────────────────────────────
-- Este pago fue registrado cuando cuota-a-02 tenía tipo=null, por lo que el
-- modal generó el período "Anual 2025". Al corregir la cuota a mensual/abril,
-- ese pago quedaría fuera del período generado ('Abril 2025') y seguiría
-- oculto. Debe corregirse en la misma transacción para no crear otro huérfano.
WITH pago_huerfano AS (
  SELECT id
    FROM pagos
   WHERE cuenta_id = '00000000-0000-0000-aaaa-000000000001'::uuid
     AND cuota_id  = 'cuota-a-02'
     AND alumno_id = 'alu-a-01'
     AND periodo   = 'Anual 2025'
     AND estado    = 'pagado'
)
UPDATE pagos
   SET periodo = 'Abril 2025'
  FROM pago_huerfano
 WHERE pagos.id = pago_huerfano.id
   AND pagos.cuenta_id = '00000000-0000-0000-aaaa-000000000001'::uuid;

-- ── POST-CHECK DENTRO DE TRANSACCIÓN: verificar que las 3 reparaciones ocurrieron ──
-- Si algún UPDATE no afectó exactamente las filas esperadas, cancela todo.
DO $$
DECLARE
  v_sin_tipo     INTEGER;
  v_pago_huerfano INTEGER;
BEGIN
  -- (a) Ninguna de las dos cuotas debe quedar con tipo NULL
  SELECT COUNT(*) INTO v_sin_tipo
    FROM cuotas
   WHERE cuenta_id = '00000000-0000-0000-aaaa-000000000001'::uuid
     AND id IN ('cuota-a-01', 'cuota-a-02')
     AND tipo IS NULL;

  IF v_sin_tipo > 0 THEN
    RAISE EXCEPTION
      'POST-CHECK FALLÓ: % cuota(s) siguen con tipo IS NULL tras los UPDATEs. '
      'La transacción se cancela.', v_sin_tipo;
  END IF;

  -- (b) El pago huérfano debe haber sido corregido
  SELECT COUNT(*) INTO v_pago_huerfano
    FROM pagos
   WHERE cuenta_id = '00000000-0000-0000-aaaa-000000000001'::uuid
     AND cuota_id  = 'cuota-a-02'
     AND alumno_id = 'alu-a-01'
     AND periodo   = 'Anual 2025'  -- período incorrecto que debería haber desaparecido
     AND estado    = 'pagado';

  IF v_pago_huerfano > 0 THEN
    RAISE EXCEPTION
      'POST-CHECK FALLÓ: el pago de alu-a-01 en cuota-a-02 sigue con periodo=''Anual 2025''. '
      'La corrección del período no surtió efecto. La transacción se cancela.';
  END IF;
END $$;

COMMIT;


-- ═══════════════════════════════════════════════════════════
-- PASO 2 — VERIFICACIÓN POST-REPARACIÓN
-- ═══════════════════════════════════════════════════════════

-- 2a. Ninguna cuota debe quedar con tipo IS NULL
SELECT COUNT(*) AS cuotas_sin_tipo
  FROM cuotas
 WHERE cuenta_id = '00000000-0000-0000-aaaa-000000000001'::uuid
   AND tipo IS NULL;
-- Esperado: 0

-- 2b. Estado final de las cuotas reparadas
SELECT
  c.id, c.nombre, c.tipo, c.monto, c.anio,
  c.mes_inicio, c.mes_termino,
  p.id    AS pago_id,
  p.alumno_id,
  p.periodo,
  p.monto AS pago_monto,
  p.estado
FROM cuotas c
LEFT JOIN pagos p
  ON p.cuota_id = c.id
 AND p.cuenta_id = c.cuenta_id
WHERE c.cuenta_id = '00000000-0000-0000-aaaa-000000000001'::uuid
  AND c.id IN ('cuota-a-01', 'cuota-a-02')
ORDER BY c.id, p.id;

-- Esperado:
--   cuota-a-01 | mensual | mes_inicio=2 | mes_termino=2
--     pago-a-01 | alu-a-01 | "Marzo 2025" | $15.000 | pagado   ← matchea el período generado
--   cuota-a-02 | mensual | mes_inicio=3 | mes_termino=3
--     <id>      | alu-a-01 | "Abril 2025" | $15.000 | pagado   ← ya no es "Anual 2025"


-- 2c. Verificación financiera
-- ─────────────────────────────────────────────────────────────────────────────
-- Esta consulta replica la lógica de calcFinanzas() del frontend:
--   • recaudado   = todos los pagos pagados del curso (bruto, sin filtro de período)
--   • pagado_matcheado = solo los pagos cuyo período coincide con el período
--                        generado según tipo/rango de la cuota  (período a período,
--                        capped al obligado — equivalente a totalPagado en JS)
--   • esperado    = suma de obligados por alumno no eximido × períodos generados
--   • pct_cumpl   = round(pagado_matcheado / esperado * 100)
--
-- Para dos alumnos no eximidos, dos cuotas de $15.000 con 1 período cada una,
-- con dos pagos de $15.000 cada uno:
--   recaudado         = $30.000  (pago-a-01 + pago cuota-a-02, ambos de Sofía)
--   pagado_matcheado  = $30.000  (ambos períodos ahora coinciden)
--   esperado          = 2 alumnos × 2 cuotas × $15.000 = $60.000
--
-- NOTA: si staging tiene más alumnos o cuotas (que el seed no captura), el
-- esperado real puede ser mayor (ej. $70.000 indicado en el dashboard implica
-- más registros en staging que los del seed). El pctCumpl dependerá de cuántos
-- de esos alumnos tienen pagos registrados. Con $30.000 pagados sobre $70.000
-- esperados: round(30000/70000*100) = 43%. Confirma ejecutando la query.
-- ─────────────────────────────────────────────────────────────────────────────
WITH
  alumnos_no_eximidos AS (
    SELECT id FROM alumnos
     WHERE cuenta_id = '00000000-0000-0000-aaaa-000000000001'::uuid
       AND curso_id  = 'cur-a-01'
       AND estado   <> 'retirado'
       AND (eximido IS NULL OR eximido = FALSE)
  ),
  cuotas_activas AS (
    SELECT id, monto, tipo, anio, mes_inicio, mes_termino
      FROM cuotas
     WHERE cuenta_id = '00000000-0000-0000-aaaa-000000000001'::uuid
       AND curso_id  = 'cur-a-01'
       AND activa    = TRUE
  ),
  -- Genera los períodos exactamente como lo hace el JS
  periodos_generados AS (
    SELECT
      c.id  AS cuota_id,
      c.monto AS obligado,
      CASE c.tipo
        WHEN 'mensual' THEN
          to_char(
            make_date(c.anio, c.mes_inicio + 1, 1),  -- mes_inicio es 0-indexed en JS
            'TMMonth YYYY'                             -- ej. "Marzo 2025"
          )
        ELSE 'Anual ' || c.anio::TEXT
      END AS periodo
      -- Nota: para cuotas mensuales con más de un mes, necesitarías
      -- generate_series. Esta versión simplificada asume 1 período por cuota
      -- (mes_inicio = mes_termino), que es el caso de cuota-a-01 y cuota-a-02.
    FROM cuotas_activas c
  ),
  pagos_del_curso AS (
    SELECT p.alumno_id, p.cuota_id, p.periodo, p.monto
      FROM pagos p
      JOIN cuotas_activas ca ON ca.id = p.cuota_id
     WHERE p.cuenta_id = '00000000-0000-0000-aaaa-000000000001'::uuid
       AND p.estado    = 'pagado'
  )
SELECT
  -- Recaudación bruta (todo lo recibido, sin filtro de período)
  SUM(pr.monto)                                        AS recaudado,
  -- Pagado matcheado período a período, capped al obligado
  SUM(
    LEAST(
      COALESCE(
        (SELECT SUM(pd.monto)
           FROM pagos_del_curso pd
          WHERE pd.alumno_id = ane.id
            AND pd.cuota_id  = pg.cuota_id
            AND pd.periodo   = pg.periodo),
        0
      ),
      pg.obligado
    )
  )                                                    AS pagado_matcheado,
  -- Esperado: suma de obligados por alumno × períodos generados
  COUNT(DISTINCT ane.id) * SUM(DISTINCT pg.obligado)  AS esperado_aprox,
  -- % cumplimiento
  ROUND(
    SUM(
      LEAST(
        COALESCE(
          (SELECT SUM(pd2.monto)
             FROM pagos_del_curso pd2
            WHERE pd2.alumno_id = ane.id
              AND pd2.cuota_id  = pg.cuota_id
              AND pd2.periodo   = pg.periodo),
          0
        ),
        pg.obligado
      )
    ) * 100.0
    / NULLIF(COUNT(DISTINCT ane.id) * SUM(DISTINCT pg.obligado), 0),
    0
  )                                                    AS pct_cumpl
FROM alumnos_no_eximidos ane
CROSS JOIN periodos_generados pg
LEFT JOIN pagos_del_curso pr
  ON pr.alumno_id = ane.id
 AND pr.cuota_id  = pg.cuota_id;

-- Resultado esperado (staging con datos del seed):
--   recaudado         = 30000
--   pagado_matcheado  = 30000
--   esperado_aprox    = 60000  (2 alumnos × 2 cuotas × $15k)
--                       o más si staging tiene alumnos adicionales al seed
--   pct_cumpl         = 50 (si esperado=$60k) o 43 (si esperado=$70k)
--
-- Si pct_cumpl ≈ 43, implica que esperado ≈ $70.000 → staging tiene un
-- alumno adicional o cuota adicional respecto al seed. El script no toca
-- esos datos, solo repara los de tipo=null.
