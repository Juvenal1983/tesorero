-- ============================================================
-- E5: RPC tesorero_set_pin — hash bcrypt de PIN en servidor
-- Ejecutar SOLO en staging después de revisión.
-- NO ejecutar en producción (tmjqzaakzhecbldebyeg).
-- ============================================================

-- pgcrypto ya debe estar habilitado; esta línea es idempotente.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------
-- Función principal: tesorero_set_pin
-- ------------------------------------------------------------
-- Propósito: permite al tesorero autenticado cambiar el PIN de
-- un alumno. Verifica ownership, valida longitud mínima,
-- hashea con bcrypt (factor de costo 10) y hace upsert en
-- alumnos_credenciales. Nunca expone el hash al cliente.
--
-- Restricciones de seguridad:
--   · SECURITY DEFINER → se ejecuta con permisos del owner
--     (postgres / service role) para escribir en
--     alumnos_credenciales aunque el caller sea 'authenticated'.
--   · SET search_path garantiza que pgcrypto.crypt() resuelva
--     correctamente en extensiones instaladas en el schema
--     "extensions" (Supabase) o "public".
--   · Solo 'authenticated' puede llamar la función; 'anon' no.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tesorero_set_pin(
  p_cuenta_id  UUID,
  p_alumno_id  TEXT,
  p_pin        TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_hash TEXT;
BEGIN
  -- 1. Verificar que el caller es dueño de la cuenta
  IF NOT es_dueno(p_cuenta_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  -- 2. Verificar que el alumno pertenece a la cuenta
  IF NOT EXISTS (
    SELECT 1 FROM public.alumnos
    WHERE cuenta_id = p_cuenta_id AND id = p_alumno_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'alumno_not_found');
  END IF;

  -- 3. Validar longitud mínima del PIN
  IF length(trim(p_pin)) < 4 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'pin_muy_corto');
  END IF;

  -- 4. Hashear con bcrypt (costo 10)
  v_hash := crypt(trim(p_pin), gen_salt('bf', 10));

  -- 5. Upsert en alumnos_credenciales
  INSERT INTO public.alumnos_credenciales
    (cuenta_id, alumno_id, pin_hash, actualizado_en)
  VALUES
    (p_cuenta_id, p_alumno_id, v_hash, now())
  ON CONFLICT (alumno_id)
    DO UPDATE SET
      pin_hash       = EXCLUDED.pin_hash,
      actualizado_en = EXCLUDED.actualizado_en;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- Revocar acceso público y conceder solo a usuarios autenticados
REVOKE ALL ON FUNCTION public.tesorero_set_pin(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tesorero_set_pin(UUID, TEXT, TEXT) TO authenticated;

-- Verificación rápida (ejecutar después del deploy):
-- SELECT public.tesorero_set_pin(
--   '<tu_cuenta_id_de_staging>',
--   '<alumno_id_de_prueba>',
--   'TEST1234'
-- );
-- Resultado esperado: {"ok": true}
