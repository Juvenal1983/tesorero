-- =============================================================================
-- ⚠️  OBSOLETO — NO USAR
-- Este archivo usa ON CONFLICT (id) con claves simples y no tiene aserciones
-- de identidad ni de relaciones. Corresponde al seed del esquema simplificado
-- (tests/sql/01_ddl_staging.sql), no al esquema v9 validado.
--
-- Archivo correcto (usar en lugar de este):
--   sql/08_seed_staging.sql  — seed v3 con claves compuestas (cuenta_id, id),
--                              validación de UUIDs en auth.users,
--                              aserciones de recuento, identidad y relaciones.
--
-- Fixture adicional para Usuario C:
--   sql/09_fixture_usuario_c.sql
--
-- Procedimiento de instalación: ver docs/INSTALL_STAGING.md
-- =============================================================================
-- CONTENIDO ORIGINAL CONSERVADO SOLO COMO REFERENCIA HISTÓRICA
-- =============================================================================
-- 08_seed_staging.sql — Datos ficticios para tests (STAGING ÚNICAMENTE)
--
-- ⚠️  NUNCA ejecutar en producción (https://tmjqzaakzhecbldebyeg.supabase.co)
-- ⚠️  Todos los datos son ficticios. No usar emails ni contraseñas reales.
--
-- ANTES DE EJECUTAR — sustituye los tres UUID marcados con «REEMPLAZAR»:
--   USER_A_UUID  → auth.uid() de Usuario A  (propietario Cuenta A)
--   USER_B_UUID  → auth.uid() de Usuario B  (propietario Cuenta B)
--   USER_C_UUID  → auth.uid() de Usuario C  (delegado en Cuenta A)
--
-- Cómo obtener los UUID:
--   Supabase dashboard → Authentication → Users → copia el UUID de cada usuario.
--
-- Ejecutar: SQL Editor del proyecto staging, DESPUÉS de 01_ddl_staging.sql
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PASO 0 — Define los UUID aquí para no repetirlos
-- ---------------------------------------------------------------------------
DO $$ BEGIN
    IF current_setting('staging.user_a_uuid', true) IS NULL
    OR current_setting('staging.user_a_uuid', true) = '' THEN
        RAISE EXCEPTION
            'Define los UUID antes de ejecutar: reemplaza los literales USER_A_UUID, USER_B_UUID, USER_C_UUID en este script.';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- PASO 1 — Cuentas de propietarios
-- IDs fijos para que los tests usen constantes predecibles.
-- ---------------------------------------------------------------------------

-- Cuenta A — propietario: Usuario A
INSERT INTO public.tesorero_cuentas (id, auth_id, email, nombre, plan, activo)
VALUES (
    '00000000-0000-0000-aaaa-000000000001',  -- CUENTA_A (fijo en test 03)
    'USER_A_UUID',                            -- ← REEMPLAZAR con UUID de Usuario A
    'usuario_a@staging.test',
    'Tesorero A (staging)',
    'anual',
    true
)
ON CONFLICT (id) DO UPDATE
    SET auth_id = EXCLUDED.auth_id,
        email   = EXCLUDED.email;

-- Cuenta B — propietario: Usuario B
INSERT INTO public.tesorero_cuentas (id, auth_id, email, nombre, plan, activo)
VALUES (
    '00000000-0000-0000-bbbb-000000000002',  -- CUENTA_B (fijo en test 03)
    'USER_B_UUID',                            -- ← REEMPLAZAR con UUID de Usuario B
    'usuario_b@staging.test',
    'Tesorero B (staging)',
    'free',
    true
)
ON CONFLICT (id) DO UPDATE
    SET auth_id = EXCLUDED.auth_id,
        email   = EXCLUDED.email;

-- ---------------------------------------------------------------------------
-- PASO 2 — Membresías / delegados
-- ---------------------------------------------------------------------------

-- Usuario A como delegado (rol=tesorero) en Cuenta B
-- → permite que test 03 verifique que A puede leer cursos de Cuenta B
INSERT INTO public.usuarios_cuenta
    (id, cuenta_id, auth_id, email, rol, curso_id, desactivado)
VALUES (
    'uc-a-en-b',
    '00000000-0000-0000-bbbb-000000000002',
    'USER_A_UUID',                            -- ← REEMPLAZAR con UUID de Usuario A
    'usuario_a@staging.test',
    'tesorero',
    NULL,
    false
)
ON CONFLICT (id) DO UPDATE
    SET auth_id     = EXCLUDED.auth_id,
        email       = EXCLUDED.email,
        rol         = EXCLUDED.rol,
        desactivado = EXCLUDED.desactivado;

-- Usuario C como delegado (rol=visor) en Cuenta A
-- → usado por test 06 (acceso delegado)
INSERT INTO public.usuarios_cuenta
    (id, cuenta_id, auth_id, email, rol, curso_id, desactivado)
VALUES (
    'uc-c-staging',
    '00000000-0000-0000-aaaa-000000000001',
    'USER_C_UUID',                            -- ← REEMPLAZAR con UUID de Usuario C
    'usuario_c@staging.test',
    'visor',
    NULL,
    false
)
ON CONFLICT (id) DO UPDATE
    SET auth_id     = EXCLUDED.auth_id,
        email       = EXCLUDED.email,
        rol         = EXCLUDED.rol,
        desactivado = EXCLUDED.desactivado;

-- ---------------------------------------------------------------------------
-- PASO 3 — Cursos
-- ---------------------------------------------------------------------------
INSERT INTO public.cursos (id, cuenta_id, nombre, activo)
VALUES
    ('curso-a-01', '00000000-0000-0000-aaaa-000000000001', '3° Básico A (staging)', true),
    ('curso-a-02', '00000000-0000-0000-aaaa-000000000001', '4° Básico B (staging)', true),
    ('curso-b-01', '00000000-0000-0000-bbbb-000000000002', 'Pre-Kinder B (staging)', true)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PASO 4 — Alumnos
-- ---------------------------------------------------------------------------
INSERT INTO public.alumnos (id, cuenta_id, nombres, apellidos, curso_id)
VALUES
    ('alu-a-01', '00000000-0000-0000-aaaa-000000000001', 'Ana',    'Staging',  'curso-a-01'),
    ('alu-a-02', '00000000-0000-0000-aaaa-000000000001', 'Bruno',  'Staging',  'curso-a-01'),
    ('alu-b-01', '00000000-0000-0000-bbbb-000000000002', 'Carlos', 'StagingB', 'curso-b-01')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PASO 5 — Cuotas
-- ---------------------------------------------------------------------------
INSERT INTO public.cuotas (id, cuenta_id, curso_id, nombre, monto)
VALUES
    ('cuota-a-01', '00000000-0000-0000-aaaa-000000000001', 'curso-a-01', 'Cuota marzo 2025',   5000),
    ('cuota-a-02', '00000000-0000-0000-aaaa-000000000001', 'curso-a-01', 'Cuota abril 2025',   5000),
    ('cuota-b-01', '00000000-0000-0000-bbbb-000000000002', 'curso-b-01', 'Cuota marzo 2025 B', 4000)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PASO 6 — Planes de pago
-- ---------------------------------------------------------------------------
INSERT INTO public.planes_pago (id, cuenta_id, alumno_id, nombre)
VALUES
    ('plan-a-01', '00000000-0000-0000-aaaa-000000000001', 'alu-a-01', 'Plan cuotas Ana (staging)'),
    ('plan-a-02', '00000000-0000-0000-aaaa-000000000001', 'alu-a-02', 'Plan cuotas Bruno (staging)')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PASO 7 — Pagos (control positivo: A tiene pagos propios)
-- ---------------------------------------------------------------------------
INSERT INTO public.pagos (id, cuenta_id, alumno_id, cuota_id, monto, fecha, medio, estado)
VALUES
    ('pago-a-01', '00000000-0000-0000-aaaa-000000000001', 'alu-a-01', 'cuota-a-01', 5000, '2025-03-10', 'efectivo',     'pagado'),
    ('pago-a-02', '00000000-0000-0000-aaaa-000000000001', 'alu-a-02', 'cuota-a-01', 5000, '2025-03-11', 'transferencia','pagado'),
    ('pago-b-01', '00000000-0000-0000-bbbb-000000000002', 'alu-b-01', 'cuota-b-01', 4000, '2025-03-12', 'efectivo',     'pagado')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PASO 8 — Abonos (para test t07 de abonos)
-- ---------------------------------------------------------------------------
INSERT INTO public.abonos (id, cuenta_id, plan_id, alumno_id, cuota_id, monto, fecha, estado)
VALUES
    ('abono-a-01', '00000000-0000-0000-aaaa-000000000001', 'plan-a-01', 'alu-a-01', 'cuota-a-02', 2500, '2025-04-01', 'registrado'),
    ('abono-a-02', '00000000-0000-0000-aaaa-000000000001', 'plan-a-02', 'alu-a-02', 'cuota-a-02', 5000, '2025-04-02', 'registrado')
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- VERIFICACIÓN RÁPIDA — ejecuta esto después del seed para confirmar:
-- =============================================================================
/*
SELECT 'tesorero_cuentas' AS tabla, count(*) FROM public.tesorero_cuentas
UNION ALL
SELECT 'usuarios_cuenta',  count(*) FROM public.usuarios_cuenta
UNION ALL
SELECT 'cursos',           count(*) FROM public.cursos
UNION ALL
SELECT 'alumnos',          count(*) FROM public.alumnos
UNION ALL
SELECT 'cuotas',           count(*) FROM public.cuotas
UNION ALL
SELECT 'planes_pago',      count(*) FROM public.planes_pago
UNION ALL
SELECT 'pagos',            count(*) FROM public.pagos
UNION ALL
SELECT 'abonos',           count(*) FROM public.abonos;
-- Resultado esperado: 2, 2, 3, 3, 3, 2, 3, 2
*/

-- =============================================================================
-- FIN DE 08_seed_staging.sql
-- Siguiente paso: crear los usuarios ficticios en Authentication y ejecutar tests.
-- =============================================================================
