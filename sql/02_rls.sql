-- ============================================================
-- El Tesorero — "El Gran Cambio" v5
-- Archivo: sql/02_rls.sql
-- Cambios v5 (resuelve CRÍTICO 2, ALTO 3, ALTO 4):
--
--   CRÍTICO 2: FOR ALL sustituido por políticas separadas por operación.
--     SELECT, INSERT, UPDATE, DELETE con ámbito de curso en USING y
--     WITH CHECK para pagos, movimientos, fondo, abonos y planes_pago.
--     Un invitado con rol tesorero solo ve y modifica datos de su curso.
--
--   ALTO 3: alumnos_credenciales sin política RLS pública → ningún
--     cliente obtiene filas. Solo service_role accede.
--
--   ALTO 4: suscripciones sin política RLS pública → ningún cliente
--     puede leer ni modificar el plan. Solo service_role accede.
--     tesorero_cuentas ya no tiene columna plan (ver 01_schema.sql).
--
-- NOTA sobre STAGING (CRÍTICO 1):
--   _staging.tesorero_datos está en schema _staging.
--   06_test_permisos.sql NO concede USAGE de _staging a authenticated.
--   El VIEW público 'tesorero_datos' tampoco es accesible porque no
--   se concede SELECT sobre él (solo se concede tabla a tabla en public).
-- ============================================================

-- ── Habilitar RLS en tablas de public ──────────────────────────
ALTER TABLE tesorero_cuentas   ENABLE ROW LEVEL SECURITY;
ALTER TABLE colegios           ENABLE ROW LEVEL SECURITY;
ALTER TABLE cursos             ENABLE ROW LEVEL SECURITY;
ALTER TABLE alumnos            ENABLE ROW LEVEL SECURITY;
ALTER TABLE apoderados         ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuotas             ENABLE ROW LEVEL SECURITY;
ALTER TABLE pagos              ENABLE ROW LEVEL SECURITY;
ALTER TABLE abonos             ENABLE ROW LEVEL SECURITY;
ALTER TABLE planes_pago        ENABLE ROW LEVEL SECURITY;
ALTER TABLE movimientos        ENABLE ROW LEVEL SECURITY;
ALTER TABLE fondo_movimientos  ENABLE ROW LEVEL SECURITY;
ALTER TABLE notas              ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuarios_cuenta    ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuarios_externos  ENABLE ROW LEVEL SECURITY;
ALTER TABLE codigos_invitacion ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_cuenta      ENABLE ROW LEVEL SECURITY;

-- suscripciones y alumnos_credenciales habilitan RLS sin políticas para
-- clientes → ningún cliente obtiene filas (defensa en profundidad).
ALTER TABLE suscripciones         ENABLE ROW LEVEL SECURITY;
ALTER TABLE alumnos_credenciales  ENABLE ROW LEVEL SECURITY;
-- (No se crean políticas para suscripciones ni alumnos_credenciales;
--  solo service_role accede, que bypassa RLS.)

-- ── Ayudante interno: curso del pago/abono (sin FK directa) ────
-- Devuelve el curso_id de una cuota dado el (cuenta_id, cuota_id).
-- Usado en USING/WITH CHECK de pagos, abonos, planes_pago.
CREATE OR REPLACE FUNCTION _curso_de_cuota(p_cuenta_id UUID, p_cuota_id TEXT)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT curso_id FROM cuotas
  WHERE cuenta_id = p_cuenta_id AND id = p_cuota_id
$$;

-- ── tesorero_cuentas ─────────────────────────────────────────────
-- Lectura: el dueño ve su cuenta; invitados la ven si tienen acceso.
CREATE POLICY "tc_select"
  ON tesorero_cuentas FOR SELECT
  USING (id IN (SELECT get_mis_cuentas()));

-- Actualización: solo el dueño puede actualizar su fila.
-- Columna 'plan' ya no existe aquí (movida a suscripciones).
-- Con esto queda eliminado el bloqueante ALTO 4.
CREATE POLICY "tc_update"
  ON tesorero_cuentas FOR UPDATE
  USING  (auth_id = auth.uid())
  WITH CHECK (auth_id = auth.uid());

-- INSERT/DELETE de cuentas: solo superuser/service_role (ninguna política).

-- ── colegios ─────────────────────────────────────────────────────
CREATE POLICY "colegios_select"
  ON colegios FOR SELECT
  USING (cuenta_id IN (SELECT get_mis_cuentas()));

CREATE POLICY "colegios_insert"
  ON colegios FOR INSERT
  WITH CHECK (
    es_dueno(cuenta_id)
    OR EXISTS (
      SELECT 1 FROM usuarios_cuenta
      WHERE cuenta_id = colegios.cuenta_id
        AND auth_id = auth.uid()
        AND rol IN ('admin', 'editor', 'tesorero')
        AND desactivado = FALSE
    )
  );

CREATE POLICY "colegios_update"
  ON colegios FOR UPDATE
  USING (
    es_dueno(cuenta_id)
    OR EXISTS (
      SELECT 1 FROM usuarios_cuenta
      WHERE cuenta_id = colegios.cuenta_id
        AND auth_id = auth.uid()
        AND rol IN ('admin', 'editor', 'tesorero')
        AND desactivado = FALSE
    )
  )
  WITH CHECK (
    es_dueno(cuenta_id)
    OR EXISTS (
      SELECT 1 FROM usuarios_cuenta
      WHERE cuenta_id = colegios.cuenta_id
        AND auth_id = auth.uid()
        AND rol IN ('admin', 'editor', 'tesorero')
        AND desactivado = FALSE
    )
  );

CREATE POLICY "colegios_delete"
  ON colegios FOR DELETE
  USING (es_dueno(cuenta_id));

-- ── cursos ───────────────────────────────────────────────────────
-- Invitados solo ven sus cursos asignados.
CREATE POLICY "cursos_select"
  ON cursos FOR SELECT
  USING (
    cuenta_id IN (SELECT get_mis_cuentas())
    AND (
      es_dueno(cuenta_id)
      OR id IN (SELECT get_mis_cursos(cuenta_id))
    )
  );

CREATE POLICY "cursos_insert"
  ON cursos FOR INSERT
  WITH CHECK (es_dueno(cuenta_id));

CREATE POLICY "cursos_update"
  ON cursos FOR UPDATE
  USING  (es_dueno(cuenta_id))
  WITH CHECK (es_dueno(cuenta_id));

CREATE POLICY "cursos_delete"
  ON cursos FOR DELETE
  USING (es_dueno(cuenta_id));

-- ── alumnos ──────────────────────────────────────────────────────
-- Lectura: dueño ve todos; invitado solo los de su curso.
CREATE POLICY "alumnos_select"
  ON alumnos FOR SELECT
  USING (
    cuenta_id IN (SELECT get_mis_cuentas())
    AND (
      es_dueno(cuenta_id)
      OR curso_id IN (SELECT get_mis_cursos(cuenta_id))
    )
  );

-- Escritura: dueño siempre; invitados solo en su curso.
CREATE POLICY "alumnos_insert"
  ON alumnos FOR INSERT
  WITH CHECK (
    es_dueno(cuenta_id)
    OR tiene_rol_en_curso(cuenta_id, curso_id, ARRAY['admin','editor','tesorero'])
  );

CREATE POLICY "alumnos_update"
  ON alumnos FOR UPDATE
  USING (
    es_dueno(cuenta_id)
    OR tiene_rol_en_curso(cuenta_id, curso_id, ARRAY['admin','editor','tesorero'])
  )
  WITH CHECK (
    es_dueno(cuenta_id)
    OR tiene_rol_en_curso(cuenta_id, curso_id, ARRAY['admin','editor','tesorero'])
  );

CREATE POLICY "alumnos_delete"
  ON alumnos FOR DELETE
  USING (es_dueno(cuenta_id));

-- ── apoderados ───────────────────────────────────────────────────
CREATE POLICY "apoderados_select"
  ON apoderados FOR SELECT
  USING (
    cuenta_id IN (SELECT get_mis_cuentas())
    AND (
      es_dueno(cuenta_id)
      OR alumno_id IN (
        SELECT a.id FROM alumnos a
        WHERE a.cuenta_id = apoderados.cuenta_id
          AND a.curso_id IN (SELECT get_mis_cursos(apoderados.cuenta_id))
      )
    )
  );

CREATE POLICY "apoderados_insert"
  ON apoderados FOR INSERT
  WITH CHECK (
    es_dueno(cuenta_id)
    OR EXISTS (
      SELECT 1 FROM alumnos a
      WHERE a.cuenta_id = apoderados.cuenta_id
        AND a.id        = apoderados.alumno_id
        AND tiene_rol_en_curso(a.cuenta_id, a.curso_id, ARRAY['admin','editor','tesorero'])
    )
  );

CREATE POLICY "apoderados_update"
  ON apoderados FOR UPDATE
  USING  (es_dueno(cuenta_id))
  WITH CHECK (es_dueno(cuenta_id));

CREATE POLICY "apoderados_delete"
  ON apoderados FOR DELETE
  USING (es_dueno(cuenta_id));

-- ── cuotas ───────────────────────────────────────────────────────
CREATE POLICY "cuotas_select"
  ON cuotas FOR SELECT
  USING (
    cuenta_id IN (SELECT get_mis_cuentas())
    AND (
      es_dueno(cuenta_id)
      OR curso_id IN (SELECT get_mis_cursos(cuenta_id))
    )
  );

CREATE POLICY "cuotas_insert"
  ON cuotas FOR INSERT
  WITH CHECK (es_dueno(cuenta_id));

CREATE POLICY "cuotas_update"
  ON cuotas FOR UPDATE
  USING  (es_dueno(cuenta_id))
  WITH CHECK (es_dueno(cuenta_id));

CREATE POLICY "cuotas_delete"
  ON cuotas FOR DELETE
  USING (es_dueno(cuenta_id));

-- ── pagos ────────────────────────────────────────────────────────
-- CRÍTICO 2 fix: tesorero solo ve/modifica pagos de su curso.
-- El ámbito de curso se verifica accediendo al curso_id de la cuota.
CREATE POLICY "pagos_select"
  ON pagos FOR SELECT
  USING (
    cuenta_id IN (SELECT get_mis_cuentas())
    AND (
      es_dueno(cuenta_id)
      OR _curso_de_cuota(cuenta_id, cuota_id) IN
         (SELECT get_mis_cursos(cuenta_id))
    )
  );

CREATE POLICY "pagos_insert"
  ON pagos FOR INSERT
  WITH CHECK (
    es_dueno(cuenta_id)
    OR tiene_rol_en_curso(
         cuenta_id,
         _curso_de_cuota(cuenta_id, cuota_id),
         ARRAY['admin','tesorero']
       )
  );

CREATE POLICY "pagos_update"
  ON pagos FOR UPDATE
  USING (
    es_dueno(cuenta_id)
    OR tiene_rol_en_curso(
         cuenta_id,
         _curso_de_cuota(cuenta_id, cuota_id),
         ARRAY['admin','tesorero']
       )
  )
  WITH CHECK (
    es_dueno(cuenta_id)
    OR tiene_rol_en_curso(
         cuenta_id,
         _curso_de_cuota(cuenta_id, cuota_id),
         ARRAY['admin','tesorero']
       )
  );

CREATE POLICY "pagos_delete"
  ON pagos FOR DELETE
  USING (
    es_dueno(cuenta_id)
    OR tiene_rol_en_curso(
         cuenta_id,
         _curso_de_cuota(cuenta_id, cuota_id),
         ARRAY['admin','tesorero']
       )
  );

-- ── abonos ───────────────────────────────────────────────────────
-- Abonos comparten el ámbito de curso a través de su cuota.
CREATE POLICY "abonos_select"
  ON abonos FOR SELECT
  USING (
    cuenta_id IN (SELECT get_mis_cuentas())
    AND (
      es_dueno(cuenta_id)
      OR _curso_de_cuota(cuenta_id, cuota_id) IN
         (SELECT get_mis_cursos(cuenta_id))
    )
  );

CREATE POLICY "abonos_insert"
  ON abonos FOR INSERT
  WITH CHECK (
    es_dueno(cuenta_id)
    OR tiene_rol_en_curso(
         cuenta_id,
         _curso_de_cuota(cuenta_id, cuota_id),
         ARRAY['admin','tesorero']
       )
  );

CREATE POLICY "abonos_update"
  ON abonos FOR UPDATE
  USING (
    es_dueno(cuenta_id)
    OR tiene_rol_en_curso(
         cuenta_id,
         _curso_de_cuota(cuenta_id, cuota_id),
         ARRAY['admin','tesorero']
       )
  )
  WITH CHECK (
    es_dueno(cuenta_id)
    OR tiene_rol_en_curso(
         cuenta_id,
         _curso_de_cuota(cuenta_id, cuota_id),
         ARRAY['admin','tesorero']
       )
  );

CREATE POLICY "abonos_delete"
  ON abonos FOR DELETE
  USING (es_dueno(cuenta_id));

-- ── planes_pago ──────────────────────────────────────────────────
CREATE POLICY "planes_select"
  ON planes_pago FOR SELECT
  USING (
    cuenta_id IN (SELECT get_mis_cuentas())
    AND (
      es_dueno(cuenta_id)
      OR _curso_de_cuota(cuenta_id, cuota_id) IN
         (SELECT get_mis_cursos(cuenta_id))
    )
  );

CREATE POLICY "planes_insert"
  ON planes_pago FOR INSERT
  WITH CHECK (
    es_dueno(cuenta_id)
    OR tiene_rol_en_curso(
         cuenta_id,
         _curso_de_cuota(cuenta_id, cuota_id),
         ARRAY['admin','tesorero']
       )
  );

CREATE POLICY "planes_update"
  ON planes_pago FOR UPDATE
  USING  (es_dueno(cuenta_id))
  WITH CHECK (es_dueno(cuenta_id));

CREATE POLICY "planes_delete"
  ON planes_pago FOR DELETE
  USING (es_dueno(cuenta_id));

-- ── movimientos ──────────────────────────────────────────────────
-- v5 CRÍTICO 2 fix:
--   SELECT: invitados ven solo visible=TRUE en su curso.
--   INSERT/UPDATE/DELETE: tesorero solo en su curso.
CREATE POLICY "mov_select"
  ON movimientos FOR SELECT
  USING (
    cuenta_id IN (SELECT get_mis_cuentas())
    AND (
      -- Dueño ve todo.
      es_dueno(cuenta_id)
      OR
      -- Invitados: movimiento visible en su curso.
      (
        visible = TRUE
        AND (
          curso_id IS NULL
          OR curso_id IN (SELECT get_mis_cursos(cuenta_id))
        )
      )
    )
  );

CREATE POLICY "mov_insert"
  ON movimientos FOR INSERT
  WITH CHECK (
    es_dueno(cuenta_id)
    OR tiene_rol_en_curso(cuenta_id, curso_id, ARRAY['admin','tesorero'])
  );

CREATE POLICY "mov_update"
  ON movimientos FOR UPDATE
  USING (
    es_dueno(cuenta_id)
    OR tiene_rol_en_curso(cuenta_id, curso_id, ARRAY['admin','tesorero'])
  )
  WITH CHECK (
    es_dueno(cuenta_id)
    OR tiene_rol_en_curso(cuenta_id, curso_id, ARRAY['admin','tesorero'])
  );

CREATE POLICY "mov_delete"
  ON movimientos FOR DELETE
  USING (
    es_dueno(cuenta_id)
    OR tiene_rol_en_curso(cuenta_id, curso_id, ARRAY['admin','tesorero'])
  );

-- ── fondo_movimientos ────────────────────────────────────────────
-- v5 CRÍTICO 2 fix: tesorero limitado a c1 no puede ver ni tocar c2.
CREATE POLICY "fondo_select"
  ON fondo_movimientos FOR SELECT
  USING (
    cuenta_id IN (SELECT get_mis_cuentas())
    AND (
      es_dueno(cuenta_id)
      OR curso_id IN (SELECT get_mis_cursos(cuenta_id))
    )
  );

CREATE POLICY "fondo_insert"
  ON fondo_movimientos FOR INSERT
  WITH CHECK (
    es_dueno(cuenta_id)
    OR tiene_rol_en_curso(cuenta_id, curso_id, ARRAY['admin','tesorero'])
  );

CREATE POLICY "fondo_update"
  ON fondo_movimientos FOR UPDATE
  USING (
    es_dueno(cuenta_id)
    OR tiene_rol_en_curso(cuenta_id, curso_id, ARRAY['admin','tesorero'])
  )
  WITH CHECK (
    es_dueno(cuenta_id)
    OR tiene_rol_en_curso(cuenta_id, curso_id, ARRAY['admin','tesorero'])
  );

CREATE POLICY "fondo_delete"
  ON fondo_movimientos FOR DELETE
  USING (
    es_dueno(cuenta_id)
    OR tiene_rol_en_curso(cuenta_id, curso_id, ARRAY['admin','tesorero'])
  );

-- ── notas ────────────────────────────────────────────────────────
-- privada=TRUE → solo el dueño.
-- privada=FALSE → invitados en su curso.
CREATE POLICY "notas_select"
  ON notas FOR SELECT
  USING (
    cuenta_id IN (SELECT get_mis_cuentas())
    AND (
      es_dueno(cuenta_id)
      OR (
        privada = FALSE
        AND (
          curso_id IS NULL
          OR curso_id IN (SELECT get_mis_cursos(cuenta_id))
        )
      )
    )
  );

CREATE POLICY "notas_insert"
  ON notas FOR INSERT
  WITH CHECK (es_dueno(cuenta_id));

CREATE POLICY "notas_update"
  ON notas FOR UPDATE
  USING  (es_dueno(cuenta_id))
  WITH CHECK (es_dueno(cuenta_id));

CREATE POLICY "notas_delete"
  ON notas FOR DELETE
  USING (es_dueno(cuenta_id));

-- ── usuarios_cuenta ──────────────────────────────────────────────
-- Lectura: dueño ve todos; invitados se ven a sí mismos.
CREATE POLICY "uc_select"
  ON usuarios_cuenta FOR SELECT
  USING (
    es_dueno(cuenta_id)
    OR auth_id = auth.uid()
  );

CREATE POLICY "uc_insert"
  ON usuarios_cuenta FOR INSERT
  WITH CHECK (es_dueno(cuenta_id));

CREATE POLICY "uc_update"
  ON usuarios_cuenta FOR UPDATE
  USING  (es_dueno(cuenta_id))
  WITH CHECK (es_dueno(cuenta_id));

CREATE POLICY "uc_delete"
  ON usuarios_cuenta FOR DELETE
  USING (es_dueno(cuenta_id));

-- ── usuarios_externos ────────────────────────────────────────────
CREATE POLICY "ext_select"
  ON usuarios_externos FOR SELECT
  USING (es_dueno(cuenta_id));

CREATE POLICY "ext_insert"
  ON usuarios_externos FOR INSERT
  WITH CHECK (es_dueno(cuenta_id));

CREATE POLICY "ext_update"
  ON usuarios_externos FOR UPDATE
  USING  (es_dueno(cuenta_id))
  WITH CHECK (es_dueno(cuenta_id));

CREATE POLICY "ext_delete"
  ON usuarios_externos FOR DELETE
  USING (es_dueno(cuenta_id));

-- ── codigos_invitacion ───────────────────────────────────────────
CREATE POLICY "ci_select"
  ON codigos_invitacion FOR SELECT
  USING (es_dueno(cuenta_id));

CREATE POLICY "ci_insert"
  ON codigos_invitacion FOR INSERT
  WITH CHECK (es_dueno(cuenta_id));

CREATE POLICY "ci_update"
  ON codigos_invitacion FOR UPDATE
  USING  (es_dueno(cuenta_id))
  WITH CHECK (es_dueno(cuenta_id));

CREATE POLICY "ci_delete"
  ON codigos_invitacion FOR DELETE
  USING (es_dueno(cuenta_id));

-- ── config_cuenta ────────────────────────────────────────────────
CREATE POLICY "cfg_select"
  ON config_cuenta FOR SELECT
  USING (cuenta_id IN (SELECT get_mis_cuentas()));

CREATE POLICY "cfg_insert"
  ON config_cuenta FOR INSERT
  WITH CHECK (es_dueno(cuenta_id));

CREATE POLICY "cfg_update"
  ON config_cuenta FOR UPDATE
  USING  (es_dueno(cuenta_id))
  WITH CHECK (es_dueno(cuenta_id));

CREATE POLICY "cfg_delete"
  ON config_cuenta FOR DELETE
  USING (es_dueno(cuenta_id));

-- ── staging (schema _staging) ────────────────────────────────────
-- _staging.tesorero_datos tiene RLS habilitado sin políticas públicas.
-- El VIEW público 'tesorero_datos' tampoco tiene políticas.
-- Solo service_role (superuser) puede acceder.
ALTER TABLE _staging.tesorero_datos ENABLE ROW LEVEL SECURITY;