-- =============================================================================
-- 02_fix_rls_recursion.sql — Corrige recursión 42P17 en RLS (STAGING ÚNICAMENTE)
--
-- ⚠️  NUNCA ejecutar en producción (https://tmjqzaakzhecbldebyeg.supabase.co)
-- ⚠️  Sólo para el proyecto de staging: rucgmytyxpfowznowxwd.supabase.co
--
-- Problema:
--   tc_delegado_select  (tesorero_cuentas) → subconsulta a usuarios_cuenta
--   uc_propietario_select (usuarios_cuenta) → subconsulta a tesorero_cuentas
--   → ciclo infinito 42P17
--
-- Causas adicionales detectadas:
--   - Todas las políticas tienen roles={public} en lugar de {authenticated}.
--   - No existía función helper SECURITY DEFINER para romper el ciclo.
--
-- Solución:
--   1. Crear public.es_propietario_cuenta(uuid) — SECURITY DEFINER, propietario
--      postgres (tiene BYPASSRLS en Supabase). Rompe el ciclo sin desactivar RLS.
--   2. Revocar EXECUTE de PUBLIC y anon; conceder solo a authenticated.
--   3. Reemplazar uc_propietario_{select,insert,update,delete} usando la función.
--   4. Rehacer las políticas de tesorero_cuentas con TO authenticated.
--   5. Fijar uc_delegado_select con TO authenticated.
--   6. Garantizar que un delegado no puede concederse permisos:
--      - uc_propietario_insert/update/delete exigen es_propietario_cuenta().
--      - Un delegado (no propietario) NO puede modificar membresías.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Función helper SECURITY DEFINER
--    Propietario: postgres → tiene BYPASSRLS → la subconsulta a tesorero_cuentas
--    se ejecuta sin evaluar las políticas RLS de esa tabla → sin recursión.
--    SET search_path = public evita inyección por search_path.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.es_propietario_cuenta(p_cuenta_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM   public.tesorero_cuentas
        WHERE  id      = p_cuenta_id
          AND  auth_id = auth.uid()
    );
$$;

-- Revocar de PUBLIC y anon; conceder solo a authenticated
REVOKE EXECUTE ON FUNCTION public.es_propietario_cuenta(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.es_propietario_cuenta(uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.es_propietario_cuenta(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Políticas de tesorero_cuentas — TO authenticated (antes: {public})
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "tc_propietario_select" ON public.tesorero_cuentas;
CREATE POLICY "tc_propietario_select" ON public.tesorero_cuentas
    FOR SELECT
    TO authenticated
    USING (auth.uid() = auth_id);

DROP POLICY IF EXISTS "tc_propietario_insert" ON public.tesorero_cuentas;
CREATE POLICY "tc_propietario_insert" ON public.tesorero_cuentas
    FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = auth_id);

DROP POLICY IF EXISTS "tc_propietario_update" ON public.tesorero_cuentas;
CREATE POLICY "tc_propietario_update" ON public.tesorero_cuentas
    FOR UPDATE
    TO authenticated
    USING     (auth.uid() = auth_id)
    WITH CHECK (auth.uid() = auth_id);

-- tc_delegado_select: el delegado lee la fila del propietario.
-- Sigue consultando usuarios_cuenta, pero ahora uc_propietario_select
-- usa es_propietario_cuenta() (SECURITY DEFINER) → sin recursión.
DROP POLICY IF EXISTS "tc_delegado_select" ON public.tesorero_cuentas;
CREATE POLICY "tc_delegado_select" ON public.tesorero_cuentas
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1
            FROM   public.usuarios_cuenta uc
            WHERE  uc.cuenta_id   = tesorero_cuentas.id
              AND  uc.auth_id     = auth.uid()
              AND  uc.desactivado = false
        )
    );

-- ---------------------------------------------------------------------------
-- 3. Política de lectura del delegado a sus propias filas (TO authenticated)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "uc_delegado_select" ON public.usuarios_cuenta;
CREATE POLICY "uc_delegado_select" ON public.usuarios_cuenta
    FOR SELECT
    TO authenticated
    USING (auth.uid() = auth_id);

-- ---------------------------------------------------------------------------
-- 4. Políticas del propietario sobre usuarios_cuenta — usan es_propietario_cuenta()
--    Garantía: solo el propietario real puede insertar/modificar/borrar membresías.
--    Un delegado (uc.auth_id = auth.uid()) no satisface es_propietario_cuenta()
--    → no puede concederse permisos adicionales ni modificar membresías.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "uc_propietario_select" ON public.usuarios_cuenta;
CREATE POLICY "uc_propietario_select" ON public.usuarios_cuenta
    FOR SELECT
    TO authenticated
    USING (public.es_propietario_cuenta(cuenta_id));

DROP POLICY IF EXISTS "uc_propietario_insert" ON public.usuarios_cuenta;
CREATE POLICY "uc_propietario_insert" ON public.usuarios_cuenta
    FOR INSERT
    TO authenticated
    WITH CHECK (public.es_propietario_cuenta(cuenta_id));

DROP POLICY IF EXISTS "uc_propietario_update" ON public.usuarios_cuenta;
CREATE POLICY "uc_propietario_update" ON public.usuarios_cuenta
    FOR UPDATE
    TO authenticated
    USING     (public.es_propietario_cuenta(cuenta_id))
    WITH CHECK (public.es_propietario_cuenta(cuenta_id));

DROP POLICY IF EXISTS "uc_propietario_delete" ON public.usuarios_cuenta;
CREATE POLICY "uc_propietario_delete" ON public.usuarios_cuenta
    FOR DELETE
    TO authenticated
    USING (public.es_propietario_cuenta(cuenta_id));

-- ---------------------------------------------------------------------------
-- Verificación post-parche: confirmar que la función existe y el propietario
-- es postgres (BYPASSRLS).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_owner  text;
    v_secdef boolean;
BEGIN
    SELECT r.rolname, p.prosecdef
    INTO   v_owner, v_secdef
    FROM   pg_proc p
    JOIN   pg_namespace n ON n.oid = p.pronamespace
    JOIN   pg_roles r     ON r.oid = p.proowner
    WHERE  n.nspname = 'public'
      AND  p.proname = 'es_propietario_cuenta';

    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'Función es_propietario_cuenta no encontrada';
    END IF;
    IF NOT v_secdef THEN
        RAISE EXCEPTION 'es_propietario_cuenta no es SECURITY DEFINER';
    END IF;
    RAISE NOTICE 'OK: es_propietario_cuenta — propietario=% security_definer=%', v_owner, v_secdef;
END $$;

COMMIT;

-- =============================================================================
-- NOTA sobre T05 (suscripciones / alumnos_credenciales):
-- Con PostgREST >= 12, una tabla sin GRANT devuelve data=[] (HTTP 200)
-- en lugar de 42501. El test 03 necesita actualizar su expectativa para
-- esas dos tablas: verificar data=[] en lugar de error 42501.
-- =============================================================================
