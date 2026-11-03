-- ============================================================
-- El Tesorero v9 — Pruebas locales del flujo apoderado
-- Ejecutar como: sudo -u postgres psql -d tesorero_test -f test_rpcs_local.sql
--
-- Prerrequisitos:
--   01_schema.sql, 07_grants_supabase.sql, 06_rpcs_apoderado.sql
--   09d_fixture_apoderado_v9.sql, 09e_fixture_contenido_v9.sql
--
-- Comportamiento:
--   • ON_ERROR_STOP on: cualquier ASSERT o error SQL detiene la ejecución.
--   • ASSERT trata NULL como fallo (igual que FALSE en plpgsql).
--   • Todo se ejecuta dentro de una única transacción que hace ROLLBACK
--     al final, deshaciendo todos los cambios de prueba.
--     Si ASSERT falla la transacción aborta automáticamente (sin commit).
--   • Los permisos anon se comprueban bajo SET LOCAL ROLE anon;
--     se verifica el código 42501 en lecturas directas protegidas.
--   • SAVEPOINTs entre DO-blocks para deshacer escrituras
--     antes de verificar relectura (ROLLBACK TO SAVEPOINT opera a nivel SQL).
--
-- Cobertura:
--   P1-P2      Selector sin PIN
--   P3-P5      Permisos directos bajo rol anon (42501) — tablas y todos los 5 RPC públicos
--   P3-helper  _apoderado_verificar_pin denegado a anon
--   P6-P9      Verificación PIN: correcto, NULL, vacío, espacios, incorrecto, sin credencial
--   P10        Bloqueo tras 5 intentos + no contagio entre alumnos
--   P11-P13    Aislamiento entre familias (cuenta, alumno, apoderado cruzados)
--   P14-P15    Escritura y persistencia de contactos
--   P17-P18    Situación financiera: estructura completa + balance_curso + abonos breakdown
--   PA         Agregar contacto: ok, nombre vacío
--   PR         Revocación: cambio PIN, alumno inactivo, curso inactivo + selector
--   PC         Contenido correcto: cuotas formato por período (LEFT JOIN), comprobantes,
--                aislamiento de pagos, plan con monto_abonado correcto
--   PC-PERIOD  Calendario: cuota-a-tst Marzo=pagado (fila en pagos),
--              Abril=pendiente (SIN fila en pagos — generado por mes_inicio/mes_termino)
-- ============================================================

\set ON_ERROR_STOP on

BEGIN;

-- ── P1-P2: Selector sin PIN ────────────────────────────────────
DO $$
DECLARE
  cnt BIGINT;
  cuenta_a CONSTANT UUID := '00000000-0000-0000-aaaa-000000000001';
BEGIN
  RAISE NOTICE '=== P1-P2: Selector ===';

  SELECT count(*) INTO cnt FROM apoderado_alumnos_curso('CUR-A01');
  ASSERT cnt >= 1, format('P1 FAIL: CUR-A01 debería tener alumnos, retornó %s', cnt);
  RAISE NOTICE '[OK] P1: código válido retorna % alumno(s)', cnt;

  SELECT count(*) INTO cnt FROM apoderado_alumnos_curso('INVALIDO');
  ASSERT cnt = 0, format('P2 FAIL: código inválido debería retornar 0, retornó %s', cnt);
  RAISE NOTICE '[OK] P2: código inválido retorna vacío';
END;
$$;

-- ── P3-P5: Permisos reales como anon ──────────────────────────
-- Verifica que:
--   • Tablas protegidas lanzan 42501 con rol anon
--   • Todos los 5 RPC públicos tienen EXECUTE para anon
--   • El helper interno _apoderado_verificar_pin es inaccesible para anon
DO $$
DECLARE
  cuenta_a CONSTANT UUID := '00000000-0000-0000-aaaa-000000000001';
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '=== P3-P5: Permisos anon ===';

  SET LOCAL ROLE anon;

  -- Tablas protegidas
  BEGIN
    PERFORM id FROM alumnos LIMIT 1;
    ASSERT false, 'P3 FAIL: SELECT sobre alumnos debería fallar con 42501';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '[OK] P3a: SELECT directo a alumnos bloqueado (42501)';
  END;

  BEGIN
    PERFORM alumno_id FROM alumnos_credenciales LIMIT 1;
    ASSERT false, 'P3b FAIL: SELECT sobre alumnos_credenciales debería fallar con 42501';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '[OK] P3b: SELECT directo a alumnos_credenciales bloqueado (42501)';
  END;

  BEGIN
    PERFORM id FROM pagos LIMIT 1;
    ASSERT false, 'P3c FAIL: SELECT sobre pagos debería fallar con 42501';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '[OK] P3c: SELECT directo a pagos bloqueado (42501)';
  END;

  BEGIN
    PERFORM cuenta_id FROM apoderado_intentos LIMIT 1;
    ASSERT false, 'P3d FAIL: SELECT sobre apoderado_intentos debería fallar (RLS sin políticas)';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '[OK] P3d: SELECT directo a apoderado_intentos bloqueado (RLS)';
  END;

  -- Los 5 RPC públicos deben ser accesibles para anon
  BEGIN
    PERFORM apoderado_alumnos_curso('CUR-A01');
    RAISE NOTICE '[OK] P4a: anon puede ejecutar apoderado_alumnos_curso';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT false, 'P4a FAIL: anon debería tener EXECUTE en apoderado_alumnos_curso';
  END;

  BEGIN
    PERFORM apoderado_acceso(cuenta_a, 'alu-a-01', '1234');
    RAISE NOTICE '[OK] P4b: anon puede ejecutar apoderado_acceso';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT false, 'P4b FAIL: anon debería tener EXECUTE en apoderado_acceso';
  END;

  BEGIN
    PERFORM apoderado_situacion_financiera(cuenta_a, 'alu-a-01', '1234');
    RAISE NOTICE '[OK] P4c: anon puede ejecutar apoderado_situacion_financiera';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT false, 'P4c FAIL: anon debería tener EXECUTE en apoderado_situacion_financiera';
  END;

  BEGIN
    PERFORM apoderado_editar_contacto(cuenta_a, 'alu-a-01', '1234', 'apo-a-01', NULL, NULL, NULL, NULL);
    RAISE NOTICE '[OK] P4d: anon puede ejecutar apoderado_editar_contacto';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT false, 'P4d FAIL: anon debería tener EXECUTE en apoderado_editar_contacto';
  END;

  BEGIN
    PERFORM apoderado_agregar_contacto(cuenta_a, 'alu-a-01', '1234', 'Test', NULL, NULL, NULL);
    RAISE NOTICE '[OK] P4e: anon puede ejecutar apoderado_agregar_contacto';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT false, 'P4e FAIL: anon debería tener EXECUTE en apoderado_agregar_contacto';
  END;

  -- El helper INTERNO _apoderado_verificar_pin NO debe ser accesible para anon
  BEGIN
    PERFORM _apoderado_verificar_pin(cuenta_a, 'alu-a-01', '1234');
    ASSERT false, 'P5 FAIL: _apoderado_verificar_pin debería ser inaccesible para anon (42501)';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '[OK] P5: helper interno _apoderado_verificar_pin denegado a anon (42501)';
  END;

  RESET ROLE;
END;
$$;

-- ── P6-P9: Verificación PIN ────────────────────────────────────
DO $$
DECLARE
  v JSONB;
  cuenta_a CONSTANT UUID := '00000000-0000-0000-aaaa-000000000001';
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '=== P6-P9: Verificación PIN ===';

  v := apoderado_acceso(cuenta_a, 'alu-a-01', '1234');
  ASSERT v->>'error' IS NULL,
    format('P6 FAIL: error inesperado: %s', v->>'error');
  ASSERT v->'alumno' IS NOT NULL, 'P6 FAIL: falta clave alumno';
  RAISE NOTICE '[OK] P6: PIN correcto retorna alumno';

  ASSERT jsonb_array_length(v->'apoderados') >= 1,
    format('P6b FAIL: apoderados vacío: %s', v->'apoderados');
  RAISE NOTICE '[OK] P6b: apoderados presentes';

  ASSERT v->'cuotas_estado' IS NOT NULL, 'P6c FAIL: falta cuotas_estado';
  RAISE NOTICE '[OK] P6c: cuotas_estado presente';

  ASSERT v->'alumno'->>'obs' IS NULL,
    format('P6d FAIL: respuesta expone obs: %s', v->'alumno'->>'obs');
  RAISE NOTICE '[OK] P6d: obs interna no expuesta';

  ASSERT v->'alumno'->>'cuenta_id' IS NULL,
    format('P6e FAIL: respuesta expone cuenta_id: %s', v->'alumno'->>'cuenta_id');
  RAISE NOTICE '[OK] P6e: cuenta_id no expuesto';

  v := apoderado_acceso(cuenta_a, 'alu-a-01', NULL);
  ASSERT v->>'error' = 'pin_requerido',
    format('P7 FAIL: esperado pin_requerido, fue: %s', v->>'error');
  RAISE NOTICE '[OK] P7: PIN NULL → pin_requerido';

  v := apoderado_acceso(cuenta_a, 'alu-a-01', '');
  ASSERT v->>'error' = 'pin_requerido',
    format('P8 FAIL: esperado pin_requerido, fue: %s', v->>'error');
  RAISE NOTICE '[OK] P8: PIN vacío → pin_requerido';

  v := apoderado_acceso(cuenta_a, 'alu-a-01', '  ');
  ASSERT v->>'error' = 'pin_requerido',
    format('P8b FAIL: esperado pin_requerido, fue: %s', v->>'error');
  RAISE NOTICE '[OK] P8b: PIN solo espacios → pin_requerido';

  v := apoderado_acceso(cuenta_a, 'alu-a-01', '0000');
  ASSERT v->>'error' = 'pin_incorrecto',
    format('P9 FAIL: esperado pin_incorrecto, fue: %s', v->>'error');
  RAISE NOTICE '[OK] P9: PIN incorrecto → pin_incorrecto';

  v := apoderado_acceso(cuenta_a, 'alu-a-03', '1234');
  ASSERT v->>'error' = 'sin_credencial',
    format('P9b FAIL: esperado sin_credencial, fue: %s', v->>'error');
  RAISE NOTICE '[OK] P9b: alumno sin credencial → sin_credencial';
END;
$$;

-- ── P10: Bloqueo por intentos repetidos ───────────────────────
DO $$
DECLARE
  v JSONB;
  n INT;
  cuenta_a CONSTANT UUID := '00000000-0000-0000-aaaa-000000000001';
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '=== P10: Bloqueo ===';

  DELETE FROM apoderado_intentos WHERE cuenta_id = cuenta_a AND alumno_id = 'alu-a-02';

  PERFORM apoderado_acceso(cuenta_a, 'alu-a-02', '0000');
  PERFORM apoderado_acceso(cuenta_a, 'alu-a-02', '0000');
  PERFORM apoderado_acceso(cuenta_a, 'alu-a-02', '0000');
  PERFORM apoderado_acceso(cuenta_a, 'alu-a-02', '0000');
  PERFORM apoderado_acceso(cuenta_a, 'alu-a-02', '0000');

  SELECT intentos_fallo INTO n FROM apoderado_intentos
  WHERE cuenta_id = cuenta_a AND alumno_id = 'alu-a-02';
  ASSERT n IS NOT NULL AND n >= 5,
    format('P10-pre FAIL: esperado intentos_fallo>=5, fue: %s', n);

  v := apoderado_acceso(cuenta_a, 'alu-a-02', '5678');
  ASSERT v->>'error' = 'bloqueado',
    format('P10 FAIL: esperado bloqueado, fue: %s', v->>'error');
  RAISE NOTICE '[OK] P10: 6° intento → bloqueado (intentos=%)', n;

  v := apoderado_acceso(cuenta_a, 'alu-a-01', '1234');
  ASSERT v->>'error' IS NULL,
    format('P10b FAIL: alu-a-01 afectado por bloqueo de alu-a-02: %s', v->>'error');
  RAISE NOTICE '[OK] P10b: bloqueo no contagia a otro alumno';

  DELETE FROM apoderado_intentos WHERE cuenta_id = cuenta_a AND alumno_id = 'alu-a-02';
END;
$$;

-- ── P11-P13: Aislamiento entre familias ───────────────────────
DO $$
DECLARE
  v JSONB;
  cuenta_a CONSTANT UUID := '00000000-0000-0000-aaaa-000000000001';
  cuenta_b CONSTANT UUID := '00000000-0000-0000-bbbb-000000000002';
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '=== P11-P13: Aislamiento ===';

  v := apoderado_acceso(cuenta_b, 'alu-a-01', '1234');
  ASSERT v->>'error' IN ('alumno_inactivo','sin_credencial','pin_incorrecto'),
    format('P11 FAIL: cruce cuenta_b+alumno_a debería rechazar, fue: %s', v->>'error');
  RAISE NOTICE '[OK] P11: cuenta_b + alumno_a → % (rechazado)', v->>'error';

  v := apoderado_acceso(cuenta_a, 'alu-b-01', '9999');
  ASSERT v->>'error' IN ('alumno_inactivo','sin_credencial'),
    format('P12 FAIL: alumno_b bajo cuenta_a debería rechazar, fue: %s', v->>'error');
  RAISE NOTICE '[OK] P12: cuenta_a + alumno_b → % (rechazado)', v->>'error';

  v := apoderado_editar_contacto(cuenta_a, 'alu-a-01', '1234', 'apo-b-01', NULL, NULL, '+56999999999', NULL);
  ASSERT v->>'error' = 'no_autorizado',
    format('P13 FAIL: edición cruzada debería ser no_autorizado, fue: %s', v->>'error');
  RAISE NOTICE '[OK] P13: editar apoderado de otra familia → no_autorizado';
END;
$$;

-- ── P14-P15: Escritura y persistencia ─────────────────────────
SAVEPOINT sp_escritura;

DO $$
DECLARE
  v JSONB;
  cuenta_a CONSTANT UUID := '00000000-0000-0000-aaaa-000000000001';
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '=== P14-P15: Escritura y persistencia ===';

  v := apoderado_editar_contacto(cuenta_a, 'alu-a-01', '1234', 'apo-a-01', NULL, NULL, '+56912340099', NULL);
  ASSERT (v->>'ok')::boolean = true,
    format('P14 FAIL: editar teléfono retornó: %s', v);
  RAISE NOTICE '[OK] P14: editar teléfono → ok';

  v := apoderado_acceso(cuenta_a, 'alu-a-01', '1234');
  ASSERT EXISTS(
    SELECT 1 FROM jsonb_array_elements(v->'apoderados') ap
    WHERE ap->>'telefono' = '+56912340099'
  ), format('P15 FAIL: teléfono no persiste: %s', v->'apoderados');
  RAISE NOTICE '[OK] P15: teléfono persiste en re-lectura';

  v := apoderado_editar_contacto(cuenta_a, 'alu-a-01', '1234', 'apo-a-01', 'Carlos García R.', 'padre y apoderado', NULL, NULL);
  ASSERT (v->>'ok')::boolean = true,
    format('P15b FAIL: editar nombre/relación retornó: %s', v);

  v := apoderado_acceso(cuenta_a, 'alu-a-01', '1234');
  ASSERT EXISTS(
    SELECT 1 FROM jsonb_array_elements(v->'apoderados') ap
    WHERE ap->>'nombre' = 'Carlos García R.'
  ), format('P15c FAIL: nombre no persiste: %s', v->'apoderados');
  RAISE NOTICE '[OK] P15b-c: nombre y relación persistidos';
END;
$$;

ROLLBACK TO SAVEPOINT sp_escritura;

-- ── P17-P18: Situación financiera ─────────────────────────────
DO $$
DECLARE
  v       JSONB;
  plan    JSONB;
  balance JSONB;
  cuenta_a CONSTANT UUID := '00000000-0000-0000-aaaa-000000000001';
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '=== P17-P18: Situación financiera ===';

  v := apoderado_situacion_financiera(cuenta_a, 'alu-a-01', '1234');
  ASSERT v->>'error' IS NULL, format('P17 FAIL: error: %s', v->>'error');

  -- Estructura principal
  ASSERT jsonb_typeof(v->'pagos')         = 'array',  'P17 FAIL: pagos no es array';
  ASSERT jsonb_typeof(v->'planes')        = 'array',  'P17 FAIL: planes no es array';
  ASSERT jsonb_typeof(v->'comprobantes')  = 'array',  'P17 FAIL: comprobantes no es array';
  ASSERT jsonb_typeof(v->'balance_curso') = 'object', 'P17 FAIL: balance_curso no es object';
  RAISE NOTICE '[OK] P17a: estructura completa (pagos, planes, comprobantes, balance_curso)';

  -- ── P17b: balance_curso — lógica calcFinanzas() ─────────────────
  --
  -- El RPC aplica la misma regla que calcFinanzas() del frontend:
  --   total_ingresos = pagos_pagados + abonos_pagados_planes_activos + movimientos_ingreso_visible
  --   total_gastos   = movimientos_gasto_visible
  --   saldo          = total_ingresos - total_gastos
  --
  -- Datos activos del fixture (cur-a-01, cuenta_a):
  --
  --   PAGOS PAGADOS (alumnos de cur-a-01: alu-a-01, alu-a-02):
  --     pago-a-01          alu-a-01  15000 pagado  SUMA
  --     pago-a-02          alu-a-02  15000 pagado  SUMA (mismo curso)
  --     pago-a-tst-mar     alu-a-01  15000 pagado  SUMA
  --     pago-a-excl-pendiente alu-a-01 9999 pendiente  EXCLUIDO (estado<>pagado)
  --     total_recaudado_cuotas = 45000
  --
  --   ABONOS PAGADOS (planes activos, alumnos de cur-a-01):
  --     abono-a-09e   plan-a-09e (activo=TRUE)  5000 pagado=TRUE  SUMA
  --     abono-a-01    plan-a-01  pagado=FALSE         EXCLUIDO
  --     abono-a-inactivo plan-a-inactivo (activo=FALSE) 7777 pagado=TRUE  EXCLUIDO
  --     total_abonos_pagados = 5000
  --
  --   MOVIMIENTOS INGRESO visible=TRUE, curso=cur-a-01:
  --     mov-a-03  ingreso  15000  visible=TRUE   SUMA
  --     mov-a-otro-curso ingreso 11111 cur-a-02  EXCLUIDO (otro curso)
  --     total_ingresos_extra = 15000
  --
  --   MOVIMIENTOS GASTO visible=TRUE, curso=cur-a-01:
  --     mov-a-01  gasto   8000  visible=TRUE    SUMA
  --     mov-a-02  gasto   3000  visible=FALSE   EXCLUIDO
  --     total_gastos = 8000
  --
  --   TOTALES:
  --     total_ingresos = 45000+5000+15000 = 65000
  --     total_gastos   = 8000
  --     saldo          = 57000
  balance := v->'balance_curso';

  -- Campos presentes
  ASSERT balance ? 'total_ingresos',        'P17b FAIL: falta total_ingresos en balance_curso';
  ASSERT balance ? 'total_gastos',          'P17b FAIL: falta total_gastos en balance_curso';
  ASSERT balance ? 'saldo',                 'P17b FAIL: falta saldo en balance_curso';
  ASSERT balance ? 'total_recaudado_cuotas','P17b FAIL: falta total_recaudado_cuotas en balance_curso';
  ASSERT balance ? 'total_abonos_pagados',  'P17b FAIL: falta total_abonos_pagados en balance_curso';
  ASSERT balance ? 'total_ingresos_extra',  'P17b FAIL: falta total_ingresos_extra en balance_curso';

  -- Componentes individuales (verifican cada exclusión)
  ASSERT (balance->>'total_recaudado_cuotas')::numeric = 45000,
    format('P17b FAIL: total_recaudado_cuotas esperado 45000, obtenido %s (debe excluir estado pendiente)', balance->>'total_recaudado_cuotas');
  ASSERT (balance->>'total_abonos_pagados')::numeric = 5000,
    format('P17b FAIL: total_abonos_pagados esperado 5000, obtenido %s (debe excluir plan inactivo y pagado=false)', balance->>'total_abonos_pagados');
  ASSERT (balance->>'total_ingresos_extra')::numeric = 15000,
    format('P17b FAIL: total_ingresos_extra esperado 15000, obtenido %s (debe excluir otro curso)', balance->>'total_ingresos_extra');

  -- Totales
  ASSERT (balance->>'total_ingresos')::numeric = 65000,
    format('P17b FAIL: total_ingresos esperado 65000, obtenido %s', balance->>'total_ingresos');
  ASSERT (balance->>'total_gastos')::numeric = 8000,
    format('P17b FAIL: total_gastos esperado 8000, obtenido %s (debe excluir visible=false)', balance->>'total_gastos');
  ASSERT (balance->>'saldo')::numeric = 57000,
    format('P17b FAIL: saldo esperado 57000, obtenido %s', balance->>'saldo');

  -- Coherencia aritmética interna
  ASSERT (balance->>'saldo')::numeric
       = (balance->>'total_ingresos')::numeric - (balance->>'total_gastos')::numeric,
    format('P17b FAIL: saldo no cuadra: %s', balance);
  ASSERT (balance->>'total_ingresos')::numeric
       = (balance->>'total_recaudado_cuotas')::numeric
       + (balance->>'total_abonos_pagados')::numeric
       + (balance->>'total_ingresos_extra')::numeric,
    format('P17b FAIL: total_ingresos no suma componentes: %s', balance);

  RAISE NOTICE '[OK] P17b: balance_curso ingresos=65000 gastos=8000 saldo=57000 (pagos+abonos+movimientos; exclusiones verificadas)';

  -- planes: desglose de abonos por plan
  IF jsonb_array_length(v->'planes') > 0 THEN
    plan := (v->'planes')->0;
    ASSERT plan ? 'abonos',             'P17c FAIL: plan sin campo abonos';
    ASSERT plan ? 'abonos_pagados',     'P17c FAIL: plan sin abonos_pagados';
    ASSERT plan ? 'monto_pagado',       'P17c FAIL: plan sin monto_pagado';
    ASSERT plan ? 'abonos_pendientes',  'P17c FAIL: plan sin abonos_pendientes';
    ASSERT plan ? 'monto_pendiente',    'P17c FAIL: plan sin monto_pendiente';
    ASSERT jsonb_typeof(plan->'abonos') = 'array', 'P17c FAIL: plan.abonos no es array';
    -- abonos_pagados + abonos_pendientes = abonos_count
    ASSERT (plan->>'abonos_pagados')::int + (plan->>'abonos_pendientes')::int
         = (plan->>'abonos_count')::int,
      format('P17c FAIL: abonos_pagados+pendientes != abonos_count: %s', plan);
    -- monto_pagado + monto_pendiente = monto_abonado + monto_pendiente
    -- (monto_abonado == monto_pagado por definición)
    ASSERT (plan->>'monto_pagado')::numeric = (plan->>'monto_abonado')::numeric,
      format('P17c FAIL: monto_pagado != monto_abonado: %s', plan);
    RAISE NOTICE '[OK] P17c: plan con desglose abonos_pagados/pendientes y array abonos';
  ELSE
    RAISE NOTICE '[SKIP] P17c: sin planes para verificar desglose (fixture ok)';
  END IF;

  v := apoderado_situacion_financiera(cuenta_a, 'alu-a-01', '0000');
  ASSERT v->>'error' = 'pin_incorrecto',
    format('P18 FAIL: esperado pin_incorrecto, fue: %s', v->>'error');
  RAISE NOTICE '[OK] P18: PIN incorrecto rechazado en situación financiera';
END;
$$;

-- ── PC: Contenido correcto ─────────────────────────────────────
-- Formato de cuotas_estado: LEFT JOIN pagos → una fila por pago (cuota+periodo).
-- Una cuota sin pagos → una fila con periodo=NULL y estado_pago='pendiente'.
-- Una cuota con pago pagado → una fila con estado_pago='pagado' y el periodo.
DO $$
DECLARE
  v JSONB;
  cuenta_a CONSTANT UUID := '00000000-0000-0000-aaaa-000000000001';
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '=== PC: Contenido correcto ===';

  v := apoderado_acceso(cuenta_a, 'alu-a-01', '1234');

  -- PC1: cuota-a-01 aparece con estado_pago=pagado (tiene pago-a-01, Marzo 2025)
  ASSERT EXISTS(
    SELECT 1 FROM jsonb_array_elements(v->'cuotas_estado') c
    WHERE c->>'cuota_id' = 'cuota-a-01' AND c->>'estado_pago' = 'pagado'
  ), format('PC1 FAIL: cuota-a-01 pagado no encontrado: %s', v->'cuotas_estado');
  RAISE NOTICE '[OK] PC1: cuota-a-01 tiene fila con estado_pago=pagado';

  -- PC2: cuota-a-02 aparece con estado_pago=pendiente para alu-a-01.
  -- Usamos cuota-a-02 que NO tiene pago de alu-a-01 en seed (plan-a-01 es de alu-a-02).
  -- alu-a-01 no tiene pagos en cuota-a-02 → fila con periodo=NULL, estado=pendiente.
  ASSERT EXISTS(
    SELECT 1 FROM jsonb_array_elements(v->'cuotas_estado') c
    WHERE c->>'cuota_id' = 'cuota-a-02'
      AND c->>'estado_pago' = 'pendiente'
      AND (c->>'periodo') IS NULL
  ), format('PC2 FAIL: cuota-a-02 sin pago debería ser pendiente con periodo=null: %s',
            v->'cuotas_estado');
  RAISE NOTICE '[OK] PC2: cuota-a-02 con periodo=null y estado_pago=pendiente (sin pagos del alumno)';

  -- PC3: cuota de otro curso (cuota-a-03 → cur-a-02) no aparece
  ASSERT NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(v->'cuotas_estado') c
    WHERE c->>'cuota_id' = 'cuota-a-03'
  ), format('PC3 FAIL: cuota-a-03 (otro curso) aparece: %s', v->'cuotas_estado');
  RAISE NOTICE '[OK] PC3: cuota de otro curso no aparece';

  v := apoderado_situacion_financiera(cuenta_a, 'alu-a-01', '1234');

  ASSERT EXISTS(
    SELECT 1 FROM jsonb_array_elements(v->'pagos') p WHERE p->>'id' = 'pago-a-01'
  ), format('PC4 FAIL: pago-a-01 no aparece: %s', v->'pagos');
  RAISE NOTICE '[OK] PC4: pago-a-01 presente en pagos de alu-a-01';

  ASSERT NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(v->'pagos') p WHERE p->>'id' = 'pago-a-02'
  ), format('PC5 FAIL: pago-a-02 (de alu-a-02) aparece en pagos de alu-a-01: %s', v->'pagos');
  RAISE NOTICE '[OK] PC5: pago de otro alumno no aparece (aislamiento)';

  ASSERT EXISTS(
    SELECT 1 FROM jsonb_array_elements(v->'comprobantes') c WHERE c->>'id' = 'mov-a-01'
  ), format('PC6 FAIL: mov-a-01 (visible+comprobante) no aparece: %s', v->'comprobantes');
  RAISE NOTICE '[OK] PC6: movimiento visible con comprobante aparece';

  ASSERT NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(v->'comprobantes') c WHERE c->>'id' = 'mov-a-02'
  ), format('PC7 FAIL: mov-a-02 (visible=FALSE) aparece: %s', v->'comprobantes');
  RAISE NOTICE '[OK] PC7: movimiento oculto (visible=FALSE) no aparece';

  ASSERT NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(v->'comprobantes') c WHERE c->>'id' = 'mov-a-03'
  ), format('PC8 FAIL: mov-a-03 (sin URL) aparece: %s', v->'comprobantes');
  RAISE NOTICE '[OK] PC8: movimiento visible sin URL no aparece';

  ASSERT NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(v->'comprobantes') c WHERE c ? 'obs'
  ), 'PC9 FAIL: comprobantes expone campo obs';
  RAISE NOTICE '[OK] PC9: comprobantes sin obs interna';

  ASSERT EXISTS(
    SELECT 1 FROM jsonb_array_elements(v->'planes') p
    WHERE p->>'id' = 'plan-a-09e' AND (p->>'monto_abonado')::int = 5000
  ), format('PC10 FAIL: plan-a-09e con monto_abonado=5000 no aparece: %s', v->'planes');
  RAISE NOTICE '[OK] PC10: plan-a-09e con monto_abonado=5000 correcto';

  -- PC11: desglose abonos en plan-a-09e
  ASSERT EXISTS(
    SELECT 1 FROM jsonb_array_elements(v->'planes') p
    WHERE p->>'id' = 'plan-a-09e'
      AND (p->>'abonos_pagados')::int = 1
      AND (p->>'monto_pagado')::int = 5000
      AND (p->>'abonos_pendientes')::int = 0
      AND (p->>'monto_pendiente')::int = 0
      AND jsonb_array_length(p->'abonos') = 1
  ), format('PC11 FAIL: desglose abonos plan-a-09e incorrecto: %s', v->'planes');
  RAISE NOTICE '[OK] PC11: plan-a-09e abonos_pagados=1 monto_pagado=5000 abonos_pendientes=0';
END;
$$;

-- ── PC-PERIOD: Estado por período generado por calendario ───────
--
-- cuota-a-tst: mensual, mes_inicio=2 (Marzo), mes_termino=3 (Abril), anio=2025
--
-- Filas en pagos para alu-a-01 / cuota-a-tst:
--   pago-a-tst-mar: Marzo 2025, estado=pagado   → tiene fila en BD
--   Abril 2025:     SIN NINGUNA FILA en pagos   → generado por calendario
--
-- El RPC debe retornar DOS filas usando el calendario de la cuota:
--   - Marzo 2025 → pagado  (con pago_id)
--   - Abril 2025 → pendiente (pago_id=null, generado sin fila en BD)
--
-- Esto verifica la corrección del cálculo por calendario introducido
-- en la versión v9: la cuota no requiere fila en pagos para mostrar
-- un período pendiente.
DO $$
DECLARE
  v JSONB;
  cuenta_a CONSTANT UUID := '00000000-0000-0000-aaaa-000000000001';
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '=== PC-PERIOD: Estado por período (calendario, sin fila en pagos) ===';

  v := apoderado_acceso(cuenta_a, 'alu-a-01', '1234');

  -- PC-PERIOD1: Marzo 2025 = pagado (tiene pago en BD)
  ASSERT EXISTS(
    SELECT 1 FROM jsonb_array_elements(v->'cuotas_estado') c
    WHERE c->>'cuota_id'    = 'cuota-a-tst'
      AND c->>'periodo'     = 'Marzo 2025'
      AND c->>'estado_pago' = 'pagado'
      AND (c->>'pago_id') IS NOT NULL
  ), format('PC-PERIOD1 FAIL: cuota-a-tst Marzo 2025 no es pagado o falta pago_id: %s', v->'cuotas_estado');
  RAISE NOTICE '[OK] PC-PERIOD1: cuota-a-tst / Marzo 2025 → pagado (con pago_id)';

  -- PC-PERIOD2: Abril 2025 = pendiente GENERADO POR CALENDARIO (sin fila en pagos)
  ASSERT EXISTS(
    SELECT 1 FROM jsonb_array_elements(v->'cuotas_estado') c
    WHERE c->>'cuota_id'    = 'cuota-a-tst'
      AND c->>'periodo'     = 'Abril 2025'
      AND c->>'estado_pago' = 'pendiente'
      AND (c->>'pago_id') IS NULL
  ), format('PC-PERIOD2 FAIL: cuota-a-tst Abril 2025 no aparece pendiente sin pago_id (calendario): %s', v->'cuotas_estado');
  RAISE NOTICE '[OK] PC-PERIOD2: cuota-a-tst / Abril 2025 → pendiente (sin fila en pagos, generado por calendario)';

  -- PC-PERIOD3: Exactamente 2 filas para cuota-a-tst (Marzo y Abril del calendario)
  ASSERT (
    SELECT count(*) FROM jsonb_array_elements(v->'cuotas_estado') c
    WHERE c->>'cuota_id' = 'cuota-a-tst'
  ) = 2,
    format('PC-PERIOD3 FAIL: esperado 2 filas del calendario para cuota-a-tst, hay %s',
      (SELECT count(*) FROM jsonb_array_elements(v->'cuotas_estado') c
       WHERE c->>'cuota_id' = 'cuota-a-tst'));
  RAISE NOTICE '[OK] PC-PERIOD3: cuota-a-tst tiene exactamente 2 filas (Marzo y Abril del calendario)';
END;
$$;

-- ── PA: Agregar contacto ───────────────────────────────────────
SAVEPOINT sp_agregar;

DO $$
DECLARE
  v JSONB;
  cuenta_a CONSTANT UUID := '00000000-0000-0000-aaaa-000000000001';
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '=== PA: Agregar contacto ===';

  v := apoderado_agregar_contacto(cuenta_a, 'alu-a-01', '1234', 'María García', 'madre', '+56912340077', 'madre@test.cl');
  ASSERT (v->>'ok')::boolean = true, format('PA1 FAIL: agregar retornó: %s', v);
  ASSERT v->>'apoderado_id' IS NOT NULL, 'PA1 FAIL: apoderado_id no retornado';
  RAISE NOTICE '[OK] PA1: contacto agregado id=%', v->>'apoderado_id';

  v := apoderado_acceso(cuenta_a, 'alu-a-01', '1234');
  ASSERT jsonb_array_length(v->'apoderados') >= 2,
    format('PA2 FAIL: esperado >=2 apoderados, hay: %s', jsonb_array_length(v->'apoderados'));
  RAISE NOTICE '[OK] PA2: nuevo contacto visible en acceso';

  v := apoderado_agregar_contacto(cuenta_a, 'alu-a-01', '1234', '', NULL, NULL, NULL);
  ASSERT v->>'error' = 'nombre_requerido',
    format('PA3 FAIL: esperado nombre_requerido, fue: %s', v->>'error');
  RAISE NOTICE '[OK] PA3: nombre vacío → nombre_requerido';
END;
$$;

ROLLBACK TO SAVEPOINT sp_agregar;

-- ── PR: Revocación de acceso ───────────────────────────────────
SAVEPOINT sp_revocacion;

DO $$
DECLARE
  v JSONB;
  cnt BIGINT;
  cuenta_a CONSTANT UUID := '00000000-0000-0000-aaaa-000000000001';
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '=== PR: Revocación ===';

  -- PR1-PR2: cambio de PIN
  UPDATE alumnos_credenciales SET pin_hash = crypt('nuevo123', gen_salt('bf'))
  WHERE cuenta_id = cuenta_a AND alumno_id = 'alu-a-01';

  v := apoderado_acceso(cuenta_a, 'alu-a-01', '1234');
  ASSERT v->>'error' = 'pin_incorrecto',
    format('PR1 FAIL: PIN antiguo debería rechazarse, fue: %s', v->>'error');
  RAISE NOTICE '[OK] PR1: PIN antiguo rechazado tras cambio';

  v := apoderado_acceso(cuenta_a, 'alu-a-01', 'nuevo123');
  ASSERT v->>'error' IS NULL,
    format('PR2 FAIL: nuevo PIN debería aceptarse, fue: %s', v->>'error');
  RAISE NOTICE '[OK] PR2: nuevo PIN aceptado';

  -- PR3: alumno inactivo
  UPDATE alumnos SET estado = 'inactivo' WHERE cuenta_id = cuenta_a AND id = 'alu-a-01';

  v := apoderado_acceso(cuenta_a, 'alu-a-01', 'nuevo123');
  ASSERT v->>'error' = 'alumno_inactivo',
    format('PR3 FAIL: esperado alumno_inactivo, fue: %s', v->>'error');
  RAISE NOTICE '[OK] PR3: alumno inactivo → alumno_inactivo';

  UPDATE alumnos SET estado = 'activo' WHERE cuenta_id = cuenta_a AND id = 'alu-a-01';

  -- PR4-PR5: curso inactivo
  UPDATE cursos SET activo = FALSE WHERE cuenta_id = cuenta_a AND id = 'cur-a-01';

  v := apoderado_acceso(cuenta_a, 'alu-a-01', 'nuevo123');
  ASSERT v->>'error' = 'alumno_inactivo',
    format('PR4 FAIL: esperado alumno_inactivo (curso inactivo), fue: %s', v->>'error');
  RAISE NOTICE '[OK] PR4: curso inactivo → alumno_inactivo en RPC';

  SELECT count(*) INTO cnt FROM apoderado_alumnos_curso('CUR-A01');
  ASSERT cnt = 0,
    format('PR5 FAIL: selector debería omitir curso inactivo, retornó %s', cnt);
  RAISE NOTICE '[OK] PR5: selector omite alumnos de curso inactivo';

  UPDATE cursos SET activo = TRUE WHERE cuenta_id = cuenta_a AND id = 'cur-a-01';
END;
$$;

ROLLBACK TO SAVEPOINT sp_revocacion;

-- ══════════════════════════════════════════════════════════════
-- CC: Acceso compartido (codigo_compartido / CC-XXXX)
-- CC1: verificar código válido retorna datos del curso
-- CC2: código inválido retorna vacío
-- CC3: resumen de pagos retorna todos los alumnos del curso
-- CC4: resumen excluye alumnos de otro curso
-- CC5: generar código CC con PIN correcto
-- CC6: generar falla con PIN incorrecto
-- CC7: revocar código CC con PIN correcto
-- ══════════════════════════════════════════════════════════════
DO $$
DECLARE
  cuenta_a UUID := '00000000-0000-0000-aaaa-000000000001'::uuid;
  fila     RECORD;
  cnt      INT;
  nueva_cc JSONB;
  cc_cod   TEXT;
BEGIN
  -- CC1: código CC-TEST-0001 debe encontrar cur-a-01
  SELECT * INTO fila FROM apoderado_cc_verificar('CC-TEST-0001');
  ASSERT fila IS NOT NULL,
    'CC1 FAIL: CC-TEST-0001 no encontró ningún curso';
  ASSERT fila.curso_id = 'cur-a-01',
    format('CC1 FAIL: esperaba cur-a-01, obtuvo %s', fila.curso_id);
  ASSERT fila.nombre_curso IS NOT NULL AND fila.nombre_curso <> '',
    'CC1 FAIL: nombre_curso vacío';
  RAISE NOTICE '[OK] CC1: CC-TEST-0001 retorna cur-a-01 "%"', fila.nombre_curso;

  -- CC2: código inválido retorna vacío
  SELECT count(*) INTO cnt FROM apoderado_cc_verificar('CC-FAKE-9999');
  ASSERT cnt = 0,
    format('CC2 FAIL: código inválido debería retornar 0 filas, retornó %s', cnt);
  RAISE NOTICE '[OK] CC2: código inválido retorna 0 filas';

  -- CC3: resumen retorna ambos alumnos del curso
  SELECT count(*) INTO cnt
  FROM apoderado_cc_resumen_pagos(cuenta_a, 'cur-a-01');
  ASSERT cnt = 2,
    format('CC3 FAIL: esperaba 2 alumnos, obtuvo %s', cnt);
  RAISE NOTICE '[OK] CC3: resumen incluye % alumnos en cur-a-01', cnt;

  -- CC4: resumen de cur-a-02 no incluye alumnos de cur-a-01
  SELECT count(*) INTO cnt
  FROM apoderado_cc_resumen_pagos(cuenta_a, 'cur-a-02');
  -- cur-a-02 puede tener 0 o más alumnos; verificamos que alu-a-01 y alu-a-02 no estén
  FOR fila IN SELECT * FROM apoderado_cc_resumen_pagos(cuenta_a, 'cur-a-02') LOOP
    ASSERT fila.alumno_id NOT IN ('alu-a-01', 'alu-a-02'),
      format('CC4 FAIL: alu-a-01/alu-a-02 aparecieron en cur-a-02');
  END LOOP;
  RAISE NOTICE '[OK] CC4: resumen de cur-a-02 excluye alumnos de cur-a-01';

  -- CC5: generar código CC con PIN correcto
  nueva_cc := apoderado_cc_generar(cuenta_a, 'cur-a-01', 'alu-a-01', '1234');
  ASSERT nueva_cc ? 'codigo_cc',
    format('CC5 FAIL: respuesta no tiene clave codigo_cc: %s', nueva_cc);
  cc_cod := nueva_cc->>'codigo_cc';
  ASSERT cc_cod LIKE 'CC-%-%',
    format('CC5 FAIL: código generado no tiene formato CC-XXXX-XXXX: %s', cc_cod);
  -- Verificar que quedó en la BD
  SELECT count(*) INTO cnt FROM cursos
  WHERE cuenta_id = cuenta_a AND id = 'cur-a-01' AND codigo_compartido = cc_cod;
  ASSERT cnt = 1,
    format('CC5 FAIL: código %s no quedó en cursos.codigo_compartido', cc_cod);
  RAISE NOTICE '[OK] CC5: código generado % guardado en cursos', cc_cod;

  -- CC6: generar falla con PIN incorrecto
  BEGIN
    PERFORM apoderado_cc_generar(cuenta_a, 'cur-a-01', 'alu-a-01', '0000');
    RAISE EXCEPTION 'CC6 FAIL: debería haber lanzado excepción con PIN incorrecto';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    RAISE NOTICE '[OK] CC6: PIN incorrecto lanza excepción P0001';
  END;

  -- CC7: revocar código CC con PIN correcto
  PERFORM apoderado_cc_revocar(cuenta_a, 'cur-a-01', 'alu-a-01', '1234');
  SELECT count(*) INTO cnt FROM cursos
  WHERE cuenta_id = cuenta_a AND id = 'cur-a-01'
    AND codigo_compartido IS NOT NULL;
  ASSERT cnt = 0,
    'CC7 FAIL: codigo_compartido no fue eliminado tras revocar';
  RAISE NOTICE '[OK] CC7: código CC revocado (NULL en cursos)';

  -- Restaurar CC-TEST-0001 para no romper tests subsiguientes
  UPDATE cursos SET codigo_compartido = 'CC-TEST-0001'
  WHERE cuenta_id = cuenta_a AND id = 'cur-a-01';

END;
$$;

-- ── Fin ────────────────────────────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '══════════════════════════════════════════════════════';
  RAISE NOTICE 'Todas las pruebas unitarias pasaron.';
  RAISE NOTICE 'Pendiente de ejecución separada: sql/test_concurrencia.sh (C1, C2, C3)';
  RAISE NOTICE '══════════════════════════════════════════════════════';
END;
$$;

-- Deshacer todos los cambios de prueba
ROLLBACK;
