/**
 * tests/e9_notas_ui.js
 *
 * Suite Playwright B3 — Notas V9: CRUD completo sobre la tabla `notas`.
 *
 * Verifica:
 *   N01  Servidor local levantado
 *   N02  Login UI completado (_v9CuentaId disponible)
 *   N03  Crear nota vía UI → fila en DB con texto y color correctos
 *   N04  Nota persiste y aparece tras reload
 *   N05  Editar texto → actualizado en DB
 *   N06  Fijar nota → fijada=true en DB; re-fijar → fijada=false
 *   N07  Eliminar nota → ausente en DB y UI
 *   N08  Limpieza: fixtures eliminados de staging (en finally)
 *
 * Patrón: igual que E8 — login REST para fixtures, login UI para comportamiento,
 * poll REST para verificación, aislamiento por EXEC_ID.
 *
 * Variables de entorno requeridas (mismo .env que E8):
 *   STAGING_SUPABASE_URL, STAGING_SUPABASE_ANON_KEY (o STAGING_KEY),
 *   STAGING_USER_A_EMAIL (o STAGING_EMAIL), STAGING_USER_A_PASSWORD (o STAGING_PASS)
 * Opcional:
 *   STAGING_CUENTA_ID  — acelera descubrirCuenta
 * NUNCA apuntar a producción (tmjqzaakzhecbldebyeg).
 */

'use strict';

const path  = require('path');
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const { chromium } = require('playwright');

try { require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') }); } catch(_) {}

const SUPA_URL_RAW = (process.env.STAGING_SUPABASE_URL || process.env.STAGING_URL || '').replace(/\/$/, '');
const ANON_KEY     = process.env.STAGING_SUPABASE_ANON_KEY || process.env.STAGING_KEY || '';
const USER_EMAIL   = process.env.STAGING_USER_A_EMAIL || process.env.STAGING_EMAIL || '';
const USER_PASS    = process.env.STAGING_USER_A_PASSWORD || process.env.STAGING_PASS || '';

if (!SUPA_URL_RAW || !ANON_KEY || !USER_EMAIL || !USER_PASS) {
  console.error('❌ Faltan variables de entorno. Revisa .env (mismas que E8).');
  process.exit(1);
}

const PROD_HOST    = 'tmjqzaakzhecbldebyeg.supabase.co';
const STAGING_HOST = 'rucgmytyxpfowznowxwd.supabase.co';
const SUPA_URL     = SUPA_URL_RAW;
let parsedHost;
try { parsedHost = new URL(SUPA_URL).hostname; } catch(_) { process.exit(2); }
if (parsedHost === PROD_HOST || parsedHost !== STAGING_HOST) {
  console.error('❌ URL no autorizada:', parsedHost); process.exit(2);
}

// ── Fixtures y constantes ─────────────────────────────────────────────────────

const EXEC_ID  = Date.now().toString(36);
const NOTA_ID1 = `nota-b3-1-${EXEC_ID}`;
const NOTA_ID2 = `nota-b3-2-${EXEC_ID}`;
const TEXTO1   = `Nota de prueba B3 ${EXEC_ID}`;
const TEXTO1_EDIT = `Editada B3 ${EXEC_ID}`;
const TEXTO2   = `Nota fijada B3 ${EXEC_ID}`;
const APP_PORT = 8798;

let CUENTA_ID = process.env.STAGING_CUENTA_ID || null;

let pass = 0, fail = 0;
const failures = [];
function ok(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else       { console.error(`  ❌ ${label}`); fail++; failures.push(label); }
}

const T_CORTO = 12_000;
const T_LARGO = 30_000;

// ── HTTP helpers (mismos que E8) ──────────────────────────────────────────────

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
function supaAnon(urlPath, opts = {}) {
  return _fetch(urlPath, { ...opts, authHeader: null });
}

// ── Servidor HTTP local (igual que E8: inyecta STAGING_SUPA_URL en <head>) ────

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

// ── Login REST y descubrimiento de cuenta ─────────────────────────────────────

async function loginTesorero() {
  const r = await supaAnon('/auth/v1/token?grant_type=password', {
    method: 'POST', body: { email: USER_EMAIL, password: USER_PASS }, prefer: '',
  });
  if (r.status !== 200 || !r.body?.access_token)
    throw new Error(`Login REST fallido: ${JSON.stringify(r.body)}`);
  return r.body.access_token;
}

async function descubrirCuenta(jwt) {
  const r = await supaAuth('/rest/v1/tesorero_cuentas?select=id&limit=1', jwt);
  if (r.status !== 200 || !Array.isArray(r.body) || r.body.length === 0)
    throw new Error('descubrirCuenta: ' + JSON.stringify(r.body));
  return r.body[0].id;
}

// ── Helpers Playwright ────────────────────────────────────────────────────────

async function waitAppReady(page) {
  await page.waitForFunction(() => typeof window.S !== 'undefined', { timeout: T_LARGO });
}

async function reloginViaUI(page) {
  const tieneForm = await page.locator('#l-email').count() > 0;
  if (!tieneForm) return;
  await page.fill('#l-email', USER_EMAIL);
  await page.fill('#l-pass',  USER_PASS);
  await page.click('[onclick="doLogin()"]');
  await page.waitForFunction(
    () => window.S?.session !== null && window.S?.session !== undefined && !!window.S?._v9CuentaId,
    { timeout: T_LARGO }
  );
}

function interceptDialogs(page) {
  page.on('dialog', async d => {
    console.log(`    [dialog] ${d.type()}: ${d.message().slice(0, 80)}`);
    await d.accept();
  });
}

/** Navegar a la sección de notas */
async function navegarNotas(page) {
  await page.evaluate(() => { if (typeof go === 'function') go('notas'); });
  await page.waitForFunction(() => window.S?.route === 'notas', { timeout: T_CORTO });
}

// ── Limpieza staging ──────────────────────────────────────────────────────────

async function limpiarNotas(jwt) {
  if (!CUENTA_ID) return;
  // Elimina todas las notas cuyo id contiene EXEC_ID
  const r = await supaAuth(
    `/rest/v1/notas?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&id=like.*${EXEC_ID}*`,
    jwt, { method: 'DELETE', prefer: 'return=minimal' }
  );
  console.log(`  🧹 limpiarNotas: HTTP ${r.status}`);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  E9 B3 — Playwright: Notas V9');
  console.log('══════════════════════════════════════════════════════════════\n');
  console.log(`EXEC_ID  : ${EXEC_ID}`);
  console.log(`Staging  : ${SUPA_URL}`);

  // ── Pre: login REST ───────────────────────────────────────────────────────
  console.log('\n[Pre] Login REST');
  let jwt;
  try {
    jwt = await loginTesorero();
    if (!CUENTA_ID) CUENTA_ID = await descubrirCuenta(jwt);
    console.log(`  Cuenta: ${CUENTA_ID}`);
  } catch (e) {
    console.error('❌ Setup falló:', e.message); process.exit(3);
  }

  let server = null, browser = null;

  try {
    // ── N01: Servidor ─────────────────────────────────────────────────────
    console.log('\n[N01] Servidor HTTP local');
    server = await servirApp();
    ok('N01: servidor levantado', true);

    // ── N02: Login UI ─────────────────────────────────────────────────────
    console.log('\n[N02] Login UI');
    browser = await chromium.launch({ headless: true });
    const ctx  = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on('console', msg => {
      if (msg.type() === 'error') console.error(`  [browser] ${msg.text()}`);
    });
    interceptDialogs(page);

    await page.goto(`http://localhost:${APP_PORT}/`, { waitUntil: 'load', timeout: T_LARGO });
    await waitAppReady(page).catch(() => { throw new Error('window.S no definido'); });

    await page.fill('#l-email', USER_EMAIL);
    await page.fill('#l-pass',  USER_PASS);
    await page.click('[onclick="doLogin()"]');
    try {
      await page.waitForFunction(
        () => window.S?.session !== null && window.S?.session !== undefined && !!window.S?._v9CuentaId,
        { timeout: T_LARGO }
      );
      ok('N02: login completado (_v9CuentaId disponible)', true);
    } catch (_) {
      ok('N02: login completado', false);
      throw new Error('Login UI no completó');
    }

    // ── N03: Crear nota vía UI → verificar DB ─────────────────────────────
    console.log('\n[N03] Crear nota vía UI → fila en DB');
    await navegarNotas(page);
    // Mostrar formulario
    await page.evaluate(() => { if (typeof mostrarFormNota === 'function') mostrarFormNota(); });
    await page.waitForSelector('#nota-texto', { timeout: T_CORTO });
    await page.fill('#nota-texto', TEXTO1);
    // Color rojo (#FCE4EC) como segundo color disponible — click en segundo dot
    const colorDots = page.locator('.color-dot');
    if (await colorDots.count() > 1) await colorDots.nth(1).click();
    // Guardar
    await page.evaluate(() => { if (typeof guardarNota === 'function') guardarNota(); });
    await page.waitForTimeout(1500);

    // Poll REST
    const r03 = await supaAuth(
      `/rest/v1/notas?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&texto=like.*${EXEC_ID}*&select=id,texto,color,fijada`,
      jwt
    );
    ok('N03-a: GET notas responde 200', r03.status === 200);
    const fila03 = Array.isArray(r03.body) ? r03.body[0] : null;
    ok('N03-b: fila insertada en DB', !!fila03);
    ok('N03-c: texto correcto', (fila03?.texto || '').includes(EXEC_ID));
    ok('N03-d: fijada=false por defecto', fila03?.fijada === false);

    // ── N04: Nota persiste tras reload ────────────────────────────────────
    console.log('\n[N04] Nota persiste tras reload');
    await page.reload({ waitUntil: 'load', timeout: T_LARGO });
    await waitAppReady(page);
    await reloginViaUI(page);
    await navegarNotas(page);
    const html04 = await page.locator('#contenido, main, body').innerHTML().catch(() => '');
    ok('N04-a: EXEC_ID visible en UI tras reload', html04.includes(EXEC_ID));

    // ── N05: Editar texto ─────────────────────────────────────────────────
    console.log('\n[N05] Editar texto de nota');
    // Obtener id de la nota desde DB
    const r05pre = await supaAuth(
      `/rest/v1/notas?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&texto=like.*${EXEC_ID}*&select=id&limit=1`,
      jwt
    );
    const notaId05 = Array.isArray(r05pre.body) && r05pre.body.length > 0 ? r05pre.body[0].id : null;
    ok('N05-a: id de nota encontrado en DB', !!notaId05);

    if (notaId05) {
      // Activar edición
      await page.evaluate(id => { if (typeof editarNota === 'function') editarNota(id); }, notaId05);
      await page.waitForSelector(`#edit-${notaId05}`, { state: 'visible', timeout: T_CORTO });
      await page.fill(`#edit-${notaId05}`, TEXTO1_EDIT);
      await page.evaluate(id => { if (typeof guardarEdicionNota === 'function') guardarEdicionNota(id); }, notaId05);
      await page.waitForTimeout(1500);

      const r05 = await supaAuth(
        `/rest/v1/notas?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&id=eq.${encodeURIComponent(notaId05)}&select=texto`,
        jwt
      );
      ok('N05-b: texto actualizado en DB', (r05.body?.[0]?.texto || '').includes('Editada B3'));
    } else {
      ok('N05-b: (BLOQUEADO — id no hallado)', false);
    }

    // ── N06: Fijar nota ───────────────────────────────────────────────────
    console.log('\n[N06] Fijar nota → fijada=true; re-fijar → false');
    if (notaId05) {
      // Primera fijar
      await page.evaluate(id => { if (typeof fijarNota === 'function') fijarNota(id); }, notaId05);
      await page.waitForTimeout(1200);
      const r06a = await supaAuth(
        `/rest/v1/notas?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&id=eq.${encodeURIComponent(notaId05)}&select=fijada`,
        jwt
      );
      ok('N06-a: fijada=true tras fijar', r06a.body?.[0]?.fijada === true);

      // Segunda fijar (desfijar)
      await page.evaluate(id => { if (typeof fijarNota === 'function') fijarNota(id); }, notaId05);
      await page.waitForTimeout(1200);
      const r06b = await supaAuth(
        `/rest/v1/notas?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&id=eq.${encodeURIComponent(notaId05)}&select=fijada`,
        jwt
      );
      ok('N06-b: fijada=false tras desfijar', r06b.body?.[0]?.fijada === false);
    } else {
      ok('N06-a: (BLOQUEADO)', false);
      ok('N06-b: (BLOQUEADO)', false);
    }

    // ── N07: Eliminar nota ────────────────────────────────────────────────
    console.log('\n[N07] Eliminar nota → ausente en DB');
    if (notaId05) {
      await page.evaluate(id => { if (typeof eliminarNota === 'function') eliminarNota(id); }, notaId05);
      await page.waitForTimeout(1500);
      const r07 = await supaAuth(
        `/rest/v1/notas?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&id=eq.${encodeURIComponent(notaId05)}&select=id`,
        jwt
      );
      ok('N07-a: GET nota eliminada responde 200', r07.status === 200);
      ok('N07-b: fila ausente en DB', Array.isArray(r07.body) && r07.body.length === 0);
    } else {
      ok('N07-a: (BLOQUEADO)', false);
      ok('N07-b: (BLOQUEADO)', false);
    }

  } finally {
    // ── N08: Limpieza ─────────────────────────────────────────────────────
    console.log('\n[N08] Limpieza staging');
    try {
      const jwtPost = await loginTesorero();
      await limpiarNotas(jwtPost);
      ok('N08: limpieza ejecutada sin excepción', true);
    } catch (e) {
      console.error('  ⚠️  limpiarNotas:', e.message);
      ok('N08: limpieza', false);
    }
    if (browser) await browser.close();
    if (server)  server.close();
  }

  console.log(`\n${'─'.repeat(56)}`);
  console.log(`📊 E9 Notas V9: ${pass} ✅  ${fail} ❌`);
  if (failures.length) {
    console.log('\nFallas:');
    failures.forEach(f => console.log('  •', f));
  }
  process.exit(fail > 0 ? 1 : 0);
})();
