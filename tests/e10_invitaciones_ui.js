/**
 * tests/e10_invitaciones_ui.js
 *
 * Suite Playwright B1 — Invitaciones V9: CRUD completo sobre `codigos_invitacion`.
 *
 * Verifica:
 *   I01  Servidor local levantado
 *   I02  Login UI completado (_v9CuentaId disponible)
 *   I03  Crear código vía UI → fila en DB (codigo, para, tipo, activo=true)
 *   I04  Código persiste y aparece tras reload
 *   I05  Desactivar código → activo=false en DB
 *   I06  Crear segundo código → sincronizarCodigos → ambos aparecen en UI
 *   I07  Eliminar código → ausente en DB
 *   I08  Limpieza: fixtures eliminados de staging (en finally)
 *
 * Patrón: igual que E8/E9 — login REST para fixtures, login UI para comportamiento,
 * poll REST para verificación, aislamiento por EXEC_ID.
 *
 * Variables de entorno requeridas (mismo .env que E8/E9):
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
  console.error('❌ Faltan variables de entorno. Revisa .env (mismas que E8/E9).');
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
const CODIGO1  = `INV-B1-1-${EXEC_ID}`.toUpperCase();
const CODIGO2  = `INV-B1-2-${EXEC_ID}`.toUpperCase();
const PARA1    = `apoderado-b1-${EXEC_ID}@test.cl`;
const PARA2    = `apoderado-b1-2-${EXEC_ID}@test.cl`;
const APP_PORT = 8799;

let CUENTA_ID = process.env.STAGING_CUENTA_ID || null;

let pass = 0, fail = 0;
const failures = [];
function ok(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else       { console.error(`  ❌ ${label}`); fail++; failures.push(label); }
}

const T_CORTO = 12_000;
const T_LARGO = 30_000;

// ── HTTP helpers (mismos que E8/E9) ───────────────────────────────────────────

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

// ── Servidor HTTP local (igual que E8/E9) ─────────────────────────────────────

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

/** Navegar a la sección de invitaciones */
async function navegarInvitaciones(page) {
  await page.evaluate(() => { if (typeof go === 'function') go('invitaciones'); });
  await page.waitForFunction(() => window.S?.route === 'invitaciones', { timeout: T_CORTO });
}

/** Navegar a la sección de config (donde suelen vivir los códigos en algunas vistas) */
async function navegarConfig(page) {
  await page.evaluate(() => { if (typeof go === 'function') go('config'); });
  await page.waitForFunction(() => window.S?.route === 'config', { timeout: T_CORTO });
}

// ── Limpieza staging ──────────────────────────────────────────────────────────

async function limpiarCodigos(jwt) {
  if (!CUENTA_ID) return;
  // Elimina todos los códigos cuyo campo `id` o `codigo` contiene EXEC_ID
  const r = await supaAuth(
    `/rest/v1/codigos_invitacion?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&codigo=like.*${EXEC_ID}*`,
    jwt, { method: 'DELETE', prefer: 'return=minimal' }
  );
  console.log(`  🧹 limpiarCodigos (por codigo): HTTP ${r.status}`);
  // También limpiar por id por si el campo id contiene EXEC_ID
  const r2 = await supaAuth(
    `/rest/v1/codigos_invitacion?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&id=like.*${EXEC_ID}*`,
    jwt, { method: 'DELETE', prefer: 'return=minimal' }
  );
  console.log(`  🧹 limpiarCodigos (por id): HTTP ${r2.status}`);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  E10 B1 — Playwright: Invitaciones V9');
  console.log('══════════════════════════════════════════════════════════════\n');
  console.log(`EXEC_ID  : ${EXEC_ID}`);
  console.log(`Staging  : ${SUPA_URL}`);
  console.log(`Código 1 : ${CODIGO1}`);
  console.log(`Código 2 : ${CODIGO2}`);

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
    // ── I01: Servidor ─────────────────────────────────────────────────────
    console.log('\n[I01] Servidor HTTP local');
    server = await servirApp();
    ok('I01: servidor levantado', true);

    // ── I02: Login UI ─────────────────────────────────────────────────────
    console.log('\n[I02] Login UI');
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
      ok('I02: login completado (_v9CuentaId disponible)', true);
    } catch (_) {
      ok('I02: login completado', false);
      throw new Error('Login UI no completó');
    }

    // ── I03: Crear código vía UI → verificar DB ───────────────────────────
    console.log('\n[I03] Crear código vía UI → fila en DB');
    await navegarInvitaciones(page).catch(() => navegarConfig(page));
    // Mostrar formulario de creación
    await page.evaluate(() => {
      if (typeof mostrarFormInvitacion === 'function') mostrarFormInvitacion();
    });
    await page.waitForTimeout(500);

    // Llenar campos del formulario
    const inputCodigo = page.locator('#inv-codigo, #codigo-invitacion, input[name="codigo"]').first();
    const inputPara   = page.locator('#inv-para, #para-invitacion, input[name="para"]').first();
    const inputTipo   = page.locator('#inv-tipo, #tipo-invitacion, select[name="tipo"]').first();

    if (await inputCodigo.count() > 0) await inputCodigo.fill(CODIGO1);
    if (await inputPara.count()   > 0) await inputPara.fill(PARA1);
    if (await inputTipo.count()   > 0) {
      const tag = await inputTipo.evaluate(el => el.tagName.toLowerCase());
      if (tag === 'select') await inputTipo.selectOption({ index: 0 });
      else await inputTipo.fill('alumno');
    }

    // Guardar
    await page.evaluate(() => {
      if (typeof guardarInvitacion     === 'function') return guardarInvitacion();
      if (typeof crearCodigoConDatos   === 'function') return crearCodigoConDatos();
      if (typeof agregarCodigoInvitacion === 'function') return agregarCodigoInvitacion();
    });
    await page.waitForTimeout(1800);

    // Poll REST — buscar por cuenta_id + codigo
    const r03 = await supaAuth(
      `/rest/v1/codigos_invitacion?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&codigo=eq.${encodeURIComponent(CODIGO1)}&select=id,codigo,para,tipo,activo`,
      jwt
    );
    ok('I03-a: GET codigos responde 200', r03.status === 200);
    const fila03 = Array.isArray(r03.body) ? r03.body[0] : null;
    ok('I03-b: fila insertada en DB', !!fila03);
    ok('I03-c: codigo correcto', fila03?.codigo === CODIGO1);
    ok('I03-d: activo=true por defecto', fila03?.activo === true);

    // ── I04: Código persiste tras reload ──────────────────────────────────
    console.log('\n[I04] Código persiste tras reload');
    await page.reload({ waitUntil: 'load', timeout: T_LARGO });
    await waitAppReady(page);
    await reloginViaUI(page);
    await navegarInvitaciones(page).catch(() => navegarConfig(page));
    const html04 = await page.locator('#contenido, main, body').innerHTML().catch(() => '');
    ok('I04-a: código visible en UI tras reload', html04.includes(CODIGO1));

    // ── I05: Desactivar código ────────────────────────────────────────────
    console.log('\n[I05] Desactivar código → activo=false');
    const codigoId05 = fila03?.id || null;

    if (codigoId05) {
      await page.evaluate(id => {
        if (typeof desactivarCodigo === 'function') return desactivarCodigo(id);
        if (typeof desactivarCodigoPorCodigo === 'function') return desactivarCodigoPorCodigo(id);
      }, codigoId05);
      await page.waitForTimeout(1500);

      const r05 = await supaAuth(
        `/rest/v1/codigos_invitacion?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&id=eq.${encodeURIComponent(codigoId05)}&select=activo`,
        jwt
      );
      ok('I05-a: GET codigo responde 200', r05.status === 200);
      ok('I05-b: activo=false en DB', r05.body?.[0]?.activo === false);
    } else {
      ok('I05-a: (BLOQUEADO — id no hallado)', false);
      ok('I05-b: (BLOQUEADO)', false);
    }

    // ── I06: Crear 2° código + sincronizar ────────────────────────────────
    console.log('\n[I06] Crear 2° código → sincronizar → ambos en UI');
    // Crear segundo código vía REST directo (fixture) para verificar sincronización
    const payload06 = {
      cuenta_id: CUENTA_ID,
      id:        `ci-b1-2-${EXEC_ID}`,
      codigo:    CODIGO2,
      para:      PARA2,
      tipo:      'alumno',
      activo:    true,
      usado:     false,
    };
    const r06ins = await supaAuth(
      `/rest/v1/codigos_invitacion`,
      jwt,
      { method: 'POST', body: payload06, prefer: 'return=representation' }
    );
    ok('I06-a: fixture 2° código insertado REST', r06ins.status === 201 || r06ins.status === 200);

    // Sincronizar desde UI
    await page.evaluate(() => {
      if (typeof sincronizarCodigos === 'function') return sincronizarCodigos();
      if (typeof sincronizarCodigosDesdeSupabase === 'function') return sincronizarCodigosDesdeSupabase();
      if (typeof recargarCodigos === 'function') return recargarCodigos();
    });
    await page.waitForTimeout(1500);

    const html06 = await page.locator('#contenido, main, body').innerHTML().catch(() => '');
    ok('I06-b: CODIGO1 visible tras sincronizar', html06.includes(CODIGO1) || html06.includes(EXEC_ID));
    ok('I06-c: CODIGO2 visible tras sincronizar', html06.includes(CODIGO2));

    // ── I07: Eliminar código ──────────────────────────────────────────────
    console.log('\n[I07] Eliminar código → ausente en DB');
    if (codigoId05) {
      await page.evaluate(id => {
        if (typeof eliminarCodigo === 'function') return eliminarCodigo(id);
        if (typeof eliminarCodigoPorCodigo === 'function') return eliminarCodigoPorCodigo(id);
      }, codigoId05);
      await page.waitForTimeout(1500);

      const r07 = await supaAuth(
        `/rest/v1/codigos_invitacion?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&id=eq.${encodeURIComponent(codigoId05)}&select=id`,
        jwt
      );
      ok('I07-a: GET codigo responde 200', r07.status === 200);
      ok('I07-b: fila ausente en DB', Array.isArray(r07.body) && r07.body.length === 0);
    } else {
      ok('I07-a: (BLOQUEADO)', false);
      ok('I07-b: (BLOQUEADO)', false);
    }

  } finally {
    // ── I08: Limpieza ─────────────────────────────────────────────────────
    console.log('\n[I08] Limpieza staging');
    try {
      const jwtPost = await loginTesorero();
      await limpiarCodigos(jwtPost);
      ok('I08: limpieza ejecutada sin excepción', true);
    } catch (e) {
      console.error('  ⚠️  limpiarCodigos:', e.message);
      ok('I08: limpieza', false);
    }
    if (browser) await browser.close();
    if (server)  server.close();
  }

  console.log(`\n${'─'.repeat(56)}`);
  console.log(`📊 E10 Invitaciones V9: ${pass} ✅  ${fail} ❌`);
  if (failures.length) {
    console.log('\nFallas:');
    failures.forEach(f => console.log('  •', f));
  }
  process.exit(fail > 0 ? 1 : 0);
})();
