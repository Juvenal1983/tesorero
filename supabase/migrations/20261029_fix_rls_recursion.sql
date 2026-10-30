-- =============================================================================
-- Migración: fix_rls_recursion
-- Fecha: 2026-10-29
-- Rama: gran-cambio-v9-relacional
--
-- Problema resuelto:
--   Error 42P17 (infinite recursion detected in policy for relation) causado
--   por el ciclo RLS entre tesorero_cuentas y usuarios_cuenta.
--   Además, todas las políticas tenían roles={public} en lugar de {authenticated}.
--
-- Solución:
--   1. Función SECURITY DEFINER public.es_propietario_cuenta(uuid)
--      → propietario postgres (BYPASSRLS) → sin recursión.
--   2. Todas las políticas de tesorero_cuentas y usuarios_cuenta rehechas
--      con TO authenticated.
--   3. Delegado no puede concederse permisos: uc_propietario_* exigen
--      es_propietario_cuenta(), que un delegado no satisface.
--
-- ⚠️  NUNCA ejecutar en producción (https://tmjqzaakzhecbldebyeg.supabase.co)
--     hasta aprobación expresa.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Función helper SECURITY DEFINER
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

REVOKE EXECUTE ON FUNCTION public.es_propietario_cuenta(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.es_propietario_cuenta(uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.es_propietario_cuenta(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Políticas de tesorero_cuentas
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "tc_propietario_select" ON public.tesorero_cuentas;
CREATE POLICY "tc_propietario_select" ON public.tesorero_cuentas
    FOR SELECT TO authenticated USING (auth.uid() = auth_id);

DROP POLICY IF EXISTS "tc_propietario_insert" ON public.tesorero_cuentas;
CREATE POLICY "tc_propietario_insert" ON public.tesorero_cuentas
    FOR INSERT TO authenticated WITH CHECK (auth.uid() = auth_id);

DROP POLICY IF EXISTS "tc_propietario_update" ON public.tesorero_cuentas;
CREATE POLICY "tc_propietario_update" ON public.tesorero_cuentas
    FOR UPDATE TO authenticated
    USING (auth.uid() = auth_id) WITH CHECK (auth.uid() = auth_id);

DROP POLICY IF EXISTS "tc_delegado_select" ON public.tesorero_cuentas;
CREATE POLICY "tc_delegado_select" ON public.tesorero_cuentas
    FOR SELECT TO authenticated USING (
        EXISTS (
            SELECT 1 FROM public.usuarios_cuenta uc
            WHERE uc.cuenta_id   = tesorero_cuentas.id
              AND uc.auth_id     = auth.uid()
              AND uc.desactivado = false
        )
    );

-- ---------------------------------------------------------------------------
-- 3. Políticas de usuarios_cuenta
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "uc_delegado_select" ON public.usuarios_cuenta;
CREATE POLICY "uc_delegado_select" ON public.usuarios_cuenta
    FOR SELECT TO authenticated USING (auth.uid() = auth_id);

DROP POLICY IF EXISTS "uc_propietario_select" ON public.usuarios_cuenta;
CREATE POLICY "uc_propietario_select" ON public.usuarios_cuenta
    FOR SELECT TO authenticated
    USING (public.es_propietario_cuenta(cuenta_id));

DROP POLICY IF EXISTS "uc_propietario_insert" ON public.usuarios_cuenta;
CREATE POLICY "uc_propietario_insert" ON public.usuarios_cuenta
    FOR INSERT TO authenticated
    WITH CHECK (public.es_propietario_cuenta(cuenta_id));

DROP POLICY IF EXISTS "uc_propietario_update" ON public.usuarios_cuenta;
CREATE POLICY "uc_propietario_update" ON public.usuarios_cuenta
    FOR UPDATE TO authenticated
    USING     (public.es_propietario_cuenta(cuenta_id))
    WITH CHECK (public.es_propietario_cuenta(cuenta_id));

DROP POLICY IF EXISTS "uc_propietario_delete" ON public.usuarios_cuenta;
CREATE POLICY "uc_propietario_delete" ON public.usuarios_cuenta
    FOR DELETE TO authenticated
    USING (public.es_propietario_cuenta(cuenta_id));

-- ---------------------------------------------------------------------------
-- Verificación post-migración
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
