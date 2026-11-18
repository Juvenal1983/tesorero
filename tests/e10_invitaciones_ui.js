/**
 * tests/e10_invitaciones_ui.js
 *
 * Suite Playwright B1 — Invitaciones V9: CRUD completo sobre `codigos_invitacion`.
 *
 * Verifica:
 *   I01  Servidor local levantado
 *   I02  Login UI completado (_v9CuentaId disponible)
 *   I03  Crear código vía UI (modal real) → fila en DB (para, tipo, activo=true)
 *   I04  Código persiste tras reload: sesión completa + ruta config + cache cargada + código en HTML
 *   I05  Desactivar código: captura PATCH (URL/método/estado/body), awaita confirmación,
 *        GET por ID exacto → activo=false
 *   I06  Crear 2° código vía REST + sincronizarCodigosDesdeSupabase → aparece en UI
 *   I07  Eliminar código → ausente en DB (awaita DELETE, verifica por ID exacto)
 *   I08  Limpieza: GET verifica ausencia real de ambos fixtures (no solo HTTP 204)
 *
 * Patrón: igual que E8 — login REST para fixtures, login UI para comportamiento,
 * intercepción de red para mutaciones, poll REST para verificación, EXEC_ID para aislamiento.
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

const EXEC_ID = Date.now().toString(36);
// El campo `para` es el identificador de búsqueda — el codigo se genera aleatoriamente
const PARA1   = `testb1-1-${EXEC_ID}`;
const PARA2   = `testb1-2-${EXEC_ID}`;
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

// ── Servidor HTTP local (igual que E8) ────────────────────────────────────────

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

/** Registra todos los errores HTTP (4xx/5xx) con URL y método para diagnóstico.
 *  Cumple el requisito: "registra URL y método para saber si corresponde a una
 *  operación del módulo o a un recurso independiente." */
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

/** Navegar a la sección de config (donde vive la gestión de invitaciones) */
async function navegarConfig(page) {
  await page.evaluate(() => { if (typeof go === 'function') go('config'); });
  await page.waitForFunction(() => window.S?.route === 'config', { timeout: T_CORTO });
}

/**
 * Espera la primera respuesta de Supabase para tabla+método dados.
 * Resuelve { status, body, url } o null si no llega antes del timeout.
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
        resolve({ status, body, url });
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

async function limpiarCodigos(jwt) {
  if (!CUENTA_ID) return;
  // Eliminar por para (campo identificador de test)
  const r = await supaAuth(
    `/rest/v1/codigos_invitacion?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&para=like.*${EXEC_ID}*`,
    jwt, { method: 'DELETE', prefer: 'return=minimal' }
  );
  console.log(`  🧹 DELETE por para: HTTP ${r.status}`);
  // También por id que contiene EXEC_ID (fixture I06)
  const r2 = await supaAuth(
    `/rest/v1/codigos_invitacion?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&id=like.*${EXEC_ID}*`,
    jwt, { method: 'DELETE', prefer: 'return=minimal' }
  );
  console.log(`  🧹 DELETE por id: HTTP ${r2.status}`);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  E10 B1 — Playwright: Invitaciones V9');
  console.log('══════════════════════════════════════════════════════════════\n');
  console.log(`EXEC_ID  : ${EXEC_ID}`);
  console.log(`Staging  : ${SUPA_URL}`);
  console.log(`Para1    : ${PARA1}`);
  console.log(`Para2    : ${PARA2}`);

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
  let codigoGenerado1 = null; // valor del campo `codigo` generado por la app
  let fila03Id = null;        // ID de la fila en DB; fijado en I03 para verificaciones exactas

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
    // Registrar todos los errores HTTP con URL y método (requisito de revisión)
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
      ok('I02: login completado (_v9CuentaId disponible)', true);
    } catch (_) {
      ok('I02: login completado', false);
      throw new Error('Login UI no completó');
    }

    // ── I03: Crear código vía UI (modal real) → verificar DB ─────────────
    console.log('\n[I03] Crear código vía UI → fila en DB');
    await navegarConfig(page);

    // Abrir modal de nuevo código (tipo prueba)
    await page.evaluate(() => {
      if (typeof showModal === 'function') showModal('nuevoCodigoModal', { tipo: 'prueba' });
    });
    // Esperar que el modal sea visible con #cod-para
    await page.waitForSelector('#cod-para', { state: 'visible', timeout: T_CORTO });

    // Llenar campo "para" con identificador de test
    await page.fill('#cod-para', PARA1);

    // Confirmar generación — interceptDialogs acepta los confirm automáticamente
    await page.evaluate(() => {
      if (typeof crearCodigoConDatos === 'function') crearCodigoConDatos('prueba');
    });
    await page.waitForTimeout(2000);

    // Poll REST — buscar por cuenta_id + para
    const r03 = await supaAuth(
      `/rest/v1/codigos_invitacion?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&para=eq.${encodeURIComponent(PARA1)}&select=id,codigo,para,tipo,activo`,
      jwt
    );
    ok('I03-a: GET codigos responde 200', r03.status === 200);
    const fila03 = Array.isArray(r03.body) ? r03.body[0] : null;
    ok('I03-b: fila insertada en DB', !!fila03);
    ok('I03-c: para correcto', fila03?.para === PARA1);
    ok('I03-d: activo=true por defecto', fila03?.activo === true);
    codigoGenerado1 = fila03?.codigo || null;
    fila03Id        = fila03?.id    || null;
    console.log(`  Código generado: ${codigoGenerado1}`);
    console.log(`  ID fila DB:      ${fila03Id}`);

    // ── I04: Código persiste tras reload ──────────────────────────────────
    // Requisito: sesión completa, ruta config, carga relacional de códigos,
    //            invitación exacta creada visible en UI.
    console.log('\n[I04] Código persiste tras reload (sesión + ruta + cache + HTML)');
    await page.reload({ waitUntil: 'load', timeout: T_LARGO });
    await waitAppReady(page);
    await reloginViaUI(page);

    // 1. Esperar _v9CuentaId === CUENTA_ID explícitamente, con o sin re-login.
    //    reloginViaUI solo espera cuando hay formulario visible; si la sesión
    //    persiste retorna de inmediato y la inicialización V9 puede seguir corriendo.
    //    _authToken se asigna ANTES de que _v9CuentaId quede fijado (arranque.js),
    //    por lo que esta espera garantiza también que _invToken() devuelva algo válido
    //    cuando llegue I05 (evita el fallback local sin PATCH).
    await page.waitForFunction(
      cuentaId => window.S?._v9CuentaId === cuentaId,
      CUENTA_ID,
      { timeout: T_LARGO }
    ).catch(() => {});
    const cuentaIdPost = await page.evaluate(() => window.S?._v9CuentaId || null);
    ok('I04-a: sesión completa tras reload (_v9CuentaId === CUENTA_ID)',
      cuentaIdPost === CUENTA_ID);

    // 2. Ruta activa es 'config'
    await navegarConfig(page);
    const rutaActual = await page.evaluate(() => window.S?.route || '');
    ok('I04-b: ruta "config" activa tras reload', rutaActual === 'config');

    // 3. Esperar carga relacional — cargarSesionV9 llama recargarCodigosV9 async;
    //    waitForFunction asegura que la caché tenga el código exacto antes de leer HTML.
    if (codigoGenerado1) {
      await page.waitForFunction(
        codigo => !!(window.DB?.config?.codigosInvitacion || []).find(c => c.codigo === codigo),
        codigoGenerado1,
        { timeout: T_LARGO }
      ).catch(() => {}); // si no llega, el ok lo captura
    }
    const codCargado = await page.evaluate(
      codigo => !!(window.DB?.config?.codigosInvitacion || []).find(c => c.codigo === codigo),
      codigoGenerado1
    );
    ok('I04-c: codigosInvitacion cargados (código exacto en cache)', codCargado);

    // 4. Código exacto visible en HTML
    const html04 = await page.locator('#contenido, main, body').innerHTML().catch(() => '');
    ok('I04-d: código exacto visible en UI (codigoGenerado1)',
      !!(codigoGenerado1 && html04.includes(codigoGenerado1)));

    // ── I05: Desactivar código ────────────────────────────────────────────
    // Requisito: capturar PATCH (URL, método, estado HTTP, body), esperar su
    //            confirmación antes del GET, verificar activo=false por ID exacto.
    console.log('\n[I05] Desactivar código → captura PATCH → activo=false por ID exacto');
    if (codigoGenerado1 && fila03Id) {
      // Preparar listener ANTES de disparar la operación
      const promesaPatch = esperarRespuestaSupabase(page, 'codigos_invitacion', 'PATCH', T_CORTO);

      // desactivarCodigoPorCodigo es async — awaitar la Promise desde page.evaluate
      await page.evaluate(async codigo => {
        if (typeof desactivarCodigoPorCodigo === 'function') await desactivarCodigoPorCodigo(codigo);
      }, codigoGenerado1);

      // Esperar captura PATCH — su llegada confirma que la operación terminó
      const patchCapture = await promesaPatch;
      if (patchCapture) {
        console.log(`  [net] PATCH ${patchCapture.url} → ${patchCapture.status}`);
        if (patchCapture.body !== null) console.log(`  [net] body: ${JSON.stringify(patchCapture.body).slice(0, 120)}`);
      } else {
        console.error('  [net] PATCH codigos_invitacion: sin respuesta en T_CORTO');
      }
      ok('I05-a: PATCH HTTP 2xx', patchCapture?.status >= 200 && patchCapture?.status < 300);

      // GET por ID exacto de fila03 — no por `para` para evitar ambigüedad
      const r05 = await supaAuth(
        `/rest/v1/codigos_invitacion?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&id=eq.${encodeURIComponent(fila03Id)}&select=id,activo`,
        jwt
      );
      console.log(`  [rest] GET por ID: HTTP ${r05.status}, body: ${JSON.stringify(r05.body)}`);
      ok('I05-b: GET por ID exacto responde 200', r05.status === 200);
      ok('I05-c: activo=false en DB (por ID exacto)', r05.body?.[0]?.activo === false);
    } else {
      ok('I05-a: (BLOQUEADO — código/id no hallado en I03)', false);
      ok('I05-b: (BLOQUEADO)', false);
      ok('I05-c: (BLOQUEADO)', false);
    }

    // ── I06: Crear 2° código vía REST + sincronizar ───────────────────────
    console.log('\n[I06] Crear 2° código REST → sincronizar → aparece en UI');
    // Generar un código con formato estándar de la app (3 segmentos de 4 chars)
    const codigo2 = `TEST-${EXEC_ID.toUpperCase().slice(0,4)}-B1`;
    const payload06 = {
      cuenta_id: CUENTA_ID,
      id:        `ci-b1-2-${EXEC_ID}`,
      codigo:    codigo2,
      para:      PARA2,
      tipo:      'prueba',
      activo:    true,
      usado:     false,
    };
    const r06ins = await supaAuth(
      `/rest/v1/codigos_invitacion`,
      jwt,
      { method: 'POST', body: payload06, prefer: 'return=representation' }
    );
    ok('I06-a: fixture 2° código insertado REST', r06ins.status === 201 || r06ins.status === 200);

    // Sincronizar desde UI — recargarCodigosV9 actualiza la lista
    await page.evaluate(() => {
      if (typeof sincronizarCodigosDesdeSupabase === 'function') return sincronizarCodigosDesdeSupabase();
      if (typeof recargarCodigosV9 === 'function') return recargarCodigosV9(false);
    });
    await page.waitForTimeout(2000);

    // Volver a config para que renderPage() refresque la vista
    await navegarConfig(page);
    const html06 = await page.locator('#contenido, main, body').innerHTML().catch(() => '');
    ok('I06-b: PARA2 o codigo2 visible tras sincronizar',
      html06.includes(PARA2) || html06.includes(codigo2)
    );

    // ── I07: Eliminar código ──────────────────────────────────────────────
    // Captura DELETE y verifica por ID exacto.
    console.log('\n[I07] Eliminar código → ausente en DB (por ID exacto)');
    if (codigoGenerado1 && fila03Id) {
      const promesaDelete = esperarRespuestaSupabase(page, 'codigos_invitacion', 'DELETE', T_CORTO);

      // eliminarCodigoPorCodigo recibe el string del código
      await page.evaluate(async codigo => {
        if (typeof eliminarCodigoPorCodigo === 'function') await eliminarCodigoPorCodigo(codigo);
      }, codigoGenerado1);

      const deleteCapture = await promesaDelete;
      if (deleteCapture) {
        console.log(`  [net] DELETE ${deleteCapture.url} → ${deleteCapture.status}`);
      } else {
        // La app acepta los confirm vía interceptDialogs; si el DELETE tarda más,
        // dar margen extra antes del GET.
        await page.waitForTimeout(2000);
      }
      ok('I07-a: DELETE HTTP 2xx', deleteCapture ? deleteCapture.status >= 200 && deleteCapture.status < 300 : null);

      // GET por ID exacto
      const r07 = await supaAuth(
        `/rest/v1/codigos_invitacion?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&id=eq.${encodeURIComponent(fila03Id)}&select=id`,
        jwt
      );
      ok('I07-b: GET confirma ausencia por ID exacto', Array.isArray(r07.body) && r07.body.length === 0);
    } else {
      ok('I07-a: (BLOQUEADO)', false);
      ok('I07-b: (BLOQUEADO)', false);
    }

  } finally {
    // ── I08: Limpieza staging + verificación por GET ──────────────────────
    // Requisito: "HTTP 204 no basta" — verificar ausencia real de ambos fixtures.
    console.log('\n[I08] Limpieza staging + verificación GET de ambos fixtures');
    try {
      const jwtPost = await loginTesorero();
      await limpiarCodigos(jwtPost);

      // Verificación real: GET por `para` (fixture PARA1 — código UI)
      const rCheck1 = await supaAuth(
        `/rest/v1/codigos_invitacion?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&para=like.*${EXEC_ID}*&select=id,para`,
        jwtPost
      );
      console.log(`  [check] GET por para: HTTP ${rCheck1.status}, filas: ${Array.isArray(rCheck1.body) ? rCheck1.body.length : '?'}`);
      if (Array.isArray(rCheck1.body) && rCheck1.body.length > 0)
        console.error(`  [check] Fixtures por para aún presentes: ${JSON.stringify(rCheck1.body)}`);
      ok('I08-a: fixture PARA1 ausente en DB (GET por para)',
        rCheck1.status === 200 && Array.isArray(rCheck1.body) && rCheck1.body.length === 0);

      // Verificación real: GET por `id` (fixture I06 — código REST con id=ci-b1-2-EXEC_ID)
      const rCheck2 = await supaAuth(
        `/rest/v1/codigos_invitacion?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&id=like.*${EXEC_ID}*&select=id`,
        jwtPost
      );
      console.log(`  [check] GET por id: HTTP ${rCheck2.status}, filas: ${Array.isArray(rCheck2.body) ? rCheck2.body.length : '?'}`);
      if (Array.isArray(rCheck2.body) && rCheck2.body.length > 0)
        console.error(`  [check] Fixtures por id aún presentes: ${JSON.stringify(rCheck2.body)}`);
      ok('I08-b: fixture por id (I06) ausente en DB (GET por id)',
        rCheck2.status === 200 && Array.isArray(rCheck2.body) && rCheck2.body.length === 0);

    } catch (e) {
      console.error('  ⚠️  limpieza:', e.message);
      ok('I08-a: limpieza', false);
      ok('I08-b: limpieza', false);
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
