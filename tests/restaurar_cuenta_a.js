/**
 * tests/restaurar_cuenta_a.js
 *
 * Restaura cuenta A a su estado conocido si tiene datos de prueba.
 * Solo escribe si los valores actuales empiezan con "Test-".
 * Muestra exactamente qué va a escribir y pide confirmación (Y/n).
 *
 * Valores objetivo:
 *   tesorero_cuentas.nombre  → "Colegio Esperanza (Staging A)"
 *   config_cuenta.plantilla_pago → "" (string vacío — valor previo a los runs de E11)
 *
 * Uso:
 *   node tests/restaurar_cuenta_a.js
 */

'use strict';

const path     = require('path');
const https    = require('https');
const readline = require('readline');

try { require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') }); } catch(_) {}

const SUPA_URL = (process.env.STAGING_SUPABASE_URL || process.env.STAGING_URL || '').replace(/\/$/, '');
const ANON_KEY = process.env.STAGING_SUPABASE_ANON_KEY || process.env.STAGING_KEY || '';
const EMAIL    = process.env.STAGING_USER_A_EMAIL || process.env.STAGING_EMAIL || '';
const PASS     = process.env.STAGING_USER_A_PASSWORD || process.env.STAGING_PASS || '';

const PROD_HOST = 'tmjqzaakzhecbldebyeg.supabase.co';
if (!SUPA_URL || !ANON_KEY || !EMAIL || !PASS) {
  console.error('❌ Faltan variables de entorno'); process.exit(1);
}
if (SUPA_URL.includes(PROD_HOST)) {
  console.error('🛑 PRODUCCIÓN DETECTADA — abortando'); process.exit(2);
}

const CUENTA_A = '00000000-0000-0000-aaaa-000000000001';
// Valores objetivo confirmados por el usuario
const NOMBRE_ESPERADO    = 'Colegio Esperanza (Staging A)';
const PLANTILLA_ESPERADA = '';   // string vacío — no NULL

function _fetch(urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const url  = new URL(SUPA_URL + urlPath);
    const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const hdrs = {
      'apikey': ANON_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Prefer': opts.prefer !== undefined ? opts.prefer : 'return=representation',
      ...(opts.headers || {}),
    };
    if (opts.auth) hdrs['Authorization'] = 'Bearer ' + opts.auth;
    const req = https.request(
      { hostname: url.hostname, path: url.pathname + url.search, method: opts.method || 'GET',
        headers: hdrs, rejectUnauthorized: false },
      res => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function supaAuth(urlPath, jwt, opts = {}) {
  return _fetch(urlPath, { ...opts, auth: jwt });
}

async function login() {
  const r = await _fetch('/auth/v1/token?grant_type=password', {
    method: 'POST', prefer: '',
    body: { email: EMAIL, password: PASS },
    headers: { 'apikey': ANON_KEY },
  });
  if (r.status !== 200 || !r.body?.access_token)
    throw new Error('Login fallido: ' + JSON.stringify(r.body));
  return r.body.access_token;
}

function preguntar(pregunta) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(pregunta, ans => { rl.close(); res(ans.trim()); }));
}

(async () => {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  Restaurar cuenta A — staging (solo si hay datos de prueba)');
  console.log('══════════════════════════════════════════════════════════════\n');

  let jwt;
  try { jwt = await login(); console.log('  Login OK'); }
  catch (e) { console.error('❌ Login fallido:', e.message); process.exit(1); }

  // Leer estado actual
  const rNombre = await supaAuth(
    `/rest/v1/tesorero_cuentas?id=eq.${CUENTA_A}&select=nombre`, jwt
  );
  const rPlant = await supaAuth(
    `/rest/v1/config_cuenta?cuenta_id=eq.${CUENTA_A}&select=plantilla_pago`, jwt
  );

  const nombreActual   = rNombre.body?.[0]?.nombre    ?? null;
  const plantillaActual = rPlant.body?.[0]?.plantilla_pago ?? null;

  console.log('\n[Estado actual cuenta A]');
  console.log(`  nombre    : ${nombreActual   === null ? 'NULL' : '"' + nombreActual   + '"'}`);
  console.log(`  plantilla : ${plantillaActual === null ? 'NULL' : '"' + plantillaActual + '"'}`);

  const necesitaNombre   = typeof nombreActual    === 'string' && nombreActual.startsWith('Test-');
  const necesitaPlantilla = typeof plantillaActual === 'string' && plantillaActual.startsWith('Test-');

  if (!necesitaNombre && !necesitaPlantilla) {
    console.log('\n  ✅ Cuenta A no tiene datos de prueba — sin acción necesaria.');
    process.exit(0);
  }

  console.log('\n[Cambios que se van a aplicar]');
  if (necesitaNombre)
    console.log(`  nombre    : "${nombreActual}" → "${NOMBRE_ESPERADO}"`);
  if (necesitaPlantilla)
    console.log(`  plantilla : "${plantillaActual}" → "${PLANTILLA_ESPERADA}"`);
  console.log(`  Tabla nombre    : tesorero_cuentas  id=eq.${CUENTA_A}`);
  console.log(`  Tabla plantilla : config_cuenta  cuenta_id=eq.${CUENTA_A}`);
  console.log(`  Staging: ${SUPA_URL}`);

  const resp = await preguntar('\n¿Confirmas la restauración? (Y/n) > ');
  if (resp.toLowerCase() !== 'y' && resp !== '') {
    console.log('  Cancelado.'); process.exit(0);
  }

  let ok = true;

  if (necesitaNombre) {
    const r = await supaAuth(
      `/rest/v1/tesorero_cuentas?id=eq.${CUENTA_A}`,
      jwt, { method: 'PATCH', prefer: '', body: { nombre: NOMBRE_ESPERADO } }
    );
    if (r.status < 200 || r.status >= 300) {
      console.error(`  ❌ PATCH nombre falló: HTTP ${r.status}`); ok = false;
    } else {
      // Verificar con GET
      const rGet = await supaAuth(
        `/rest/v1/tesorero_cuentas?id=eq.${CUENTA_A}&select=nombre`, jwt
      );
      const actual = rGet.body?.[0]?.nombre;
      if (actual === NOMBRE_ESPERADO) console.log(`  ✅ nombre restaurado → "${actual}"`);
      else { console.error(`  ❌ nombre GET ≠ esperado: "${actual}"`); ok = false; }
    }
  }

  if (necesitaPlantilla) {
    const r = await supaAuth(
      `/rest/v1/config_cuenta?cuenta_id=eq.${CUENTA_A}`,
      jwt, { method: 'PATCH', prefer: '', body: { plantilla_pago: PLANTILLA_ESPERADA } }
    );
    if (r.status < 200 || r.status >= 300) {
      console.error(`  ❌ PATCH plantilla falló: HTTP ${r.status}`); ok = false;
    } else {
      const rGet = await supaAuth(
        `/rest/v1/config_cuenta?cuenta_id=eq.${CUENTA_A}&select=plantilla_pago`, jwt
      );
      const actual = rGet.body?.[0]?.plantilla_pago;
      if (actual === PLANTILLA_ESPERADA) console.log(`  ✅ plantilla restaurada → "${actual}"`);
      else { console.error(`  ❌ plantilla GET ≠ esperado: "${actual}"`); ok = false; }
    }
  }

  process.exit(ok ? 0 : 1);
})();
