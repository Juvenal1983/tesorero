-- ============================================================
-- tests/00_local_test_env.sql
-- Entorno de prueba aislado para PostgreSQL local.
-- NO requiere credenciales de Supabase ni de staging.
--
-- Implementa el esquema v9 real (simplificado pero compatible),
-- incluyendo:
--   - Stubs auth.uid() y es_dueno()
--   - usuarios_cuenta.curso_id para autorización a nivel de curso
--   - Índice parcial de idempotency_key (como M001)
--   - Restricción NOT NULL en eximido (como M002)
--   - NULLIF en stubs para manejar GUC no inicializado
--
-- USO:
--   psql -d tesorero_test -f tests/00_local_test_env.sql
--   psql -d tesorero_test -f sql/11_insertar_pagos_lote.sql
--   psql -d tesorero_test -f tests/01_suite_pagos_acumulables.sql
-- ============================================================

-- ── Esquema auth (stub mínimo de Supabase Auth) ──────────────────────────────
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT
);

-- auth.uid(): retorna app.test_user_id si está configurado, si no el UUID de prueba.
-- NULLIF(TRIM(COALESCE(..., '')), '') maneja tanto NULL como '' que devuelve
-- current_setting con missing_ok=true cuando el GUC no existe.
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

-- ── Esquema extensions para gen_random_uuid ──────────────────────────────────
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE OR REPLACE FUNCTION extensions.gen_random_uuid()
RETURNS UUID LANGUAGE sql AS $$ SELECT gen_random_uuid(); $$;

-- ── Limpiar tablas de prueba anteriores (en orden de dependencia) ─────────────
DROP TABLE IF EXISTS pagos       CASCADE;
DROP TABLE IF EXISTS cuotas      CASCADE;
DROP TABLE IF EXISTS alumnos     CASCADE;
DROP TABLE IF EXISTS cursos      CASCADE;
DROP TABLE IF EXISTS colegios    CASCADE;
DROP TABLE IF EXISTS usuarios_cuenta CASCADE;
DROP TABLE IF EXISTS tesorero_cuentas CASCADE;

-- ── Schema v9 (compatible con el esquema real de Supabase) ───────────────────

CREATE TABLE tesorero_cuentas (
  id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan    TEXT    DEFAULT 'gratis',
  activo  BOOLEAN DEFAULT true
);

-- usuarios_cuenta incluye curso_id para autorización a nivel de curso.
-- curso_id IS NULL significa acceso a todos los cursos de la cuenta (admin/dueno).
-- curso_id = 'X' significa que el tesorero solo puede operar en el curso 'X'.
CREATE TABLE usuarios_cuenta (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  cuenta_id   UUID    NOT NULL REFERENCES tesorero_cuentas(id),
  auth_id     UUID    NOT NULL,
  rol         TEXT    NOT NULL DEFAULT 'tesorero',
  -- NULL = todos los cursos; valor = solo ese curso
  curso_id    TEXT    DEFAULT NULL,
  desactivado BOOLEAN DEFAULT false
);

CREATE TABLE colegios (
  cuenta_id UUID NOT NULL REFERENCES tesorero_cuentas(id),
  id        TEXT NOT NULL,
  nombre    TEXT NOT NULL,
  PRIMARY KEY (cuenta_id, id)
);

CREATE TABLE cursos (
  cuenta_id  UUID    NOT NULL REFERENCES tesorero_cuentas(id),
  id         TEXT    NOT NULL,
  nombre     TEXT    NOT NULL,
  anio       INT,
  activo     BOOLEAN DEFAULT true,
  PRIMARY KEY (cuenta_id, id)
);

CREATE TABLE alumnos (
  cuenta_id  UUID    NOT NULL REFERENCES tesorero_cuentas(id),
  id         TEXT    NOT NULL,
  curso_id   TEXT    NOT NULL,
  nombres    TEXT,
  apellidos  TEXT,
  -- M002: eximido NOT NULL DEFAULT false (con restricción real)
  eximido    BOOLEAN NOT NULL DEFAULT false,
  estado     TEXT    DEFAULT 'activo',
  PRIMARY KEY (cuenta_id, id),
  FOREIGN KEY (cuenta_id, curso_id)
    REFERENCES cursos(cuenta_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE cuotas (
  cuenta_id  UUID NOT NULL REFERENCES tesorero_cuentas(id),
  id         TEXT NOT NULL,
  curso_id   TEXT NOT NULL,
  nombre     TEXT,
  tipo       TEXT DEFAULT 'mensual',  -- 'mensual'|'anual'|'extraordinaria'
  monto      INT  DEFAULT 0 CHECK (monto >= 0),
  anio       INT,
  activa     BOOLEAN DEFAULT true,
  PRIMARY KEY (cuenta_id, id),
  FOREIGN KEY (cuenta_id, curso_id)
    REFERENCES cursos(cuenta_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE pagos (
  cuenta_id       UUID NOT NULL REFERENCES tesorero_cuentas(id),
  id              TEXT NOT NULL,
  alumno_id       TEXT,
  cuota_id        TEXT,
  monto           INT  DEFAULT 0 CHECK (monto > 0),  -- M001: monto > 0 (el RPC valida)
  fecha           DATE,
  medio           TEXT DEFAULT 'efectivo',
  estado          TEXT DEFAULT 'pagado',
  periodo         TEXT,
  obs             TEXT,
  creado_por      TEXT,
  -- M001: columna de idempotencia (NULL = sin clave)
  idempotency_key TEXT,
  PRIMARY KEY (cuenta_id, id),
  FOREIGN KEY (cuenta_id, alumno_id)
    REFERENCES alumnos(cuenta_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (cuenta_id, cuota_id)
    REFERENCES cuotas(cuenta_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX idx_pagos_cuota ON pagos(cuenta_id, cuota_id);
CREATE INDEX idx_pagos_alumno ON pagos(cuenta_id, alumno_id);

-- M001: índice parcial de idempotencia (único cuando no es NULL)
CREATE UNIQUE INDEX pagos_idempotency_key_unico
  ON pagos (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ── Función es_dueno (stub configurable vía GUC) ─────────────────────────────
-- app.test_es_dueno = 'true' → el llamante es dueño de la cuenta
-- NULLIF maneja el string vacío que devuelve current_setting cuando el GUC no existe.
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

\echo '00_local_test_env.sql: esquema v9 real creado OK (con curso_id en usuarios_cuenta)'
