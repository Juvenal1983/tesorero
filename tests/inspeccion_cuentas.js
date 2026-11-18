/**
 * tests/inspeccion_cuentas.js
 *
 * Script de solo lectura. Lee el estado actual de las cuentas A y B en staging
 * y muestra si quedaron datos de prueba del run mwljbfsd.
 *
 * NO escribe ni modifica ningún dato.
 *
 * Uso:
 *   node tests/inspeccion_cuentas.js
 *
 * Variables de entorno requeridas (mismas que e11):
 *   STAGING_SUPABASE_URL / STAGING_URL
 *   STAGING_SUPABASE_ANON_KEY / STAGING_KEY
 *   STAGING_USER_A_EMAIL / STAGING_EMAIL
 *   STAGING_USER_A_PASSWORD / STAGING_PASS
 */

'use strict';

const path  = require('path');
const https = require('https');

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
const CUENTA_B = '00000000-0000-0000-bbbb-000000000002';

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

async function supaAuth(path, jwt, opts = {}) {
  return _fetch(path, { ...opts, auth: jwt });
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

async function leerCuenta(jwt, cuentaId) {
  const r = await supaAuth(
    `/rest/v1/tesorero_cuentas?id=eq.${cuentaId}&select=id,nombre`,
    jwt
  );
  return { status: r.status, fila: r.body?.[0] ?? null };
}

async function leerConfig(jwt, cuentaId) {
  const r = await supaAuth(
    `/rest/v1/config_cuenta?cuenta_id=eq.${cuentaId}&select=cuenta_id,plantilla_pago`,
    jwt
  );
  return { status: r.status, fila: r.body?.[0] ?? null };
}

async function listarTodasCuentas(jwt) {
  const r = await supaAuth(
    '/rest/v1/tesorero_cuentas?select=id,nombre&order=id.asc',
    jwt
  );
  return { status: r.status, filas: Array.isArray(r.body) ? r.body : [] };
}

(async () => {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  Inspección cuentas staging (solo lectura)');
  console.log('══════════════════════════════════════════════════════════════\n');

  let jwt;
  try {
    jwt = await login();
    console.log('  Login OK\n');
  } catch (e) {
    console.error('❌ Login fallido:', e.message); process.exit(1);
  }

  // 1. Todas las cuentas accesibles con este JWT
  const todas = await listarTodasCuentas(jwt);
  console.log(`[Cuentas accesibles con este JWT] HTTP ${todas.status}`);
  if (Array.isArray(todas.filas) && todas.filas.length > 0) {
    todas.filas.forEach(f => console.log(`  ${f.id}  "${f.nombre}"`));
  } else {
    console.log('  (ninguna)');
  }

  // 2. Estado cuenta A
  console.log('\n[Cuenta A — aaaa...0001]');
  const ca = await leerCuenta(jwt, CUENTA_A);
  if (ca.fila) {
    console.log(`  nombre    : "${ca.fila.nombre}"`);
    const limpio = !ca.fila.nombre.startsWith('Test-');
    console.log(`  ¿limpia?  : ${limpio ? '✅ sí' : '❌ contiene datos de prueba'}`);
  } else {
    console.log(`  HTTP ${ca.status} — fila no encontrada o sin acceso`);
  }
  const cfgA = await leerConfig(jwt, CUENTA_A);
  if (cfgA.fila) {
    const plantA = cfgA.fila.plantilla_pago;
    const limploP = !plantA || !plantA.startsWith('Test-');
    console.log(`  plantilla : ${plantA === null ? 'NULL' : '"' + plantA + '"'}`);
    console.log(`  ¿limpia?  : ${limploP ? '✅ sí' : '❌ contiene datos de prueba'}`);
  } else {
    console.log(`  config HTTP ${cfgA.status} — ${JSON.stringify(cfgA.fila)}`);
  }

  // 3. Estado cuenta B
  console.log('\n[Cuenta B — bbbb...0002]');
  const cb = await leerCuenta(jwt, CUENTA_B);
  if (cb.fila) {
    console.log(`  nombre    : "${cb.fila.nombre}"`);
    const limpio = !cb.fila.nombre.startsWith('Test-');
    console.log(`  ¿limpia?  : ${limpio ? '✅ sí' : '❌ contiene datos de prueba'}`);
  } else {
    console.log(`  HTTP ${cb.status} — fila no encontrada o sin acceso`);
  }
  const cfgB = await leerConfig(jwt, CUENTA_B);
  if (cfgB.fila) {
    const plantB = cfgB.fila.plantilla_pago;
    const limploP = !plantB || !plantB.startsWith('Test-');
    console.log(`  plantilla : ${plantB === null ? 'NULL' : '"' + plantB + '"'}`);
    console.log(`  ¿limpia?  : ${limploP ? '✅ sí' : '❌ contiene datos de prueba'}`);
  } else {
    console.log(`  config HTTP ${cfgB.status} — ${JSON.stringify(cfgB.fila)}`);
  }

  // 4. Resumen
  const nombreA = ca.fila?.nombre ?? '';
  const plantA  = cfgA.fila?.plantilla_pago ?? null;
  const nombreB = cb.fila?.nombre ?? '';

  const sucioA = nombreA.startsWith('Test-') || (typeof plantA === 'string' && plantA.startsWith('Test-'));
  const sucioB = nombreB.startsWith('Test-') || (typeof cfgB.fila?.plantilla_pago === 'string' && cfgB.fila.plantilla_pago.startsWith('Test-'));

  console.log('\n[Resumen]');
  if (!sucioA && !sucioB) {
    console.log('  ✅ Ambas cuentas limpias — no requieren restauración.');
  } else {
    if (sucioA) {
      console.log('  ⚠️  Cuenta A tiene datos de prueba:');
      if (nombreA.startsWith('Test-'))
        console.log(`       nombre actual    : "${nombreA}"`);
      if (typeof plantA === 'string' && plantA.startsWith('Test-'))
        console.log(`       plantilla actual : "${plantA}"`);
      console.log('       nombre esperado  : "Colegio Esperanza (Staging A)"');
      console.log('       plantilla esp.   : NULL  (o "" si así estaba antes del run mwlj6hkl)');
      console.log('\n  Para restaurar cuenta A ejecuta:');
      console.log('    node tests/restaurar_cuenta_a.js');
    }
    if (sucioB) {
      console.log('  ⚠️  Cuenta B tiene datos de prueba.');
    }
  }
})();
