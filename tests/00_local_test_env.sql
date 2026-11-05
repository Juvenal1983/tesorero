-- ============================================================
-- tests/00_local_test_env.sql
-- Entorno de prueba local — carga el esquema v9 REAL.
--
-- ÍTEM 4: Integra los archivos reales 01_schema.sql, M001, M002
-- y M004. No reconstruye el esquema, no simula funciones.
--
-- ESTRUCTURA:
--   1. Guard de base de datos — aborta si no es tesorero_test.
--   2. Stubs de Supabase Auth (auth.uid) — ANTES del esquema real.
--   3. Roles anon/authenticated — requeridos por 07_grants.
--   4. Limpiar schema public → recrear (DROP CASCADE).
--   5. \i sql/01_schema.sql      — esquema real completo.
--   6. \i M001                   — idempotency_key en pagos.
--   7. \i M002                   — eximido NOT NULL.
--   8. \i M004                   — tabla operaciones_pagos.
--   9. \i sql/11_insertar_pagos_lote.sql — RPC v9.
--  10. Stubs de set_config para test helpers (app.test_user_id).
--
-- NOTA SOBRE RLS:
--   02_rls.sql crea políticas de Supabase que referencian
--   auth.uid() en USING clauses. Las políticas se pueden cargar,
--   pero los tests locales corren como superusuario (postgres),
--   que bypasea RLS por defecto. Para test de RLS se requiere
--   infraestructura Supabase real. Esto está fuera del alcance
--   del entorno local y se documenta aquí explícitamente.
--
-- NOTA SOBRE \i:
--   Las rutas \i son relativas al directorio actual cuando se
--   invoca psql. run_tests.sh lo llama desde la raíz del proyecto.
--   Invocar desde otro directorio requiere ajustar las rutas.
--
-- USO:
--   psql -d tesorero_test -v ON_ERROR_STOP=1 \
--        -f tests/00_local_test_env.sql
--
-- PRODUCCIÓN: NUNCA ejecutar contra tmjqzaakzhecbldebyeg
-- STAGING: NO ejecutar — staging tiene su propia BD
-- ============================================================

\set ON_ERROR_STOP on

-- ── 1. GUARD: aborta si la BD no es tesorero_test ────────────────────────────
DO $$
BEGIN
  IF current_database() NOT IN ('tesorero_test') THEN
    RAISE EXCEPTION
      'SEGURIDAD: Este script solo puede ejecutarse en tesorero_test. '
      'Base de datos actual: %. Abortando.',
      current_database();
  END IF;
END;
$$;

-- ── 2. Schema auth y stub de auth.uid() ──────────────────────────────────────
-- Debe crearse ANTES de cargar 01_schema.sql, ya que las funciones
-- es_dueno() y tiene_rol_en_curso() llaman auth.uid() en sus cuerpos.
-- El stub lee app.test_user_id (GUC de sesión) para simular el usuario.
CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    NULLIF(TRIM(COALESCE(current_setting('app.test_user_id', true), '')), '')::UUID,
    '00000000-0000-0000-0000-000000000001'::UUID
  )
$$;

-- Stub mínimo de auth.users para referencias externas (no usado en tests)
CREATE TABLE IF NOT EXISTS auth.users (
  id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT
);

-- ── 3. Roles requeridos por grants de Supabase ───────────────────────────────
-- 07_grants_supabase.sql otorga permisos a authenticated y anon.
-- Los roles deben existir antes de cualquier GRANT.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon;
  END IF;
END;
$$;

-- ── 4. Limpiar y recrear schema public ───────────────────────────────────────
-- DROP CASCADE elimina todas las tablas, funciones, índices y triggers.
-- Solo es seguro después del guard de BD.
-- El schema _staging y auth se conservan (no son public).
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO authenticated, anon;

-- Schema extensions (requerido por SET search_path = public, extensions)
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE OR REPLACE FUNCTION extensions.gen_random_uuid()
RETURNS UUID LANGUAGE sql AS $$ SELECT gen_random_uuid(); $$;

-- ── 5. Cargar esquema real v9 ─────────────────────────────────────────────────
-- Crea todas las tablas, índices, triggers y funciones auxiliares reales.
-- Incluye es_dueno(), tiene_rol_en_curso(), _check_pago_mismo_curso(), etc.
\i sql/01_schema.sql

-- ── 6. M001: idempotency_key en pagos ────────────────────────────────────────
-- Elimina el UNIQUE index de período único y agrega idempotency_key.
-- Permite pagos acumulables por (alumno, cuota, período).
\i sql/migrations/M001_idempotency_key.sql

-- ── 7. M002: eximido NOT NULL ─────────────────────────────────────────────────
-- Normaliza alumnos.eximido = NULL → false y agrega restricción NOT NULL.
\i sql/migrations/M002_eximido_normalize.sql

-- ── 8. M004: tabla operaciones_pagos (identidad durable) ─────────────────────
-- Registra operaciones de forma independiente del pago editable/eliminable.
-- Previene que un reintento antiguo recree un pago eliminado.
\i sql/migrations/M004_operaciones_idempotentes.sql

-- ── 9. RPC insertar_pagos_lote ────────────────────────────────────────────────
-- Función transaccional con idempotencia durable, autorización por curso
-- (es_dueno() = bypass total; admin/tesorero usan tiene_rol_en_curso()),
-- e identidad completa de operación (autor + contenido).
\i sql/11_insertar_pagos_lote.sql

-- ── 10. Confirmación ─────────────────────────────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE '=================================================';
  RAISE NOTICE 'Entorno de prueba LOCAL listo (tesorero_test).';
  RAISE NOTICE '  Esquema real: 01_schema.sql ✓';
  RAISE NOTICE '  Migraciones: M001 ✓  M002 ✓  M004 ✓';
  RAISE NOTICE '  RPC: insertar_pagos_lote ✓';
  RAISE NOTICE '  auth.uid() stubbed (app.test_user_id) ✓';
  RAISE NOTICE '  Roles: authenticated ✓  anon ✓';
  RAISE NOTICE '=================================================';
  RAISE NOTICE 'NOTA: RLS no se prueba localmente (bypaseado por';
  RAISE NOTICE '  superusuario). Las políticas de 02_rls.sql';
  RAISE NOTICE '  requieren infraestructura Supabase Auth real.';
  RAISE NOTICE '=================================================';
END;
$$;
