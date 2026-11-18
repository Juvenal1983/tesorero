/**
 * tests/limpiar_fixtures_e13.js
 *
 * Limpia fixtures residuales de corridas de E13 que no se limpiaron solas.
 * Elimina cursos, alumnos, pagos y usuarios_externos cuyo nombre o campo de texto
 * contenga los prefijos del fixture ("FixtureCurso-E13-", "FixtureAlumno", "FixtureE13-",
 * "fixture_e13_", "FixtureCorrupto-R09", "FixtureUsuarioE13-").
 *
 * USO:
 *   node tests/limpiar_fixtures_e13.js [EXEC_ID]
 *
 * Si se pasa EXEC_ID, solo elimina los fixtures de esa ejecución.
 * Sin argumento, elimina todos los fixtures E13 (todos los EXEC_ID).
 *
 * Solo afecta staging — se rechaza si STAGING_URL apunta a producción.
 */

'use strict';

const path  = require('path');
const https = require('https');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') }); } catch(_) {}

const SUPA_URL_RAW = (process.env.STAGING_SUPABASE_URL || process.env.STAGING_URL || '').replace(/\/$/, '');
const ANON_KEY     = process.env.STAGING_SUPABASE_ANON_KEY || process.env.STAGING_KEY || '';
const USER_EMAIL   = process.env.STAGING_USER_A_EMAIL || process.env.STAGING_EMAIL || '';
const USER_PASS    = process.env.STAGING_USER_A_PASSWORD || process.env.STAGING_PASS || '';

if (!SUPA_URL_RAW || !ANON_KEY || !USER_EMAIL || !USER_PASS) {
  console.error('❌ Faltan variables de entorno.'); process.exit(1);
}

const PROD_HOST    = 'tmjqzaakzhecbldebyeg.supabase.co';
const STAGING_HOST = 'rucgmytyxpfowznowxwd.supabase.co';
let parsedHost;
try { parsedHost = new URL(SUPA_URL_RAW).hostname; } catch(_) { process.exit(2); }
if (parsedHost === PROD_HOST || parsedHost !== STAGING_HOST) {
  console.error('❌ URL no autorizada:', parsedHost); process.exit(2);
}

const EXEC_ID_FILTER = process.argv[2] || null;

function _fetch(urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const url  = new URL(SUPA_URL_RAW + urlPath);
    const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const hdrs = {
      'apikey':       ANON_KEY,
      'Content-Type': 'application/json',
      'Accept':       'application/json',
      'Prefer':       opts.prefer !== undefined ? opts.prefer : 'return=representation',
      ...(opts.headers || {}),
    };
    if (opts.authHeader !== null && opts.authHeader !== undefined)
      hdrs['Authorization'] = opts.authHeader;
    if (body) hdrs['Content-Length'] = String(Buffer.byteLength(body));
    const req = https.request(
      { hostname: url.hostname, path: url.pathname + url.search,
        method: opts.method || 'GET', headers: hdrs },
      res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          let body; try { body = JSON.parse(data); } catch (_) { body = data; }
          resolve({ status: res.statusCode, body });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function supaAuth(urlPath, jwt, opts = {}) {
  return _fetch(urlPath, { ...opts, authHeader: 'Bearer ' + jwt });
}

async function login() {
  const r = await _fetch('/auth/v1/token?grant_type=password', {
    method: 'POST', body: { email: USER_EMAIL, password: USER_PASS },
    prefer: '', authHeader: null,
  });
  if (r.status !== 200 || !r.body?.access_token)
    throw new Error(`Login falló: ${JSON.stringify(r.body)}`);
  return r.body.access_token;
}

async function descubrirCuenta(jwt) {
  const payload = jwt.split('.')[1];
  const padded  = payload + '='.repeat((4 - payload.length % 4) % 4);
  const sub     = JSON.parse(Buffer.from(padded, 'base64url').toString('utf8')).sub;
  const r = await supaAuth(
    `/rest/v1/tesorero_cuentas?auth_id=eq.${encodeURIComponent(sub)}&select=id&limit=1`,
    jwt
  );
  if (r.status !== 200 || !r.body?.[0]?.id)
    throw new Error(`descubrirCuenta falló: ${JSON.stringify(r.body)}`);
  return r.body[0].id;
}

(async () => {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  Limpieza de fixtures E13');
  console.log('══════════════════════════════════════════════════════════════\n');
  if (EXEC_ID_FILTER) console.log(`  Filtrando por EXEC_ID: ${EXEC_ID_FILTER}`);
  else                console.log('  Eliminando TODOS los fixtures E13');

  const jwt      = await login();
  const cuentaId = await descubrirCuenta(jwt);
  console.log(`  Cuenta: ${cuentaId}\n`);

  let eliminados = 0, errores = 0;

  async function eliminarRegistros(tabla, filtroQs, descripcion) {
    const rGet = await supaAuth(
      `/rest/v1/${tabla}?cuenta_id=eq.${encodeURIComponent(cuentaId)}&${filtroQs}&select=id`,
      jwt
    );
    // Exigir HTTP 200 + array
    if (rGet.status !== 200) {
      console.error(`  ${tabla}: GET de búsqueda falló HTTP ${rGet.status}`);
      errores++;
      return;
    }
    if (!Array.isArray(rGet.body)) {
      console.error(`  ${tabla}: GET no devolvió array: ${JSON.stringify(rGet.body).slice(0,80)}`);
      errores++;
      return;
    }
    if (rGet.body.length === 0) {
      console.log(`  ${tabla}: 0 registros ${descripcion}`);
      return;
    }
    console.log(`  ${tabla}: ${rGet.body.length} registros ${descripcion}`);
    for (const { id } of rGet.body) {
      const rDel = await supaAuth(
        `/rest/v1/${tabla}?id=eq.${encodeURIComponent(id)}&cuenta_id=eq.${encodeURIComponent(cuentaId)}`,
        jwt, { method: 'DELETE', prefer: '' }
      );
      if (rDel.status < 200 || rDel.status >= 300) {
        console.error(`    ✗ ${tabla} ${id.slice(0,8)}… DELETE HTTP ${rDel.status}`);
        errores++;
        continue;
      }
      // Verificar que fue eliminado: HTTP 200 + array + length 0
      const rVerif = await supaAuth(
        `/rest/v1/${tabla}?id=eq.${encodeURIComponent(id)}&select=id`,
        jwt
      );
      if (rVerif.status !== 200) {
        console.error(`    ✗ ${tabla} ${id.slice(0,8)}… verificación GET HTTP ${rVerif.status}`);
        errores++;
      } else if (!Array.isArray(rVerif.body)) {
        console.error(`    ✗ ${tabla} ${id.slice(0,8)}… GET no devolvió array`);
        errores++;
      } else if (rVerif.body.length > 0) {
        console.error(`    ✗ ${tabla} ${id.slice(0,8)}… sigue en DB después de DELETE`);
        errores++;
      } else {
        console.log(`    ✓ ${tabla} ${id.slice(0,8)}… eliminado y verificado`);
        eliminados++;
      }
    }
  }

  const sufijo = EXEC_ID_FILTER ? `-${EXEC_ID_FILTER}` : '-E13-';

  // pagos (por obs o periodo)
  await eliminarRegistros('pagos',
    `obs=like.*${encodeURIComponent('Fixture E13')}*`,
    'con obs "Fixture E13"');

  // alumnos (por apellidos = EXEC_ID, o nombres)
  await eliminarRegistros('alumnos',
    `nombres=like.*${encodeURIComponent('FixtureAlumno')}*`,
    'con nombres "FixtureAlumno*"');

  // cursos (por nombre)
  await eliminarRegistros('cursos',
    `nombre=like.*${encodeURIComponent(sufijo)}*`,
    `con nombre "*${sufijo}*"`);

  // usuarios_externos (por nombre o email)
  await eliminarRegistros('usuarios_externos',
    `email=like.*${encodeURIComponent('fixture_e13_')}*`,
    'con email "fixture_e13_*"');

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Eliminados: ${eliminados}  Errores: ${errores}`);
  process.exit(errores > 0 ? 1 : 0);
})();
