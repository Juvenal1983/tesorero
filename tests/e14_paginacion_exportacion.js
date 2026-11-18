/**
 * tests/e14_paginacion_exportacion.js
 *
 * Suite Playwright E14 — Paginación de exportarDatosCompletosV9
 *
 * Verifica que _v9FetchAll no trunca colecciones con > 1000 filas.
 *
 * Estrategia:
 *   - Inserta 1100 notas de prueba vía API directa (11 lotes de 100).
 *   - Dispara la exportación UI en staging.
 *   - Verifica que el JSON descargado contiene las 1100 notas (IDs exactos),
 *     incluidos los registros al cruzar el límite de página (posiciones 999,
 *     1000, 1001 dentro de los insertados).
 *   - Limpia via DELETE con filtro de texto.
 *   - Producción excluida.
 *
 * Tests:
 *   P01  Servidor local levantado y staging alcanzable
 *   P02  Login REST + cuenta descubierta
 *   P03  1100 notas fixture insertadas (11 lotes × 100)
 *   P04  Exportación UI → JSON descargado
 *   P05  Notas en backup ≥ 1100
 *   P06  ID del registro 0 (primera página) presente en backup
 *   P07  ID del registro 999 (último de pág. 1) presente en backup
 *   P08  ID del registro 1000 (primero de pág. 2) presente en backup
 *   P09  ID del registro 1099 (último insertado) presente en backup
 *   P10  Limpieza: notas E14 eliminadas (GET vacío tras DELETE)
 */

'use strict';

const path   = require('path');
const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const crypto = require('crypto');
const { chromium } = require('playwright');

try { require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') }); } catch(_) {}

const SUPA_URL_RAW = (process.env.STAGING_SUPABASE_URL || process.env.STAGING_URL || '').replace(/\/$/, '');
const ANON_KEY     = process.env.STAGING_SUPABASE_ANON_KEY || process.env.STAGING_KEY || '';
const USER_EMAIL   = process.env.STAGING_USER_A_EMAIL || process.env.STAGING_EMAIL || '';
const USER_PASS    = process.env.STAGING_USER_A_PASSWORD || process.env.STAGING_PASS || '';

if (!SUPA_URL_RAW || !ANON_KEY || !USER_EMAIL || !USER_PASS) {
  console.error('❌ Faltan variables de entorno. Revisa .env.');
  process.exit(1);
}

const PROD_HOST    = 'tmjqzaakzhecbldebyeg.supabase.co';
const STAGING_HOST = 'rucgmytyxpfowznowxwd.supabase.co';
const SUPA_URL     = SUPA_URL_RAW;
let parsedHost;
try { parsedHost = new URL(SUPA_URL).hostname; } catch(_) { process.exit(2); }
if (parsedHost === PROD_HOST || parsedHost !== STAGING_HOST) {
  console.error('❌ URL no autorizada:', parsedHost);
  process.exit(2);
}

const EXEC_ID  = Date.now().toString(36);
const APP_PORT = 8803;
const N_NOTAS  = 1100;   // debe superar 1000 (el límite de PostgREST por página)
const LOTE     = 100;

let pass = 0, fail = 0, blocked = 0;
const failures    = [];
const blockedList = [];

function ok(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else       { console.error(`  ❌ ${label}`); fail++; failures.push(label); }
}
function skip(label, razon) {
  console.log(`  ⏭  ${label} [bloqueado: ${razon}]`);
  blocked++;
  blockedList.push(`${label} (${razon})`);
}
function nota(label, detalle) {
  console.log(`  📝 ${label}${detalle ? ': ' + detalle : ''}`);
}

const T_CORTO = 12_000;
const T_LARGO = 90_000;   // exportar ~1100 filas puede tardar más

// ── HTTP helpers ───────────────────────────────────────────────────────────────

function _fetch(urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const url  = new URL(SUPA_URL + urlPath);
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
          let parsed; try { parsed = JSON.parse(data); } catch (_) { parsed = data; }
          resolve({ status: res.statusCode, body: parsed });
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

// ── Servidor HTTP local ────────────────────────────────────────────────────────

function servirApp() {
  const MIME = {
    '.html':'text/html', '.css':'text/css', '.js':'application/javascript',
    '.json':'application/json', '.png':'image/png', '.ico':'image/x-icon',
    '.svg':'image/svg+xml', '.woff2':'font/woff2', '.woff':'font/woff',
  };
  const APP_DIR = path.resolve(__dirname, '..');
  const server  = http.createServer((req, res) => {
    let filePath = path.join(APP_DIR, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory())
      filePath = path.join(APP_DIR, 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      const ext  = path.extname(filePath).toLowerCase();
      const mime = MIME[ext] || 'application/octet-stream';
      let content = data;
      if (filePath.endsWith('index.html')) {
        let html = data.toString('utf8');
        html = html.replace(/https:\/\/STAGING_SUPA_HOST/g, `https://${STAGING_HOST}`);
        html = html.replace(/wss:\/\/STAGING_SUPA_HOST/g,   `wss://${STAGING_HOST}`);
        const envScript = `<script>
window.STAGING_SUPA_URL = ${JSON.stringify(SUPA_URL)};
window.STAGING_SUPA_KEY = ${JSON.stringify(ANON_KEY)};
</script>`;
        html = html.replace('<head>', '<head>' + envScript);
        content = Buffer.from(html, 'utf8');
      }
      res.writeHead(200, { 'Content-Type': mime });
      res.end(content);
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(APP_PORT, '127.0.0.1', () => {
      console.log(`  Servidor app: http://localhost:${APP_PORT}`);
      resolve(server);
    });
    server.on('error', reject);
  });
}

// ── Login REST ────────────────────────────────────────────────────────────────

async function loginTesorero() {
  const r = await _fetch('/auth/v1/token?grant_type=password', {
    method: 'POST', body: { email: USER_EMAIL, password: USER_PASS },
    prefer: '', authHeader: null,
  });
  if (r.status !== 200 || !r.body?.access_token)
    throw new Error(`Login REST fallido: ${JSON.stringify(r.body)}`);
  return r.body.access_token;
}

function jwtSub(token) {
  try {
    const payload = token.split('.')[1];
    const padded  = payload + '='.repeat((4 - payload.length % 4) % 4);
    return JSON.parse(Buffer.from(padded, 'base64url').toString('utf8')).sub || null;
  } catch { return null; }
}

async function descubrirCuenta(jwt) {
  const sub = jwtSub(jwt);
  if (!sub) throw new Error('descubrirCuenta: no se pudo extraer sub del JWT');
  const r = await supaAuth(
    `/rest/v1/tesorero_cuentas?auth_id=eq.${encodeURIComponent(sub)}&select=id&limit=1`, jwt
  );
  if (r.status !== 200 || !Array.isArray(r.body) || r.body.length === 0)
    throw new Error(`descubrirCuenta: auth_id=${sub} → ${JSON.stringify(r.body)}`);
  return r.body[0].id;
}

// ── Helpers Playwright ─────────────────────────────────────────────────────────

async function waitAppReady(page) {
  await page.waitForFunction(() => typeof window.S !== 'undefined', { timeout: T_LARGO });
}

// loginUI — controles reales, mismos selectores validados en E12/E13.
// Verifica que S._v9CuentaId (UI) coincida con cuentaId descubierto por REST.
async function loginUI(page, cuentaId) {
  const APP_URL = `http://localhost:${APP_PORT}`;
  await page.goto(APP_URL);
  await waitAppReady(page);
  await page.fill('#l-email', USER_EMAIL);
  await page.fill('#l-pass',  USER_PASS);
  await page.click('[onclick="doLogin()"]');
  await page.waitForFunction(
    () => window.S?.session !== null
       && window.S?.session !== undefined
       && !!window.S?._v9CuentaId,
    { timeout: T_LARGO }
  );
  const cuentaUI = await page.evaluate(() => window.S?._v9CuentaId ?? null);
  if (cuentaUI !== cuentaId)
    throw new Error(`_v9CuentaId UI (${cuentaUI}) ≠ REST (${cuentaId})`);
}

async function navegarRespaldos(page) {
  await page.evaluate(() => { if (typeof go === 'function') go('respaldos'); });
  await page.waitForFunction(() => window.S?.route === 'respaldos', { timeout: T_CORTO });
}

// ── Inserción masiva de notas fixture ─────────────────────────────────────────

/**
 * Inserta N_NOTAS notas en lotes de LOTE. Las notas usan IDs UUID estándar
 * y texto `E14-${EXEC_ID}-{i}` para identificarlas en cleanup.
 * Devuelve array de IDs en orden de inserción.
 */
async function insertarNotasFixture(jwt, cuentaId) {
  const ids = Array.from({ length: N_NOTAS }, () => crypto.randomUUID());

  for (let i = 0; i < N_NOTAS; i += LOTE) {
    const lote = ids.slice(i, i + LOTE).map((id, j) => ({
      id,
      cuenta_id: cuentaId,
      texto:     `E14-${EXEC_ID}-${String(i + j).padStart(4, '0')}`,
      color:     '#FFF9C4',
      fijada:    false,
      privada:   true,
    }));
    const r = await supaAuth('/rest/v1/notas', jwt, {
      method: 'POST',
      prefer: 'return=minimal',
      body: lote,
    });
    if (r.status < 200 || r.status > 299)
      throw new Error(`insertarNotasFixture lote ${i}: HTTP ${r.status} — ${JSON.stringify(r.body).slice(0, 200)}`);
  }

  return ids;  // ids[0] = primera, ids[999] = límite pág 1, ids[1000] = inicio pág 2
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

async function limpiarNotasFixture(jwt, cuentaId) {
  // Elimina todas las notas del EXEC_ID con un único DELETE por filtro de texto.
  const prefix = encodeURIComponent(`E14-${EXEC_ID}-%`);
  const r = await supaAuth(
    `/rest/v1/notas?cuenta_id=eq.${encodeURIComponent(cuentaId)}&texto=like.${prefix}`,
    jwt,
    { method: 'DELETE', prefer: 'return=minimal' }
  );
  if (r.status !== 200 && r.status !== 204)
    throw new Error(`limpiarNotasFixture: HTTP ${r.status} — ${JSON.stringify(r.body).slice(0, 200)}`);
}

// ── Suite principal ────────────────────────────────────────────────────────────

(async () => {
  let server = null, browser = null, page = null;
  let jwt = null, cuentaId = null;
  let idsFixture = null;
  let respaldoNotas = null;

  try {
    // ── P01: Servidor + staging ───────────────────────────────────────────────
    console.log('\n── P01: Servidor local + staging ──');
    server = await servirApp();
    ok('P01-a: servidor levantado', true);

    const pingUrl  = new URL(SUPA_URL);
    pingUrl.pathname = '/rest/v1/';
    const pingResp = await new Promise(resolve =>
      https.get(
        { hostname: pingUrl.hostname, path: pingUrl.pathname,
          headers: { apikey: ANON_KEY } },
        r => { r.resume(); resolve(r.statusCode); }
      ).on('error', () => resolve(0))
    );
    ok('P01-b: staging alcanzable', pingResp >= 200 && pingResp < 500);

    // ── P02: Login + cuenta ───────────────────────────────────────────────────
    console.log('\n── P02: Login REST + cuenta ──');
    jwt       = await loginTesorero();
    cuentaId  = await descubrirCuenta(jwt);
    ok('P02-a: login REST exitoso', !!jwt);
    ok('P02-b: cuentaId descubierto', !!cuentaId);

    // ── P03: Insertar 1100 notas fixture ──────────────────────────────────────
    console.log(`\n── P03: Insertar ${N_NOTAS} notas fixture (lotes de ${LOTE}) ──`);
    idsFixture = await insertarNotasFixture(jwt, cuentaId);
    ok(`P03: ${N_NOTAS} notas insertadas`, idsFixture.length === N_NOTAS);
    nota('IDs de muestra', `primero=${idsFixture[0].slice(0,8)}… · último=${idsFixture[N_NOTAS-1].slice(0,8)}…`);

    if (idsFixture.length < N_NOTAS) {
      skip('P04–P09', 'inserción de fixtures no completó');
    } else {
      // ── P04: Exportación UI → JSON descargado ─────────────────────────────
      console.log('\n── P04: Exportación UI ──');
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        acceptDownloads: true,
        recordVideo: undefined,
      });
      page = await context.newPage();

      await loginUI(page, cuentaId);   // verifica que S._v9CuentaId === cuentaId
      ok('P04-a: login UI (_v9CuentaId coincide con REST)', true);

      await navegarRespaldos(page);
      ok('P04-b: ruta respaldos', true);

      // Trigger export — waitForEvent('download') antes de click
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: T_LARGO }),
        page.evaluate(() => {
          if (typeof exportarDatosConFecha === 'function') exportarDatosConFecha();
        }),
      ]);
      const tmpPath = await download.path();
      ok('P04-c: archivo descargado', !!tmpPath);

      if (!tmpPath) {
        skip('P05–P09', 'descarga falló');
      } else {
        const jsonRaw  = fs.readFileSync(tmpPath, 'utf8');
        const respaldo = JSON.parse(jsonRaw);
        respaldoNotas  = Array.isArray(respaldo?.colecciones?.notas)
          ? respaldo.colecciones.notas
          : null;

        // ── P05: Conteo ───────────────────────────────────────────────────
        console.log('\n── P05–P09: Verificación de paginación ──');
        ok(`P05: notas en backup ≥ ${N_NOTAS}`, (respaldoNotas?.length ?? 0) >= N_NOTAS);
        nota('Conteo', `backup.colecciones.notas.length = ${respaldoNotas?.length ?? 'n/a'}`);

        const idSet = new Set((respaldoNotas || []).map(n => n.id));

        // ── P06: posiciones de frontera de página ─────────────────────────
        const limites = [0, 999, 1000, N_NOTAS - 1];
        const faltanLimites = limites.filter(i => !idSet.has(idsFixture[i]));
        ok('P06: IDs en posiciones de frontera (0, 999, 1000, 1099) presentes',
           faltanLimites.length === 0,
           faltanLimites.map(i => `[${i}]=${idsFixture[i]?.slice(0,8)}…`).join(', '));

        // ── P07: verificación completa de los 1100 IDs del fixture ────────
        // No basta con un conteo ni cuatro muestras: se cruza el set completo.
        const faltantes = idsFixture.filter(id => !idSet.has(id));
        ok(`P07: los ${N_NOTAS} IDs del fixture están en el backup`,
           faltantes.length === 0,
           faltantes.length > 0
             ? `faltan ${faltantes.length} IDs; primeros 5: ${faltantes.slice(0, 5).join(', ')}`
             : '');
      }
    }

  } catch (e) {
    console.error('❌ Error no capturado:', e.message);
    fail++;
    failures.push('error no capturado: ' + e.message);
  } finally {
    // ── P10: Limpieza — se ejecuta siempre, incluso ante setup parcial ────
    console.log('\n── P10: Limpieza (finally) ──');
    if (cuentaId && jwt) {
      try {
        await limpiarNotasFixture(jwt, cuentaId);
      } catch (ce) {
        console.error('⚠️  limpiarNotasFixture lanzó:', ce.message);
        fail++;
        failures.push('limpiarNotasFixture: ' + ce.message);
      }
      // Exigir GET HTTP 200 con array vacío — prefijo exacto E14-{EXEC_ID}-
      const prefix = encodeURIComponent(`E14-${EXEC_ID}-%`);
      const check  = await supaAuth(
        `/rest/v1/notas?cuenta_id=eq.${encodeURIComponent(cuentaId)}&texto=like.${prefix}&select=id`,
        jwt
      ).catch(e => ({ status: 0, body: e.message }));
      ok('P10-a: GET verificación HTTP 200', check.status === 200,
         `status=${check.status}`);
      ok('P10-b: notas fixture E14-${EXEC_ID}- = 0 tras DELETE',
         check.status === 200 && Array.isArray(check.body) && check.body.length === 0,
         check.status === 200 ? `quedaron ${Array.isArray(check.body) ? check.body.length : '?'}` : '');
    } else {
      skip('P10', 'sin cuentaId o jwt (setup no completó)');
    }

    if (page)    await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (server)  server.close();
  }

  // ── Resumen ──────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`E14 Resultados: ${pass} OK / ${fail} FAIL / ${blocked} BLOQUEADOS`);
  if (failures.length)    console.error('Fallos:', failures);
  if (blockedList.length) console.log('Bloqueados:', blockedList);
  process.exit(fail > 0 ? 1 : 0);
})();
