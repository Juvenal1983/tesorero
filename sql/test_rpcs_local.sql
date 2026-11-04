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
-- CC3: resumen de pagos (por código CC) retorna todos los alumnos del curso
-- CC4: resumen excluye alumnos de otro curso (aislamiento por código)
-- CC5: generar código CC requiere JWT de tesorero/admin
-- CC5b: generar falla si anon intenta llamar (42501 desde permisos PostgreSQL)
-- CC6: anon no puede llamar apoderado_cc_generar (42501 desde permisos PostgreSQL)
-- CC7: revocar código CC requiere JWT de tesorero/admin
-- CC8: tras revocar, resumen_pagos con el código anterior retorna vacío
-- ══════════════════════════════════════════════════════════════
DO $$
DECLARE
  cuenta_a UUID := '00000000-0000-0000-aaaa-000000000001'::uuid;
  fila     RECORD;
  cnt      INT;
  nueva_cc JSONB;
  cc_cod   TEXT;
  cc_02    TEXT;
BEGIN
  -- ── CC1: código CC-TEST-0001 debe encontrar cur-a-01 ─────────
-- (CC1-CC4 son independientes de la identidad del usuario → funcionan en staging)
-- (CC5-CC8 usan UUID simulado → LOCAL ONLY: ver sección de scope al final)
  SELECT * INTO fila FROM apoderado_cc_verificar('CC-TEST-0001');
  ASSERT fila IS NOT NULL,
    'CC1 FAIL: CC-TEST-0001 no encontró ningún curso';
  ASSERT fila.curso_id = 'cur-a-01',
    format('CC1 FAIL: esperaba cur-a-01, obtuvo %s', fila.curso_id);
  ASSERT fila.nombre_curso IS NOT NULL AND fila.nombre_curso <> '',
    'CC1 FAIL: nombre_curso vacío';
  RAISE NOTICE '[OK] CC1: CC-TEST-0001 retorna cur-a-01 "%"', fila.nombre_curso;

  -- ── CC2: código inválido retorna vacío ───────────────────────
  SELECT count(*) INTO cnt FROM apoderado_cc_verificar('CC-FAKE-9999');
  ASSERT cnt = 0,
    format('CC2 FAIL: código inválido debería retornar 0 filas, retornó %s', cnt);
  RAISE NOTICE '[OK] CC2: código inválido retorna 0 filas';

  -- ── CC3: resumen por código CC retorna alumnos del curso ─────
  -- La nueva firma acepta el código CC como único parámetro.
  SELECT count(*) INTO cnt
  FROM apoderado_cc_resumen_pagos('CC-TEST-0001');
  ASSERT cnt = 2,
    format('CC3 FAIL: esperaba 2 alumnos para CC-TEST-0001, obtuvo %s', cnt);
  RAISE NOTICE '[OK] CC3: resumen CC-TEST-0001 incluye % alumnos', cnt;

  -- ── CC4: resumen de otro código excluye alumnos de cur-a-01 ──
  -- Crear un código temporal para cur-a-02 y verificar aislamiento
  UPDATE cursos SET codigo_compartido = 'CC-TEST-0002'
  WHERE cuenta_id = cuenta_a AND id = 'cur-a-02';

  FOR fila IN SELECT * FROM apoderado_cc_resumen_pagos('CC-TEST-0002') LOOP
    ASSERT fila.alumno_id NOT IN ('alu-a-01', 'alu-a-02'),
      format('CC4 FAIL: alumno %s de cur-a-01 apareció en resumen de CC-TEST-0002',
             fila.alumno_id);
  END LOOP;
  RAISE NOTICE '[OK] CC4: resumen CC-TEST-0002 excluye alumnos de cur-a-01';

  -- Limpiar código temporal de cur-a-02
  UPDATE cursos SET codigo_compartido = NULL
  WHERE cuenta_id = cuenta_a AND id = 'cur-a-02';

  -- ── CC5: generar código CC con JWT de tesorero ───────────────
  -- [LOCAL ONLY] Usa UUID simulado aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
  -- que solo existe en el fixture local 09d. En staging omitir CC5-CC8.
  -- Simular JWT del tesorero (auth_id = aaaaaaaa-…-01 es dueño de cuenta_a)
  PERFORM set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}',
    true);
  SET LOCAL ROLE authenticated;

  nueva_cc := apoderado_cc_generar(cuenta_a, 'cur-a-01');
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);

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
  RAISE NOTICE '[OK] CC5: JWT tesorero generó código % guardado en cursos', cc_cod;

  -- ── CC5b: restaurar CC-TEST-0001 para CC3 (y cc_cod queda en cur-a-01) ──
  -- cc_cod es el nuevo código; lo necesitamos para CC7/CC8.
  -- También verificamos que CC-TEST-0001 ya no apunta a cur-a-01 (fue reemplazado).
  SELECT count(*) INTO cnt FROM cursos
  WHERE cuenta_id = cuenta_a AND id = 'cur-a-01' AND codigo_compartido = 'CC-TEST-0001';
  ASSERT cnt = 0,
    'CC5b FAIL: CC-TEST-0001 debería haber sido reemplazado por el nuevo código';
  RAISE NOTICE '[OK] CC5b: CC-TEST-0001 fue reemplazado por % en cursos', cc_cod;

  -- ── CC6: anon no puede llamar apoderado_cc_generar (42501) ───
  -- anon no tiene EXECUTE; PostgreSQL lanza 42501 antes de entrar al cuerpo.
  -- Usamos ERRCODE = '45000' en la aserción de fallo para que no sea capturado
  -- por el handler de insufficient_privilege (42501).
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM apoderado_cc_generar(cuenta_a, 'cur-a-01');
    RESET ROLE;
    -- Si llegamos aquí, el RPC aceptó la llamada → fallo real del test
    RAISE EXCEPTION 'CC6 FAIL: anon pudo llamar apoderado_cc_generar'
      USING ERRCODE = '45000';    -- <-- ERRCODE distinto: no lo captura el EXCEPTION de abajo
  EXCEPTION
    WHEN insufficient_privilege THEN   -- 42501
      RESET ROLE;
      RAISE NOTICE '[OK] CC6: anon no puede llamar apoderado_cc_generar (42501)';
  END;

  -- ── CC7: revocar código CC con JWT de tesorero ──────────────
  -- [LOCAL ONLY] idem CC5
  PERFORM set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}',
    true);
  SET LOCAL ROLE authenticated;

  PERFORM apoderado_cc_revocar(cuenta_a, 'cur-a-01');
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);

  SELECT count(*) INTO cnt FROM cursos
  WHERE cuenta_id = cuenta_a AND id = 'cur-a-01'
    AND codigo_compartido IS NOT NULL;
  ASSERT cnt = 0,
    'CC7 FAIL: codigo_compartido no fue eliminado tras revocar';
  RAISE NOTICE '[OK] CC7: JWT tesorero revocó el código CC (NULL en cursos)';

  -- ── CC8: tras revocar, resumen_pagos con el código anterior retorna vacío ──
  -- cc_cod tenía el código generado en CC5; ahora debe ser inválido.
  SELECT count(*) INTO cnt
  FROM apoderado_cc_resumen_pagos(cc_cod);
  ASSERT cnt = 0,
    format('CC8 FAIL: código revocado %s aún retorna %s filas', cc_cod, cnt);
  RAISE NOTICE '[OK] CC8: código revocado % retorna 0 filas en resumen_pagos', cc_cod;

  -- ── Restaurar CC-TEST-0001 para no romper tests subsiguientes ──
  UPDATE cursos SET codigo_compartido = 'CC-TEST-0001'
  WHERE cuenta_id = cuenta_a AND id = 'cur-a-01';

END;
$$;

-- ══════════════════════════════════════════════════════════════
-- Sección CC-PER: Resumen compartido con lógica por período
-- ══════════════════════════════════════════════════════════════
-- CC9:  cuota mensual 4 meses (mar-jun), solo marzo pagado por alu-a-01.
--       Verifica deuda exacta y períodos pendientes.
-- CC10: alumno eximido aparece con 0 obligaciones.
-- CC11: abono en plan de pago reduce monto_pendiente sin duplicar pagos.
--
-- Nota: CC9-CC11 crean datos temporales dentro de la transacción
-- (ROLLBACK al final) para no afectar los fixtures permanentes.
-- Son independientes del UUID simulado → funcionan en LOCAL y en STAGING.
-- ══════════════════════════════════════════════════════════════
DO $$
DECLARE
  cuenta_a UUID := '00000000-0000-0000-aaaa-000000000001'::uuid;
  fila     RECORD;
  r_a01    RECORD;
  r_a02    RECORD;
  r_a04    RECORD;
BEGIN

  -- ── Datos temporales para CC9-CC11 ───────────────────────────
  -- Usamos cur-a-02 (un alumno: alu-a-03, cuota-a-03 no mensual sin pagos)
  -- para evitar interferencia con los fixtures de cur-a-01.
  -- Código CC temporal para cur-a-02:
  UPDATE cursos SET codigo_compartido = 'CC-TEST-PER'
  WHERE cuenta_id = cuenta_a AND id = 'cur-a-02';

  -- Cuota mensual nueva: mar-jun 2025 (4 períodos, $10 000 c/u)
  INSERT INTO cuotas (cuenta_id, id, curso_id, nombre, tipo, monto, anio,
                      mes_inicio, mes_termino, activa)
  VALUES (cuenta_a, 'cuota-mens-cc9', 'cur-a-02',
          'Cuota mensual CC9 mar-jun', 'mensual', 10000, 2025, 2, 5, true)
  ON CONFLICT (cuenta_id, id) DO NOTHING;

  -- Alumno extra (eximido para CC10) en cur-a-02
  INSERT INTO alumnos (cuenta_id, id, curso_id, nombres, apellidos, estado, eximido)
  VALUES (cuenta_a, 'alu-cc9-b', 'cur-a-02', 'Alumno', 'Eximido', 'activo', false)
  ON CONFLICT (cuenta_id, id) DO NOTHING;

  -- Pago de alu-a-03 para Marzo 2025 únicamente
  INSERT INTO pagos (cuenta_id, id, alumno_id, cuota_id, monto, fecha,
                     medio, estado, periodo)
  VALUES (cuenta_a, 'pago-cc9-01', 'alu-a-03', 'cuota-mens-cc9',
          10000, '2025-03-05', 'transferencia', 'pagado', 'Marzo 2025')
  ON CONFLICT (cuenta_id, id) DO NOTHING;

  -- ── CC9: período exacto para alu-a-03 ────────────────────────
  -- cur-a-02 tiene:
  --   cuota-a-03 (NULL tipo = no mensual, $12000, sin pago)
  --   cuota-mens-cc9 (mensual, 4 meses, $10000, Marzo pagado)
  -- alu-a-03: 1 cuota pagada (Marzo), 4 pendientes (3 mens + 1 no-mensual)
  -- monto_pagado = 10000, monto_pendiente = 12000 + 30000 = 42000
  SELECT * INTO r_a01
  FROM apoderado_cc_resumen_pagos('CC-TEST-PER')
  WHERE alumno_id = 'alu-a-03';

  ASSERT r_a01 IS NOT NULL,
    'CC9 FAIL: alu-a-03 no apareció en resumen CC-TEST-PER';
  ASSERT r_a01.num_cuotas_pagadas = 1,
    format('CC9 FAIL: alu-a-03 esperaba 1 período pagado (Marzo), obtuvo %s',
           r_a01.num_cuotas_pagadas);
  ASSERT r_a01.num_cuotas_pendientes = 4,
    format('CC9 FAIL: alu-a-03 esperaba 4 pendientes (3 mens + 1 anual), obtuvo %s',
           r_a01.num_cuotas_pendientes);
  ASSERT r_a01.monto_pendiente = 42000,
    format('CC9 FAIL: alu-a-03 monto_pendiente esperado 42000, obtuvo %s',
           r_a01.monto_pendiente);
  RAISE NOTICE '[OK] CC9: alu-a-03 — 1 pagada (Marzo), 4 pendientes, monto_pendiente=42000';

  -- ── CC10: alumno eximido tiene 0 obligaciones ────────────────
  -- Marcar alu-cc9-b como eximido
  UPDATE alumnos SET eximido = true WHERE cuenta_id = cuenta_a AND id = 'alu-cc9-b';

  SELECT * INTO r_a02
  FROM apoderado_cc_resumen_pagos('CC-TEST-PER')
  WHERE alumno_id = 'alu-cc9-b';

  ASSERT r_a02 IS NOT NULL,
    'CC10 FAIL: alu-cc9-b (eximido) no apareció en resumen';
  ASSERT r_a02.num_cuotas_pagadas = 0,
    format('CC10 FAIL: alumno eximido debería tener 0 pagadas, obtuvo %s',
           r_a02.num_cuotas_pagadas);
  ASSERT r_a02.num_cuotas_pendientes = 0,
    format('CC10 FAIL: alumno eximido debería tener 0 pendientes, obtuvo %s',
           r_a02.num_cuotas_pendientes);
  ASSERT r_a02.monto_pendiente = 0,
    format('CC10 FAIL: alumno eximido monto_pendiente esperado 0, obtuvo %s',
           r_a02.monto_pendiente);
  RAISE NOTICE '[OK] CC10: alu-cc9-b (eximido) — 0 pagadas, 0 pendientes, 0 deuda';

  -- ── CC11: abono reduce monto_pendiente sin duplicar pagos ────
  -- alu-cc9-b (eximido=true), quitamos exención y añadimos abono
  UPDATE alumnos SET eximido = false WHERE cuenta_id = cuenta_a AND id = 'alu-cc9-b';

  -- Plan de pago y abono para cuota-mens-cc9 de alu-cc9-b
  INSERT INTO planes_pago (cuenta_id, id, alumno_id, cuota_id, monto_total, activo)
  VALUES (cuenta_a, 'plan-cc9-01', 'alu-cc9-b', 'cuota-mens-cc9', 40000, true)
  ON CONFLICT (cuenta_id, id) DO NOTHING;

  INSERT INTO abonos (cuenta_id, id, alumno_id, cuota_id, plan_id, monto, pagado)
  VALUES (cuenta_a, 'abono-cc9-01', 'alu-cc9-b', 'cuota-mens-cc9', 'plan-cc9-01',
          15000, true)
  ON CONFLICT (cuenta_id, id) DO NOTHING;

  -- alu-cc9-b: cuota-a-03 ($12000 no-mens) + cuota-mens-cc9 (4 × $10000 = $40000)
  --   total obligado = 52000, abono = 15000
  --   monto_pendiente = 52000 - 15000 = 37000, num_cuotas_pendientes = 5 (abiertos)
  SELECT * INTO r_a04
  FROM apoderado_cc_resumen_pagos('CC-TEST-PER')
  WHERE alumno_id = 'alu-cc9-b';

  ASSERT r_a04 IS NOT NULL,
    'CC11 FAIL: alu-cc9-b no apareció en resumen';
  ASSERT r_a04.monto_abonado = 15000,
    format('CC11 FAIL: monto_abonado esperado 15000, obtuvo %s', r_a04.monto_abonado);
  ASSERT r_a04.monto_pendiente = 37000,
    format('CC11 FAIL: monto_pendiente esperado 37000, obtuvo %s', r_a04.monto_pendiente);
  ASSERT r_a04.num_cuotas_pendientes = 5,  -- abono no cierra períodos
    format('CC11 FAIL: num_cuotas_pendientes esperado 5, obtuvo %s',
           r_a04.num_cuotas_pendientes);
  RAISE NOTICE '[OK] CC11: alu-cc9-b — abono 15000 reduce pendiente a 37000 (5 períodos siguen abiertos)';

  -- ── Limpieza de datos temporales ─────────────────────────────
  DELETE FROM abonos      WHERE cuenta_id = cuenta_a AND id = 'abono-cc9-01';
  DELETE FROM planes_pago WHERE cuenta_id = cuenta_a AND id = 'plan-cc9-01';
  DELETE FROM pagos       WHERE cuenta_id = cuenta_a AND id = 'pago-cc9-01';
  DELETE FROM alumnos     WHERE cuenta_id = cuenta_a AND id = 'alu-cc9-b';
  DELETE FROM cuotas      WHERE cuenta_id = cuenta_a AND id = 'cuota-mens-cc9';
  UPDATE cursos SET codigo_compartido = NULL
  WHERE cuenta_id = cuenta_a AND id = 'cur-a-02';

END;
$$;

-- ══════════════════════════════════════════════════════════════
-- Sección CC-ESC: Scope de curso en generar/revocar
-- [LOCAL ONLY] Los tests CC-ESC1-CC-ESC5 usan JWT simulado con el
-- UUID aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa (solo existe en fixture 09d).
-- En staging, usar credenciales reales de Supabase: obtener token JWT
-- de un usuario real y probarlo contra /rpc/apoderado_cc_generar
-- sin modificar sus datos existentes.
--
-- CC-ESC1: tesorero de cur-a-01 no puede gestionar cur-a-02 (misma cuenta)
-- CC-ESC2: visor rechazado (42501)
-- CC-ESC3: editor rechazado (42501)
-- CC-ESC4: miembro desactivado rechazado (42501)
-- CC-ESC5: usuario externo (cuenta distinta) rechazado (42501)
-- ══════════════════════════════════════════════════════════════
-- CC-ESC1: tesorero scoped a cur-a-01 NO puede gestionar cur-a-02
-- [LOCAL ONLY] Usa un UUID diferente al del dueño para evitar que
-- es_dueno() anule el check de scope de curso.
DO $$
DECLARE
  cuenta_a   UUID := '00000000-0000-0000-aaaa-000000000001'::uuid;
  -- UUID distinto al dueño (aaaaaaaa-…) → NO es dueño de cuenta_a
  tes_scoped UUID := 'cccccccc-cccc-cccc-cccc-000000000001';
BEGIN
  -- Membresía: tesorero solo en cur-a-01
  INSERT INTO usuarios_cuenta (cuenta_id, id, auth_id, email, nombre, rol, curso_id, desactivado)
  VALUES (cuenta_a, 'uc-esc-tesorero-01', tes_scoped,
          'esc-test@local.test', 'Tesorero ESC Test', 'tesorero', 'cur-a-01', false)
  ON CONFLICT (cuenta_id, id) DO NOTHING;

  -- Intentar generar código para cur-a-02 (distinto al curso asignado)
  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', tes_scoped), true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM apoderado_cc_generar(cuenta_a, 'cur-a-02');
    RESET ROLE;
    RAISE EXCEPTION 'CC-ESC1 FAIL: tesorero de cur-a-01 pudo generar código para cur-a-02'
      USING ERRCODE = '45000';
  EXCEPTION
    WHEN insufficient_privilege THEN   -- 42501
      RESET ROLE;
      RAISE NOTICE '[OK] CC-ESC1: tesorero de cur-a-01 no puede gestionar cur-a-02 (42501)';
  END;
  PERFORM set_config('request.jwt.claims', '', true);

  DELETE FROM usuarios_cuenta WHERE cuenta_id = cuenta_a AND id = 'uc-esc-tesorero-01';
END;
$$;

-- CC-ESC2: visor rechazado  [LOCAL ONLY]
DO $$
DECLARE
  cuenta_a UUID := '00000000-0000-0000-aaaa-000000000001'::uuid;
  visor_id UUID := 'bbbbbbbb-bbbb-bbbb-bbbb-000000000001';
BEGIN
  INSERT INTO usuarios_cuenta (cuenta_id, id, auth_id, email, nombre, rol, desactivado)
  VALUES (cuenta_a, 'uc-esc-visor', visor_id, 'visor@local.test', 'Visor', 'visor', false)
  ON CONFLICT (cuenta_id, id) DO NOTHING;

  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', visor_id), true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM apoderado_cc_generar(cuenta_a, 'cur-a-01');
    RESET ROLE;
    RAISE EXCEPTION 'CC-ESC2 FAIL: visor pudo generar código CC'
      USING ERRCODE = '45000';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RESET ROLE;
      RAISE NOTICE '[OK] CC-ESC2: visor rechazado en generar (42501)';
  END;
  PERFORM set_config('request.jwt.claims', '', true);
  DELETE FROM usuarios_cuenta WHERE cuenta_id = cuenta_a AND id = 'uc-esc-visor';
END;
$$;

-- CC-ESC3: editor rechazado  [LOCAL ONLY]
DO $$
DECLARE
  cuenta_a  UUID := '00000000-0000-0000-aaaa-000000000001'::uuid;
  editor_id UUID := 'bbbbbbbb-bbbb-bbbb-bbbb-000000000002';
BEGIN
  INSERT INTO usuarios_cuenta (cuenta_id, id, auth_id, email, nombre, rol, desactivado)
  VALUES (cuenta_a, 'uc-esc-editor', editor_id, 'editor@local.test', 'Editor', 'editor', false)
  ON CONFLICT (cuenta_id, id) DO NOTHING;

  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', editor_id), true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM apoderado_cc_generar(cuenta_a, 'cur-a-01');
    RESET ROLE;
    RAISE EXCEPTION 'CC-ESC3 FAIL: editor pudo generar código CC'
      USING ERRCODE = '45000';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RESET ROLE;
      RAISE NOTICE '[OK] CC-ESC3: editor rechazado en generar (42501)';
  END;
  PERFORM set_config('request.jwt.claims', '', true);
  DELETE FROM usuarios_cuenta WHERE cuenta_id = cuenta_a AND id = 'uc-esc-editor';
END;
$$;

-- CC-ESC4: miembro desactivado rechazado  [LOCAL ONLY]
DO $$
DECLARE
  cuenta_a  UUID := '00000000-0000-0000-aaaa-000000000001'::uuid;
  desact_id UUID := 'bbbbbbbb-bbbb-bbbb-bbbb-000000000003';
BEGIN
  INSERT INTO usuarios_cuenta (cuenta_id, id, auth_id, email, nombre, rol, desactivado)
  VALUES (cuenta_a, 'uc-esc-desact', desact_id, 'desact@local.test',
          'Desactivado', 'tesorero', true)
  ON CONFLICT (cuenta_id, id) DO NOTHING;

  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', desact_id), true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM apoderado_cc_generar(cuenta_a, 'cur-a-01');
    RESET ROLE;
    RAISE EXCEPTION 'CC-ESC4 FAIL: miembro desactivado pudo generar código CC'
      USING ERRCODE = '45000';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RESET ROLE;
      RAISE NOTICE '[OK] CC-ESC4: miembro desactivado rechazado en generar (42501)';
  END;
  PERFORM set_config('request.jwt.claims', '', true);
  DELETE FROM usuarios_cuenta WHERE cuenta_id = cuenta_a AND id = 'uc-esc-desact';
END;
$$;

-- CC-ESC5: usuario externo (cuenta B) rechazado  [LOCAL ONLY]
DO $$
DECLARE
  cuenta_a UUID := '00000000-0000-0000-aaaa-000000000001'::uuid;
  user_b   UUID := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';  -- dueño de cuenta_b
BEGIN
  -- user_b es dueño de cuenta_b, NO tiene membresía en cuenta_a
  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', user_b), true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM apoderado_cc_generar(cuenta_a, 'cur-a-01');
    RESET ROLE;
    RAISE EXCEPTION 'CC-ESC5 FAIL: usuario externo pudo generar código en cuenta_a'
      USING ERRCODE = '45000';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RESET ROLE;
      RAISE NOTICE '[OK] CC-ESC5: usuario externo rechazado en cuenta_a (42501)';
  END;
  PERFORM set_config('request.jwt.claims', '', true);
END;
$$;

-- ════════════════════════════════════════════════════════════════
-- CC-ESC-R: Rechazos de alcance/rol en apoderado_cc_revocar
-- Espejo exacto de CC-ESC1-CC-ESC5 pero llamando a revocar.
-- Primero generamos un código válido como dueño para que haya algo que revocar.
-- ════════════════════════════════════════════════════════════════

-- CC-ESC-R0: generar código válido para cur-a-01 (dueño de cuenta_a) [LOCAL ONLY]
DO $$
DECLARE
  cuenta_a  UUID   := '00000000-0000-0000-aaaa-000000000001'::uuid;
  user_a    UUID   := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_codigo  TEXT;
BEGIN
  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', user_a), true);
  SET LOCAL ROLE authenticated;
  SELECT apoderado_cc_generar(cuenta_a, 'cur-a-01')->>'codigo_cc' INTO v_codigo;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RAISE NOTICE '[setup] CC-ESC-R0: código generado para cur-a-01: %', v_codigo;
END;
$$;

-- CC-ESC-R1: tesorero de cur-a-01 no puede revocar código de cur-a-02  [LOCAL ONLY]
DO $$
DECLARE
  cuenta_a  UUID   := '00000000-0000-0000-aaaa-000000000001'::uuid;
  sim_uuid  UUID   := 'cccccccc-cccc-cccc-cccc-000000000001';
BEGIN
  -- Insertar membresía tesorero scoped a cur-a-01
  INSERT INTO usuarios_cuenta(cuenta_id, id, auth_id, email, rol, curso_id, desactivado)
  VALUES (cuenta_a, 'uc-esc-r1', sim_uuid, 'esc-r1@test.local', 'tesorero', 'cur-a-01', false)
  ON CONFLICT DO NOTHING;

  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', sim_uuid), true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM apoderado_cc_revocar(cuenta_a, 'cur-a-02');
    RESET ROLE;
    RAISE EXCEPTION 'CC-ESC-R1 FAIL: tesorero de cur-a-01 pudo revocar código de cur-a-02'
      USING ERRCODE = '45000';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RESET ROLE;
      RAISE NOTICE '[OK] CC-ESC-R1: tesorero de cur-a-01 no puede revocar cur-a-02 (42501)';
  END;
  PERFORM set_config('request.jwt.claims', '', true);
  DELETE FROM usuarios_cuenta WHERE cuenta_id = cuenta_a AND id = 'uc-esc-r1';
END;
$$;

-- CC-ESC-R2: visor rechazado en revocar  [LOCAL ONLY]
DO $$
DECLARE
  cuenta_a  UUID := '00000000-0000-0000-aaaa-000000000001'::uuid;
  sim_uuid  UUID := 'bbbbbbbb-bbbb-bbbb-bbbb-000000000001';
BEGIN
  INSERT INTO usuarios_cuenta(cuenta_id, id, auth_id, email, rol, curso_id, desactivado)
  VALUES (cuenta_a, 'uc-esc-r2', sim_uuid, 'esc-r2@test.local', 'visor', 'cur-a-01', false)
  ON CONFLICT DO NOTHING;

  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', sim_uuid), true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM apoderado_cc_revocar(cuenta_a, 'cur-a-01');
    RESET ROLE;
    RAISE EXCEPTION 'CC-ESC-R2 FAIL: visor pudo revocar código CC'
      USING ERRCODE = '45000';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RESET ROLE;
      RAISE NOTICE '[OK] CC-ESC-R2: visor rechazado en revocar (42501)';
  END;
  PERFORM set_config('request.jwt.claims', '', true);
  DELETE FROM usuarios_cuenta WHERE cuenta_id = cuenta_a AND id = 'uc-esc-r2';
END;
$$;

-- CC-ESC-R3: editor rechazado en revocar  [LOCAL ONLY]
DO $$
DECLARE
  cuenta_a  UUID := '00000000-0000-0000-aaaa-000000000001'::uuid;
  sim_uuid  UUID := 'bbbbbbbb-bbbb-bbbb-bbbb-000000000002';
BEGIN
  INSERT INTO usuarios_cuenta(cuenta_id, id, auth_id, email, rol, curso_id, desactivado)
  VALUES (cuenta_a, 'uc-esc-r3', sim_uuid, 'esc-r3@test.local', 'editor', 'cur-a-01', false)
  ON CONFLICT DO NOTHING;

  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', sim_uuid), true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM apoderado_cc_revocar(cuenta_a, 'cur-a-01');
    RESET ROLE;
    RAISE EXCEPTION 'CC-ESC-R3 FAIL: editor pudo revocar código CC'
      USING ERRCODE = '45000';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RESET ROLE;
      RAISE NOTICE '[OK] CC-ESC-R3: editor rechazado en revocar (42501)';
  END;
  PERFORM set_config('request.jwt.claims', '', true);
  DELETE FROM usuarios_cuenta WHERE cuenta_id = cuenta_a AND id = 'uc-esc-r3';
END;
$$;

-- CC-ESC-R4: miembro desactivado rechazado en revocar  [LOCAL ONLY]
DO $$
DECLARE
  cuenta_a  UUID := '00000000-0000-0000-aaaa-000000000001'::uuid;
  sim_uuid  UUID := 'bbbbbbbb-bbbb-bbbb-bbbb-000000000003';
BEGIN
  INSERT INTO usuarios_cuenta(cuenta_id, id, auth_id, email, rol, curso_id, desactivado)
  VALUES (cuenta_a, 'uc-esc-r4', sim_uuid, 'esc-r4@test.local', 'tesorero', 'cur-a-01', true)
  ON CONFLICT DO NOTHING;

  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', sim_uuid), true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM apoderado_cc_revocar(cuenta_a, 'cur-a-01');
    RESET ROLE;
    RAISE EXCEPTION 'CC-ESC-R4 FAIL: miembro desactivado pudo revocar código CC'
      USING ERRCODE = '45000';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RESET ROLE;
      RAISE NOTICE '[OK] CC-ESC-R4: miembro desactivado rechazado en revocar (42501)';
  END;
  PERFORM set_config('request.jwt.claims', '', true);
  DELETE FROM usuarios_cuenta WHERE cuenta_id = cuenta_a AND id = 'uc-esc-r4';
END;
$$;

-- CC-ESC-R5: usuario externo (cuenta B) rechazado en revocar  [LOCAL ONLY]
DO $$
DECLARE
  cuenta_a UUID := '00000000-0000-0000-aaaa-000000000001'::uuid;
  user_b   UUID := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
BEGIN
  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', user_b), true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM apoderado_cc_revocar(cuenta_a, 'cur-a-01');
    RESET ROLE;
    RAISE EXCEPTION 'CC-ESC-R5 FAIL: usuario externo pudo revocar código en cuenta_a'
      USING ERRCODE = '45000';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RESET ROLE;
      RAISE NOTICE '[OK] CC-ESC-R5: usuario externo rechazado en revocar (42501)';
  END;
  PERFORM set_config('request.jwt.claims', '', true);
END;
$$;

-- ══════════════════════════════════════════════════════════════
-- CC-ESC-6 y CC-ESC-7: correctitud del cálculo por obligación
-- en apoderado_cc_resumen_pagos
--
-- CC-ESC-6: un abono cuya cuota ya está cubierta por pagos NO debe
--           reducir el pendiente de otra cuota del mismo alumno.
-- CC-ESC-7: varios pagos para la misma cuota no-mensual NO deben
--           multiplicar el monto obligado de esa cuota.
--
-- Ambos tests son independientes del JWT → válidos LOCAL y STAGING.
-- Se crean cursos temporales (cur-esc6, cur-esc7) con código CC
-- propio; todo se elimina con DELETE explícito antes del ROLLBACK.
-- ══════════════════════════════════════════════════════════════
DO $$
DECLARE
  cuenta_a UUID := '00000000-0000-0000-aaaa-000000000001'::uuid;
  r_esc6   RECORD;
  r_esc7   RECORD;
BEGIN

  -- ════════════════════════════════════════════════════════════
  -- CC-ESC-6: abono en obligación cubierta no "derrama" a otra
  -- ────────────────────────────────────────────────────────────
  -- Escenario:
  --   • cuota-esc6-c1 (mensual, Marzo 2025, $10 000) → pago completo
  --   • cuota-esc6-c2 (mensual, Abril 2025, $10 000) → sin pago
  --   • plan-esc6-01 con abono $5 000 para cuota-esc6-c1 (ya cubierta)
  -- Comportamiento esperado:
  --   monto_pendiente  = 10 000 (sólo C2 pendiente)
  --   monto_abonado    =      0 (abono en C1 cubierta queda en 0 efectivo)
  --   num_cuotas_pagadas   = 1
  --   num_cuotas_pendientes = 1
  -- ════════════════════════════════════════════════════════════

  INSERT INTO cursos (cuenta_id, id, nombre, activo, codigo_compartido)
  VALUES (cuenta_a, 'cur-esc6', 'Curso ESC6 temp', true, 'CC-ESC6-TEST')
  ON CONFLICT (cuenta_id, id) DO NOTHING;

  -- C1: sólo Marzo (mes 2 = índice base-0 en el array de meses)
  INSERT INTO cuotas (cuenta_id, id, curso_id, nombre, tipo,
                      monto, anio, mes_inicio, mes_termino, activa)
  VALUES (cuenta_a, 'cuota-esc6-c1', 'cur-esc6',
          'Cuota ESC6 C1 Marzo', 'mensual', 10000, 2025, 2, 2, true)
  ON CONFLICT (cuenta_id, id) DO NOTHING;

  -- C2: sólo Abril (mes 3)
  INSERT INTO cuotas (cuenta_id, id, curso_id, nombre, tipo,
                      monto, anio, mes_inicio, mes_termino, activa)
  VALUES (cuenta_a, 'cuota-esc6-c2', 'cur-esc6',
          'Cuota ESC6 C2 Abril', 'mensual', 10000, 2025, 3, 3, true)
  ON CONFLICT (cuenta_id, id) DO NOTHING;

  INSERT INTO alumnos (cuenta_id, id, curso_id, nombres, apellidos, estado, eximido)
  VALUES (cuenta_a, 'alu-esc6', 'cur-esc6', 'Alumno', 'ESC6', 'activo', false)
  ON CONFLICT (cuenta_id, id) DO NOTHING;

  -- Pago completo de C1 / Marzo 2025
  INSERT INTO pagos (cuenta_id, id, alumno_id, cuota_id,
                     monto, fecha, medio, estado, periodo)
  VALUES (cuenta_a, 'pago-esc6-01', 'alu-esc6', 'cuota-esc6-c1',
          10000, '2025-03-05', 'transferencia', 'pagado', 'Marzo 2025')
  ON CONFLICT (cuenta_id, id) DO NOTHING;

  -- Plan y abono para C1 (C1 ya está cubierta; el abono debe quedar sin efecto)
  INSERT INTO planes_pago (cuenta_id, id, alumno_id, cuota_id, monto_total, activo)
  VALUES (cuenta_a, 'plan-esc6-01', 'alu-esc6', 'cuota-esc6-c1', 10000, true)
  ON CONFLICT (cuenta_id, id) DO NOTHING;

  INSERT INTO abonos (cuenta_id, id, alumno_id, cuota_id, plan_id, monto, pagado)
  VALUES (cuenta_a, 'abono-esc6-01', 'alu-esc6', 'cuota-esc6-c1',
          'plan-esc6-01', 5000, true)
  ON CONFLICT (cuenta_id, id) DO NOTHING;

  SELECT * INTO r_esc6
  FROM apoderado_cc_resumen_pagos('CC-ESC6-TEST')
  WHERE alumno_id = 'alu-esc6';

  ASSERT r_esc6 IS NOT NULL,
    'CC-ESC-6 FAIL: alu-esc6 no apareció en resumen';

  ASSERT r_esc6.monto_pendiente = 10000,
    format('CC-ESC-6 FAIL: monto_pendiente esperado 10000 (C2 impaga), '
           'obtuvo %s — el abono de C1 (ya cubierta) reduce ilegalmente C2',
           r_esc6.monto_pendiente);

  ASSERT r_esc6.monto_abonado = 0,
    format('CC-ESC-6 FAIL: monto_abonado efectivo esperado 0 (C1 cubierta), '
           'obtuvo %s',
           r_esc6.monto_abonado);

  ASSERT r_esc6.monto_pagado = 10000,
    format('CC-ESC-6 FAIL: monto_pagado esperado 10000, obtuvo %s',
           r_esc6.monto_pagado);

  ASSERT r_esc6.num_cuotas_pagadas = 1,
    format('CC-ESC-6 FAIL: num_cuotas_pagadas esperado 1, obtuvo %s',
           r_esc6.num_cuotas_pagadas);

  ASSERT r_esc6.num_cuotas_pendientes = 1,
    format('CC-ESC-6 FAIL: num_cuotas_pendientes esperado 1, obtuvo %s',
           r_esc6.num_cuotas_pendientes);

  RAISE NOTICE '[OK] CC-ESC-6: abono en C1 cubierta no reduce C2 — '
               'pendiente=10000, abonado=0, pagadas=1, pendientes=1';

  -- Limpieza CC-ESC-6
  DELETE FROM abonos      WHERE cuenta_id = cuenta_a AND id = 'abono-esc6-01';
  DELETE FROM planes_pago WHERE cuenta_id = cuenta_a AND id = 'plan-esc6-01';
  DELETE FROM pagos       WHERE cuenta_id = cuenta_a AND id = 'pago-esc6-01';
  DELETE FROM alumnos     WHERE cuenta_id = cuenta_a AND id = 'alu-esc6';
  DELETE FROM cuotas      WHERE cuenta_id = cuenta_a AND id IN ('cuota-esc6-c1','cuota-esc6-c2');
  DELETE FROM cursos      WHERE cuenta_id = cuenta_a AND id = 'cur-esc6';


  -- ════════════════════════════════════════════════════════════
  -- CC-ESC-7: varios pagos para la misma cuota no-mensual NO
  --           multiplican el monto obligado
  -- ────────────────────────────────────────────────────────────
  -- Escenario:
  --   • cuota-esc7-c1 (no-mensual, $12 000) — alu-esc7
  --   • pago-esc7-01: $10 000 (pago parcial inicial)
  --   • pago-esc7-02: $ 5 000 (corrección/complemento)
  --   Sin pre-agregar pagos: 2 filas en pagos_otros harían fan-out
  --   y duplicarían SUM(oo.monto) → monto_obligado ficticio de $24 000
  --   → monto_pendiente = MAX(0, 24000-15000) = 9000  ← BUG
  -- Comportamiento esperado con fix:
  --   monto_pagado  = 15 000  (suma real de ambos pagos)
  --   monto_pendiente = 0     (pagado ≥ obligado → MAX(0,12000-15000)=0)
  --   num_cuotas_pagadas   = 1
  --   num_cuotas_pendientes = 0
  -- ════════════════════════════════════════════════════════════

  INSERT INTO cursos (cuenta_id, id, nombre, activo, codigo_compartido)
  VALUES (cuenta_a, 'cur-esc7', 'Curso ESC7 temp', true, 'CC-ESC7-TEST')
  ON CONFLICT (cuenta_id, id) DO NOTHING;

  -- Cuota no-mensual (tipo NULL = no-mensual según la app)
  INSERT INTO cuotas (cuenta_id, id, curso_id, nombre, tipo, monto, activa)
  VALUES (cuenta_a, 'cuota-esc7-c1', 'cur-esc7',
          'Cuota Anual ESC7', NULL, 12000, true)
  ON CONFLICT (cuenta_id, id) DO NOTHING;

  INSERT INTO alumnos (cuenta_id, id, curso_id, nombres, apellidos, estado, eximido)
  VALUES (cuenta_a, 'alu-esc7', 'cur-esc7', 'Alumno', 'ESC7', 'activo', false)
  ON CONFLICT (cuenta_id, id) DO NOTHING;

  -- Dos pagos distintos para la misma cuota no-mensual
  INSERT INTO pagos (cuenta_id, id, alumno_id, cuota_id,
                     monto, fecha, medio, estado)
  VALUES
    (cuenta_a, 'pago-esc7-01', 'alu-esc7', 'cuota-esc7-c1',
     10000, '2025-03-05', 'transferencia', 'pagado'),
    (cuenta_a, 'pago-esc7-02', 'alu-esc7', 'cuota-esc7-c1',
     5000,  '2025-03-10', 'transferencia', 'pagado')
  ON CONFLICT (cuenta_id, id) DO NOTHING;

  SELECT * INTO r_esc7
  FROM apoderado_cc_resumen_pagos('CC-ESC7-TEST')
  WHERE alumno_id = 'alu-esc7';

  ASSERT r_esc7 IS NOT NULL,
    'CC-ESC-7 FAIL: alu-esc7 no apareció en resumen';

  ASSERT r_esc7.monto_pendiente = 0,
    format('CC-ESC-7 FAIL: monto_pendiente esperado 0, obtuvo %s — '
           'posible fan-out que multiplica el monto obligado ($12000→$24000)',
           r_esc7.monto_pendiente);

  ASSERT r_esc7.monto_pagado = 15000,
    format('CC-ESC-7 FAIL: monto_pagado esperado 15000 (suma de los 2 pagos), '
           'obtuvo %s',
           r_esc7.monto_pagado);

  ASSERT r_esc7.num_cuotas_pagadas = 1,
    format('CC-ESC-7 FAIL: num_cuotas_pagadas esperado 1, obtuvo %s',
           r_esc7.num_cuotas_pagadas);

  ASSERT r_esc7.num_cuotas_pendientes = 0,
    format('CC-ESC-7 FAIL: num_cuotas_pendientes esperado 0, obtuvo %s',
           r_esc7.num_cuotas_pendientes);

  RAISE NOTICE '[OK] CC-ESC-7: 2 pagos en cuota no-mensual no multiplican obligado — '
               'pagado=15000, pendiente=0, pagadas=1, pendientes=0';

  -- Limpieza CC-ESC-7
  DELETE FROM pagos   WHERE cuenta_id = cuenta_a AND id IN ('pago-esc7-01','pago-esc7-02');
  DELETE FROM alumnos WHERE cuenta_id = cuenta_a AND id = 'alu-esc7';
  DELETE FROM cuotas  WHERE cuenta_id = cuenta_a AND id = 'cuota-esc7-c1';
  DELETE FROM cursos  WHERE cuenta_id = cuenta_a AND id = 'cur-esc7';

  -- ════════════════════════════════════════════════════════════════
  -- CC-ESC-8: Sobrepago mensual NO reduce el pendiente de otro período
  --
  -- Escenario: 1 cuota mensual, 2 períodos (Marzo y Abril, $10.000 c/u).
  --   • Pago Marzo = $15.000 (sobrepago de $5.000)
  --   • Pago Abril = $0
  -- Resultado esperado:
  --   pendiente = $10.000  (solo Abril; el exceso de Marzo no cubre Abril)
  --   pagadas   = 1        (solo Marzo está cubierto)
  --   pendientes= 1        (Abril sigue sin pagar)
  -- ════════════════════════════════════════════════════════════════
  RAISE NOTICE '-- CC-ESC-8: Sobrepago mensual no cubre otro período --';

  INSERT INTO cursos  (cuenta_id, id, nombre, activo, codigo_compartido)
  VALUES (cuenta_a, 'cur-esc8', 'Curso ESC8 temp', true, 'CC-ESC8-TEST');

  INSERT INTO alumnos (cuenta_id, id, nombres, apellidos, curso_id)
  VALUES (cuenta_a, 'alu-esc8', 'Alumno', 'ESC8', 'cur-esc8');

  -- Cuota mensual Marzo–Abril $10.000/período
  INSERT INTO cuotas (cuenta_id, id, nombre, tipo, monto, anio, mes_inicio, mes_termino, curso_id)
  VALUES (cuenta_a, 'cuota-esc8-c1', 'Mensualidad ESC8', 'mensual', 10000, 2025, 2, 3, 'cur-esc8');

  -- Obligaciones mensuales: Marzo y Abril
  INSERT INTO obligaciones (cuenta_id, id, alumno_id, cuota_id, periodo, monto)
  VALUES
    (cuenta_a, 'ob-esc8-mar', 'alu-esc8', 'cuota-esc8-c1', 'Marzo 2025',  10000),
    (cuenta_a, 'ob-esc8-abr', 'alu-esc8', 'cuota-esc8-c1', 'Abril 2025',  10000);

  -- Solo se pagó Marzo, con sobrepago de $5.000
  INSERT INTO pagos (cuenta_id, id, alumno_id, cuota_id, periodo, monto, fecha, medio, estado)
  VALUES (cuenta_a, 'pago-esc8-mar', 'alu-esc8', 'cuota-esc8-c1', 'Marzo 2025', 15000,
          CURRENT_DATE, 'Transferencia', 'pagado');

  DECLARE esc8 RECORD;
  SELECT * INTO esc8
  FROM apoderado_cc_resumen_pagos('CC-ESC8-TEST')
  WHERE alumno_id = 'alu-esc8';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CC-ESC-8 FAIL: alu-esc8 no apareció en resumen';
  END IF;
  IF esc8.monto_pendiente <> 10000 THEN
    RAISE EXCEPTION 'CC-ESC-8 FAIL: pendiente esperado 10000 (solo Abril), obtuvo % — '
      'el sobrepago de Marzo NO debe reducir Abril', esc8.monto_pendiente;
  END IF;
  IF esc8.num_cuotas_pagadas <> 1 THEN
    RAISE EXCEPTION 'CC-ESC-8 FAIL: num_cuotas_pagadas esperado 1 (Marzo), obtuvo %',
      esc8.num_cuotas_pagadas;
  END IF;
  IF esc8.num_cuotas_pendientes <> 1 THEN
    RAISE EXCEPTION 'CC-ESC-8 FAIL: num_cuotas_pendientes esperado 1 (Abril), obtuvo %',
      esc8.num_cuotas_pendientes;
  END IF;
  RAISE NOTICE '[OK] CC-ESC-8: sobrepago mensual no reduce otro período — '
               'pagado=15000, pendiente=10000, pagadas=1, pendientes=1';

  -- Limpieza CC-ESC-8
  DELETE FROM pagos        WHERE cuenta_id = cuenta_a AND id = 'pago-esc8-mar';
  DELETE FROM obligaciones WHERE cuenta_id = cuenta_a AND id IN ('ob-esc8-mar','ob-esc8-abr');
  DELETE FROM alumnos      WHERE cuenta_id = cuenta_a AND id = 'alu-esc8';
  DELETE FROM cuotas       WHERE cuenta_id = cuenta_a AND id = 'cuota-esc8-c1';
  DELETE FROM cursos       WHERE cuenta_id = cuenta_a AND id = 'cur-esc8';

  -- ════════════════════════════════════════════════════════════════
  -- CC-ESC-9: Pago parcial en cuota no-mensual NO cuenta como "pagada"
  --
  -- Escenario: 1 cuota no-mensual $12.000. Pago registrado = $5.000.
  -- Resultado esperado:
  --   pendiente = $7.000  (12000 - 5000)
  --   pagadas   = 0       (parcial ≠ cubierta)
  --   pendientes= 1
  -- ════════════════════════════════════════════════════════════════
  RAISE NOTICE '-- CC-ESC-9: Pago parcial cuota no-mensual no cuenta como pagada --';

  INSERT INTO cursos  (cuenta_id, id, nombre, activo, codigo_compartido)
  VALUES (cuenta_a, 'cur-esc9', 'Curso ESC9 temp', true, 'CC-ESC9-TEST');

  INSERT INTO alumnos (cuenta_id, id, nombres, apellidos, curso_id)
  VALUES (cuenta_a, 'alu-esc9', 'Alumno', 'ESC9', 'cur-esc9');

  -- Cuota no-mensual (anual) $12.000
  INSERT INTO cuotas (cuenta_id, id, nombre, tipo, monto, anio, curso_id)
  VALUES (cuenta_a, 'cuota-esc9-c1', 'Matrícula ESC9', 'anual', 12000, 2025, 'cur-esc9');

  -- Obligación no-mensual
  INSERT INTO obligaciones (cuenta_id, id, alumno_id, cuota_id, monto)
  VALUES (cuenta_a, 'ob-esc9-01', 'alu-esc9', 'cuota-esc9-c1', 12000);

  -- Pago parcial: solo $5.000 de $12.000
  INSERT INTO pagos (cuenta_id, id, alumno_id, cuota_id, monto, fecha, medio, estado)
  VALUES (cuenta_a, 'pago-esc9-01', 'alu-esc9', 'cuota-esc9-c1', 5000,
          CURRENT_DATE, 'Efectivo', 'pagado');

  DECLARE esc9 RECORD;
  SELECT * INTO esc9
  FROM apoderado_cc_resumen_pagos('CC-ESC9-TEST')
  WHERE alumno_id = 'alu-esc9';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CC-ESC-9 FAIL: alu-esc9 no apareció en resumen';
  END IF;
  IF esc9.monto_pendiente <> 7000 THEN
    RAISE EXCEPTION 'CC-ESC-9 FAIL: pendiente esperado 7000 (12000-5000), obtuvo %',
      esc9.monto_pendiente;
  END IF;
  IF esc9.num_cuotas_pagadas <> 0 THEN
    RAISE EXCEPTION 'CC-ESC-9 FAIL: num_cuotas_pagadas esperado 0 (pago parcial ≠ pagada), obtuvo %',
      esc9.num_cuotas_pagadas;
  END IF;
  IF esc9.num_cuotas_pendientes <> 1 THEN
    RAISE EXCEPTION 'CC-ESC-9 FAIL: num_cuotas_pendientes esperado 1, obtuvo %',
      esc9.num_cuotas_pendientes;
  END IF;
  RAISE NOTICE '[OK] CC-ESC-9: pago parcial no-mensual no cuenta como pagada — '
               'pagado=5000, pendiente=7000, pagadas=0, pendientes=1';

  -- Limpieza CC-ESC-9
  DELETE FROM pagos        WHERE cuenta_id = cuenta_a AND id = 'pago-esc9-01';
  DELETE FROM obligaciones WHERE cuenta_id = cuenta_a AND id = 'ob-esc9-01';
  DELETE FROM alumnos      WHERE cuenta_id = cuenta_a AND id = 'alu-esc9';
  DELETE FROM cuotas       WHERE cuenta_id = cuenta_a AND id = 'cuota-esc9-c1';
  DELETE FROM cursos       WHERE cuenta_id = cuenta_a AND id = 'cur-esc9';

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
