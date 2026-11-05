-- ============================================================
-- El Tesorero — "El Gran Cambio" v9
-- Archivo: sql/10_codigo_compartido_v9.sql
-- Propósito: Acceso compartido (CC-XXXX) en modelo relacional v9.
--
-- Depende de: 01_schema.sql (tabla cursos), 06_rpcs_apoderado.sql
--
-- Funciones que agrega / reemplaza:
--
--   apoderado_cc_verificar(p_codigo_cc TEXT)
--     → TABLE(cuenta_id, curso_id, nombre_curso, anio)
--     Acceso: anon (sin PIN).  Primera llamada del flujo de acceso.
--     Retorna vacío si el código no existe o el curso está inactivo.
--
--   apoderado_cc_resumen_pagos(p_codigo_cc TEXT)
--     → TABLE(alumno_id, nombre, monto_pagado, monto_abonado,
--              monto_pendiente, num_cuotas_pagadas, num_cuotas_pendientes)
--     Acceso: anon (sin PIN).
--     Verifica el código en cada llamada: si fue revocado devuelve vacío.
--     *** Nota de seguridad ***
--       El código CC es la única credencial; quien lo posee puede consultar
--       el estado del curso mientras esté vigente.  El tesorero revoca el
--       código para cortar el acceso.  El servidor no guarda tokens de sesión
--       por consulta: la validación es el código mismo, comprobado aquí.
--
--   apoderado_cc_generar(p_cuenta_id UUID, p_curso_id TEXT)
--     → JSONB{codigo_cc}
--     Acceso: authenticated (JWT de Supabase).
--     Solo el dueño de la cuenta o un usuario con rol tesorero/admin puede
--     invocar esta función; anon recibe 42501 (permiso denegado).
--
--   apoderado_cc_revocar(p_cuenta_id UUID, p_curso_id TEXT)
--     → JSONB{revocado}
--     Acceso: authenticated (JWT de Supabase).
--     Mismo requisito de autorización que apoderado_cc_generar.
--     Tras revocar, apoderado_cc_resumen_pagos devuelve vacío.
--
-- Columna nueva:
--   cursos.codigo_compartido TEXT (UNIQUE, nullable)
-- ============================================================

BEGIN;

SET search_path = public, extensions;


-- ── 0. Columna en cursos ─────────────────────────────────────
ALTER TABLE cursos
  ADD COLUMN IF NOT EXISTS codigo_compartido TEXT;

-- Índice único: solo un código por código (global, no por cuenta)
-- Garantiza que dos cursos distintos no compartan el mismo CC-XXXX
CREATE UNIQUE INDEX IF NOT EXISTS cursos_codigo_compartido_key
  ON cursos (codigo_compartido)
  WHERE codigo_compartido IS NOT NULL;


-- ── 1. apoderado_cc_verificar ────────────────────────────────
-- Dado un código CC-XXXX, retorna los datos básicos del curso.
-- Si el código no existe o el curso está inactivo, retorna vacío.
-- No requiere JWT: es la primera llamada del flujo de acceso compartido.
-- ─────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS apoderado_cc_verificar(TEXT);

CREATE OR REPLACE FUNCTION apoderado_cc_verificar(p_codigo_cc TEXT)
RETURNS TABLE(
  cuenta_id   UUID,
  curso_id    TEXT,
  nombre_curso TEXT,
  anio        INTEGER
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT
    c.cuenta_id,
    c.id         AS curso_id,
    c.nombre     AS nombre_curso,
    c.anio
  FROM cursos c
  WHERE c.codigo_compartido = p_codigo_cc
    AND c.activo = TRUE
  LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION apoderado_cc_verificar(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION apoderado_cc_verificar(TEXT) TO anon;


-- ── 2. apoderado_cc_resumen_pagos ────────────────────────────
-- Verifica el código en la propia función; si fue revocado devuelve vacío.
-- Acepta únicamente el código CC como credencial; no admite cuenta+curso
-- directamente, de modo que revocar el código corta el acceso de inmediato.
--
-- Lógica de obligaciones (idéntica al flujo privado):
--   • Cuotas tipo='mensual' → se expanden en un período por mes del calendario
--     (mes_inicio..mes_termino de la cuota o del curso como fallback).
--     Un período sin pago registrado cuenta como pendiente.
--   • Cuotas de otro tipo → una obligación simple por alumno.
--   • alumnos.eximido = TRUE → el alumno tiene 0 obligaciones (aparece con
--     monto_pendiente = 0 y num_cuotas_pendientes = 0).
--   • Abonos de planes activos se deducen del pendiente sin duplicar pagos.
-- ─────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS apoderado_cc_resumen_pagos(UUID, TEXT);  -- firma anterior
DROP FUNCTION IF EXISTS apoderado_cc_resumen_pagos(TEXT);

CREATE OR REPLACE FUNCTION apoderado_cc_resumen_pagos(p_codigo_cc TEXT)
RETURNS TABLE(
  alumno_id             TEXT,
  nombre                TEXT,
  monto_pagado          NUMERIC,
  monto_abonado         NUMERIC,
  monto_pendiente       NUMERIC,
  num_cuotas_pagadas    INT,
  num_cuotas_pendientes INT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_cuenta_id UUID;
  v_curso_id  TEXT;
BEGIN
  -- Verificar código compartido vigente en cada llamada.
  -- Si fue revocado (NULL) o el curso quedó inactivo: devuelve vacío.
  SELECT c.cuenta_id, c.id
    INTO v_cuenta_id, v_curso_id
    FROM cursos c
   WHERE c.codigo_compartido = p_codigo_cc
     AND c.activo = TRUE
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN;  -- código revocado o inválido → conjunto vacío
  END IF;

  RETURN QUERY
  WITH

  -- Meses en español (array 0-based: Enero=0, …, Diciembre=11)
  meses(idx, nombre) AS (
    VALUES (0,'Enero'),(1,'Febrero'),(2,'Marzo'),(3,'Abril'),
           (4,'Mayo'),(5,'Junio'),(6,'Julio'),(7,'Agosto'),
           (8,'Septiembre'),(9,'Octubre'),(10,'Noviembre'),(11,'Diciembre')
  ),

  -- Alumnos activos del curso con flag de exención
  base AS (
    SELECT
      a.id      AS alumno_id,
      COALESCE(NULLIF(TRIM(a.nombre), ''),
               TRIM(COALESCE(a.nombres,'') || ' ' || COALESCE(a.apellidos,'')),
               a.id)       AS nombre,
      a.eximido
    FROM alumnos a
    WHERE a.cuenta_id = v_cuenta_id
      AND a.curso_id  = v_curso_id
      AND a.estado    = 'activo'
  ),

  -- Cuotas activas del curso con calendario de mes (para expansión mensual)
  cuotas_activas AS (
    SELECT
      cu.id    AS cuota_id,
      cu.monto,
      cu.tipo,
      COALESCE(cu.mes_inicio,  cur.mes_inicio_cuota,  0)                              AS mes_ini,
      COALESCE(cu.mes_termino, cur.mes_termino_cuota, 11)                             AS mes_fin,
      COALESCE(cu.anio, cur.anio,
               EXTRACT(YEAR FROM CURRENT_DATE)::int)                                  AS anio
    FROM cuotas cu
    JOIN cursos cur
      ON  cur.cuenta_id = cu.cuenta_id
      AND cur.id        = cu.curso_id
    WHERE cu.cuenta_id = v_cuenta_id
      AND cu.curso_id  = v_curso_id
      AND cu.activa    = TRUE
  ),

  -- ── Obligaciones mensuales: una fila por (alumno × período) ──
  -- Solo alumnos no eximidos. El período es "Mes AAAA" (ej. "Marzo 2025").
  obligaciones_mensual AS (
    SELECT
      b.alumno_id,
      ca.cuota_id,
      ca.monto,
      m.nombre || ' ' || ca.anio::text AS periodo
    FROM base b
    CROSS JOIN cuotas_activas ca
    JOIN generate_series(0, 11) AS gs(mes)
      ON gs.mes BETWEEN ca.mes_ini AND ca.mes_fin
    JOIN meses m ON m.idx = gs.mes
    WHERE ca.tipo = 'mensual'
      AND NOT COALESCE(b.eximido, false)  -- B12-fix: COALESCE para eximido=NULL
  ),

  -- ── Obligaciones no-mensuales: una fila por (alumno × cuota) ──
  obligaciones_otros AS (
    SELECT
      b.alumno_id,
      ca.cuota_id,
      ca.monto
    FROM base b
    CROSS JOIN cuotas_activas ca
    WHERE ca.tipo IS DISTINCT FROM 'mensual'
      AND NOT COALESCE(b.eximido, false)  -- B12-fix: COALESCE para eximido=NULL
  ),

  -- ── Pagos realizados para cuotas mensuales (pre-agregados) ──
  -- GROUP BY (alumno, cuota, periodo) evita fan-out si hubiera más de
  -- un registro de pago para el mismo período (p.ej. corrección).
  pagos_mensual AS (
    SELECT p.alumno_id, p.cuota_id, p.periodo, SUM(p.monto) AS monto
    FROM pagos p
    WHERE p.cuenta_id = v_cuenta_id
      AND p.estado    = 'pagado'
      AND p.cuota_id  IN (SELECT om.cuota_id FROM obligaciones_mensual om)
      AND p.alumno_id IN (SELECT bx.alumno_id FROM base bx)
    GROUP BY p.alumno_id, p.cuota_id, p.periodo
  ),

  -- ── Pagos realizados para cuotas no-mensuales (pre-agregados) ─
  -- GROUP BY (alumno, cuota) antes del JOIN evita el fan-out que
  -- duplicaría SUM(oo.monto) cuando existen varios pagos para la
  -- misma cuota no-mensual (p.ej. pago parcial + corrección).
  pagos_otros AS (
    SELECT p.alumno_id, p.cuota_id, SUM(p.monto) AS monto
    FROM pagos p
    WHERE p.cuenta_id = v_cuenta_id
      AND p.estado    = 'pagado'
      AND p.cuota_id  IN (SELECT oo.cuota_id FROM obligaciones_otros oo)
      AND p.alumno_id IN (SELECT bx.alumno_id FROM base bx)
    GROUP BY p.alumno_id, p.cuota_id
  ),

  -- ── B5-fix: abonos por período mensual ───────────────────────
  -- Agrupa abonos por (alumno, cuota, periodo) uniéndose a través de
  -- planes_pago.periodo.  Esto garantiza que un abono registrado para
  -- "Marzo 2025" solo reduzca la obligación de ese período, nunca la de
  -- "Abril 2025" aunque ambos sean de la misma cuota.
  --
  -- B5-fix: se eliminó el filtro AND pp.activo = TRUE.
  --   Los planes completados (activo=false) siguen contando: sus abonos
  --   ya fueron pagados y no deben desaparecer del cálculo de pendiente.
  --
  -- Nota: solo aplica a cuotas de tipo 'mensual'; los no-mensuales
  -- conservan su abono a nivel de cuota en abonos_por_cuota (más abajo).
  abonos_por_periodo AS (
    SELECT
      ab.alumno_id,
      pp.cuota_id,
      pp.periodo,
      COALESCE(SUM(ab.monto), 0::NUMERIC) AS total
    FROM abonos ab
    JOIN planes_pago pp
      ON  pp.cuenta_id = ab.cuenta_id
      AND pp.id        = ab.plan_id
    JOIN cuotas cu
      ON  cu.cuenta_id = pp.cuenta_id
      AND cu.id        = pp.cuota_id
    WHERE ab.cuenta_id = v_cuenta_id
      AND ab.alumno_id IN (SELECT bx.alumno_id FROM base bx)
      AND ab.pagado    = TRUE
      -- B5-fix: sin filtro activo=TRUE; planes completados siguen contando
      AND cu.curso_id  = v_curso_id
      AND cu.tipo      = 'mensual'
    GROUP BY ab.alumno_id, pp.cuota_id, pp.periodo
  ),

  -- ── Pendiente por período mensual ───────────────────────────
  -- REGLA CLAVE: MAX(0, ob−pa) se aplica POR PERÍODO, no por cuota.
  -- Un sobrepago en Marzo (pagado $15k / obligado $10k → pendiente 0)
  -- no puede reducir el pendiente de Abril ($10k).
  -- Una cuota se considera "pagada" solo si pagado + abonado >= obligado.
  --
  -- B5-fix: se agrega abonado_efectivo por período (desde abonos_por_periodo).
  --   El abono se cappea al pendiente_gross del período para no crear
  --   crédito negativo ni cross-period contamination.
  mensual_por_periodo AS (
    SELECT
      om.alumno_id,
      om.cuota_id,
      om.periodo,
      om.monto                                                  AS obligado,
      COALESCE(pm.monto, 0::NUMERIC)                           AS pagado,
      -- Abono efectivo: capeado al pendiente_gross para no pasar de 0
      LEAST(
        COALESCE(abp.total, 0::NUMERIC),
        GREATEST(0::NUMERIC, om.monto - COALESCE(pm.monto, 0::NUMERIC))
      )                                                         AS abonado_efectivo,
      -- Período pagado = pago + abono cubren íntegramente la obligación
      CASE WHEN COALESCE(pm.monto, 0::NUMERIC)
                + LEAST(
                    COALESCE(abp.total, 0::NUMERIC),
                    GREATEST(0::NUMERIC, om.monto - COALESCE(pm.monto, 0::NUMERIC))
                  ) >= om.monto
           THEN 1 ELSE 0 END                                   AS periodo_pagado,
      -- Pendiente GROSS del período (sin descontar abono, para identidad algebraica).
      -- pendiente_neto = pendiente_gross - abonado_efectivo (ver mensual_por_cuota).
      GREATEST(0::NUMERIC,
        om.monto - COALESCE(pm.monto, 0::NUMERIC))            AS pendiente
    FROM obligaciones_mensual om
    LEFT JOIN pagos_mensual pm
      ON  pm.alumno_id = om.alumno_id
      AND pm.cuota_id  = om.cuota_id
      AND pm.periodo   = om.periodo
    LEFT JOIN abonos_por_periodo abp
      ON  abp.alumno_id = om.alumno_id
      AND abp.cuota_id  = om.cuota_id
      AND abp.periodo   = om.periodo
  ),

  -- ── Resumen mensual por (alumno × cuota) ─────────────────────
  -- pendiente_bruto = SUM de pendientes GROSS por período (ya capeados en 0
  --   respecto a pagos, pero SIN descontar abono todavía).
  -- abonado_total   = SUM de abonos efectivos por período.
  -- pendiente_neto  = pendiente_bruto − abonado_total (lo que el alumno debe)
  --
  -- Se mantienen separados para permitir que con_abono aplique la identidad:
  --   monto_pendiente = pendiente_bruto − abonado (consistent con otros_por_cuota).
  mensual_por_cuota AS (
    SELECT
      alumno_id,
      cuota_id,
      COUNT(*)::INT            AS total_periodos,
      SUM(periodo_pagado)::INT AS periodos_pagados,
      SUM(obligado)            AS obligado,
      SUM(pagado)              AS pagado,
      SUM(abonado_efectivo)    AS abonado_total,
      SUM(pendiente)           AS pendiente_bruto  -- gross (sin descontar abono)
    FROM mensual_por_periodo
    GROUP BY alumno_id, cuota_id
  ),

  -- ── Resumen no-mensual por (alumno × cuota) ──────────────────
  -- cuota "pagada" solo si SUM(pagos) >= obligado (pago parcial ≠ pagada).
  otros_por_cuota AS (
    SELECT
      oo.alumno_id,
      oo.cuota_id,
      1::INT                                                    AS total_obligaciones,
      -- cuota pagada únicamente si el total pagado cubre el monto obligado
      CASE WHEN COALESCE(po.monto, 0::NUMERIC) >= oo.monto
           THEN 1 ELSE 0 END::INT                              AS obligaciones_pagadas,
      oo.monto                                                  AS obligado,
      COALESCE(po.monto, 0::NUMERIC)                           AS pagado,
      GREATEST(0::NUMERIC,
        oo.monto - COALESCE(po.monto, 0::NUMERIC))            AS pendiente_bruto
    FROM obligaciones_otros oo
    LEFT JOIN pagos_otros po
      ON  po.alumno_id = oo.alumno_id
      AND po.cuota_id  = oo.cuota_id
  ),

  -- ── B5-fix: abonos de cuotas NO mensuales por (alumno × cuota) ─
  -- Para cuotas mensuales, el abono ya se aplicó por período en
  -- abonos_por_periodo + mensual_por_periodo (arriba).  Este CTE
  -- cubre únicamente los tipos distintos de 'mensual' (anual, extraordinaria).
  --
  -- B5-fix: se eliminó el filtro AND pp.activo = TRUE.
  --   Los planes completados (activo=false) siguen contando: sus abonos
  --   ya fueron pagados y no deben desaparecer del cálculo de pendiente.
  abonos_por_cuota AS (
    SELECT ab.alumno_id, pp.cuota_id,
           COALESCE(SUM(ab.monto), 0::NUMERIC) AS total
    FROM abonos ab
    JOIN planes_pago pp
      ON  pp.cuenta_id = ab.cuenta_id
      AND pp.id        = ab.plan_id
    JOIN cuotas cu
      ON  cu.cuenta_id = pp.cuenta_id
      AND cu.id        = pp.cuota_id
    WHERE ab.cuenta_id = v_cuenta_id
      AND ab.alumno_id IN (SELECT bx.alumno_id FROM base bx)
      AND ab.pagado    = TRUE
      -- B5-fix: sin filtro activo=TRUE; planes completados siguen contando
      AND cu.curso_id  = v_curso_id
      AND cu.tipo IS DISTINCT FROM 'mensual'  -- B5-fix: solo no-mensuales
    GROUP BY ab.alumno_id, pp.cuota_id
  ),

  -- ── Unión mensual + no-mensual por (alumno × cuota) ──────────
  -- Para mensual: abonado_total viene de mensual_por_cuota (período-level).
  -- Para otros:   abonado_total=0 (se aplicará en con_abono desde abonos_por_cuota).
  todos_por_cuota AS (
    SELECT alumno_id, cuota_id,
           total_periodos    AS total_obs,
           periodos_pagados  AS obs_pagadas,
           obligado, pagado,
           abonado_total,       -- B5: período-level abono ya calculado
           pendiente_bruto      -- gross (sin abono) para identidad algebraica
    FROM mensual_por_cuota
    UNION ALL
    SELECT alumno_id, cuota_id,
           total_obligaciones,
           obligaciones_pagadas,
           obligado, pagado,
           0::NUMERIC AS abonado_total,  -- para otros, abono se aplica en con_abono
           pendiente_bruto
    FROM otros_por_cuota
  ),

  -- ── Aplicar abono limitado al pendiente bruto de su cuota ─────
  -- Para cuotas mensuales:
  --   abonado = abonado_total (período-level, ya calculado)
  --   abonos_por_cuota.total = NULL para mensuales → COALESCE = 0
  --   resultado: abonado = abonado_total + 0 = abonado_total  ✓
  -- Para cuotas no-mensuales:
  --   abonado_total = 0
  --   abonado = 0 + LEAST(apc.total, pendiente_bruto)  ✓
  -- Identidad: monto_pendiente = pendiente_bruto − abonado
  con_abono AS (
    SELECT
      tpc.alumno_id,
      tpc.total_obs,
      tpc.obs_pagadas,
      tpc.obligado,
      tpc.pagado,
      tpc.pendiente_bruto,
      -- Abono total = período-level (mensual) + cuota-level (otros, capeado)
      tpc.abonado_total + LEAST(
        COALESCE(apc.total, 0::NUMERIC),
        tpc.pendiente_bruto                -- cap al pendiente bruto restante
      )                                                         AS abonado
    FROM todos_por_cuota tpc
    LEFT JOIN abonos_por_cuota apc
      ON  apc.alumno_id = tpc.alumno_id
      AND apc.cuota_id  = tpc.cuota_id
  ),

  -- ── Resumen final agregado por alumno ─────────────────────────
  resumen_alumno AS (
    SELECT
      alumno_id,
      SUM(total_obs)::INT       AS total_obligaciones,
      SUM(obs_pagadas)::INT     AS total_pagadas,
      SUM(pagado)               AS monto_pagado,
      SUM(abonado)              AS monto_abonado,
      -- pendiente = bruto − abono; bruto ≥ abono garantizado por LEAST anterior
      SUM(pendiente_bruto - abonado) AS monto_pendiente
    FROM con_abono
    GROUP BY alumno_id
  )

  SELECT
    b.alumno_id,
    b.nombre,
    -- Pagado = suma real de todos los pagos recibidos
    COALESCE(ra.monto_pagado,    0::NUMERIC) AS monto_pagado,
    -- Abonado = crédito efectivo (capped al pendiente de su cuota)
    COALESCE(ra.monto_abonado,   0::NUMERIC) AS monto_abonado,
    -- Pendiente = SUM(pendiente_por_período) − abono efectivo, por cuota, sumado por alumno
    COALESCE(ra.monto_pendiente, 0::NUMERIC) AS monto_pendiente,
    -- Cuotas pagadas: períodos cubiertos al 100% + no-mensuales con pago >= obligado
    COALESCE(ra.total_pagadas,   0)::INT     AS num_cuotas_pagadas,
    -- Cuotas pendientes: total − pagadas (nunca negativo)
    GREATEST(0,
      COALESCE(ra.total_obligaciones, 0) - COALESCE(ra.total_pagadas, 0)
    )::INT                                   AS num_cuotas_pendientes
  FROM base b
  LEFT JOIN resumen_alumno ra ON ra.alumno_id = b.alumno_id
  ORDER BY b.nombre;
END;
$$;

REVOKE EXECUTE ON FUNCTION apoderado_cc_resumen_pagos(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION apoderado_cc_resumen_pagos(TEXT) TO anon;


-- ── 3. apoderado_cc_generar ──────────────────────────────────
-- Genera un código CC-XXXX para un curso.
-- Requiere JWT autenticado; el llamante debe ser:
--   • dueño de la cuenta (tesorero_cuentas.auth_id = auth.uid()), o
--   • usuario con rol 'tesorero' o 'admin' en usuarios_cuenta, no desactivado,
--     CON acceso al curso específico (curso_id = p_curso_id OR curso_id IS NULL).
-- Esto impide que un tesorero asignado solo al curso A gestione el curso B.
-- ─────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS apoderado_cc_generar(UUID, TEXT, TEXT, TEXT);  -- firma anterior (con PIN)
DROP FUNCTION IF EXISTS apoderado_cc_generar(UUID, TEXT);

CREATE OR REPLACE FUNCTION apoderado_cc_generar(
  p_cuenta_id UUID,
  p_curso_id  TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_codigo TEXT;
  v_chars  TEXT := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_seg1   TEXT := '';
  v_seg2   TEXT := '';
  i        INT;
BEGIN
  -- Verificar autorización con scope de curso:
  --   • dueño de la cuenta (acceso total), o
  --   • tiene_rol_en_curso() → tesorero/admin con curso_id = p_curso_id OR NULL
  -- Un tesorero asignado a 'cur-a-01' no puede gestionar 'cur-a-02'.
  IF NOT (
    es_dueno(p_cuenta_id)
    OR tiene_rol_en_curso(p_cuenta_id, p_curso_id, ARRAY['tesorero','admin'])
  ) THEN
    RAISE EXCEPTION 'No autorizado: se requiere rol tesorero o admin con acceso al curso'
      USING ERRCODE = '42501';
  END IF;

  -- Verificar que el curso pertenece a la cuenta
  IF NOT EXISTS (
    SELECT 1 FROM cursos
    WHERE cuenta_id = p_cuenta_id AND id = p_curso_id
  ) THEN
    RAISE EXCEPTION 'Curso no encontrado en esta cuenta'
      USING ERRCODE = 'P0002';
  END IF;

  -- Generar código CC-XXXX-XXXX usando gen_random_bytes para aleatoriedad
  FOR i IN 1..4 LOOP
    v_seg1 := v_seg1 || substr(v_chars,
      1 + (get_byte(gen_random_bytes(1), 0) % length(v_chars)), 1);
  END LOOP;
  FOR i IN 1..4 LOOP
    v_seg2 := v_seg2 || substr(v_chars,
      1 + (get_byte(gen_random_bytes(1), 0) % length(v_chars)), 1);
  END LOOP;
  v_codigo := 'CC-' || v_seg1 || '-' || v_seg2;

  -- Guardar en cursos (reemplaza el anterior si existía)
  UPDATE cursos
     SET codigo_compartido = v_codigo
   WHERE cuenta_id = p_cuenta_id
     AND id        = p_curso_id;

  RETURN jsonb_build_object('codigo_cc', v_codigo);
END;
$$;

REVOKE EXECUTE ON FUNCTION apoderado_cc_generar(UUID, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION apoderado_cc_generar(UUID, TEXT) TO authenticated;
-- anon no tiene EXECUTE: 42501 en la capa de permisos de PostgreSQL.


-- ── 4. apoderado_cc_revocar ──────────────────────────────────
-- Elimina el código CC del curso.
-- Mismo requisito de autorización que apoderado_cc_generar:
--   dueño de la cuenta, o tesorero/admin con acceso al curso específico.
-- Tras revocar, apoderado_cc_resumen_pagos devuelve vacío.
-- ─────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS apoderado_cc_revocar(UUID, TEXT, TEXT, TEXT);  -- firma anterior (con PIN)
DROP FUNCTION IF EXISTS apoderado_cc_revocar(UUID, TEXT);

CREATE OR REPLACE FUNCTION apoderado_cc_revocar(
  p_cuenta_id UUID,
  p_curso_id  TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  -- Verificar autorización con scope de curso (igual que apoderado_cc_generar)
  IF NOT (
    es_dueno(p_cuenta_id)
    OR tiene_rol_en_curso(p_cuenta_id, p_curso_id, ARRAY['tesorero','admin'])
  ) THEN
    RAISE EXCEPTION 'No autorizado: se requiere rol tesorero o admin con acceso al curso'
      USING ERRCODE = '42501';
  END IF;

  UPDATE cursos
     SET codigo_compartido = NULL
   WHERE cuenta_id = p_cuenta_id
     AND id        = p_curso_id;

  RETURN jsonb_build_object('revocado', TRUE);
END;
$$;

REVOKE EXECUTE ON FUNCTION apoderado_cc_revocar(UUID, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION apoderado_cc_revocar(UUID, TEXT) TO authenticated;
-- anon no tiene EXECUTE: 42501 en la capa de permisos de PostgreSQL.


-- ── Verificación del script ──────────────────────────────────
DO $$
DECLARE errores INT := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'cursos'
       AND column_name  = 'codigo_compartido'
  ) THEN
    RAISE WARNING 'columna cursos.codigo_compartido no existe'; errores := errores + 1;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'apoderado_cc_verificar'
  ) THEN
    RAISE WARNING 'función apoderado_cc_verificar no existe'; errores := errores + 1;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'apoderado_cc_resumen_pagos'
  ) THEN
    RAISE WARNING 'función apoderado_cc_resumen_pagos no existe'; errores := errores + 1;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'apoderado_cc_generar'
  ) THEN
    RAISE WARNING 'función apoderado_cc_generar no existe'; errores := errores + 1;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'apoderado_cc_revocar'
  ) THEN
    RAISE WARNING 'función apoderado_cc_revocar no existe'; errores := errores + 1;
  END IF;

  IF errores > 0 THEN
    RAISE EXCEPTION '10_codigo_compartido_v9.sql falló con % error(es)', errores;
  END IF;

  RAISE NOTICE '10_codigo_compartido_v9.sql OK: columna + 4 funciones CC.';
  RAISE NOTICE '  apoderado_cc_verificar       → anon';
  RAISE NOTICE '  apoderado_cc_resumen_pagos   → anon  (verifica código en cada llamada)';
  RAISE NOTICE '  apoderado_cc_generar         → authenticated  (solo tesorero/admin)';
  RAISE NOTICE '  apoderado_cc_revocar         → authenticated  (solo tesorero/admin)';
END;
$$;

COMMIT;
