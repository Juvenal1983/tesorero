-- ============================================================
-- El Tesorero — "El Gran Cambio" v9
-- Archivo: sql/09b_nota_uc_a_en_b.sql  (v1)
-- Propósito: Documentar el comportamiento de la membresía
--            uc-a-en-b (Usuario A como tesorero en Cuenta B,
--            curso_id=NULL) y confirmar qué ve A en Cuenta B.
--
-- NO MODIFICA DATOS. Solo ejecuta consultas explicativas.
-- Requiere: 08_seed_staging.sql ya ejecutado.
--
-- ANÁLISIS:
--   En 08_seed_staging.sql, Usuario A es insertado como tesorero
--   en Cuenta B con curso_id=NULL.
--
--   get_mis_cursos(cuenta_b) filtra WHERE curso_id IS NOT NULL.
--   → A obtiene 0 cursos de Cuenta B vía get_mis_cursos().
--
--   La política cursos_select verifica:
--     cuenta_id IN (get_mis_cuentas())   ← A sí tiene acceso a cuenta B
--     AND (
--       es_dueno(cuenta_id)              ← A NO es dueño de B
--       OR id IN (get_mis_cursos(...))   ← vacío para A en B
--     )
--   → A no ve ningún curso de B.
--
-- DECISIÓN DE DISEÑO (no es un bug):
--   curso_id=NULL en un rol no-dueño significa "membresía registrada
--   sin asignación de curso". A puede aparecer en la lista de miembros
--   de B (uc_select lo permite), pero no accede a datos de cursos.
--   Para que A acceda a un curso de B, se le debe asignar curso_id
--   explícitamente (como en 09_fixture_usuario_c.sql para C en A).
--
-- IMPACTO EN TESTS:
--   test:03 verifica que A ve cursos de Cuenta B.
--   Con la membresía actual (curso_id=NULL), ese test FALLARÁ
--   para la verificación de acceso a cursos de B.
--   Opciones:
--     a) Actualizar el test para reflejar el comportamiento real.
--     b) Crear un fixture adicional que asigne un curso_id a uc-a-en-b.
--     c) Cambiar test:03 para verificar membresía, no visibilidad de cursos.
--   La decisión la toma el equipo; este archivo documenta el estado.
-- ============================================================

-- Verificación de estado actual (solo lectura):
SELECT
  uc.id,
  uc.cuenta_id,
  uc.auth_id,
  uc.rol,
  uc.curso_id,
  CASE WHEN uc.curso_id IS NULL
    THEN 'SIN CURSO ASIGNADO — A no verá cursos de B por RLS'
    ELSE 'Con curso asignado: ' || uc.curso_id
  END AS nota_rls
FROM usuarios_cuenta uc
WHERE uc.id = 'uc-a-en-b'
  AND uc.cuenta_id = '00000000-0000-0000-bbbb-000000000002'::uuid;
