-- ============================================================
-- El Tesorero — "El Gran Cambio" v9
-- Archivo: sql/01_schema.sql
-- Cambios v9:
--   • _check_pago_mismo_curso: agrega FOR SHARE también en la fila de cuota
--     (Fix 1): el FOR SHARE de v8 sobre alumnos no protegía la carrera
--     entre UPDATE cuotas.curso_id (sin commit) e INSERT pago concurrente.
--     Ahora la sesión de INSERT bloquea tanto alumno como cuota en FOR SHARE,
--     forzando esperar hasta que cualquier cambio de curso de cuota confirme.
--   • _check_abono_plan_consistente: agrega FOR SHARE en la fila del plan
--     (Fix 2): antes un INSERT abono leía el plan sin bloqueo, permitiendo
--     que un UPDATE planes_pago.alumno_id sin commit pasara invisible.
--     Ahora la sesión de INSERT abono bloquea el plan en FOR SHARE, forzando
--     serialización con cualquier cambio de titular pendiente.
-- Nota de diseño — Rutas de adquisición de locks en INSERT abonos:
--   Un INSERT (o UPDATE) sobre la tabla abonos dispara dos triggers en orden:
--     1. trg_abonos_mismo_curso   → _check_pago_mismo_curso()
--          adquiere FOR SHARE en alumnos  (fila del alumno_id del abono)
--          adquiere FOR SHARE en cuotas   (fila del cuota_id del abono)
--     2. trg_abonos_plan_consistente → _check_abono_plan_consistente()
--          adquiere FOR SHARE en planes_pago (fila del plan_id, solo si plan_id IS NOT NULL)
--   Ruta observada para esa operación: alumno → cuota → plan.
--
--   Esto NO garantiza ausencia de deadlocks. Existen otras rutas de bloqueo
--   que este esquema no controla en su totalidad:
--     • UPDATE sobre alumnos, cuotas o planes_pago adquiere FOR NO KEY UPDATE
--       o FOR UPDATE implícito en la fila afectada, según las columnas modificadas
--       (FOR NO KEY UPDATE cuando no se tocan columnas referenciadas por FK;
--       FOR UPDATE cuando sí se tocan). Ambos modos son incompatibles con FOR SHARE
--       de otra transacción concurrente; la espera puede formar ciclo con una tercera
--       operación.
--     • Las restricciones de clave foránea (FK) adquieren locks internos en las
--       tablas referenciadas al validar integridad referencial; ese orden no es
--       configurable por el usuario.
--     • Operaciones que afectan varias filas de la misma tabla en distinto orden
--       entre sesiones concurrentes pueden crear deadlock dentro de un único trigger.
--     • Futuros triggers o consultas que accedan a estas tablas en otro orden
--       pueden introducir nuevas rutas de ciclo.
--
--   Tratamiento de deadlocks (SQLSTATE 40P01):
--     PostgreSQL detecta el ciclo y aborta una de las transacciones con el error
--     "deadlock detected". La aplicación cliente debe:
--       a) Capturar el error 40P01.
--       b) Revertir la transacción completa (ROLLBACK).
--       c) Reintentar la transacción desde el principio, con retardo exponencial
--          y un número máximo de intentos (p.ej. 3 reintentos, espera 100–400 ms).
--     NO debe reintentarse solo el statement fallido dentro de la misma transacción:
--     el estado de la transacción es inválido tras un deadlock.
--     Ejemplo de manejo en la capa de aplicación (pseudocódigo):
--       for attempt in 1..MAX_ATTEMPTS:
--         try: BEGIN; ... INSERT abono ...; COMMIT; return ok
--         catch 40P01: ROLLBACK; sleep(100ms * 2^attempt); continue
--         catch other: ROLLBACK; raise
--       raise "deadlock: operación fallida tras MAX_ATTEMPTS intentos"
--     -- Al agotar los intentos, el error se propaga al llamador.
--     -- No debe asumirse éxito si el bucle termina sin COMMIT.
--
--   Los escenarios probados en prueba_concurrencia.py validan las tres combinaciones
--   concurrentes identificadas durante la revisión de v8. No cubren todas las
--   combinaciones posibles de operaciones simultáneas ni las rutas de lock implícitas
--   de FK. La documentación de esta ruta busca mantener la consistencia del diseño
--   cuando se modifique el código, no reemplazar pruebas adicionales.
--
-- Cambios v8:
--   • _check_pago_mismo_curso usa SELECT … FOR SHARE en la fila de alumno
--     (Fix 3): evita race condition entre traslado de alumno y registro de
--     pago concurrentes bajo READ COMMITTED.
--   • Trigger _check_plan_cambio_titular en planes_pago (Fix 2):
--     bloquea UPDATE de alumno_id o cuota_id cuando el plan ya tiene abonos.
--     Protege la relación plan↔abono en ambos sentidos (antes solo al escribir
--     el abono; ahora también al editar el padre).
-- Cambios v7:
--   • UNIQUE index de pagos extendido con COALESCE(periodo,'') (Fix 1):
--     cubre periodo=NULL, cierra brecha de pagos sin periodo duplicados.
--   • Trigger _check_abono_plan_consistente en abonos (Fix 2):
--     si plan_id presente, alumno_id y cuota_id del abono deben coincidir
--     exactamente con los del plan; impide abonos cruzados entre cursos.
--   • Trigger _check_alumno_cambio_curso en alumnos UPDATE OF curso_id (Fix 3):
--     bloquea traslado de alumno con pagos/planes/abonos del curso anterior.
--   • Trigger _check_cuota_cambio_curso en cuotas UPDATE OF curso_id (Fix 3):
--     simétrico; bloquea cambio de curso de una cuota con registros existentes.
-- Cambios v6:
--   • Vista pública tesorero_datos ELIMINADA (Fix 1 revisión v5):
--     la vista heredaba permisos del propietario (postgres/superuser) y podía
--     quedar accesible si existían grants heredados previos.
--     La migración ahora siempre usa _staging.tesorero_datos directamente.
--   • Trigger check_pago_mismo_curso en pagos/planes_pago/abonos (Fix 2):
--     alumno y cuota deben pertenecer al mismo curso; impide pagos cruzados.
--   • UNIQUE parcial en pagos (Fix 3): un pago estado='pagado' por alumno+cuota+periodo.
--   • pgcrypto + crypt() en migración para pin_hash (Fix 4).
--   • curso_id añadido a pagos y planes_pago como columna derivada (Fix 2 apoyo).
-- Cambios v5:
--   • tesorero_datos movido a schema _staging (no expuesto a clientes)
--   • planes_pago: estructura real del HTML original
--     (periodo, monto_total; ya no nCuotas/montoCuota/fechaInicio)
--   • abonos: plan_id FK a planes_pago, campos pagado/fecha_pago
--   • fondo_movimientos: tipos reales del HTML original
--     (aporte, rendimiento, actividad, multa) + nombre, monto_individual, participantes
--   • pin separado en tabla alumnos_credenciales (no legible por clientes)
--   • plan en tabla separada suscripciones (solo editable por backend)
--   • columna origen_auth_id en tesorero_cuentas para mapeo robusto
-- ============================================================

-- ── Extensión pgcrypto para hashing de PIN ────────────────────
-- Necesario para crypt() / gen_salt('bf') en alumnos_credenciales.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Schema privado para staging (NO accesible por clientes) ──
CREATE SCHEMA IF NOT EXISTS _staging;

-- ── Tabla raíz: Cuentas de tesoreros ──────────────────────────
CREATE TABLE IF NOT EXISTS tesorero_cuentas (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_id         UUID    UNIQUE,          -- identidad Supabase Auth del dueño (sin FK)
  origen_auth_id  UUID    UNIQUE,          -- UUID de la cuenta en producción original (clave de idempotencia)
  email           TEXT    NOT NULL UNIQUE, -- clave de mapeo en 05_mapeo_auth.sql
  nombre          TEXT,
  creado_en       TIMESTAMPTZ DEFAULT now()
);
-- NOTA: columna 'plan' eliminada de esta tabla (v5).
--       El plan se gestiona en la tabla 'suscripciones' (solo backend/service_role).

-- ── Suscripciones (solo backend/service_role puede escribir) ──
-- En Supabase real: grants ONLY a service_role, no a authenticated.
CREATE TABLE IF NOT EXISTS suscripciones (
  cuenta_id   UUID PRIMARY KEY REFERENCES tesorero_cuentas(id) ON DELETE CASCADE,
  plan        TEXT    DEFAULT 'gratis',
  activo      BOOLEAN DEFAULT true,
  vence_el    DATE,
  fecha_inicio DATE
);

-- ── Datos de origen JSON (staging de migración, en schema privado) ─
CREATE TABLE IF NOT EXISTS _staging.tesorero_datos (
  usuario_id   UUID PRIMARY KEY,
  datos        JSONB NOT NULL,
  importado_en TIMESTAMPTZ DEFAULT now()
);
-- NOTA v6: La vista pública tesorero_datos fue ELIMINADA.
-- Razón: con grants heredados previos (ALTER DEFAULT PRIVILEGES), el propietario
--        de la vista (postgres/superuser) omite RLS de _staging, exponiendo los JSON.
-- La migración (04_migracion.sql) ya usa _staging.tesorero_datos directamente.
-- En Supabase real el schema _staging no existe en el proyecto de destino;
-- los datos se importan por otro mecanismo controlado (copia autenticada o seed).

-- ── Colegios ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS colegios (
  cuenta_id  UUID    NOT NULL REFERENCES tesorero_cuentas(id) ON DELETE RESTRICT,
  id         TEXT    NOT NULL,
  nombre     TEXT    NOT NULL,
  activo     BOOLEAN DEFAULT true,
  ciudad     TEXT,
  PRIMARY KEY (cuenta_id, id)
);

-- ── Cursos ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cursos (
  cuenta_id          UUID    NOT NULL REFERENCES tesorero_cuentas(id) ON DELETE RESTRICT,
  id                 TEXT    NOT NULL,
  colegio_id         TEXT,
  nombre             TEXT    NOT NULL,
  anio               INT,
  activo             BOOLEAN DEFAULT true,
  codigo             TEXT,
  tesorero           TEXT,
  tesorera_id        TEXT,
  banco              JSONB,
  meta               INT     DEFAULT 0,
  cuota_anual        INT     DEFAULT 0,
  cuota_mensual      INT     DEFAULT 0,
  fondo_especial     JSONB,
  mes_inicio_cuota   INT     DEFAULT 0,   -- convención 0-based (MESES.slice) del HTML
  mes_termino_cuota  INT     DEFAULT 10,  -- 0=enero … 11=diciembre
  comuna             TEXT,
  region             TEXT,
  PRIMARY KEY (cuenta_id, id),
  FOREIGN KEY (cuenta_id, colegio_id)
    REFERENCES colegios(cuenta_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);

-- ── Alumnos ───────────────────────────────────────────────────
-- PIN eliminado de esta tabla para no exponerlo a clientes.
-- Se almacena en alumnos_credenciales (acceso restringido).
CREATE TABLE IF NOT EXISTS alumnos (
  cuenta_id  UUID    NOT NULL,
  id         TEXT    NOT NULL,
  curso_id   TEXT,
  nombre     TEXT,
  nombres    TEXT,
  apellidos  TEXT,
  estado     TEXT    DEFAULT 'activo',
  obs        TEXT,
  eximido    BOOLEAN DEFAULT false,
  PRIMARY KEY (cuenta_id, id),
  FOREIGN KEY (cuenta_id, curso_id)
    REFERENCES cursos(cuenta_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);

-- ── Credenciales de alumnos (solo backend/service_role) ───────
-- La columna pin NO se expone a clientes por grants.
-- En Supabase: REVOKE SELECT ON alumnos_credenciales FROM authenticated, anon.
CREATE TABLE IF NOT EXISTS alumnos_credenciales (
  cuenta_id   UUID  NOT NULL,
  alumno_id   TEXT  NOT NULL,
  pin_hash    TEXT,  -- hash del PIN, nunca texto plano
  PRIMARY KEY (cuenta_id, alumno_id),
  FOREIGN KEY (cuenta_id, alumno_id)
    REFERENCES alumnos(cuenta_id, id) ON DELETE CASCADE
);

-- ── Apoderados ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS apoderados (
  cuenta_id  UUID  NOT NULL,
  id         TEXT  NOT NULL,
  alumno_id  TEXT,
  nombre     TEXT  NOT NULL,
  relacion   TEXT,
  estado     TEXT  DEFAULT 'activo',
  telefono   TEXT,
  email      TEXT,
  PRIMARY KEY (cuenta_id, id),
  FOREIGN KEY (cuenta_id, alumno_id)
    REFERENCES alumnos(cuenta_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);

-- ── Cuotas ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cuotas (
  cuenta_id    UUID    NOT NULL,
  id           TEXT    NOT NULL,
  curso_id     TEXT,
  nombre       TEXT    NOT NULL,
  monto        INT     DEFAULT 0  CHECK (monto >= 0),
  tipo         TEXT,
  anio         INT,
  activa       BOOLEAN DEFAULT true,
  mes_inicio   INT,    -- 0-based (mismo que HTML)
  mes_termino  INT,
  obs          TEXT,
  PRIMARY KEY (cuenta_id, id),
  FOREIGN KEY (cuenta_id, curso_id)
    REFERENCES cursos(cuenta_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);

-- ── Pagos ─────────────────────────────────────────────────────
-- v6: UNIQUE parcial para impedir pago duplicado pagado.
-- v7: UNIQUE extendido con COALESCE(periodo,'') para cubrir periodo=NULL (Fix 1).
CREATE TABLE IF NOT EXISTS pagos (
  cuenta_id   UUID  NOT NULL,
  id          TEXT  NOT NULL,
  alumno_id   TEXT,
  cuota_id    TEXT,
  monto       INT   DEFAULT 0  CHECK (monto >= 0),
  fecha       DATE,
  medio       TEXT,
  estado      TEXT  DEFAULT 'pagado',
  periodo     TEXT,
  obs         TEXT,
  creado_por  TEXT,
  PRIMARY KEY (cuenta_id, id),
  FOREIGN KEY (cuenta_id, alumno_id)
    REFERENCES alumnos(cuenta_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (cuenta_id, cuota_id)
    REFERENCES cuotas(cuenta_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS idx_pagos_cuota ON pagos(cuenta_id, cuota_id);

-- Fix 1 v7: UNIQUE extendido con COALESCE(periodo, '') para cubrir también periodo=NULL.
-- COALESCE convierte NULL → '' de forma que dos pagos sin periodo del mismo alumno+cuota
-- colisionan igual que dos con el mismo texto. Esto cierra la brecha de pagos nuevos
-- sin periodo: estado=pagado, mismo alumno+cuota, ambos sin periodo → colisión '' = ''.
-- Para datos históricos importados con NULL legítimos y distintas IDs, el importador
-- debe asignar un periodo descriptivo (ej. "histórico-YYYY") en vez de NULL.
CREATE UNIQUE INDEX IF NOT EXISTS pagos_alumno_cuota_periodo_unico
  ON pagos (cuenta_id, alumno_id, cuota_id, COALESCE(periodo, ''))
  WHERE estado = 'pagado';

-- ── Planes de pago ────────────────────────────────────────────
-- Estructura del HTML original:
--   planesPago: [{id, alumnoId, cuotaId, periodo, montoTotal,
--                  abonos:[{monto,fecha,pagado,fechaPago}],
--                  activo, creadoEn}]
-- Los abonos anidados se migran a la tabla 'abonos' con plan_id FK.
CREATE TABLE IF NOT EXISTS planes_pago (
  cuenta_id    UUID    NOT NULL,
  id           TEXT    NOT NULL,
  alumno_id    TEXT,
  cuota_id     TEXT,
  periodo      TEXT,           -- "Anual 2025", "Mensual Marzo", etc.
  monto_total  INT     DEFAULT 0  CHECK (monto_total >= 0),
  activo       BOOLEAN DEFAULT true,
  creado_en    DATE,
  obs          TEXT,
  PRIMARY KEY (cuenta_id, id),
  FOREIGN KEY (cuenta_id, alumno_id)
    REFERENCES alumnos(cuenta_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (cuenta_id, cuota_id)
    REFERENCES cuotas(cuenta_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);

-- ── Abonos ────────────────────────────────────────────────────
-- Pagos parciales.  Pueden venir del JSON raíz (abonos[]) O
-- de planesPago[].abonos[] (en ese caso, plan_id apunta al plan).
-- plan_id = NULL: abono directo sin plan.
CREATE TABLE IF NOT EXISTS abonos (
  cuenta_id   UUID    NOT NULL,
  id          TEXT    NOT NULL,
  alumno_id   TEXT,
  cuota_id    TEXT,
  plan_id     TEXT,             -- FK a planes_pago; NULL si es abono directo
  monto       INT     DEFAULT 0  CHECK (monto >= 0),
  fecha       DATE,
  pagado      BOOLEAN DEFAULT false,
  fecha_pago  DATE,
  medio       TEXT,
  estado      TEXT  DEFAULT 'registrado',
  obs         TEXT,
  creado_por  TEXT,
  PRIMARY KEY (cuenta_id, id),
  FOREIGN KEY (cuenta_id, alumno_id)
    REFERENCES alumnos(cuenta_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (cuenta_id, cuota_id)
    REFERENCES cuotas(cuenta_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (cuenta_id, plan_id)
    REFERENCES planes_pago(cuenta_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS idx_abonos_plan ON abonos(cuenta_id, plan_id);

-- ── Movimientos de caja ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS movimientos (
  cuenta_id   UUID    NOT NULL,
  id          TEXT    NOT NULL,
  curso_id    TEXT,
  tipo        TEXT    NOT NULL CHECK (tipo IN ('ingreso', 'gasto', 'egreso')),
  monto       INT     DEFAULT 0  CHECK (monto >= 0),
  "desc"      TEXT,
  obs         TEXT,
  fecha       DATE,
  categoria   TEXT,
  visible     BOOLEAN DEFAULT true,
  comprobante TEXT,
  archivos    JSONB,
  creado_por  TEXT,
  responsable TEXT,
  PRIMARY KEY (cuenta_id, id),
  FOREIGN KEY (cuenta_id, curso_id)
    REFERENCES cursos(cuenta_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);

-- ── Fondo especial / historial de fondos ─────────────────────
-- Tipos reales del HTML original (saveMovFondo):
--   aporte, rendimiento, actividad, multa
-- Campos adicionales del formato real:
--   nombre, monto_total, monto_individual (JSONB {alumno_id: monto}),
--   participantes (JSONB array de alumno_ids)
CREATE TABLE IF NOT EXISTS fondo_movimientos (
  cuenta_id          UUID  NOT NULL,
  id                 TEXT  NOT NULL,
  curso_id           TEXT,
  tipo               TEXT  NOT NULL
                       CHECK (tipo IN ('aporte', 'rendimiento', 'actividad', 'multa',
                                       'ingreso', 'egreso')),
                       -- 'ingreso'/'egreso' como alias de compatibilidad
  nombre             TEXT,   -- descripción libre del movimiento
  monto_total        INT   DEFAULT 0  CHECK (monto_total >= 0),
  monto_individual   JSONB,  -- {"alumno_id": monto, ...}
  participantes      JSONB,  -- array de alumno_ids que participaron
  "desc"             TEXT,   -- alias para compatibilidad con formato simplificado
  fecha              DATE,
  obs                TEXT,
  creado_por         TEXT,
  PRIMARY KEY (cuenta_id, id),
  FOREIGN KEY (cuenta_id, curso_id)
    REFERENCES cursos(cuenta_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);

-- ── Notas ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notas (
  cuenta_id  UUID    NOT NULL,
  id         TEXT    NOT NULL,
  curso_id   TEXT,
  texto      TEXT    NOT NULL DEFAULT '',
  color      TEXT,
  fijada     BOOLEAN DEFAULT false,
  privada    BOOLEAN DEFAULT true,
  fecha      TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (cuenta_id, id),
  FOREIGN KEY (cuenta_id, curso_id)
    REFERENCES cursos(cuenta_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);

-- ── Usuarios con acceso a la cuenta ──────────────────────────
CREATE TABLE IF NOT EXISTS usuarios_cuenta (
  cuenta_id        UUID    NOT NULL REFERENCES tesorero_cuentas(id) ON DELETE RESTRICT,
  id               TEXT    NOT NULL,
  auth_id          UUID,
  email            TEXT    NOT NULL,
  nombre           TEXT,
  rol              TEXT    DEFAULT 'visor'
                     CHECK (rol IN ('visor', 'editor', 'tesorero', 'admin')),
  curso_id         TEXT,
  desactivado      BOOLEAN DEFAULT false,
  plan_anual       BOOLEAN DEFAULT false,
  plan_anual_hasta DATE,
  fecha_registro   DATE,
  PRIMARY KEY (cuenta_id, id),
  FOREIGN KEY (cuenta_id, curso_id)
    REFERENCES cursos(cuenta_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS idx_usuarios_cuenta_email ON usuarios_cuenta(cuenta_id, email);
CREATE INDEX IF NOT EXISTS idx_usuarios_cuenta_auth  ON usuarios_cuenta(auth_id);

-- ── Usuarios externos ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS usuarios_externos (
  cuenta_id           UUID  NOT NULL REFERENCES tesorero_cuentas(id) ON DELETE RESTRICT,
  id                  TEXT  NOT NULL,
  email               TEXT,
  nombre              TEXT,
  codigo_usado        TEXT,
  desactivado         BOOLEAN DEFAULT false,
  plan_anual          BOOLEAN DEFAULT false,
  plan_anual_hasta    DATE,
  fecha_registro      DATE,
  ultima_actividad    TIMESTAMPTZ,
  PRIMARY KEY (cuenta_id, id)
);

-- ── Códigos de invitación ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS codigos_invitacion (
  cuenta_id   UUID  NOT NULL REFERENCES tesorero_cuentas(id) ON DELETE RESTRICT,
  id          TEXT  NOT NULL,
  para        TEXT,
  codigo      TEXT,
  tipo        TEXT,
  notas       TEXT,
  activo      BOOLEAN DEFAULT true,
  usado       BOOLEAN DEFAULT false,
  usado_en    DATE,
  usado_por   TEXT,
  vence_el    DATE,
  PRIMARY KEY (cuenta_id, id)
);

-- ── Configuración por cuenta ──────────────────────────────────
CREATE TABLE IF NOT EXISTS config_cuenta (
  cuenta_id       UUID PRIMARY KEY REFERENCES tesorero_cuentas(id) ON DELETE RESTRICT,
  moneda          TEXT DEFAULT 'CLP',
  tipo_org        TEXT,
  app_url         TEXT,
  plantilla_pago  TEXT,
  categorias      JSONB
);

-- ──────────────────────────────────────────────────────────────
-- Funciones auxiliares RLS
-- SECURITY DEFINER + SET search_path previene inyección de search_path
-- ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_mis_cuentas()
RETURNS TABLE(id UUID)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT tc.id FROM tesorero_cuentas tc WHERE tc.auth_id = auth.uid()
  UNION
  SELECT uc.cuenta_id FROM usuarios_cuenta uc
  WHERE uc.auth_id = auth.uid() AND uc.desactivado = FALSE
$$;

CREATE OR REPLACE FUNCTION get_mis_cursos(p_cuenta_id UUID)
RETURNS TABLE(curso_id TEXT)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT uc.curso_id FROM usuarios_cuenta uc
  WHERE uc.auth_id = auth.uid()
    AND uc.cuenta_id = p_cuenta_id
    AND uc.desactivado = FALSE
    AND uc.curso_id IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION es_dueno(p_cuenta_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1 FROM tesorero_cuentas
    WHERE id = p_cuenta_id AND auth_id = auth.uid()
  )
$$;

-- Verifica que auth.uid() tiene rol >= mínimo en la cuenta/curso dados
-- roles: visor < editor < tesorero < admin
-- Usado en políticas DML para limitar escritura por rol Y curso
CREATE OR REPLACE FUNCTION tiene_rol_en_curso(
  p_cuenta_id UUID,
  p_curso_id  TEXT,
  p_roles     TEXT[]   -- roles aceptados, ej. ARRAY['tesorero','admin']
)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1 FROM usuarios_cuenta
    WHERE cuenta_id    = p_cuenta_id
      AND auth_id      = auth.uid()
      AND rol          = ANY(p_roles)
      AND desactivado  = FALSE
      AND (curso_id    = p_curso_id OR curso_id IS NULL)
  )
$$;

-- ──────────────────────────────────────────────────────────────
-- Función auxiliar: retorna curso_id de una cuota (para _curso_de_cuota en RLS)
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _curso_de_cuota(p_cuenta_id UUID, p_cuota_id TEXT)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT curso_id FROM cuotas
  WHERE cuenta_id = p_cuenta_id AND id = p_cuota_id
$$;

-- ──────────────────────────────────────────────────────────────
-- Fix 2: Trigger de integridad de mismo-curso en pagos
-- Impide registrar un pago cuyo alumno y cuota pertenezcan a cursos distintos.
-- Protege contra ataques de tesoreros de curso parcial (RLS no alcanza FKs cruzadas).
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _check_pago_mismo_curso()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  alumno_curso TEXT;
  cuota_curso  TEXT;
BEGIN
  -- Solo valida cuando ambos campos están presentes
  IF NEW.alumno_id IS NULL OR NEW.cuota_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- FOR SHARE en alumno (v8): serializa con UPDATE alumnos.curso_id concurrentes.
  -- FOR SHARE en cuota (v9): serializa con UPDATE cuotas.curso_id concurrentes.
  -- Ambos locks garantizan que si hay un cambio de curso pendiente en alumno
  -- o en cuota, esta sesión espera hasta que ese cambio confirme o revierta,
  -- y entonces re-lee el estado real antes de comparar.
  -- Orden fijo alumno → cuota previene deadlocks con otras rutas de bloqueo.
  SELECT curso_id INTO alumno_curso
  FROM alumnos WHERE cuenta_id = NEW.cuenta_id AND id = NEW.alumno_id
  FOR SHARE;

  SELECT curso_id INTO cuota_curso
  FROM cuotas WHERE cuenta_id = NEW.cuenta_id AND id = NEW.cuota_id
  FOR SHARE;

  IF alumno_curso IS DISTINCT FROM cuota_curso THEN
    RAISE EXCEPTION
      'Integridad de curso violada en pagos: alumno_id=% pertenece a curso=%, cuota_id=% pertenece a curso=%',
      NEW.alumno_id, alumno_curso, NEW.cuota_id, cuota_curso
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_pagos_mismo_curso
  BEFORE INSERT OR UPDATE ON pagos
  FOR EACH ROW EXECUTE FUNCTION _check_pago_mismo_curso();

-- Trigger equivalente para planes_pago (alumno y cuota deben ser del mismo curso)
CREATE TRIGGER trg_planes_mismo_curso
  BEFORE INSERT OR UPDATE ON planes_pago
  FOR EACH ROW EXECUTE FUNCTION _check_pago_mismo_curso();

-- Trigger equivalente para abonos (alumno y cuota deben ser del mismo curso)
CREATE TRIGGER trg_abonos_mismo_curso
  BEFORE INSERT OR UPDATE ON abonos
  FOR EACH ROW EXECUTE FUNCTION _check_pago_mismo_curso();

-- ──────────────────────────────────────────────────────────────
-- Fix 2 v7: Trigger de consistencia abono → plan
-- Si el abono tiene plan_id, su alumno_id y cuota_id deben coincidir
-- exactamente con los del plan. Impide abonos cruzados entre planes de
-- distintos cursos o de alumnos diferentes al titular del plan.
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _check_abono_plan_consistente()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  plan_alumno TEXT;
  plan_cuota  TEXT;
BEGIN
  -- Sin plan_id: abono directo, nada que verificar
  IF NEW.plan_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- FOR SHARE en plan (v9): si un UPDATE planes_pago.alumno_id está en curso
  -- sin COMMIT, esta sesión espera hasta que ese cambio confirme o revierta.
  -- Sin este lock, el INSERT abono leería el titular antiguo (READ COMMITTED)
  -- y ambas transacciones podrían confirmarse dejando abono.alumno ≠ plan.alumno.
  SELECT alumno_id, cuota_id
  INTO plan_alumno, plan_cuota
  FROM planes_pago
  WHERE cuenta_id = NEW.cuenta_id AND id = NEW.plan_id
  FOR SHARE;

  IF NOT FOUND THEN
    -- El plan no existe en esta cuenta: la FK lo capturará, pero damos mensaje claro
    RAISE EXCEPTION
      'Abono inválido: plan_id=% no existe en cuenta %',
      NEW.plan_id, NEW.cuenta_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF plan_alumno IS DISTINCT FROM NEW.alumno_id OR plan_cuota IS DISTINCT FROM NEW.cuota_id THEN
    RAISE EXCEPTION
      'Abono inconsistente con el plan: plan=% (alumno=%, cuota=%) '
      'pero el abono especifica alumno=%, cuota=%',
      NEW.plan_id, plan_alumno, plan_cuota, NEW.alumno_id, NEW.cuota_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_abonos_plan_consistente
  BEFORE INSERT OR UPDATE ON abonos
  FOR EACH ROW EXECUTE FUNCTION _check_abono_plan_consistente();

-- ──────────────────────────────────────────────────────────────
-- Fix 3 v7: Trigger de bloqueo de traslado de curso
-- Impide cambiar curso_id de un alumno que ya tiene pagos, planes o abonos
-- vinculados a cuotas del curso anterior.
-- Razón: un traslado silencioso haría inconsistentes los registros financieros;
-- el operador debe trasladar o anular esos registros primero.
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _check_alumno_cambio_curso()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n_pagos  INT;
  n_planes INT;
  n_abonos INT;
BEGIN
  -- Solo actúa cuando el curso cambia efectivamente
  IF NEW.curso_id IS NOT DISTINCT FROM OLD.curso_id THEN
    RETURN NEW;
  END IF;

  -- Pagos que vinculan este alumno con cuotas del curso anterior
  SELECT COUNT(*) INTO n_pagos
  FROM pagos p
  JOIN cuotas c ON c.cuenta_id = p.cuenta_id AND c.id = p.cuota_id
  WHERE p.cuenta_id = NEW.cuenta_id
    AND p.alumno_id = NEW.id
    AND c.curso_id  = OLD.curso_id;

  -- Planes de pago con la cuota del curso anterior
  SELECT COUNT(*) INTO n_planes
  FROM planes_pago pp
  JOIN cuotas c ON c.cuenta_id = pp.cuenta_id AND c.id = pp.cuota_id
  WHERE pp.cuenta_id = NEW.cuenta_id
    AND pp.alumno_id = NEW.id
    AND c.curso_id   = OLD.curso_id;

  -- Abonos directos (sin plan) con cuota del curso anterior
  SELECT COUNT(*) INTO n_abonos
  FROM abonos ab
  JOIN cuotas c ON c.cuenta_id = ab.cuenta_id AND c.id = ab.cuota_id
  WHERE ab.cuenta_id = NEW.cuenta_id
    AND ab.alumno_id = NEW.id
    AND ab.plan_id   IS NULL
    AND c.curso_id   = OLD.curso_id;

  IF n_pagos + n_planes + n_abonos > 0 THEN
    RAISE EXCEPTION
      'No se puede cambiar el curso del alumno % de "%" a "%": '
      'existen % pago(s), % plan(es) y % abono(s) vinculados a cuotas del curso anterior. '
      'Traslade o anule esos registros financieros antes de reasignar el alumno.',
      NEW.id, OLD.curso_id, NEW.curso_id, n_pagos, n_planes, n_abonos
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- Solo dispara cuando curso_id cambia (OF curso_id evita ejecución en updates inocuos)
CREATE TRIGGER trg_alumno_cambio_curso
  BEFORE UPDATE OF curso_id ON alumnos
  FOR EACH ROW EXECUTE FUNCTION _check_alumno_cambio_curso();

-- Trigger simétrico en cuotas: cambiar el curso de una cuota con pagos existentes
-- dejaría esos pagos con alumno/cuota de cursos distintos (rompiendo la invariante).
CREATE OR REPLACE FUNCTION _check_cuota_cambio_curso()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n_pagos  INT;
  n_planes INT;
  n_abonos INT;
BEGIN
  IF NEW.curso_id IS NOT DISTINCT FROM OLD.curso_id THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*) INTO n_pagos
  FROM pagos WHERE cuenta_id = NEW.cuenta_id AND cuota_id = NEW.id;

  SELECT COUNT(*) INTO n_planes
  FROM planes_pago WHERE cuenta_id = NEW.cuenta_id AND cuota_id = NEW.id;

  SELECT COUNT(*) INTO n_abonos
  FROM abonos WHERE cuenta_id = NEW.cuenta_id AND cuota_id = NEW.id AND plan_id IS NULL;

  IF n_pagos + n_planes + n_abonos > 0 THEN
    RAISE EXCEPTION
      'No se puede cambiar el curso de la cuota % de "%" a "%": '
      'existen % pago(s), % plan(es) y % abono(s) vinculados a ella. '
      'Traslade o anule esos registros antes de reasignar la cuota.',
      NEW.id, OLD.curso_id, NEW.curso_id, n_pagos, n_planes, n_abonos
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_cuota_cambio_curso
  BEFORE UPDATE OF curso_id ON cuotas
  FOR EACH ROW EXECUTE FUNCTION _check_cuota_cambio_curso();

-- ──────────────────────────────────────────────────────────────
-- Fix 2 v8: Trigger de protección del plan padre
-- Bloquea UPDATE de alumno_id o cuota_id en planes_pago cuando
-- ya existen abonos vinculados al plan. Protege la relación en
-- ambos sentidos: el trigger _check_abono_plan_consistente
-- protege al insertar el abono; este protege al editar el padre.
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _check_plan_cambio_titular()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n_abonos INT;
BEGIN
  -- Si alumno_id y cuota_id no cambian, no hay nada que validar
  IF NEW.alumno_id IS NOT DISTINCT FROM OLD.alumno_id
     AND NEW.cuota_id IS NOT DISTINCT FROM OLD.cuota_id
  THEN RETURN NEW; END IF;

  SELECT COUNT(*) INTO n_abonos
  FROM abonos
  WHERE cuenta_id = NEW.cuenta_id AND plan_id = NEW.id;

  IF n_abonos > 0 THEN
    RAISE EXCEPTION
      'No se puede cambiar el titular o cuota del plan % '
      '(alumno: % → %, cuota: % → %): existen % abono(s) vinculados. '
      'Anule los abonos antes de modificar el plan.',
      NEW.id, OLD.alumno_id, NEW.alumno_id, OLD.cuota_id, NEW.cuota_id,
      n_abonos
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_plan_cambio_titular
  BEFORE UPDATE OF alumno_id, cuota_id ON planes_pago
  FOR EACH ROW EXECUTE FUNCTION _check_plan_cambio_titular();