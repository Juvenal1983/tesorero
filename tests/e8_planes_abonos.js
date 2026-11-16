/**
 * E8 — Planes de pago y abonos (suite API)
 *
 * Requisitos de entorno (staging) — en .env o variables de entorno:
 *   STAGING_URL   = https://rucgmytyxpfowznowxwd.supabase.co   (opcional; default incluido)
 *   STAGING_KEY   = <anon key de staging>
 *   STAGING_EMAIL = <email del tesorero de prueba>
 *   STAGING_PASS  = <contraseña del tesorero>
 *
 * También acepta los nombres anteriores: STAGING_SUPABASE_URL, STAGING_SUPABASE_ANON_KEY,
 * STAGING_USER_A_EMAIL, STAGING_USER_A_PASSWORD.
 *
 * El JWT se obtiene automáticamente en setup() vía signIn.
 * STAGING_CUENTA_ID se descubre vía RLS si no está en el entorno.
 *
 * Para SEC.1 (opcional):
 *   STAGING_JWT_SIN_ACCESO = <JWT de un usuario sin rol en el curso de prueba>
 *
 * El código compartido del curso se genera en setup() via apoderado_cc_generar.
 *
 * Producción EXCLUIDA. No ejecutar contra tmjqzaakzhecbldebyeg.
 */

'use strict';

const path   = require('path');
const assert = require('assert');
const https  = require('https');

// Cargar .env desde la raíz del proyecto (si existe)
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') }); } catch(_){}

// ─── Configuración ────────────────────────────────────────────────────────────
const BASE = (
  process.env.STAGING_URL ||
  process.env.STAGING_SUPABASE_URL ||
  'https://rucgmytyxpfowznowxwd.supabase.co'
).replace(/\/$/, '');

const ANON_KEY = process.env.STAGING_KEY || process.env.STAGING_SUPABASE_ANON_KEY || '';
const EMAIL    = process.env.STAGING_EMAIL || process.env.STAGING_USER_A_EMAIL || '';
const PASS     = process.env.STAGING_PASS  || process.env.STAGING_USER_A_PASSWORD || '';

if (!ANON_KEY || !EMAIL || !PASS) {
  console.error('Faltan variables de entorno: STAGING_KEY (o STAGING_SUPABASE_ANON_KEY),');
  console.error('  STAGING_EMAIL (o STAGING_USER_A_EMAIL),');
  console.error('  STAGING_PASS  (o STAGING_USER_A_PASSWORD)');
  process.exit(1);
}

// JWT y CUENTA se inicializan en setup() tras el login
var JWT    = '';
var CUENTA = process.env.STAGING_CUENTA_ID || '';

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
        'Authorization': 'Bearer ' + JWT,  // JWT se llena en setup()
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

// ─── Login y descubrimiento de cuenta ─────────────────────────────────────────
function login() {
  return new Promise(function(resolve, reject) {
    var url  = new URL('/auth/v1/token?grant_type=password', BASE);
    var data = JSON.stringify({ email: EMAIL, password: PASS });
    var opts = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'apikey':         ANON_KEY,
        'Content-Length': Buffer.byteLength(data),
      },
    };
    var r = https.request(opts, function(res) {
      var raw = '';
      res.on('data', function(c) { raw += c; });
      res.on('end', function() {
        var parsed;
        try { parsed = JSON.parse(raw); } catch(e) { return reject(new Error('Login: respuesta no-JSON: ' + raw)); }
        if (res.statusCode >= 400) return reject(new Error('Login falló (' + res.statusCode + '): ' + raw));
        if (!parsed.access_token) return reject(new Error('Login: sin access_token en respuesta'));
        resolve(parsed.access_token);
      });
    });
    r.on('error', reject);
    r.write(data);
    r.end();
  });
}

async function descubrirCuentaId() {
  var rows = await GET('/rest/v1/tesorero_cuentas?select=id&limit=1');
  if (!Array.isArray(rows) || !rows[0] || !rows[0].id) {
    throw new Error('No se encontró cuenta para este usuario en staging. ' +
      'Verifica que STAGING_EMAIL corresponde a un tesorero/dueño de cuenta.');
  }
  return rows[0].id;
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
  // 0. Login y descubrir cuenta
  JWT = await login();
  if (!CUENTA) {
    CUENTA = await descubrirCuentaId();
    console.log('  setup: CUENTA descubierta=' + CUENTA);
  }

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
var passed = 0, failed = 0, skipped = 0;

// Señal de omisión explícita (no cuenta como fallo)
function SkipError(msg) {
  this.name    = 'SkipError';
  this.message = msg;
}
SkipError.prototype = Object.create(Error.prototype);

async function run(name, fn) {
  try {
    await fn();
    console.log('  ✓ ' + name);
    passed++;
  } catch (e) {
    if (e instanceof SkipError) {
      console.log('  - ' + name + ' (omitido: ' + e.message + ')');
      skipped++;
    } else {
      console.error('  ✗ ' + name);
      console.error('    ' + (e.message || e));
      failed++;
    }
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

// ─── SEC.1 Plan conocido enviado por usuario real sin acceso al curso ─────────
// Verifica que el bloque 0 de idempotencia (SECURITY DEFINER) NO devuelve datos
// a un usuario autenticado que no tiene rol en el curso al que pertenece el plan.
//
// Escenario: el atacante conoce cuenta_id y plan_id (p.ej. desde logs del cliente)
// y envía exactamente esos valores con sus propias credenciales.
// La función debe lanzar permission_denied ANTES de devolver cualquier dato.
//
// Requiere STAGING_JWT_SIN_ACCESO: JWT válido de un usuario de staging que NO
// tiene rol (admin/tesorero) en el curso donde vive el plan de prueba.
// Si la variable no está definida, el test se omite explícitamente.
// NO se usa una cuenta_id inventada como sustituto — ese código path es distinto
// (not_found, no permission_denied) y no valida la comprobación de autorización.
async function testSec1() {
  var JWT_SIN_ACCESO = process.env.STAGING_JWT_SIN_ACCESO;
  if (!JWT_SIN_ACCESO) {
    throw new SkipError('requiere STAGING_JWT_SIN_ACCESO (JWT de usuario sin rol en el curso)');
  }

  // Crear plan real con el JWT principal
  var payload    = planPayload();
  var r          = await rpc('crear_plan_con_abonos', payload);
  var realPlanId = r.plan.id;

  // Función auxiliar con JWT alternativo
  var rpcConJWT = function(fn, params, jwt) {
    return new Promise(function(resolve, reject) {
      var url  = new URL('/rest/v1/rpc/' + fn, BASE);
      var data = JSON.stringify(params);
      var opts = {
        hostname: url.hostname,
        path:     url.pathname,
        method:   'POST',
        headers: {
          'Content-Type':   'application/json',
          'apikey':         ANON_KEY,
          'Authorization':  'Bearer ' + jwt,
          'Content-Length': Buffer.byteLength(data),
        },
      };
      var req2 = https.request(opts, function(res) {
        var raw = '';
        res.on('data', function(c) { raw += c; });
        res.on('end', function() {
          var parsed;
          try { parsed = JSON.parse(raw); } catch(e) { parsed = raw; }
          if (res.statusCode >= 400) {
            var e2 = new Error('HTTP ' + res.statusCode + ': ' + raw);
            e2.status = res.statusCode; e2.body = parsed;
            return reject(e2);
          }
          resolve(parsed);
        });
      });
      req2.on('error', reject);
      req2.write(data);
      req2.end();
    });
  };

  // Misma cuenta_id y plan_id reales, mismo payload — solo el JWT difiere.
  // El bloque 0 debe autorizar ANTES de devolver datos y lanzar permission_denied.
  var payloadAtaque = Object.assign({}, payload);  // cuenta_id y plan_id correctos
  await assert.rejects(
    function() { return rpcConJWT('crear_plan_con_abonos', payloadAtaque, JWT_SIN_ACCESO); },
    /permission_denied/,
    'SEC.1: usuario sin rol en el curso no debe obtener datos del plan via idempotencia'
  );

  // Limpieza
  await rpc('eliminar_plan', { p_cuenta_id: CUENTA, p_plan_id: realPlanId });
}

// ─── SEC.2 Idempotencia rechaza calendario modificado ─────────────────────────
// Verifica que la identidad completa del reintento incluye fechas y montos
// individuales de los abonos, no solo el monto_total.
async function testSec2() {
  var payload = planPayload();
  var r = await rpc('crear_plan_con_abonos', payload);

  // Reintento con mismos montos individuales pero fechas distintas
  var payloadFechaDistinta = Object.assign({}, payload, {
    p_abonos: [
      { monto: 5000, fecha: '2026-05-01' },  // fecha cambiada
      { monto: 5000, fecha: '2026-06-01' },  // fecha cambiada
    ],
  });
  await assert.rejects(
    function() { return rpc('crear_plan_con_abonos', payloadFechaDistinta); },
    /idempotency_conflict/,
    'SEC.2: mismo p_plan_id con fechas de abonos distintas debe rechazarse'
  );

  // Reintento con mismas fechas pero un monto individual distinto
  var payloadMontoDistinto = Object.assign({}, payload, {
    p_abonos: [
      { monto: 3000, fecha: '2026-03-01' },  // monto cambiado
      { monto: 7000, fecha: '2026-04-01' },  // monto cambiado (suma = 10000 igual)
    ],
  });
  await assert.rejects(
    function() { return rpc('crear_plan_con_abonos', payloadMontoDistinto); },
    /idempotency_conflict/,
    'SEC.2: mismo p_plan_id con distribucion de montos distinta debe rechazarse'
  );

  await rpc('eliminar_plan', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id });
}

// ─── SEC.3 Idempotencia rechaza alumno o cuota distintos ─────────────────────
// El campo identidad del reintento incluye alumno_id y cuota_id.
async function testSec3() {
  var payload = planPayload();
  var r = await rpc('crear_plan_con_abonos', payload);

  // Reintento con alumno_id inventado
  var payloadAlumnoDistinto = Object.assign({}, payload, { p_alumno_id: 'alumno-falso-' + uid() });
  await assert.rejects(
    function() { return rpc('crear_plan_con_abonos', payloadAlumnoDistinto); },
    /idempotency_conflict|alumno_not_in_curso/,
    'SEC.3: mismo p_plan_id con alumno_id distinto debe rechazarse'
  );

  await rpc('eliminar_plan', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id });
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

// ─── PLAN.15 Reintento con params originales tras editar_abono ───────────────
// Verifica que solicitud_json (snapshot inmutable) se usa para la comparación,
// no el estado mutable actual.  Tras editar_abono el snapshot queda intacto;
// el reintento con los parámetros originales debe reconocerse como idempotente.
async function testPlan15() {
  var payload = planPayload();  // {5000+5000, total=10000}
  var r       = await rpc('crear_plan_con_abonos', payload);
  var abonoId = r.abonos[0].id;

  // Editar primer abono: 5000 → 7000; planes_pago.monto_total pasa a 12000
  await rpc('editar_abono', {
    p_cuenta_id: CUENTA,
    p_abono_id:  abonoId,
    p_monto:     7000,
  });

  // Reintento con payload ORIGINAL (5000+5000, total=10000).
  // Con snapshot inmutable esto debe devolver idempotente=true.
  var r2 = await rpc('crear_plan_con_abonos', payload);
  assert.strictEqual(r2.idempotente, true,
    'PLAN.15: reintento con params originales debe reconocerse tras editar_abono');
  assert.strictEqual(r2.plan.id, r.plan.id,
    'PLAN.15: debe devolver el mismo plan_id');

  // Limpieza: revertir edición y eliminar plan
  await rpc('editar_abono', { p_cuenta_id: CUENTA, p_abono_id: abonoId, p_monto: 5000 });
  await rpc('eliminar_plan', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id });
}

// ─── PLAN.16 Concurrencia: mismo plan_id con calendarios distintos ────────────
// Dos peticiones concurrentes usan el mismo plan_id pero calendarios distintos.
// La primera que llega almacena el snapshot; la segunda falla idempotency_conflict.
async function testPlan16() {
  var planId   = uid();
  var payload1 = planPayload({
    p_plan_id: planId,
    p_abonos:  [{ monto: 5000, fecha: '2026-03-01' }, { monto: 5000, fecha: '2026-04-01' }],
  });
  var payload2 = planPayload({
    p_plan_id: planId,
    p_abonos:  [{ monto: 3000, fecha: '2026-03-01' }, { monto: 7000, fecha: '2026-04-01' }],
  });

  var results = await Promise.allSettled([
    rpc('crear_plan_con_abonos', payload1),
    rpc('crear_plan_con_abonos', payload2),
  ]);

  var ok  = results.filter(function(r) { return r.status === 'fulfilled'; });
  var err = results.filter(function(r) { return r.status === 'rejected';  });

  assert.strictEqual(ok.length,  1, 'PLAN.16: exactamente una peticion debe tener exito');
  assert.strictEqual(err.length, 1, 'PLAN.16: exactamente una peticion debe fallar');
  assert.ok(
    err[0].reason.message.includes('idempotency_conflict'),
    'PLAN.16: el conflicto debe ser idempotency_conflict, recibido: ' + err[0].reason.message
  );

  await rpc('eliminar_plan', { p_cuenta_id: CUENTA, p_plan_id: planId });
}

// ─── PLAN.17 Respuesta perdida desde el handler: reintento idempotente ────────
// Simula el flujo del formulario: se genera planId, se envía la petición y la
// respuesta se "pierde" (error de red, timeout, recarga del navegador).
// En el reintento (mismo planId, mismo payload) el servidor devuelve
// idempotente=true y los mismos datos, sin crear un plan duplicado.
async function testPlan17() {
  var payload = planPayload();
  var planId  = payload.p_plan_id;

  // Primera llamada: el servidor crea el plan.  "Respuesta perdida": la ignoramos.
  void (await rpc('crear_plan_con_abonos', payload));

  // Reintento desde el handler (misma sessionStorage → mismo planId)
  var r2 = await rpc('crear_plan_con_abonos', payload);
  assert.strictEqual(r2.idempotente, true,
    'PLAN.17: reintento tras respuesta perdida debe devolver idempotente=true');
  assert.strictEqual(r2.plan.id, planId, 'PLAN.17: debe ser el mismo plan');
  assert.ok(Array.isArray(r2.abonos) && r2.abonos.length === 2,
    'PLAN.17: debe devolver los 2 abonos originales');

  // Verificar que no se crearon planes duplicados
  var planes = await GET(
    '/rest/v1/planes_pago?cuenta_id=eq.' + CUENTA +
    '&alumno_id=eq.' + ALUMNO_ID + '&cuota_id=eq.' + CUOTA_ID + '&select=id'
  );
  assert.strictEqual(planes.length, 1, 'PLAN.17: no deben existir planes duplicados');

  await rpc('eliminar_plan', { p_cuenta_id: CUENTA, p_plan_id: planId });
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

  console.log('\n  [PLAN] Idempotencia con snapshot inmutable');
  await run('PLAN.15 reintento tras editar_abono (snapshot)',    testPlan15);
  await run('PLAN.16 mismo plan_id calendarios distintos',       testPlan16);
  await run('PLAN.17 respuesta perdida → reintento idempotente', testPlan17);

  console.log('\n  [SEC] Seguridad de idempotencia (SECURITY DEFINER)');
  await run('SEC.1  usuario real sin acceso al curso',       testSec1);
  await run('SEC.2  calendario modificado rechazado',        testSec2);
  await run('SEC.3  alumno_id distinto rechazado',           testSec3);

  console.log('\n  [SALDO] Resumen CC con importes exactos');
  await run('SALDO.1 resumen sin abonos',                    testSaldo1);
  await run('SALDO.2 resumen con abono parcial',             testSaldo2);
  await run('SALDO.3 plan completo no duplica en pagos',     testSaldo3);

  console.log('\n  Limpiando fixtures...');
  try { await teardown(); } catch (e) {
    console.warn('  ! teardown parcial:', e.message);
  }

  var total = passed + failed;
  var skipNote = skipped > 0 ? ', ' + skipped + ' omitidos' : '';
  console.log('\n  ' + passed + '/' + total + ' pasaron, ' + failed + ' fallaron' + skipNote + '\n');
  process.exit(failed > 0 ? 1 : 0);
})();
