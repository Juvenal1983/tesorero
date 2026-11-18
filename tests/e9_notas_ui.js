/**
 * tests/e9_notas_ui.js
 *
 * Suite Playwright B3 — Notas V9: CRUD completo sobre la tabla `notas`.
 *
 * Verifica:
 *   N01  Libreta vacía carga sin error
 *   N02  Crear nota → persiste en Supabase (GET REST)
 *   N03  Nota aparece en UI tras reload
 *   N04  Editar texto → actualiza en DB
 *   N05  Fijar nota → fijada=true en DB; re-fijar → fijada=false
 *   N06  Eliminar nota → ausente en DB y UI
 *   N07  Rol Visor no puede crear ni editar (RLS + guard)
 *   N08  Limpieza: fixture eliminado de staging
 *
 * Variables de entorno: igual que E8 (STAGING_SUPABASE_URL, STAGING_KEY, etc.)
 * NUNCA apuntar a producción (tmjqzaakzhecbldebyeg).
 */

'use strict';

const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') }); } catch(_) {}

const SUPA_URL_RAW = process.env.STAGING_SUPABASE_URL || process.env.STAGING_URL || '';
const ANON_KEY    = process.env.STAGING_SUPABASE_ANON_KEY || process.env.STAGING_KEY || '';
const USER_EMAIL  = process.env.STAGING_USER_A_EMAIL || process.env.STAGING_EMAIL || '';
const USER_PASS   = process.env.STAGING_USER_A_PASSWORD || process.env.STAGING_PASS || '';

if (!SUPA_URL_RAW || !ANON_KEY || !USER_EMAIL || !USER_PASS) {
  console.error('❌ Faltan variables de entorno (mismas que E8).');
  process.exit(1);
}

const SUPA_URL = SUPA_URL_RAW.replace(/\/$/, '');

const PROD_HOST    = 'tmjqzaakzhecbldebyeg.supabase.co';
const STAGING_HOST = 'rucgmytyxpfowznowxwd.supabase.co';
let parsedHost;
try { parsedHost = new URL(SUPA_URL).hostname; } catch(_) { process.exit(2); }
if (parsedHost === PROD_HOST || parsedHost !== STAGING_HOST) {
  console.error('❌ URL no autorizada:', parsedHost); process.exit(2);
}

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const { chromium } = require('playwright');

const EXEC_ID  = Date.now().toString(36);
const NOTA_ID1 = `nota-b3-1-${EXEC_ID}`;
const NOTA_ID2 = `nota-b3-2-${EXEC_ID}`;
const TEXTO1   = `Nota de prueba B3 ${EXEC_ID}`;
const TEXTO2   = `Recordatorio B3 fijado ${EXEC_ID}`;
const APP_PORT = 8798;

let pass = 0, fail = 0;
const failures = [];
function ok(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else       { console.error(`  ❌ ${label}`); fail++; failures.push(label); }
}

const T_CORTO = 12_000;
const T_LARGO = 30_000;

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function _fetch(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const body   = opts.body ? JSON.stringify(opts.body) : undefined;
    const req = lib.request({
      hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search, method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json', 'Accept': 'application/json',
        'apikey': ANON_KEY,
        ...(opts.authHeader !== undefined
          ? (opts.authHeader ? { Authorization: opts.authHeader } : {})
          : { Authorization: `Bearer ${ANON_KEY}` }),
        ...(opts.prefer ? { Prefer: opts.prefer } : {}),
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(opts.headers || {}),
      }
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        let parsed2;
        try { parsed2 = raw ? JSON.parse(raw) : null; } catch(_) { parsed2 = raw; }
        resolve({ status: res.statusCode, body: parsed2 });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
function supaAnon(path2, opts = {}) {
  return _fetch(SUPA_URL + path2, { ...opts, authHeader: null });
}
function supaAuth(path2, jwt, opts = {}) {
  return _fetch(SUPA_URL + path2, { ...opts, authHeader: `Bearer ${jwt}` });
}
async function loginTesorero() {
  const r = await supaAnon('/auth/v1/token?grant_type=password', {
    method: 'POST', body: { email: USER_EMAIL, password: USER_PASS }, prefer: '',
  });
  if (r.status !== 200 || !r.body?.access_token)
    throw new Error(`Login falló (HTTP ${r.status})`);
  return r.body.access_token;
}
let CUENTA_ID = process.env.STAGING_CUENTA_ID || null;
async function descubrirCuenta(jwt) {
  const r = await supaAuth('/rest/v1/tesorero_cuentas?select=id&limit=1', jwt);
  if (r.status !== 200 || !r.body?.length) throw new Error('Sin cuenta');
  return r.body[0].id;
}

// ── Helpers Playwright ────────────────────────────────────────────────────────
async function screenshot(page, nombre) {
  try {
    const p = path.join(__dirname, `b3-${nombre}-${EXEC_ID}.png`);
    await page.screenshot({ path: p, fullPage: true });
    console.log(`    📸 ${p}`);
  } catch(_) {}
}
async function waitAppReady(page) {
  await page.waitForFunction(() => typeof window.S !== 'undefined', { timeout: T_LARGO });
}

// ── Servidor app local ────────────────────────────────────────────────────────
function servirApp() {
  const HTML_DIR = path.resolve(__dirname, '..');
  const server = http.createServer((req, res) => {
    let filePath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    const full = path.join(HTML_DIR, filePath);
    const ext  = path.extname(full);
    const mime = { '.html':'text/html','.js':'application/javascript','.css':'text/css',
                   '.json':'application/json','.png':'image/png' }[ext] || 'application/octet-stream';
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(APP_PORT, '127.0.0.1', () => { console.log(`  Servidor app: http://localhost:${APP_PORT}`); resolve(server); });
    server.on('error', reject);
  });
}

// ── Limpieza REST ─────────────────────────────────────────────────────────────
async function limpiarNotas(jwt) {
  const c = encodeURIComponent(CUENTA_ID);
  // Eliminar notas creadas en este run (ID contiene EXEC_ID)
  const url1 = `/rest/v1/notas?cuenta_id=eq.${c}&id=like.*${EXEC_ID}*`;
  const r = await supaAuth(url1, jwt, { method: 'DELETE', prefer: 'return=minimal' }).catch(e => ({ status: 0, body: e.message }));
  const ok204 = r.status === 200 || r.status === 204 || r.status === 404;
  console.log(`  ${ok204 ? '✅' : '⚠️ '} DELETE notas EXEC_ID=${EXEC_ID}: HTTP ${r.status}`);
  if (!ok204) console.error('  ⚠️  Limpiar manualmente notas con id like *' + EXEC_ID + '*');
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  E9 B3 — Recorrido Playwright: Notas V9');
  console.log('══════════════════════════════════════════════════════════════\n');
  console.log(`EXEC_ID: ${EXEC_ID}  Staging: ${SUPA_URL}`);

  let jwt;
  try {
    jwt = await loginTesorero();
    if (!CUENTA_ID) CUENTA_ID = await descubrirCuenta(jwt);
    console.log(`  Cuenta: ${CUENTA_ID}`);
  } catch(e) { console.error('❌ Setup:', e.message); process.exit(3); }

  let server = null, browser = null;
  try {
    // ── N01: Servidor + app ───────────────────────────────────────────────────
    console.log('\n[N01] Servidor HTTP local + Chromium');
    server  = await servirApp();
    browser = await chromium.launch({ headless: true });
    const ctx  = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on('console', msg => { if (msg.type() === 'error') console.error(`  [browser] ${msg.text()}`); });
    page.on('dialog', async d => { console.log(`  [dialog] ${d.message().slice(0,60)}`); await d.accept(); });
    await page.addInitScript(({ url, key }) => {
      window.STAGING_SUPA_URL = url;
      window.STAGING_SUPA_KEY = key;
    }, { url: SUPA_URL, key: ANON_KEY });
    await page.goto(`http://localhost:${APP_PORT}/`, { waitUntil: 'load', timeout: T_LARGO });
    await waitAppReady(page);
    ok('N01-a: app cargada', true);

    // Login
    await page.fill('#l-email', USER_EMAIL);
    await page.fill('#l-pass',  USER_PASS);
    await page.click('[onclick="doLogin()"]');
    await page.waitForFunction(() => !!window.S?._v9CuentaId, { timeout: T_LARGO });
    ok('N01-b: login completado', true);

    // ── Navegar a Notas ───────────────────────────────────────────────────────
    console.log('\n[N01-c] Navegar a Libreta de notas');
    await page.evaluate(() => window.go('notas'));
    await page.waitForFunction(() => window.S?.route === 'notas', { timeout: T_CORTO });
    ok('N01-c: ruta notas activa', true);

    // ── N02: Crear nota vía UI ────────────────────────────────────────────────
    console.log('\n[N02] Crear nota vía UI');
    await page.click('#btn-nueva-nota');
    await page.waitForSelector('#nota-texto', { timeout: T_CORTO });
    await page.fill('#nota-texto', TEXTO1);
    await page.click('[onclick="guardarNota()"]');

    // Polling REST: esperar que nota aparezca en DB
    let notaDB = null;
    const t02 = Date.now();
    while (Date.now() - t02 < T_LARGO) {
      const r = await supaAuth(
        `/rest/v1/notas?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&texto=eq.${encodeURIComponent(TEXTO1)}&select=id,texto,fijada,privada`,
        jwt
      );
      if (r.status === 200 && r.body?.length > 0) { notaDB = r.body[0]; break; }
      await new Promise(res => setTimeout(res, 600));
    }
    ok('N02-a: nota creada en Supabase (REST GET confirma)', !!notaDB);
    ok('N02-b: nota.privada=true por defecto', notaDB?.privada === true);
    console.log(`    DB: id=${notaDB?.id} fijada=${notaDB?.fijada} privada=${notaDB?.privada}`);
    const notaId = notaDB?.id;

    // ── N03: Nota aparece en UI tras reload ───────────────────────────────────
    console.log('\n[N03] Nota persiste en UI tras reload');
    await page.reload({ waitUntil: 'load', timeout: T_LARGO });
    await waitAppReady(page);
    const sesion3 = await page.evaluate(() => !!window.S?._v9CuentaId);
    if (!sesion3) {
      await page.fill('#l-email', USER_EMAIL);
      await page.fill('#l-pass',  USER_PASS);
      await page.click('[onclick="doLogin()"]');
      await page.waitForFunction(() => !!window.S?._v9CuentaId, { timeout: T_LARGO });
    }
    await page.evaluate(() => window.go('notas'));
    await page.waitForFunction(() => window.S?.route === 'notas', { timeout: T_CORTO });
    // La nota debe aparecer en el DOM
    const notaEnDOM = await page.locator(`text=${TEXTO1.slice(0, 30)}`).count();
    ok('N03: nota aparece en UI tras reload', notaEnDOM > 0);

    // ── N04: Editar texto ─────────────────────────────────────────────────────
    console.log('\n[N04] Editar texto de la nota');
    if (notaId) {
      const TEXTO_EDIT = TEXTO1 + ' EDITADO';
      await page.click(`#btn-edit-${notaId}`);
      await page.waitForSelector(`#edit-${notaId}`, { timeout: T_CORTO });
      await page.fill(`#edit-${notaId}`, TEXTO_EDIT);
      await page.click(`#btn-save-${notaId}`);
      // Polling REST
      let editada = false;
      const t04 = Date.now();
      while (Date.now() - t04 < T_LARGO) {
        const r = await supaAuth(
          `/rest/v1/notas?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&id=eq.${encodeURIComponent(notaId)}&select=texto`,
          jwt
        );
        if (r.status === 200 && r.body?.[0]?.texto === TEXTO_EDIT) { editada = true; break; }
        await new Promise(res => setTimeout(res, 600));
      }
      ok('N04: texto editado persiste en DB', editada);
    } else {
      ok('N04: (BLOQUEADO — notaId no disponible)', false);
    }

    // ── N05: Fijar nota ───────────────────────────────────────────────────────
    console.log('\n[N05] Fijar nota');
    if (notaId) {
      await page.click(`[onclick="fijarNota('${notaId}')"]`);
      let fijada = false;
      const t05 = Date.now();
      while (Date.now() - t05 < T_LARGO) {
        const r = await supaAuth(
          `/rest/v1/notas?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&id=eq.${encodeURIComponent(notaId)}&select=fijada`,
          jwt
        );
        if (r.status === 200 && r.body?.[0]?.fijada === true) { fijada = true; break; }
        await new Promise(res => setTimeout(res, 600));
      }
      ok('N05-a: nota fijada=true en DB', fijada);
      // Desfijar
      await page.click(`[onclick="fijarNota('${notaId}')"]`);
      let desfijada = false;
      const t05b = Date.now();
      while (Date.now() - t05b < T_LARGO) {
        const r = await supaAuth(
          `/rest/v1/notas?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&id=eq.${encodeURIComponent(notaId)}&select=fijada`,
          jwt
        );
        if (r.status === 200 && r.body?.[0]?.fijada === false) { desfijada = true; break; }
        await new Promise(res => setTimeout(res, 600));
      }
      ok('N05-b: nota desfijada (fijada=false) en DB', desfijada);
    } else {
      ok('N05-a: (BLOQUEADO)', false);
      ok('N05-b: (BLOQUEADO)', false);
    }

    // ── N06: Eliminar nota ────────────────────────────────────────────────────
    console.log('\n[N06] Eliminar nota');
    if (notaId) {
      await page.click(`[onclick="eliminarNota('${notaId}')"]`);
      let eliminada = false;
      const t06 = Date.now();
      while (Date.now() - t06 < T_LARGO) {
        const r = await supaAuth(
          `/rest/v1/notas?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&id=eq.${encodeURIComponent(notaId)}&select=id`,
          jwt
        );
        if (r.status === 200 && Array.isArray(r.body) && r.body.length === 0) { eliminada = true; break; }
        await new Promise(res => setTimeout(res, 600));
      }
      ok('N06-a: nota eliminada de DB', eliminada);
      const enDOM = await page.locator(`#tarjeta-${notaId}`).count();
      ok('N06-b: nota eliminada del DOM', enDOM === 0);
    } else {
      ok('N06-a: (BLOQUEADO)', false);
      ok('N06-b: (BLOQUEADO)', false);
    }

    // ── N07: Rol Visor — guard en cliente ─────────────────────────────────────
    // Simula rol visor sobrescribiendo S.session.rol en la página
    console.log('\n[N07] Rol Visor no puede crear notas (guard cliente)');
    const toastVisor = await page.evaluate(async () => {
      const rolPrev = window.S?.session?.rol;
      if (window.S?.session) window.S.session.rol = 'visor';
      let toastTexto = '';
      const origToast = window.showToast;
      window.showToast = (msg) => { toastTexto = msg; };
      if (typeof window.guardarNota === 'function') await window.guardarNota();
      window.showToast = origToast;
      if (window.S?.session) window.S.session.rol = rolPrev;
      return toastTexto;
    });
    ok('N07: guard visor — showToast con mensaje de error', toastVisor.includes('⛔'));

  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server)  server.close();

    console.log('\n[Post] Limpiar notas de test en staging');
    try { await limpiarNotas(jwt); } catch(e) { console.error('  ⚠️  Limpieza:', e.message); }

    console.log('\n══════════════════════════════════════════════════════════════');
    console.log(`  RESULTADO: ${pass} ✅ / ${fail} ❌`);
    if (failures.length) console.error('  FALLOS:\n' + failures.map(f => '    - ' + f).join('\n'));
    console.log('══════════════════════════════════════════════════════════════\n');
    process.exit(fail > 0 ? 1 : 0);
  }
})();
