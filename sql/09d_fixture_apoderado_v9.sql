-- ============================================================
-- El Tesorero — "El Gran Cambio" v9
-- Archivo: sql/09d_fixture_apoderado_v9.sql
-- Propósito: Fixture INCREMENTAL para el flujo apoderado v9.
--
-- IMPORTANTE:
--   • No modifica ni reemplaza 08_seed_staging.sql ni ningún fixture previo.
--   • Solo agrega: codigo en cursos existentes + credenciales PIN ficticias.
--   • Ejecutar DESPUÉS de 08_seed_staging.sql y 06_rpcs_apoderado.sql.
--   • Los PIN en texto plano están documentados aquí SOLO para staging/pruebas.
--     En producción los PIN los ingresa el tesorero por la interfaz.
--
-- Cursos afectados:
--   cur-a-01 (Cuenta A) → codigo 'CUR-A01'  (alumnos: alu-a-01, alu-a-02)
--   cur-b-01 (Cuenta B) → codigo 'CUR-B01'  (alumno:  alu-b-01)
--   cur-a-02 (Cuenta A) → sin codigo (curso sin acceso apoderado aún)
--
-- PIN ficticios (solo staging):
--   alu-a-01: PIN "1234"
--   alu-a-02: PIN "5678"
--   alu-b-01: PIN "9999"
--   alu-a-03: sin PIN (alumno sin acceso apoderado en este fixture)
-- ============================================================

BEGIN;

-- ── 1. Agregar codigo de acceso a los cursos de prueba ─────────
-- Se actualiza solo si el codigo actual es NULL o vacío,
-- para no pisar un codigo ya configurado en re-ejecuciones.
UPDATE cursos
SET codigo = 'CUR-A01'
WHERE cuenta_id = '00000000-0000-0000-aaaa-000000000001'::uuid
  AND id = 'cur-a-01'
  AND (codigo IS NULL OR codigo = '');

UPDATE cursos
SET codigo = 'CUR-B01'
WHERE cuenta_id = '00000000-0000-0000-bbbb-000000000002'::uuid
  AND id = 'cur-b-01'
  AND (codigo IS NULL OR codigo = '');

-- cur-a-02: sin codigo — verifica que alumnos de ese curso no sean accesibles.
-- No se toca.

-- ── Código CC de acceso compartido para cur-a-01 ───────────────
-- Solo para staging/pruebas. En producción el tesorero lo genera
-- desde la UI y queda almacenado en cursos.codigo_compartido.
UPDATE cursos
SET codigo_compartido = 'CC-TEST-0001'
WHERE cuenta_id = '00000000-0000-0000-aaaa-000000000001'::uuid
  AND id = 'cur-a-01'
  AND (codigo_compartido IS NULL OR codigo_compartido = '');

-- ── 2. Credenciales PIN para alumnos ──────────────────────────
-- crypt() y gen_salt() requieren pgcrypto. En Supabase puede estar en
-- el schema 'extensions'; SET search_path lo cubre en la sesión.
SET search_path = public, extensions;

-- ON CONFLICT DO NOTHING: no sobreescribe credenciales ya existentes.
-- Si un PIN ya existe y es incorrecto, borrarlo manualmente y re-ejecutar:
--   DELETE FROM alumnos_credenciales WHERE alumno_id='alu-a-01';
INSERT INTO alumnos_credenciales (cuenta_id, alumno_id, pin_hash)
VALUES
  ('00000000-0000-0000-aaaa-000000000001'::uuid,
   'alu-a-01',
   crypt('1234', gen_salt('bf'))),

  ('00000000-0000-0000-aaaa-000000000001'::uuid,
   'alu-a-02',
   crypt('5678', gen_salt('bf'))),

  ('00000000-0000-0000-bbbb-000000000002'::uuid,
   'alu-b-01',
   crypt('9999', gen_salt('bf')))

ON CONFLICT (cuenta_id, alumno_id) DO NOTHING;

-- alu-a-03 no tiene PIN: verifica que el RPC rechace sin credencial.
-- alu-b-02 no tiene PIN: idem.

-- ── 3. Verificación post-insert por fila exacta ────────────────
-- Verifica cada fila objetivo individualmente (no recuentos globales que
-- podrían pasar si existen filas ajenas adicionales o distintas).
DO $$
DECLARE
  errores INT := 0;
BEGIN
  SET LOCAL search_path = public, extensions;

  -- Verificar codigos exactos en los cursos objetivo
  IF NOT EXISTS(
    SELECT 1 FROM cursos
    WHERE cuenta_id = '00000000-0000-0000-aaaa-000000000001'
      AND id = 'cur-a-01' AND codigo = 'CUR-A01'
  ) THEN
    RAISE WARNING 'cur-a-01 no tiene codigo=CUR-A01';
    errores := errores + 1;
  END IF;

  IF NOT EXISTS(
    SELECT 1 FROM cursos
    WHERE cuenta_id = '00000000-0000-0000-bbbb-000000000002'
      AND id = 'cur-b-01' AND codigo = 'CUR-B01'
  ) THEN
    RAISE WARNING 'cur-b-01 no tiene codigo=CUR-B01';
    errores := errores + 1;
  END IF;

  -- cur-a-02 no debe tener codigo
  IF EXISTS(
    SELECT 1 FROM cursos
    WHERE cuenta_id = '00000000-0000-0000-aaaa-000000000001'
      AND id = 'cur-a-02' AND codigo IS NOT NULL AND codigo <> ''
  ) THEN
    RAISE WARNING 'cur-a-02 tiene codigo inesperado (debería ser NULL)';
    errores := errores + 1;
  END IF;

  -- Verificar código compartido CC-TEST-0001 en cur-a-01
  IF NOT EXISTS(
    SELECT 1 FROM cursos
    WHERE cuenta_id = '00000000-0000-0000-aaaa-000000000001'
      AND id = 'cur-a-01' AND codigo_compartido = 'CC-TEST-0001'
  ) THEN
    RAISE WARNING 'cur-a-01 no tiene codigo_compartido=CC-TEST-0001';
    errores := errores + 1;
  END IF;

  -- Verificar PINs por valor (crypt(pin, hash) = hash si el PIN es correcto)
  IF NOT EXISTS(
    SELECT 1 FROM alumnos_credenciales
    WHERE cuenta_id = '00000000-0000-0000-aaaa-000000000001'
      AND alumno_id = 'alu-a-01'
      AND crypt('1234', pin_hash) = pin_hash
  ) THEN
    RAISE WARNING 'PIN de alu-a-01 no corresponde a "1234" (credencial ausente o PIN distinto)';
    errores := errores + 1;
  END IF;

  IF NOT EXISTS(
    SELECT 1 FROM alumnos_credenciales
    WHERE cuenta_id = '00000000-0000-0000-aaaa-000000000001'
      AND alumno_id = 'alu-a-02'
      AND crypt('5678', pin_hash) = pin_hash
  ) THEN
    RAISE WARNING 'PIN de alu-a-02 no corresponde a "5678"';
    errores := errores + 1;
  END IF;

  IF NOT EXISTS(
    SELECT 1 FROM alumnos_credenciales
    WHERE cuenta_id = '00000000-0000-0000-bbbb-000000000002'
      AND alumno_id = 'alu-b-01'
      AND crypt('9999', pin_hash) = pin_hash
  ) THEN
    RAISE WARNING 'PIN de alu-b-01 no corresponde a "9999"';
    errores := errores + 1;
  END IF;

  -- alu-a-03 no debe tener credencial
  IF EXISTS(
    SELECT 1 FROM alumnos_credenciales
    WHERE cuenta_id = '00000000-0000-0000-aaaa-000000000001'
      AND alumno_id = 'alu-a-03'
  ) THEN
    RAISE WARNING 'alu-a-03 tiene credencial inesperada';
    errores := errores + 1;
  END IF;

  IF errores > 0 THEN
    RAISE EXCEPTION 'Fixture 09d falló con % error(es). ROLLBACK.', errores;
  END IF;

  RAISE NOTICE 'Fixture 09d OK: codigos y PINs verificados por fila y valor.';
END;
$$;

COMMIT;
