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
 *   C05  Restauración plantilla_pago → GET confirma valor original exacto
 *   C06  saveCuenta V9: nombre persiste en tesorero_cuentas vía formulario real
 *   C07  Restauración nombre → GET confirma valor original exacto
 *
 * Notas de diseño:
 *   - Lectura de valores originales: exige HTTP 200 y fila existente.
 *     Distingue fila inexistente, campo NULL y error de consulta.
 *     Un valor desconocido (error de lectura) NO se trata como NULL.
 *   - C04 y C06 exigen controles de formulario reales; sin fallback al helper.
 *   - restaurarPlantilla / restaurarNombre devuelven { ok, actual, esperado }.
 *     C05/C07 usan ese resultado en ok() — una restauración fallida cuenta como FAIL.
 *   - Restauración en finally siempre, incluso tras excepción.
 *
 * Producción excluida. B6 (administración de usuarios) pendiente.
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

// Sentinel para distinguir "campo NULL en DB" de "valor no leído por error"
const UNREAD = Symbol('UNREAD');

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

// ── Lectura segura de valores originales ─────────────────────────────────────
// Lanza si HTTP != 200 o la fila no existe.
// Devuelve el valor exacto del campo (null si era NULL en DB).
// No convierte un error en null — usa el sentinel UNREAD para indicar
// que el valor no fue leído correctamente.

async function leerNombreOriginal(jwt, cuentaId) {
  const r = await supaAuth(
    `/rest/v1/tesorero_cuentas?id=eq.${encodeURIComponent(cuentaId)}&select=nombre`,
    jwt
  );
  if (r.status !== 200)
    throw new Error(`leerNombreOriginal: HTTP ${r.status} — ${JSON.stringify(r.body)}`);
  if (!Array.isArray(r.body) || r.body.length === 0)
    throw new Error(`leerNombreOriginal: fila no encontrada para cuenta ${cuentaId}`);
  // El campo puede ser null; Object.prototype.hasOwnProperty confirma que existe
  if (!Object.prototype.hasOwnProperty.call(r.body[0], 'nombre'))
    throw new Error('leerNombreOriginal: columna "nombre" ausente en la respuesta');
  return r.body[0].nombre;  // null | string
}

async function leerPlantillaOriginal(jwt, cuentaId) {
  const r = await supaAuth(
    `/rest/v1/config_cuenta?cuenta_id=eq.${encodeURIComponent(cuentaId)}&select=plantilla_pago`,
    jwt
  );
  if (r.status !== 200)
    throw new Error(`leerPlantillaOriginal: HTTP ${r.status} — ${JSON.stringify(r.body)}`);
  if (!Array.isArray(r.body) || r.body.length === 0)
    throw new Error(`leerPlantillaOriginal: fila no encontrada para cuenta ${cuentaId}`);
  if (!Object.prototype.hasOwnProperty.call(r.body[0], 'plantilla_pago'))
    throw new Error('leerPlantillaOriginal: columna "plantilla_pago" ausente en la respuesta');
  return r.body[0].plantilla_pago;  // null | string
}

// ── Restauración verificada ───────────────────────────────────────────────────
// Devuelve { ok: boolean, actual, esperado } — nunca lanza.
// Si el valor original es UNREAD no se restaura (no sabemos qué restaurar).

async function restaurarPlantilla(jwt, cuentaId, valorOriginal) {
  if (valorOriginal === UNREAD) {
    console.error('  [finally] restaurarPlantilla: valor original no fue leído — omitida');
    return { ok: false, actual: UNREAD, esperado: UNREAD };
  }
  try {
    const r = await supaAuth(
      `/rest/v1/config_cuenta?cuenta_id=eq.${encodeURIComponent(cuentaId)}`,
      jwt, { method: 'PATCH', body: { plantilla_pago: valorOriginal }, prefer: '' }
    );
    if (r.status < 200 || r.status >= 300) {
      console.error(`  [finally] restaurarPlantilla PATCH falló: HTTP ${r.status}`);
      return { ok: false, actual: null, esperado: valorOriginal };
    }
    // GET de verificación
    const rGet = await supaAuth(
      `/rest/v1/config_cuenta?cuenta_id=eq.${encodeURIComponent(cuentaId)}&select=plantilla_pago`,
      jwt
    );
    if (rGet.status !== 200 || !Array.isArray(rGet.body) || rGet.body.length === 0) {
      console.error(`  [finally] restaurarPlantilla GET falló: HTTP ${rGet.status}`);
      return { ok: false, actual: null, esperado: valorOriginal };
    }
    const actual   = rGet.body[0].plantilla_pago;
    const esperado = valorOriginal;
    const confirmed = actual === esperado;
    if (confirmed) console.log(`  [finally] plantilla_pago restaurada ✓`);
    else           console.error(`  [finally] plantilla_pago no coincide: esperado ${JSON.stringify(esperado)}, actual ${JSON.stringify(actual)}`);
    return { ok: confirmed, actual, esperado };
  } catch (e) {
    console.error(`  [finally] restaurarPlantilla excepción: ${e.message}`);
    return { ok: false, actual: null, esperado: valorOriginal };
  }
}

async function restaurarNombre(jwt, cuentaId, valorOriginal) {
  if (valorOriginal === UNREAD) {
    console.error('  [finally] restaurarNombre: valor original no fue leído — omitida');
    return { ok: false, actual: UNREAD, esperado: UNREAD };
  }
  try {
    const r = await supaAuth(
      `/rest/v1/tesorero_cuentas?id=eq.${encodeURIComponent(cuentaId)}`,
      jwt, { method: 'PATCH', body: { nombre: valorOriginal }, prefer: '' }
    );
    if (r.status < 200 || r.status >= 300) {
      console.error(`  [finally] restaurarNombre PATCH falló: HTTP ${r.status}`);
      return { ok: false, actual: null, esperado: valorOriginal };
    }
    // GET de verificación
    const rGet = await supaAuth(
      `/rest/v1/tesorero_cuentas?id=eq.${encodeURIComponent(cuentaId)}&select=nombre`,
      jwt
    );
    if (rGet.status !== 200 || !Array.isArray(rGet.body) || rGet.body.length === 0) {
      console.error(`  [finally] restaurarNombre GET falló: HTTP ${rGet.status}`);
      return { ok: false, actual: null, esperado: valorOriginal };
    }
    const actual   = rGet.body[0].nombre;
    const esperado = valorOriginal;
    const confirmed = actual === esperado;
    if (confirmed) console.log(`  [finally] nombre restaurado ✓`);
    else           console.error(`  [finally] nombre no coincide: esperado ${JSON.stringify(esperado)}, actual ${JSON.stringify(actual)}`);
    return { ok: confirmed, actual, esperado };
  } catch (e) {
    console.error(`  [finally] restaurarNombre excepción: ${e.message}`);
    return { ok: false, actual: null, esperado: valorOriginal };
  }
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

// ── Login REST ────────────────────────────────────────────────────────────────

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

  // Leer valores originales con validación estricta ANTES del try.
  // Si la lectura falla, se aborta: no sabemos qué restaurar.
  // Si el campo es NULL, se guarda null (no '').
  let nombreOriginal   = UNREAD;
  let plantillaOriginal = UNREAD;

  try {
    nombreOriginal    = await leerNombreOriginal(jwt, CUENTA_ID);
    plantillaOriginal = await leerPlantillaOriginal(jwt, CUENTA_ID);
  } catch (e) {
    console.error('❌ No se pudieron leer los valores originales:', e.message);
    process.exit(3);
  }
  console.log(`  Nombre original en DB    : ${JSON.stringify(nombreOriginal)}`);
  console.log(`  Plantilla original en DB : ${JSON.stringify((plantillaOriginal ?? '').toString().slice(0, 60))}`);

  // Flags: qué se modificó (para restaurar en finally)
  let plantillaModificada = false;
  let nombreModificado    = false;

  // Resultados de restauración (usados en ok() después del finally)
  let resRestaurarPlantilla = null;
  let resRestaurarNombre    = null;

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
    console.log('\n[C04] Guardar plantilla_pago via UI real (#cfg-plantilla) → PATCH → DB');
    await navegarConfig(page);

    const plantillaTest = `Test-${EXEC_ID}: Estimado apoderado, adjunto su comprobante.`;

    const fInputPlantilla = page.locator('#cfg-plantilla');
    const tieneInput = await fInputPlantilla.count() > 0;
    ok('C04-a: control #cfg-plantilla presente en ruta config', tieneInput);
    if (!tieneInput) throw new Error('C04: #cfg-plantilla ausente — ¿la ruta config no está activa?');

    const promesaPatchCfg = esperarRespuestaSupabase(page, 'config_cuenta', 'PATCH', T_CORTO);
    await fInputPlantilla.fill(plantillaTest);
    await page.evaluate(() => {
      if (typeof savePlantillaCfg === 'function') savePlantillaCfg();
    });
    plantillaModificada = true;

    const patchCfg = await promesaPatchCfg;
    if (patchCfg) console.log(`  [net] PATCH ${patchCfg.url} → ${patchCfg.status}`);
    else          console.error('  [net] PATCH config_cuenta: sin respuesta en T_CORTO');
    ok('C04-b: PATCH config_cuenta HTTP 2xx', patchCfg?.status >= 200 && patchCfg?.status < 300);

    const rC04 = await supaAuth(
      `/rest/v1/config_cuenta?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&select=plantilla_pago`,
      jwt
    );
    console.log(`  [rest] plantilla_pago en DB: "${(rC04.body?.[0]?.plantilla_pago || '').slice(0, 60)}"`);
    ok('C04-c: plantilla_pago persiste en DB', rC04.body?.[0]?.plantilla_pago === plantillaTest);

    // ── C06: saveCuenta V9 → nombre persiste vía formulario real ─────────
    console.log('\n[C06] saveCuenta V9 → nombre persiste en tesorero_cuentas');
    await navegarConfig(page);

    const nombreTest = `Test-${EXEC_ID.slice(0, 6)} Tesorero`;

    const fNombre = page.locator('#cfg-usr-nombre');
    const tieneFormCuenta = await fNombre.count() > 0;
    ok('C06-a: control #cfg-usr-nombre presente en ruta config', tieneFormCuenta);
    if (!tieneFormCuenta) throw new Error('C06: #cfg-usr-nombre ausente — ¿la ruta config no está activa?');

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
    if (patchCuenta) console.log(`  [net] PATCH ${patchCuenta.url} → ${patchCuenta.status}`);
    else             console.error('  [net] PATCH tesorero_cuentas: sin respuesta en T_CORTO');
    ok('C06-b: PATCH tesorero_cuentas HTTP 2xx', patchCuenta?.status >= 200 && patchCuenta?.status < 300);

    const rC06 = await supaAuth(
      `/rest/v1/tesorero_cuentas?id=eq.${encodeURIComponent(CUENTA_ID)}&select=nombre`,
      jwt
    );
    console.log(`  [rest] nombre en DB: "${rC06.body?.[0]?.nombre}"`);
    ok('C06-c: nombre persiste en tesorero_cuentas', rC06.body?.[0]?.nombre === nombreTest);

  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server)  server.close();

    // Restaurar siempre — resultado se usa en ok() después del bloque finally
    if (jwt && CUENTA_ID) {
      if (plantillaModificada) {
        console.log('\n[C05/finally] Restaurar plantilla_pago original');
        resRestaurarPlantilla = await restaurarPlantilla(jwt, CUENTA_ID, plantillaOriginal);
      }
      if (nombreModificado) {
        console.log('\n[C07/finally] Restaurar nombre original');
        resRestaurarNombre = await restaurarNombre(jwt, CUENTA_ID, nombreOriginal);
      }
    }
  }

  // C05/C07 usan el resultado verificado de la restauración
  if (plantillaModificada)
    ok('C05: plantilla_pago restaurada y verificada por GET', resRestaurarPlantilla?.ok === true);
  if (nombreModificado)
    ok('C07: nombre restaurado y verificado por GET', resRestaurarNombre?.ok === true);

  console.log(`\n${'─'.repeat(56)}`);
  console.log(`📊 E11 Config Cuenta V9: ${pass} ✅  ${fail} ❌`);
  if (failures.length) {
    console.log('\nFallas:');
    failures.forEach(f => console.log('  •', f));
  }
  process.exit(fail > 0 ? 1 : 0);
})();
