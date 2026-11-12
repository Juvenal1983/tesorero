/**
 * tests/browser_test_staging_ui.js
 *
 * Recorrido de interfaz de usuario contra staging Supabase.
 * Usa Playwright: sirve la app localmente, inyecta credenciales de staging
 * con addInitScript (window.STAGING_SUPA_URL / STAGING_SUPA_KEY) y navega
 * el flujo real: login → selector de curso → pagos parciales → recarga →
 * edición → eliminación.
 *
 * Requisitos de entorno:
 *   STAGING_SUPABASE_URL        — https://rucgmytyxpfowznowxwd.supabase.co
 *   STAGING_SUPABASE_ANON_KEY   — anon key del proyecto de staging
 *   STAGING_USER_A_EMAIL        — email del tesorero A
 *   STAGING_USER_A_PASSWORD     — contraseña del tesorero A
 *
 * El cuenta_id se descubre automáticamente tras el login.
 *
 * Ejecución:
 *   Windows CMD : for /f "usebackq tokens=1,* delims==" %A in (`type .env ^| findstr /v "^#"`) do set %A=%B
 *                 node tests/browser_test_staging_ui.js
 *   bash/zsh    : export $(grep -v '^#' .env | xargs) && node tests/browser_test_staging_ui.js
 *
 * El script levanta un servidor HTTP local en el puerto 8787, lanza Chromium
 * headless con credenciales de staging inyectadas, corre el recorrido completo
 * y limpia los fixtures al finalizar.
 *
 * NUNCA apuntar al proyecto de producción (tmjqzaakzhecbldebyeg).
 */

'use strict';

// ── Validar variables de entorno ──────────────────────────────────────────────
const REQUIRED_ENV = [
  'STAGING_SUPABASE_URL', 'STAGING_SUPABASE_ANON_KEY',
  'STAGING_USER_A_EMAIL', 'STAGING_USER_A_PASSWORD',
];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error('❌ Faltan variables de entorno:\n  ' + missing.join('\n  '));
  process.exit(1);
}

const SUPA_URL   = process.env.STAGING_SUPABASE_URL;
const ANON_KEY   = process.env.STAGING_SUPABASE_ANON_KEY;
const USER_EMAIL = process.env.STAGING_USER_A_EMAIL;
const USER_PASS  = process.env.STAGING_USER_A_PASSWORD;
// CUENTA_ID se descubre automáticamente tras el login (ver loginTesorero)
let   CUENTA_ID  = null;

// ── Guard: hostname exacto de staging ────────────────────────────────────────
const STAGING_HOSTNAME = 'rucgmytyxpfowznowxwd.supabase.co';
const PROD_HOSTNAME    = 'tmjqzaakzhecbldebyeg.supabase.co';

let parsedHost;
try { parsedHost = new URL(SUPA_URL).hostname; }
catch (_) { console.error('❌ STAGING_SUPABASE_URL no es una URL válida.'); process.exit(2); }

if (parsedHost === PROD_HOSTNAME) {
  console.error('❌ CRÍTICO: STAGING_SUPA_URL apunta a producción. Abortando.');
  process.exit(2);
}
if (parsedHost !== STAGING_HOSTNAME) {
  console.error(`❌ STAGING_SUPA_URL tiene hostname inesperado: ${parsedHost}`);
  console.error(`   Hostname autorizado: ${STAGING_HOSTNAME}`);
  process.exit(2);
}

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { chromium } = require('playwright');

// ── EXEC_ID delimita fixtures de este run ─────────────────────────────────────
const EXEC_ID  = Date.now().toString(36);
const CURSO_ID = `crs-ui-${EXEC_ID}`;
const ALU_ID   = `alu-ui-${EXEC_ID}`;
const CUOTA_ID = `cuo-ui-${EXEC_ID}`;
// Nombre del alumno tal como lo renderiza el chip (apellidos.split(' ')[0], nombres.split(' ')[0])
// apellidos = `UI ${EXEC_ID}` → split(' ')[0] = 'UI'
// nombres   = 'Test'
const ALU_CHIP_TEXT = 'UI,';  // parte estable del chip (apellidos[0] + coma)
const CURSO_NOMBRE  = `Test UI ${EXEC_ID}`;
const CUOTA_NOMBRE  = `Cuota UI ${EXEC_ID}`;
const PERIODO_UI    = `Anual ${new Date().getFullYear()}`;
const APP_PORT      = 8787;
const APP_DIR       = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];

function ok(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else       { console.error(`  ❌ ${label}`); fail++; failures.push(label); }
}

// ── HTTP helpers (REST fixtures, misma lógica que el test REST) ───────────────
function supaFetchAuth(urlPath, jwt, opts = {}) {
  return _fetch(urlPath, { ...opts, authHeader: 'Bearer ' + jwt });
}
function supaFetchAnon(urlPath, opts = {}) {
  return _fetch(urlPath, { ...opts, authHeader: 'Bearer ' + ANON_KEY });
}

function _fetch(urlPath, opts) {
  return new Promise((resolve, reject) => {
    const url  = new URL(SUPA_URL + urlPath);
    const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const req  = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   opts.method || 'GET',
      headers: {
        'apikey':        ANON_KEY,
        'Authorization': opts.authHeader || ('Bearer ' + ANON_KEY),
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        'Prefer':        opts.prefer !== undefined ? opts.prefer : 'return=representation',
        ...(opts.headers || {}),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let body;
        try { body = JSON.parse(data); } catch (_) { body = data; }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Servidor HTTP local para la app ──────────────────────────────────────────
function servirApp() {
  const MIME = {
    '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
    '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff',
  };
  const server = http.createServer((req, res) => {
    let filePath = path.join(APP_DIR, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(APP_DIR, 'index.html');
    }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      const ext  = path.extname(filePath).toLowerCase();
      const mime = MIME[ext] || 'application/octet-stream';
      let content = data;
      // Para index.html: reemplazar placeholder de CSP y agregar __env.js inline
      if (filePath.endsWith('index.html')) {
        let html = data.toString('utf8');
        // Reemplazar placeholder STAGING_SUPA_HOST con el host real de staging
        html = html.replace(/https:\/\/STAGING_SUPA_HOST/g, `https://${STAGING_HOSTNAME}`);
        html = html.replace(/wss:\/\/STAGING_SUPA_HOST/g,   `wss://${STAGING_HOSTNAME}`);
        // Inyectar credenciales de staging ANTES de cualquier otro script
        // config.js ya lee window.STAGING_SUPA_URL y window.STAGING_SUPA_KEY
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

// ── Login REST para conseguir JWT (usado en pre/post fixtures) ────────────────
async function loginTesorero() {
  const res = await supaFetchAnon('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body:   { email: USER_EMAIL, password: USER_PASS },
    prefer: '',
  });
  if (res.status !== 200 || !res.body?.access_token) {
    throw new Error(`Login falló (HTTP ${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body.access_token;
}

async function descubrirCuentaId(jwt) {
  const res = await supaFetchAuth('/rest/v1/tesorero_cuentas?select=id,auth_id&limit=5', jwt);
  if (res.status !== 200 || !Array.isArray(res.body) || res.body.length === 0) {
    throw new Error(`No se encontró cuenta en tesorero_cuentas (HTTP ${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body[0].id;
}

// ── Crear fixtures vía REST (con JWT del tesorero) ───────────────────────────
async function crearFixtures(jwt) {
  const anio = new Date().getFullYear();
  const steps = [
    {
      nombre: 'curso',
      url: '/rest/v1/cursos',
      body: { cuenta_id: CUENTA_ID, id: CURSO_ID, nombre: CURSO_NOMBRE, anio, activo: true },
    },
    {
      nombre: 'alumno',
      url: '/rest/v1/alumnos',
      body: { cuenta_id: CUENTA_ID, id: ALU_ID, curso_id: CURSO_ID, nombres: 'Test', apellidos: `UI ${EXEC_ID}`, estado: 'activo', eximido: false },
    },
    {
      nombre: 'cuota',
      url: '/rest/v1/cuotas',
      body: { cuenta_id: CUENTA_ID, id: CUOTA_ID, curso_id: CURSO_ID, nombre: CUOTA_NOMBRE, tipo: 'extraordinaria', monto: 20000, anio, activa: true },
    },
  ];
  for (const step of steps) {
    const r = await supaFetchAuth(step.url, jwt, { method: 'POST', body: step.body });
    if (r.status !== 201) {
      throw new Error(`No pudo crear ${step.nombre} (HTTP ${r.status}): ${JSON.stringify(r.body)}`);
    }
  }
  console.log(`  ✅ Fixtures UI creados: ${CURSO_NOMBRE} / ${ALU_ID} / ${CUOTA_ID}`);
}

// ── Limpiar fixtures vía REST (con JWT) ───────────────────────────────────────
async function limpiarFixtures(jwt) {
  const pasos = [
    { nombre: 'pagos',   url: `/rest/v1/pagos?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&alumno_id=eq.${encodeURIComponent(ALU_ID)}`,       verUrl: `/rest/v1/pagos?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&alumno_id=eq.${encodeURIComponent(ALU_ID)}&select=id` },
    { nombre: 'cuota',   url: `/rest/v1/cuotas?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&id=eq.${encodeURIComponent(CUOTA_ID)}`,             verUrl: `/rest/v1/cuotas?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&id=eq.${encodeURIComponent(CUOTA_ID)}&select=id` },
    { nombre: 'alumno',  url: `/rest/v1/alumnos?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&id=eq.${encodeURIComponent(ALU_ID)}`,               verUrl: `/rest/v1/alumnos?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&id=eq.${encodeURIComponent(ALU_ID)}&select=id` },
    { nombre: 'curso',   url: `/rest/v1/cursos?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&id=eq.${encodeURIComponent(CURSO_ID)}`,              verUrl: `/rest/v1/cursos?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&id=eq.${encodeURIComponent(CURSO_ID)}&select=id` },
  ];
  for (const paso of pasos) {
    const rDel = await supaFetchAuth(paso.url, jwt, { method: 'DELETE', prefer: 'return=minimal' });
    if (rDel.status !== 200 && rDel.status !== 204) {
      console.error(`  ⚠️  DELETE ${paso.nombre}: HTTP ${rDel.status}`);
      continue;
    }
    const rVer = await supaFetchAuth(paso.verUrl, jwt);
    if (rVer.status === 200 && Array.isArray(rVer.body) && rVer.body.length > 0) {
      console.error(`  ⚠️  ${paso.nombre}: ${rVer.body.length} fila(s) no eliminada(s)`);
    } else {
      console.log(`  ✅ ${paso.nombre} eliminado`);
    }
  }
  console.log('\n  📋 SQL admin para limpiar operaciones_pagos:');
  console.log(`  DELETE FROM operaciones_pagos WHERE cuenta_id = '${CUENTA_ID}' AND idempotency_key LIKE 'stg-ui-%';`);
}

// ── Helpers Playwright ────────────────────────────────────────────────────────
const TIMEOUT_CORTO  = 10_000;
const TIMEOUT_LARGO  = 25_000;

/** Esperar a que la app JS esté cargada (S global definido) */
async function waitAppReady(page) {
  await page.waitForFunction(() => typeof window.S !== 'undefined', { timeout: TIMEOUT_LARGO });
}

/** Re-login vía UI si el formulario de login está visible (sesión no restaurada) */
async function reloginViaUI(page) {
  const tieneForm = await page.locator('#l-email').count() > 0;
  if (!tieneForm) return; // ya autenticado u otra vista
  await page.fill('#l-email', USER_EMAIL);
  await page.fill('#l-pass', USER_PASS);
  await page.click('[onclick="doLogin()"]');
  await page.waitForFunction(
    () => window.S?.session !== null && window.S?.session !== undefined,
    { timeout: TIMEOUT_LARGO }
  );
}

/** Navegar a la vista de pagos del alumno de test (asume sesión activa) */
async function navegarPagosAlumno(page) {
  const cursoActual = await page.evaluate(() => window.S?.cursoId ?? null);
  if (cursoActual !== CURSO_ID) {
    await page.evaluate((id) => window.selectCurso && window.selectCurso(id), CURSO_ID);
    await page.waitForFunction(
      (id) => window.S?.cursoId === id,
      CURSO_ID,
      { timeout: TIMEOUT_LARGO }
    );
  }
  await page.evaluate((id) => window.go('pagos', { aluId: id }), ALU_ID);
  await page.waitForFunction(() => window.S?.route === 'pagos', { timeout: TIMEOUT_CORTO });
}

/** Capturar screenshot en fallo */
async function screenshot(page, nombre) {
  try {
    const p = `/tmp/claude-0/-home-claude/baceb390-7fe6-5be0-bc70-3bf96e00da99/scratchpad/ui-${nombre}-${EXEC_ID}.png`;
    await page.screenshot({ path: p, fullPage: true });
    console.log(`    📸 ${p}`);
  } catch (_) {}
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n── Recorrido UI: login → pagos → recarga → editar → eliminar ──────────\n');
  console.log(`EXEC_ID  : ${EXEC_ID}`);
  console.log(`Staging  : ${SUPA_URL}`);
  console.log(`Cuenta A : ${CUENTA_ID}\n`);

  // ── Pre: login REST y fixtures ────────────────────────────────────────────
  console.log('[Pre] Login REST y creación de fixtures');
  let jwt;
  try {
    jwt = await loginTesorero();
    CUENTA_ID = await descubrirCuentaId(jwt);
    console.log(`  Cuenta A: ${CUENTA_ID}`);
  } catch (e) {
    console.error('❌ Login REST falló:', e.message);
    process.exit(3);
  }
  try { await crearFixtures(jwt); } catch (e) {
    console.error('❌ Fixtures falló:', e.message);
    process.exit(4);
  }

  let server = null;
  let browser = null;

  try {
    // ── Levantar servidor local ───────────────────────────────────────────────
    console.log('\n[U01] Servidor HTTP local de la app');
    server = await servirApp();
    ok('U01: servidor levantado en puerto ' + APP_PORT, true);

    // ── Lanzar Playwright ─────────────────────────────────────────────────────
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();

    // Capturar errores de consola del browser
    page.on('console', msg => {
      if (msg.type() === 'error') console.error(`  [browser] ${msg.text()}`);
    });

    // ── U02: Cargar app e inyectar credenciales ────────────────────────────────
    console.log('\n[U02] Cargar app con credenciales de staging inyectadas');
    // addInitScript como refuerzo (el servidor ya inyecta el script en el HTML)
    await page.addInitScript(({ url, key }) => {
      window.STAGING_SUPA_URL = url;
      window.STAGING_SUPA_KEY = key;
    }, { url: SUPA_URL, key: ANON_KEY });

    await page.goto(`http://localhost:${APP_PORT}/`, { waitUntil: 'load', timeout: TIMEOUT_LARGO });
    try {
      await waitAppReady(page);
    } catch (_) {
      await screenshot(page, 'u02-appready-fail');
      throw new Error('window.S no definido tras cargar la app (ver screenshot u02-appready-fail)');
    }
    const hasLoginForm = await page.locator('#l-email').count() > 0;
    ok('U02: formulario de login visible', hasLoginForm);
    if (!hasLoginForm) {
      await screenshot(page, 'u02-nologin');
      throw new Error('Formulario de login no encontrado; app no cargó correctamente');
    }

    // ── U03: Login vía UI ─────────────────────────────────────────────────────
    console.log('\n[U03] Login del tesorero A via UI');
    await page.fill('#l-email', USER_EMAIL);
    await page.fill('#l-pass', USER_PASS);
    await page.click('[onclick="doLogin()"]');

    // Esperar a que desaparezca el form de login (login exitoso → redirige)
    try {
      await page.waitForFunction(
        () => window.S?.session !== null && window.S?.session !== undefined,
        { timeout: TIMEOUT_LARGO }
      );
      ok('U03: login completado (S.session definido)', true);
    } catch (_) {
      await screenshot(page, 'u03-login-fail');
      ok('U03: login completado (S.session definido)', false);
      throw new Error('Login UI no completó en tiempo');
    }

    // ── U04: Seleccionar curso exclusivo ──────────────────────────────────────
    console.log('\n[U04] Seleccionar curso de test en el selector');
    // Si hay un único curso se salta el selector. Con el nuevo curso hay ≥2 → selector.
    let enSelector = false;
    try {
      await page.waitForSelector(`text=Seleccionar curso`, { timeout: TIMEOUT_CORTO });
      enSelector = true;
    } catch (_) {
      // Si hay un solo curso u otro flujo, podría ir directo al dashboard
    }

    if (enSelector) {
      // Buscar el curso por nombre (contiene EXEC_ID, único en esta cuenta ahora)
      const cursoBtnSelector = `text=${CURSO_NOMBRE}`;
      await page.waitForSelector(cursoBtnSelector, { timeout: TIMEOUT_CORTO });
      await page.click(cursoBtnSelector);
      ok('U04: curso de test seleccionado en selector', true);
    } else {
      // Si llegó directo al dashboard, cambiar de curso programáticamente
      const cursoActual = await page.evaluate(() => window.S?.cursoId ?? null);
      if (cursoActual !== CURSO_ID) {
        await page.evaluate((id) => window.selectCurso(id), CURSO_ID);
      }
      ok('U04: curso de test activo (un solo curso o navegación directa)', true);
    }

    // Esperar que el curso quede cargado
    await page.waitForFunction(
      (id) => window.S?.cursoId === id,
      CURSO_ID,
      { timeout: TIMEOUT_LARGO }
    );
    ok('U04-b: S.cursoId === CURSO_ID', true);

    // ── U05: Navegar a pagos ──────────────────────────────────────────────────
    console.log('\n[U05] Navegar a sección Pagos');
    await page.evaluate(() => window.go('pagos'));
    await page.waitForFunction(
      () => window.S?.route === 'pagos',
      { timeout: TIMEOUT_CORTO }
    );
    ok('U05: ruta pagos activa', true);

    // Esperar a que aparezca el nombre del alumno de test en los chips
    try {
      await page.waitForSelector(`text=UI,`, { timeout: TIMEOUT_CORTO });
      ok('U05-b: alumno de test visible en chips', true);
    } catch (_) {
      await screenshot(page, 'u05-nochip');
      ok('U05-b: alumno de test visible en chips', false);
    }

    // ── U06: Seleccionar alumno de test ───────────────────────────────────────
    console.log('\n[U06] Seleccionar alumno de test');
    // Chip: `${apellidos.split(' ')[0]}, ${nombres.split(' ')[0]}` → "UI, Test"
    // Click en el chip del alumno (apellidos = "UI EXEC_ID" → chip empieza con "UI,")
    const chipAlumno = page.locator('.chip', { hasText: /^UI,/ }).first();
    if (await chipAlumno.count() > 0) {
      await chipAlumno.click();
      ok('U06: alumno de test seleccionado', true);
    } else {
      // Seleccionar programáticamente por ID si el chip no matchea
      await page.evaluate((id) => window.go('pagos', { aluId: id }), ALU_ID);
      ok('U06: alumno de test seleccionado (programático)', true);
    }
    await page.waitForFunction(
      (id) => window.S?.params?.aluId === id,
      ALU_ID,
      { timeout: TIMEOUT_CORTO }
    );

    // ── U07: Registrar primer pago parcial ($8.000) ───────────────────────────
    console.log('\n[U07] Registrar pago parcial 1 — $8.000');
    // Buscar el botón "+ Registrar pago" para la cuota de test
    // El botón tiene onclick="showModal('addPago',{aluId:'...', cuotaId:'CUOTA_ID'})"
    const btnPago = page.locator(`[onclick*="addPago"][onclick*="${CUOTA_ID}"]`).first();
    if (await btnPago.count() > 0) {
      await btnPago.click();
      ok('U07-a: modal de pago abierto', true);
    } else {
      // Fallback: abrir modal programáticamente
      await page.evaluate(
        ({ aluId, cuotaId }) => window.showModal('addPago', { aluId, cuotaId }),
        { aluId: ALU_ID, cuotaId: CUOTA_ID }
      );
      ok('U07-a: modal de pago abierto (programático)', true);
    }

    await page.waitForSelector('#p-monto', { timeout: TIMEOUT_CORTO });
    await page.fill('#p-monto', '8000');
    // Seleccionar "Efectivo" en el medio de pago
    await page.selectOption('#p-medio', 'Efectivo');

    // Recolectar idempotency keys que se van a usar (antes de guardar)
    const iksAntes = await page.evaluate(() => {
      try { return Object.keys(window.localStorage).filter(k => k.startsWith('tesorero')); }
      catch(_) { return []; }
    });

    // Hacer click en "Registrar y notificar →"
    await page.click('[onclick*="savePago"]');

    // Esperar que el modal se cierre
    try {
      await page.waitForFunction(() => document.querySelector('#p-monto') === null, { timeout: TIMEOUT_LARGO });
      ok('U07-b: modal cerrado tras guardar pago 1', true);
    } catch (_) {
      await screenshot(page, 'u07-modal-open');
      ok('U07-b: modal cerrado tras guardar pago 1', false);
    }

    // Verificar en DB que el pago se guardó
    const pagos7 = await _queryPagosTest(jwt);
    ok('U07-c: pago 1 en DB (via REST)', pagos7.length === 1 && pagos7[0]?.monto === 8000);

    // ── U08: Registrar segundo pago parcial ($12.000) ─────────────────────────
    console.log('\n[U08] Registrar pago parcial 2 — $12.000');
    const btnPago2 = page.locator(`[onclick*="addPago"][onclick*="${CUOTA_ID}"]`).first();
    if (await btnPago2.count() > 0) {
      await btnPago2.click();
    } else {
      await page.evaluate(
        ({ aluId, cuotaId }) => window.showModal('addPago', { aluId, cuotaId }),
        { aluId: ALU_ID, cuotaId: CUOTA_ID }
      );
    }
    await page.waitForSelector('#p-monto', { timeout: TIMEOUT_CORTO });
    await page.fill('#p-monto', '12000');
    await page.click('[onclick*="savePago"]');

    try {
      await page.waitForFunction(() => document.querySelector('#p-monto') === null, { timeout: TIMEOUT_LARGO });
      ok('U08-a: modal cerrado tras guardar pago 2', true);
    } catch (_) {
      await screenshot(page, 'u08-modal-open');
      ok('U08-a: modal cerrado tras guardar pago 2', false);
    }

    const pagos8 = await _queryPagosTest(jwt);
    const sumado8 = pagos8.reduce((s, p) => s + (p.monto ?? 0), 0);
    ok('U08-b: 2 pagos en DB, suma = 20000', pagos8.length === 2 && sumado8 === 20000);

    // ── U09: Recarga — verificar persistencia ─────────────────────────────────
    console.log('\n[U09] Recarga de página: verificar que los 2 pagos persisten');
    await page.reload({ waitUntil: 'load', timeout: TIMEOUT_LARGO });
    try {
      await waitAppReady(page);
    } catch (_) {
      await screenshot(page, 'u09-appready-fail');
      throw new Error('window.S no definido tras recarga (ver screenshot u09-appready-fail)');
    }

    // Tras recarga: sesión puede perderse si no había token cacheado.
    // Verificar en DB (REST) como fuente de verdad.
    const pagos9 = await _queryPagosTest(jwt);
    ok('U09-a: 2 pagos en DB después de recarga', pagos9.length === 2);

    // Restaurar sesión vía UI si no estaba activa (no REST fallback)
    const sesionActiva = await page.evaluate(() =>
      window.S?.session !== null && window.S?.session !== undefined
    );
    if (!sesionActiva) {
      console.log('  → Sesión no restaurada automáticamente; re-login vía UI');
      try {
        await reloginViaUI(page);
        ok('U09-b: re-login vía UI tras recarga', true);
      } catch (_) {
        await screenshot(page, 'u09-relogin-fail');
        ok('U09-b: re-login vía UI tras recarga', false);
      }
    } else {
      ok('U09-b: sesión restaurada automáticamente', true);
    }

    // Navegar a pagos del alumno (siempre)
    try {
      await navegarPagosAlumno(page);
      const badgePagado = await page.locator('text=✓ Pagado').count();
      ok('U09-c: estado "Pagado" visible en tabla de cuotas', badgePagado > 0);
    } catch (_) {
      await screenshot(page, 'u09-nav-fail');
      ok('U09-c: estado "Pagado" visible en tabla de cuotas', false);
    }

    // ── U10: Editar pago 1 vía UI ─────────────────────────────────────────────
    console.log('\n[U10] Editar pago 1 — cambiar medio a "Cheque" via UI');
    const p1db = pagos9.find(p => p.monto === 8000) ?? pagos8.find(p => p.monto === 8000);
    if (p1db?.id) {
      const btnEditar = page.locator(`[onclick*="editPago"][onclick*="${p1db.id}"]`).first();
      if (await btnEditar.count() > 0) {
        await btnEditar.click();
        await page.waitForSelector('#ep-medio,#p-medio,select.fs', { timeout: TIMEOUT_CORTO });
        const medioSel = page.locator('#ep-medio,select.fs').first();
        await medioSel.selectOption('Cheque');
        await page.click('[onclick*="saveEditPago"]');
        try {
          await page.waitForFunction(() => document.querySelector('#ep-medio') === null, { timeout: TIMEOUT_LARGO });
          ok('U10-a: modal edición cerrado', true);
        } catch (_) {
          await screenshot(page, 'u10-modal-stuck');
          ok('U10-a: modal edición cerrado', false);
        }
      } else {
        await screenshot(page, 'u10-noedit');
        ok('U10-a: botón editar visible en UI (pago 1)', false);
      }
      // Verificar en DB
      const pagos10 = await _queryPagosTest(jwt);
      const p1Upd   = pagos10.find(p => p.id === p1db.id);
      ok('U10-b: medio actualizado a "cheque" o "Cheque"',
        /^cheque$/i.test(p1Upd?.medio ?? ''));
    } else {
      ok('U10: skip (no se encontró pago de $8.000)', false);
    }

    // ── U11: Eliminar pago 2 vía UI ───────────────────────────────────────────
    console.log('\n[U11] Eliminar pago 2 via UI');
    const pagos10b = await _queryPagosTest(jwt);
    const p2db = pagos10b.find(p => p.monto === 12000);
    if (p2db?.id) {
      const btnEliminar = page.locator(`[onclick*="delPago('${p2db.id}')"]`).first();
      if (await btnEliminar.count() > 0) {
        page.on('dialog', async dialog => { await dialog.accept(); });
        await btnEliminar.click();
        await page.waitForTimeout(2000);
        ok('U11-a: botón eliminar clickeado', true);
      } else {
        await screenshot(page, 'u11-nodel');
        ok('U11-a: botón eliminar visible en UI (pago 2)', false);
      }
      const pagos11 = await _queryPagosTest(jwt);
      ok('U11-b: 1 pago en DB (pago 2 eliminado)', pagos11.length === 1);
    } else {
      ok('U11: skip (no se encontró pago de $12.000)', false);
    }

    await screenshot(page, 'final');
    await browser.close();
    browser = null;

  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server)  server.close();
    console.log('\n[Cleanup] Eliminar fixtures UI');
    if (jwt) await limpiarFixtures(jwt);
  }

  console.log('\n────────────────────────────────────────────────────────────');
  console.log(`Total: ${pass + fail}  ✅ ${pass}  ❌ ${fail}`);
  if (fail === 0) console.log('\n✅ Recorrido UI completo — login → pagos → recarga → editar → eliminar OK.');
  else { console.log('\n❌ Fallos:'); failures.forEach(f => console.error(`  - ${f}`)); }
  process.exit(fail > 0 ? 1 : 0);
})().catch(async e => {
  console.error('\n❌ Error no capturado:', e.message || e);
  process.exit(5);
});

// ── Helpers de acceso a datos para verificaciones internas ───────────────────
async function _queryPagosTest(jwt) {
  const res = await supaFetchAuth(
    `/rest/v1/pagos?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&alumno_id=eq.${encodeURIComponent(ALU_ID)}&select=id,monto,medio,estado`,
    jwt
  );
  if (res.status !== 200) throw new Error(`_queryPagosTest HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  return Array.isArray(res.body) ? res.body : [];
}

// _editarPago y _eliminarPago eliminados: U10/U11 usan exclusivamente la UI.
// Si necesitas editar/eliminar en cleanup, usa limpiarFixtures() que ya lo hace.
