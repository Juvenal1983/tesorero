/**
 * scripts/cleanup_e14_notas.js
 *
 * Inspección y limpieza de notas fixture E14 que quedaron huérfanas en staging
 * tras una corrida abortada (el test se detuvo antes de ejecutar su teardown).
 *
 * ── Uso ───────────────────────────────────────────────────────────────────────
 *  Corrida específica (prefijo exacto "E14-{EXEC_ID}-"):
 *    node scripts/cleanup_e14_notas.js <EXEC_ID>
 *
 *  Ejemplo — corrida pendiente mwma9888:
 *    node scripts/cleanup_e14_notas.js mwma9888
 *
 *  Sin argumento: todas las notas "E14-" de la cuenta (cualquier corrida):
 *    node scripts/cleanup_e14_notas.js
 *
 * ── Qué hace ──────────────────────────────────────────────────────────────────
 *  1. Inspección paginada: GET en páginas de 1000 hasta recibir HTTP 200 (fin).
 *     PostgREST devuelve 206 Partial Content mientras haya más registros;
 *     aceptar solo la primera respuesta dejaría un conteo incompleto.
 *  2. DELETE — una sola llamada (PostgREST borra todos los registros del filtro).
 *     Limitado a la cuenta y prefijo del argumento; nunca toca notas ajenas.
 *  3. Verificación: exige HTTP 200 con array vacío (0 filas = sin paginación = 200).
 *
 * Producción excluida (guard exclusivo de staging).
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

// ── Guard exclusivo de staging ─────────────────────────────────────────────────
const PROD_HOST    = 'tmjqzaakzhecbldebyeg.supabase.co';
const STAGING_HOST = 'rucgmytyxpfowznowxwd.supabase.co';

let parsedHost;
try { parsedHost = new URL(SUPA_URL_RAW).hostname; } catch (_) {
  console.error('❌  URL inválida:', SUPA_URL_RAW); process.exit(2);
}
if (parsedHost === PROD_HOST) {
  console.error('🚫  PRODUCCIÓN BLOQUEADA. Este script opera solo en staging.'); process.exit(2);
}
if (parsedHost !== STAGING_HOST) {
  console.error('⚠️   Host no reconocido:', parsedHost, '— se esperaba', STAGING_HOST); process.exit(2);
}

const SUPA_URL = SUPA_URL_RAW;

// ── EXEC_ID del argumento ──────────────────────────────────────────────────────
const EXEC_ID_ARG   = process.argv[2] || null;
const LIKE_PATTERN  = EXEC_ID_ARG ? `E14-${EXEC_ID_ARG}-%` : `E14-%`;

// ── HTTP helper — devuelve status, headers y body ─────────────────────────────
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
    if (opts.jwt)   hdrs['Authorization'] = 'Bearer ' + opts.jwt;
    if (body)       hdrs['Content-Length'] = String(Buffer.byteLength(body));
    const r = https.request(
      { hostname: url.hostname, path: url.pathname + url.search,
        method: opts.method || 'GET', headers: hdrs },
      res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          let parsed; try { parsed = JSON.parse(data); } catch (_) { parsed = data; }
          // Preservar headers en minúsculas para acceso uniforme
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      }
    );
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

/**
 * Parsea el header Content-Range de PostgREST.
 * Formato: "items <first>-<last>/<total|*>"
 * Devuelve { first, last, total } donde total puede ser null si es "*".
 */
function parseContentRange(header) {
  if (!header) return null;
  const m = header.match(/^items\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!m) return null;
  return {
    first: parseInt(m[1], 10),
    last:  parseInt(m[2], 10),
    total: m[3] === '*' ? null : parseInt(m[3], 10),
  };
}

/**
 * Paginación completa de un endpoint PostgREST con Prefer: count=exact.
 *
 * Estrategia robusta (tres condiciones independientes de parada):
 *   1. Content-Range confirma que se alcanzó el total declarado.
 *   2. La página devuelta tiene 0 filas (fin de datos sin total declarado).
 *   3. El acumulado ya supera el total del Content-Range (protección extra).
 *
 * No termina solo por HTTP 200: algunos proxies normalizan 206→200;
 * el criterio definitivo es el contenido de la página y el Content-Range.
 *
 * Valida que cada respuesta sea un array; lanza si no lo es.
 *
 * @param {string} jwt         Bearer token
 * @param {string} basePath    Ruta REST con filtros pero SIN limit/offset
 * @param {number} [page=1000] Tamaño de página (≤ límite de PostgREST)
 * @returns {Promise<{rows: Array, total: number|null}>}
 */
async function fetchAll(jwt, basePath, page = 1000) {
  const all = [];
  let offset = 0;
  let declaredTotal = null;   // total del Content-Range, null si desconocido

  const sep = basePath.includes('?') ? '&' : '?';

  while (true) {
    const r = await req(
      `${basePath}${sep}limit=${page}&offset=${offset}`,
      {
        jwt,
        // Prefer count=exact pide a PostgREST que incluya el total en Content-Range
        headers: { 'Prefer': 'count=exact' },
      }
    );

    if (r.status !== 200 && r.status !== 206) {
      throw new Error(
        `fetchAll: HTTP ${r.status} en offset ${offset} — ` +
        JSON.stringify(r.body).slice(0, 200)
      );
    }

    // Validar que sea array
    if (!Array.isArray(r.body)) {
      throw new Error(
        `fetchAll: respuesta no es array en offset ${offset} — ` +
        JSON.stringify(r.body).slice(0, 200)
      );
    }

    const rows = r.body;
    all.push(...rows);

    // Leer total declarado la primera vez (o cada vez, por si varía)
    const cr = parseContentRange(r.headers['content-range']);
    if (cr && cr.total !== null) declaredTotal = cr.total;

    // Condición 1: total confirmado por Content-Range alcanzado
    if (declaredTotal !== null && all.length >= declaredTotal) break;

    // Condición 2: página vacía → no hay más datos
    if (rows.length === 0) break;

    // Condición 3: página incompleta → era la última (sin Content-Range total)
    if (rows.length < page) break;

    offset += page;
  }

  return { rows: all, total: declaredTotal };
}

// ── Main ───────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n══════════════════════════════════════════════════════');
  console.log(' cleanup_e14_notas.js — staging:', STAGING_HOST);
  if (EXEC_ID_ARG)
    console.log(' EXEC_ID:', EXEC_ID_ARG);
  else
    console.log(' Sin EXEC_ID → limpia TODOS los E14- de la cuenta');
  console.log(' Prefijo exacto:', LIKE_PATTERN);
  console.log('══════════════════════════════════════════════════════\n');

  // ── 1. Login ────────────────────────────────────────────────────────────────
  process.stdout.write('→ Login REST… ');
  const authR = await req('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body:   { email: USER_EMAIL, password: USER_PASS },
    headers: { Prefer: '' },
  });
  if (authR.status !== 200 || !authR.body?.access_token) {
    console.error('❌  Login falló:', JSON.stringify(authR.body).slice(0, 200));
    process.exit(1);
  }
  const jwt = authR.body.access_token;
  console.log('OK');

  // ── 2. Descubrir cuentaId ───────────────────────────────────────────────────
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

  const pattern   = encodeURIComponent(LIKE_PATTERN);
  const cuentaEnc = encodeURIComponent(cuentaId);
  // order=texto.asc garantiza orden estable entre páginas (sin orden el cursor es inconsistente)
  const baseGET   = `/rest/v1/notas?cuenta_id=eq.${cuentaEnc}&texto=like.${pattern}&select=id,texto&order=texto.asc`;

  // ── 3. Inspección paginada ──────────────────────────────────────────────────
  // Con Prefer: count=exact PostgREST incluye el total en Content-Range.
  // fetchAll pagina hasta que el acumulado alcance ese total o la página quede vacía.
  process.stdout.write(`→ Inspeccionando (paginado) "${LIKE_PATTERN}"… `);
  let notas, declaredTotal;
  try {
    ({ rows: notas, total: declaredTotal } = await fetchAll(jwt, baseGET));
  } catch (e) {
    console.error('❌ ', e.message); process.exit(1);
  }
  console.log(`${notas.length} notas obtenidas` +
    (declaredTotal !== null ? ` (total declarado: ${declaredTotal})` : ' (total no declarado)'));

  // Verificar coherencia: lo que obtuvimos debe coincidir con el total declarado
  if (declaredTotal !== null && notas.length !== declaredTotal) {
    console.error(`❌  Discrepancia: obtuvimos ${notas.length} pero Content-Range declaró ${declaredTotal}`);
    process.exit(1);
  }

  if (notas.length === 0) {
    console.log('\n✅  No hay notas huérfanas con ese prefijo. Nada que limpiar.');
    process.exit(0);
  }

  // Muestra de primeras y últimas 3
  const cabeza = notas.slice(0, 3);
  const cola   = notas.length > 3 ? notas.slice(-3) : [];
  const linea  = [...cabeza, ...(cola.length ? ['…'] : []), ...cola]
    .map(n => typeof n === 'string' ? n : n.texto)
    .join(' | ');
  console.log('   Muestra:', linea);

  // ── 4. DELETE ───────────────────────────────────────────────────────────────
  // PostgREST borra todos los registros que coinciden con el filtro en una sola
  // llamada (sin paginación, independientemente del volumen).
  process.stdout.write(`\n→ Eliminando ${notas.length} notas (DELETE)… `);
  const delR = await req(
    `/rest/v1/notas?cuenta_id=eq.${cuentaEnc}&texto=like.${pattern}`,
    { method: 'DELETE', jwt, headers: { Prefer: 'return=minimal' } }
  );
  if (delR.status !== 200 && delR.status !== 204) {
    console.error('❌  DELETE falló (HTTP', delR.status + '):', JSON.stringify(delR.body).slice(0, 200));
    process.exit(1);
  }
  console.log('OK (HTTP', delR.status + ')');

  // ── 5. Verificación: exige HTTP 200 + array vacío ──────────────────────────
  // Con 0 filas PostgREST devuelve 200 (no 206). Si devuelve 206 es un fallo.
  process.stdout.write('→ Verificando ausencia (GET exige HTTP 200 + [])… ');
  const verR = await req(
    `/rest/v1/notas?cuenta_id=eq.${cuentaEnc}&texto=like.${pattern}&select=id`,
    { jwt, headers: { Prefer: 'return=representation' } }
  );
  if (verR.status !== 200) {
    console.error(`❌  Verificación falló: esperaba HTTP 200, got ${verR.status}`);
    if (verR.status === 206)
      console.error('    206 Partial — aún quedan registros; el DELETE no eliminó todo.');
    process.exit(1);
  }
  const quedaron = Array.isArray(verR.body) ? verR.body.length : -1;
  if (quedaron !== 0) {
    console.error(`❌  Todavía quedan ${quedaron} notas tras el DELETE.`);
    process.exit(1);
  }
  console.log('HTTP 200 + [] ✓');

  console.log(`\n✅  Limpieza completa. ${notas.length} notas eliminadas de la cuenta ${cuentaId}.\n`);
  process.exit(0);
})();
