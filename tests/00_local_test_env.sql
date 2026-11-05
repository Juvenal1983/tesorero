-- ============================================================
-- tests/00_local_test_env.sql
-- Entorno de prueba aislado para PostgreSQL local.
-- NO requiere credenciales de Supabase ni de staging.
-- Proporciona stubs de las funciones Supabase-específicas:
--   auth.uid(), es_dueno(), usuarios_cuenta, etc.
--
-- USO:
--   psql -d tesorero_test -f tests/00_local_test_env.sql
--   psql -d tesorero_test -f tests/01_suite_pagos_acumulables.sql
-- ============================================================

-- Esquema auth (stub mínimo de Supabase Auth)
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT
);

-- Función auth.uid() — retorna el usuario de sesión actual (stub)
-- NULLIF maneja el caso en que current_setting devuelve '' en lugar de NULL
-- cuando el GUC no ha sido inicializado en esta sesión.
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    NULLIF(TRIM(COALESCE(current_setting('app.test_user_id', true), '')), '')::UUID,
    '00000000-0000-0000-0000-000000000001'::UUID
  );
$$;

-- Esquema extensions para gen_random_uuid
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE OR REPLACE FUNCTION extensions.gen_random_uuid()
RETURNS UUID
LANGUAGE sql
AS $$ SELECT gen_random_uuid(); $$;

-- ── Tablas mínimas del schema (versión simplificada para pruebas) ─────────────

CREATE TABLE IF NOT EXISTS tesorero_cuentas (
  id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan    TEXT DEFAULT 'gratis',
  activo  BOOLEAN DEFAULT true
);

CREATE TABLE IF NOT EXISTS usuarios_cuenta (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cuenta_id   UUID NOT NULL REFERENCES tesorero_cuentas(id),
  auth_id     UUID NOT NULL,
  rol         TEXT NOT NULL DEFAULT 'tesorero',
  desactivado BOOLEAN DEFAULT false
);

CREATE TABLE IF NOT EXISTS colegios (
  cuenta_id UUID NOT NULL REFERENCES tesorero_cuentas(id),
  id        TEXT NOT NULL,
  nombre    TEXT NOT NULL,
  PRIMARY KEY (cuenta_id, id)
);

CREATE TABLE IF NOT EXISTS cursos (
  cuenta_id  UUID NOT NULL REFERENCES tesorero_cuentas(id),
  id         TEXT NOT NULL,
  nombre     TEXT NOT NULL,
  anio       INT,
  activo     BOOLEAN DEFAULT true,
  PRIMARY KEY (cuenta_id, id)
);

CREATE TABLE IF NOT EXISTS alumnos (
  cuenta_id  UUID    NOT NULL REFERENCES tesorero_cuentas(id),
  id         TEXT    NOT NULL,
  curso_id   TEXT    NOT NULL,
  nombres    TEXT,
  apellidos  TEXT,
  eximido    BOOLEAN NOT NULL DEFAULT false,
  estado     TEXT    DEFAULT 'activo',
  PRIMARY KEY (cuenta_id, id),
  FOREIGN KEY (cuenta_id, curso_id)
    REFERENCES cursos(cuenta_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS cuotas (
  cuenta_id  UUID NOT NULL REFERENCES tesorero_cuentas(id),
  id         TEXT NOT NULL,
  curso_id   TEXT NOT NULL,
  nombre     TEXT,
  tipo       TEXT DEFAULT 'mensual',
  monto      INT  DEFAULT 0,
  anio       INT,
  activa     BOOLEAN DEFAULT true,
  PRIMARY KEY (cuenta_id, id),
  FOREIGN KEY (cuenta_id, curso_id)
    REFERENCES cursos(cuenta_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS pagos (
  cuenta_id       UUID NOT NULL REFERENCES tesorero_cuentas(id),
  id              TEXT NOT NULL,
  alumno_id       TEXT,
  cuota_id        TEXT,
  monto           INT DEFAULT 0 CHECK (monto >= 0),
  fecha           DATE,
  medio           TEXT,
  estado          TEXT DEFAULT 'pagado',
  periodo         TEXT,
  obs             TEXT,
  creado_por      TEXT,
  idempotency_key TEXT,
  PRIMARY KEY (cuenta_id, id),
  FOREIGN KEY (cuenta_id, alumno_id)
    REFERENCES alumnos(cuenta_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (cuenta_id, cuota_id)
    REFERENCES cuotas(cuenta_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS idx_pagos_cuota ON pagos(cuenta_id, cuota_id);

-- Índice de idempotencia (parcial — solo si tiene valor)
CREATE UNIQUE INDEX IF NOT EXISTS pagos_idempotency_key_unico
  ON pagos (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ── Funciones de autorización (stubs para pruebas locales) ───────────────────

-- es_dueno: en pruebas, el test configura 'app.test_es_dueno' con 'true'/'false'
-- NULLIF maneja el caso de string vacío por GUC no inicializado.
CREATE OR REPLACE FUNCTION es_dueno(p_cuenta_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    NULLIF(TRIM(COALESCE(current_setting('app.test_es_dueno', true), '')), '')::BOOLEAN,
    false
  );
$$;

-- ── Función RPC bajo prueba ───────────────────────────────────────────────────
-- (se carga por separado con \i sql/11_insertar_pagos_lote.sql)

\echo '00_local_test_env.sql: entorno de prueba creado OK'
