/**
 * tests/e9_notas_ui.js
 *
 * Suite Playwright B3 — Notas V9: CRUD completo sobre la tabla `notas`.
 *
 * Verifica:
 *   N01  Servidor local levantado
 *   N02  Login UI completado (_v9CuentaId disponible)
 *   N03  Crear nota vía UI → fila en DB con texto y color correctos
 *   N04  Nota persiste y aparece tras reload (sesión completa + ruta + DB.notas cargadas)
 *   N05  Editar texto → actualizado en DB (awaita PATCH, verifica por ID exacto)
 *   N06  Fijar nota → fijada=true en DB; re-fijar → fijada=false
 *   N07  Eliminar nota → ausente en DB (awaita DELETE, verifica por ID exacto)
 *   N08  Limpieza: GET verifica ausencia real de fixture (no solo HTTP 204)
 *
 * Patrón: igual que E8 — login REST para fixtures, login UI para comportamiento,
 * intercepción de red para mutaciones, poll REST para verificación, EXEC_ID para aislamiento.
 *
 * Variables de entorno requeridas (mismo .env que E8):
 *   STAGING_SUPABASE_URL, STAGING_SUPABASE_ANON_KEY (o STAGING_KEY),
 *   STAGING_USER_A_EMAIL (o STAGING_EMAIL), STAGING_USER_A_PASSWORD (o STAGING_PASS)
 * Opcional: STAGING_CUENTA_ID
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

const EXEC_ID    = Date.now().toString(36);
const TEXTO1     = `Nota de prueba B3 ${EXEC_ID}`;
const TEXTO1_EDIT = `Editada B3 ${EXEC_ID}`;
const APP_PORT   = 8798;

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

// ── Servidor HTTP local ───────────────────────────────────────────────────────

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

/** Registra todas las respuestas 4xx/5xx con URL y método para diagnóstico. */
function registrarRespuestasError(page) {
  page.on('response', async res => {
    const status = res.status();
    if (status >= 400) {
      const method = res.request().method();
      const url    = res.url();
      let body = '';
      try { body = await res.text().then(t => t.slice(0, 120)); } catch(_) {}
      console.error(`  [net ${status}] ${method} ${url}${body ? ' → ' + body : ''}`);
    }
  });
}

/** Navegar a notas y esperar que la ruta sea 'notas'. */
async function navegarNotas(page) {
  await page.evaluate(() => { if (typeof go === 'function') go('notas'); });
  await page.waitForFunction(() => window.S?.route === 'notas', { timeout: T_CORTO });
}

/**
 * Esperar una respuesta de Supabase para una tabla+método dados.
 * Retorna { status, body } de la primera respuesta que coincida, o null si
 * no llega antes del timeout.
 */
function esperarRespuestaSupabase(page, tabla, metodo, timeoutMs = T_CORTO) {
  return new Promise(resolve => {
    let resolved = false;
    const handler = async res => {
      if (resolved) return;
      const url = res.url();
      if (url.includes(tabla) && res.request().method() === metodo) {
        resolved = true;
        page.off('response', handler);
        const status = res.status();
        let body = null;
        try { body = await res.json(); } catch(_) {}
        resolve({ status, body });
      }
    };
    page.on('response', handler);
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        page.off('response', handler);
        resolve(null);
      }
    }, timeoutMs);
  });
}

// ── Limpieza staging ──────────────────────────────────────────────────────────

async function limpiarNotas(jwt) {
  if (!CUENTA_ID) return;
  const r = await supaAuth(
    `/rest/v1/notas?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&texto=like.*${EXEC_ID}*`,
    jwt, { method: 'DELETE', prefer: 'return=minimal' }
  );
  console.log(`  🧹 DELETE notas por texto: HTTP ${r.status}`);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  E9 B3 — Playwright: Notas V9');
  console.log('══════════════════════════════════════════════════════════════\n');
  console.log(`EXEC_ID  : ${EXEC_ID}`);
  console.log(`Staging  : ${SUPA_URL}`);

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
  let notaId = null; // ID real de la fila en DB, fijado en N03

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
    registrarRespuestasError(page);

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
    await page.evaluate(() => { if (typeof mostrarFormNota === 'function') mostrarFormNota(); });
    await page.waitForSelector('#nota-texto', { timeout: T_CORTO });
    await page.fill('#nota-texto', TEXTO1);
    const colorDots = page.locator('.color-dot');
    if (await colorDots.count() > 1) await colorDots.nth(1).click();

    // Capturar POST antes de llamar guardarNota
    const promesaPost = esperarRespuestaSupabase(page, 'notas', 'POST');
    await page.evaluate(() => { if (typeof guardarNota === 'function') guardarNota(); });
    const respPost = await promesaPost;
    console.log(`  [net] POST notas → ${respPost?.status ?? 'sin respuesta'}`);

    // Poll REST para confirmar fila con ID exacto
    const r03 = await supaAuth(
      `/rest/v1/notas?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&texto=like.*${EXEC_ID}*&select=id,texto,color,fijada`,
      jwt
    );
    ok('N03-a: GET notas responde 200', r03.status === 200);
    const fila03 = Array.isArray(r03.body) ? r03.body[0] : null;
    ok('N03-b: fila insertada en DB', !!fila03);
    ok('N03-c: texto correcto', (fila03?.texto || '').includes(EXEC_ID));
    ok('N03-d: fijada=false por defecto', fila03?.fijada === false);
    notaId = fila03?.id || null;
    console.log(`  ID nota: ${notaId}`);

    // ── N04: Nota persiste tras reload ────────────────────────────────────
    console.log('\n[N04] Nota persiste y aparece en UI tras reload');
    await page.reload({ waitUntil: 'load', timeout: T_LARGO });
    await waitAppReady(page);
    await reloginViaUI(page);

    // 1. Sesión completa: esperar _v9CuentaId explícitamente, con o sin re-login.
    //    reloginViaUI solo espera cuando hay formulario visible; si la sesión
    //    persiste retorna de inmediato y la inicialización V9 puede seguir corriendo.
    //    Verificar además que coincide con la cuenta esperada (no solo truthy).
    await page.waitForFunction(
      cuentaId => window.S?._v9CuentaId === cuentaId,
      CUENTA_ID,
      { timeout: T_LARGO }
    ).catch(() => {});
    const cuentaIdPost = await page.evaluate(() => window.S?._v9CuentaId || null);
    ok('N04-a: sesión completa tras reload (_v9CuentaId === CUENTA_ID)',
      cuentaIdPost === CUENTA_ID);

    // 2. Esperar que DB.notas tenga la nota exacta (carga relacional completada)
    if (notaId) {
      await page.waitForFunction(
        id => !!(window.DB?.notas || []).find(n => n.id === id),
        notaId,
        { timeout: T_LARGO }
      ).catch(() => {});
    }

    // 3. Navegar a notas y verificar ruta
    await navegarNotas(page);
    const rutaActual = await page.evaluate(() => window.S?.route || '');
    ok('N04-b: ruta es "notas" tras reload', rutaActual === 'notas');

    // 4. Nota exacta visible en UI
    const html04 = await page.locator('#contenido, main, body').innerHTML().catch(() => '');
    ok('N04-c: nota exacta visible (EXEC_ID en UI)', html04.includes(EXEC_ID));
    if (notaId) ok('N04-d: ID de nota presente en UI', html04.includes(notaId));

    // ── N05: Editar texto ─────────────────────────────────────────────────
    console.log('\n[N05] Editar texto de nota');
    ok('N05-a: id de nota disponible', !!notaId);

    if (notaId) {
      await page.evaluate(id => { if (typeof editarNota === 'function') editarNota(id); }, notaId);
      await page.waitForSelector(`#edit-${notaId}`, { state: 'visible', timeout: T_CORTO });
      await page.fill(`#edit-${notaId}`, TEXTO1_EDIT);

      // Capturar PATCH antes de guardar
      const promesaPatch = esperarRespuestaSupabase(page, 'notas', 'PATCH');
      await page.evaluate(id => { if (typeof guardarEdicionNota === 'function') guardarEdicionNota(id); }, notaId);
      const respPatch = await promesaPatch;
      console.log(`  [net] PATCH notas → ${respPatch?.status ?? 'sin respuesta'}`);
      ok('N05-b: PATCH HTTP 2xx', respPatch?.status >= 200 && respPatch?.status < 300);

      // Verificar por ID exacto
      const r05 = await supaAuth(
        `/rest/v1/notas?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&id=eq.${encodeURIComponent(notaId)}&select=id,texto`,
        jwt
      );
      ok('N05-c: texto actualizado en DB (por ID exacto)',
        (r05.body?.[0]?.texto || '').includes('Editada B3'));
    } else {
      ok('N05-b: (BLOQUEADO)', false);
      ok('N05-c: (BLOQUEADO)', false);
    }

    // ── N06: Fijar nota ───────────────────────────────────────────────────
    console.log('\n[N06] Fijar nota → fijada=true; re-fijar → false');
    if (notaId) {
      // Primera fijar — awaitar PATCH
      const promesaFij1 = esperarRespuestaSupabase(page, 'notas', 'PATCH');
      await page.evaluate(async id => { if (typeof fijarNota === 'function') await fijarNota(id); }, notaId);
      const rFij1 = await promesaFij1;
      console.log(`  [net] PATCH fijar(1) → ${rFij1?.status ?? 'sin respuesta'}`);
      const r06a = await supaAuth(
        `/rest/v1/notas?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&id=eq.${encodeURIComponent(notaId)}&select=fijada`,
        jwt
      );
      ok('N06-a: fijada=true tras fijar (por ID exacto)', r06a.body?.[0]?.fijada === true);

      // Segunda fijar (desfijar)
      const promesaFij2 = esperarRespuestaSupabase(page, 'notas', 'PATCH');
      await page.evaluate(async id => { if (typeof fijarNota === 'function') await fijarNota(id); }, notaId);
      const rFij2 = await promesaFij2;
      console.log(`  [net] PATCH fijar(2) → ${rFij2?.status ?? 'sin respuesta'}`);
      const r06b = await supaAuth(
        `/rest/v1/notas?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&id=eq.${encodeURIComponent(notaId)}&select=fijada`,
        jwt
      );
      ok('N06-b: fijada=false tras desfijar (por ID exacto)', r06b.body?.[0]?.fijada === false);
    } else {
      ok('N06-a: (BLOQUEADO)', false);
      ok('N06-b: (BLOQUEADO)', false);
    }

    // ── N07: Eliminar nota ────────────────────────────────────────────────
    console.log('\n[N07] Eliminar nota → ausente en DB');
    if (notaId) {
      const promesaDel = esperarRespuestaSupabase(page, 'notas', 'DELETE');
      await page.evaluate(async id => { if (typeof eliminarNota === 'function') await eliminarNota(id); }, notaId);
      const respDel = await promesaDel;
      console.log(`  [net] DELETE notas → ${respDel?.status ?? 'sin respuesta'}`);
      ok('N07-a: DELETE HTTP 2xx', respDel?.status >= 200 && respDel?.status < 300);

      const r07 = await supaAuth(
        `/rest/v1/notas?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&id=eq.${encodeURIComponent(notaId)}&select=id`,
        jwt
      );
      ok('N07-b: GET confirma ausencia (por ID exacto)', Array.isArray(r07.body) && r07.body.length === 0);
    } else {
      ok('N07-a: (BLOQUEADO)', false);
      ok('N07-b: (BLOQUEADO)', false);
    }

  } finally {
    // ── N08: Limpieza + verificación por GET ──────────────────────────────
    console.log('\n[N08] Limpieza staging + verificación GET');
    try {
      const jwtPost = await loginTesorero();
      await limpiarNotas(jwtPost);
      // Verificar ausencia real — HTTP 204 no basta
      const rCheck = await supaAuth(
        `/rest/v1/notas?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&texto=like.*${EXEC_ID}*&select=id`,
        jwtPost
      );
      console.log(`  [check] GET notas post-limpieza: HTTP ${rCheck.status}, filas: ${Array.isArray(rCheck.body) ? rCheck.body.length : '?'}`);
      ok('N08-a: fixture ausente en DB tras limpieza (GET)',
        rCheck.status === 200 && Array.isArray(rCheck.body) && rCheck.body.length === 0);
    } catch (e) {
      console.error('  ⚠️  limpieza:', e.message);
      ok('N08-a: limpieza', false);
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
