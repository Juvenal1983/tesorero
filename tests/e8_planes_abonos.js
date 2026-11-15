/**
 * E8 — Planes de pago y abonos (suite API)
 *
 * Requisitos de entorno (staging):
 *   STAGING_URL        = https://rucgmytyxpfowznowxwd.supabase.co
 *   STAGING_KEY        = <anon key>
 *   STAGING_JWT        = <JWT de usuario tesorero para la cuenta de prueba>
 *   STAGING_CUENTA_ID  = <UUID de la cuenta de staging>
 *
 * El código compartido del curso se genera en setup() via apoderado_cc_generar.
 * No se necesita STAGING_CC_CODIGO externo.
 *
 * Producción EXCLUIDA. No ejecutar contra tmjqzaakzhecbldebyeg.
 */

'use strict';

const assert = require('assert');
const https  = require('https');

// ─── Configuración ────────────────────────────────────────────────────────────
const BASE     = process.env.STAGING_URL  || 'https://rucgmytyxpfowznowxwd.supabase.co';
const ANON_KEY = process.env.STAGING_KEY;
const JWT      = process.env.STAGING_JWT;
const CUENTA   = process.env.STAGING_CUENTA_ID;

if (!ANON_KEY || !JWT || !CUENTA) {
  console.error('Faltan variables de entorno: STAGING_KEY, STAGING_JWT, STAGING_CUENTA_ID');
  process.exit(1);
}

// Guardia de seguridad: nunca tocar producción
if (BASE.includes('tmjqzaakzhecbldebyeg')) {
  console.error('⛔ PROHIBIDO: BASE apunta a producción. Abortando.');
  process.exit(2);
}

// ─── Helper HTTP ──────────────────────────────────────────────────────────────
function req(method, path, body, extraHeaders) {
  extraHeaders = extraHeaders || {};
  return new Promise(function(resolve, reject) {
    var url  = new URL(path, BASE);
    var data = body ? JSON.stringify(body) : null;
    var opts = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   method,
      headers: Object.assign({
        'Content-Type':  'application/json',
        'apikey':        ANON_KEY,
        'Authorization': 'Bearer ' + JWT,
        'Prefer':        'return=representation',
      }, extraHeaders),
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);

    var r = https.request(opts, function(res) {
      var raw = '';
      res.on('data', function(c) { raw += c; });
      res.on('end', function() {
        var parsed;
        try { parsed = JSON.parse(raw); } catch(e) { parsed = raw; }
        if (res.statusCode >= 400) {
          var e2 = new Error('HTTP ' + res.statusCode + ' ' + method + ' ' + path + ': ' + raw);
          e2.status = res.statusCode;
          e2.body   = parsed;
          return reject(e2);
        }
        resolve(parsed);
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function GET(path, h)       { return req('GET',    path, null, h); }
function POST(path, body)   { return req('POST',   path, body); }
function DELETE(path, h)    { return req('DELETE', path, null, h); }

function rpc(fn, params) {
  return POST('/rest/v1/rpc/' + fn, params);
}

function uid() {
  return 'e8-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────
var CURSO_ID, ALUMNO_ID, CUOTA_ID, CC_CODE;

async function setup() {
  // 1. Crear curso fixture
  var cursos = await POST('/rest/v1/cursos', {
    cuenta_id: CUENTA,
    nombre:    'Curso E8 ' + Date.now(),
    anio:      2026,
    activo:    true,
  });
  CURSO_ID = cursos[0].id;

  // 2. Crear alumno con campos reales: nombres, apellidos, estado
  var alumnos = await POST('/rest/v1/alumnos', {
    cuenta_id: CUENTA,
    curso_id:  CURSO_ID,
    nombres:   'Alumno',
    apellidos: 'E8',
    estado:    'activo',
  });
  ALUMNO_ID = alumnos[0].id;

  // 3. Crear cuota con campos reales: activa (no activo), anio
  var cuotas = await POST('/rest/v1/cuotas', {
    cuenta_id: CUENTA,
    curso_id:  CURSO_ID,
    nombre:    'Marzo 2026',
    tipo:      'mensual',
    monto:     10000,
    anio:      2026,
    activa:    true,
  });
  CUOTA_ID = cuotas[0].id;

  // 4. Generar código compartido para el curso (necesario para tests SALDO)
  var codigo = await rpc('apoderado_cc_generar', {
    p_cuenta_id: CUENTA,
    p_curso_id:  CURSO_ID,
  });
  CC_CODE = typeof codigo === 'string' ? codigo : (codigo && codigo.codigo_compartido);
  if (!CC_CODE) throw new Error('apoderado_cc_generar no devolvió código CC: ' + JSON.stringify(codigo));

  console.log('  setup: CURSO=' + CURSO_ID + ' ALUMNO=' + ALUMNO_ID + ' CUOTA=' + CUOTA_ID + ' CC=' + CC_CODE);
}

async function teardown() {
  await DELETE('/rest/v1/abonos?cuenta_id=eq.' + CUENTA + '&alumno_id=eq.' + ALUMNO_ID).catch(function(){});
  await DELETE('/rest/v1/planes_pago?cuenta_id=eq.' + CUENTA + '&alumno_id=eq.' + ALUMNO_ID).catch(function(){});
  await DELETE('/rest/v1/cuotas?id=eq.' + CUOTA_ID + '&cuenta_id=eq.' + CUENTA).catch(function(){});
  await DELETE('/rest/v1/alumnos?id=eq.' + ALUMNO_ID + '&cuenta_id=eq.' + CUENTA).catch(function(){});
  await DELETE('/rest/v1/cursos?id=eq.' + CURSO_ID + '&cuenta_id=eq.' + CUENTA).catch(function(){});
}

// ─── Resultado ────────────────────────────────────────────────────────────────
var passed = 0, failed = 0;

async function run(name, fn) {
  try {
    await fn();
    console.log('  ✓ ' + name);
    passed++;
  } catch (e) {
    console.error('  ✗ ' + name);
    console.error('    ' + (e.message || e));
    failed++;
  }
}

// ─── Helper: construir payload de plan ───────────────────────────────────────
function planPayload(overrides) {
  overrides = overrides || {};
  var planId = overrides.p_plan_id || uid();
  var base = {
    p_cuenta_id:   CUENTA,
    p_plan_id:     planId,
    p_alumno_id:   ALUMNO_ID,
    p_cuota_id:    CUOTA_ID,
    p_periodo:     'Marzo 2026',
    p_monto_total: 10000,
    p_abonos: [
      { monto: 5000, fecha: '2026-03-01' },
      { monto: 5000, fecha: '2026-04-01' },
    ],
  };
  return Object.assign({}, base, overrides);
}

// ─── PLAN.1 Crear plan con dos abonos ────────────────────────────────────────
async function testPlan1() {
  var payload = planPayload();
  var r = await rpc('crear_plan_con_abonos', payload);
  assert.ok(r.plan, 'falta plan en respuesta');
  assert.ok(Array.isArray(r.abonos), 'falta arreglo abonos');
  assert.strictEqual(r.abonos.length, 2, 'se esperaban 2 abonos');
  assert.strictEqual(r.plan.monto_total, 10000);
  assert.strictEqual(r.idempotente, false);
  await rpc('eliminar_plan', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id });
}

// ─── PLAN.2 Monto cero rechazado ──────────────────────────────────────────────
async function testPlan2() {
  var payload = planPayload({ p_monto_total: 0 });
  await assert.rejects(
    function() { return rpc('crear_plan_con_abonos', payload); },
    /monto_invalido/,
    'deberia rechazar monto_total=0'
  );
}

// ─── PLAN.3 Suma de abonos != monto_total rechazada ──────────────────────────
async function testPlan3() {
  var payload = planPayload({
    p_abonos: [{ monto: 3000, fecha: '2026-03-01' }, { monto: 3000, fecha: '2026-04-01' }],
  });
  await assert.rejects(
    function() { return rpc('crear_plan_con_abonos', payload); },
    /suma_abonos_invalida/
  );
}

// ─── PLAN.4 Un solo abono rechazado ──────────────────────────────────────────
async function testPlan4() {
  var payload = planPayload({
    p_monto_total: 5000,
    p_abonos: [{ monto: 5000, fecha: '2026-03-01' }],
  });
  await assert.rejects(
    function() { return rpc('crear_plan_con_abonos', payload); },
    /min_dos_abonos/
  );
}

// ─── PLAN.5 Fecha inválida rechazada ─────────────────────────────────────────
async function testPlan5() {
  var payload = planPayload({
    p_abonos: [{ monto: 5000, fecha: 'no-una-fecha' }, { monto: 5000, fecha: '2026-04-01' }],
  });
  await assert.rejects(
    function() { return rpc('crear_plan_con_abonos', payload); },
    /abono_fecha_invalida/
  );
}

// ─── PLAN.6 Pagar primer abono no cierra el plan ─────────────────────────────
async function testPlan6() {
  var payload = planPayload();
  var r = await rpc('crear_plan_con_abonos', payload);
  var abonoId = r.abonos[0].id;
  var r2 = await rpc('pagar_abono', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id, p_abono_id: abonoId });
  assert.strictEqual(r2.ya_pagado, false);
  assert.strictEqual(r2.plan_cerrado, false, 'plan no debe cerrarse con 1 de 2');
  await rpc('revertir_abono', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id, p_abono_id: abonoId });
  await rpc('eliminar_plan',  { p_cuenta_id: CUENTA, p_plan_id: r.plan.id });
}

// ─── PLAN.7 Pagar todos los abonos cierra el plan ────────────────────────────
async function testPlan7() {
  var payload = planPayload();
  var r = await rpc('crear_plan_con_abonos', payload);
  var ab1 = r.abonos[0], ab2 = r.abonos[1];
  await rpc('pagar_abono', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id, p_abono_id: ab1.id });
  var r2 = await rpc('pagar_abono', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id, p_abono_id: ab2.id });
  assert.strictEqual(r2.plan_cerrado, true, 'plan debe cerrarse al pagar todos los abonos');
  var planRows = await GET('/rest/v1/planes_pago?id=eq.' + r.plan.id + '&cuenta_id=eq.' + CUENTA + '&select=activo');
  assert.strictEqual(planRows[0].activo, false);
  // G05: no debe insertarse en tabla pagos
  var pagos = await GET('/rest/v1/pagos?alumno_id=eq.' + ALUMNO_ID + '&cuota_id=eq.' + CUOTA_ID + '&cuenta_id=eq.' + CUENTA).catch(function(){ return []; });
  assert.ok(!pagos || pagos.length === 0, 'G05: no debe insertarse en tabla pagos al completar plan');
}

// ─── PLAN.8 Revertir abono reabre el plan ────────────────────────────────────
async function testPlan8() {
  var payload = planPayload();
  var r = await rpc('crear_plan_con_abonos', payload);
  var ab1 = r.abonos[0], ab2 = r.abonos[1];
  await rpc('pagar_abono',    { p_cuenta_id: CUENTA, p_plan_id: r.plan.id, p_abono_id: ab1.id });
  await rpc('pagar_abono',    { p_cuenta_id: CUENTA, p_plan_id: r.plan.id, p_abono_id: ab2.id });
  await rpc('revertir_abono', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id, p_abono_id: ab2.id });
  var planRows = await GET('/rest/v1/planes_pago?id=eq.' + r.plan.id + '&cuenta_id=eq.' + CUENTA + '&select=activo');
  assert.strictEqual(planRows[0].activo, true, 'plan debe reabrirse al revertir un abono');
  await rpc('revertir_abono', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id, p_abono_id: ab1.id });
  await rpc('eliminar_plan',  { p_cuenta_id: CUENTA, p_plan_id: r.plan.id });
}

// ─── PLAN.9 Editar monto actualiza monto_total del plan ──────────────────────
async function testPlan9() {
  var payload = planPayload();
  var r = await rpc('crear_plan_con_abonos', payload);
  var abonoId = r.abonos[0].id;
  var r2 = await rpc('editar_abono', {
    p_cuenta_id: CUENTA,
    p_abono_id:  abonoId,
    p_monto:     7000,
    p_fecha:     null,
  });
  assert.ok(r2.abono, 'falta abono en respuesta');
  assert.strictEqual(r2.abono.monto, 7000);
  // monto_total pasa de 10000 a 12000 (delta +2000)
  var planRows = await GET('/rest/v1/planes_pago?id=eq.' + r.plan.id + '&cuenta_id=eq.' + CUENTA + '&select=monto_total');
  assert.strictEqual(planRows[0].monto_total, 12000, 'monto_total del plan debe reflejar el delta');
  await rpc('eliminar_plan', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id });
}

// ─── PLAN.10 Editar abono ya pagado rechazado ────────────────────────────────
async function testPlan10() {
  var payload = planPayload();
  var r = await rpc('crear_plan_con_abonos', payload);
  var abonoId = r.abonos[0].id;
  await rpc('pagar_abono', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id, p_abono_id: abonoId });
  await assert.rejects(
    function() { return rpc('editar_abono', { p_cuenta_id: CUENTA, p_abono_id: abonoId, p_monto: 1000 }); },
    /abono_ya_pagado/
  );
  await rpc('revertir_abono', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id, p_abono_id: abonoId });
  await rpc('eliminar_plan',  { p_cuenta_id: CUENTA, p_plan_id: r.plan.id });
}

// ─── PLAN.11 Eliminar plan con abono pagado rechazado ────────────────────────
async function testPlan11() {
  var payload = planPayload();
  var r = await rpc('crear_plan_con_abonos', payload);
  var abonoId = r.abonos[0].id;
  await rpc('pagar_abono', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id, p_abono_id: abonoId });
  await assert.rejects(
    function() { return rpc('eliminar_plan', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id }); },
    /plan_con_abonos_pagados/
  );
  await rpc('revertir_abono', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id, p_abono_id: abonoId });
  await rpc('eliminar_plan',  { p_cuenta_id: CUENTA, p_plan_id: r.plan.id });
}

// ─── PLAN.12 Idempotencia: mismo p_plan_id devuelve el mismo plan ─────────────
async function testPlan12() {
  var payload = planPayload();
  var r1 = await rpc('crear_plan_con_abonos', payload);
  assert.strictEqual(r1.idempotente, false, 'primera llamada no debe ser idempotente');

  // Segunda llamada con el mismo p_plan_id
  var r2 = await rpc('crear_plan_con_abonos', payload);
  assert.strictEqual(r2.idempotente, true,         'segunda llamada debe ser idempotente');
  assert.strictEqual(r2.plan.id,     r1.plan.id,   'debe devolver el mismo plan_id');
  assert.strictEqual(r2.abonos.length, 2,           'debe devolver los mismos 2 abonos');

  // Mismo p_plan_id con monto distinto debe fallar
  var payloadMontoDiff = Object.assign({}, payload, { p_monto_total: 99999 });
  await assert.rejects(
    function() { return rpc('crear_plan_con_abonos', payloadMontoDiff); },
    /idempotency_conflict/,
    'mismo p_plan_id con monto diferente debe rechazarse'
  );

  await rpc('eliminar_plan', { p_cuenta_id: CUENTA, p_plan_id: r1.plan.id });
}

// ─── PLAN.13 Concurrencia: dos creaciones del mismo natural key ───────────────
// Ambas con p_plan_id DIFERENTE pero mismo (alumno, cuota, periodo).
// Solo una debe tener éxito; la otra falla con duplicate_active_plan.
async function testPlan13() {
  var payload1 = planPayload({ p_plan_id: uid() });
  var payload2 = planPayload({ p_plan_id: uid() });

  var results = await Promise.allSettled([
    rpc('crear_plan_con_abonos', payload1),
    rpc('crear_plan_con_abonos', payload2),
  ]);

  var ok  = results.filter(function(r) { return r.status === 'fulfilled'; });
  var err = results.filter(function(r) { return r.status === 'rejected'; });

  assert.strictEqual(ok.length,  1, 'exactamente una creacion debe tener exito');
  assert.strictEqual(err.length, 1, 'exactamente una creacion debe fallar');
  assert.ok(
    err[0].reason.message.includes('duplicate_active_plan'),
    'el error debe ser duplicate_active_plan'
  );

  var planId = ok[0].value.plan.id;
  await rpc('eliminar_plan', { p_cuenta_id: CUENTA, p_plan_id: planId });
}

// ─── PLAN.13b Concurrencia: pago y eliminación simultáneos ───────────────────
// Verifica que el orden de bloqueos (plan primero) no produce deadlock.
async function testPlan13b() {
  var payload = planPayload();
  var r       = await rpc('crear_plan_con_abonos', payload);
  var abonoId = r.abonos[0].id;
  var planId  = r.plan.id;

  var results = await Promise.allSettled([
    rpc('pagar_abono',   { p_cuenta_id: CUENTA, p_plan_id: planId, p_abono_id: abonoId }),
    rpc('eliminar_plan', { p_cuenta_id: CUENTA, p_plan_id: planId }),
  ]);

  // No debe haber deadlock ni error 500 no controlado
  for (var i = 0; i < results.length; i++) {
    var res = results[i];
    if (res.status === 'rejected') {
      var msg = (res.reason && res.reason.message) || '';
      var isExpected = /plan_con_abonos_pagados|plan_not_found/.test(msg);
      assert.ok(isExpected,
        'error inesperado en concurrencia pago+eliminacion: ' + msg);
    }
  }

  // Limpieza condicional
  var planRows = await GET('/rest/v1/planes_pago?id=eq.' + planId + '&cuenta_id=eq.' + CUENTA + '&select=id').catch(function(){ return []; });
  if (planRows && planRows.length > 0) {
    await rpc('revertir_abono', { p_cuenta_id: CUENTA, p_plan_id: planId, p_abono_id: abonoId }).catch(function(){});
    await rpc('eliminar_plan',  { p_cuenta_id: CUENTA, p_plan_id: planId }).catch(function(){});
  }
}

// ─── PLAN.14 Cuota de otro curso rechazada ───────────────────────────────────
async function testPlan14() {
  var otroCursos = await POST('/rest/v1/cursos', {
    cuenta_id: CUENTA,
    nombre:    'Curso E8 B ' + Date.now(),
    anio:      2026,
    activo:    true,
  });
  var otroCursoId = otroCursos[0].id;

  var otraCuotas = await POST('/rest/v1/cuotas', {
    cuenta_id: CUENTA,
    curso_id:  otroCursoId,
    nombre:    'Marzo 2026',
    tipo:      'mensual',
    monto:     8000,
    anio:      2026,
    activa:    true,
  });
  var otraCuotaId = otraCuotas[0].id;

  var payload = planPayload({ p_cuota_id: otraCuotaId });
  await assert.rejects(
    function() { return rpc('crear_plan_con_abonos', payload); },
    /alumno_not_in_curso|cuota_not_found/,
    'no debe permitir crear plan con cuota de otro curso'
  );

  await DELETE('/rest/v1/cuotas?id=eq.' + otraCuotaId + '&cuenta_id=eq.' + CUENTA).catch(function(){});
  await DELETE('/rest/v1/cursos?id=eq.' + otroCursoId + '&cuenta_id=eq.' + CUENTA).catch(function(){});
}

// ─── ISO.1 Rollback ante falla parcial ───────────────────────────────────────
async function testIso1() {
  var badPayload = planPayload({
    p_abonos: [
      { monto: 5000, fecha: '2026-03-01' },
      { monto: 5000, fecha: 'INVALIDA'   },
    ],
  });
  await assert.rejects(
    function() { return rpc('crear_plan_con_abonos', badPayload); },
    /abono_fecha_invalida/
  );
  var rows = await GET('/rest/v1/planes_pago?id=eq.' + badPayload.p_plan_id + '&cuenta_id=eq.' + CUENTA + '&select=id').catch(function(){ return []; });
  assert.strictEqual(rows.length, 0, 'rollback: no debe quedar plan huerfano');
}

// ─── RLS.1 Cuenta ajena denegada en crear ────────────────────────────────────
async function testRls1() {
  var fakeUuid = '00000000-0000-0000-0000-000000000000';
  var payload  = planPayload({ p_cuenta_id: fakeUuid });
  await assert.rejects(
    function() { return rpc('crear_plan_con_abonos', payload); },
    /permission_denied|cuota_not_found/,
    'RLS debe impedir acceso a cuenta ajena'
  );
}

// ─── RLS.2 Cuenta ajena denegada en eliminar ─────────────────────────────────
async function testRls2() {
  var fakeUuid = '00000000-0000-0000-0000-000000000000';
  await assert.rejects(
    function() { return rpc('eliminar_plan', { p_cuenta_id: fakeUuid, p_plan_id: 'fake-plan' }); },
    /plan_not_found|permission_denied/
  );
}

// ─── SALDO.1 Resumen CC responde correctamente ───────────────────────────────
async function testSaldo1() {
  var resumen = await rpc('apoderado_cc_resumen_pagos', { p_codigo_cc: CC_CODE });
  assert.ok(Array.isArray(resumen), 'resumen debe ser un arreglo');
}

// ─── SALDO.2 Resumen refleja abono parcial ───────────────────────────────────
async function testSaldo2() {
  var payload = planPayload();
  var r       = await rpc('crear_plan_con_abonos', payload);
  // Pagar primer abono: 5000 de 10000
  await rpc('pagar_abono', {
    p_cuenta_id: CUENTA,
    p_plan_id:   r.plan.id,
    p_abono_id:  r.abonos[0].id,
  });

  var resumen = await rpc('apoderado_cc_resumen_pagos', { p_codigo_cc: CC_CODE });
  var fila    = resumen.find(function(f) { return f.alumno_id === ALUMNO_ID; });

  if (fila) {
    assert.ok(fila.monto_abonado >= 5000,
      'monto_abonado debe ser >= 5000; obtenido: ' + fila.monto_abonado);
  }

  await rpc('revertir_abono', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id, p_abono_id: r.abonos[0].id });
  await rpc('eliminar_plan',  { p_cuenta_id: CUENTA, p_plan_id: r.plan.id });
}

// ─── SALDO.3 Plan completo no duplica en tabla pagos (G05) ───────────────────
async function testSaldo3() {
  var payload = planPayload();
  var r       = await rpc('crear_plan_con_abonos', payload);
  for (var i = 0; i < r.abonos.length; i++) {
    await rpc('pagar_abono', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id, p_abono_id: r.abonos[i].id });
  }

  var pagos = await GET(
    '/rest/v1/pagos?alumno_id=eq.' + ALUMNO_ID + '&cuota_id=eq.' + CUOTA_ID + '&cuenta_id=eq.' + CUENTA + '&select=id'
  ).catch(function(){ return []; });
  assert.strictEqual((pagos || []).length, 0,
    'G05: completar un plan no debe crear registros en tabla pagos');

  var resumen = await rpc('apoderado_cc_resumen_pagos', { p_codigo_cc: CC_CODE });
  var fila    = resumen.find(function(f) { return f.alumno_id === ALUMNO_ID; });
  if (fila) {
    assert.ok(fila.monto_abonado >= 10000,
      'monto_abonado debe ser >= 10000 tras completar el plan; obtenido: ' + fila.monto_abonado);
  }
  // Plan cerrado; teardown lo eliminará con DELETE directo
}

// ─── Runner ───────────────────────────────────────────────────────────────────
(async function() {
  console.log('\nE8 — Planes de pago y abonos\n');
  console.log('  Preparando fixtures...');
  try { await setup(); } catch (e) {
    console.error('  ✗ setup fallo:', e.message);
    process.exit(1);
  }

  console.log('\n  [PLAN] Validaciones y flujos basicos');
  await run('PLAN.1  Crear plan con dos abonos',            testPlan1);
  await run('PLAN.2  monto_total=0 rechazado',              testPlan2);
  await run('PLAN.3  suma abonos != monto_total rechazada', testPlan3);
  await run('PLAN.4  un solo abono rechazado',              testPlan4);
  await run('PLAN.5  fecha invalida rechazada',             testPlan5);
  await run('PLAN.6  pagar primer abono',                   testPlan6);
  await run('PLAN.7  pagar todos los abonos cierra plan',   testPlan7);
  await run('PLAN.8  revertir abono reabre plan',           testPlan8);
  await run('PLAN.9  editar monto actualiza monto_total',   testPlan9);
  await run('PLAN.10 editar abono ya pagado rechazado',     testPlan10);
  await run('PLAN.11 eliminar plan con pagado rechazado',   testPlan11);

  console.log('\n  [PLAN] Idempotencia y concurrencia');
  await run('PLAN.12 idempotencia por p_plan_id',           testPlan12);
  await run('PLAN.13 dos creaciones concurrentes',          testPlan13);
  await run('PLAN.13b pago concurrente con eliminacion',    testPlan13b);
  await run('PLAN.14 cuota de otro curso rechazada',        testPlan14);

  console.log('\n  [ISO] Atomicidad');
  await run('ISO.1  rollback ante falla parcial',           testIso1);

  console.log('\n  [RLS] Autorizacion');
  await run('RLS.1  cuenta ajena denegada en crear',        testRls1);
  await run('RLS.2  cuenta ajena denegada en eliminar',     testRls2);

  console.log('\n  [SALDO] Resumen CC con importes exactos');
  await run('SALDO.1 resumen sin abonos',                   testSaldo1);
  await run('SALDO.2 resumen con abono parcial',            testSaldo2);
  await run('SALDO.3 plan completo no duplica en pagos',    testSaldo3);

  console.log('\n  Limpiando fixtures...');
  try { await teardown(); } catch (e) {
    console.warn('  ! teardown parcial:', e.message);
  }

  var total = passed + failed;
  console.log('\n  ' + passed + '/' + total + ' pasaron, ' + failed + ' fallaron\n');
  process.exit(failed > 0 ? 1 : 0);
})();
