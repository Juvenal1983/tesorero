-- ============================================================
-- El Tesorero — "El Gran Cambio" v9
-- Archivo: sql/09b_nota_uc_a_en_b.sql  (v2)
-- Propósito: Documentar el comportamiento de la membresía
--            uc-a-en-b (Usuario A como tesorero en Cuenta B,
--            curso_id=NULL) y confirmar qué ve y qué puede
--            escribir A en Cuenta B.
--
-- NO MODIFICA DATOS. Solo ejecuta consultas explicativas.
-- Requiere: 08_seed_staging.sql ya ejecutado.
--
-- ============================================================
-- ANÁLISIS DE LA ASIMETRÍA curso_id=NULL
-- ============================================================
--
-- El seed v3 crea uc-a-en-b con curso_id=NULL.
-- Esto produce un comportamiento ASIMÉTRICO entre lecturas y escrituras:
--
-- --- LECTURAS (política SELECT) ---
--   get_mis_cursos(cuenta_b) filtra WHERE curso_id IS NOT NULL.
--   → A obtiene 0 filas de get_mis_cursos() para Cuenta B.
--
--   La política cursos_select verifica:
--     cuenta_id IN (get_mis_cuentas())       ← A sí tiene acceso a Cuenta B
--     AND (
--       es_dueno(cuenta_id)                  ← A NO es dueño de B
--       OR id IN (get_mis_cursos(cuenta_id)) ← 0 cursos para A en B
--     )
--   → A no ve ningún curso de B bajo RLS SELECT.
--
--   Lo mismo aplica a alumnos_select, cuotas_select, pagos_select, etc.:
--   todos dependen de get_mis_cursos() para miembros no-dueños.
--
-- --- ESCRITURAS (políticas INSERT / UPDATE / DELETE) ---
--   tiene_rol_en_curso(p_cuenta_id, p_curso_id, p_roles) verifica:
--     AND (curso_id = p_curso_id OR curso_id IS NULL)
--   → El OR curso_id IS NULL hace que NULL sea "alcance general":
--     A con curso_id=NULL PUEDE escribir en CUALQUIER curso de Cuenta B.
--
--   Resultado: A puede INSERT, UPDATE y DELETE en cursos, alumnos,
--   cuotas, pagos de Cuenta B —en cualquier curso— pero no puede
--   leer las filas resultantes por RLS SELECT.
--
-- --- RESUMEN ---
--   curso_id=NULL NO es ausencia total de permisos.
--   Es una membresía con alcance general de escritura y sin visibilidad
--   de lectura (por diseño del filtro get_mis_cursos).
--
--   Escenario real:            SELECT  INSERT/UPDATE/DELETE
--   uc-a-en-b (NULL)       →   0 filas   cualquier curso de B
--   uc-c-visor-a (cur-a-01) →  cur-a-01  solo cur-a-01
--
-- --- SOLUCIÓN para visibilidad completa ---
--   Asignar un curso_id explícito a uc-a-en-b.
--   Ver: sql/09c_fixture_uc_a_en_b_curso.sql
--   Ese fixture asigna cur-b-01 y permite a A ver y operar ese curso.
--
-- --- IMPACTO EN TESTS ---
--   test:03 — dos variantes según estado del fixture 09c:
--
--   SIN 09c (seed puro, curso_id=NULL):
--     - A aparece en usuarios_cuenta de B (uc_select lo permite)
--     - get_mis_cursos(cuenta_b) → 0 filas para A
--     - A puede escribir en cualquier curso de B (INSERT/UPDATE/DELETE pasan)
--     - test:03 debe verificar membresía de A en B, NO visibilidad de cursos
--
--   CON 09c (curso_id=cur-b-01):
--     - A ve cur-b-01 en Cuenta B (get_mis_cursos retorna la fila)
--     - A puede leer y escribir en cur-b-01
--     - test:03 puede verificar acceso delegado completo (lectura + escritura)
--
-- ============================================================

-- Verificación de estado actual (solo lectura):
SELECT
  uc.id,
  uc.cuenta_id,
  uc.auth_id,
  uc.rol,
  uc.curso_id,
  CASE
    WHEN uc.curso_id IS NULL
      THEN 'NULL = alcance general: ESCRIBE en cualquier curso de B, no ve cursos por SELECT'
    ELSE
      'Curso asignado: ' || uc.curso_id || ' — ve y escribe en ese curso'
  END AS nota_rls
FROM usuarios_cuenta uc
WHERE uc.id = 'uc-a-en-b'
  AND uc.cuenta_id = '00000000-0000-0000-bbbb-000000000002'::uuid;

-- Confirmar qué cursos ve A en Cuenta B con get_mis_cursos():
SELECT
  'get_mis_cursos(Cuenta B) para A' AS consulta,
  COALESCE(
    (SELECT string_agg(curso_id, ', ' ORDER BY curso_id)
     FROM get_mis_cursos('00000000-0000-0000-bbbb-000000000002'::uuid)),
    '(ninguno — curso_id IS NULL en uc-a-en-b; ejecutar 09c para asignar cur-b-01)'
  ) AS resultado;
