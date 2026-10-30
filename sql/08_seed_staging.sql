-- ============================================================
-- El Tesorero — "El Gran Cambio" v9
-- Archivo: sql/08_seed_staging.sql  (v3 — identidad y valores verificados, no solo recuentos)
-- Propósito: Datos ficticios para el proyecto Supabase de staging.
--
-- IMPORTANTE — ANTES DE EJECUTAR:
--   1. Crea dos usuarios en Authentication → Users del dashboard de staging.
--      Usa contraseña con confirmación; NO uses "Invite user" porque
--      los correos @staging.test no existen y el link de invitación expira.
--        usuario_a@staging.test  (anota su UUID → reemplaza USER_A_UUID)
--        usuario_b@staging.test  (anota su UUID → reemplaza USER_B_UUID)
--   2. Sustituye TEXTUALMENTE cada marcador en este archivo:
--        USER_A_UUID  →  UUID real del usuario A en Auth (xxxxxxxx-xxxx-...)
--        USER_B_UUID  →  UUID real del usuario B en Auth
--      El script abortará si detecta marcadores sin sustituir.
--   3. Ejecuta DESPUÉS de: 01_schema.sql → 02_rls.sql → 07_grants_supabase.sql
--   4. El script se ejecuta en una transacción explícita y hace ROLLBACK si
--      hay errores. Es IDEMPOTENTE: usa INSERT ... ON CONFLICT DO NOTHING,
--      pero verifica al final que los datos son los esperados.
--   5. Los INSERT con ON CONFLICT DO NOTHING no actualizan filas que ya existen;
--      si los datos previos son incorrectos, limpia las tablas antes de re-ejecutar.
--
-- TODOS LOS DATOS SON FICTICIOS. Los correos usan @staging.test.
--
-- ROLES DE PRUEBA:
--   Usuario A → propietario (admin) de Cuenta A + tesorero en Cuenta B
--   Usuario B → propietario (admin) de Cuenta B
--   Prueba de aislamiento: A no debe ver datos de B que no le correspondan,
--   B no debe ver ningún dato de A.
--
-- ESTADO DEL ABONO DE PRUEBA:
--   El abono 'abono-a-01' queda en estado 'registrado' (pagado=false).
--   Es un abono pendiente de cobro. No usar para conciliación de ingresos
--   cobrados sin antes cambiarlo a 'pagado'.
-- ============================================================

BEGIN;

-- ── Verificación de marcadores sin sustituir ──────────────────
-- Si USER_A_UUID o USER_B_UUID no fueron reemplazados, el cast a UUID
-- fallará aquí con un error claro antes de insertar datos inconsistentes.
DO $$
DECLARE
  uuid_a UUID;
  uuid_b UUID;
BEGIN
  BEGIN
    uuid_a := 'USER_A_UUID'::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'USER_A_UUID no fue sustituido. Reemplaza el marcador con el UUID real del usuario A en Auth.';
  END;

  BEGIN
    uuid_b := 'USER_B_UUID'::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'USER_B_UUID no fue sustituido. Reemplaza el marcador con el UUID real del usuario B en Auth.';
  END;

  IF uuid_a = uuid_b THEN
    RAISE EXCEPTION 'USER_A_UUID y USER_B_UUID son idénticos (%). Deben corresponder a usuarios distintos.', uuid_a;
  END IF;

  -- Verificar que los usuarios existen en auth.users
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = uuid_a) THEN
    RAISE EXCEPTION 'USER_A_UUID (%) no existe en auth.users. Crea el usuario en Authentication primero.', uuid_a;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = uuid_b) THEN
    RAISE EXCEPTION 'USER_B_UUID (%) no existe en auth.users. Crea el usuario en Authentication primero.', uuid_b;
  END IF;

  RAISE NOTICE 'Validación de UUIDs OK: A=%, B=%', uuid_a, uuid_b;
END;
$$;

-- ── Cuentas ───────────────────────────────────────────────────
-- tesorero_cuentas: (id UUID PK, auth_id UUID, email TEXT NOT NULL, nombre TEXT)
-- No existen columnas rut_representante, email_contacto ni plan en esta tabla.
-- El plan vive en suscripciones (solo service_role).

INSERT INTO tesorero_cuentas (id, auth_id, email, nombre)
VALUES
  ('00000000-0000-0000-aaaa-000000000001'::uuid,
   'USER_A_UUID'::uuid,
   'cuenta-a@staging.test',
   'Colegio Esperanza (Staging A)')
ON CONFLICT (id) DO NOTHING;

INSERT INTO tesorero_cuentas (id, auth_id, email, nombre)
VALUES
  ('00000000-0000-0000-bbbb-000000000002'::uuid,
   'USER_B_UUID'::uuid,
   'cuenta-b@staging.test',
   'Colegio Araucaria (Staging B)')
ON CONFLICT (id) DO NOTHING;

-- ── Suscripciones (requiere service_role) ─────────────────────
-- Las pruebas de RLS comprueban que authenticated no puede leer esta tabla.
-- Insertar aquí requiere service_role (SQL Editor con privilegios de postgres).
INSERT INTO suscripciones (cuenta_id, plan, activo)
VALUES
  ('00000000-0000-0000-aaaa-000000000001'::uuid, 'pro',    true),
  ('00000000-0000-0000-bbbb-000000000002'::uuid, 'basico', true)
ON CONFLICT (cuenta_id) DO NOTHING;

-- ── Membresías (usuarios_cuenta) ──────────────────────────────
-- PK: (cuenta_id UUID, id TEXT)
-- Columnas relevantes: auth_id UUID, email TEXT NOT NULL, rol TEXT, nombre TEXT
-- No existe columna user_id; el usuario se identifica por auth_id.

-- Usuario A → propietario (admin) de Cuenta A
INSERT INTO usuarios_cuenta (cuenta_id, id, auth_id, email, nombre, rol)
VALUES
  ('00000000-0000-0000-aaaa-000000000001'::uuid,
   'uc-a-propietario',
   'USER_A_UUID'::uuid,
   'usuario_a@staging.test',
   'Usuario A (Staging)',
   'admin')
ON CONFLICT (cuenta_id, id) DO NOTHING;

-- Usuario A → tesorero en Cuenta B (permite probar acceso cruzado con rol)
INSERT INTO usuarios_cuenta (cuenta_id, id, auth_id, email, nombre, rol)
VALUES
  ('00000000-0000-0000-bbbb-000000000002'::uuid,
   'uc-a-en-b',
   'USER_A_UUID'::uuid,
   'usuario_a@staging.test',
   'Usuario A (Staging)',
   'tesorero')
ON CONFLICT (cuenta_id, id) DO NOTHING;

-- Usuario B → propietario (admin) de Cuenta B
INSERT INTO usuarios_cuenta (cuenta_id, id, auth_id, email, nombre, rol)
VALUES
  ('00000000-0000-0000-bbbb-000000000002'::uuid,
   'uc-b-propietario',
   'USER_B_UUID'::uuid,
   'usuario_b@staging.test',
   'Usuario B (Staging)',
   'admin')
ON CONFLICT (cuenta_id, id) DO NOTHING;

-- ── Colegios ──────────────────────────────────────────────────
-- PK: (cuenta_id, id TEXT). Columnas: nombre, ciudad, activo.
-- No existe columna rbd.

INSERT INTO colegios (cuenta_id, id, nombre, ciudad, activo)
VALUES
  ('00000000-0000-0000-aaaa-000000000001'::uuid,
   'col-a-01', 'Escuela Esperanza', 'Santiago', true),
  ('00000000-0000-0000-bbbb-000000000002'::uuid,
   'col-b-01', 'Liceo Araucaria',   'Valparaíso', true)
ON CONFLICT (cuenta_id, id) DO NOTHING;

-- ── Cursos ────────────────────────────────────────────────────
-- PK: (cuenta_id, id TEXT). Columnas: colegio_id, nombre, anio, activo.
-- No existe columna nivel.

INSERT INTO cursos (cuenta_id, id, colegio_id, nombre, anio, activo)
VALUES
  ('00000000-0000-0000-aaaa-000000000001'::uuid,
   'cur-a-01', 'col-a-01', '1° Básico A', 2025, true),
  ('00000000-0000-0000-aaaa-000000000001'::uuid,
   'cur-a-02', 'col-a-01', '2° Básico B', 2025, true),
  ('00000000-0000-0000-bbbb-000000000002'::uuid,
   'cur-b-01', 'col-b-01', '3° Medio A',  2025, true)
ON CONFLICT (cuenta_id, id) DO NOTHING;

-- ── Alumnos ───────────────────────────────────────────────────
-- PK: (cuenta_id, id TEXT). Columnas: curso_id, nombres, apellidos, estado.
-- No existen columnas apellido (singular) ni rut.

INSERT INTO alumnos (cuenta_id, id, curso_id, nombres, apellidos, estado)
VALUES
  ('00000000-0000-0000-aaaa-000000000001'::uuid,
   'alu-a-01', 'cur-a-01', 'Sofía',    'García',   'activo'),
  ('00000000-0000-0000-aaaa-000000000001'::uuid,
   'alu-a-02', 'cur-a-01', 'Matías',   'López',    'activo'),
  ('00000000-0000-0000-aaaa-000000000001'::uuid,
   'alu-a-03', 'cur-a-02', 'Camila',   'Martínez', 'activo'),
  ('00000000-0000-0000-bbbb-000000000002'::uuid,
   'alu-b-01', 'cur-b-01', 'Diego',    'Rojas',    'activo'),
  ('00000000-0000-0000-bbbb-000000000002'::uuid,
   'alu-b-02', 'cur-b-01', 'Valentina','Torres',   'activo')
ON CONFLICT (cuenta_id, id) DO NOTHING;

-- ── Apoderados ────────────────────────────────────────────────
-- PK: (cuenta_id, id TEXT). Columnas: alumno_id, nombre, relacion, telefono, email, estado.
-- No existe columna apellido separado; nombre es texto libre.

INSERT INTO apoderados (cuenta_id, id, alumno_id, nombre, relacion, telefono, email, estado)
VALUES
  ('00000000-0000-0000-aaaa-000000000001'::uuid,
   'apo-a-01', 'alu-a-01', 'Carlos García', 'padre', '+56912340001',
   'apod-a01@staging.test', 'activo'),
  ('00000000-0000-0000-aaaa-000000000001'::uuid,
   'apo-a-02', 'alu-a-02', 'Ana López',     'madre', '+56912340002',
   'apod-a02@staging.test', 'activo'),
  ('00000000-0000-0000-bbbb-000000000002'::uuid,
   'apo-b-01', 'alu-b-01', 'Pedro Rojas',   'padre', '+56912340003',
   'apod-b01@staging.test', 'activo')
ON CONFLICT (cuenta_id, id) DO NOTHING;

-- ── Cuotas ────────────────────────────────────────────────────
-- PK: (cuenta_id, id TEXT). Columnas: curso_id, nombre, monto, anio, activa.
-- No existen columnas descripcion ni fecha_vencimiento.

INSERT INTO cuotas (cuenta_id, id, curso_id, nombre, tipo, monto, anio, activa)
VALUES
  ('00000000-0000-0000-aaaa-000000000001'::uuid,
   'cuota-a-01', 'cur-a-01', 'Cuota marzo 2025',  'mensual', 15000, 2025, true),
  ('00000000-0000-0000-aaaa-000000000001'::uuid,
   'cuota-a-02', 'cur-a-01', 'Cuota abril 2025',  'mensual', 15000, 2025, true),
  ('00000000-0000-0000-aaaa-000000000001'::uuid,
   'cuota-a-03', 'cur-a-02', 'Cuota marzo 2025',  'mensual', 12000, 2025, true),
  ('00000000-0000-0000-bbbb-000000000002'::uuid,
   'cuota-b-01', 'cur-b-01', 'Matrícula 2025',    'anual',   50000, 2025, true)
ON CONFLICT (cuenta_id, id) DO NOTHING;

-- ── Pagos ─────────────────────────────────────────────────────
-- PK: (cuenta_id, id TEXT). Columnas: alumno_id, cuota_id, monto, fecha DATE,
--   medio TEXT, estado TEXT, periodo TEXT.
-- No existen columnas fecha_pago ni medio_pago.

INSERT INTO pagos (cuenta_id, id, alumno_id, cuota_id, monto, fecha, medio, estado, periodo)
VALUES
  ('00000000-0000-0000-aaaa-000000000001'::uuid,
   'pago-a-01', 'alu-a-01', 'cuota-a-01',
   15000, '2025-03-10', 'transferencia', 'pagado', 'Marzo 2025'),
  ('00000000-0000-0000-bbbb-000000000002'::uuid,
   'pago-b-01', 'alu-b-01', 'cuota-b-01',
   50000, '2025-01-15', 'efectivo', 'pagado', 'Anual 2025')
ON CONFLICT (cuenta_id, id) DO NOTHING;

-- ── Planes de pago ────────────────────────────────────────────
-- PK: (cuenta_id, id TEXT). Columnas: alumno_id, cuota_id, periodo TEXT, monto_total.
-- No existe columna n_cuotas.

INSERT INTO planes_pago (cuenta_id, id, alumno_id, cuota_id, periodo, monto_total, activo)
VALUES
  ('00000000-0000-0000-aaaa-000000000001'::uuid,
   'plan-a-01', 'alu-a-02', 'cuota-a-02',
   'Abril 2025 — 3 cuotas', 15000, true)
ON CONFLICT (cuenta_id, id) DO NOTHING;

-- ── Abonos ────────────────────────────────────────────────────
-- PK: (cuenta_id, id TEXT). Columnas: alumno_id, cuota_id, plan_id, monto,
--   fecha DATE, pagado BOOLEAN DEFAULT false, fecha_pago DATE,
--   medio TEXT, estado TEXT DEFAULT 'registrado', obs TEXT, creado_por TEXT.
-- alumno_id y cuota_id son obligatorios (triggers los verifican contra el plan).
-- No existen columnas fecha_abono ni numero_cuota.
--
-- ESTADO: 'registrado' (pendiente de cobro). No está marcado como 'pagado'
-- porque es un abono de ejemplo de cuota parcial, no un ingreso cobrado.
-- Para conciliar como cobrado: UPDATE con estado='pagado' antes de conciliar.

INSERT INTO abonos (cuenta_id, id, plan_id, alumno_id, cuota_id, monto, fecha, estado)
VALUES
  ('00000000-0000-0000-aaaa-000000000001'::uuid,
   'abono-a-01', 'plan-a-01', 'alu-a-02', 'cuota-a-02',
   5000, '2025-04-05', 'registrado')
ON CONFLICT (cuenta_id, id) DO NOTHING;

-- ── Config por cuenta ─────────────────────────────────────────
-- PK: cuenta_id (única por cuenta). Columnas directas: moneda, tipo_org, etc.
-- No es una tabla clave-valor; no existen columnas (clave, valor).

INSERT INTO config_cuenta (cuenta_id, moneda, tipo_org)
VALUES
  ('00000000-0000-0000-aaaa-000000000001'::uuid, 'CLP', 'colegio'),
  ('00000000-0000-0000-bbbb-000000000002'::uuid, 'CLP', 'colegio')
ON CONFLICT (cuenta_id) DO NOTHING;

-- ── Notas de prueba ───────────────────────────────────────────
-- PK: (cuenta_id, id TEXT). Columnas: curso_id, texto, color, fijada, privada.
-- No existen columnas cuenta_ref_id ni autor_id.
-- curso_id = NULL para notas de cuenta (no asociadas a un curso específico).

INSERT INTO notas (cuenta_id, id, curso_id, texto, privada)
VALUES
  ('00000000-0000-0000-aaaa-000000000001'::uuid,
   'nota-a-01', NULL,
   'Nota ficticia de prueba — Cuenta A', true)
ON CONFLICT (cuenta_id, id) DO NOTHING;

-- ── Aserciones: verificar recuentos, identidades y relaciones ─
-- El seed usa ON CONFLICT DO NOTHING, que no actualiza filas existentes.
-- Si hay datos previos con auth_id o relaciones incorrectas, las aserciones
-- de identidad y relación lo detectan aunque los recuentos coincidan.
-- En ese caso: limpia las tablas afectadas y re-ejecuta.
DO $$
DECLARE
  n_cuentas      INT;
  n_subs         INT;
  n_membs        INT;
  n_colegios     INT;
  n_cursos       INT;
  n_alumnos      INT;
  n_apoderados   INT;
  n_cuotas       INT;
  n_pagos        INT;
  n_planes       INT;
  n_abonos       INT;
  n_config       INT;
  n_notas        INT;
  errores        INT := 0;

  -- Variables para verificación de identidad y relaciones
  auth_a_cuenta  UUID;
  auth_b_cuenta  UUID;
  auth_a_uc      UUID;
  auth_b_uc      UUID;
  uc_a_rol       TEXT;
  uc_b_rol       TEXT;
  uc_aenb_auth   UUID;
  uc_aenb_rol    TEXT;
  plan_alu       TEXT;
  plan_cuota     TEXT;
  abono_plan     TEXT;
  abono_alu      TEXT;
  abono_cuota    TEXT;

  -- Recuentos esperados
  E_CUENTAS    CONSTANT INT := 2;
  E_SUBS       CONSTANT INT := 2;
  E_MEMBS      CONSTANT INT := 3;  -- uc-a-propietario, uc-a-en-b, uc-b-propietario
  E_COLEGIOS   CONSTANT INT := 2;
  E_CURSOS     CONSTANT INT := 3;
  E_ALUMNOS    CONSTANT INT := 5;
  E_APODERADOS CONSTANT INT := 3;
  E_CUOTAS     CONSTANT INT := 4;
  E_PAGOS      CONSTANT INT := 2;
  E_PLANES     CONSTANT INT := 1;
  E_ABONOS     CONSTANT INT := 1;
  E_CONFIG     CONSTANT INT := 2;
  E_NOTAS      CONSTANT INT := 1;

  CUENTA_A CONSTANT UUID := '00000000-0000-0000-aaaa-000000000001';
  CUENTA_B CONSTANT UUID := '00000000-0000-0000-bbbb-000000000002';

BEGIN
  SELECT COUNT(*) INTO n_cuentas    FROM tesorero_cuentas   WHERE id IN (CUENTA_A, CUENTA_B);
  SELECT COUNT(*) INTO n_subs       FROM suscripciones       WHERE cuenta_id IN (CUENTA_A, CUENTA_B);
  SELECT COUNT(*) INTO n_membs      FROM usuarios_cuenta      WHERE cuenta_id IN (CUENTA_A, CUENTA_B);
  SELECT COUNT(*) INTO n_colegios   FROM colegios             WHERE cuenta_id IN (CUENTA_A, CUENTA_B);
  SELECT COUNT(*) INTO n_cursos     FROM cursos               WHERE cuenta_id IN (CUENTA_A, CUENTA_B);
  SELECT COUNT(*) INTO n_alumnos    FROM alumnos              WHERE cuenta_id IN (CUENTA_A, CUENTA_B);
  SELECT COUNT(*) INTO n_apoderados FROM apoderados           WHERE cuenta_id IN (CUENTA_A, CUENTA_B);
  SELECT COUNT(*) INTO n_cuotas     FROM cuotas               WHERE cuenta_id IN (CUENTA_A, CUENTA_B);
  SELECT COUNT(*) INTO n_pagos      FROM pagos                WHERE cuenta_id IN (CUENTA_A, CUENTA_B);
  SELECT COUNT(*) INTO n_planes     FROM planes_pago          WHERE cuenta_id IN (CUENTA_A, CUENTA_B);
  SELECT COUNT(*) INTO n_abonos     FROM abonos               WHERE cuenta_id IN (CUENTA_A, CUENTA_B);
  SELECT COUNT(*) INTO n_config     FROM config_cuenta        WHERE cuenta_id IN (CUENTA_A, CUENTA_B);
  SELECT COUNT(*) INTO n_notas      FROM notas                WHERE cuenta_id IN (CUENTA_A, CUENTA_B);

  RAISE NOTICE '08_seed_staging.sql (v3) — verificando recuentos, identidades y relaciones...';

  -- ── Recuentos ───────────────────────────────────────────────
  IF n_cuentas    <> E_CUENTAS    THEN RAISE WARNING 'tesorero_cuentas: esperado %, obtenido %', E_CUENTAS,    n_cuentas;    errores := errores + 1; END IF;
  IF n_subs       <> E_SUBS       THEN RAISE WARNING 'suscripciones: esperado %, obtenido %',    E_SUBS,       n_subs;       errores := errores + 1; END IF;
  IF n_membs      <> E_MEMBS      THEN RAISE WARNING 'usuarios_cuenta: esperado %, obtenido %',  E_MEMBS,      n_membs;      errores := errores + 1; END IF;
  IF n_colegios   <> E_COLEGIOS   THEN RAISE WARNING 'colegios: esperado %, obtenido %',         E_COLEGIOS,   n_colegios;   errores := errores + 1; END IF;
  IF n_cursos     <> E_CURSOS     THEN RAISE WARNING 'cursos: esperado %, obtenido %',            E_CURSOS,     n_cursos;     errores := errores + 1; END IF;
  IF n_alumnos    <> E_ALUMNOS    THEN RAISE WARNING 'alumnos: esperado %, obtenido %',           E_ALUMNOS,    n_alumnos;    errores := errores + 1; END IF;
  IF n_apoderados <> E_APODERADOS THEN RAISE WARNING 'apoderados: esperado %, obtenido %',       E_APODERADOS, n_apoderados; errores := errores + 1; END IF;
  IF n_cuotas     <> E_CUOTAS     THEN RAISE WARNING 'cuotas: esperado %, obtenido %',            E_CUOTAS,     n_cuotas;     errores := errores + 1; END IF;
  IF n_pagos      <> E_PAGOS      THEN RAISE WARNING 'pagos: esperado %, obtenido %',             E_PAGOS,      n_pagos;      errores := errores + 1; END IF;
  IF n_planes     <> E_PLANES     THEN RAISE WARNING 'planes_pago: esperado %, obtenido %',       E_PLANES,     n_planes;     errores := errores + 1; END IF;
  IF n_abonos     <> E_ABONOS     THEN RAISE WARNING 'abonos: esperado %, obtenido %',            E_ABONOS,     n_abonos;     errores := errores + 1; END IF;
  IF n_config     <> E_CONFIG     THEN RAISE WARNING 'config_cuenta: esperado %, obtenido %',     E_CONFIG,     n_config;     errores := errores + 1; END IF;
  IF n_notas      <> E_NOTAS      THEN RAISE WARNING 'notas: esperado %, obtenido %',             E_NOTAS,      n_notas;      errores := errores + 1; END IF;

  -- ── Identidad de propietarios (auth_id en tesorero_cuentas) ─
  -- Detecta el caso donde un auth_id diferente al esperado ya ocupaba la fila
  -- (ON CONFLICT DO NOTHING no corrige valores erróneos previos).
  SELECT auth_id INTO auth_a_cuenta FROM tesorero_cuentas WHERE id = CUENTA_A;
  IF auth_a_cuenta IS DISTINCT FROM 'USER_A_UUID'::uuid THEN
    RAISE WARNING 'tesorero_cuentas: Cuenta A tiene auth_id=% (esperado: USER_A_UUID). '
      'Limpia la fila y re-ejecuta.', auth_a_cuenta;
    errores := errores + 1;
  END IF;

  SELECT auth_id INTO auth_b_cuenta FROM tesorero_cuentas WHERE id = CUENTA_B;
  IF auth_b_cuenta IS DISTINCT FROM 'USER_B_UUID'::uuid THEN
    RAISE WARNING 'tesorero_cuentas: Cuenta B tiene auth_id=% (esperado: USER_B_UUID). '
      'Limpia la fila y re-ejecuta.', auth_b_cuenta;
    errores := errores + 1;
  END IF;

  -- ── Identidad de membresías (auth_id y rol en usuarios_cuenta) ─
  SELECT auth_id, rol INTO auth_a_uc, uc_a_rol
    FROM usuarios_cuenta WHERE cuenta_id = CUENTA_A AND id = 'uc-a-propietario';
  IF auth_a_uc IS DISTINCT FROM 'USER_A_UUID'::uuid THEN
    RAISE WARNING 'usuarios_cuenta: uc-a-propietario tiene auth_id=% (esperado: USER_A_UUID)', auth_a_uc;
    errores := errores + 1;
  END IF;
  IF uc_a_rol IS DISTINCT FROM 'admin' THEN
    RAISE WARNING 'usuarios_cuenta: uc-a-propietario tiene rol=% (esperado: admin)', uc_a_rol;
    errores := errores + 1;
  END IF;

  SELECT auth_id, rol INTO auth_b_uc, uc_b_rol
    FROM usuarios_cuenta WHERE cuenta_id = CUENTA_B AND id = 'uc-b-propietario';
  IF auth_b_uc IS DISTINCT FROM 'USER_B_UUID'::uuid THEN
    RAISE WARNING 'usuarios_cuenta: uc-b-propietario tiene auth_id=% (esperado: USER_B_UUID)', auth_b_uc;
    errores := errores + 1;
  END IF;
  IF uc_b_rol IS DISTINCT FROM 'admin' THEN
    RAISE WARNING 'usuarios_cuenta: uc-b-propietario tiene rol=% (esperado: admin)', uc_b_rol;
    errores := errores + 1;
  END IF;

  -- Membresía cruzada: A es tesorero en B con su propio auth_id
  SELECT auth_id, rol INTO uc_aenb_auth, uc_aenb_rol
    FROM usuarios_cuenta WHERE cuenta_id = CUENTA_B AND id = 'uc-a-en-b';
  IF uc_aenb_auth IS DISTINCT FROM 'USER_A_UUID'::uuid THEN
    RAISE WARNING 'usuarios_cuenta: uc-a-en-b tiene auth_id=% (esperado: USER_A_UUID — A como tesorero en B)', uc_aenb_auth;
    errores := errores + 1;
  END IF;
  IF uc_aenb_rol IS DISTINCT FROM 'tesorero' THEN
    RAISE WARNING 'usuarios_cuenta: uc-a-en-b tiene rol=% (esperado: tesorero)', uc_aenb_rol;
    errores := errores + 1;
  END IF;

  -- ── Relaciones: plan-a-01 → alumno y cuota correctos ────────
  SELECT alumno_id, cuota_id INTO plan_alu, plan_cuota
    FROM planes_pago WHERE cuenta_id = CUENTA_A AND id = 'plan-a-01';
  IF plan_alu IS DISTINCT FROM 'alu-a-02' THEN
    RAISE WARNING 'planes_pago: plan-a-01 tiene alumno_id=% (esperado: alu-a-02)', plan_alu;
    errores := errores + 1;
  END IF;
  IF plan_cuota IS DISTINCT FROM 'cuota-a-02' THEN
    RAISE WARNING 'planes_pago: plan-a-01 tiene cuota_id=% (esperado: cuota-a-02)', plan_cuota;
    errores := errores + 1;
  END IF;

  -- ── Relaciones: abono-a-01 → plan, alumno y cuota correctos ─
  SELECT plan_id, alumno_id, cuota_id INTO abono_plan, abono_alu, abono_cuota
    FROM abonos WHERE cuenta_id = CUENTA_A AND id = 'abono-a-01';
  IF abono_plan IS DISTINCT FROM 'plan-a-01' THEN
    RAISE WARNING 'abonos: abono-a-01 tiene plan_id=% (esperado: plan-a-01)', abono_plan;
    errores := errores + 1;
  END IF;
  IF abono_alu IS DISTINCT FROM 'alu-a-02' THEN
    RAISE WARNING 'abonos: abono-a-01 tiene alumno_id=% (esperado: alu-a-02)', abono_alu;
    errores := errores + 1;
  END IF;
  IF abono_cuota IS DISTINCT FROM 'cuota-a-02' THEN
    RAISE WARNING 'abonos: abono-a-01 tiene cuota_id=% (esperado: cuota-a-02)', abono_cuota;
    errores := errores + 1;
  END IF;

  -- ── Resultado ────────────────────────────────────────────────
  IF errores > 0 THEN
    RAISE EXCEPTION 'Seed inválido: % verificación(es) fallida(s) (recuentos, identidades o relaciones). '
      'ON CONFLICT DO NOTHING no corrige filas existentes con valores incorrectos — '
      'limpia las tablas afectadas y re-ejecuta.', errores;
  ELSE
    RAISE NOTICE 'Seed OK (v3): % cuentas | % membresías | % alumnos | % cuotas | % pagos | % planes | % abonos',
      n_cuentas, n_membs, n_alumnos, n_cuotas, n_pagos, n_planes, n_abonos;
    RAISE NOTICE '  Cuenta A (auth=USER_A_UUID): 00000000-0000-0000-aaaa-000000000001';
    RAISE NOTICE '  Cuenta B (auth=USER_B_UUID): 00000000-0000-0000-bbbb-000000000002';
    RAISE NOTICE '  A es propietario (admin) de A y tesorero en B.';
    RAISE NOTICE '  Abono abono-a-01: estado=registrado (pendiente, no cobrado).';
    RAISE NOTICE '  Ejecutar tests/03_rls_cliente.js para verificar RLS.';
  END IF;
END;
$$;

COMMIT;