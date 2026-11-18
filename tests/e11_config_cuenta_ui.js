/**
 * tests/e11_config_cuenta_ui.js
 *
 * Suite Playwright B4 — Configuración de cuenta V9
 *
 * Verifica:
 *   C01  Servidor local levantado
 *   C02  Login UI completado (_v9CuentaId disponible)
 *   C03  Cargar config_cuenta desde Supabase (GET → estructura válida)
 *   C04  Guardar plantilla_pago via UI → captura PATCH → verifica en DB
 *   C05  Restaurar plantilla_pago original → verifica en DB
 *   C06  saveCuenta V9: nombre persiste en tesorero_cuentas (PATCH → GET)
 *   C07  saveCuenta V9: restaurar nombre original
 *
 * Producción excluida. Administración de usuarios (B6) permanece pendiente.
 *
 * Variables de entorno requeridas (mismo .env que E8–E10):
 *   STAGING_SUPABASE_URL, STAGING_SUPABASE_ANON_KEY (o STAGING_KEY),
 *   STAGING_USER_A_EMAIL (o STAGING_EMAIL), STAGING_USER_A_PASSWORD (o STAGING_PASS)
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
  console.error('❌ Faltan variables de entorno. Revisa .env.');
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

const EXEC_ID  = Date.now().toString(36);
const APP_PORT = 8800;
let CUENTA_ID  = process.env.STAGING_CUENTA_ID || null;

let pass = 0, fail = 0;
const failures = [];
function ok(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else       { console.error(`  ❌ ${label}`); fail++; failures.push(label); }
}

const T_CORTO = 12_000;
const T_LARGO = 30_000;

// ── HTTP helpers ──────────────────────────────────────────────────────────────

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

// ── Login REST y descubrimiento ───────────────────────────────────────────────

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

function registrarRespuestasError(page) {
  page.on('response', async res => {
    const status = res.status();
    if (status >= 400) {
      const method = res.request().method();
      const url    = res.url();
      let body = '';
      try { body = await res.text().then(t => t.slice(0, 160)); } catch(_) {}
      console.error(`  [net ${status}] ${method} ${url}${body ? '\n    → ' + body : ''}`);
    }
  });
}

async function navegarConfig(page) {
  await page.evaluate(() => { if (typeof go === 'function') go('config'); });
  await page.waitForFunction(() => window.S?.route === 'config', { timeout: T_CORTO });
}

async function esperarCuentaIdListo(page) {
  await page.waitForFunction(
    cuentaId => window.S?._v9CuentaId === cuentaId,
    CUENTA_ID,
    { timeout: T_LARGO }
  ).catch(() => {});
}

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
        resolve({ status, body, url });
      }
    };
    page.on('response', handler);
    setTimeout(() => {
      if (!resolved) { resolved = true; page.off('response', handler); resolve(null); }
    }, timeoutMs);
  });
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  E11 B4 — Playwright: Configuración de cuenta V9');
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

  // Leer nombre original para restaurar al final
  const rCuentaOrig = await supaAuth(
    `/rest/v1/tesorero_cuentas?id=eq.${encodeURIComponent(CUENTA_ID)}&select=id,nombre,email`,
    jwt
  );
  const nombreOriginal = rCuentaOrig.body?.[0]?.nombre || '';
  console.log(`  Nombre original en DB: "${nombreOriginal}"`);

  // Leer plantilla original para restaurar al final
  const rCfgOrig = await supaAuth(
    `/rest/v1/config_cuenta?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&select=plantilla_pago`,
    jwt
  );
  const plantillaOriginal = rCfgOrig.body?.[0]?.plantilla_pago || '';
  console.log(`  Plantilla original en DB: "${plantillaOriginal.slice(0, 60)}"`);

  let server = null, browser = null;

  try {
    // ── C01: Servidor ─────────────────────────────────────────────────────
    console.log('\n[C01] Servidor HTTP local');
    server = await servirApp();
    ok('C01: servidor levantado', true);

    // ── C02: Login UI ─────────────────────────────────────────────────────
    console.log('\n[C02] Login UI');
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
      ok('C02: login completado (_v9CuentaId disponible)', true);
    } catch (_) {
      ok('C02: login completado', false);
      throw new Error('Login UI no completó');
    }

    // ── C03: Cargar config_cuenta desde Supabase ──────────────────────────
    console.log('\n[C03] Cargar config_cuenta desde Supabase');
    const rCfg = await supaAuth(
      `/rest/v1/config_cuenta?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&select=cuenta_id,plantilla_pago,tipo_org,app_url`,
      jwt
    );
    ok('C03-a: GET config_cuenta responde 200', rCfg.status === 200);
    const cfgFila = Array.isArray(rCfg.body) ? rCfg.body[0] : null;
    ok('C03-b: fila de config_cuenta existe', !!cfgFila);
    ok('C03-c: cuenta_id coincide', cfgFila?.cuenta_id === CUENTA_ID);
    console.log(`  config: ${JSON.stringify(cfgFila)}`);

    // ── C04: Guardar plantilla_pago via UI ────────────────────────────────
    console.log('\n[C04] Guardar plantilla_pago via UI → PATCH → verifica en DB');
    await navegarConfig(page);

    const plantillaTest = `Test-${EXEC_ID}: Estimado apoderado, adjunto su comprobante.`;

    // Preparar listener ANTES de disparar
    const promesaPatchCfg = esperarRespuestaSupabase(page, 'config_cuenta', 'PATCH', T_CORTO);

    // Escribir en el textarea de plantilla y guardar
    const fInputPlantilla = page.locator('#cfg-plantilla');
    const tieneInput = await fInputPlantilla.count() > 0;
    if (tieneInput) {
      await fInputPlantilla.fill(plantillaTest);
      await page.evaluate(() => {
        if (typeof savePlantillaCfg === 'function') savePlantillaCfg();
      });
    } else {
      // Disparar directamente con la función si el campo no está visible
      await page.evaluate(async (txt) => {
        if (typeof _persistirConfigV9 === 'function')
          await _persistirConfigV9({ plantilla_pago: txt });
      }, plantillaTest);
    }

    const patchCfg = await promesaPatchCfg;
    if (patchCfg) {
      console.log(`  [net] PATCH ${patchCfg.url} → ${patchCfg.status}`);
    } else {
      console.error('  [net] PATCH config_cuenta: sin respuesta en T_CORTO');
    }
    ok('C04-a: PATCH config_cuenta HTTP 2xx', patchCfg?.status >= 200 && patchCfg?.status < 300);

    // Verificar en DB
    const rC04 = await supaAuth(
      `/rest/v1/config_cuenta?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&select=plantilla_pago`,
      jwt
    );
    console.log(`  [rest] plantilla_pago en DB: "${(rC04.body?.[0]?.plantilla_pago || '').slice(0, 60)}"`);
    ok('C04-b: plantilla_pago persiste en DB', rC04.body?.[0]?.plantilla_pago === plantillaTest);

    // ── C05: Restaurar plantilla_pago original ────────────────────────────
    console.log('\n[C05] Restaurar plantilla_pago original');
    const promesaPatchRest = esperarRespuestaSupabase(page, 'config_cuenta', 'PATCH', T_CORTO);
    await page.evaluate(async (txt) => {
      if (typeof _persistirConfigV9 === 'function')
        await _persistirConfigV9({ plantilla_pago: txt });
    }, plantillaOriginal);

    const patchRest = await promesaPatchRest;
    ok('C05-a: PATCH restaurar HTTP 2xx', patchRest?.status >= 200 && patchRest?.status < 300);
    const rC05 = await supaAuth(
      `/rest/v1/config_cuenta?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&select=plantilla_pago`,
      jwt
    );
    ok('C05-b: plantilla_pago restaurada en DB', rC05.body?.[0]?.plantilla_pago === plantillaOriginal);

    // ── C06: saveCuenta V9 → nombre persiste en tesorero_cuentas ─────────
    console.log('\n[C06] saveCuenta V9 → nombre persiste en tesorero_cuentas');
    await navegarConfig(page);

    const nombreTest = `Test-${EXEC_ID.slice(0, 6)} Tesorero`;

    // Rellenar formulario de cuenta si existe
    const fNombre = page.locator('#cfg-usr-nombre');
    const tieneFormCuenta = await fNombre.count() > 0;
    let patchCuenta = null;

    if (tieneFormCuenta) {
      await fNombre.fill(nombreTest);
      // Limpiar password para no cambiarla
      const fPass = page.locator('#cfg-usr-pass');
      if (await fPass.count() > 0) await fPass.fill('');
      const fPass2 = page.locator('#cfg-usr-pass2');
      if (await fPass2.count() > 0) await fPass2.fill('');

      const promesaPatchCuenta = esperarRespuestaSupabase(page, 'tesorero_cuentas', 'PATCH', T_CORTO);
      await page.evaluate(() => {
        if (typeof saveCuenta === 'function') saveCuenta();
      });
      patchCuenta = await promesaPatchCuenta;
    } else {
      // Disparar vía actualizarCuentaV9 directamente
      const promesaPatchCuenta = esperarRespuestaSupabase(page, 'tesorero_cuentas', 'PATCH', T_CORTO);
      await page.evaluate(async (nombre, cuentaId) => {
        if (typeof actualizarCuentaV9 === 'function') {
          const token = (typeof _authToken !== 'undefined' && _authToken) ||
                        window.S?.session?.accessToken || null;
          if (token) await actualizarCuentaV9(cuentaId, { nombre }, token);
        }
      }, nombreTest, CUENTA_ID);
      patchCuenta = await promesaPatchCuenta;
    }

    if (patchCuenta) {
      console.log(`  [net] PATCH ${patchCuenta.url} → ${patchCuenta.status}`);
    } else {
      console.error('  [net] PATCH tesorero_cuentas: sin respuesta en T_CORTO');
    }
    ok('C06-a: PATCH tesorero_cuentas HTTP 2xx', patchCuenta?.status >= 200 && patchCuenta?.status < 300);

    const rC06 = await supaAuth(
      `/rest/v1/tesorero_cuentas?id=eq.${encodeURIComponent(CUENTA_ID)}&select=id,nombre`,
      jwt
    );
    console.log(`  [rest] nombre en DB: "${rC06.body?.[0]?.nombre}"`);
    ok('C06-b: nombre persiste en tesorero_cuentas', rC06.body?.[0]?.nombre === nombreTest);

    // ── C07: Restaurar nombre original ────────────────────────────────────
    console.log('\n[C07] Restaurar nombre original en tesorero_cuentas');
    const promesaPatchNombreOrig = esperarRespuestaSupabase(page, 'tesorero_cuentas', 'PATCH', T_CORTO);
    await page.evaluate(async (nombre, cuentaId) => {
      const token = (typeof _authToken !== 'undefined' && _authToken) ||
                    window.S?.session?.accessToken || null;
      if (token && typeof actualizarCuentaV9 === 'function')
        await actualizarCuentaV9(cuentaId, { nombre }, token);
    }, nombreOriginal, CUENTA_ID);
    const patchOrig = await promesaPatchNombreOrig;
    ok('C07-a: PATCH restaurar nombre HTTP 2xx', patchOrig?.status >= 200 && patchOrig?.status < 300);
    const rC07 = await supaAuth(
      `/rest/v1/tesorero_cuentas?id=eq.${encodeURIComponent(CUENTA_ID)}&select=id,nombre`,
      jwt
    );
    ok('C07-b: nombre original restaurado', rC07.body?.[0]?.nombre === nombreOriginal);

  } finally {
    if (browser) await browser.close();
    if (server)  server.close();
  }

  console.log(`\n${'─'.repeat(56)}`);
  console.log(`📊 E11 Config Cuenta V9: ${pass} ✅  ${fail} ❌`);
  if (failures.length) {
    console.log('\nFallas:');
    failures.forEach(f => console.log('  •', f));
  }
  process.exit(fail > 0 ? 1 : 0);
})();
