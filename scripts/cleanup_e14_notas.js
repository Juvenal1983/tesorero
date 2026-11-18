/**
 * scripts/cleanup_e14_notas.js
 *
 * Inspección y limpieza de notas fixture E14 que quedaron huérfanas en staging
 * tras una corrida abortada (el test se detuvo antes de ejecutar su teardown).
 *
 * ── Uso ───────────────────────────────────────────────────────────────────────
 *  Limpiar TODAS las notas E14 de una corrida específica:
 *    node scripts/cleanup_e14_notas.js <EXEC_ID>
 *
 *  Limpiar TODAS las notas E14 de cualquier corrida (prefijo E14-):
 *    node scripts/cleanup_e14_notas.js
 *
 * ── Qué hace ──────────────────────────────────────────────────────────────────
 *  1. Inspección: GET para contar notas con el prefijo indicado en la cuenta.
 *  2. Elimina SOLO notas de esa cuenta y ese prefijo (nunca toca notas ajenas).
 *  3. Verifica la eliminación con GET HTTP 200 + array vacío.
 *
 * Producción excluida.
 */

'use strict';

const https = require('https');
const path  = require('path');

try { require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') }); } catch (_) {}

// ── Config ─────────────────────────────────────────────────────────────────────
const SUPA_URL_RAW = (process.env.STAGING_SUPABASE_URL || process.env.STAGING_URL || '').replace(/\/$/, '');
const ANON_KEY     = process.env.STAGING_SUPABASE_ANON_KEY || process.env.STAGING_KEY || '';
const USER_EMAIL   = process.env.STAGING_USER_A_EMAIL || process.env.STAGING_EMAIL || '';
const USER_PASS    = process.env.STAGING_USER_A_PASSWORD || process.env.STAGING_PASS || '';

if (!SUPA_URL_RAW || !ANON_KEY || !USER_EMAIL || !USER_PASS) {
  console.error('❌  Faltan variables de entorno. Revisa .env.');
  process.exit(1);
}

// ── Guardia de producción ──────────────────────────────────────────────────────
const PROD_HOST    = 'tmjqzaakzhecbldebyeg.supabase.co';
const STAGING_HOST = 'rucgmytyxpfowznowxwd.supabase.co';

let parsedHost;
try { parsedHost = new URL(SUPA_URL_RAW).hostname; } catch (_) {
  console.error('❌  URL inválida:', SUPA_URL_RAW); process.exit(2);
}
if (parsedHost === PROD_HOST) {
  console.error('🚫  PRODUCCIÓN BLOQUEADA. Usa el host de staging.'); process.exit(2);
}
if (parsedHost !== STAGING_HOST) {
  console.error('⚠️   Host no reconocido:', parsedHost, '— se esperaba', STAGING_HOST); process.exit(2);
}

const SUPA_URL = SUPA_URL_RAW;

// ── EXEC_ID del argumento (opcional) ──────────────────────────────────────────
// Con EXEC_ID: limpia solo notas de esa corrida (prefijo exacto "E14-{EXEC_ID}-")
// Sin EXEC_ID: limpia TODAS las notas E14 de la cuenta (prefijo "E14-")
const EXEC_ID_ARG = process.argv[2] || null;
const LIKE_PATTERN = EXEC_ID_ARG
  ? `E14-${EXEC_ID_ARG}-%`
  : `E14-%`;

// ── HTTP helper ─────────────────────────────────────────────────────────────────
function req(urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const url  = new URL(SUPA_URL + urlPath);
    const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const hdrs = {
      'apikey':        ANON_KEY,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
      'Prefer':        'return=representation',
      ...(opts.headers || {}),
    };
    if (opts.jwt) hdrs['Authorization'] = 'Bearer ' + opts.jwt;
    if (body) hdrs['Content-Length'] = String(Buffer.byteLength(body));
    const r = https.request(
      { hostname: url.hostname, path: url.pathname + url.search,
        method: opts.method || 'GET', headers: hdrs },
      res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          let parsed; try { parsed = JSON.parse(data); } catch (_) { parsed = data; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

// ── Main ───────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n══════════════════════════════════════════════════');
  console.log(' cleanup_e14_notas.js — staging:', STAGING_HOST);
  if (EXEC_ID_ARG) console.log(' EXEC_ID:', EXEC_ID_ARG);
  console.log(' Patrón a limpiar:', LIKE_PATTERN);
  console.log('══════════════════════════════════════════════════\n');

  // 1. Login
  process.stdout.write('→ Login REST… ');
  const authR = await req('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email: USER_EMAIL, password: USER_PASS },
    headers: { Prefer: '' },
  });
  if (authR.status !== 200 || !authR.body?.access_token) {
    console.error('❌  Login falló:', JSON.stringify(authR.body).slice(0, 200));
    process.exit(1);
  }
  const jwt = authR.body.access_token;
  console.log('OK');

  // 2. Descubrir cuentaId
  process.stdout.write('→ Descubriendo cuentaId… ');
  let sub;
  try {
    const payload = jwt.split('.')[1];
    const padded  = payload + '='.repeat((4 - payload.length % 4) % 4);
    sub = JSON.parse(Buffer.from(padded, 'base64url').toString('utf8')).sub;
  } catch (_) { sub = null; }
  if (!sub) { console.error('❌  No se pudo extraer sub del JWT'); process.exit(1); }

  const cuentaR = await req(
    `/rest/v1/tesorero_cuentas?auth_id=eq.${encodeURIComponent(sub)}&select=id&limit=1`,
    { jwt }
  );
  if (cuentaR.status !== 200 || !Array.isArray(cuentaR.body) || !cuentaR.body.length) {
    console.error('❌  No se encontró cuenta:', JSON.stringify(cuentaR.body).slice(0, 200));
    process.exit(1);
  }
  const cuentaId = cuentaR.body[0].id;
  console.log('OK —', cuentaId);

  // 3. Inspección: contar notas con el prefijo
  const pattern  = encodeURIComponent(LIKE_PATTERN);
  const cuentaEnc = encodeURIComponent(cuentaId);

  process.stdout.write(`→ Inspeccionando notas "${LIKE_PATTERN}"… `);
  const inspR = await req(
    `/rest/v1/notas?cuenta_id=eq.${cuentaEnc}&texto=like.${pattern}&select=id,texto&order=texto.asc`,
    { jwt, headers: { Prefer: 'count=exact' } }
  );
  if (inspR.status !== 200) {
    console.error('❌  GET inspección falló (HTTP', inspR.status + '):', JSON.stringify(inspR.body).slice(0, 200));
    process.exit(1);
  }
  const notas = Array.isArray(inspR.body) ? inspR.body : [];
  console.log(`${notas.length} notas encontradas`);

  if (notas.length === 0) {
    console.log('\n✅  No hay notas huérfanas con ese patrón. Nada que limpiar.');
    process.exit(0);
  }

  // Muestra de primeras y últimas 3
  const muestra = [...notas.slice(0, 3), ...(notas.length > 6 ? notas.slice(-3) : notas.slice(3))];
  console.log('   Muestra (texto):',
    muestra.map(n => n.texto).join(' | ') +
    (notas.length > 6 ? ` … (${notas.length - 6} más)` : '')
  );

  // 4. DELETE — limitado a cuenta + prefijo exacto (nunca toca otras cuentas ni notas)
  process.stdout.write(`→ Eliminando ${notas.length} notas (DELETE)… `);
  const delR = await req(
    `/rest/v1/notas?cuenta_id=eq.${cuentaEnc}&texto=like.${pattern}`,
    { method: 'DELETE', jwt, headers: { Prefer: 'return=minimal' } }
  );
  if (delR.status !== 200 && delR.status !== 204) {
    console.error('❌  DELETE falló (HTTP', delR.status + '):', JSON.stringify(delR.body).slice(0, 200));
    process.exit(1);
  }
  console.log('OK (HTTP', delR.status + ')');

  // 5. Verificación: GET HTTP 200 con array vacío
  process.stdout.write('→ Verificando ausencia (GET)… ');
  const verR = await req(
    `/rest/v1/notas?cuenta_id=eq.${cuentaEnc}&texto=like.${pattern}&select=id`,
    { jwt }
  );
  if (verR.status !== 200) {
    console.error('❌  GET verificación falló (HTTP', verR.status + ')');
    process.exit(1);
  }
  const quedaron = Array.isArray(verR.body) ? verR.body.length : -1;
  if (quedaron !== 0) {
    console.error(`❌  Todavía quedan ${quedaron} notas tras el DELETE.`);
    process.exit(1);
  }
  console.log('OK — array vacío ✓');

  console.log(`\n✅  Limpieza completa. ${notas.length} notas eliminadas.\n`);
  process.exit(0);
})();
