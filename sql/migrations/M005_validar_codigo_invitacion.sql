-- ============================================================
-- M005: RPC validar_codigo_invitacion — acceso anon para registro
--
-- PROBLEMA:
--   doRegistro() llama a sbGet('codigos_invitacion', 'codigo=eq.X')
--   usando la clave anon.  La tabla codigos_invitacion tiene RLS que
--   restringe SELECT a es_dueno(cuenta_id), por lo que un usuario no
--   autenticado siempre recibe [] → código válido rechazado como inválido.
--
-- SOLUCIÓN:
--   RPC con SECURITY DEFINER que verifica el código con permisos del
--   propietario de la tabla y devuelve solo {valido, tipo, vence_el}
--   sin exponer otros códigos de otras cuentas.
--
-- SEGURIDAD:
--   - Solo devuelve si el código existe, está activo, no usado y no vencido.
--   - No expone cuenta_id, creado_en ni ningún otro dato del código.
--   - No permite enumerar códigos: requiere el código exacto.
--   - GRANT solo a anon (mínimo necesario para el flujo de registro).
-- ============================================================

CREATE OR REPLACE FUNCTION validar_codigo_invitacion(p_codigo TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tipo    TEXT;
  v_vence   DATE;
BEGIN
  -- Buscar código activo, no usado y no vencido
  SELECT tipo, vence_el
    INTO v_tipo, v_vence
    FROM codigos_invitacion
   WHERE codigo  = p_codigo
     AND activo  = TRUE
     AND usado   = FALSE
     AND (vence_el IS NULL OR vence_el >= CURRENT_DATE)
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('valido', FALSE);
  END IF;

  RETURN jsonb_build_object(
    'valido',   TRUE,
    'tipo',     COALESCE(v_tipo, 'prueba'),
    'vence_el', v_vence
  );
END;
$$;

-- Revocar acceso por defecto y conceder solo a anon
REVOKE EXECUTE ON FUNCTION validar_codigo_invitacion(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION validar_codigo_invitacion(TEXT) TO anon;
