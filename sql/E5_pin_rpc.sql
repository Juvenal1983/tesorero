-- ============================================================
-- E5: RPC tesorero_set_pin — hash bcrypt de PIN en servidor
-- ============================================================
-- Ejecutar SOLO en staging después de revisar con el equipo.
-- NO ejecutar en producción (tmjqzaakzhecbldebyeg).
--
-- Prerrequisitos (ya desplegados en staging):
--   01_schema.sql   → crea alumnos_credenciales, es_dueno(), pgcrypto
--   02_rls.sql      → políticas RLS
--   07_grants_supabase.sql → permisos de roles
--
-- Schema real de alumnos_credenciales (01_schema.sql):
--
--   CREATE TABLE alumnos_credenciales (
--     cuenta_id  UUID  NOT NULL,
--     alumno_id  TEXT  NOT NULL,
--     pin_hash   TEXT,
--     PRIMARY KEY (cuenta_id, alumno_id),
--     FOREIGN KEY (cuenta_id, alumno_id)
--       REFERENCES alumnos(cuenta_id, id) ON DELETE CASCADE
--   );
--
--   ⚠ La tabla NO tiene columna actualizado_en.
--     Si en el futuro se necesita auditoría de fecha, agregar:
--       ALTER TABLE alumnos_credenciales
--         ADD COLUMN IF NOT EXISTS actualizado_en TIMESTAMPTZ;
--     Pero no es requisito del flujo actual.
--
-- Validaciones en este RPC:
--   · PIN null/vacío     → error 'pin_vacio'
--   · PIN < 4 caracteres → error 'pin_muy_corto'
--   · Caller no es dueño → error 'forbidden'
--   · Alumno no existe   → error 'alumno_not_found'
--
-- Verificación rápida (SQL Editor de staging, después de aplicar):
--
--   -- Debe devolver {"ok": true}
--   SELECT public.tesorero_set_pin(
--     '<cuenta_id_de_staging>',
--     '<alumno_id_de_prueba>',
--     'TEST1234'
--   );
--
--   -- Debe devolver {"ok": false, "error": "pin_vacio"}
--   SELECT public.tesorero_set_pin(
--     '<cuenta_id_de_staging>', '<alumno_id>', ''
--   );
--
--   -- Debe devolver {"ok": false, "error": "pin_muy_corto", ...}
--   SELECT public.tesorero_set_pin(
--     '<cuenta_id_de_staging>', '<alumno_id>', '123'
--   );
--
-- Alternativa sin abrir el SQL Editor: ejecutar tests/test_v9_staging.js
-- ============================================================

-- pgcrypto ya debe estar habilitado; esta línea es idempotente.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- Función principal: tesorero_set_pin
-- ============================================================
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
  -- 1. Normalizar PIN (trim); rechazar null y vacío
  v_pin := trim(COALESCE(p_pin, ''));
  IF v_pin = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'pin_vacio');
  END IF;

  -- 2. Rechazar PIN demasiado corto (mínimo 4 caracteres)
  IF char_length(v_pin) < 4 THEN
    RETURN jsonb_build_object(
      'ok',      false,
      'error',   'pin_muy_corto',
      'detalle', 'El PIN debe tener al menos 4 caracteres.'
    );
  END IF;

  -- 3. Verificar que el caller es dueño de la cuenta (via RLS helper)
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

  -- 5. Hashear con bcrypt, costo 10
  v_hash := crypt(v_pin, gen_salt('bf', 10));

  -- 6. Upsert — ON CONFLICT usa la PK real: (cuenta_id, alumno_id)
  --    La tabla NO tiene columna actualizado_en.
  INSERT INTO public.alumnos_credenciales (cuenta_id, alumno_id, pin_hash)
  VALUES (p_cuenta_id, p_alumno_id, v_hash)
  ON CONFLICT (cuenta_id, alumno_id)
    DO UPDATE SET pin_hash = EXCLUDED.pin_hash;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- Solo usuarios autenticados pueden llamar esta función; anon no.
REVOKE ALL   ON FUNCTION public.tesorero_set_pin(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tesorero_set_pin(UUID, TEXT, TEXT) TO authenticated;
