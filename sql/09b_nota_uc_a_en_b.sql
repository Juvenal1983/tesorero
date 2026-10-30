-- ============================================================
-- El Tesorero — "El Gran Cambio" v9
-- Archivo: sql/09b_nota_uc_a_en_b.sql  (v3)
-- Propósito: Documentar el comportamiento de la membresía
--            uc-a-en-b (Usuario A como tesorero en Cuenta B,
--            curso_id=NULL) y confirmar qué ve y qué puede
--            escribir A en Cuenta B.
--
-- NO MODIFICA DATOS. Solo ejecuta consultas explicativas.
-- Requiere: 08_seed_staging.sql ya ejecutado.
-- Las consultas AS deben ejecutarse con identidad A simulada
-- (SET LOCAL request.jwt.claims + SET LOCAL ROLE authenticated)
-- para que RLS sea efectivo. Ejecutarlas como superuser/postgres
-- omite RLS y no demuestra nada.
--
-- ============================================================
-- PERMISOS REALES POR TABLA (lectura directa de pg_policies)
-- ============================================================
--
-- Las políticas de escritura NO son uniformes. Cada tabla define
-- sus propias condiciones. Resumen para A como tesorero en Cuenta B:
--
-- CURSOS
--   INSERT:   WITH CHECK = es_dueno(cuenta_id)
--             → A NO puede crear cursos en B (no es dueño)
--   UPDATE:   USING = es_dueno(cuenta_id)
--             → A NO puede actualizar cursos en B
--   DELETE:   USING = es_dueno(cuenta_id)
--             → A NO puede eliminar cursos en B
--
-- ALUMNOS
--   INSERT:   WITH CHECK = es_dueno(cuenta_id)
--                       OR tiene_rol_en_curso(cuenta_id, curso_id,
--                          ['admin','editor','tesorero'])
--             → A SÍ puede insertar alumnos en cur-b-01 (rol tesorero)
--   UPDATE:   USING = es_dueno(cuenta_id)
--                  OR tiene_rol_en_curso(cuenta_id, curso_id,
--                     ['admin','editor','tesorero'])
--             → A SÍ puede actualizar alumnos de cur-b-01
--   DELETE:   USING = es_dueno(cuenta_id)
--             → A NO puede eliminar alumnos (solo propietario)
--
-- CUOTAS
--   INSERT:   WITH CHECK = es_dueno(cuenta_id)
--             → A NO puede crear cuotas en B
--   UPDATE:   USING = es_dueno(cuenta_id)
--             → A NO puede actualizar cuotas en B
--   DELETE:   USING = es_dueno(cuenta_id)
--             → A NO puede eliminar cuotas en B
--   (cuotas es dominio exclusivo del propietario)
--
-- PAGOS
--   INSERT:   WITH CHECK = es_dueno(cuenta_id)
--                       OR tiene_rol_en_curso(cuenta_id,
--                          _curso_de_cuota(cuenta_id, cuota_id),
--                          ['admin','tesorero'])
--             → A SÍ puede registrar pagos sobre cuotas de cur-b-01
--   UPDATE:   USING = es_dueno(cuenta_id)
--                  OR tiene_rol_en_curso(...)  ['admin','tesorero']
--             → A SÍ puede actualizar pagos de cur-b-01
--   DELETE:   USING = es_dueno(cuenta_id)
--                  OR tiene_rol_en_curso(...)  ['admin','tesorero']
--             → A SÍ puede eliminar pagos de cur-b-01
--
-- ABONOS / PLANES_PAGO
--   INSERT/UPDATE: igual que pagos — tiene_rol_en_curso ['admin','tesorero']
--             → A SÍ puede operar abonos y planes sobre cur-b-01
--   DELETE plans: USING = es_dueno(cuenta_id)
--             → A NO puede eliminar planes_pago
--   DELETE abonos: es_dueno(cuenta_id)
--             → A NO puede eliminar abonos
--
-- ROL VISOR (usuario C en Cuenta A)
--   Ninguna política de escritura incluye 'visor' en su array de roles.
--   C tiene acceso SELECT a cursos, alumnos y cuotas de cur-a-01,
--   pero NO puede insertar, actualizar ni eliminar ningún dato.
--
-- ============================================================
-- ASIMETRÍA curso_id=NULL vs curso_id explícito
-- ============================================================
--
-- tiene_rol_en_curso(p_cuenta_id, p_curso_id, p_roles) evalúa:
--   AND (curso_id = p_curso_id OR curso_id IS NULL)
--
-- Con curso_id=NULL en uc-a-en-b, la condición es verdadera para
-- CUALQUIER valor de p_curso_id. Por tanto, en las operaciones que
-- usan tiene_rol_en_curso (alumnos INSERT/UPDATE, pagos, abonos),
-- A tiene el mismo permiso de escritura sobre todos los cursos de B,
-- no solo sobre cur-b-01.
--
-- Para LECTURA, get_mis_cursos filtra WHERE curso_id IS NOT NULL:
--   → con curso_id=NULL, A obtiene 0 cursos de Cuenta B.
--   → A no ve ninguna fila de cursos, alumnos ni cuotas de B por SELECT.
--
-- Después de ejecutar 09c (curso_id=cur-b-01):
--   → get_mis_cursos(Cuenta B) retorna 'cur-b-01' para A.
--   → A puede leer cursos, alumnos y cuotas de cur-b-01.
--   → Los permisos de escritura no cambian (tiene_rol_en_curso sigue
--     siendo verdadero para cualquier curso con el NULL que tenía antes;
--     ahora, con cur-b-01 explícito, es verdadero solo para cur-b-01).
--
-- ============================================================
-- CONSULTAS EXPLICATIVAS (ejecutar con identidad A simulada)
-- ============================================================
--
-- IMPORTANTE: estas consultas deben ejecutarse dentro de una transacción
-- con la identidad de A simulada. Como superuser omiten RLS.
-- Ejemplo de bloque de prueba:
--
--   BEGIN;
--   SELECT set_config('request.jwt.claims',
--     '{"sub":"<UUID_A>","role":"authenticated"}', true);
--   SET LOCAL ROLE authenticated;
--   -- ... consultas aquí ...
--   ROLLBACK;
--

-- Estado actual de uc-a-en-b (solo lectura, sin RLS):
SELECT
  uc.id,
  uc.cuenta_id,
  uc.auth_id,
  uc.rol,
  uc.curso_id,
  CASE
    WHEN uc.curso_id IS NULL
      THEN 'NULL: 0 filas SELECT en B; escribe en alumnos/pagos de cualquier curso de B'
    ELSE
      'curso_id=' || uc.curso_id || ': ve y escribe en ese curso'
  END AS nota_rls
FROM usuarios_cuenta uc
WHERE uc.id = 'uc-a-en-b'
  AND uc.cuenta_id = '00000000-0000-0000-bbbb-000000000002'::uuid;
