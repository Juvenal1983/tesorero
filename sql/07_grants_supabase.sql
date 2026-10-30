-- ============================================================
-- El Tesorero — "El Gran Cambio" v9
-- Archivo: sql/07_grants_supabase.sql  (v3)
-- Propósito: Grants y REVOKEs para el proyecto Supabase de staging.
--
-- EJECUTAR EN:
--   SQL Editor del proyecto de STAGING únicamente.
--   Requiere privilegios de superuser (postgres).
--   NO ejecutar en producción (tmjqzaakzhecbldebyeg.supabase.co).
--
-- Todo el script está dentro de una transacción explícita.
-- Si la verificación final falla con EXCEPTION, todos los cambios
-- del script se revierten (ROLLBACK automático).
--
-- ORDEN DE EJECUCIÓN dentro del deploy de staging:
--   01_schema.sql → 02_rls.sql → 07_grants_supabase.sql
--   Después: 08_seed_staging.sql (una sola vez, con UUIDs reales de Auth)
--
-- ── NOTAS TÉCNICAS ──────────────────────────────────────────
--
-- FIRMAS DE FUNCIÓN
--   PostgreSQL identifica funciones sobrecargadas por sus tipos de argumento.
--   Los nombres de parámetro son opcionales para la resolución; se omiten
--   aquí en los GRANT/REVOKE para evitar ambigüedades si cambian los nombres.
--
-- ALTER DEFAULT PRIVILEGES — dos capas independientes
--   • Global (sin IN SCHEMA): aplica a todos los schemas presentes y futuros.
--   • Por schema (IN SCHEMA x): solo para ese schema.
--   Un REVOKE solo en IN SCHEMA NO elimina los defaults globales.
--   Este script revoca AMBAS capas para PUBLIC, anon y authenticated.
--   Los permisos de tablas y funciones futuras se otorgan migration a migration;
--   no se establece ningún acceso automático global aquí.
--
-- FUNCIONES DE TRIGGER
--   Los permisos de función son independientes de los permisos de tabla.
--   PostgreSQL ejecuta los triggers bajo el contexto del propietario
--   del objeto (postgres), no del rol del cliente. Revocar EXECUTE
--   de las funciones _check_* en clientes NO impide que los triggers
--   existentes se ejecuten.
--
-- SCHEMA _staging
--   Creado por 01_schema.sql para datos locales de prueba.
--   Su presencia en el proyecto Supabase de staging es ESPERADA.
--   Lo que se verifica aquí es que ningún cliente tiene acceso.
-- ============================================================

BEGIN;

-- ════════════════════════════════════════════════════════════════
-- Paso 1: REVOKE sobre tablas y secuencias existentes
-- ════════════════════════════════════════════════════════════════

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon;
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;

-- ════════════════════════════════════════════════════════════════
-- Paso 2: REVOKE EXECUTE sobre funciones existentes
-- ════════════════════════════════════════════════════════════════
-- Se revoca de PUBLIC (y por herencia de anon y authenticated) sobre:
--   a) Helpers RLS: get_mis_cuentas, get_mis_cursos, es_dueno,
--      tiene_rol_en_curso, _curso_de_cuota
--   b) Funciones de trigger (5 en total):
--      _check_pago_mismo_curso, _check_abono_plan_consistente,
--      _check_alumno_cambio_curso, _check_cuota_cambio_curso,
--      _check_plan_cambio_titular
-- La revocación explícita de anon y authenticated es adicional por
-- si Supabase asigna grants propios fuera de la herencia estándar.

DO $$
DECLARE
  rec RECORD;
  sql_stmt TEXT;
BEGIN
  FOR rec IN
    SELECT p.proname,
           pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'get_mis_cuentas',
        'get_mis_cursos',
        'es_dueno',
        'tiene_rol_en_curso',
        '_curso_de_cuota',
        '_check_pago_mismo_curso',
        '_check_abono_plan_consistente',
        '_check_alumno_cambio_curso',
        '_check_cuota_cambio_curso',
        '_check_plan_cambio_titular'
      )
  LOOP
    -- REVOKE de PUBLIC (cubre herencia a todos los roles)
    sql_stmt := format(
      'REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM PUBLIC',
      rec.proname, rec.args
    );
    EXECUTE sql_stmt;

    -- REVOKE explícito de anon (Supabase puede tener grants propios)
    sql_stmt := format(
      'REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM anon',
      rec.proname, rec.args
    );
    EXECUTE sql_stmt;

    -- REVOKE de authenticated (se re-concederá solo en helpers en Paso 6)
    sql_stmt := format(
      'REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM authenticated',
      rec.proname, rec.args
    );
    EXECUTE sql_stmt;

    RAISE NOTICE '  REVOKE EXECUTE OK: public.%(%)  [PUBLIC, anon, authenticated]',
      rec.proname, rec.args;
  END LOOP;
END;
$$;

-- ════════════════════════════════════════════════════════════════
-- Paso 3: REVOKE en schema _staging
-- ════════════════════════════════════════════════════════════════
-- _staging es creado por 01_schema.sql — su presencia es ESPERADA.
-- Verificar que ningún cliente tenga USAGE ni acceso a sus tablas.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.schemata
    WHERE schema_name = '_staging'
  ) THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA _staging FROM PUBLIC;
    REVOKE ALL ON ALL TABLES IN SCHEMA _staging FROM anon;
    REVOKE ALL ON ALL TABLES IN SCHEMA _staging FROM authenticated;
    REVOKE USAGE ON SCHEMA _staging FROM PUBLIC;
    REVOKE USAGE ON SCHEMA _staging FROM anon;
    REVOKE USAGE ON SCHEMA _staging FROM authenticated;
    RAISE NOTICE '_staging detectado (presencia esperada): acceso de cliente revocado.';
  ELSE
    RAISE NOTICE '_staging no encontrado. ¿Se ejecutó 01_schema.sql completo?';
  END IF;
END;
$$;

-- ════════════════════════════════════════════════════════════════
-- Paso 4: REVOKE DEFAULT PRIVILEGES — capa global Y capa por schema
-- ════════════════════════════════════════════════════════════════
-- El objetivo es que los objetos creados en el futuro no hereden
-- permisos automáticamente para clientes no autorizados.
--
-- Capa GLOBAL (sin IN SCHEMA): aplica a todos los schemas.
-- Un REVOKE solo IN SCHEMA no elimina estos defaults globales.
-- Ambas capas son necesarias.
--
-- Para tablas futuras: ningún cliente recibe acceso automático.
-- Cada migración que crea una tabla de negocio debe hacer su propio GRANT.
--
-- service_role sí recibe default grants para mantener acceso de backend.

-- Capa global — todos los schemas
ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES    FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES    FROM anon;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES    FROM authenticated;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON SEQUENCES FROM authenticated;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM anon;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM authenticated;

-- Capa por schema — complementa la capa global para public
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM authenticated;

-- Default grants para service_role en objetos futuros del schema public
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
-- Las funciones de negocio futuras recibirán su GRANT en la migración que las crea.

-- ════════════════════════════════════════════════════════════════
-- Paso 5: USAGE en schemas
-- ════════════════════════════════════════════════════════════════

GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;

-- authenticated necesita EXECUTE en auth.uid() / auth.role() para las políticas RLS
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid()  TO authenticated;
GRANT EXECUTE ON FUNCTION auth.role() TO authenticated;

-- ════════════════════════════════════════════════════════════════
-- Paso 6: GRANT EXECUTE en helpers RLS (solo a authenticated)
-- ════════════════════════════════════════════════════════════════
-- Solo estos 5 helpers son invocados directamente por las políticas RLS.
-- Las funciones de trigger (_check_*) NO reciben GRANT de cliente.
-- Tipos de argumento sin nombres de parámetro para evitar ambigüedad.

GRANT EXECUTE ON FUNCTION public.get_mis_cuentas()
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_mis_cursos(uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.es_dueno(uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.tiene_rol_en_curso(uuid, text, text[])
  TO authenticated;
GRANT EXECUTE ON FUNCTION public._curso_de_cuota(uuid, text)
  TO authenticated;

-- ════════════════════════════════════════════════════════════════
-- Paso 7: GRANT en secuencias existentes
-- ════════════════════════════════════════════════════════════════

GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated;
GRANT ALL   ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- ════════════════════════════════════════════════════════════════
-- Paso 8: GRANT tabla a tabla (solo tablas con política RLS activa)
-- ════════════════════════════════════════════════════════════════
-- Criterio: una tabla recibe grant si y solo si existe una política RLS
-- que filtre su contenido por cuenta (cuenta_id = ...).
--
-- Tablas SIN grant (acceso denegado para todos los clientes):
--   suscripciones, alumnos_credenciales
-- Estas son inaccesibles incluso para authenticated.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tesorero_cuentas   TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.colegios            TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.cursos              TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.alumnos             TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.apoderados          TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.cuotas              TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.pagos               TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.abonos              TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.planes_pago         TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.movimientos         TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.fondo_movimientos   TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.notas               TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.usuarios_cuenta     TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.usuarios_externos   TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.codigos_invitacion  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.config_cuenta       TO authenticated;

-- service_role: acceso completo a todos los objetos existentes
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;

-- ════════════════════════════════════════════════════════════════
-- Paso 9: Verificación completa
-- Permisos faltantes o incorrectos → EXCEPTION → ROLLBACK automático
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE
  -- Helpers RLS: authenticated DEBE tener EXECUTE; anon NO debe tenerlo.
  -- Formato compatible con has_function_privilege(): 'nombre(tipos)'
  helpers text[] := ARRAY[
    'get_mis_cuentas()',
    'get_mis_cursos(uuid)',
    'es_dueno(uuid)',
    'tiene_rol_en_curso(uuid, text, text[])',
    '_curso_de_cuota(uuid, text)'
  ];

  -- Funciones de trigger: ningún cliente debe tener EXECUTE.
  -- Son 5 funciones creadas en 01_schema.sql; su ausencia es un error.
  -- Solo se usan los nombres; la firma exacta se obtiene de pg_proc.
  trigger_names text[] := ARRAY[
    '_check_pago_mismo_curso',
    '_check_abono_plan_consistente',
    '_check_alumno_cambio_curso',
    '_check_cuota_cambio_curso',
    '_check_plan_cambio_titular'
  ];

  -- Tablas que NO deben tener grant de cliente
  tablas_protegidas text[] := ARRAY['suscripciones', 'alumnos_credenciales'];

  -- Tablas de negocio que authenticated DEBE poder leer
  tablas_negocio text[] := ARRAY[
    'tesorero_cuentas','colegios','cursos','alumnos','apoderados',
    'cuotas','pagos','abonos','planes_pago','movimientos',
    'fondo_movimientos','notas','usuarios_cuenta','usuarios_externos',
    'codigos_invitacion','config_cuenta'
  ];

  n_ok       int  := 0;
  n_err      int  := 0;
  msgs       text := '';
  tiene      boolean;
  fn         text;
  tn         text;
  func_ident text;
  trig_args  text;
BEGIN
  RAISE NOTICE '══ Verificación de permisos efectivos ══';

  -- ── 9a. Helpers RLS: authenticated DEBE tener EXECUTE ──────────
  RAISE NOTICE '── Helpers RLS: authenticated debe tener EXECUTE ──';
  FOREACH fn IN ARRAY helpers LOOP
    func_ident := 'public.' || fn;
    tiene := has_function_privilege('authenticated', func_ident, 'EXECUTE');
    IF tiene THEN
      RAISE NOTICE '  ✓ authenticated EXECUTE %', func_ident;
      n_ok := n_ok + 1;
    ELSE
      RAISE WARNING '  ✗ FALTA: authenticated sin EXECUTE en %', func_ident;
      n_err := n_err + 1;
      msgs  := msgs || E'\n  • FALTA: authenticated sin EXECUTE en ' || func_ident;
    END IF;
  END LOOP;

  -- ── 9b. Helpers RLS: anon NO debe tener EXECUTE ─────────────────
  RAISE NOTICE '── Helpers RLS: anon NO debe tener EXECUTE ──';
  FOREACH fn IN ARRAY helpers LOOP
    func_ident := 'public.' || fn;
    tiene := has_function_privilege('anon', func_ident, 'EXECUTE');
    IF NOT tiene THEN
      RAISE NOTICE '  ✓ anon sin EXECUTE en %', func_ident;
      n_ok := n_ok + 1;
    ELSE
      RAISE WARNING '  ✗ EXCESO: anon tiene EXECUTE en %', func_ident;
      n_err := n_err + 1;
      msgs  := msgs || E'\n  • EXCESO: anon tiene EXECUTE en ' || func_ident;
    END IF;
  END LOOP;

  -- ── 9c. Funciones de trigger: ningún cliente debe tener EXECUTE ──
  RAISE NOTICE '── Funciones trigger: ningún cliente debe tener EXECUTE ──';
  FOREACH tn IN ARRAY trigger_names LOOP
    -- Buscar la firma real en pg_proc
    SELECT pg_get_function_identity_arguments(p.oid)
    INTO trig_args
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = tn
    LIMIT 1;

    IF trig_args IS NULL THEN
      -- La función de trigger no existe — 01_schema.sql no fue ejecutado o falló.
      -- Esto es un error de configuración: las 5 funciones de trigger son obligatorias.
      RAISE WARNING '  ✗ FALTA: función de trigger % no encontrada en public', tn;
      n_err := n_err + 1;
      msgs  := msgs || E'\n  • FALTA: función trigger public.' || tn
               || '() — ¿se ejecutó 01_schema.sql?';
      CONTINUE;
    END IF;

    func_ident := 'public.' || tn || '(' || trig_args || ')';

    tiene := has_function_privilege('anon', func_ident, 'EXECUTE');
    IF NOT tiene THEN
      RAISE NOTICE '  ✓ anon sin EXECUTE en %', func_ident;
      n_ok := n_ok + 1;
    ELSE
      RAISE WARNING '  ✗ EXCESO: anon tiene EXECUTE en función trigger %', func_ident;
      n_err := n_err + 1;
      msgs  := msgs || E'\n  • EXCESO: anon tiene EXECUTE en trigger ' || func_ident;
    END IF;

    tiene := has_function_privilege('authenticated', func_ident, 'EXECUTE');
    IF NOT tiene THEN
      RAISE NOTICE '  ✓ authenticated sin EXECUTE en %', func_ident;
      n_ok := n_ok + 1;
    ELSE
      RAISE WARNING '  ✗ EXCESO: authenticated tiene EXECUTE en función trigger %', func_ident;
      n_err := n_err + 1;
      msgs  := msgs || E'\n  • EXCESO: authenticated tiene EXECUTE en trigger ' || func_ident;
    END IF;
  END LOOP;

  -- ── 9d. Tablas protegidas: ningún cliente debe tener SELECT ──────
  RAISE NOTICE '── Tablas protegidas: sin SELECT para clientes ──';
  FOREACH tn IN ARRAY tablas_protegidas LOOP
    tiene := has_table_privilege('anon', 'public.' || tn, 'SELECT');
    IF NOT tiene THEN
      RAISE NOTICE '  ✓ anon sin SELECT en %', tn;
      n_ok := n_ok + 1;
    ELSE
      RAISE WARNING '  ✗ EXCESO: anon tiene SELECT en tabla protegida %', tn;
      n_err := n_err + 1;
      msgs  := msgs || E'\n  • EXCESO: anon tiene SELECT en ' || tn;
    END IF;

    tiene := has_table_privilege('authenticated', 'public.' || tn, 'SELECT');
    IF NOT tiene THEN
      RAISE NOTICE '  ✓ authenticated sin SELECT en %', tn;
      n_ok := n_ok + 1;
    ELSE
      RAISE WARNING '  ✗ EXCESO: authenticated tiene SELECT en tabla protegida %', tn;
      n_err := n_err + 1;
      msgs  := msgs || E'\n  • EXCESO: authenticated tiene SELECT en ' || tn;
    END IF;
  END LOOP;

  -- ── 9e. Tablas de negocio: authenticated DEBE tener SELECT ───────
  RAISE NOTICE '── Tablas de negocio: authenticated debe tener SELECT ──';
  FOREACH tn IN ARRAY tablas_negocio LOOP
    tiene := has_table_privilege('authenticated', 'public.' || tn, 'SELECT');
    IF tiene THEN
      RAISE NOTICE '  ✓ authenticated SELECT en %', tn;
      n_ok := n_ok + 1;
    ELSE
      RAISE WARNING '  ✗ FALTA: authenticated sin SELECT en tabla de negocio %', tn;
      n_err := n_err + 1;
      msgs  := msgs || E'\n  • FALTA: authenticated sin SELECT en ' || tn;
    END IF;
  END LOOP;

  -- ── 9f. service_role: USAGE en schema public ─────────────────────
  RAISE NOTICE '── service_role ──';
  IF has_schema_privilege('service_role', 'public', 'USAGE') THEN
    RAISE NOTICE '  ✓ service_role USAGE en schema public';
    n_ok := n_ok + 1;
  ELSE
    RAISE WARNING '  ✗ FALTA: service_role sin USAGE en schema public';
    n_err := n_err + 1;
    msgs  := msgs || E'\n  • FALTA: service_role sin USAGE en schema public';
  END IF;

  -- ── 9g. Schema _staging: ningún cliente debe tener USAGE ─────────
  RAISE NOTICE '── Schema _staging ──';
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = '_staging') THEN
    IF has_schema_privilege('anon', '_staging', 'USAGE') THEN
      RAISE WARNING '  ✗ EXCESO: anon tiene USAGE en schema _staging';
      n_err := n_err + 1;
      msgs  := msgs || E'\n  • EXCESO: anon tiene USAGE en _staging';
    ELSE
      RAISE NOTICE '  ✓ anon sin USAGE en _staging';
      n_ok := n_ok + 1;
    END IF;

    IF has_schema_privilege('authenticated', '_staging', 'USAGE') THEN
      RAISE WARNING '  ✗ EXCESO: authenticated tiene USAGE en schema _staging';
      n_err := n_err + 1;
      msgs  := msgs || E'\n  • EXCESO: authenticated tiene USAGE en _staging';
    ELSE
      RAISE NOTICE '  ✓ authenticated sin USAGE en _staging';
      n_ok := n_ok + 1;
    END IF;
  ELSE
    RAISE NOTICE '  ℹ _staging no existe (puede no haberse ejecutado 01_schema.sql completo).';
  END IF;

  -- ── Resultado final ───────────────────────────────────────────────
  RAISE NOTICE '';
  RAISE NOTICE '══ Resultado: % OK, % error(es) ══', n_ok, n_err;

  IF n_err > 0 THEN
    RAISE EXCEPTION
      E'07_grants_supabase.sql: % verificación(es) fallaron. '
       'Todos los cambios serán revertidos (ROLLBACK).%',
      n_err, msgs;
  END IF;

  RAISE NOTICE '07_grants_supabase.sql v3 aplicado y verificado correctamente.';
  RAISE NOTICE 'Siguiente paso: ejecutar 08_seed_staging.sql con UUIDs reales.';
  RAISE NOTICE 'Para validar permisos en objetos FUTUROS: ver tests/05_prueba_permisos_locales.sql';
END;
$$;

COMMIT;