-- ═══════════════════════════════════════════════════════
-- TESORERO — Datos de demostración
-- Ejecutar DESPUÉS de 001_initial_schema.sql
-- IMPORTANTE: Solo para entornos de desarrollo/demo
-- ═══════════════════════════════════════════════════════

-- Nota: Los usuarios reales se crean a través de Supabase Auth.
-- Este seed crea los registros directamente en la tabla 'usuarios'
-- para demo. En producción, los usuarios se crean mediante registro.

-- ─── COLEGIOS ─────────────────────────────────────────
INSERT INTO colegios (id, nombre, ciudad, region, activo) VALUES
  ('col-0001-0000-0000-000000000001', 'Colegio San Martín',    'Santiago',    'Metropolitana', TRUE),
  ('col-0001-0000-0000-000000000002', 'Colegio Gabriela Mistral', 'Valparaíso', 'Valparaíso',  TRUE);

-- ─── USUARIOS DEMO ────────────────────────────────────
-- En producción NO insertes aquí; usa Supabase Auth → Users
-- Estos IDs deben coincidir con los de auth.users
INSERT INTO usuarios (id, email, nombre_completo, rol, activo) VALUES
  ('usr-0000-0000-0000-000000000001', 'admin@tesorero.cl',        'Administrador Sistema', 'superadmin', TRUE),
  ('usr-0000-0000-0000-000000000002', 'maria@5basicoa.cl',        'María González Pérez',  'tesorero',   TRUE),
  ('usr-0000-0000-0000-000000000003', 'carlos@6basicob.cl',       'Carlos Rojas Silva',    'tesorero',   TRUE)
ON CONFLICT (id) DO NOTHING;

-- ─── CURSOS ───────────────────────────────────────────
INSERT INTO cursos (id, colegio_id, nombre, anio_academico, tesorero_id, codigo_acceso, cuota_mensual_clp, cuota_anual_clp, meta_anual_clp, activo) VALUES
  ('cur-0001-0000-0000-000000000001', 'col-0001-0000-0000-000000000001', '5° Básico A', 2026, 'usr-0000-0000-0000-000000000002', '5BA-2026-MK7X', 5000, 40000, 600000, TRUE),
  ('cur-0001-0000-0000-000000000002', 'col-0001-0000-0000-000000000001', '6° Básico B', 2026, 'usr-0000-0000-0000-000000000003', '6BB-2026-PQ3Y', 5000, 40000, 600000, TRUE);

-- ─── CURSO_USUARIOS ───────────────────────────────────
INSERT INTO curso_usuarios (curso_id, usuario_id, rol_en_curso, activo) VALUES
  ('cur-0001-0000-0000-000000000001', 'usr-0000-0000-0000-000000000002', 'tesorero',          TRUE),
  ('cur-0001-0000-0000-000000000002', 'usr-0000-0000-0000-000000000003', 'tesorero',          TRUE),
  ('cur-0001-0000-0000-000000000001', 'usr-0000-0000-0000-000000000001', 'tesorero',          TRUE),
  ('cur-0001-0000-0000-000000000002', 'usr-0000-0000-0000-000000000001', 'tesorero',          TRUE);

-- ─── ALUMNOS (5° Básico A) ────────────────────────────
INSERT INTO alumnos (id, curso_id, nombres, apellidos, estado) VALUES
  ('alu-0001-0000-0000-000000000001', 'cur-0001-0000-0000-000000000001', 'Sofía',      'Martínez López',  'activo'),
  ('alu-0001-0000-0000-000000000002', 'cur-0001-0000-0000-000000000001', 'Matías',     'González Pérez',  'activo'),
  ('alu-0001-0000-0000-000000000003', 'cur-0001-0000-0000-000000000001', 'Valentina',  'Rojas Silva',     'activo'),
  ('alu-0001-0000-0000-000000000004', 'cur-0001-0000-0000-000000000001', 'Benjamín',   'López Torres',    'activo'),
  ('alu-0001-0000-0000-000000000005', 'cur-0001-0000-0000-000000000001', 'Catalina',   'Soto Morales',    'activo'),
  ('alu-0001-0000-0000-000000000006', 'cur-0001-0000-0000-000000000001', 'Diego',      'Vega Castro',     'activo'),
  ('alu-0001-0000-0000-000000000007', 'cur-0001-0000-0000-000000000001', 'Isidora',    'Muñoz Bravo',     'activo'),
  ('alu-0001-0000-0000-000000000008', 'cur-0001-0000-0000-000000000001', 'Agustín',    'Fuentes Díaz',    'activo');

-- Alumnos (6° Básico B)
INSERT INTO alumnos (id, curso_id, nombres, apellidos, estado) VALUES
  ('alu-0001-0000-0000-000000000009', 'cur-0001-0000-0000-000000000002', 'Renata',     'Pino Araya',      'activo'),
  ('alu-0001-0000-0000-000000000010', 'cur-0001-0000-0000-000000000002', 'Tomás',      'Caro Vidal',      'activo');

-- ─── APODERADOS ───────────────────────────────────────
INSERT INTO apoderados (alumno_id, nombre_completo, telefono, email, relacion) VALUES
  ('alu-0001-0000-0000-000000000001', 'Claudia López Ramos',    '+56 9 8765 4321', 'clopez@mail.cl',    'Madre'),
  ('alu-0001-0000-0000-000000000002', 'Roberto González Vera',  '+56 9 7654 3210', 'rgonzalez@mail.cl', 'Padre'),
  ('alu-0001-0000-0000-000000000003', 'Ana Silva Moreno',       '+56 9 6543 2109', 'asilva@mail.cl',    'Madre'),
  ('alu-0001-0000-0000-000000000004', 'Pedro Torres Campos',    '+56 9 5432 1098', 'ptorres@mail.cl',   'Padre'),
  ('alu-0001-0000-0000-000000000005', 'Marcela Morales Soto',   '+56 9 4321 0987', 'mmorales@mail.cl',  'Madre'),
  ('alu-0001-0000-0000-000000000006', 'Rodrigo Vega Palma',     '+56 9 3210 9876', 'rvega@mail.cl',     'Padre'),
  ('alu-0001-0000-0000-000000000007', 'Pamela Bravo Núñez',     '+56 9 2109 8765', 'pbravo@mail.cl',    'Madre'),
  ('alu-0001-0000-0000-000000000008', 'Hernán Fuentes Reyes',   '+56 9 1098 7654', 'hfuentes@mail.cl',  'Padre');

-- ─── CUOTAS ───────────────────────────────────────────
INSERT INTO cuotas (id, curso_id, tipo_cuota, nombre, monto_clp, anio, activa, observaciones) VALUES
  ('qta-0001-0000-0000-000000000001', 'cur-0001-0000-0000-000000000001', 'mensual',     'Cuota Mensual 2026', 5000,  2026, TRUE, 'Vence el día 10 de cada mes'),
  ('qta-0001-0000-0000-000000000002', 'cur-0001-0000-0000-000000000001', 'anual',       'Cuota Anual 2026',   40000, 2026, TRUE, 'Pagadera idealmente en marzo'),
  ('qta-0001-0000-0000-000000000003', 'cur-0001-0000-0000-000000000002', 'mensual',     'Cuota Mensual 2026', 5000,  2026, TRUE, 'Vence el día 10 de cada mes'),
  ('qta-0001-0000-0000-000000000004', 'cur-0001-0000-0000-000000000002', 'anual',       'Cuota Anual 2026',   40000, 2026, TRUE, NULL);

-- ─── PAGOS (5° Básico A - Cuota Mensual) ──────────────
INSERT INTO pagos (cuota_id, alumno_id, monto_pagado, periodo, fecha_pago, medio_pago, estado, creado_por) VALUES
  -- Enero: todos pagaron
  ('qta-0001-0000-0000-000000000001', 'alu-0001-0000-0000-000000000001', 5000, 'Enero',    '2026-01-08', 'Transferencia', 'pagado', 'usr-0000-0000-0000-000000000002'),
  ('qta-0001-0000-0000-000000000001', 'alu-0001-0000-0000-000000000002', 5000, 'Enero',    '2026-01-09', 'Efectivo',      'pagado', 'usr-0000-0000-0000-000000000002'),
  ('qta-0001-0000-0000-000000000001', 'alu-0001-0000-0000-000000000003', 5000, 'Enero',    '2026-01-10', 'Transferencia', 'pagado', 'usr-0000-0000-0000-000000000002'),
  ('qta-0001-0000-0000-000000000001', 'alu-0001-0000-0000-000000000004', 5000, 'Enero',    '2026-01-10', 'Transferencia', 'pagado', 'usr-0000-0000-0000-000000000002'),
  ('qta-0001-0000-0000-000000000001', 'alu-0001-0000-0000-000000000005', 5000, 'Enero',    '2026-01-12', 'Efectivo',      'pagado', 'usr-0000-0000-0000-000000000002'),
  ('qta-0001-0000-0000-000000000001', 'alu-0001-0000-0000-000000000006', 5000, 'Enero',    '2026-01-08', 'Transferencia', 'pagado', 'usr-0000-0000-0000-000000000002'),
  ('qta-0001-0000-0000-000000000001', 'alu-0001-0000-0000-000000000007', 5000, 'Enero',    '2026-01-09', 'Efectivo',      'pagado', 'usr-0000-0000-0000-000000000002'),
  ('qta-0001-0000-0000-000000000001', 'alu-0001-0000-0000-000000000008', 5000, 'Enero',    '2026-01-10', 'Transferencia', 'pagado', 'usr-0000-0000-0000-000000000002'),
  -- Febrero: 6/8 pagaron
  ('qta-0001-0000-0000-000000000001', 'alu-0001-0000-0000-000000000001', 5000, 'Febrero',  '2026-02-06', 'Transferencia', 'pagado', 'usr-0000-0000-0000-000000000002'),
  ('qta-0001-0000-0000-000000000001', 'alu-0001-0000-0000-000000000002', 5000, 'Febrero',  '2026-02-07', 'Efectivo',      'pagado', 'usr-0000-0000-0000-000000000002'),
  ('qta-0001-0000-0000-000000000001', 'alu-0001-0000-0000-000000000003', 5000, 'Febrero',  '2026-02-08', 'Transferencia', 'pagado', 'usr-0000-0000-0000-000000000002'),
  ('qta-0001-0000-0000-000000000001', 'alu-0001-0000-0000-000000000004', 5000, 'Febrero',  '2026-02-09', 'Efectivo',      'pagado', 'usr-0000-0000-0000-000000000002'),
  ('qta-0001-0000-0000-000000000001', 'alu-0001-0000-0000-000000000005', 5000, 'Febrero',  '2026-02-10', 'Transferencia', 'pagado', 'usr-0000-0000-0000-000000000002'),
  ('qta-0001-0000-0000-000000000001', 'alu-0001-0000-0000-000000000006', 5000, 'Febrero',  '2026-02-11', 'Transferencia', 'pagado', 'usr-0000-0000-0000-000000000002'),
  -- Marzo: 4/8 pagaron
  ('qta-0001-0000-0000-000000000001', 'alu-0001-0000-0000-000000000001', 5000, 'Marzo',    '2026-03-07', 'Transferencia', 'pagado', 'usr-0000-0000-0000-000000000002'),
  ('qta-0001-0000-0000-000000000001', 'alu-0001-0000-0000-000000000002', 5000, 'Marzo',    '2026-03-08', 'Efectivo',      'pagado', 'usr-0000-0000-0000-000000000002'),
  ('qta-0001-0000-0000-000000000001', 'alu-0001-0000-0000-000000000003', 5000, 'Marzo',    '2026-03-09', 'Transferencia', 'pagado', 'usr-0000-0000-0000-000000000002'),
  ('qta-0001-0000-0000-000000000001', 'alu-0001-0000-0000-000000000005', 5000, 'Marzo',    '2026-03-10', 'Efectivo',      'pagado', 'usr-0000-0000-0000-000000000002'),
  -- Cuota anual: 3/8 pagaron
  ('qta-0001-0000-0000-000000000002', 'alu-0001-0000-0000-000000000001', 40000, 'Anual 2026', '2026-03-01', 'Transferencia', 'pagado', 'usr-0000-0000-0000-000000000002'),
  ('qta-0001-0000-0000-000000000002', 'alu-0001-0000-0000-000000000002', 40000, 'Anual 2026', '2026-03-02', 'Transferencia', 'pagado', 'usr-0000-0000-0000-000000000002'),
  ('qta-0001-0000-0000-000000000002', 'alu-0001-0000-0000-000000000003', 40000, 'Anual 2026', '2026-03-03', 'Efectivo',      'pagado', 'usr-0000-0000-0000-000000000002');

-- ─── MOVIMIENTOS FINANCIEROS ──────────────────────────
INSERT INTO movimientos_financieros (curso_id, tipo_movimiento, descripcion, monto_clp, fecha_movimiento, responsable, visible_para_apoderados, creado_por) VALUES
  ('cur-0001-0000-0000-000000000001', 'gasto',   'Materiales de arte 1er semestre',    15000, '2026-03-10', 'María González', TRUE,  'usr-0000-0000-0000-000000000002'),
  ('cur-0001-0000-0000-000000000001', 'ingreso', 'Rifa de chocolates San Valentín',    28500, '2026-02-14', 'María González', TRUE,  'usr-0000-0000-0000-000000000002'),
  ('cur-0001-0000-0000-000000000001', 'gasto',   'Decoración bienvenida 2026',         12000, '2026-03-04', 'María González', TRUE,  'usr-0000-0000-0000-000000000002'),
  ('cur-0001-0000-0000-000000000001', 'gasto',   'Fotocopias y útiles marzo',           4200, '2026-03-14', 'María González', TRUE,  'usr-0000-0000-0000-000000000002'),
  ('cur-0001-0000-0000-000000000001', 'ingreso', 'Donación voluntaria apoderado',      10000, '2026-02-20', 'María González', FALSE, 'usr-0000-0000-0000-000000000002');

-- ─── VERIFICAR DATOS ──────────────────────────────────
SELECT 'colegios'  AS tabla, COUNT(*) AS total FROM colegios  UNION ALL
SELECT 'cursos',               COUNT(*) FROM cursos           UNION ALL
SELECT 'usuarios',             COUNT(*) FROM usuarios         UNION ALL
SELECT 'alumnos',              COUNT(*) FROM alumnos          UNION ALL
SELECT 'apoderados',           COUNT(*) FROM apoderados       UNION ALL
SELECT 'cuotas',               COUNT(*) FROM cuotas           UNION ALL
SELECT 'pagos',                COUNT(*) FROM pagos            UNION ALL
SELECT 'movimientos',          COUNT(*) FROM movimientos_financieros;
