-- =============================================================================
-- 01_ddl_staging.sql — Esquema v9 + RLS para El Tesorero (STAGING ÚNICAMENTE)
--
-- ⚠️  NUNCA ejecutar en producción (https://tmjqzaakzhecbldebyeg.supabase.co)
-- ⚠️  Sólo para el proyecto de staging: rucgmytyxpfowznowxwd.supabase.co
--
-- Ejecutar en: SQL Editor del proyecto de staging
-- Orden: este archivo primero, luego 08_seed_staging.sql
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. Extensiones
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------------------
-- 1. tesorero_cuentas
--    Propietarios de cuenta (un registro por tesorero/administrador).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tesorero_cuentas (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_id     UUID        NOT NULL UNIQUE,   -- auth.uid() del propietario
    email       TEXT        NOT NULL,
    nombre      TEXT,
    plan        TEXT        NOT NULL DEFAULT 'free',
    activo      BOOLEAN     NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 2. usuarios_cuenta
--    Delegados invitados a operar en la cuenta de un propietario.
--    Esquema real v9: auth_id (no user_auth_id), desactivado (no activo).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.usuarios_cuenta (
    id          TEXT        PRIMARY KEY,       -- 'uc-c-staging' o gen_random_uuid()::text
    cuenta_id   UUID        NOT NULL REFERENCES public.tesorero_cuentas(id) ON DELETE CASCADE,
    auth_id     UUID        NOT NULL,          -- auth.uid() del delegado
    email       TEXT        NOT NULL,          -- obligatorio en esquema v9
    rol         TEXT        NOT NULL DEFAULT 'visor'
                            CHECK (rol IN ('visor','editor','tesorero')),
    curso_id    TEXT,                          -- nullable: null = acceso a todos los cursos
    desactivado BOOLEAN     NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usuarios_cuenta_auth_id
    ON public.usuarios_cuenta (auth_id);
CREATE INDEX IF NOT EXISTS idx_usuarios_cuenta_cuenta_id
    ON public.usuarios_cuenta (cuenta_id);

-- ---------------------------------------------------------------------------
-- 3. colegios
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.colegios (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    cuenta_id   UUID        NOT NULL REFERENCES public.tesorero_cuentas(id) ON DELETE CASCADE,
    nombre      TEXT        NOT NULL,
    comuna      TEXT,
    region      TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 4. cursos
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cursos (
    id          TEXT        PRIMARY KEY,
    cuenta_id   UUID        NOT NULL REFERENCES public.tesorero_cuentas(id) ON DELETE CASCADE,
    nombre      TEXT        NOT NULL,
    activo      BOOLEAN     NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 5. alumnos
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.alumnos (
    id          TEXT        PRIMARY KEY,
    cuenta_id   UUID        NOT NULL REFERENCES public.tesorero_cuentas(id) ON DELETE CASCADE,
    nombres     TEXT        NOT NULL,
    apellidos   TEXT        NOT NULL,
    curso_id    TEXT        REFERENCES public.cursos(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 6. apoderados
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.apoderados (
    id          TEXT        PRIMARY KEY,
    cuenta_id   UUID        NOT NULL REFERENCES public.tesorero_cuentas(id) ON DELETE CASCADE,
    alumno_id   TEXT        REFERENCES public.alumnos(id),
    nombres     TEXT        NOT NULL,
    apellidos   TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 7. cuotas
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cuotas (
    id          TEXT        PRIMARY KEY,
    cuenta_id   UUID        NOT NULL REFERENCES public.tesorero_cuentas(id) ON DELETE CASCADE,
    curso_id    TEXT        REFERENCES public.cursos(id),
    nombre      TEXT        NOT NULL,
    monto       INTEGER     NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 8. planes_pago
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.planes_pago (
    id          TEXT        PRIMARY KEY,
    cuenta_id   UUID        NOT NULL REFERENCES public.tesorero_cuentas(id) ON DELETE CASCADE,
    alumno_id   TEXT        REFERENCES public.alumnos(id),
    nombre      TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 9. pagos
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pagos (
    id          TEXT        PRIMARY KEY,
    cuenta_id   UUID        NOT NULL REFERENCES public.tesorero_cuentas(id) ON DELETE CASCADE,
    alumno_id   TEXT        REFERENCES public.alumnos(id),
    cuota_id    TEXT        REFERENCES public.cuotas(id),
    monto       INTEGER     NOT NULL DEFAULT 0,
    fecha       DATE        NOT NULL,
    medio       TEXT,
    estado      TEXT        NOT NULL DEFAULT 'pagado',
    periodo     TEXT,
    obs         TEXT,
    creado_por  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 10. abonos
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.abonos (
    id          TEXT        PRIMARY KEY,
    cuenta_id   UUID        NOT NULL REFERENCES public.tesorero_cuentas(id) ON DELETE CASCADE,
    plan_id     TEXT        REFERENCES public.planes_pago(id),
    alumno_id   TEXT        REFERENCES public.alumnos(id),
    cuota_id    TEXT        REFERENCES public.cuotas(id),
    monto       INTEGER     NOT NULL DEFAULT 0,
    fecha       DATE        NOT NULL,
    estado      TEXT        NOT NULL DEFAULT 'registrado',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 11. suscripciones  (sin grant a authenticated — debe devolver 42501 en tests)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.suscripciones (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    cuenta_id   UUID        NOT NULL REFERENCES public.tesorero_cuentas(id) ON DELETE CASCADE,
    plan        TEXT,
    vigente_hasta DATE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 12. alumnos_credenciales  (sin grant a authenticated — debe devolver 42501)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.alumnos_credenciales (
    alumno_id   TEXT        PRIMARY KEY REFERENCES public.alumnos(id) ON DELETE CASCADE,
    pin_hash    TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- GRANTS — sólo las tablas que la app opera (rol authenticated)
-- suscripciones y alumnos_credenciales quedan SIN grant (test t05 verifica esto)
-- =============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tesorero_cuentas    TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.usuarios_cuenta      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.colegios             TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cursos               TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.alumnos              TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.apoderados           TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cuotas               TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.planes_pago          TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pagos                TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.abonos               TO authenticated;
-- suscripciones: sin grant (deliberado)
-- alumnos_credenciales: sin grant (deliberado)

-- =============================================================================
-- RLS — habilitar y crear políticas
-- =============================================================================

-- tesorero_cuentas ────────────────────────────────────────────────────────────
ALTER TABLE public.tesorero_cuentas ENABLE ROW LEVEL SECURITY;

-- Propietario ve y edita su propia fila
CREATE POLICY "tc_propietario_select" ON public.tesorero_cuentas
    FOR SELECT USING (auth.uid() = auth_id);

CREATE POLICY "tc_propietario_insert" ON public.tesorero_cuentas
    FOR INSERT WITH CHECK (auth.uid() = auth_id);

CREATE POLICY "tc_propietario_update" ON public.tesorero_cuentas
    FOR UPDATE USING (auth.uid() = auth_id) WITH CHECK (auth.uid() = auth_id);

-- Delegado puede leer la fila del propietario (para obtener nombre/email de la cuenta)
CREATE POLICY "tc_delegado_select" ON public.tesorero_cuentas
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.usuarios_cuenta uc
            WHERE uc.cuenta_id = tesorero_cuentas.id
              AND uc.auth_id   = auth.uid()
              AND uc.desactivado = false
        )
    );

-- usuarios_cuenta ─────────────────────────────────────────────────────────────
ALTER TABLE public.usuarios_cuenta ENABLE ROW LEVEL SECURITY;

-- Cada delegado ve sólo sus propias filas
CREATE POLICY "uc_delegado_select" ON public.usuarios_cuenta
    FOR SELECT USING (auth.uid() = auth_id);

-- El propietario ve todas las membresías de su cuenta
CREATE POLICY "uc_propietario_select" ON public.usuarios_cuenta
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.tesorero_cuentas tc
            WHERE tc.id      = usuarios_cuenta.cuenta_id
              AND tc.auth_id = auth.uid()
        )
    );

-- Propietario puede insertar / actualizar / borrar membresías de su cuenta
CREATE POLICY "uc_propietario_insert" ON public.usuarios_cuenta
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.tesorero_cuentas tc
            WHERE tc.id      = usuarios_cuenta.cuenta_id
              AND tc.auth_id = auth.uid()
        )
    );

CREATE POLICY "uc_propietario_update" ON public.usuarios_cuenta
    FOR UPDATE
    USING (EXISTS (SELECT 1 FROM public.tesorero_cuentas tc
                   WHERE tc.id = usuarios_cuenta.cuenta_id AND tc.auth_id = auth.uid()))
    WITH CHECK (EXISTS (SELECT 1 FROM public.tesorero_cuentas tc
                        WHERE tc.id = usuarios_cuenta.cuenta_id AND tc.auth_id = auth.uid()));

CREATE POLICY "uc_propietario_delete" ON public.usuarios_cuenta
    FOR DELETE USING (
        EXISTS (
            SELECT 1 FROM public.tesorero_cuentas tc
            WHERE tc.id      = usuarios_cuenta.cuenta_id
              AND tc.auth_id = auth.uid()
        )
    );

-- Macro: política genérica para tablas operativas (cursos, alumnos, cuotas, pagos, abonos, …)
-- La app filtra siempre por cuenta_id; RLS verifica que ese cuenta_id pertenece al JWT.
-- Se aplica a: colegios, cursos, alumnos, apoderados, cuotas, planes_pago, pagos, abonos

-- colegios ────────────────────────────────────────────────────────────────────
ALTER TABLE public.colegios ENABLE ROW LEVEL SECURITY;
CREATE POLICY "colegios_propietario" ON public.colegios
    USING (EXISTS (SELECT 1 FROM public.tesorero_cuentas tc
                   WHERE tc.id = colegios.cuenta_id AND tc.auth_id = auth.uid()))
    WITH CHECK (EXISTS (SELECT 1 FROM public.tesorero_cuentas tc
                        WHERE tc.id = colegios.cuenta_id AND tc.auth_id = auth.uid()));

-- cursos ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.cursos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cursos_propietario_o_delegado" ON public.cursos
    USING (
        -- propietario directo
        EXISTS (SELECT 1 FROM public.tesorero_cuentas tc
                WHERE tc.id = cursos.cuenta_id AND tc.auth_id = auth.uid())
        OR
        -- delegado con acceso a la cuenta
        EXISTS (SELECT 1 FROM public.usuarios_cuenta uc
                WHERE uc.cuenta_id   = cursos.cuenta_id
                  AND uc.auth_id     = auth.uid()
                  AND uc.desactivado = false
                  AND (uc.curso_id IS NULL OR uc.curso_id = cursos.id))
    )
    WITH CHECK (
        EXISTS (SELECT 1 FROM public.tesorero_cuentas tc
                WHERE tc.id = cursos.cuenta_id AND tc.auth_id = auth.uid())
    );

-- alumnos ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.alumnos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "alumnos_propietario_o_delegado" ON public.alumnos
    USING (
        EXISTS (SELECT 1 FROM public.tesorero_cuentas tc
                WHERE tc.id = alumnos.cuenta_id AND tc.auth_id = auth.uid())
        OR
        EXISTS (SELECT 1 FROM public.usuarios_cuenta uc
                WHERE uc.cuenta_id   = alumnos.cuenta_id
                  AND uc.auth_id     = auth.uid()
                  AND uc.desactivado = false)
    )
    WITH CHECK (
        EXISTS (SELECT 1 FROM public.tesorero_cuentas tc
                WHERE tc.id = alumnos.cuenta_id AND tc.auth_id = auth.uid())
    );

-- apoderados ──────────────────────────────────────────────────────────────────
ALTER TABLE public.apoderados ENABLE ROW LEVEL SECURITY;
CREATE POLICY "apoderados_propietario" ON public.apoderados
    USING (EXISTS (SELECT 1 FROM public.tesorero_cuentas tc
                   WHERE tc.id = apoderados.cuenta_id AND tc.auth_id = auth.uid()))
    WITH CHECK (EXISTS (SELECT 1 FROM public.tesorero_cuentas tc
                        WHERE tc.id = apoderados.cuenta_id AND tc.auth_id = auth.uid()));

-- cuotas ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.cuotas ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cuotas_propietario_o_delegado" ON public.cuotas
    USING (
        EXISTS (SELECT 1 FROM public.tesorero_cuentas tc
                WHERE tc.id = cuotas.cuenta_id AND tc.auth_id = auth.uid())
        OR
        EXISTS (SELECT 1 FROM public.usuarios_cuenta uc
                WHERE uc.cuenta_id   = cuotas.cuenta_id
                  AND uc.auth_id     = auth.uid()
                  AND uc.desactivado = false)
    )
    WITH CHECK (
        EXISTS (SELECT 1 FROM public.tesorero_cuentas tc
                WHERE tc.id = cuotas.cuenta_id AND tc.auth_id = auth.uid())
    );

-- planes_pago ─────────────────────────────────────────────────────────────────
ALTER TABLE public.planes_pago ENABLE ROW LEVEL SECURITY;
CREATE POLICY "planes_propietario" ON public.planes_pago
    USING (EXISTS (SELECT 1 FROM public.tesorero_cuentas tc
                   WHERE tc.id = planes_pago.cuenta_id AND tc.auth_id = auth.uid()))
    WITH CHECK (EXISTS (SELECT 1 FROM public.tesorero_cuentas tc
                        WHERE tc.id = planes_pago.cuenta_id AND tc.auth_id = auth.uid()));

-- pagos ───────────────────────────────────────────────────────────────────────
ALTER TABLE public.pagos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pagos_propietario_o_delegado" ON public.pagos
    USING (
        EXISTS (SELECT 1 FROM public.tesorero_cuentas tc
                WHERE tc.id = pagos.cuenta_id AND tc.auth_id = auth.uid())
        OR
        EXISTS (SELECT 1 FROM public.usuarios_cuenta uc
                WHERE uc.cuenta_id   = pagos.cuenta_id
                  AND uc.auth_id     = auth.uid()
                  AND uc.desactivado = false)
    )
    WITH CHECK (
        EXISTS (SELECT 1 FROM public.tesorero_cuentas tc
                WHERE tc.id = pagos.cuenta_id AND tc.auth_id = auth.uid())
        OR
        EXISTS (SELECT 1 FROM public.usuarios_cuenta uc
                WHERE uc.cuenta_id   = pagos.cuenta_id
                  AND uc.auth_id     = auth.uid()
                  AND uc.desactivado = false
                  AND uc.rol IN ('editor','tesorero'))
    );

-- abonos ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.abonos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "abonos_propietario_o_delegado" ON public.abonos
    USING (
        EXISTS (SELECT 1 FROM public.tesorero_cuentas tc
                WHERE tc.id = abonos.cuenta_id AND tc.auth_id = auth.uid())
        OR
        EXISTS (SELECT 1 FROM public.usuarios_cuenta uc
                WHERE uc.cuenta_id   = abonos.cuenta_id
                  AND uc.auth_id     = auth.uid()
                  AND uc.desactivado = false)
    )
    WITH CHECK (
        EXISTS (SELECT 1 FROM public.tesorero_cuentas tc
                WHERE tc.id = abonos.cuenta_id AND tc.auth_id = auth.uid())
    );

-- suscripciones — RLS habilitado, sin política = nadie accede salvo service_role
ALTER TABLE public.suscripciones ENABLE ROW LEVEL SECURITY;

-- alumnos_credenciales — igual
ALTER TABLE public.alumnos_credenciales ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- FIN DE 01_ddl_staging.sql
-- Ejecutar a continuación: 08_seed_staging.sql  (sustituyendo los UUID reales)
-- =============================================================================
