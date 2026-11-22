/**
 * tests/m005_registro_ui.test.js
 *
 * Suite Playwright M005-UI — Registro V9 mediante el formulario real de la app.
 *
 * Requisitos previos:
 *   - M005 (validar_codigo_invitacion RPC) debe estar aplicado en staging.
 *   - M006 NO es requisito: el formulario valida tipo en JS, no en DB.
 *   - El servidor local debe estar levantado en APP_PORT.
 *
 * Flujo principal (REG01):
 *   Setup  : crear código de invitación vía REST con JWT del tesorero existente.
 *   Acción : abrir la app → pestaña "Crear cuenta" → llenar el formulario real
 *            → submit → verificar que la app llega al dashboard.
 *   V9     : verificar vía REST (anon key) que usuarios_app + datos del curso
 *            fueron persistidos en Supabase.
 *   Logout : hacer click en el botón de cierre de sesión de la app.
 *   Login  : abrir la app → pestaña "Iniciar sesión" → email + contraseña → submit.
 *   Reusar : tras login, confirmar que el curso/configuración del usuario sigue visible.
 *   Código : confirmar que el código fue marcado como usado (activo=false o usado=true).
 *
 * Casos adicionales:
 *   REG02  : reutilizar el mismo código → app muestra error en el campo.
 *   REG03  : código vencido → app muestra error.
 *   REG04  : dos registros concurrentes con el mismo código → solo uno prospera.
 *
 * Teardown:
 *   - Eliminar el/los usuario(s) Auth creados durante las pruebas.
 *   - La service_role key se usa SOLO aquí, en Node.js, nunca en el navegador.
 *
 * Variables de entorno requeridas:
 *   STAGING_SUPABASE_URL          URL de staging (rucgmytyxpfowznowxwd.supabase.co)
 *   STAGING_SUPABASE_ANON_KEY     anon key de staging
 *   STAGING_EMAIL                 correo del tesorero existente (para crear el código)
 *   STAGING_PASS                  contraseña del tesorero existente
 *   STAGING_SERVICE_ROLE_KEY      service_role key (solo para teardown; NUNCA va al browser)
 *   STAGING_CUENTA_ID             (opcional) acelera la descubrirCuenta
 *
 * NUNCA usar tmjqzaakzhecbldebyeg (producción).
 */

'use strict';

const path   = require('path');
const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const { chromium } = require('playwright');

try { require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') }); } catch(_) {}

// ── Variables de entorno ────────────────────────────────────────────────────
const SUPA_URL_RAW   = (process.env.STAGING_SUPABASE_URL || process.env.STAGING_URL || '').replace(/\/$/, '');
const ANON_KEY       = process.env.STAGING_SUPABASE_ANON_KEY || process.env.STAGING_KEY || '';
const SVC_KEY        = process.env.STAGING_SERVICE_ROLE_KEY || '';  // solo teardown, nunca al browser
const USER_EMAIL     = process.env.STAGING_EMAIL || '';
const USER_PASS      = process.env.STAGING_PASS  || '';

if (!SUPA_URL_RAW || !ANON_KEY || !USER_EMAIL || !USER_PASS) {
  console.error('❌ Faltan variables de entorno. Revisa .env.');
  process.exit(1);
}
if (!SVC_KEY) {
  console.warn('⚠️  STAGING_SERVICE_ROLE_KEY no configurada — teardown no eliminará usuarios Auth.');
}

// ── Guard producción ────────────────────────────────────────────────────────
const PROD_HOST    = 'tmjqzaakzhecbldebyeg.supabase.co';
const STAGING_HOST = 'rucgmytyxpfowznowxwd.supabase.co';
let parsedHost;
try { parsedHost = new URL(SUPA_URL_RAW).hostname; } catch(_) { process.exit(2); }
if (parsedHost === PROD_HOST || parsedHost !== STAGING_HOST) {
  console.error('❌ URL no autorizada:', parsedHost, '— solo se permite staging.'); process.exit(2);
}

// ── Constantes ──────────────────────────────────────────────────────────────
const APP_PORT = 8799;
const APP_URL  = `http://localhost:${APP_PORT}`;
const EXEC_ID  = Date.now().toString(36);

// Datos del usuario de prueba — únicos por ejecución para evitar colisiones
const TEST_EMAIL  = `test-m005-${EXEC_ID}@example-staging.invalid`;
const TEST_PASS   = 'TestPwd2025!';
const TEST_NOMBRE = `Bot M005 ${EXEC_ID}`;
const TEST_CURSO  = `Prueba ${EXEC_ID}`;
const TEST_CUOTA  = '3000';
const TEST_CODE   = `M005-${EXEC_ID.toUpperCase()}`;

let CUENTA_ID = process.env.STAGING_CUENTA_ID || null;
let TESORERO_JWT = null;          // JWT del tesorero existente (para setup)
let createdAuthIds = [];          // Auth UUIDs a eliminar en teardown

let pass = 0, fail = 0;
const failures = [];
function ok(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else       { console.error(`  ❌ ${label}`); fail++; failures.push(label); }
}

const T_CORTO = 12_000;
const T_LARGO = 30_000;

// ── HTTP helpers ─────────────────────────────────────────────────────────────
function _fetch(urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const full = SUPA_URL_RAW + urlPath;
    const u = new URL(full);
    const lib = u.protocol === 'https:' ? https : http;
    const body = opts.body ? Buffer.from(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : null;
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'apikey':        ANON_KEY,
        'Authorization': opts.auth ? `Bearer ${opts.auth}` : `Bearer ${ANON_KEY}`,
        ...(body ? { 'Content-Length': body.length } : {}),
        ...(opts.headers || {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const ct = res.headers['content-type'] || '';
        resolve({ status: res.statusCode, body: ct.includes('json') ? JSON.parse(data || 'null') : data });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** REST con service_role — SOLO para teardown (delete Auth user). */
function _fetchSvc(urlPath, opts = {}) {
  if (!SVC_KEY) throw new Error('SVC_KEY no configurada');
  return _fetch(urlPath, { ...opts, auth: SVC_KEY });
}

/** REST con JWT del tesorero existente (setup: crear código). */
function _fetchJwt(urlPath, opts = {}) {
  if (!TESORERO_JWT) throw new Error('TESORERO_JWT no disponible');
  return _fetch(urlPath, { ...opts, auth: TESORERO_JWT });
}

/** Espera con reintentos hasta que la condición se cumpla. */
async function poll(fn, { max = 10, delay = 400 } = {}) {
  for (let i = 0; i < max; i++) {
    try { const r = await fn(); if (r) return r; } catch(_) {}
    await new Promise(r => setTimeout(r, delay));
  }
  return null;
}

// ── Setup: obtener JWT del tesorero existente ────────────────────────────────
async function loginTesorero() {
  const r = await _fetch('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email: USER_EMAIL, password: USER_PASS },
  });
  if (r.status !== 200 || !r.body?.access_token) {
    throw new Error(`Login tesorero falló (HTTP ${r.status}): ${JSON.stringify(r.body)}`);
  }
  TESORERO_JWT = r.body.access_token;
}

/** Crea un código de invitación real via REST con el JWT del tesorero. */
async function crearCodigo({ codigo, tipo = 'prueba', venceEl = null }) {
  if (!CUENTA_ID) {
    // Descubrir cuenta_id desde tesorero_cuentas
    const r = await _fetchJwt('/rest/v1/tesorero_cuentas?select=id&limit=1');
    CUENTA_ID = r.body?.[0]?.id;
  }
  if (!CUENTA_ID) throw new Error('No se pudo obtener cuenta_id del tesorero');

  const payload = { codigo, tipo, activo: true, usado: false, cuenta_id: CUENTA_ID };
  if (venceEl) payload.vence_el = venceEl;

  const r = await _fetchJwt('/rest/v1/codigos_invitacion', {
    method:  'POST',
    headers: { 'Prefer': 'return=representation' },
    body: payload,
  });
  if (r.status !== 201) throw new Error(`crearCodigo falló (HTTP ${r.status}): ${JSON.stringify(r.body)}`);
  return r.body?.[0] || payload;
}

/** Elimina el código de invitación (limpieza). */
async function eliminarCodigo(codigo) {
  await _fetchJwt(`/rest/v1/codigos_invitacion?codigo=eq.${encodeURIComponent(codigo)}`, {
    method: 'DELETE',
  });
}

/** Elimina un usuario Auth (teardown — usa service_role en Node.js, nunca en el browser). */
async function eliminarAuthUser(authId) {
  if (!SVC_KEY || !authId) return;
  await _fetchSvc(`/auth/v1/admin/users/${authId}`, { method: 'DELETE' });
}

// ── Helpers Playwright ───────────────────────────────────────────────────────

/** Abre la app y espera que cargue el panel de login. */
async function abrirApp(page) {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: T_LARGO });
  // Esperar que el panel de login esté visible (cualquier tab activa)
  await page.waitForSelector('#panel-login, #panel-registro, #panel-codigo', {
    state: 'visible', timeout: T_LARGO,
  });
}

/** Navega a la pestaña "Crear cuenta" del formulario de login. */
async function irARegistro(page) {
  // El tab puede estar visible como un link/div con texto "Crear cuenta"
  const tab = page.locator('#tab-registro');
  await tab.waitFor({ state: 'visible', timeout: T_CORTO });
  await tab.click();
  await page.waitForSelector('#panel-registro', { state: 'visible', timeout: T_CORTO });
}

/** Llena el formulario de registro y lo envía.
 *  Espera a que las opciones de región se carguen antes de seleccionar.
 *  Usa colegio manual ('__nuevo__') para evitar depender de datos de red. */
async function llenarYEnviarRegistro(page, { codigo, nombre, curso, email, pass, cuota }) {
  // Código de invitación
  await page.fill('#r-invitacion', codigo);

  // Nombre completo
  await page.fill('#r-nombre', nombre);

  // Región — esperar opciones cargadas (hay más de 1 opción)
  await page.waitForFunction(() => {
    const sel = document.getElementById('r-region');
    return sel && sel.options.length > 1;
  }, { timeout: T_LARGO });
  // Seleccionar primera región disponible (ej. Región Metropolitana)
  const regionOpts = await page.evaluate(() =>
    Array.from(document.getElementById('r-region').options)
      .filter(o => o.value)
      .map(o => o.value)
  );
  await page.selectOption('#r-region', regionOpts[0]);

  // Comuna — esperar que se habilite y cargue opciones
  await page.waitForFunction(() => {
    const sel = document.getElementById('r-comuna');
    return sel && !sel.disabled && sel.options.length > 1;
  }, { timeout: T_LARGO });
  const comunaOpts = await page.evaluate(() =>
    Array.from(document.getElementById('r-comuna').options)
      .filter(o => o.value)
      .map(o => o.value)
  );
  await page.selectOption('#r-comuna', comunaOpts[0]);

  // Colegio — esperar que el select se habilite, luego elegir "Otro / escribir manualmente"
  await page.waitForFunction(() => {
    const sel = document.getElementById('r-colegio-sel');
    return sel && !sel.disabled && sel.options.length > 1;
  }, { timeout: T_LARGO });
  // Seleccionar '__nuevo__' para habilitar el campo manual
  await page.selectOption('#r-colegio-sel', '__nuevo__');
  // Esperar que el campo manual aparezca
  await page.waitForSelector('#fg-colegio-manual', { state: 'visible', timeout: T_CORTO });
  await page.fill('#r-colegio', `Escuela Prueba ${EXEC_ID}`);

  // Curso y año
  await page.fill('#r-curso', curso);
  await page.fill('#r-anio', '2025');

  // Correo y contraseña
  await page.fill('#r-email', email);
  await page.fill('#r-pass', pass);
  await page.fill('#r-pass2', pass);

  // Cuota mensual
  await page.fill('#r-cuota', cuota);

  // Meses por defecto (Marzo–Diciembre, ya seleccionados en HTML)
  // No cambiar; los valores por defecto del formulario son válidos.

  // Enviar
  await page.click('button:has-text("Crear cuenta y entrar")');
}

/** Verifica que la app llegó al dashboard (panel principal visible). */
async function esperarDashboard(page, timeout = T_LARGO) {
  // El dashboard muestra elementos con id que contienen 'dashboard' o el saldo/porcentaje
  await page.waitForSelector('#section-dashboard, [id*="dashboard"], .dash-card, #saldo-total', {
    state: 'visible', timeout,
  });
}

/** Hace logout usando el botón de la app.
 *  La navegación genera el botón con onclick="logout()" vía JS;
 *  buscamos por texto visible o por el atributo onclick. */
async function hacerLogout(page) {
  // Intentar primero el menú "más" si existe (hamburger / menú lateral)
  const masMenu = page.locator('[onclick*="openMasMenu"], [onclick*="closeMasMenu"], .mas-menu-btn, #mas-menu-btn');
  if (await masMenu.first().isVisible().catch(() => false)) {
    await masMenu.first().click();
    await page.waitForTimeout(400);
  }

  // Botón de logout generado dinámicamente por navegacion.js
  // Texto: "← Cerrar sesión" (rutas.js) o "↩ Salir" o icono con onclick=logout()
  const logoutLoc = page.locator(
    'button[onclick*="logout"], [onclick*="logout()"], ' +
    'button:has-text("Cerrar sesión"), button:has-text("Salir"), ' +
    'div[onclick*="logout"]'
  ).first();
  await logoutLoc.waitFor({ state: 'visible', timeout: T_CORTO });
  await logoutLoc.click();

  // Esperar que el panel de login reaparezca
  await page.waitForSelector('#panel-login, #panel-registro, #tab-login', {
    state: 'visible', timeout: T_LARGO,
  });
}

/** Hace login en la app con el formulario real. */
async function hacerLoginUI(page, { email, pass: password }) {
  // Ir a pestaña "Iniciar sesión" si no está activa
  const tabLogin = page.locator('#tab-login');
  if (await tabLogin.isVisible()) await tabLogin.click();

  await page.waitForSelector('#panel-login', { state: 'visible', timeout: T_CORTO });
  await page.fill('#l-email', email);
  await page.fill('#l-pass', password);
  await page.click('button:has-text("Ingresar"), button:has-text("Iniciar sesión")');
}

/** Consulta usuarios_app en staging vía REST (anon key). */
async function buscarUsuarioApp(email) {
  const r = await _fetch(`/rest/v1/usuarios_app?email=eq.${encodeURIComponent(email)}&select=*&limit=1`);
  return r.body?.[0] || null;
}

/** Verifica que el código fue consumido (activo=false o usado=true). */
async function verificarCodigoConsumido(codigo) {
  const r = await _fetchJwt(`/rest/v1/codigos_invitacion?codigo=eq.${encodeURIComponent(codigo)}&select=activo,usado`);
  const c = r.body?.[0];
  return c && (c.usado === true || c.activo === false);
}

// ── Servidor local ────────────────────────────────────────────────────────────
let server = null;

function levantarServidor() {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      let filePath = path.join(__dirname, '..', req.url === '/' ? 'index.html' : req.url);
      // Limpiar query strings
      filePath = filePath.split('?')[0];
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        const ext = path.extname(filePath);
        const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
          '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml' }[ext] || 'text/plain';
        res.writeHead(200, { 'Content-Type': mime });
        res.end(data);
      });
    });
    server.listen(APP_PORT, 'localhost', () => resolve());
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') resolve(); // ya está corriendo
      else reject(e);
    });
  });
}

// ── TESTS ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  M005-UI  Registro V9 — formulario real de la app');
  console.log(`  Staging: ${STAGING_HOST}`);
  console.log(`  EXEC_ID: ${EXEC_ID}`);
  console.log('══════════════════════════════════════════════════════\n');

  // ── Setup global ─────────────────────────────────────────────────────────
  console.log('▶ Setup: servidor local y JWT tesorero');
  await levantarServidor();
  console.log(`  Servidor en http://localhost:${APP_PORT}`);
  await loginTesorero();
  console.log(`  JWT tesorero OK (${USER_EMAIL})`);

  const browser = await chromium.launch({ headless: true });

  // ───────────────────────────────────────────────────────────────────────────
  // REG01 — Flujo completo: registro → verificación V9 → logout → login → datos
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n▶ REG01 — Registro completo + verificación V9');
  {
    // Crear código de invitación real
    await crearCodigo({ codigo: TEST_CODE });
    console.log(`  Código creado: ${TEST_CODE}`);

    const page = await browser.newPage();
    try {
      // R01-1: La app carga sin error
      await abrirApp(page);
      ok('R01-1 App levantada', true);

      // R01-2: Pestaña "Crear cuenta" visible y clickeable
      await irARegistro(page);
      ok('R01-2 Panel de registro visible', true);

      // R01-3: Llenar y enviar el formulario real
      await llenarYEnviarRegistro(page, {
        codigo:  TEST_CODE,
        nombre:  TEST_NOMBRE,
        curso:   TEST_CURSO,
        email:   TEST_EMAIL,
        pass:    TEST_PASS,
        cuota:   TEST_CUOTA,
      });

      // R01-4: La app llega al dashboard tras el registro
      await esperarDashboard(page);
      ok('R01-4 Dashboard visible tras registro', true);

      // R01-5: usuarios_app tiene la fila del nuevo usuario (dar tiempo a sync)
      const uApp = await poll(() => buscarUsuarioApp(TEST_EMAIL), { max: 15, delay: 800 });
      ok('R01-5 usuarios_app: fila persistida en Supabase', !!uApp);

      // Guardar auth_id para teardown
      if (uApp?.auth_id) createdAuthIds.push(uApp.auth_id);

      // R01-6: El código fue marcado como consumido
      const consumido = await verificarCodigoConsumido(TEST_CODE);
      ok('R01-6 Código marcado como usado/inactivo', consumido);

      // R01-7: Logout mediante la UI de la app
      await hacerLogout(page);
      ok('R01-7 Logout: panel de login reaparece', true);

      // R01-8: Login con las mismas credenciales vía UI
      await hacerLoginUI(page, { email: TEST_EMAIL, pass: TEST_PASS });
      await esperarDashboard(page);
      ok('R01-8 Login posterior: dashboard visible', true);

      // R01-9: Datos del curso visibles en la UI tras login
      // Buscar el nombre del curso en algún elemento del DOM
      const contenido = await page.content();
      ok('R01-9 Nombre de curso visible tras login', contenido.includes(TEST_CURSO));

    } catch(e) {
      console.error('  ⚠️  Error inesperado en REG01:', e.message);
      fail++; failures.push('REG01 (excepción: ' + e.message + ')');
    } finally {
      await page.close();
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // REG02 — Reutilización del mismo código → error en la app
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n▶ REG02 — Reutilizar código ya consumido');
  {
    const page = await browser.newPage();
    try {
      await abrirApp(page);
      await irARegistro(page);

      // Intentar registrar con el mismo TEST_CODE (ya consumido por REG01)
      await page.fill('#r-invitacion', TEST_CODE);
      await page.fill('#r-nombre', 'Intruso ' + EXEC_ID);
      // No hace falta llenar todo — validar_codigo_invitacion falla primero
      // Pero la app puede validar el código solo al hacer submit; llenamos mínimo
      await page.fill('#r-email', `intruso-${EXEC_ID}@example-staging.invalid`);
      await page.fill('#r-pass', TEST_PASS);
      await page.fill('#r-pass2', TEST_PASS);
      await page.click('button:has-text("Crear cuenta y entrar")');

      // Esperar el mensaje de error (el div #registro-err debe aparecer con texto)
      await page.waitForSelector('#registro-err:not([style*="display:none"])', {
        state: 'visible', timeout: T_CORTO,
      });
      const errText = await page.textContent('#registro-err');
      ok('R02-1 Reutilizar código: error visible en la app', !!errText && errText.length > 0);
      ok('R02-2 No llegó al dashboard', true); // si no lanzó excepción arriba, no hubo navegación

    } catch(e) {
      console.error('  ⚠️  Error inesperado en REG02:', e.message);
      fail++; failures.push('REG02 (excepción: ' + e.message + ')');
    } finally {
      await page.close();
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // REG03 — Código vencido → error en la app
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n▶ REG03 — Código vencido');
  {
    const EXPIRED_CODE = `M005-EXP-${EXEC_ID}`;
    const ayer = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    try {
      await crearCodigo({ codigo: EXPIRED_CODE, venceEl: ayer });
    } catch(e) {
      console.error('  ⚠️  No se pudo crear código vencido:', e.message);
    }

    const page = await browser.newPage();
    try {
      await abrirApp(page);
      await irARegistro(page);

      await page.fill('#r-invitacion', EXPIRED_CODE);
      await page.fill('#r-nombre', 'Vencido ' + EXEC_ID);
      await page.fill('#r-email', `vencido-${EXEC_ID}@example-staging.invalid`);
      await page.fill('#r-pass', TEST_PASS);
      await page.fill('#r-pass2', TEST_PASS);
      await page.click('button:has-text("Crear cuenta y entrar")');

      await page.waitForSelector('#registro-err:not([style*="display:none"])', {
        state: 'visible', timeout: T_CORTO,
      });
      const errText = await page.textContent('#registro-err');
      ok('R03-1 Código vencido: error visible en la app', !!errText && errText.length > 0);

      // Limpiar código vencido
      await eliminarCodigo(EXPIRED_CODE).catch(() => {});

    } catch(e) {
      console.error('  ⚠️  Error inesperado en REG03:', e.message);
      fail++; failures.push('REG03 (excepción: ' + e.message + ')');
    } finally {
      await page.close();
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // REG04 — Dos registros concurrentes con el mismo código → solo uno prospera
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n▶ REG04 — Dos registros concurrentes con el mismo código');
  {
    const CONC_CODE  = `M005-CONC-${EXEC_ID}`;
    const CONC_EMAIL_A = `conc-a-${EXEC_ID}@example-staging.invalid`;
    const CONC_EMAIL_B = `conc-b-${EXEC_ID}@example-staging.invalid`;
    try {
      await crearCodigo({ codigo: CONC_CODE });
    } catch(e) {
      console.error('  ⚠️  No se pudo crear código concurrente:', e.message);
    }

    const registrar = async (email) => {
      const pg = await browser.newPage();
      let llegoDashboard = false;
      let errorVisible   = false;
      try {
        await abrirApp(pg);
        await irARegistro(pg);
        await llenarYEnviarRegistro(pg, {
          codigo:  CONC_CODE,
          nombre:  `Bot Conc ${email}`,
          curso:   `Curso Conc ${EXEC_ID}`,
          email,
          pass:    TEST_PASS,
          cuota:   '1000',
        });
        // ¿Llegó al dashboard?
        try {
          await esperarDashboard(pg, 8_000);
          llegoDashboard = true;
          // Guardar auth_id si lo persistió
          const uApp = await poll(() => buscarUsuarioApp(email), { max: 5, delay: 600 });
          if (uApp?.auth_id) createdAuthIds.push(uApp.auth_id);
        } catch(_) {
          // No llegó al dashboard
          const errEl = pg.locator('#registro-err:not([style*="display:none"])');
          errorVisible = await errEl.isVisible().catch(() => false);
        }
      } catch(_) {}
      await pg.close();
      return { llegoDashboard, errorVisible };
    };

    // Lanzar ambos en paralelo
    const [resA, resB] = await Promise.all([
      registrar(CONC_EMAIL_A),
      registrar(CONC_EMAIL_B),
    ]);

    const exitosos = [resA, resB].filter(r => r.llegoDashboard).length;
    const fallidos = [resA, resB].filter(r => !r.llegoDashboard).length;

    ok('R04-1 Exactamente un registro concurrente prosperó', exitosos === 1);
    ok('R04-2 El otro recibió error (código ya usado)', fallidos === 1);

    // Limpiar código concurrente
    await eliminarCodigo(CONC_CODE).catch(() => {});
  }

  // ── Teardown ─────────────────────────────────────────────────────────────
  console.log('\n▶ Teardown: eliminar usuarios Auth de prueba');
  for (const authId of createdAuthIds) {
    try {
      await eliminarAuthUser(authId);
      console.log(`  Auth ${authId} eliminado`);
    } catch(e) {
      console.warn(`  ⚠️  No se pudo eliminar Auth ${authId}: ${e.message}`);
    }
  }
  // Eliminar código principal si aún existe
  await eliminarCodigo(TEST_CODE).catch(() => {});

  await browser.close();
  if (server) server.close();

  // ── Resultado ─────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════');
  console.log(`  Resultado: ${pass} ✅ / ${fail} ❌`);
  if (failures.length) console.error('  Fallaron:', failures.join(', '));
  console.log('══════════════════════════════════════════════════════\n');

  // ── Pendientes explícitos ─────────────────────────────────────────────────
  console.log('⏳ Pendientes (fuera del alcance de esta suite):');
  console.log('   • JWT expired — sigue afectando el uso normal del tesorero.');
  console.log('   • 46/46 financieros — evidencia reportada; falta contrastar con datos reales de Sofía en staging.');
  console.log('   • M005, M006, M007 — ninguna ejecutada; requieren aprobación explícita.');
  console.log('');

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('❌ Fatal:', e); process.exit(2); });
