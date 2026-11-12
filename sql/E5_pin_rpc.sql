-- ============================================================
-- E5: RPC tesorero_set_pin — hash bcrypt de PIN en servidor
-- Ejecutar SOLO en staging después de revisión.
-- NO ejecutar en producción (tmjqzaakzhecbldebyeg).
-- ============================================================
--
-- Schema real de alumnos_credenciales (sql/01_schema.sql):
--   cuenta_id  UUID  NOT NULL
--   alumno_id  TEXT  NOT NULL
--   pin_hash   TEXT
--   PRIMARY KEY (cuenta_id, alumno_id)
--
-- ⚠️ La tabla NO tiene columna actualizado_en.
--    Si se necesita auditoría de fecha, agregar primero:
--
--      ALTER TABLE public.alumnos_credenciales
--        ADD COLUMN IF NOT EXISTS actualizado_en TIMESTAMPTZ;
--
--    pero NO es requisito del flujo actual; el RPC funciona sin ella.
-- ============================================================

-- pgcrypto ya debe estar habilitado; esta línea es idempotente.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------
-- Función principal: tesorero_set_pin
-- ------------------------------------------------------------
-- Propósito: permite al tesorero autenticado cambiar el PIN de
-- un alumno. Verifica ownership, valida el PIN, hashea con
-- bcrypt (costo 10) y hace upsert en alumnos_credenciales.
-- Nunca devuelve el hash al cliente.
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
  v_pin  TEXT;
BEGIN
  -- 1. Normalizar PIN (trim); rechazar NULL y vacío
  v_pin := trim(COALESCE(p_pin, ''));
  IF v_pin = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'pin_vacio');
  END IF;

  -- 2. Rechazar PIN demasiado corto (mínimo 4 caracteres)
  IF char_length(v_pin) < 4 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'pin_muy_corto',
      'detalle', 'El PIN debe tener al menos 4 caracteres.');
  END IF;

  -- 3. Verificar que el caller es dueño de la cuenta
  IF NOT es_dueno(p_cuenta_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  -- 4. Verificar que el alumno pertenece a esta cuenta
  IF NOT EXISTS (
    SELECT 1 FROM public.alumnos
    WHERE cuenta_id = p_cuenta_id AND id = p_alumno_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'alumno_not_found');
  END IF;

  -- 5. Hashear con bcrypt (costo 10)
  v_hash := crypt(v_pin, gen_salt('bf', 10));

  -- 6. Upsert en alumnos_credenciales
  --    ON CONFLICT usa la PK real: (cuenta_id, alumno_id)
  INSERT INTO public.alumnos_credenciales (cuenta_id, alumno_id, pin_hash)
  VALUES (p_cuenta_id, p_alumno_id, v_hash)
  ON CONFLICT (cuenta_id, alumno_id)
    DO UPDATE SET pin_hash = EXCLUDED.pin_hash;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- Revocar acceso público y conceder solo a usuarios autenticados
REVOKE ALL ON FUNCTION public.tesorero_set_pin(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tesorero_set_pin(UUID, TEXT, TEXT) TO authenticated;

-- ============================================================
-- Verificación rápida (ejecutar en el SQL Editor de staging):
--
--   SELECT public.tesorero_set_pin(
--     '<tu_cuenta_id_de_staging>',
--     '<alumno_id_de_prueba>',
--     'TEST1234'
--   );
--   -- Resultado esperado: {"ok": true}
--
--   SELECT public.tesorero_set_pin(
--     '<tu_cuenta_id_de_staging>',
--     '<alumno_id_de_prueba>',
--     '123'           -- demasiado corto
--   );
--   -- Resultado esperado: {"ok": false, "error": "pin_muy_corto", ...}
--
--   SELECT public.tesorero_set_pin(
--     '<tu_cuenta_id_de_staging>',
--     '<alumno_id_de_prueba>',
--     ''              -- vacío
--   );
--   -- Resultado esperado: {"ok": false, "error": "pin_vacio"}
-- ============================================================
