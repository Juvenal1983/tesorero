-- ============================================================
-- El Tesorero — "El Gran Cambio" v9
-- Archivo: sql/09_fixture_usuario_c.sql  (v1)
-- Propósito: Fixture adicional — Usuario C como delegado (visor)
--            en Cuenta A, asignado a un curso específico.
--
-- EJECUTAR DESPUÉS DE: 08_seed_staging.sql
--
-- ANTES DE EJECUTAR:
--   1. Crea el usuario en Authentication → Users del dashboard de staging:
--        usuario_c@staging.test  (anota su UUID → reemplaza USER_C_UUID)
--   2. Sustituye TEXTUALMENTE el marcador:
--        USER_C_UUID  →  UUID real del usuario C en Auth
--
-- DISEÑO — por qué curso_id no es NULL:
--   get_mis_cursos(p_cuenta_id) filtra WHERE curso_id IS NOT NULL.
--   Un delegado con curso_id=NULL no obtiene acceso bajo las políticas
--   de cursos_select / alumnos_select / cuotas_select para roles no-dueños.
--   El rol 'visor' con curso_id=NULL resultaría en 0 filas visibles.
--   Por eso este fixture asigna a C el curso 'cur-a-01' explícitamente.
--
-- PRUEBA QUE HABILITA:
--   C puede ver cursos, alumnos y cuotas de cur-a-01 (Cuenta A).
--   C NO ve cur-a-02 ni ningún dato de Cuenta B.
--   Esto cubre el escenario de acceso delegado por curso (test 06).
-- ============================================================

BEGIN;

-- Verificación del marcador
DO $$
DECLARE
  uuid_c UUID;
BEGIN
  BEGIN
    uuid_c := 'USER_C_UUID'::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'USER_C_UUID no fue sustituido. Reemplaza el marcador con el UUID real del usuario C en Auth.';
  END;

  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = uuid_c) THEN
    RAISE EXCEPTION 'USER_C_UUID (%) no existe en auth.users. Crea el usuario en Authentication primero.', uuid_c;
  END IF;

  -- Verificar que el seed base ya fue ejecutado
  IF NOT EXISTS (
    SELECT 1 FROM tesorero_cuentas
    WHERE id = '00000000-0000-0000-aaaa-000000000001'::uuid
  ) THEN
    RAISE EXCEPTION '08_seed_staging.sql no fue ejecutado o Cuenta A no existe. Ejecuta el seed base primero.';
  END IF;

  RAISE NOTICE 'Validación OK: C=%, cur-a-01 existe en Cuenta A', uuid_c;
END;
$$;

-- Membresía: Usuario C → visor en Cuenta A, curso cur-a-01
-- PK compuesta: (cuenta_id, id) — conforme al esquema v9
INSERT INTO usuarios_cuenta (cuenta_id, id, auth_id, email, nombre, rol, curso_id, desactivado)
VALUES (
  '00000000-0000-0000-aaaa-000000000001'::uuid,
  'uc-c-visor-a',
  'USER_C_UUID'::uuid,
  'usuario_c@staging.test',
  'Usuario C (Staging)',
  'visor',
  'cur-a-01',   -- Asignado a curso específico; ver DISEÑO arriba
  false
)
ON CONFLICT (cuenta_id, id) DO NOTHING;

-- Verificación
DO $$
DECLARE
  auth_c      UUID;
  rol_c       TEXT;
  curso_c     TEXT;
  errores     INT := 0;
BEGIN
  SELECT auth_id, rol, curso_id
  INTO   auth_c, rol_c, curso_c
  FROM   usuarios_cuenta
  WHERE  cuenta_id = '00000000-0000-0000-aaaa-000000000001'::uuid
    AND  id = 'uc-c-visor-a';

  IF auth_c IS DISTINCT FROM 'USER_C_UUID'::uuid THEN
    RAISE WARNING 'uc-c-visor-a: auth_id=% (esperado: USER_C_UUID)', auth_c;
    errores := errores + 1;
  END IF;

  IF rol_c IS DISTINCT FROM 'visor' THEN
    RAISE WARNING 'uc-c-visor-a: rol=% (esperado: visor)', rol_c;
    errores := errores + 1;
  END IF;

  IF curso_c IS DISTINCT FROM 'cur-a-01' THEN
    RAISE WARNING 'uc-c-visor-a: curso_id=% (esperado: cur-a-01)', curso_c;
    errores := errores + 1;
  END IF;

  IF errores > 0 THEN
    RAISE EXCEPTION 'Fixture usuario C: % verificación(es) fallida(s).', errores;
  END IF;

  RAISE NOTICE 'Fixture OK: C (%) → visor en Cuenta A, curso cur-a-01', auth_c;
  RAISE NOTICE '  C ve alumnos/cuotas de cur-a-01 solamente.';
  RAISE NOTICE '  C no ve cur-a-02 ni datos de Cuenta B.';
END;
$$;

COMMIT;
