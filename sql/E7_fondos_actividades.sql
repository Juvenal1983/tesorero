-- ══════════════════════════════════════════════════════════════════════════════
-- E7: Fondos especiales · Actividades · Reportes
-- ──────────────────────────────────────────────────────────────────────────────
-- Ejecutar en staging ANTES de probar E7.
-- NO ejecutar en producción hasta aprobación explícita.
-- Producción: https://tmjqzaakzhecbldebyeg.supabase.co — NO TOCAR.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. Tabla actividades ──────────────────────────────────────────────────────
-- Registra eventos de recaudación de fondos individuales por alumno.
-- (peñas, rifas, ventas, sorteos, etc.)
-- Anteriormente almacenado en DB.actividades (localStorage).
-- Campos espejo del formato legado:
--   cursoId   → curso_id
--   nombre    → nombre
--   montoTotal → monto_total
--   fecha     → fecha
--   obs       → obs
--   participantes (JSONB array de alumno_ids)

CREATE TABLE IF NOT EXISTS actividades (
  cuenta_id      UUID  NOT NULL,
  id             TEXT  NOT NULL,
  curso_id       TEXT,
  nombre         TEXT  NOT NULL,
  monto_total    INT   DEFAULT 0  CHECK (monto_total >= 0),
  participantes  JSONB,  -- array de alumno_ids
  fecha          DATE,
  obs            TEXT,
  creado_por     TEXT,
  PRIMARY KEY (cuenta_id, id),
  FOREIGN KEY (cuenta_id, curso_id)
    REFERENCES cursos(cuenta_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);

-- ── 2. RLS para actividades ───────────────────────────────────────────────────

ALTER TABLE actividades ENABLE ROW LEVEL SECURITY;

CREATE POLICY "actividades_select"
  ON actividades FOR SELECT
  USING (
    cuenta_id IN (SELECT get_mis_cuentas())
    AND (
      es_dueno(cuenta_id)
      OR curso_id IN (SELECT get_mis_cursos(cuenta_id))
    )
  );

CREATE POLICY "actividades_insert"
  ON actividades FOR INSERT
  WITH CHECK (
    es_dueno(cuenta_id)
    OR tiene_rol_en_curso(cuenta_id, curso_id, ARRAY['admin','tesorero'])
  );

CREATE POLICY "actividades_update"
  ON actividades FOR UPDATE
  USING (
    es_dueno(cuenta_id)
    OR tiene_rol_en_curso(cuenta_id, curso_id, ARRAY['admin','tesorero'])
  )
  WITH CHECK (
    es_dueno(cuenta_id)
    OR tiene_rol_en_curso(cuenta_id, curso_id, ARRAY['admin','tesorero'])
  );

CREATE POLICY "actividades_delete"
  ON actividades FOR DELETE
  USING (
    es_dueno(cuenta_id)
    OR tiene_rol_en_curso(cuenta_id, curso_id, ARRAY['admin','tesorero'])
  );

-- ── 3. GRANTs para actividades ────────────────────────────────────────────────

REVOKE ALL ON TABLE public.actividades FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.actividades TO authenticated;
GRANT ALL                            ON TABLE public.actividades TO service_role;

-- ── 4. GRANTs para fondo_movimientos (si no existen ya) ──────────────────────
-- fondo_movimientos existe en 01_schema.sql y 07_grants_supabase.sql.
-- Este bloque es idempotente: solo emite GRANT si se necesita.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.fondo_movimientos TO authenticated;
GRANT ALL                            ON TABLE public.fondo_movimientos TO service_role;

-- ── 5. Comentarios descriptivos ───────────────────────────────────────────────

COMMENT ON TABLE actividades IS
  'Actividades de recaudación de fondo especial por curso (peñas, rifas, ventas, etc.). '
  'Migración de DB.actividades (localStorage) → PostgreSQL para modo V9_RELACIONAL.';

COMMENT ON TABLE fondo_movimientos IS
  'Movimientos del fondo especial por curso (aportes, rendimientos, actividades, multas). '
  'Tipos: aporte | rendimiento | actividad | multa | ingreso | egreso.';
