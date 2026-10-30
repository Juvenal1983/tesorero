-- ============================================================
-- El Tesorero — "El Gran Cambio" v9
-- Archivo: sql/09c_fixture_uc_a_en_b_curso.sql  (v1)
-- Propósito: Fixture adicional — asignar cur-b-01 a la membresía
--            uc-a-en-b (Usuario A como tesorero en Cuenta B).
--
-- EJECUTAR DESPUÉS DE: 08_seed_staging.sql
-- INDEPENDIENTE DE: 09_fixture_usuario_c.sql
--
-- DISEÑO — por qué existe este fixture:
--   El seed v3 crea uc-a-en-b con curso_id=NULL.
--   Con NULL, get_mis_cursos(cuenta_b) devuelve 0 filas para A,
--   por lo que las políticas cursos_select / alumnos_select / cuotas_select
--   no dejan pasar ninguna fila de Cuenta B al cliente.
--
--   Sin embargo, tiene_rol_en_curso() sí contempla NULL como alcance
--   general: AND (curso_id = p_curso_id OR curso_id IS NULL).
--   A puede por tanto ESCRIBIR (INSERT/UPDATE/DELETE) en cualquier curso
--   de Cuenta B, pero NO VER filas de cursos (asimetría documentada en
--   09b_nota_uc_a_en_b.sql).
--
--   Este fixture asigna explícitamente cur-b-01 a uc-a-en-b para
--   verificar el escenario de acceso delegado con visibilidad completa:
--     - A ve cur-b-01 en Cuenta B (get_mis_cursos retorna la fila)
--     - A puede leer alumnos y cuotas de cur-b-01
--     - A sigue sin ver cur-b-02 ni datos de Cuenta A que no le pertenezcan
--
-- PRUEBA QUE HABILITA (test:03 actualizado):
--   SIN este fixture: A ve 0 cursos en B (pero puede escribir vía NULL)
--   CON este fixture: A ve cur-b-01 en B (acceso delegado completo)
--
-- NO MODIFICA el seed original (08_seed_staging.sql).
-- Usa ON CONFLICT ... DO UPDATE SET para ser idempotente.
-- ============================================================

BEGIN;

-- Verificar que el seed base ya fue ejecutado
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM usuarios_cuenta
    WHERE cuenta_id = '00000000-0000-0000-bbbb-000000000002'::uuid
      AND id = 'uc-a-en-b'
  ) THEN
    RAISE EXCEPTION
      '08_seed_staging.sql no fue ejecutado o uc-a-en-b no existe. '
      'Ejecuta el seed base primero.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM cursos
    WHERE cuenta_id = '00000000-0000-0000-bbbb-000000000002'::uuid
      AND id = 'cur-b-01'
  ) THEN
    RAISE EXCEPTION
      'cur-b-01 no existe en Cuenta B. Ejecuta el seed base primero.';
  END IF;

  RAISE NOTICE 'Validación OK: uc-a-en-b y cur-b-01 existen.';
END;
$$;

-- Asignar cur-b-01 a uc-a-en-b
-- PK compuesta: (cuenta_id, id) — conforme al esquema v9
-- DO UPDATE SET: idempotente; no toca auth_id, rol ni desactivado
UPDATE usuarios_cuenta
SET curso_id = 'cur-b-01'
WHERE cuenta_id = '00000000-0000-0000-bbbb-000000000002'::uuid
  AND id = 'uc-a-en-b';

-- Verificación
DO $$
DECLARE
  curso_actual TEXT;
  errores      INT := 0;
BEGIN
  SELECT curso_id
  INTO   curso_actual
  FROM   usuarios_cuenta
  WHERE  cuenta_id = '00000000-0000-0000-bbbb-000000000002'::uuid
    AND  id = 'uc-a-en-b';

  IF curso_actual IS DISTINCT FROM 'cur-b-01' THEN
    RAISE WARNING 'uc-a-en-b: curso_id=% (esperado: cur-b-01)', curso_actual;
    errores := errores + 1;
  END IF;

  IF errores > 0 THEN
    RAISE EXCEPTION 'Fixture 09c: % verificación(es) fallida(s).', errores;
  END IF;

  RAISE NOTICE 'Fixture 09c OK: uc-a-en-b ahora tiene curso_id=cur-b-01 en Cuenta B.';
  RAISE NOTICE '  A ve cur-b-01 vía get_mis_cursos(Cuenta B).';
  RAISE NOTICE '  test:03 puede verificar acceso delegado con visibilidad completa.';
  RAISE NOTICE '';
  RAISE NOTICE '  NOTA: sin este fixture, A sigue pudiendo ESCRIBIR en cualquier';
  RAISE NOTICE '  curso de B (tiene_rol_en_curso permite NULL como alcance general)';
  RAISE NOTICE '  pero no ve ninguna fila de cursos (get_mis_cursos filtra NULL).';
END;
$$;

COMMIT;
