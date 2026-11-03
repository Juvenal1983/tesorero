-- ============================================================
-- El Tesorero — "El Gran Cambio" v9
-- Archivo: sql/10_codigo_compartido_v9.sql
-- Propósito: Acceso compartido (CC-XXXX) en modelo relacional v9.
--
-- Depende de: 01_schema.sql (tabla cursos), 06_rpcs_apoderado.sql
--
-- Funciones que agrega:
--   apoderado_cc_verificar(p_codigo_cc TEXT)
--     → {cuenta_id, curso_id, nombre_curso, anio} | NULL si inválido
--     Acceso: anon (sin PIN)
--
--   apoderado_cc_resumen_pagos(p_cuenta_id UUID, p_curso_id TEXT)
--     → lista de alumnos con monto_pagado / monto_pendiente / porcentaje
--     Acceso: anon (sin PIN) — solo llamar tras verificar con la función anterior
--
--   apoderado_cc_generar(p_cuenta_id UUID, p_curso_id TEXT, p_pin TEXT)
--     → {codigo_cc TEXT} | lanza excepción si PIN incorrecto
--     Genera un código CC nuevo; requiere PIN de cualquier apoderado activo
--     del curso (en v9 el tesorero también es un apoderado con rol 'admin').
--
--   apoderado_cc_revocar(p_cuenta_id UUID, p_curso_id TEXT, p_pin TEXT)
--     → {revocado BOOLEAN}
--     Elimina el código CC; mismo requisito de PIN que el anterior.
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
-- No requiere PIN: es la primera llamada del flujo de acceso compartido.
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
-- Retorna el estado de pagos de todos los alumnos activos de un
-- curso, agregando cuotas pagadas y pendientes.
-- Se llama SOLO después de verificar el código con apoderado_cc_verificar.
-- No requiere PIN (el código CC es la credencial de acceso).
-- ─────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS apoderado_cc_resumen_pagos(UUID, TEXT);

CREATE OR REPLACE FUNCTION apoderado_cc_resumen_pagos(
  p_cuenta_id UUID,
  p_curso_id  TEXT
)
RETURNS TABLE(
  alumno_id        TEXT,
  nombre           TEXT,
  monto_pagado     NUMERIC,
  monto_abonado    NUMERIC,
  monto_pendiente  NUMERIC,
  num_cuotas_pagadas   INT,
  num_cuotas_pendientes INT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  WITH

  -- Alumnos activos del curso
  base AS (
    SELECT
    a.id AS alumno_id,
    COALESCE(NULLIF(TRIM(a.nombre), ''),
             TRIM(COALESCE(a.nombres,'') || ' ' || COALESCE(a.apellidos,'')),
             a.id) AS nombre
    FROM alumnos a
    WHERE a.cuenta_id = p_cuenta_id
      AND a.curso_id  = p_curso_id
      AND a.estado    = 'activo'
  ),

  -- Cuotas activas del curso con su monto
  cuotas_activas AS (
    SELECT cu.id AS cuota_id, cu.monto
    FROM cuotas cu
    WHERE cu.cuenta_id = p_cuenta_id
      AND cu.curso_id  = p_curso_id
      AND cu.activa    = TRUE
  ),

  -- Pagos efectuados (estado=pagado), uno por (alumno, cuota)
  pagos_ok AS (
    SELECT p.alumno_id, COUNT(*)::INT AS n, COALESCE(SUM(p.monto), 0) AS total
    FROM pagos p
    WHERE p.cuenta_id = p_cuenta_id
      AND p.alumno_id IN (SELECT alumno_id FROM base)
      AND p.cuota_id  IN (SELECT cuota_id  FROM cuotas_activas)
      AND p.estado    = 'pagado'
    GROUP BY p.alumno_id
  ),

  -- Abonos pagados de planes activos cuya cuota pertenece al curso
  abonos_ok AS (
    SELECT ab.alumno_id, COALESCE(SUM(ab.monto), 0) AS total
    FROM abonos ab
    JOIN planes_pago pp
      ON pp.cuenta_id = ab.cuenta_id
     AND pp.id        = ab.plan_id
    JOIN cuotas cu
      ON cu.cuenta_id = pp.cuenta_id
     AND cu.id        = pp.cuota_id
    WHERE ab.cuenta_id = p_cuenta_id
      AND ab.alumno_id IN (SELECT alumno_id FROM base)
      AND ab.pagado    = TRUE
      AND pp.activo    = TRUE
      AND cu.curso_id  = p_curso_id
    GROUP BY ab.alumno_id
  ),

  -- Total de cuotas por alumno (para calcular pendientes)
  total_cuotas AS (
    SELECT COUNT(*) AS n FROM cuotas_activas
  )

  SELECT
    b.alumno_id,
    b.nombre,
    COALESCE(po.total, 0)                                     AS monto_pagado,
    COALESCE(ao.total, 0)                                     AS monto_abonado,
    -- Pendiente: cuotas activas * monto_cuota - pagado - abonado
    -- Simplificación: diferencia de cantidad de cuotas * monto promedio
    GREATEST(
      0,
      (SELECT COALESCE(SUM(cu.monto), 0) FROM cuotas_activas cu)
      - COALESCE(po.total, 0)
      - COALESCE(ao.total, 0)
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
$$;

REVOKE EXECUTE ON FUNCTION apoderado_cc_resumen_pagos(UUID, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION apoderado_cc_resumen_pagos(UUID, TEXT) TO anon;


-- ── 3. apoderado_cc_generar ──────────────────────────────────
-- El tesorero (apoderado con PIN válido) genera un código CC-XXXX.
-- Si ya existía uno, lo reemplaza.
-- ─────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS apoderado_cc_generar(UUID, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION apoderado_cc_generar(
  p_cuenta_id UUID,
  p_curso_id  TEXT,
  p_alumno_id TEXT,   -- alumno del tesorero (para verificar PIN)
  p_pin       TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_resultado TEXT;
  v_codigo    TEXT;
  v_chars     TEXT := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_seg1      TEXT := '';
  v_seg2      TEXT := '';
  i           INT;
BEGIN
  -- Verificar PIN con la función auxiliar existente
  v_resultado := _apoderado_verificar_pin(p_cuenta_id, p_alumno_id, p_pin);

  IF v_resultado <> 'ok' THEN
    RAISE EXCEPTION 'PIN inválido: %', v_resultado
      USING ERRCODE = 'P0001';
  END IF;

  -- Verificar que el alumno pertenece al curso indicado
  IF NOT EXISTS (
    SELECT 1 FROM alumnos
    WHERE cuenta_id = p_cuenta_id
      AND id        = p_alumno_id
      AND curso_id  = p_curso_id
  ) THEN
    RAISE EXCEPTION 'El alumno no pertenece al curso indicado'
      USING ERRCODE = 'P0002';
  END IF;

  -- Generar código CC-XXXX-XXXX usando gen_random_bytes para aleatoriedad
  FOR i IN 1..4 LOOP
    v_seg1 := v_seg1 || substr(v_chars,
      1 + (get_byte(gen_random_bytes(1), 0) % length(v_chars)),
      1);
  END LOOP;
  FOR i IN 1..4 LOOP
    v_seg2 := v_seg2 || substr(v_chars,
      1 + (get_byte(gen_random_bytes(1), 0) % length(v_chars)),
      1);
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

REVOKE EXECUTE ON FUNCTION apoderado_cc_generar(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION apoderado_cc_generar(UUID, TEXT, TEXT, TEXT) TO anon;


-- ── 4. apoderado_cc_revocar ──────────────────────────────────
-- Elimina el código CC del curso. Mismo requisito de PIN.
-- ─────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS apoderado_cc_revocar(UUID, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION apoderado_cc_revocar(
  p_cuenta_id UUID,
  p_curso_id  TEXT,
  p_alumno_id TEXT,
  p_pin       TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_resultado TEXT;
BEGIN
  v_resultado := _apoderado_verificar_pin(p_cuenta_id, p_alumno_id, p_pin);

  IF v_resultado <> 'ok' THEN
    RAISE EXCEPTION 'PIN inválido: %', v_resultado
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE cursos
     SET codigo_compartido = NULL
   WHERE cuenta_id = p_cuenta_id
     AND id        = p_curso_id;

  RETURN jsonb_build_object('revocado', TRUE);
END;
$$;

REVOKE EXECUTE ON FUNCTION apoderado_cc_revocar(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION apoderado_cc_revocar(UUID, TEXT, TEXT, TEXT) TO anon;


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
    WHERE n.nspname = 'public'
      AND p.proname = 'apoderado_cc_verificar'
  ) THEN
    RAISE WARNING 'función apoderado_cc_verificar no existe'; errores := errores + 1;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'apoderado_cc_resumen_pagos'
  ) THEN
    RAISE WARNING 'función apoderado_cc_resumen_pagos no existe'; errores := errores + 1;
  END IF;

  IF errores > 0 THEN
    RAISE EXCEPTION '10_codigo_compartido_v9.sql falló con % error(es)', errores;
  END IF;

  RAISE NOTICE '10_codigo_compartido_v9.sql OK: columna + 4 funciones CC creadas.';
END;
$$;

COMMIT;
