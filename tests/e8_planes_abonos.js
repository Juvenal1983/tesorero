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
 *   User B no tiene rol en el curso de la cuenta A, por lo que el plan le es inaccesible.
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

// Guardia de seguridad: nunca tocar producción
if (BASE.includes('tmjqzaakzhecbldebyeg')) {
  console.error('⛔ PROHIBIDO: BASE apunta a producción. Abortando.');
  process.exit(2);
}

// JWT y cuenta se inicializan en setup() tras el login
var JWT    = '';
var CUENTA = process.env.STAGING_CUENTA_ID || '';

// ─── Helper HTTP ──────────────────────────────────────────────────────────────
function reqRaw(method, url_path, body, overrideHeaders) {
  return new Promise(function(resolve, reject) {
    var url  = new URL(url_path, BASE);
    var data = body ? JSON.stringify(body) : null;
    var opts = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   method,
      headers:  Object.assign({
        'Content-Type':  'application/json',
        'apikey':        ANON_KEY,
        'Authorization': 'Bearer ' + JWT,
        'Prefer':        'return=representation',
      }, overrideHeaders || {}),
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
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

// Inserción sin return: evita dependencia de defaults inexistentes en la respuesta
function insert(table, body) {
  return reqRaw('POST', '/rest/v1/' + table, body, { 'Prefer': 'return=minimal' });
}

function rpc(fn, params) {
  return POST('/rest/v1/rpc/' + fn, params);
}

// RPC con JWT arbitrario (para pruebas multi-usuario)
function rpcConJWT(fn, params, jwt) {
  return reqRaw('POST', '/rest/v1/rpc/' + fn, params, {
    'Authorization': 'Bearer ' + jwt,
    'Prefer':        'return=representation',
  });
}

// Genera IDs TEXT exclusivos por ejecución; no depende de defaults de la BD
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
        'Content-Length': Buffer.byteLength(data),
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
          return reject(new Error('Login (' + email + '): sin access_token en respuesta'));
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
    throw new Error('No se encontró cuenta para este usuario. ' +
      'Verifica que STAGING_EMAIL corresponde a un tesorero/dueño de cuenta.');
  }
  return rows[0].id;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────
// IDs generados en setup() y usados en toda la suite
var CURSO_ID  = null;
var ALUMNO_ID = null;
var CUOTA_ID  = null;
var CC_CODE   = null;

// Lista de fixtures creados, en orden de creación; teardown los borra en orden inverso
var _toClean = [];

async function setup() {
  // 0. Login y descubrir cuenta
  JWT = await loginWith(EMAIL, PASS);
  if (!CUENTA) {
    CUENTA = await descubrirCuentaId();
    console.log('  setup: CUENTA descubierta=' + CUENTA);
  }

  // 1. Crear curso fixture — id TEXT explícito, no depende de defaults
  CURSO_ID = uid('curs');
  await insert('cursos', {
    id:        CURSO_ID,
    cuenta_id: CUENTA,
    nombre:    '[e8] Fixture ' + new Date().toISOString() + ' (auto-eliminar)',
    anio:      2026,
    activo:    true,
  });
  _toClean.push({ table: 'cursos', id: CURSO_ID });

  // 2. Crear alumno fixture — id TEXT explícito
  ALUMNO_ID = uid('alu');
  await insert('alumnos', {
    id:        ALUMNO_ID,
    cuenta_id: CUENTA,
    curso_id:  CURSO_ID,
    nombres:   'Alumno',
    apellidos: 'E8',
    estado:    'activo',
  });
  _toClean.push({ table: 'alumnos', id: ALUMNO_ID });

  // 3. Crear cuota fixture — id TEXT explícito
  CUOTA_ID = uid('cuot');
  await insert('cuotas', {
    id:        CUOTA_ID,
    cuenta_id: CUENTA,
    curso_id:  CURSO_ID,
    nombre:    'Marzo 2026',
    tipo:      'mensual',
    monto:     10000,
    anio:      2026,
    activa:    true,
  });
  _toClean.push({ table: 'cuotas', id: CUOTA_ID });

  // 4. Código CC del curso (necesario para las pruebas SALDO)
  var codigo = await rpc('apoderado_cc_generar', {
    p_cuenta_id: CUENTA,
    p_curso_id:  CURSO_ID,
  });
  CC_CODE = typeof codigo === 'string' ? codigo : (codigo && codigo.codigo_compartido);
  if (!CC_CODE) {
    throw new Error('apoderado_cc_generar no devolvió código CC: ' + JSON.stringify(codigo));
  }

  console.log('  setup: CURSO=' + CURSO_ID + ' ALUMNO=' + ALUMNO_ID + ' CUOTA=' + CUOTA_ID + ' CC=' + CC_CODE);
}

// teardown: se ejecuta siempre en finally, incluso si setup falló a medias.
// Borra sólo los fixtures que llegaron a crearse (_toClean).
// Errores ≠ 404 se acumulan y se lanzan al final para no silenciar problemas.
// Después de borrar verifica que las filas desaparecieron.
async function teardown() {
  var errors = [];

  // Red de seguridad: borrar planes/abonos residuales antes de los fixtures padre
  if (ALUMNO_ID && CUENTA) {
    var aQ = '/rest/v1/abonos?cuenta_id=eq.'     + CUENTA + '&alumno_id=eq.' + ALUMNO_ID;
    var pQ = '/rest/v1/planes_pago?cuenta_id=eq.' + CUENTA + '&alumno_id=eq.' + ALUMNO_ID;
    try { await DELETE(aQ); } catch(e) {
      if (e.status !== 404) errors.push('abonos residuales: ' + (e.message || e));
    }
    try { await DELETE(pQ); } catch(e) {
      if (e.status !== 404) errors.push('planes_pago residuales: ' + (e.message || e));
    }
  }

  // Borrar fixtures en orden inverso (hijos antes que padres)
  for (var i = _toClean.length - 1; i >= 0; i--) {
    var item = _toClean[i];
    var q = '/rest/v1/' + item.table + '?id=eq.' + encodeURIComponent(item.id) +
            '&cuenta_id=eq.' + CUENTA;
    try {
      await DELETE(q);
    } catch(e) {
      if (e.status !== 404) {
        errors.push(item.table + '(' + item.id + '): ' + (e.message || e));
      }
    }
  }

  // Verificar que las filas desaparecieron
  for (var j = 0; j < _toClean.length; j++) {
    var item2 = _toClean[j];
    var q2 = '/rest/v1/' + item2.table + '?id=eq.' + encodeURIComponent(item2.id) +
             '&cuenta_id=eq.' + CUENTA + '&select=id';
    var rows;
    try { rows = await GET(q2); } catch(_) { rows = []; }
    if (Array.isArray(rows) && rows.length > 0) {
      errors.push('fixture sigue presente: ' + item2.table + '(' + item2.id + ')');
    }
  }

  if (errors.length > 0) {
    throw new Error('Teardown incompleto:\n  ' + errors.join('\n  '));
  }
}

// ─── Resultado ────────────────────────────────────────────────────────────────
var passed = 0, failed = 0, skipped = 0;

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

// ─── Helper: payload de plan con fixtures de esta ejecución ──────────────────
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
    /monto_invalido/
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
  assert.strictEqual(r2.ya_pagado,    false);
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
  // G05: completar un plan no debe insertar en tabla pagos
  var pagos = await GET('/rest/v1/pagos?alumno_id=eq.' + ALUMNO_ID +
    '&cuota_id=eq.' + CUOTA_ID + '&cuenta_id=eq.' + CUENTA).catch(function() { return []; });
  assert.strictEqual((pagos || []).length, 0, 'G05: no debe insertarse en tabla pagos al completar plan');
  // Plan cerrado; teardown lo borra con DELETE directo
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

  var r2 = await rpc('crear_plan_con_abonos', payload);
  assert.strictEqual(r2.idempotente, true,       'segunda llamada debe ser idempotente');
  assert.strictEqual(r2.plan.id,     r1.plan.id, 'debe devolver el mismo plan_id');
  assert.strictEqual(r2.abonos.length, 2,         'debe devolver los mismos 2 abonos');

  var payloadMontoDiff = Object.assign({}, payload, { p_monto_total: 99999 });
  await assert.rejects(
    function() { return rpc('crear_plan_con_abonos', payloadMontoDiff); },
    /idempotency_conflict/,
    'mismo p_plan_id con monto diferente debe rechazarse'
  );

  await rpc('eliminar_plan', { p_cuenta_id: CUENTA, p_plan_id: r1.plan.id });
}

// ─── PLAN.13 Concurrencia: dos plan_id distintos, mismo natural key ───────────
async function testPlan13() {
  var payload1 = planPayload({ p_plan_id: uid('p13a') });
  var payload2 = planPayload({ p_plan_id: uid('p13b') });

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

  await rpc('eliminar_plan', { p_cuenta_id: CUENTA, p_plan_id: ok[0].value.plan.id });
}

// ─── PLAN.13b Concurrencia: pago y eliminación simultáneos ───────────────────
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
    var res = results[i];
    if (res.status === 'rejected') {
      var msg = (res.reason && res.reason.message) || '';
      var isExpected = /plan_con_abonos_pagados|plan_not_found/.test(msg);
      assert.ok(isExpected, 'error inesperado en concurrencia pago+eliminacion: ' + msg);
    }
  }

  var planRows = await GET('/rest/v1/planes_pago?id=eq.' + planId + '&cuenta_id=eq.' + CUENTA + '&select=id').catch(function() { return []; });
  if (planRows && planRows.length > 0) {
    await rpc('revertir_abono', { p_cuenta_id: CUENTA, p_plan_id: planId, p_abono_id: abonoId }).catch(function(){});
    await rpc('eliminar_plan',  { p_cuenta_id: CUENTA, p_plan_id: planId }).catch(function(){});
  }
}

// ─── PLAN.14 Cuota de otro curso rechazada ───────────────────────────────────
async function testPlan14() {
  var otroCursoId  = uid('c14');
  var otraCuotaId  = uid('q14');

  await insert('cursos', {
    id:        otroCursoId,
    cuenta_id: CUENTA,
    nombre:    '[e8] Otro curso ' + new Date().toISOString(),
    anio:      2026,
    activo:    true,
  });
  await insert('cuotas', {
    id:        otraCuotaId,
    cuenta_id: CUENTA,
    curso_id:  otroCursoId,
    nombre:    'Marzo 2026',
    tipo:      'mensual',
    monto:     8000,
    anio:      2026,
    activa:    true,
  });

  var payload = planPayload({ p_cuota_id: otraCuotaId });
  var testErr = null;
  try {
    await assert.rejects(
      function() { return rpc('crear_plan_con_abonos', payload); },
      /alumno_not_in_curso|cuota_not_found/,
      'no debe permitir crear plan con cuota de otro curso'
    );
  } catch(e) {
    testErr = e;
  }

  // Limpiar aunque falle la aserción
  var cleanErrs = [];
  try { await DELETE('/rest/v1/cuotas?id=eq.' + otraCuotaId + '&cuenta_id=eq.' + CUENTA); } catch(e) { if (e.status !== 404) cleanErrs.push('cuota: ' + e.message); }
  try { await DELETE('/rest/v1/cursos?id=eq.' + otroCursoId + '&cuenta_id=eq.' + CUENTA); } catch(e) { if (e.status !== 404) cleanErrs.push('curso: ' + e.message); }

  if (testErr) throw testErr;
  if (cleanErrs.length) throw new Error('PLAN.14 cleanup: ' + cleanErrs.join('; '));
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
  var rows = await GET('/rest/v1/planes_pago?id=eq.' + badPayload.p_plan_id + '&cuenta_id=eq.' + CUENTA + '&select=id').catch(function() { return []; });
  assert.strictEqual(rows.length, 0, 'rollback: no debe quedar plan huerfano');
}

// ─── RLS.1 Cuenta ajena denegada en crear ────────────────────────────────────
async function testRls1() {
  var fakeUuid = '00000000-0000-0000-0000-000000000000';
  var payload  = planPayload({ p_cuenta_id: fakeUuid });
  await assert.rejects(
    function() { return rpc('crear_plan_con_abonos', payload); },
    /permission_denied|cuota_not_found/
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

// ─── SEC.1 Usuario real (cuenta B) sin acceso al curso ────────────────────────
// Verifica que el bloque de idempotencia (SECURITY DEFINER) NO devuelve datos del
// plan a un usuario autenticado que pertenece a una cuenta distinta.
//
// Escenario: se crea un plan con JWT de la cuenta A.  Luego User B (cuenta distinta,
// sin ningún rol en el curso) envía exactamente la misma cuenta_id+plan_id.
// La función debe lanzar permission_denied ANTES de devolver cualquier dato.
//
// Auto-login con STAGING_USER_B_EMAIL + STAGING_USER_B_PASSWORD.
// Se omite si esas variables no están definidas.
async function testSec1() {
  var emailB = process.env.STAGING_USER_B_EMAIL;
  var passB  = process.env.STAGING_USER_B_PASSWORD;
  if (!emailB || !passB) {
    throw new SkipError(
      'requiere STAGING_USER_B_EMAIL y STAGING_USER_B_PASSWORD ' +
      '(segundo usuario staging sin rol en la cuenta A)'
    );
  }

  // Login de User B
  var jwtB = await loginWith(emailB, passB);

  // Crear plan real con JWT de User A
  var payload    = planPayload();
  var r          = await rpc('crear_plan_con_abonos', payload);
  var realPlanId = r.plan.id;

  // Ataque: User B usa la cuenta_id y plan_id correctos de User A
  var testErr = null;
  try {
    await assert.rejects(
      function() { return rpcConJWT('crear_plan_con_abonos', payload, jwtB); },
      /permission_denied/,
      'SEC.1: User B sin acceso al curso no debe obtener datos del plan'
    );
  } catch(e) {
    testErr = e;
  }

  await rpc('eliminar_plan', { p_cuenta_id: CUENTA, p_plan_id: realPlanId });
  if (testErr) throw testErr;
}

// ─── SEC.2 Idempotencia rechaza calendario modificado ─────────────────────────
async function testSec2() {
  var payload = planPayload();
  var r = await rpc('crear_plan_con_abonos', payload);

  var payloadFechaDistinta = Object.assign({}, payload, {
    p_abonos: [
      { monto: 5000, fecha: '2026-05-01' },
      { monto: 5000, fecha: '2026-06-01' },
    ],
  });
  await assert.rejects(
    function() { return rpc('crear_plan_con_abonos', payloadFechaDistinta); },
    /idempotency_conflict/,
    'SEC.2: mismo p_plan_id con fechas de abonos distintas debe rechazarse'
  );

  var payloadMontoDistinto = Object.assign({}, payload, {
    p_abonos: [
      { monto: 3000, fecha: '2026-03-01' },
      { monto: 7000, fecha: '2026-04-01' },
    ],
  });
  await assert.rejects(
    function() { return rpc('crear_plan_con_abonos', payloadMontoDistinto); },
    /idempotency_conflict/,
    'SEC.2: mismo p_plan_id con distribucion de montos distinta debe rechazarse'
  );

  await rpc('eliminar_plan', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id });
}

// ─── SEC.3 Idempotencia rechaza alumno_id distinto ───────────────────────────
async function testSec3() {
  var payload = planPayload();
  var r = await rpc('crear_plan_con_abonos', payload);

  var payloadAlumnoDistinto = Object.assign({}, payload, { p_alumno_id: 'alu-falso-' + uid() });
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

// ─── SALDO.2 Resumen refleja abono parcial — importes y deuda exactos ─────────
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

  // La fila DEBE existir; si no, el resumen no refleja el abono
  assert.ok(fila, 'SALDO.2: debe existir fila para el alumno en el resumen CC');
  assert.strictEqual(fila.monto_abonado, 5000,
    'SALDO.2: monto_abonado debe ser exactamente 5000; obtenido: ' + fila.monto_abonado);
  // deuda = cuota.monto (10000) − monto_abonado (5000) = 5000
  assert.strictEqual(fila.deuda, 5000,
    'SALDO.2: deuda debe ser exactamente 5000; obtenida: ' + fila.deuda);

  await rpc('revertir_abono', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id, p_abono_id: r.abonos[0].id });
  await rpc('eliminar_plan',  { p_cuenta_id: CUENTA, p_plan_id: r.plan.id });
}

// ─── SALDO.3 Plan completo — sin duplicado en pagos; saldo exacto (G05) ───────
async function testSaldo3() {
  var payload = planPayload();
  var r       = await rpc('crear_plan_con_abonos', payload);

  for (var i = 0; i < r.abonos.length; i++) {
    await rpc('pagar_abono', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id, p_abono_id: r.abonos[i].id });
  }

  // G05: no deben crearse registros en tabla pagos
  var pagos = await GET(
    '/rest/v1/pagos?alumno_id=eq.' + ALUMNO_ID +
    '&cuota_id=eq.' + CUOTA_ID + '&cuenta_id=eq.' + CUENTA + '&select=id'
  ).catch(function() { return []; });
  assert.strictEqual((pagos || []).length, 0,
    'G05: completar un plan no debe crear registros en tabla pagos');

  var resumen = await rpc('apoderado_cc_resumen_pagos', { p_codigo_cc: CC_CODE });
  var fila    = resumen.find(function(f) { return f.alumno_id === ALUMNO_ID; });

  // La fila DEBE existir con saldo exacto
  assert.ok(fila, 'SALDO.3: debe existir fila para el alumno en el resumen CC');
  assert.strictEqual(fila.monto_abonado, 10000,
    'SALDO.3: monto_abonado debe ser exactamente 10000; obtenido: ' + fila.monto_abonado);
  assert.strictEqual(fila.deuda, 0,
    'SALDO.3: deuda debe ser 0 tras completar el plan; obtenida: ' + fila.deuda);

  // Plan cerrado; teardown elimina el plan con DELETE directo (no hay abonos revertibles)
}

// ─── PLAN.15 Reintento con params originales tras editar_abono ───────────────
// solicitud_json (snapshot inmutable) no cambia al editar abonos.
// El reintento con el payload original debe reconocerse como idempotente.
async function testPlan15() {
  var payload = planPayload();
  var r       = await rpc('crear_plan_con_abonos', payload);
  var abonoId = r.abonos[0].id;

  // Editar: 5000 → 7000; planes_pago.monto_total pasa a 12000, pero solicitud_json queda intacto
  await rpc('editar_abono', {
    p_cuenta_id: CUENTA,
    p_abono_id:  abonoId,
    p_monto:     7000,
  });

  // Reintento con payload ORIGINAL — debe usar el snapshot, no el estado mutable
  var r2 = await rpc('crear_plan_con_abonos', payload);
  assert.strictEqual(r2.idempotente, true,
    'PLAN.15: reintento con params originales debe reconocerse tras editar_abono');
  assert.strictEqual(r2.plan.id, r.plan.id, 'PLAN.15: debe devolver el mismo plan_id');

  // Revertir edición y limpiar
  await rpc('editar_abono', { p_cuenta_id: CUENTA, p_abono_id: abonoId, p_monto: 5000 });
  await rpc('eliminar_plan', { p_cuenta_id: CUENTA, p_plan_id: r.plan.id });
}

// ─── PLAN.16 Concurrencia: mismo plan_id con calendarios distintos ────────────
// La primera solicitud almacena el snapshot; la segunda (distinto calendario)
// debe fallar con idempotency_conflict.
async function testPlan16() {
  var planId   = uid('p16');
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
    'PLAN.16: el conflicto debe ser idempotency_conflict; recibido: ' + err[0].reason.message
  );

  await rpc('eliminar_plan', { p_cuenta_id: CUENTA, p_plan_id: planId });
}

// ─── PLAN.17 Respuesta perdida — reintento idempotente vía API ────────────────
// Primera llamada llega al servidor y crea el plan; la respuesta se "pierde"
// (error de red, timeout, recarga).  El cliente reintenta con el mismo planId
// (mismo p_plan_id) y el servidor devuelve idempotente=true sin duplicar.
async function testPlan17() {
  var payload = planPayload();
  var planId  = payload.p_plan_id;

  // Primera llamada — el servidor crea el plan; respuesta descartada
  void (await rpc('crear_plan_con_abonos', payload));

  // Reintento con el mismo planId
  var r2 = await rpc('crear_plan_con_abonos', payload);
  assert.strictEqual(r2.idempotente, true,
    'PLAN.17: reintento tras respuesta perdida debe devolver idempotente=true');
  assert.strictEqual(r2.plan.id, planId, 'PLAN.17: debe ser el mismo plan');
  assert.ok(Array.isArray(r2.abonos) && r2.abonos.length === 2,
    'PLAN.17: debe devolver los 2 abonos originales');

  // No deben existir planes duplicados
  var planes = await GET(
    '/rest/v1/planes_pago?cuenta_id=eq.' + CUENTA +
    '&alumno_id=eq.' + ALUMNO_ID + '&cuota_id=eq.' + CUOTA_ID + '&select=id'
  );
  assert.strictEqual(planes.length, 1, 'PLAN.17: no deben existir planes duplicados');

  await rpc('eliminar_plan', { p_cuenta_id: CUENTA, p_plan_id: planId });
}

// ─── PLAN.17b Respuesta perdida desde guardarPlanPago() ──────────────────────
// Simula el flujo completo de guardarPlanPago():
//  1. Formulario genera planId y lo persiste junto al payloadHash.
//  2. La petición llega al servidor pero la respuesta se pierde.
//  3. El usuario reabre el formulario con el mismo payload.
//  4. guardarPlanPago() detecta que el hash coincide y reutiliza el planId.
//  5. El servidor reconoce el reintento como idempotente.
//
// La simulación usa variables locales en lugar de sessionStorage.
// El comportamiento que se verifica es del servidor; el cliente sólo aporta
// que el planId persiste y se reutiliza correctamente cuando el hash no cambió.
async function testPlan17b() {
  var cuentaId    = CUENTA;
  var alumnoId    = ALUMNO_ID;
  var cuotaId     = CUOTA_ID;
  var periodo     = 'Marzo 2026';
  var abonos      = [{ monto: 5000, fecha: '2026-03-01' }, { monto: 5000, fecha: '2026-04-01' }];
  var totalAbonos = 10000;

  // Paso 1: guardarPlanPago() genera planId y calcula payloadHash
  var pendingKey   = 'pp_pending_' + cuentaId + '_' + alumnoId + '_' + cuotaId + '_' + periodo;
  var payloadHash  = JSON.stringify({ totalAbonos: totalAbonos, abonos: abonos });
  var planId       = uid('form');
  var sessionStore = {};
  sessionStore[pendingKey] = { planId: planId, payloadHash: payloadHash };

  // Paso 2: petición enviada — respuesta "perdida" (sessionStore no se limpia)
  await rpc('crear_plan_con_abonos', {
    p_cuenta_id:   cuentaId,
    p_plan_id:     planId,
    p_alumno_id:   alumnoId,
    p_cuota_id:    cuotaId,
    p_periodo:     periodo,
    p_monto_total: totalAbonos,
    p_abonos:      abonos,
  });
  // La entrada persiste — simula que la respuesta nunca llegó al cliente
  assert.ok(sessionStore[pendingKey], 'sessionStore debe mantener la entrada tras respuesta perdida');

  // Paso 3: usuario reabre formulario con el MISMO payload
  var stored           = sessionStore[pendingKey];
  var newPayloadHash   = JSON.stringify({ totalAbonos: totalAbonos, abonos: abonos });
  // guardarPlanPago() detecta hash idéntico: reutiliza planId
  assert.strictEqual(stored.payloadHash, newPayloadHash, 'hash debe coincidir: mismo payload');
  var retryPlanId = stored.planId;
  assert.strictEqual(retryPlanId, planId, 'planId reutilizado debe coincidir con el original');

  // Paso 4: reintento — servidor reconoce idempotencia
  var r2 = await rpc('crear_plan_con_abonos', {
    p_cuenta_id:   cuentaId,
    p_plan_id:     retryPlanId,
    p_alumno_id:   alumnoId,
    p_cuota_id:    cuotaId,
    p_periodo:     periodo,
    p_monto_total: totalAbonos,
    p_abonos:      abonos,
  });
  assert.strictEqual(r2.idempotente, true,
    'PLAN.17b: reintento via handler debe ser idempotente');
  assert.strictEqual(r2.plan.id, planId,
    'PLAN.17b: debe devolver el mismo plan');

  // Paso 5: éxito confirmado — sessionStorage se limpia
  delete sessionStore[pendingKey];
  assert.strictEqual(sessionStore[pendingKey], undefined,
    'sessionStore debe limpiarse tras confirmación del servidor');

  // Sin planes duplicados
  var planes = await GET(
    '/rest/v1/planes_pago?cuenta_id=eq.' + CUENTA +
    '&alumno_id=eq.' + ALUMNO_ID + '&cuota_id=eq.' + CUOTA_ID + '&select=id'
  );
  assert.strictEqual(planes.length, 1, 'PLAN.17b: no deben existir planes duplicados');

  await rpc('eliminar_plan', { p_cuenta_id: CUENTA, p_plan_id: planId });
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
      // No ejecutar tests si setup falló; teardown se encarga de lo que se creó
      failed++;
    } else {
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
      await run('PLAN.15 reintento tras editar_abono (snapshot)',         testPlan15);
      await run('PLAN.16 mismo plan_id calendarios distintos',            testPlan16);
      await run('PLAN.17 respuesta perdida → reintento idempotente (API)', testPlan17);
      await run('PLAN.17b respuesta perdida → guardarPlanPago() handler', testPlan17b);

      console.log('\n  [SEC] Seguridad de idempotencia (SECURITY DEFINER)');
      await run('SEC.1  usuario real sin acceso al curso (cuenta B)',  testSec1);
      await run('SEC.2  calendario modificado rechazado',              testSec2);
      await run('SEC.3  alumno_id distinto rechazado',                 testSec3);

      console.log('\n  [SALDO] Resumen CC con importes exactos');
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
