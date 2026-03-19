-- ═══════════════════════════════════════════════════════
-- TESORERO — Migración inicial completa
-- Ejecutar en el SQL Editor de Supabase
-- ═══════════════════════════════════════════════════════

-- Habilitar extensión UUID
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── ENUMS ────────────────────────────────────────────
CREATE TYPE rol_usuario AS ENUM ('superadmin', 'tesorero', 'apoderado_lector');
CREATE TYPE rol_en_curso AS ENUM ('tesorero', 'apoderado_lector', 'colaborador');
CREATE TYPE estado_alumno AS ENUM ('activo', 'retirado', 'suspendido');
CREATE TYPE tipo_cuota AS ENUM ('mensual', 'anual', 'extraordinaria');
CREATE TYPE estado_pago AS ENUM ('pagado', 'anulado', 'parcial');
CREATE TYPE tipo_movimiento AS ENUM ('ingreso', 'gasto');

-- ─── USUARIOS ─────────────────────────────────────────
CREATE TABLE usuarios (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       VARCHAR(255) NOT NULL UNIQUE,
  nombre_completo VARCHAR(255) NOT NULL,
  rol         rol_usuario NOT NULL DEFAULT 'tesorero',
  activo      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger: crear perfil al registrar usuario en Supabase Auth
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO usuarios (id, email, nombre_completo, rol)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'nombre_completo', split_part(NEW.email, '@', 1)),
    COALESCE((NEW.raw_user_meta_data->>'rol')::rol_usuario, 'tesorero')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- Trigger: updated_at automático
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- ─── COLEGIOS ─────────────────────────────────────────
CREATE TABLE colegios (
  id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre  VARCHAR(255) NOT NULL,
  ciudad  VARCHAR(100),
  region  VARCHAR(100),
  activo  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── CURSOS ───────────────────────────────────────────
CREATE TABLE cursos (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  colegio_id          UUID NOT NULL REFERENCES colegios(id) ON DELETE CASCADE,
  nombre              VARCHAR(100) NOT NULL,
  anio_academico      INTEGER NOT NULL CHECK (anio_academico >= 2020 AND anio_academico <= 2099),
  tesorero_id         UUID REFERENCES usuarios(id),
  codigo_acceso       VARCHAR(30) NOT NULL UNIQUE,
  cuota_mensual_clp   INTEGER NOT NULL DEFAULT 0 CHECK (cuota_mensual_clp >= 0),
  cuota_anual_clp     INTEGER NOT NULL DEFAULT 0 CHECK (cuota_anual_clp >= 0),
  meta_anual_clp      INTEGER NOT NULL DEFAULT 0,
  activo              BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TRIGGER cursos_updated_at BEFORE UPDATE ON cursos FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── CURSO_USUARIOS (N:M) ─────────────────────────────
CREATE TABLE curso_usuarios (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  curso_id     UUID NOT NULL REFERENCES cursos(id) ON DELETE CASCADE,
  usuario_id   UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  rol_en_curso rol_en_curso NOT NULL DEFAULT 'tesorero',
  activo       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(curso_id, usuario_id)
);

-- ─── ALUMNOS ──────────────────────────────────────────
CREATE TABLE alumnos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  curso_id      UUID NOT NULL REFERENCES cursos(id) ON DELETE CASCADE,
  nombres       VARCHAR(100) NOT NULL,
  apellidos     VARCHAR(100) NOT NULL,
  estado        estado_alumno NOT NULL DEFAULT 'activo',
  observaciones TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_alumnos_curso ON alumnos(curso_id);
CREATE TRIGGER alumnos_updated_at BEFORE UPDATE ON alumnos FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── APODERADOS ───────────────────────────────────────
CREATE TABLE apoderados (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alumno_id       UUID NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
  usuario_app_id  UUID REFERENCES usuarios(id),
  nombre_completo VARCHAR(255) NOT NULL,
  telefono        VARCHAR(30),
  email           VARCHAR(255),
  relacion        VARCHAR(50),
  estado          VARCHAR(20) NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo', 'inactivo')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_apoderados_alumno ON apoderados(alumno_id);
CREATE TRIGGER apoderados_updated_at BEFORE UPDATE ON apoderados FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── CUOTAS ───────────────────────────────────────────
CREATE TABLE cuotas (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  curso_id          UUID NOT NULL REFERENCES cursos(id) ON DELETE CASCADE,
  tipo_cuota        tipo_cuota NOT NULL,
  nombre            VARCHAR(200) NOT NULL,
  monto_clp         INTEGER NOT NULL CHECK (monto_clp > 0),
  fecha_vencimiento DATE,
  periodo           VARCHAR(50),
  anio              INTEGER NOT NULL,
  activa            BOOLEAN NOT NULL DEFAULT TRUE,
  observaciones     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_cuotas_curso ON cuotas(curso_id);

-- ─── PAGOS ────────────────────────────────────────────
CREATE TABLE pagos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cuota_id        UUID NOT NULL REFERENCES cuotas(id) ON DELETE CASCADE,
  alumno_id       UUID NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
  apoderado_id    UUID REFERENCES apoderados(id),
  monto_pagado    INTEGER NOT NULL CHECK (monto_pagado > 0),
  periodo         VARCHAR(50) NOT NULL,
  fecha_pago      DATE NOT NULL,
  medio_pago      VARCHAR(50) NOT NULL DEFAULT 'Transferencia',
  estado          estado_pago NOT NULL DEFAULT 'pagado',
  comprobante_url TEXT,
  observaciones   TEXT,
  creado_por      UUID REFERENCES usuarios(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_pagos_cuota ON pagos(cuota_id);
CREATE INDEX idx_pagos_alumno ON pagos(alumno_id);
CREATE TRIGGER pagos_updated_at BEFORE UPDATE ON pagos FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── CATEGORÍAS DE MOVIMIENTOS ────────────────────────
CREATE TABLE categorias_movimientos (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  curso_id UUID REFERENCES cursos(id) ON DELETE CASCADE,  -- NULL = global
  nombre   VARCHAR(100) NOT NULL,
  tipo     VARCHAR(20) NOT NULL DEFAULT 'ambos' CHECK (tipo IN ('ingreso', 'gasto', 'ambos')),
  activa   BOOLEAN NOT NULL DEFAULT TRUE,
  orden    INTEGER NOT NULL DEFAULT 0
);

-- Categorías globales iniciales
INSERT INTO categorias_movimientos (nombre, tipo, orden) VALUES
  ('Cuota de curso',     'ingreso', 1),
  ('Rifa',               'ingreso', 2),
  ('Donación',           'ingreso', 3),
  ('Venta',              'ingreso', 4),
  ('Evento (ingreso)',   'ingreso', 5),
  ('Materiales',         'gasto',   10),
  ('Convivencia',        'gasto',   11),
  ('Paseo',              'gasto',   12),
  ('Regalo profesor',    'gasto',   13),
  ('Evento (gasto)',     'gasto',   14),
  ('Transporte',         'gasto',   15),
  ('Alimentación',       'gasto',   16),
  ('Fotocopias',         'gasto',   17),
  ('Imprevistos',        'ambos',   20),
  ('Otro',               'ambos',   99);

-- ─── MOVIMIENTOS FINANCIEROS ──────────────────────────
CREATE TABLE movimientos_financieros (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  curso_id                  UUID NOT NULL REFERENCES cursos(id) ON DELETE CASCADE,
  tipo_movimiento           tipo_movimiento NOT NULL,
  categoria_id              UUID REFERENCES categorias_movimientos(id),
  descripcion               VARCHAR(500) NOT NULL,
  monto_clp                 INTEGER NOT NULL CHECK (monto_clp > 0),
  fecha_movimiento          DATE NOT NULL,
  responsable               VARCHAR(255),
  observaciones             TEXT,
  archivo_url               TEXT,
  visible_para_apoderados   BOOLEAN NOT NULL DEFAULT TRUE,
  creado_por                UUID REFERENCES usuarios(id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_movimientos_curso ON movimientos_financieros(curso_id);
CREATE INDEX idx_movimientos_visible ON movimientos_financieros(curso_id, visible_para_apoderados);
CREATE TRIGGER movimientos_updated_at BEFORE UPDATE ON movimientos_financieros FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── AUDITORÍA ────────────────────────────────────────
CREATE TABLE auditoria (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id        UUID REFERENCES usuarios(id),
  accion            VARCHAR(100) NOT NULL,
  tabla_afectada    VARCHAR(100) NOT NULL,
  registro_id       UUID,
  datos_anteriores  JSONB,
  datos_nuevos      JSONB,
  ip_address        VARCHAR(50),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_auditoria_usuario ON auditoria(usuario_id);
CREATE INDEX idx_auditoria_tabla ON auditoria(tabla_afectada, registro_id);

-- ═══════════════════════════════════════════════════════
-- ROW LEVEL SECURITY (RLS)
-- ═══════════════════════════════════════════════════════

ALTER TABLE usuarios              ENABLE ROW LEVEL SECURITY;
ALTER TABLE colegios              ENABLE ROW LEVEL SECURITY;
ALTER TABLE cursos                ENABLE ROW LEVEL SECURITY;
ALTER TABLE curso_usuarios        ENABLE ROW LEVEL SECURITY;
ALTER TABLE alumnos               ENABLE ROW LEVEL SECURITY;
ALTER TABLE apoderados            ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuotas                ENABLE ROW LEVEL SECURITY;
ALTER TABLE pagos                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE categorias_movimientos ENABLE ROW LEVEL SECURITY;
ALTER TABLE movimientos_financieros ENABLE ROW LEVEL SECURITY;
ALTER TABLE auditoria             ENABLE ROW LEVEL SECURITY;

-- Helper function: obtener rol del usuario en un curso
CREATE OR REPLACE FUNCTION get_rol_en_curso(p_curso_id UUID, p_user_id UUID DEFAULT auth.uid())
RETURNS TEXT AS $$
  SELECT rol_en_curso::TEXT FROM curso_usuarios
  WHERE curso_id = p_curso_id AND usuario_id = p_user_id AND activo = TRUE
  LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Helper: ¿es superadmin?
CREATE OR REPLACE FUNCTION es_superadmin(p_user_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN AS $$
  SELECT EXISTS (SELECT 1 FROM usuarios WHERE id = p_user_id AND rol = 'superadmin');
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ── Usuarios: cada uno ve su propio perfil, superadmin ve todos ──
CREATE POLICY "usuarios_select" ON usuarios FOR SELECT
  USING (id = auth.uid() OR es_superadmin());

CREATE POLICY "usuarios_update_self" ON usuarios FOR UPDATE
  USING (id = auth.uid());

-- ── Colegios: visibles para todos los autenticados ──
CREATE POLICY "colegios_select" ON colegios FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "colegios_insert" ON colegios FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- ── Cursos: solo los cursos a los que pertenece el usuario ──
CREATE POLICY "cursos_select" ON cursos FOR SELECT
  USING (
    es_superadmin() OR
    EXISTS (SELECT 1 FROM curso_usuarios WHERE curso_id = id AND usuario_id = auth.uid() AND activo = TRUE)
  );

CREATE POLICY "cursos_insert" ON cursos FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "cursos_update" ON cursos FOR UPDATE
  USING (
    es_superadmin() OR
    tesorero_id = auth.uid() OR
    get_rol_en_curso(id) = 'tesorero'
  );

-- ── curso_usuarios ──
CREATE POLICY "cu_select" ON curso_usuarios FOR SELECT
  USING (usuario_id = auth.uid() OR es_superadmin());

CREATE POLICY "cu_insert" ON curso_usuarios FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- ── Alumnos: tesorero y colaborador pueden leer y escribir; lector solo leer ──
CREATE POLICY "alumnos_select" ON alumnos FOR SELECT
  USING (
    es_superadmin() OR
    get_rol_en_curso(curso_id) IS NOT NULL
  );

CREATE POLICY "alumnos_insert" ON alumnos FOR INSERT
  WITH CHECK (
    es_superadmin() OR
    get_rol_en_curso(curso_id) IN ('tesorero', 'colaborador')
  );

CREATE POLICY "alumnos_update" ON alumnos FOR UPDATE
  USING (
    es_superadmin() OR
    get_rol_en_curso(curso_id) IN ('tesorero', 'colaborador')
  );

CREATE POLICY "alumnos_delete" ON alumnos FOR DELETE
  USING (
    es_superadmin() OR
    get_rol_en_curso(curso_id) = 'tesorero'
  );

-- ── Apoderados: datos privados, solo tesorero ──
CREATE POLICY "apoderados_select" ON apoderados FOR SELECT
  USING (
    es_superadmin() OR
    EXISTS (
      SELECT 1 FROM alumnos a
      WHERE a.id = alumno_id
      AND get_rol_en_curso(a.curso_id) IN ('tesorero', 'colaborador')
    )
  );

CREATE POLICY "apoderados_insert" ON apoderados FOR INSERT
  WITH CHECK (
    es_superadmin() OR
    EXISTS (
      SELECT 1 FROM alumnos a
      WHERE a.id = alumno_id
      AND get_rol_en_curso(a.curso_id) IN ('tesorero', 'colaborador')
    )
  );

CREATE POLICY "apoderados_delete" ON apoderados FOR DELETE
  USING (
    es_superadmin() OR
    EXISTS (
      SELECT 1 FROM alumnos a
      WHERE a.id = alumno_id
      AND get_rol_en_curso(a.curso_id) = 'tesorero'
    )
  );

-- ── Cuotas ──
CREATE POLICY "cuotas_select" ON cuotas FOR SELECT
  USING (es_superadmin() OR get_rol_en_curso(curso_id) IS NOT NULL);

CREATE POLICY "cuotas_write" ON cuotas FOR ALL
  USING (es_superadmin() OR get_rol_en_curso(curso_id) = 'tesorero');

-- ── Pagos: solo tesorero puede leer detalle individual ──
CREATE POLICY "pagos_select_tesorero" ON pagos FOR SELECT
  USING (
    es_superadmin() OR
    EXISTS (
      SELECT 1 FROM cuotas q
      WHERE q.id = cuota_id
      AND get_rol_en_curso(q.curso_id) IN ('tesorero', 'colaborador')
    )
  );

CREATE POLICY "pagos_insert" ON pagos FOR INSERT
  WITH CHECK (
    es_superadmin() OR
    EXISTS (
      SELECT 1 FROM cuotas q
      WHERE q.id = cuota_id
      AND get_rol_en_curso(q.curso_id) IN ('tesorero', 'colaborador')
    )
  );

CREATE POLICY "pagos_update" ON pagos FOR UPDATE
  USING (
    es_superadmin() OR
    EXISTS (
      SELECT 1 FROM cuotas q WHERE q.id = cuota_id
      AND get_rol_en_curso(q.curso_id) = 'tesorero'
    )
  );

CREATE POLICY "pagos_delete" ON pagos FOR DELETE
  USING (
    es_superadmin() OR
    EXISTS (
      SELECT 1 FROM cuotas q WHERE q.id = cuota_id
      AND get_rol_en_curso(q.curso_id) = 'tesorero'
    )
  );

-- ── Categorías ──
CREATE POLICY "categorias_select" ON categorias_movimientos FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- ── Movimientos: lector solo ve los públicos ──
CREATE POLICY "movimientos_select" ON movimientos_financieros FOR SELECT
  USING (
    es_superadmin() OR
    (
      get_rol_en_curso(curso_id) IN ('tesorero', 'colaborador')
    ) OR
    (
      get_rol_en_curso(curso_id) = 'apoderado_lector'
      AND visible_para_apoderados = TRUE
    )
  );

CREATE POLICY "movimientos_write" ON movimientos_financieros FOR ALL
  USING (
    es_superadmin() OR
    get_rol_en_curso(curso_id) IN ('tesorero', 'colaborador')
  );

-- ── Auditoría: solo superadmin y el propio usuario ──
CREATE POLICY "auditoria_select" ON auditoria FOR SELECT
  USING (usuario_id = auth.uid() OR es_superadmin());

CREATE POLICY "auditoria_insert" ON auditoria FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- ═══════════════════════════════════════════════════════
-- STORAGE BUCKETS
-- ═══════════════════════════════════════════════════════
-- Ejecutar esto en el Dashboard de Supabase > Storage > New Bucket
-- O usar la API:
-- INSERT INTO storage.buckets (id, name, public) VALUES ('comprobantes', 'comprobantes', false);

-- Política de Storage: solo el tesorero puede subir/ver comprobantes de su curso
-- (Configurar en Supabase Dashboard > Storage > Policies)

-- ═══════════════════════════════════════════════════════
-- VISTA AGREGADA PARA APODERADOS (sin datos individuales)
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE VIEW resumen_publico_curso AS
SELECT
  c.id AS curso_id,
  c.nombre AS curso_nombre,
  c.anio_academico,
  col.nombre AS colegio_nombre,
  COUNT(DISTINCT a.id) FILTER (WHERE a.estado = 'activo') AS total_alumnos,
  COALESCE(SUM(p.monto_pagado) FILTER (WHERE p.estado = 'pagado'), 0) AS total_cuotas_cobradas,
  COALESCE(SUM(mf.monto_clp) FILTER (WHERE mf.tipo_movimiento = 'ingreso' AND mf.visible_para_apoderados), 0) AS total_ingresos_extra,
  COALESCE(SUM(mf.monto_clp) FILTER (WHERE mf.tipo_movimiento = 'gasto' AND mf.visible_para_apoderados), 0) AS total_gastos
FROM cursos c
LEFT JOIN colegios col ON col.id = c.colegio_id
LEFT JOIN alumnos a ON a.curso_id = c.id
LEFT JOIN cuotas q ON q.curso_id = c.id AND q.activa = TRUE
LEFT JOIN pagos p ON p.cuota_id = q.id
LEFT JOIN movimientos_financieros mf ON mf.curso_id = c.id
GROUP BY c.id, c.nombre, c.anio_academico, col.nombre;

COMMENT ON VIEW resumen_publico_curso IS
  'Vista agregada segura para apoderados lectores. No expone datos individuales.';
