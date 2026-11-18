/**
 * tests/e15_restauracion_sesion.js
 *
 * Suite Playwright E15 — Restauración de sesión y "Recordar mi acceso"
 *
 * Verifica que:
 *   1. Tras un login con "Recordar mi acceso" marcado, el contexto (cuentaId +
 *      alumnoId) se persiste en localStorage (NUNCA el PIN).
 *   2. Al recargar la página, el panel de acceso rápido aparece con el nombre
 *      del alumno.
 *   3. El usuario puede ingresar su PIN directamente (paso-pin) sin reingresar
 *      el código del curso.
 *   4. Con PIN incorrecto, el mensaje de error aparece y la sesión NO se abre.
 *   5. logoutLector (cerrar sesión de lector) conserva las claves V9 para el
 *      próximo auto-login.
 *   6. logout (cierre de sesión de tesorero) limpia TODAS las claves, incluyendo V9.
 *   7. "Ingresar con otro código" (limpiarSesionApoderado) borra el contexto V9.
 *
 * Tests:
 *   R01  Servidor local levantado y staging alcanzable
 *   R02  Login REST + cuenta descubierta
 *   R03  Búsqueda de alumno vía RPC apoderado_alumnos_curso (fixture)
 *   R04  Login apoderado con PIN correcto → sesión creada
 *   R05  "Recordar mi acceso" marcado: cuentaId + alumnoId en localStorage
 *   R06  PIN NO persistido en localStorage (seguridad)
 *   R07  Panel de acceso rápido visible tras recarga (nombre del alumno)
 *   R08  paso-pin visible directamente al hacer clic en "Ingresar a mi cuenta"
 *   R09  PIN incorrecto → error visible, sesión NO creada
 *   R10  PIN correcto vía acceso rápido → dashboard abierto
 *   R11  logoutLector conserva claves V9 en localStorage
 *   R12  logout (tesorero) limpia claves V9
 *   R13  "Ingresar con otro código" borra contexto V9
 *
 * Producción excluida.
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
const AP_CODIGO    = process.env.STAGING_AP_CODIGO    || '';  // código de curso de prueba
const AP_ALUMNO_ID = process.env.STAGING_AP_ALUMNO_ID || '';  // id del alumno de prueba
const AP_PIN       = process.env.STAGING_AP_PIN        || '';  // PIN válido del alumno

if (!SUPA_URL_RAW || !ANON_KEY || !USER_EMAIL || !USER_PASS) {
  console.error('❌ Faltan variables de entorno. Revisa .env.');
  process.exit(1);
}
if (!AP_CODIGO || !AP_ALUMNO_ID || !AP_PIN) {
  console.error('❌ Faltan AP_CODIGO, AP_ALUMNO_ID y AP_PIN en .env.');
  console.error('   Estos identifican al alumno de prueba para el flujo apoderado.');
  process.exit(1);
}

// ── Guardia de producción ────────────────────────────────────────────────────
const PROD_HOST    = 'tmjqzaakzhecbldebyeg.supabase.co';
const STAGING_HOST = 'rucgmytyxpfowznowxwd.supabase.co';

let parsedHost;
try { parsedHost = new URL(SUPA_URL_RAW).hostname; } catch(_) { process.exit(2); }
if (parsedHost === PROD_HOST || parsedHost !== STAGING_HOST) {
  console.error('❌ URL no autorizada:', parsedHost);
  process.exit(2);
}

const SUPA_URL = SUPA_URL_RAW;
const PORT     = 8805;

// ── Utilidades ──────────────────────────────────────────────────────────────
function apiUrl(path) {
  return `${SUPA_URL}/rest/v1${path}`;
}

async function apiFetch(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   opts.method || 'GET',
      headers:  opts.headers || {},
    };
    const req = lib.request(reqOpts, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

let results = [];
let passed = 0, failed = 0;
function ok(label, cond, detail = '') {
  results.push({ label, cond, detail });
  if (cond) { passed++; console.log(`  ✅ ${label}`); }
  else        { failed++; console.error(`  ❌ ${label}${detail ? ' — '+detail : ''}`); }
}

// ── Servidor local ──────────────────────────────────────────────────────────
let server;
function serveLocal(port) {
  const root = path.resolve(__dirname, '..');
  server = http.createServer((req, res) => {
    let filePath = path.join(root, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
    const ext  = path.extname(filePath);
    const mime = { '.html':'text/html', '.js':'application/javascript',
                   '.css':'text/css', '.json':'application/json' }[ext] || 'text/plain';
    let content = fs.readFileSync(filePath, 'utf8');
    // Reemplazar URLs de Supabase real por staging
    content = content.replace(/https:\/\/STAGING_SUPA_HOST/g, `https://${STAGING_HOST}`);
    content = content.replace(/wss:\/\/STAGING_SUPA_HOST/g,   `wss://${STAGING_HOST}`);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
  });
  return new Promise(r => server.listen(port, '127.0.0.1', r));
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n════════════════════════════════════════════');
  console.log(' E15 — Restauración de sesión / Recordar acceso');
  console.log('════════════════════════════════════════════\n');

  // R01 — Servidor local
  await serveLocal(PORT);
  ok('R01: servidor local en puerto '+PORT, true);

  // ── Autenticación REST (token del tesorero) ──────────────────────────────
  const authRes  = await apiFetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'apikey':       ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email: USER_EMAIL, password: USER_PASS }),
  });
  const authData = JSON.parse(authRes.body || '{}');
  const token    = authData.access_token;
  ok('R02: token REST obtenido', !!token);
  if (!token) { server?.close(); process.exit(1); }

  // Cabeceras comunes
  const H = { 'apikey': ANON_KEY, 'Authorization': 'Bearer '+token,
              'Content-Type': 'application/json', 'Accept': 'application/json' };

  // R03 — RPC apoderado_alumnos_curso
  const rpcRes = await apiFetch(`${SUPA_URL}/rest/v1/rpc/apoderado_alumnos_curso`, {
    method: 'POST',
    headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ p_codigo: AP_CODIGO }),
  });
  const rpcData = JSON.parse(rpcRes.body || '[]');
  const alumnoFound = Array.isArray(rpcData) && rpcData.some(a => a.id === AP_ALUMNO_ID || a.alumno_id === AP_ALUMNO_ID);
  ok('R03: RPC apoderado_alumnos_curso encuentra alumno fixture', alumnoFound,
     `codigo=${AP_CODIGO} alumnoId=${AP_ALUMNO_ID}`);

  if (!alumnoFound) {
    console.error('⚠️  No se puede continuar sin el alumno fixture.');
    server?.close(); process.exit(1);
  }

  // Obtener cuentaId del alumno en el RPC (lo necesitamos para los asserts de storage)
  const alumnoRow = rpcData.find(a => a.id === AP_ALUMNO_ID || a.alumno_id === AP_ALUMNO_ID);
  const CUENTA_ID = alumnoRow?.cuenta_id || alumnoRow?.cuentaId || '';
  ok('R03b: cuentaId extraído del RPC', !!CUENTA_ID, CUENTA_ID);

  // ── Pruebas Playwright ────────────────────────────────────────────────────
  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });

  try {
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });

    // Esperar que la app cargue el panel de login
    await page.waitForSelector('#panel-codigo, #l-codigo, [onclick="switchLoginTab(\'codigo\')"]', { timeout: 10000 })
      .catch(() => {});

    // Ir a la pestaña "Soy apoderado"
    const tabCodigo = page.locator('[onclick="switchLoginTab(\'codigo\')"]');
    if (await tabCodigo.count()) await tabCodigo.click();

    // ── R04: Login apoderado completo con PIN correcto ──────────────────────
    // Paso 1: ingresar código
    await page.waitForSelector('#l-codigo', { timeout: 5000 });
    await page.fill('#l-codigo', AP_CODIGO);
    await page.click('[onclick="doVerificarCodigo()"]');

    // Esperar al selector de alumno (paso 2)
    const paso2 = await page.waitForSelector('#paso-alumnos, #lista-alumnos-selector', { timeout: 8000 })
      .catch(() => null);
    ok('R04a: paso-alumnos visible', !!paso2);

    // Seleccionar alumno
    const alumnoEl = page.locator(`[data-alu-id="${AP_ALUMNO_ID}"], [onclick*="${AP_ALUMNO_ID}"]`).first();
    if (await alumnoEl.count()) {
      await alumnoEl.click();
    } else {
      // Fallback: tomar primer elemento de la lista
      const firstAlu = page.locator('#lista-alumnos-selector > *').first();
      if (await firstAlu.count()) await firstAlu.click();
    }

    // Ir al paso-pin
    const pasoPin = await page.waitForSelector('#paso-pin', { state: 'visible', timeout: 5000 })
      .catch(() => null);
    ok('R04b: paso-pin visible tras seleccionar alumno', !!pasoPin);
    if (!pasoPin) { server?.close(); await browser.close(); process.exit(1); }

    // Marcar "Recordar mi acceso"
    const checkbox = page.locator('#ap-recordar');
    const checkboxVisible = await checkbox.isVisible().catch(() => false);
    ok('R04c: checkbox #ap-recordar visible', checkboxVisible);
    if (checkboxVisible) await checkbox.check();

    // Ingresar PIN correcto
    await page.fill('#l-pin', AP_PIN);
    await page.click('[onclick="doAccesoCodigo()"]');

    // Esperar al dashboard (ruta 'dashboard')
    const dashboard = await page.waitForSelector('[data-route="dashboard"], #app[data-route="dashboard"], .dashboard', { timeout: 8000 })
      .catch(() => page.waitForFunction(() => window.S?.route === 'dashboard', { timeout: 8000 }).catch(() => null));
    const enDashboard = await page.evaluate(() => window.S?.route === 'dashboard' || document.title.includes('Tesorero'));
    ok('R04d: sesión abierta → dashboard', enDashboard);

    // ── R05: cuentaId + alumnoId en localStorage ────────────────────────────
    const v9Recordar = await page.evaluate(() =>
      localStorage.getItem('tesorero_ap_v9_recordar'));
    const v9CuentaId = await page.evaluate(() =>
      localStorage.getItem('tesorero_ap_v9_cuentaId'));
    const v9AluId    = await page.evaluate(() =>
      localStorage.getItem('tesorero_ap_v9_alumnoId'));
    const v9AluNombre= await page.evaluate(() =>
      localStorage.getItem('tesorero_ap_v9_alumnoNombre'));

    ok('R05a: v9_recordar=1 en localStorage', v9Recordar === '1');
    ok('R05b: cuentaId guardado en localStorage', !!v9CuentaId);
    ok('R05c: alumnoId guardado en localStorage', !!v9AluId);
    ok('R05d: alumnoNombre guardado en localStorage', !!v9AluNombre);

    // ── R06: PIN NO persistido ──────────────────────────────────────────────
    const keysConPin = await page.evaluate(() => {
      const peligrosas = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.includes('pin') || k.includes('PIN')) peligrosas.push(k);
      }
      return peligrosas;
    });
    ok('R06: PIN NO persistido en localStorage', keysConPin.length === 0,
       keysConPin.length > 0 ? 'claves peligrosas: '+keysConPin.join(', ') : '');

    // ── R07: Panel de acceso rápido visible tras recarga ────────────────────
    await page.reload({ waitUntil: 'domcontentloaded' });
    // Ir a pestaña apoderado si es necesario
    const tabCodigo2 = page.locator('[onclick="switchLoginTab(\'codigo\')"]');
    if (await tabCodigo2.count()) await tabCodigo2.click();

    const panelRapido = await page.waitForSelector('#panel-ap-rapido', { state: 'visible', timeout: 6000 })
      .catch(() => null);
    ok('R07: panel de acceso rápido visible tras recarga', !!panelRapido);
    if (panelRapido) {
      const nombrePanelText = await page.locator('#ap-rapido-nombre').textContent().catch(() => '');
      ok('R07b: nombre del alumno visible en panel rápido', !!nombrePanelText && nombrePanelText.length > 3,
         `texto="${nombrePanelText}"`);
    }

    // ── R08: Clic en "Ingresar a mi cuenta" → paso-pin directamente ─────────
    if (panelRapido) {
      const btnRapido = page.locator('[onclick="reingresarApoderado()"]');
      await btnRapido.click();
      const pinDirecto = await page.waitForSelector('#paso-pin', { state: 'visible', timeout: 4000 })
        .catch(() => null);
      ok('R08: paso-pin visible directamente (sin ingresar código)', !!pinDirecto);
      // paso-codigo debe estar oculto
      const codigoOculto = await page.evaluate(() => {
        const el = document.getElementById('paso-codigo');
        return el && (el.style.display === 'none' || el.offsetParent === null);
      });
      ok('R08b: paso-codigo oculto en acceso rápido', codigoOculto);
    } else {
      ok('R08: paso-pin visible directamente (skip — no hay panel rápido)', false, 'panel no encontrado');
      ok('R08b: paso-codigo oculto en acceso rápido', false, 'panel no encontrado');
    }

    // ── R09: PIN incorrecto → error visible ─────────────────────────────────
    await page.fill('#l-pin', '000000_incorrecto');
    await page.click('[onclick="doAccesoCodigo()"]');
    const pinErr = await page.waitForSelector('#pin-err', { state: 'visible', timeout: 5000 })
      .catch(() => null);
    ok('R09a: mensaje de error visible con PIN incorrecto', !!pinErr);
    const pinErrText = pinErr ? await page.locator('#pin-err').textContent() : '';
    ok('R09b: mensaje de error no vacío', !!pinErrText && pinErrText.trim().length > 0);
    // Sesión NO abierta
    const noSesion = await page.evaluate(() => !window.S?.session || !window.S?.session?.id?.startsWith('ap_v9'));
    ok('R09c: sesión NO creada con PIN incorrecto', noSesion);

    // ── R10: PIN correcto vía acceso rápido → dashboard ─────────────────────
    await page.fill('#l-pin', AP_PIN);
    await page.click('[onclick="doAccesoCodigo()"]');
    const dash2 = await page.waitForFunction(() => window.S?.route === 'dashboard', { timeout: 8000 })
      .catch(() => null);
    const enDash2 = await page.evaluate(() => window.S?.route === 'dashboard');
    ok('R10: acceso rápido con PIN correcto → dashboard', enDash2);

    // ── R11: logoutLector conserva claves V9 ───────────────────────────────
    await page.evaluate(() => { if (typeof logoutLector === 'function') logoutLector(); });
    await page.waitForTimeout(500);
    const v9RecordarPost = await page.evaluate(() =>
      localStorage.getItem('tesorero_ap_v9_recordar'));
    const v9CuentaPost   = await page.evaluate(() =>
      localStorage.getItem('tesorero_ap_v9_cuentaId'));
    ok('R11a: v9_recordar conservado tras logoutLector', v9RecordarPost === '1');
    ok('R11b: v9_cuentaId conservado tras logoutLector', !!v9CuentaPost);

    // ── R12: logout (tesorero) limpia claves V9 ─────────────────────────────
    // Para ejecutar logout(), necesitamos tener una sesión de tesorero.
    // Verificamos el comportamiento directamente desde JS.
    await page.evaluate(() => {
      // Simular claves presentes
      localStorage.setItem('tesorero_ap_v9_recordar', '1');
      localStorage.setItem('tesorero_ap_v9_cuentaId', 'test-cuenta');
      localStorage.setItem('tesorero_ap_v9_alumnoId', 'test-alu');
      // logout() debe limpiarlas
      if (typeof logout === 'function') logout();
    });
    await page.waitForTimeout(1000);
    const v9RecordarLogout = await page.evaluate(() =>
      localStorage.getItem('tesorero_ap_v9_recordar'));
    ok('R12: v9_recordar limpiado tras logout()', !v9RecordarLogout);

    // ── R13: limpiarSesionApoderado borra contexto V9 ───────────────────────
    // Re-poblar claves y llamar limpiarSesionApoderado
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      localStorage.setItem('tesorero_ap_v9_recordar', '1');
      localStorage.setItem('tesorero_ap_v9_cuentaId', 'test-cuenta');
    });
    // Navegar a la tab código para que el panel rápido esté disponible
    const tabCodigo3 = page.locator('[onclick="switchLoginTab(\'codigo\')"]');
    if (await tabCodigo3.count()) await tabCodigo3.click();
    await page.evaluate(() => {
      if (typeof limpiarSesionApoderado === 'function') limpiarSesionApoderado();
    });
    await page.waitForTimeout(300);
    const v9RecordarLimpiado = await page.evaluate(() =>
      localStorage.getItem('tesorero_ap_v9_recordar'));
    ok('R13: v9_recordar limpiado tras limpiarSesionApoderado()', !v9RecordarLimpiado);

  } finally {
    await browser.close();
    if (server) server.close();
  }

  // ── Resumen ─────────────────────────────────────────────────────────────
  console.log('\n────────────────────────────────────────────');
  console.log(` RESULTADO: ${passed}/${passed+failed} pruebas pasaron`);
  if (failed > 0) {
    console.log('\n Fallos:');
    results.filter(r => !r.cond).forEach(r =>
      console.error(`   ❌ ${r.label}${r.detail ? ' — '+r.detail : ''}`));
  }
  console.log('────────────────────────────────────────────\n');
  process.exit(failed > 0 ? 1 : 0);
})();
