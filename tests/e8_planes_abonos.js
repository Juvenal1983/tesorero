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
 * Para SEC.1 (usuario sin acceso al curso):
 *   STAGING_USER_B_EMAIL    = <email de un segundo usuario de staging>
 *   STAGING_USER_B_PASSWORD = <contraseña del segundo usuario>
 *   El test se omite si las credenciales B no están presentes.
 *
 * Producción EXCLUIDA. No ejecutar contra tmjqzaakzhecbldebyeg.
 */

'use strict';

const path   = require('path');
const assert = require('assert');
const https  = require('https');

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
  console.error('Faltan variables de entorno: STAGING_KEY, STAGING_EMAIL, STAGING_PASS');
  process.exit(1);
}
if (BASE.includes('tmjqzaakzhecbldebyeg')) {
  console.error('⛔ PROHIBIDO: BASE apunta a producción. Abortando.');
  process.exit(2);
}

var JWT    = '';
var CUENTA = process.env.STAGING_CUENTA_ID || '';

// ─── HTTP core ────────────────────────────────────────────────────────────────
// overrideHeaders: valores null eliminan la cabecera del default set
function reqRaw(method, url_path, body, overrideHeaders) {
  return new Promise(function(resolve, reject) {
    var url  = new URL(url_path, BASE);
    var data = body ? JSON.stringify(body) : null;
    var base = {
      'Content-Type':  'application/json',
      'apikey':        ANON_KEY,
      'Authorization': 'Bearer ' + JWT,
      'Prefer':        'return=representation',
    };
    var merged = Object.assign({}, base, overrideHeaders || {});
    // Eliminar cabeceras explícitamente anuladas (null)
    Object.keys(merged).forEach(function(k) { if (merged[k] == null) delete merged[k]; });
    if (data) merged['Content-Length'] = String(Buffer.byteLength(data));
    var opts = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   method,
      headers:  merged,
    };
    var r = https.request(opts, function(res) {
      var raw = '';
      res.on('data', function(c) { raw += c; });
      res.on('end', function() {
        var parsed;
        try { parsed = JSON.parse(raw); } catch(_) { parsed = raw; }
        if (res.statusCode >= 400) {
          var e2 = new Error('HTTP ' + res.statusCode + ' ' + method + ' ' + url_path + ': ' + raw);
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

function GET(p, h)       { return reqRaw('GET',    p, null, h); }
function POST(p, body)   { return reqRaw('POST',   p, body); }
function DELETE(p, h)    { return reqRaw('DELETE', p, null, h); }

// Inserción sin return: evita dependencia de defaults en la respuesta
function insert(table, body) {
  return reqRaw('POST', '/rest/v1/' + table, body, { 'Prefer': 'return=minimal' });
}

// RPC autenticado (tesorero)
function rpc(fn, params) {
  return POST('/rest/v1/rpc/' + fn, params);
}

// RPC anónimo: sin Authorization.
// apoderado_cc_resumen_pagos es una función pública concedida a anon;
// llamarla con JWT de tesorero ampliaría permisos de forma no representativa.
function rpcAnon(fn, params) {
  return reqRaw('POST', '/rest/v1/rpc/' + fn, params, { 'Authorization': null });
}

// RPC con JWT arbitrario (pruebas multi-usuario)
function rpcConJWT(fn, params, jwt) {
  return reqRaw('POST', '/rest/v1/rpc/' + fn, params, {
    'Authorization': 'Bearer ' + jwt,
    'Prefer':        'return=representation',
  });
}

// IDs TEXT exclusivos por ejecución
var _runTag = Date.now().toString(36);
function uid(prefix) {
  return (prefix || 'e8') + '-' + _runTag + '-' + Math.random().toString(36).slice(2, 8);
}

// ─── Login ────────────────────────────────────────────────────────────────────
function loginWith(email, pass) {
  return new Promise(function(resolve, reject) {
    var url  = new URL('/auth/v1/token?grant_type=password', BASE);
    var data = JSON.stringify({ email: email, password: pass });
    var opts = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'apikey':         ANON_KEY,
        'Content-Length': String(Buffer.byteLength(data)),
      },
    };
    var r = https.request(opts, function(res) {
      var raw = '';
      res.on('data', function(c) { raw += c; });
      res.on('end', function() {
        var parsed;
        try { parsed = JSON.parse(raw); } catch(e) {
          return reject(new Error('Login (' + email + '): respuesta no-JSON: ' + raw));
        }
        if (res.statusCode >= 400) {
          return reject(new Error('Login (' + email + ') falló (' + res.statusCode + '): ' + raw));
        }
        if (!parsed.access_token) {
          return reject(new Error('Login (' + email + '): sin access_token'));
        }
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
    throw new Error('No se encontró cuenta. Verifica STAGING_EMAIL.');
  }
  return rows[0].id;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────
var CURSO_ID  = null;
var ALUMNO_ID = null;
var CUOTA_ID  = null;
var CC_CODE   = null;
var _toClean  = [];   // creados en setup; teardown los borra en orden inverso

async function setup() {
  JWT = await loginWith(EMAIL, PASS);
  if (!CUENTA) {
    CUENTA = await descubrirCuentaId();
    console.log('  setup: CUENTA descubierta=' + CUENTA);
  }

  CURSO_ID = uid('curs');
  await insert('cursos', {
    id: CURSO_ID, cuenta_id: CUENTA,
    nombre: '[e8] Fixture ' + new Date().toISOString(),
    anio: 2026, activo: true,
  });
  _toClean.push({ table: 'cursos', id: CURSO_ID });

  ALUMNO_ID = uid('alu');
  await insert('alumnos', {
    id: ALUMNO_ID, cuenta_id: CUENTA, curso_id: CURSO_ID,
    nombres: 'Alumno', apellidos: 'E8', estado: 'activo',
  });
  _toClean.push({ table: 'alumnos', id: ALUMNO_ID });

  CUOTA_ID = uid('cuot');
  await insert('cuotas', {
    id: CUOTA_ID, cuenta_id: CUENTA, curso_id: CURSO_ID,
    nombre: 'Marzo 2026', tipo: 'mensual', monto: 10000, anio: 2026, activa: true,
  });
  _toClean.push({ table: 'cuotas', id: CUOTA_ID });

  // apoderado_cc_generar devuelve { codigo_cc: '...' }
  var codigo = await rpc('apoderado_cc_generar', { p_cuenta_id: CUENTA, p_curso_id: CURSO_ID });
  CC_CODE = (codigo && codigo.codigo_cc) || (typeof codigo === 'string' ? codigo : null);
  if (!CC_CODE) throw new Error('apoderado_cc_generar no devolvió codigo_cc: ' + JSON.stringify(codigo));

  console.log('  setup: CURSO=' + CURSO_ID + ' ALUMNO=' + ALUMNO_ID + ' CUOTA=' + CUOTA_ID + ' CC=' + CC_CODE);
}

// teardown: corre siempre en finally; borra sólo lo creado; verifica desaparición
async function teardown() {
  var errors = [];

  if (ALUMNO_ID && CUENTA) {
    var aQ = '/rest/v1/abonos?cuenta_id=eq.'     + CUENTA + '&alumno_id=eq.' + ALUMNO_ID;
    var pQ = '/rest/v1/planes_pago?cuenta_id=eq.' + CUENTA + '&alumno_id=eq.' + ALUMNO_ID;
    try { await DELETE(aQ); } catch(e) { if (e.status !== 404) errors.push('abonos: ' + e.message); }
    try { await DELETE(pQ); } catch(e) { if (e.status !== 404) errors.push('planes_pago: ' + e.message); }
  }

  for (var i = _toClean.length - 1; i >= 0; i--) {
    var item = _toClean[i];
    var q = '/rest/v1/' + item.table + '?id=eq.' + encodeURIComponent(item.id) + '&cuenta_id=eq.' + CUENTA;
    try { await DELETE(q); } catch(e) { if (e.status !== 404) errors.push(item.table + ': ' + e.message); }
  }

  for (var j = 0; j < _toClean.length; j++) {
    var item2 = _toClean[j];
    var q2 = '/rest/v1/' + item2.table + '?id=eq.' + encodeURIComponent(item2.id) + '&cuenta_id=eq.' + CUENTA + '&select=id';
    var rows;
    try { rows = await GET(q2); } catch(_) { rows = []; }
    if (Array.isArray(rows) && rows.length > 0) errors.push('fixture sigue presente: ' + item2.table + '(' + item2.id + ')');
  }

  if (errors.length > 0) throw new Error('Teardown incompleto:\n  ' + errors.join('\n  '));
}

// ─── Resultado ────────────────────────────────────────────────────────────────
var passed = 0, failed = 0, skipped = 0;

function SkipError(msg) { this.name = 'SkipError'; this.message = msg; }
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

// withCleanup: garantiza eliminar_plan aunque el test falle.
// La RPC puede rechazar si el plan tiene abonos pagados (plan cerrado por PLAN.7);
// en ese caso teardown() limpia vía DELETE directo — no es un error.
async function withCleanup(planId, fn) {
  try {
    return await fn();
  } finally {
    await rpc('eliminar_plan', { p_cuenta_id: CUENTA, p_plan_id: planId })
      .catch(function() {});
  }
}

// ─── Payload estándar ─────────────────────────────────────────────────────────
function planPayload(overrides) {
  overrides = overrides || {};
  var base = {
    p_cuenta_id:   CUENTA,
    p_plan_id:     overrides.p_plan_id || uid('plan'),
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

// ─── PLAN.1 ───────────────────────────────────────────────────────────────────
async function testPlan1() {
  var payload = planPayload();
  await withCleanup(payload.p_plan_id, async function() {
    var r = await rpc('crear_plan_con_abonos', payload);
    assert.ok(r.plan, 'falta plan');
    assert.ok(Array.isArray(r.abonos), 'falta arreglo abonos');
    assert.strictEqual(r.abonos.length, 2);
    assert.strictEqual(r.plan.monto_total, 10000);
    assert.strictEqual(r.idempotente, false);
  });
}

// ─── PLAN.2 ───────────────────────────────────────────────────────────────────
async function testPlan2() {
  await assert.rejects(
    function() { return rpc('crear_plan_con_abonos', planPayload({ p_monto_total: 0 })); },
    /monto_invalido/
  );
}

// ─── PLAN.3 ───────────────────────────────────────────────────────────────────
async function testPlan3() {
  await assert.rejects(
    function() {
      return rpc('crear_plan_con_abonos', planPayload({
        p_abonos: [{ monto: 3000, fecha: '2026-03-01' }, { monto: 3000, fecha: '2026-04-01' }],
      }));
    },
    /suma_abonos_invalida/
  );
}

// ─── PLAN.4 ───────────────────────────────────────────────────────────────────
async function testPlan4() {
  await assert.rejects(
    function() {
      return rpc('crear_plan_con_abonos', planPayload({
        p_monto_total: 5000,
        p_abonos: [{ monto: 5000, fecha: '2026-03-01' }],
      }));
    },
    /min_dos_abonos/
  );
}

// ─── PLAN.5 — Fecha inválida: error es abono_fecha_invalida, no SQLSTATE 22007 ─
// _sort_abonos (rev 5) ordena por texto y NO convierte fechas.
// El error correcto lo lanza el validador de Bloque 1.
async function testPlan5() {
  var badPayload = planPayload({
    p_abonos: [
      { monto: 5000, fecha: 'no-una-fecha' },
      { monto: 5000, fecha: '2026-04-01'  },
    ],
  });
  var e = await rpc('crear_plan_con_abonos', badPayload).then(
    function() { return null; },
    function(err) { return err; }
  );
  assert.ok(e, 'PLAN.5: debe rechazar la solicitud');
  // El mensaje debe ser abono_fecha_invalida, NO un error de base de datos genérico
  assert.ok(
    /abono_fecha_invalida/.test(e.message),
    'PLAN.5: error debe ser abono_fecha_invalida; recibido: ' + e.message
  );
  // No SQLSTATE 22007 (invalid_datetime_format)
  assert.ok(
    !/22007/.test(e.message),
    'PLAN.5: no debe lanzar SQLSTATE 22007 (_sort_abonos no debe convertir fechas)'
  );
}

// ─── PLAN.6 ───────────────────────────────────────────────────────────────────
async function testPlan6() {
  var payload = planPayload();
  await withCleanup(payload.p_plan_id, async function() {
    var r = await rpc('crear_plan_con_abonos', payload);
    var r2 = await rpc('pagar_abono', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id, p_abono_id: r.abonos[0].id });
    assert.strictEqual(r2.ya_pagado,    false);
    assert.strictEqual(r2.plan_cerrado, false);
    await rpc('revertir_abono', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id, p_abono_id: r.abonos[0].id });
  });
}

// ─── PLAN.7 ───────────────────────────────────────────────────────────────────
async function testPlan7() {
  var payload = planPayload();
  var r = await rpc('crear_plan_con_abonos', payload);
  var ab1 = r.abonos[0], ab2 = r.abonos[1];
  await rpc('pagar_abono', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id, p_abono_id: ab1.id });
  var r2 = await rpc('pagar_abono', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id, p_abono_id: ab2.id });
  assert.strictEqual(r2.plan_cerrado, true);
  var rows = await GET('/rest/v1/planes_pago?id=eq.' + r.plan.id + '&cuenta_id=eq.' + CUENTA + '&select=activo');
  assert.strictEqual(rows[0].activo, false);
  var pagos = await GET('/rest/v1/pagos?alumno_id=eq.' + ALUMNO_ID + '&cuota_id=eq.' + CUOTA_ID + '&cuenta_id=eq.' + CUENTA).catch(function() { return []; });
  assert.strictEqual((pagos || []).length, 0, 'G05: no insertar en tabla pagos');
  // Plan cerrado con abonos pagados: no se puede eliminar_plan. Teardown lo borra directamente.
}

// ─── PLAN.8 ───────────────────────────────────────────────────────────────────
async function testPlan8() {
  var payload = planPayload();
  await withCleanup(payload.p_plan_id, async function() {
    var r = await rpc('crear_plan_con_abonos', payload);
    await rpc('pagar_abono',    { p_cuenta_id: CUENTA, p_plan_id: r.plan.id, p_abono_id: r.abonos[0].id });
    await rpc('pagar_abono',    { p_cuenta_id: CUENTA, p_plan_id: r.plan.id, p_abono_id: r.abonos[1].id });
    await rpc('revertir_abono', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id, p_abono_id: r.abonos[1].id });
    var rows = await GET('/rest/v1/planes_pago?id=eq.' + r.plan.id + '&cuenta_id=eq.' + CUENTA + '&select=activo');
    assert.strictEqual(rows[0].activo, true, 'plan debe reabrirse al revertir un abono');
    await rpc('revertir_abono', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id, p_abono_id: r.abonos[0].id });
  });
}

// ─── PLAN.9 ───────────────────────────────────────────────────────────────────
async function testPlan9() {
  var payload = planPayload();
  await withCleanup(payload.p_plan_id, async function() {
    var r = await rpc('crear_plan_con_abonos', payload);
    var r2 = await rpc('editar_abono', { p_cuenta_id: CUENTA, p_abono_id: r.abonos[0].id, p_monto: 7000, p_fecha: null });
    assert.strictEqual(r2.abono.monto, 7000);
    var rows = await GET('/rest/v1/planes_pago?id=eq.' + r.plan.id + '&cuenta_id=eq.' + CUENTA + '&select=monto_total');
    assert.strictEqual(rows[0].monto_total, 12000, 'monto_total debe reflejar el delta');
    await rpc('editar_abono', { p_cuenta_id: CUENTA, p_abono_id: r.abonos[0].id, p_monto: 5000, p_fecha: null });
  });
}

// ─── PLAN.10 ──────────────────────────────────────────────────────────────────
async function testPlan10() {
  var payload = planPayload();
  await withCleanup(payload.p_plan_id, async function() {
    var r = await rpc('crear_plan_con_abonos', payload);
    await rpc('pagar_abono', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id, p_abono_id: r.abonos[0].id });
    await assert.rejects(
      function() { return rpc('editar_abono', { p_cuenta_id: CUENTA, p_abono_id: r.abonos[0].id, p_monto: 1000 }); },
      /abono_ya_pagado/
    );
    await rpc('revertir_abono', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id, p_abono_id: r.abonos[0].id });
  });
}

// ─── PLAN.11 ──────────────────────────────────────────────────────────────────
async function testPlan11() {
  var payload = planPayload();
  await withCleanup(payload.p_plan_id, async function() {
    var r = await rpc('crear_plan_con_abonos', payload);
    await rpc('pagar_abono', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id, p_abono_id: r.abonos[0].id });
    await assert.rejects(
      function() { return rpc('eliminar_plan', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id }); },
      /plan_con_abonos_pagados/
    );
    await rpc('revertir_abono', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id, p_abono_id: r.abonos[0].id });
  });
}

// ─── PLAN.12 ──────────────────────────────────────────────────────────────────
async function testPlan12() {
  var payload = planPayload();
  await withCleanup(payload.p_plan_id, async function() {
    var r1 = await rpc('crear_plan_con_abonos', payload);
    assert.strictEqual(r1.idempotente, false);
    var r2 = await rpc('crear_plan_con_abonos', payload);
    assert.strictEqual(r2.idempotente, true);
    assert.strictEqual(r2.plan.id, r1.plan.id);
    assert.strictEqual(r2.abonos.length, 2);
    await assert.rejects(
      function() { return rpc('crear_plan_con_abonos', Object.assign({}, payload, { p_monto_total: 99999 })); },
      /idempotency_conflict/
    );
  });
}

// ─── PLAN.13 ──────────────────────────────────────────────────────────────────
async function testPlan13() {
  var p1 = planPayload({ p_plan_id: uid('p13a') });
  var p2 = planPayload({ p_plan_id: uid('p13b') });
  var results = await Promise.allSettled([
    rpc('crear_plan_con_abonos', p1),
    rpc('crear_plan_con_abonos', p2),
  ]);
  var ok  = results.filter(function(r) { return r.status === 'fulfilled'; });
  var err = results.filter(function(r) { return r.status === 'rejected'; });
  assert.strictEqual(ok.length,  1);
  assert.strictEqual(err.length, 1);
  assert.ok(/duplicate_active_plan/.test(err[0].reason.message));
  await rpc('eliminar_plan', { p_cuenta_id: CUENTA, p_plan_id: ok[0].value.plan.id });
}

// ─── PLAN.13b ─────────────────────────────────────────────────────────────────
async function testPlan13b() {
  var payload = planPayload();
  var r       = await rpc('crear_plan_con_abonos', payload);
  var abonoId = r.abonos[0].id;
  var planId  = r.plan.id;

  var results = await Promise.allSettled([
    rpc('pagar_abono',   { p_cuenta_id: CUENTA, p_plan_id: planId, p_abono_id: abonoId }),
    rpc('eliminar_plan', { p_cuenta_id: CUENTA, p_plan_id: planId }),
  ]);

  for (var i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected') {
      var msg = (results[i].reason && results[i].reason.message) || '';
      assert.ok(/plan_con_abonos_pagados|plan_not_found/.test(msg),
        'error inesperado: ' + msg);
    }
  }

  var planRows = await GET('/rest/v1/planes_pago?id=eq.' + planId + '&cuenta_id=eq.' + CUENTA + '&select=id');
  if (planRows && planRows.length > 0) {
    await rpc('revertir_abono', { p_cuenta_id: CUENTA, p_plan_id: planId, p_abono_id: abonoId }).catch(function(){});
    await rpc('eliminar_plan',  { p_cuenta_id: CUENTA, p_plan_id: planId }).catch(function(){});
  }
}

// ─── PLAN.14 ──────────────────────────────────────────────────────────────────
async function testPlan14() {
  var otroCursoId = uid('c14');
  var otraCuotaId = uid('q14');
  var cleanupErrs = [];

  await insert('cursos', { id: otroCursoId, cuenta_id: CUENTA, nombre: '[e8] Otro curso', anio: 2026, activo: true });
  await insert('cuotas', { id: otraCuotaId, cuenta_id: CUENTA, curso_id: otroCursoId, nombre: 'Marzo 2026', tipo: 'mensual', monto: 8000, anio: 2026, activa: true });

  var testErr = null;
  try {
    await assert.rejects(
      function() { return rpc('crear_plan_con_abonos', planPayload({ p_cuota_id: otraCuotaId })); },
      /alumno_not_in_curso|cuota_not_found/
    );
  } catch(e) { testErr = e; }

  try { await DELETE('/rest/v1/cuotas?id=eq.' + otraCuotaId + '&cuenta_id=eq.' + CUENTA); } catch(e) { if (e.status !== 404) cleanupErrs.push(e.message); }
  try { await DELETE('/rest/v1/cursos?id=eq.' + otroCursoId + '&cuenta_id=eq.' + CUENTA); } catch(e) { if (e.status !== 404) cleanupErrs.push(e.message); }

  if (testErr) throw testErr;
  if (cleanupErrs.length) throw new Error('PLAN.14 cleanup: ' + cleanupErrs.join('; '));
}


// ─── ISO.1 — Rechazo pre-write: no queda plan huérfano ───────────────────────
// Bloque 1 (rev 6) rechaza dos clases de fecha inválida antes del primer INSERT:
//   a) fecha con formato no parseable como DATE
//   b) fecha ausente del objeto JSON (NULL implícito — IS NULL explícito en rev 6)
// En ambos casos la función lanza 'abono_fecha_invalida' antes de escribir nada.
async function testIso1() {
  // a) Fecha con formato inválido
  var planId_a = uid('iso1a');
  await assert.rejects(
    function() {
      return rpc('crear_plan_con_abonos', planPayload({
        p_plan_id: planId_a,
        p_abonos:  [{ monto: 5000, fecha: '2026-03-01' }, { monto: 5000, fecha: 'INVALIDA' }],
      }));
    },
    /abono_fecha_invalida/,
    'ISO.1a: fecha no parseable debe lanzar abono_fecha_invalida'
  );
  var rows_a = await GET('/rest/v1/planes_pago?id=eq.' + planId_a + '&cuenta_id=eq.' + CUENTA + '&select=id');
  assert.strictEqual(rows_a.length, 0, 'ISO.1a: no debe quedar plan huérfano');

  // b) Fecha ausente (campo "fecha" no incluido en el objeto del abono)
  var planId_b = uid('iso1b');
  await assert.rejects(
    function() {
      return rpc('crear_plan_con_abonos', {
        p_cuenta_id:   CUENTA,
        p_plan_id:     planId_b,
        p_alumno_id:   ALUMNO_ID,
        p_cuota_id:    CUOTA_ID,
        p_periodo:     'Marzo 2026',
        p_monto_total: 10000,
        p_abonos: [
          { monto: 5000, fecha: '2026-03-01' },
          { monto: 5000 },   // campo "fecha" ausente -> NULL
        ],
      });
    },
    /abono_fecha_invalida/,
    'ISO.1b: fecha ausente debe lanzar abono_fecha_invalida (rev 6)'
  );
  var rows_b = await GET('/rest/v1/planes_pago?id=eq.' + planId_b + '&cuenta_id=eq.' + CUENTA + '&select=id');
  assert.strictEqual(rows_b.length, 0, 'ISO.1b: no debe quedar plan huérfano');
}

// ─── ISO.2 — Rollback mid-write  [PENDIENTE — requiere PostgreSQL local] ──────
//
// Estado: NO ejecutada. Esta suite (API sobre staging) no puede inyectar una
// falla controlada después de que crear_plan_con_abonos ya comenzó a insertar
// filas sin modificar el esquema de producción.
//
// La atomicidad transaccional de la función se verifica en PostgreSQL local
// desechable, usando un trigger de fallo que dispara en el segundo abono.
// Pasos para reproducirla manualmente:
//
//   # 1. Instancia PG efímera
//   initdb -D /tmp/pg_iso2
//   pg_ctl start -D /tmp/pg_iso2 -l /tmp/pg_iso2.log
//   psql -d postgres -c "CREATE DATABASE iso2_test;"
//
//   # 2. Aplicar esquema mínimo (tablas + función) en iso2_test
//   psql -d iso2_test -f sql/00_schema_minimal.sql
//   psql -d iso2_test -f sql/11_rpc_b2_planes.sql
//
//   # 3. Instalar trigger de fallo en el segundo abono
//   psql -d iso2_test <<'SQL'
//   CREATE FUNCTION _fault_inject_mid_write() RETURNS trigger LANGUAGE plpgsql AS $$
//   BEGIN
//     IF (SELECT count(*) FROM abonos WHERE plan_id = NEW.plan_id) >= 1 THEN
//       RAISE EXCEPTION 'fault_inject_mid_write';
//     END IF;
//     RETURN NEW;
//   END $$;
//   CREATE TRIGGER t_fault_inject
//     BEFORE INSERT ON abonos
//     FOR EACH ROW EXECUTE FUNCTION _fault_inject_mid_write();
//   SQL
//
//   # 4. Invocar la función con 3 abonos válidos y capturar el error
//   planId=$(uuidgen)
//   psql -d iso2_test -c "SELECT crear_plan_con_abonos(
//     'acct-test', '$planId', 'alu-test', 'cuota-test', 'Marzo 2026', 10000,
//     '[{\"monto\":3000,\"fecha\":\"2026-03-01\"},
//       {\"monto\":3000,\"fecha\":\"2026-04-01\"},
//       {\"monto\":4000,\"fecha\":\"2026-05-01\"}]'::jsonb
//   );"
//   # Se espera: ERROR:  fault_inject_mid_write
//
//   # 5. Verificar rollback completo
//   psql -d iso2_test -c \
//     "SELECT count(*) FROM planes_pago WHERE id = '$planId';"  -- debe ser 0
//   psql -d iso2_test -c \
//     "SELECT count(*) FROM abonos WHERE plan_id = '$planId';"  -- debe ser 0
//
//   # 6. Limpiar
//   pg_ctl stop -D /tmp/pg_iso2
//   rm -rf /tmp/pg_iso2
//
async function testIso2() {
  throw new SkipError('pendiente — requiere PostgreSQL local con trigger de fallo; ver comentario ISO.2');
}

// ─── RLS.1 ────────────────────────────────────────────────────────────────────
async function testRls1() {
  await assert.rejects(
    function() { return rpc('crear_plan_con_abonos', planPayload({ p_cuenta_id: '00000000-0000-0000-0000-000000000000' })); },
    /permission_denied|cuota_not_found/
  );
}

// ─── RLS.2 ────────────────────────────────────────────────────────────────────
async function testRls2() {
  await assert.rejects(
    function() { return rpc('eliminar_plan', { p_cuenta_id: '00000000-0000-0000-0000-000000000000', p_plan_id: 'fake' }); },
    /plan_not_found|permission_denied/
  );
}

// ─── SEC.1 — Usuario real (cuenta B) sin acceso al curso ──────────────────────
// Auto-login con STAGING_USER_B_EMAIL + STAGING_USER_B_PASSWORD.
// User B pertenece a una cuenta distinta → no tiene rol en el curso de la cuenta A.
async function testSec1() {
  var emailB = process.env.STAGING_USER_B_EMAIL;
  var passB  = process.env.STAGING_USER_B_PASSWORD;
  if (!emailB || !passB) {
    throw new SkipError('requiere STAGING_USER_B_EMAIL y STAGING_USER_B_PASSWORD');
  }

  var jwtB    = await loginWith(emailB, passB);
  var payload = planPayload();
  var r       = await rpc('crear_plan_con_abonos', payload);

  var testErr = null;
  try {
    await assert.rejects(
      function() { return rpcConJWT('crear_plan_con_abonos', payload, jwtB); },
      /permission_denied/
    );
  } catch(e) { testErr = e; }

  await rpc('eliminar_plan', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id });
  if (testErr) throw testErr;
}

// ─── SEC.2 ────────────────────────────────────────────────────────────────────
async function testSec2() {
  var payload = planPayload();
  await withCleanup(payload.p_plan_id, async function() {
    await rpc('crear_plan_con_abonos', payload);
    await assert.rejects(
      function() {
        return rpc('crear_plan_con_abonos', Object.assign({}, payload, {
          p_abonos: [{ monto: 5000, fecha: '2026-05-01' }, { monto: 5000, fecha: '2026-06-01' }],
        }));
      },
      /idempotency_conflict/
    );
    await assert.rejects(
      function() {
        return rpc('crear_plan_con_abonos', Object.assign({}, payload, {
          p_abonos: [{ monto: 3000, fecha: '2026-03-01' }, { monto: 7000, fecha: '2026-04-01' }],
        }));
      },
      /idempotency_conflict/
    );
  });
}

// ─── SEC.3 ────────────────────────────────────────────────────────────────────
async function testSec3() {
  var payload = planPayload();
  await withCleanup(payload.p_plan_id, async function() {
    await rpc('crear_plan_con_abonos', payload);
    await assert.rejects(
      function() {
        return rpc('crear_plan_con_abonos', Object.assign({}, payload, {
          p_alumno_id: 'alu-falso-' + uid(),
        }));
      },
      /idempotency_conflict|alumno_not_in_curso/
    );
  });
}

// ─── SALDO.1 — apoderado_cc_resumen_pagos se llama como anon ─────────────────
// La RPC está concedida al rol anon (cliente compartido del apoderado);
// el test la llama sin cabecera Authorization para representar ese rol real.
async function testSaldo1() {
  var resumen = await rpcAnon('apoderado_cc_resumen_pagos', { p_codigo_cc: CC_CODE });
  assert.ok(Array.isArray(resumen), 'resumen debe ser un arreglo');
}

// ─── SALDO.2 — Resumen refleja abono parcial; importes y deuda exactos ─────────
async function testSaldo2() {
  var payload = planPayload();
  await withCleanup(payload.p_plan_id, async function() {
    var r = await rpc('crear_plan_con_abonos', payload);
    await rpc('pagar_abono', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id, p_abono_id: r.abonos[0].id });

    var resumen = await rpcAnon('apoderado_cc_resumen_pagos', { p_codigo_cc: CC_CODE });
    var fila    = resumen.find(function(f) { return f.alumno_id === ALUMNO_ID; });

    assert.ok(fila, 'SALDO.2: debe existir fila para el alumno en el resumen CC');
    assert.strictEqual(fila.monto_abonado, 5000,
      'SALDO.2: monto_abonado debe ser exactamente 5000; obtenido: ' + fila.monto_abonado);
    assert.strictEqual(fila.deuda, 5000,
      'SALDO.2: deuda debe ser exactamente 5000; obtenida: ' + fila.deuda);

    await rpc('revertir_abono', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id, p_abono_id: r.abonos[0].id });
  });
}

// ─── SALDO.3 — Plan completo: sin duplicado en pagos; saldo exacto (G05) ───────
async function testSaldo3() {
  var payload = planPayload();
  var r       = await rpc('crear_plan_con_abonos', payload);

  for (var i = 0; i < r.abonos.length; i++) {
    await rpc('pagar_abono', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id, p_abono_id: r.abonos[i].id });
  }

  var pagos = await GET(
    '/rest/v1/pagos?alumno_id=eq.' + ALUMNO_ID + '&cuota_id=eq.' + CUOTA_ID +
    '&cuenta_id=eq.' + CUENTA + '&select=id'
  ).catch(function() { return []; });
  assert.strictEqual((pagos || []).length, 0, 'G05: completar plan no debe crear registros en pagos');

  var resumen = await rpcAnon('apoderado_cc_resumen_pagos', { p_codigo_cc: CC_CODE });
  var fila    = resumen.find(function(f) { return f.alumno_id === ALUMNO_ID; });
  assert.ok(fila, 'SALDO.3: debe existir fila para el alumno');
  assert.strictEqual(fila.monto_abonado, 10000,
    'SALDO.3: monto_abonado debe ser exactamente 10000; obtenido: ' + fila.monto_abonado);
  assert.strictEqual(fila.deuda, 0,
    'SALDO.3: deuda debe ser 0; obtenida: ' + fila.deuda);
  // Plan cerrado con abonos pagados → teardown lo borra con DELETE directo
}

// ─── PLAN.15 — Reintento con params originales tras editar_abono ──────────────
async function testPlan15() {
  var payload = planPayload();
  await withCleanup(payload.p_plan_id, async function() {
    var r       = await rpc('crear_plan_con_abonos', payload);
    var abonoId = r.abonos[0].id;
    await rpc('editar_abono', { p_cuenta_id: CUENTA, p_abono_id: abonoId, p_monto: 7000 });
    var r2 = await rpc('crear_plan_con_abonos', payload);
    assert.strictEqual(r2.idempotente, true, 'reintento con params originales debe ser idempotente tras editar_abono');
    assert.strictEqual(r2.plan.id, r.plan.id);
    // Revertir edición para que withCleanup pueda eliminar el plan
    await rpc('editar_abono', { p_cuenta_id: CUENTA, p_abono_id: abonoId, p_monto: 5000 });
  });
}

// ─── PLAN.16 — Mismo plan_id, calendarios distintos en paralelo ──────────────
async function testPlan16() {
  var planId = uid('p16');
  await withCleanup(planId, async function() {
    var results = await Promise.allSettled([
      rpc('crear_plan_con_abonos', planPayload({
        p_plan_id: planId,
        p_abonos:  [{ monto: 5000, fecha: '2026-03-01' }, { monto: 5000, fecha: '2026-04-01' }],
      })),
      rpc('crear_plan_con_abonos', planPayload({
        p_plan_id: planId,
        p_abonos:  [{ monto: 3000, fecha: '2026-03-01' }, { monto: 7000, fecha: '2026-04-01' }],
      })),
    ]);
    var ok  = results.filter(function(r) { return r.status === 'fulfilled'; });
    var err = results.filter(function(r) { return r.status === 'rejected';  });
    assert.strictEqual(ok.length,  1, 'exactamente una petición debe tener éxito');
    assert.strictEqual(err.length, 1, 'exactamente una petición debe fallar');
    assert.ok(/idempotency_conflict/.test(err[0].reason.message),
      'conflicto debe ser idempotency_conflict; recibido: ' + err[0].reason.message);
  });
}

// ─── PLAN.17 — Respuesta perdida: reintento idempotente vía API ───────────────
// Primera llamada llega al servidor; respuesta descartada (error de red, timeout).
// Segunda llamada con el MISMO plan_id → idempotente=true sin duplicar el plan.
// La verificación usa el plan_id exacto para no confundir con planes de otros tests.
async function testPlan17() {
  var payload = planPayload();
  var planId  = payload.p_plan_id;

  await withCleanup(planId, async function() {
    // Primera llamada — el servidor crea el plan; respuesta "perdida"
    void (await rpc('crear_plan_con_abonos', payload));

    // Estado antes del reintento: capturar ID del plan para comparación
    var planesAntes = await GET(
      '/rest/v1/planes_pago?id=eq.' + planId + '&cuenta_id=eq.' + CUENTA + '&select=id'
    );
    assert.strictEqual(planesAntes.length, 1, 'PLAN.17: debe existir exactamente un plan antes del reintento');

    // Reintento con el mismo planId
    var r2 = await rpc('crear_plan_con_abonos', payload);
    assert.strictEqual(r2.idempotente, true,
      'PLAN.17: reintento debe devolver idempotente=true');
    assert.strictEqual(r2.plan.id, planId,
      'PLAN.17: debe devolver el mismo plan_id');
    assert.ok(Array.isArray(r2.abonos) && r2.abonos.length === 2,
      'PLAN.17: debe devolver los 2 abonos originales');

    // Verificar por ID exacto que no se creó ningún plan adicional
    var planesDespues = await GET(
      '/rest/v1/planes_pago?id=eq.' + planId + '&cuenta_id=eq.' + CUENTA + '&select=id'
    );
    assert.strictEqual(planesDespues.length, 1,
      'PLAN.17: no deben existir planes duplicados (consultando por plan_id exacto)');
  });
}

// ─── PLAN.17b — Respuesta perdida: simulación del handler guardarPlanPago() ───
// Alcance: simulación Node.js del flujo de cliente de guardarPlanPago().
// Esta prueba NO invoca el código JavaScript del navegador (pagos-formularios.js),
// que depende del DOM, sessionStorage y confirm().
// Lo que se prueba es el comportamiento del SERVIDOR cuando el cliente
// reutiliza el planId persistido (el mecanismo de sesión es simulado con variables).
//
// Flujo simulado:
//   1. guardarPlanPago() genera planId + payloadHash y los persiste en "sessionStorage"
//   2. La petición llega al servidor pero la respuesta se pierde (error de red)
//   3. El usuario reabre el formulario con el mismo payload → hash coincide → reutiliza planId
//   4. El servidor reconoce el reintento como idempotente
//   5. Éxito confirmado → "sessionStorage" se limpia
async function testPlan17b() {
  var cuentaId   = CUENTA;
  var alumnoId   = ALUMNO_ID;
  var cuotaId    = CUOTA_ID;
  var periodo    = 'Marzo 2026';
  var abonos     = [{ monto: 5000, fecha: '2026-03-01' }, { monto: 5000, fecha: '2026-04-01' }];
  var totalAbs   = 10000;
  var payloadHash = JSON.stringify({ totalAbonos: totalAbs, abonos: abonos });

  var pendingKey   = 'pp_pending_' + cuentaId + '_' + alumnoId + '_' + cuotaId + '_' + periodo;
  var planId       = uid('form');
  var sessionStore = {};
  sessionStore[pendingKey] = { planId: planId, payloadHash: payloadHash };

  await withCleanup(planId, async function() {
    // Paso 1: petición enviada → respuesta perdida (sessionStore no se limpia)
    await rpc('crear_plan_con_abonos', {
      p_cuenta_id: cuentaId, p_plan_id: planId, p_alumno_id: alumnoId,
      p_cuota_id:  cuotaId,  p_periodo:  periodo,
      p_monto_total: totalAbs, p_abonos: abonos,
    });
    assert.ok(sessionStore[pendingKey], 'sessionStore debe mantener la entrada tras respuesta perdida');

    // Paso 2: reapertura del formulario → hash coincide → reutiliza planId
    var stored        = sessionStore[pendingKey];
    var newPayloadHash = JSON.stringify({ totalAbonos: totalAbs, abonos: abonos });
    assert.strictEqual(stored.payloadHash, newPayloadHash, 'hash debe coincidir: mismo payload');
    assert.strictEqual(stored.planId, planId, 'planId reutilizado debe coincidir');

    // Paso 3: reintento → servidor reconoce idempotencia
    var r2 = await rpc('crear_plan_con_abonos', {
      p_cuenta_id: cuentaId, p_plan_id: stored.planId, p_alumno_id: alumnoId,
      p_cuota_id:  cuotaId,  p_periodo:  periodo,
      p_monto_total: totalAbs, p_abonos: abonos,
    });
    assert.strictEqual(r2.idempotente, true, 'PLAN.17b: reintento debe ser idempotente');
    assert.strictEqual(r2.plan.id, planId);

    // Paso 4: éxito confirmado → sessionStorage limpiado
    delete sessionStore[pendingKey];
    assert.strictEqual(sessionStore[pendingKey], undefined, 'sessionStore debe limpiarse tras éxito');

    // Sin planes duplicados (consultando por plan_id exacto)
    var planes = await GET('/rest/v1/planes_pago?id=eq.' + planId + '&cuenta_id=eq.' + CUENTA + '&select=id');
    assert.strictEqual(planes.length, 1, 'PLAN.17b: no deben existir planes duplicados');
  });
}

// ─── Runner ───────────────────────────────────────────────────────────────────
(async function() {
  console.log('\nE8 — Planes de pago y abonos\n');
  console.log('  BASE: ' + BASE);

  var setupOk = false;
  try {
    console.log('  Preparando fixtures...');
    await setup();
    setupOk = true;
  } catch (e) {
    console.error('  ✗ setup falló: ' + e.message);
  }

  try {
    if (!setupOk) {
      failed++;
    } else {
      console.log('\n  [PLAN] Validaciones y flujos basicos');
      await run('PLAN.1  Crear plan con dos abonos',            testPlan1);
      await run('PLAN.2  monto_total=0 rechazado',              testPlan2);
      await run('PLAN.3  suma abonos != monto_total rechazada', testPlan3);
      await run('PLAN.4  un solo abono rechazado',              testPlan4);
      await run('PLAN.5  fecha inválida → abono_fecha_invalida (no 22007)', testPlan5);
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
      await run('ISO.1  rechazo pre-write → sin plan huerfano',              testIso1);
      await run('ISO.2  rollback mid-write → sin datos parciales',           testIso2);

      console.log('\n  [RLS] Autorizacion');
      await run('RLS.1  cuenta ajena denegada en crear',        testRls1);
      await run('RLS.2  cuenta ajena denegada en eliminar',     testRls2);

      console.log('\n  [PLAN] Idempotencia con snapshot inmutable');
      await run('PLAN.15 reintento tras editar_abono (snapshot)',          testPlan15);
      await run('PLAN.16 mismo plan_id calendarios distintos',             testPlan16);
      await run('PLAN.17 respuesta perdida → reintento idempotente (API)', testPlan17);
      await run('PLAN.17b respuesta perdida → guardarPlanPago() [simulación Node.js]', testPlan17b);

      console.log('\n  [SEC] Seguridad de idempotencia (SECURITY DEFINER)');
      await run('SEC.1  usuario cuenta B sin acceso al curso', testSec1);
      await run('SEC.2  calendario modificado rechazado',      testSec2);
      await run('SEC.3  alumno_id distinto rechazado',         testSec3);

      console.log('\n  [SALDO] Resumen CC (anon) con importes exactos');
      await run('SALDO.1 resumen sin abonos',                testSaldo1);
      await run('SALDO.2 resumen con abono parcial exacto',  testSaldo2);
      await run('SALDO.3 plan completo sin duplicado pagos', testSaldo3);
    }
  } finally {
    console.log('\n  Limpiando fixtures...');
    try {
      await teardown();
      console.log('  ✓ teardown completo (fixtures verificados)');
    } catch (e) {
      console.error('  ✗ teardown: ' + e.message);
      failed++;
    }
  }

  var total    = passed + failed;
  var skipNote = skipped > 0 ? ', ' + skipped + ' omitidos' : '';
  console.log('\n  ' + passed + '/' + total + ' pasaron, ' + failed + ' fallaron' + skipNote + '\n');
  process.exit(failed > 0 ? 1 : 0);
})();
