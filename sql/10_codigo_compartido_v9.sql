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
-- ─────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS apoderado_cc_resumen_pagos(UUID, TEXT);  -- firma anterior
DROP FUNCTION IF EXISTS apoderado_cc_resumen_pagos(TEXT);

CREATE OR REPLACE FUNCTION apoderado_cc_resumen_pagos(p_codigo_cc TEXT)
RETURNS TABLE(
  alumno_id        TEXT,
  nombre           TEXT,
  monto_pagado     NUMERIC,
  monto_abonado    NUMERIC,
  monto_pendiente  NUMERIC,
  num_cuotas_pagadas   INT,
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

  -- Alumnos activos del curso
  base AS (
    SELECT
      a.id AS alumno_id,
      COALESCE(NULLIF(TRIM(a.nombre), ''),
               TRIM(COALESCE(a.nombres,'') || ' ' || COALESCE(a.apellidos,'')),
               a.id) AS nombre
    FROM alumnos a
    WHERE a.cuenta_id = v_cuenta_id
      AND a.curso_id  = v_curso_id
      AND a.estado    = 'activo'
  ),

  -- Cuotas activas del curso
  cuotas_activas AS (
    SELECT cu.id AS cuota_id, cu.monto
    FROM cuotas cu
    WHERE cu.cuenta_id = v_cuenta_id
      AND cu.curso_id  = v_curso_id
      AND cu.activa    = TRUE
  ),

  -- Pagos efectuados (estado = pagado)
  pagos_ok AS (
    SELECT p.alumno_id, COUNT(*)::INT AS n,
           COALESCE(SUM(p.monto), 0::NUMERIC) AS total
    FROM pagos p
    WHERE p.cuenta_id = v_cuenta_id
      AND p.alumno_id IN (SELECT b2.alumno_id FROM base b2)
      AND p.cuota_id  IN (SELECT ca2.cuota_id  FROM cuotas_activas ca2)
      AND p.estado    = 'pagado'
    GROUP BY p.alumno_id
  ),

  -- Abonos pagados de planes activos cuya cuota pertenece al curso
  abonos_ok AS (
    SELECT ab.alumno_id,
           COALESCE(SUM(ab.monto), 0::NUMERIC) AS total
    FROM abonos ab
    JOIN planes_pago pp
      ON pp.cuenta_id = ab.cuenta_id
     AND pp.id        = ab.plan_id
    JOIN cuotas cu
      ON cu.cuenta_id = pp.cuenta_id
     AND cu.id        = pp.cuota_id
    WHERE ab.cuenta_id = v_cuenta_id
      AND ab.alumno_id IN (SELECT b3.alumno_id FROM base b3)
      AND ab.pagado    = TRUE
      AND pp.activo    = TRUE
      AND cu.curso_id  = v_curso_id
    GROUP BY ab.alumno_id
  )

  SELECT
    b.alumno_id,
    b.nombre,
    COALESCE(po.total, 0::NUMERIC)                            AS monto_pagado,
    COALESCE(ao.total, 0::NUMERIC)                            AS monto_abonado,
    GREATEST(
      0::NUMERIC,
      (SELECT COALESCE(SUM(cu.monto), 0::NUMERIC) FROM cuotas_activas cu)
      - COALESCE(po.total, 0::NUMERIC)
      - COALESCE(ao.total, 0::NUMERIC)
    )                                                          AS monto_pendiente,
    COALESCE(po.n, 0)                                         AS num_cuotas_pagadas,
    GREATEST(
      0,
      (SELECT COUNT(*)::INT FROM cuotas_activas) - COALESCE(po.n, 0)
    )                                                          AS num_cuotas_pendientes
  FROM base b
  LEFT JOIN pagos_ok  po ON po.alumno_id = b.alumno_id
  LEFT JOIN abonos_ok ao ON ao.alumno_id = b.alumno_id
  ORDER BY b.nombre;
END;
$$;

REVOKE EXECUTE ON FUNCTION apoderado_cc_resumen_pagos(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION apoderado_cc_resumen_pagos(TEXT) TO anon;


-- ── 3. apoderado_cc_generar ──────────────────────────────────
-- Genera un código CC-XXXX para un curso.
-- Requiere JWT autenticado; el llamante debe ser:
--   • dueño de la cuenta (tesorero_cuentas.auth_id = auth.uid()), o
--   • usuario con rol 'tesorero' o 'admin' en usuarios_cuenta, no desactivado.
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
  -- Verificar autorización: dueño de la cuenta o tesorero/admin
  IF NOT (
    es_dueno(p_cuenta_id)
    OR EXISTS (
      SELECT 1 FROM usuarios_cuenta
      WHERE cuenta_id = p_cuenta_id
        AND auth_id   = auth.uid()
        AND rol IN ('tesorero', 'admin')
        AND NOT desactivado
    )
  ) THEN
    RAISE EXCEPTION 'No autorizado: se requiere rol tesorero o admin de la cuenta'
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
-- Mismo requisito de autorización que apoderado_cc_generar.
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
  -- Verificar autorización: dueño de la cuenta o tesorero/admin
  IF NOT (
    es_dueno(p_cuenta_id)
    OR EXISTS (
      SELECT 1 FROM usuarios_cuenta
      WHERE cuenta_id = p_cuenta_id
        AND auth_id   = auth.uid()
        AND rol IN ('tesorero', 'admin')
        AND NOT desactivado
    )
  ) THEN
    RAISE EXCEPTION 'No autorizado: se requiere rol tesorero o admin de la cuenta'
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
