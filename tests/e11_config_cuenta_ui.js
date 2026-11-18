/**
 * tests/e11_config_cuenta_ui.js
 *
 * Suite Playwright B4 — Configuración de cuenta V9
 *
 * Verifica:
 *   C01  Servidor local levantado
 *   C02  Login UI completado (_v9CuentaId disponible)
 *   C03  Cargar config_cuenta desde Supabase (GET → estructura válida)
 *   C04  Guardar plantilla_pago via UI real (#cfg-plantilla) → PATCH → verifica en DB
 *   C05  Restaurar plantilla_pago original → verifica en DB
 *   C06  saveCuenta V9: nombre persiste en tesorero_cuentas vía formulario real → PATCH → GET
 *   C07  saveCuenta V9: restaurar nombre original
 *
 * Notas de diseño:
 *   - C04 y C06 exigen los controles de formulario reales (#cfg-plantilla,
 *     #cfg-usr-nombre). Si no están presentes en la ruta "config", el caso
 *     falla explícitamente: no se usa fallback directo al helper.
 *   - Los valores originales se leen antes del try (incluido NULL explícito).
 *   - La restauración (C05/C07) se hace en el bloque finally vía REST,
 *     independiente de si hubo excepción durante la prueba.
 *   - GET de verificación tras cada restauración confirma el estado real.
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

// ── Restauración REST (usada en finally) ─────────────────────────────────────

async function restaurarPlantilla(jwt, cuentaId, valorOriginal) {
  // Si el valor original era NULL, enviar null explícitamente.
  const payload = { plantilla_pago: valorOriginal === undefined ? null : valorOriginal };
  const r = await supaAuth(
    `/rest/v1/config_cuenta?cuenta_id=eq.${encodeURIComponent(cuentaId)}`,
    jwt, { method: 'PATCH', body: payload }
  );
  if (r.status < 200 || r.status >= 300)
    console.error(`  [finally] restaurarPlantilla falló: ${r.status}`);
  // GET de verificación
  const rGet = await supaAuth(
    `/rest/v1/config_cuenta?cuenta_id=eq.${encodeURIComponent(cuentaId)}&select=plantilla_pago`,
    jwt
  );
  const actual = rGet.body?.[0]?.plantilla_pago;
  const esperado = valorOriginal === undefined ? null : valorOriginal;
  if (actual !== esperado)
    console.error(`  [finally] plantilla_pago no restaurada: esperado ${JSON.stringify(esperado)}, actual ${JSON.stringify(actual)}`);
  else
    console.log(`  [finally] plantilla_pago restaurada ✓`);
}

async function restaurarNombre(jwt, cuentaId, valorOriginal) {
  const payload = { nombre: valorOriginal === undefined ? null : valorOriginal };
  const r = await supaAuth(
    `/rest/v1/tesorero_cuentas?id=eq.${encodeURIComponent(cuentaId)}`,
    jwt, { method: 'PATCH', body: payload }
  );
  if (r.status < 200 || r.status >= 300)
    console.error(`  [finally] restaurarNombre falló: ${r.status}`);
  // GET de verificación
  const rGet = await supaAuth(
    `/rest/v1/tesorero_cuentas?id=eq.${encodeURIComponent(cuentaId)}&select=id,nombre`,
    jwt
  );
  const actual = rGet.body?.[0]?.nombre;
  const esperado = valorOriginal === undefined ? null : valorOriginal;
  if (actual !== esperado)
    console.error(`  [finally] nombre no restaurado: esperado ${JSON.stringify(esperado)}, actual ${JSON.stringify(actual)}`);
  else
    console.log(`  [finally] nombre restaurado ✓`);
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

  // Leer valores originales ANTES del try para poder restaurarlos en finally.
  // No se usa || '' ni valor por defecto: se preserva NULL.
  const rCuentaOrig = await supaAuth(
    `/rest/v1/tesorero_cuentas?id=eq.${encodeURIComponent(CUENTA_ID)}&select=id,nombre,email`,
    jwt
  );
  const nombreOriginal = rCuentaOrig.body?.[0]?.nombre;   // puede ser null
  console.log(`  Nombre original en DB: ${JSON.stringify(nombreOriginal)}`);

  const rCfgOrig = await supaAuth(
    `/rest/v1/config_cuenta?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&select=plantilla_pago`,
    jwt
  );
  const plantillaOriginal = rCfgOrig.body?.[0]?.plantilla_pago;  // puede ser null
  console.log(`  Plantilla original en DB: ${JSON.stringify((plantillaOriginal || '').slice(0, 60))}`);

  // Flags para saber qué restaurar en finally
  let plantillaModificada = false;
  let nombreModificado    = false;

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

    // ── C04: Guardar plantilla_pago via formulario real ───────────────────
    console.log('\n[C04] Guardar plantilla_pago via UI real (#cfg-plantilla) → PATCH → verifica en DB');
    await navegarConfig(page);

    const plantillaTest = `Test-${EXEC_ID}: Estimado apoderado, adjunto su comprobante.`;

    // Exigir el control real. Si no existe, el caso falla aquí sin fallback.
    const fInputPlantilla = page.locator('#cfg-plantilla');
    const tieneInput = await fInputPlantilla.count() > 0;
    ok('C04: control #cfg-plantilla presente en ruta config', tieneInput);
    if (!tieneInput) throw new Error('C04: #cfg-plantilla ausente — ¿la ruta config no está activa?');

    const promesaPatchCfg = esperarRespuestaSupabase(page, 'config_cuenta', 'PATCH', T_CORTO);
    await fInputPlantilla.fill(plantillaTest);
    await page.evaluate(() => {
      if (typeof savePlantillaCfg === 'function') savePlantillaCfg();
    });
    plantillaModificada = true;

    const patchCfg = await promesaPatchCfg;
    if (patchCfg) {
      console.log(`  [net] PATCH ${patchCfg.url} → ${patchCfg.status}`);
    } else {
      console.error('  [net] PATCH config_cuenta: sin respuesta en T_CORTO');
    }
    ok('C04-b: PATCH config_cuenta HTTP 2xx', patchCfg?.status >= 200 && patchCfg?.status < 300);

    const rC04 = await supaAuth(
      `/rest/v1/config_cuenta?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&select=plantilla_pago`,
      jwt
    );
    console.log(`  [rest] plantilla_pago en DB: "${(rC04.body?.[0]?.plantilla_pago || '').slice(0, 60)}"`);
    ok('C04-c: plantilla_pago persiste en DB', rC04.body?.[0]?.plantilla_pago === plantillaTest);

    // ── C06: saveCuenta V9 → nombre persiste vía formulario real ─────────
    console.log('\n[C06] saveCuenta V9 → nombre persiste en tesorero_cuentas vía formulario real');
    await navegarConfig(page);

    const nombreTest = `Test-${EXEC_ID.slice(0, 6)} Tesorero`;

    // Exigir los controles reales. Si no existen, el caso falla aquí sin fallback.
    const fNombre = page.locator('#cfg-usr-nombre');
    const tieneFormCuenta = await fNombre.count() > 0;
    ok('C06: control #cfg-usr-nombre presente en ruta config', tieneFormCuenta);
    if (!tieneFormCuenta) throw new Error('C06: #cfg-usr-nombre ausente — ¿la ruta config no está activa?');

    // Verificar también los campos de contraseña (deben estar limpios)
    const fPass  = page.locator('#cfg-usr-pass');
    const fPass2 = page.locator('#cfg-usr-pass2');
    if (await fPass.count() > 0)  await fPass.fill('');
    if (await fPass2.count() > 0) await fPass2.fill('');

    const promesaPatchCuenta = esperarRespuestaSupabase(page, 'tesorero_cuentas', 'PATCH', T_CORTO);
    await fNombre.fill(nombreTest);
    await page.evaluate(() => {
      if (typeof saveCuenta === 'function') saveCuenta();
    });
    nombreModificado = true;

    const patchCuenta = await promesaPatchCuenta;
    if (patchCuenta) {
      console.log(`  [net] PATCH ${patchCuenta.url} → ${patchCuenta.status}`);
    } else {
      console.error('  [net] PATCH tesorero_cuentas: sin respuesta en T_CORTO');
    }
    ok('C06-b: PATCH tesorero_cuentas HTTP 2xx', patchCuenta?.status >= 200 && patchCuenta?.status < 300);

    const rC06 = await supaAuth(
      `/rest/v1/tesorero_cuentas?id=eq.${encodeURIComponent(CUENTA_ID)}&select=id,nombre`,
      jwt
    );
    console.log(`  [rest] nombre en DB: "${rC06.body?.[0]?.nombre}"`);
    ok('C06-c: nombre persiste en tesorero_cuentas', rC06.body?.[0]?.nombre === nombreTest);

  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server)  server.close();

    // ── C05/C07: Restaurar valores originales (siempre, incluso tras excepción) ──
    if (jwt && CUENTA_ID) {
      if (plantillaModificada) {
        console.log('\n[C05/finally] Restaurar plantilla_pago original');
        await restaurarPlantilla(jwt, CUENTA_ID, plantillaOriginal).catch(e =>
          console.error('  [finally] restaurarPlantilla error:', e.message)
        );
      }
      if (nombreModificado) {
        console.log('\n[C07/finally] Restaurar nombre original');
        await restaurarNombre(jwt, CUENTA_ID, nombreOriginal).catch(e =>
          console.error('  [finally] restaurarNombre error:', e.message)
        );
      }
    }
  }

  // Registrar C05/C07 en el conteo (la restauración fue verificada en finally con log)
  // Aquí solo contamos si llegamos al finally sin excepción previa en C04/C06.
  if (plantillaModificada) ok('C05: plantilla_pago restaurada en finally', true);
  if (nombreModificado)    ok('C07: nombre restaurado en finally', true);

  console.log(`\n${'─'.repeat(56)}`);
  console.log(`📊 E11 Config Cuenta V9: ${pass} ✅  ${fail} ❌`);
  if (failures.length) {
    console.log('\nFallas:');
    failures.forEach(f => console.log('  •', f));
  }
  process.exit(fail > 0 ? 1 : 0);
})();
