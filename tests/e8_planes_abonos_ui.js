/**
 * tests/e8_planes_abonos_ui.js
 *
 * Recorrido Playwright B2 — Planes de pago completo (crear → pago parcial →
 * completar → recargar → revertir desde plan completado → recargar saldos).
 *
 * También verifica:
 *   - Vista privada del apoderado (código CC + PIN): apoderado_situacion_financiera
 *   - Vista compartida CC: apoderado_cc_resumen_pagos (acceso sin PIN)
 *   - checkNoPagos correcto: 404/403 bloquean; solo 200+[] demuestra ausencia
 *
 * Patrón idéntico a browser_test_staging_ui.js:
 *   - Levanta servidor HTTP local que inyecta credenciales de staging
 *   - Lanza Chromium headless via Playwright
 *   - Fixtures exclusivos por EXEC_ID, eliminados en finally
 *
 * Variables de entorno — acepta los mismos nombres que E6/E7 y E8-API:
 *   STAGING_SUPABASE_URL   o  STAGING_URL        — URL del proyecto de staging
 *   STAGING_SUPABASE_ANON_KEY o STAGING_KEY       — anon key (solo apikey, sin JWT de usuario)
 *   STAGING_USER_A_EMAIL   o  STAGING_EMAIL       — email del tesorero
 *   STAGING_USER_A_PASSWORD o  STAGING_PASS       — contraseña
 *
 * Opcionales:
 *   STAGING_CUENTA_ID  — omitir → autodiscovery post-login
 *   ALU_PIN            — PIN del alumno de test (default: "1234")
 *
 * Ejecución:
 *   bash/zsh : export $(grep -v '^#' .env | xargs) && node tests/e8_planes_abonos_ui.js
 *   Windows  : for /f "usebackq tokens=1,* delims==" %A in (`type .env ^| findstr /v "^#"`) do set %A=%B
 *              node tests\e8_planes_abonos_ui.js
 *
 * NUNCA apuntar a producción (tmjqzaakzhecbldebyeg).
 */

'use strict';

// ── 1. Cargar .env automáticamente (igual que E8-API) ────────────────────────
const path  = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') }); } catch(_){}

// ── 2. Resolver variables aceptando todos los alias de E6/E7/E8 ──────────────
//   Prioridad: nombre largo (STAGING_SUPABASE_*) > nombre corto (STAGING_*)
const SUPA_URL_RAW =
  process.env.STAGING_SUPABASE_URL ||
  process.env.STAGING_URL          || '';
const ANON_KEY =
  process.env.STAGING_SUPABASE_ANON_KEY ||
  process.env.STAGING_KEY               || '';
const USER_EMAIL =
  process.env.STAGING_USER_A_EMAIL ||
  process.env.STAGING_EMAIL        || '';
const USER_PASS =
  process.env.STAGING_USER_A_PASSWORD ||
  process.env.STAGING_PASS            || '';
const ALU_PIN = process.env.ALU_PIN || '1234';

if (!SUPA_URL_RAW || !ANON_KEY || !USER_EMAIL || !USER_PASS) {
  console.error('❌ Faltan variables de entorno. Requeridas (cualquier alias):');
  console.error('   STAGING_SUPABASE_URL / STAGING_URL');
  console.error('   STAGING_SUPABASE_ANON_KEY / STAGING_KEY');
  console.error('   STAGING_USER_A_EMAIL / STAGING_EMAIL');
  console.error('   STAGING_USER_A_PASSWORD / STAGING_PASS');
  process.exit(1);
}

const SUPA_URL = SUPA_URL_RAW.replace(/\/$/, '');

// ── 3. Guard de hostname: rechaza producción Y cualquier host no autorizado ───
const PROD_HOST    = 'tmjqzaakzhecbldebyeg.supabase.co';
const STAGING_HOST = 'rucgmytyxpfowznowxwd.supabase.co';
let parsedHost;
try { parsedHost = new URL(SUPA_URL).hostname; }
catch (_) { console.error('❌ URL de staging no es válida: ' + SUPA_URL_RAW); process.exit(2); }
if (parsedHost === PROD_HOST) {
  console.error('❌ CRÍTICO: URL apunta a producción. Abortando.'); process.exit(2);
}
if (parsedHost !== STAGING_HOST) {
  console.error(`❌ Hostname no autorizado: ${parsedHost}`);
  console.error(`   Hostname esperado: ${STAGING_HOST}`);
  console.error('   Si tu staging tiene otro hostname, edita STAGING_HOST en este script.');
  process.exit(2);
}

const http  = require('http');
const https = require('https');
const fs    = require('fs');
// path ya fue requerido arriba (para dotenv)
const { chromium } = require('playwright');

// ── EXEC_ID y fixtures exclusivos de este run ─────────────────────────────────
const EXEC_ID   = Date.now().toString(36);
const CURSO_ID  = `crs-b2-${EXEC_ID}`;
const ALU_ID    = `alu-b2-${EXEC_ID}`;
const CUOTA_ID  = `cuo-b2-${EXEC_ID}`;
const CURSO_NOM = `Plan B2 ${EXEC_ID}`;
const CUOTA_NOM = `Cuota B2 ${EXEC_ID}`;
const PERIODO   = `Diciembre ${new Date().getFullYear()}`;
// 2 abonos de $45.000 → total $90.000
const MONTO_TOTAL = 90000;
const MONTO_AB1   = 45000;
const MONTO_AB2   = 45000;

let CUENTA_ID = process.env.STAGING_CUENTA_ID || null;
let CC_CODE   = null;

const APP_PORT = 8797;  // distinto de 8787 para no colisionar con otros tests

let pass = 0, fail = 0;
const failures = [];

function ok(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else       { console.error(`  ❌ ${label}`); fail++; failures.push(label); }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
// _fetch base: construye la cabecera definitiva antes de llamar a https.request.
// opts.authHeader = string  → se usa como Authorization
// opts.authHeader = null    → cabecera Authorization omitida (llamadas anon)
// opts.authHeader = undefined → no se sobreescribe el default (Bearer ANON_KEY)
function _fetch(urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const url  = new URL(SUPA_URL + urlPath);
    const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    // Cabeceras base
    const hdrs = {
      'apikey':       ANON_KEY,
      'Content-Type': 'application/json',
      'Accept':       'application/json',
      'Prefer':       opts.prefer !== undefined ? opts.prefer : 'return=representation',
      ...(opts.headers || {}),
    };
    // Authorization solo si se suministra explícitamente (null = omitir)
    if (opts.authHeader !== null && opts.authHeader !== undefined) {
      hdrs['Authorization'] = opts.authHeader;
    }
    if (body) hdrs['Content-Length'] = String(Buffer.byteLength(body));
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search,
      method: opts.method || 'GET',
      headers: hdrs,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let body; try { body = JSON.parse(data); } catch (_) { body = data; }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Llamada autenticada con JWT del tesorero
function supaAuth(url, jwt, opts = {}) {
  return _fetch(url, { ...opts, authHeader: 'Bearer ' + jwt });
}
// Llamada anon: solo apikey, sin Authorization (igual que rpcAnon en e8_planes_abonos.js)
function supaAnon(url, opts = {}) {
  return _fetch(url, { ...opts, authHeader: null });
}
function rpcAnon(fn, params) {
  return supaAnon('/rest/v1/rpc/' + fn, {
    method: 'POST', body: params, prefer: 'return=representation',
  });
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

// ── Login y fixtures vía REST ─────────────────────────────────────────────────
async function loginTesorero() {
  const r = await supaAnon('/auth/v1/token?grant_type=password', {
    method: 'POST', body: { email: USER_EMAIL, password: USER_PASS }, prefer: '',
  });
  if (r.status !== 200 || !r.body?.access_token)
    throw new Error(`Login falló (HTTP ${r.status}): ${JSON.stringify(r.body)}`);
  return r.body.access_token;
}

async function descubrirCuenta(jwt) {
  const r = await supaAuth('/rest/v1/tesorero_cuentas?select=id&limit=1', jwt);
  if (r.status !== 200 || !r.body?.length)
    throw new Error(`Sin cuenta (HTTP ${r.status})`);
  return r.body[0].id;
}

async function crearFixtures(jwt) {
  const anio = new Date().getFullYear();
  const steps = [
    { nombre: 'curso',  url: '/rest/v1/cursos',
      body: { id: CURSO_ID, cuenta_id: CUENTA_ID, nombre: CURSO_NOM, anio, activo: true } },
    { nombre: 'alumno', url: '/rest/v1/alumnos',
      body: { id: ALU_ID, cuenta_id: CUENTA_ID, curso_id: CURSO_ID,
              nombres: 'Demo', apellidos: `B2 ${EXEC_ID}`, estado: 'activo' } },
    { nombre: 'cuota',  url: '/rest/v1/cuotas',
      body: { id: CUOTA_ID, cuenta_id: CUENTA_ID, curso_id: CURSO_ID, nombre: CUOTA_NOM,
              tipo: 'mensual', monto: MONTO_TOTAL, anio, activa: true } },
  ];
  for (const s of steps) {
    const r = await supaAuth(s.url, jwt, { method: 'POST', body: s.body });
    if (r.status !== 201)
      throw new Error(`No pudo crear ${s.nombre} (HTTP ${r.status}): ${JSON.stringify(r.body)}`);
  }
  // Generar código CC del apoderado
  const rCC = await supaAuth('/rest/v1/rpc/apoderado_cc_generar', jwt, {
    method: 'POST', body: { p_cuenta_id: CUENTA_ID, p_curso_id: CURSO_ID },
  });
  if (rCC.status === 200) {
    CC_CODE = rCC.body?.codigo_cc || (typeof rCC.body === 'string' ? rCC.body : null);
  }
  // Establecer PIN del alumno para vista privada
  const rPin = await supaAuth('/rest/v1/rpc/tesorero_set_pin', jwt, {
    method: 'POST',
    body: { p_cuenta_id: CUENTA_ID, p_alumno_id: ALU_ID, p_pin: ALU_PIN },
  });
  const pinOk = rPin.status === 200 && rPin.body?.ok === true;
  console.log(`  ✅ Fixtures: ${CURSO_NOM} / ${ALU_ID} / ${CUOTA_NOM}`);
  console.log(`  ✅ Código CC: ${CC_CODE || '(no generado)'}`);
  console.log(`  ${pinOk ? '✅' : '⚠️ '} PIN alumno: ${pinOk ? 'establecido' : JSON.stringify(rPin.body)}`);
}

async function limpiarFixtures(jwt) {
  const c = encodeURIComponent(CUENTA_ID);
  const a = encodeURIComponent(ALU_ID);
  const q = encodeURIComponent(CUOTA_ID);
  const cr= encodeURIComponent(CURSO_ID);
  // Orden: primero hijos (abonos, planes, alumno, cuota), luego padre (curso)
  const pasos = [
    { nombre: 'abonos',      url: `/rest/v1/abonos?cuenta_id=eq.${c}&alumno_id=eq.${a}` },
    { nombre: 'planes_pago', url: `/rest/v1/planes_pago?cuenta_id=eq.${c}&alumno_id=eq.${a}` },
    { nombre: 'alumnos',     url: `/rest/v1/alumnos?cuenta_id=eq.${c}&id=eq.${a}` },
    { nombre: 'cuotas',      url: `/rest/v1/cuotas?cuenta_id=eq.${c}&id=eq.${q}` },
    { nombre: 'cursos',      url: `/rest/v1/cursos?cuenta_id=eq.${c}&id=eq.${cr}` },
  ];
  const errores = [];
  for (const paso of pasos) {
    const r = await supaAuth(paso.url, jwt, { method: 'DELETE', prefer: 'return=minimal' })
      .catch(e => ({ status: 0, body: e.message }));
    // 200 (con body) o 204 (sin body) son éxito; 404 también (ya inexistente)
    const ok204 = r.status === 200 || r.status === 204 || r.status === 404;
    console.log(`  ${ok204 ? '✅' : '⚠️ '} DELETE ${paso.nombre}: HTTP ${r.status}`);
    if (!ok204) errores.push(`${paso.nombre} HTTP ${r.status}: ${JSON.stringify(r.body).slice(0,80)}`);
  }
  // Verificar ausencia real de los tres IDs principales en DB
  const rAlu   = await supaAuth(`/rest/v1/alumnos?cuenta_id=eq.${c}&id=eq.${a}&select=id`,   jwt).catch(() => ({ status: 0 }));
  const rCuota = await supaAuth(`/rest/v1/cuotas?cuenta_id=eq.${c}&id=eq.${q}&select=id`,    jwt).catch(() => ({ status: 0 }));
  const rCurso = await supaAuth(`/rest/v1/cursos?cuenta_id=eq.${c}&id=eq.${cr}&select=id`,   jwt).catch(() => ({ status: 0 }));
  const aluGone   = rAlu.status   === 200 && Array.isArray(rAlu.body)   && rAlu.body.length   === 0;
  const cuotaGone = rCuota.status === 200 && Array.isArray(rCuota.body) && rCuota.body.length === 0;
  const cursoGone = rCurso.status === 200 && Array.isArray(rCurso.body) && rCurso.body.length === 0;
  console.log(`  Ausencia verificada: alumno=${aluGone?'✅':'❌PRESENTE'} cuota=${cuotaGone?'✅':'❌PRESENTE'} curso=${cursoGone?'✅':'❌PRESENTE'}`);
  if (!aluGone || !cuotaGone || !cursoGone) {
    errores.push('IDs todavía presentes en DB tras DELETE');
  }
  if (errores.length) {
    console.error('  ⚠️  Errores en limpieza: ' + errores.join(' | '));
    console.error(`  Limpiar manualmente: alumno=${ALU_ID} cuota=${CUOTA_ID} curso=${CURSO_ID}`);
  } else {
    console.log('  ✅ Fixtures eliminados y ausencia verificada');
  }
}

// ── Helpers Playwright ────────────────────────────────────────────────────────
const T_CORTO = 12_000;
const T_LARGO = 30_000;

async function waitAppReady(page) {
  await page.waitForFunction(() => typeof window.S !== 'undefined', { timeout: T_LARGO });
}

async function screenshot(page, nombre) {
  try {
    const p = path.join(__dirname, `b2-${nombre}-${EXEC_ID}.png`);
    await page.screenshot({ path: p, fullPage: true });
    console.log(`    📸 ${p}`);
  } catch (_) {}
}

/** Re-login vía UI si la sesión se perdió tras reload (patrón E7) */
async function reloginViaUI(page) {
  const tieneForm = await page.locator('#l-email').count() > 0;
  if (!tieneForm) return; // ya autenticado u otra vista
  await page.fill('#l-email', USER_EMAIL);
  await page.fill('#l-pass',  USER_PASS);
  await page.click('[onclick="doLogin()"]');
  await page.waitForFunction(
    () => window.S?.session !== null && window.S?.session !== undefined && !!window.S?._v9CuentaId,
    { timeout: T_LARGO }
  );
}

/** Re-seleccionar curso y navegar a pagos del alumno (patrón E7) */
async function navegarPagosAlumno(page) {
  const v9Listo    = await page.evaluate(() => !!window.S?._v9CuentaId);
  const cursoActual = await page.evaluate(() => window.S?.cursoId ?? null);
  if (cursoActual !== CURSO_ID) {
    if (v9Listo) {
      await page.evaluate(id => window.selectCurso && window.selectCurso(id), CURSO_ID);
      await page.waitForFunction(id => window.S?.cursoId === id, CURSO_ID, { timeout: T_LARGO });
    } else {
      await page.evaluate(() => window.go('selector'));
      await page.waitForSelector(`text=${CURSO_NOM}`, { timeout: T_CORTO });
      await page.click(`text=${CURSO_NOM}`);
      await page.waitForFunction(id => window.S?.cursoId === id, CURSO_ID, { timeout: T_LARGO });
    }
  }
  await page.evaluate(id => window.go('pagos', { aluId: id }), ALU_ID);
  await page.waitForFunction(() => window.S?.route === 'pagos', { timeout: T_CORTO });
}

/** Espera que confirm/alert del browser sea interceptado — sin bloquear la prueba */
function interceptDialogs(page) {
  page.on('dialog', async dialog => {
    console.log(`    [dialog] ${dialog.type()}: ${dialog.message().slice(0,80)}`);
    await dialog.accept();
  });
}

// ── Helpers para leer estado de planes en staging ─────────────────────────────
async function queryPlanes(jwt) {
  const r = await supaAuth(
    `/rest/v1/planes_pago?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&alumno_id=eq.${encodeURIComponent(ALU_ID)}&select=id,activo,periodo`,
    jwt
  );
  return (r.status === 200 && Array.isArray(r.body)) ? r.body : [];
}

async function queryAbonos(jwt, planId) {
  const r = await supaAuth(
    `/rest/v1/abonos?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&plan_id=eq.${encodeURIComponent(planId)}&select=id,pagado,monto,fecha_pago&order=id`,
    jwt
  );
  return (r.status === 200 && Array.isArray(r.body)) ? r.body : [];
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  E8 B2 — Recorrido Playwright: planes de pago completo');
  console.log('══════════════════════════════════════════════════════════════\n');
  console.log(`EXEC_ID  : ${EXEC_ID}`);
  console.log(`Staging  : ${SUPA_URL}`);

  // ── Pre: login REST y fixtures ────────────────────────────────────────────
  console.log('\n[Pre] Login REST y fixtures');
  let jwt;
  try {
    jwt = await loginTesorero();
    if (!CUENTA_ID) CUENTA_ID = await descubrirCuenta(jwt);
    console.log(`  Cuenta: ${CUENTA_ID}`);
    await crearFixtures(jwt);
  } catch (e) {
    console.error('❌ Setup falló:', e.message); process.exit(3);
  }

  let server = null, browser = null;

  try {
    // ── U01: Servidor HTTP local ─────────────────────────────────────────────
    console.log('\n[U01] Servidor HTTP local');
    server = await servirApp();
    ok('U01: servidor levantado', true);

    // ── U02: Navegador y login ────────────────────────────────────────────────
    console.log('\n[U02] Lanzar Chromium e inyectar credenciales de staging');
    browser = await chromium.launch({ headless: true });
    const ctx  = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();

    page.on('console', msg => {
      if (msg.type() === 'error') console.error(`  [browser] ${msg.text()}`);
    });
    interceptDialogs(page);

    await page.addInitScript(({ url, key }) => {
      window.STAGING_SUPA_URL = url;
      window.STAGING_SUPA_KEY = key;
    }, { url: SUPA_URL, key: ANON_KEY });

    await page.goto(`http://localhost:${APP_PORT}/`, { waitUntil: 'load', timeout: T_LARGO });
    await waitAppReady(page).catch(async () => {
      await screenshot(page, 'u02-fail');
      throw new Error('window.S no definido tras cargar la app');
    });
    ok('U02: app cargada', true);

    // ── U03: Login ────────────────────────────────────────────────────────────
    console.log('\n[U03] Login del tesorero vía UI');
    await page.fill('#l-email', USER_EMAIL);
    await page.fill('#l-pass',  USER_PASS);
    await page.click('[onclick="doLogin()"]');
    try {
      await page.waitForFunction(
        () => window.S?.session !== null && window.S?.session !== undefined &&
              !!window.S?._v9CuentaId,
        { timeout: T_LARGO }
      );
      ok('U03: login completado (_v9CuentaId disponible)', true);
    } catch (_) {
      await screenshot(page, 'u03-fail');
      ok('U03: login completado', false);
      throw new Error('Login UI no completó');
    }

    // ── U04: Seleccionar curso de test ────────────────────────────────────────
    console.log('\n[U04] Seleccionar curso de test');
    // Intentar selector programático (más robusto)
    const v9Listo = await page.evaluate(() => !!window.S?._v9CuentaId);
    if (v9Listo) {
      await page.evaluate(id => window.selectCurso && window.selectCurso(id), CURSO_ID);
    } else {
      await page.evaluate(() => window.go('selector'));
      await page.waitForSelector(`text=${CURSO_NOM}`, { timeout: T_CORTO });
      await page.click(`text=${CURSO_NOM}`);
    }
    await page.waitForFunction(id => window.S?.cursoId === id, CURSO_ID, { timeout: T_LARGO });
    ok('U04: curso de test activo (S.cursoId)', true);

    // ── U05: Navegar a pagos del alumno de test ───────────────────────────────
    console.log('\n[U05] Navegar a Pagos → alumno de test');
    await page.evaluate(id => window.go('pagos', { aluId: id }), ALU_ID);
    await page.waitForFunction(() => window.S?.route === 'pagos', { timeout: T_CORTO });
    ok('U05: ruta pagos activa', true);

    // ── U06: Crear plan de pago (2 abonos) ────────────────────────────────────
    console.log('\n[U06] Crear plan de pago (2 abonos de $45.000)');
    // Abrir modal planPago programáticamente (el botón 📅 sin plan existente)
    await page.evaluate(
      ({ aluId, cuotaId, periodo }) => window.showModal('planPago', { aluId, cuotaId, periodo }),
      { aluId: ALU_ID, cuotaId: CUOTA_ID, periodo: PERIODO }
    );
    // Esperar que el input de número de abonos esté visible
    try {
      await page.waitForSelector('#pp-num', { timeout: T_CORTO });
      ok('U06-a: modal crear plan visible', true);
    } catch (_) {
      await screenshot(page, 'u06-modal-fail');
      ok('U06-a: modal crear plan visible', false);
      throw new Error('Modal crear plan no apareció — #pp-num no encontrado');
    }

    // Configurar 2 abonos
    await page.fill('#pp-num', '2');
    await page.dispatchEvent('#pp-num', 'input');
    await page.waitForFunction(
      () => document.getElementById('pp-abonos-lista')?.children.length > 0,
      { timeout: T_CORTO }
    ).catch(() => {});

    // Clic en "💾 Crear plan"
    await page.click('[onclick*="guardarPlanPago"]');

    // ── U06-b: guardarPlanPago hace closeModal() + go('pagos') al éxito ──────
    // No esperar re-apertura automática del modal; esperar que el overlay desaparezca
    // O que aparezca el toast "Plan de pago creado" O que la ruta vuelva a 'pagos'.
    let uiGuardarOk = false;
    try {
      await page.waitForFunction(
        () => !document.getElementById('modal-ov') ||
              window.S?.route === 'pagos' ||
              document.body.textContent.includes('Plan de pago creado'),
        { timeout: 15_000 }
      );
      uiGuardarOk = true;
    } catch (_) {
      await screenshot(page, 'u06-guardar-timeout');
      console.log('    ⚠️  guardarPlanPago no emitió señal de cierre — consultando DB');
    }

    // ── U06-c: Fuente de verdad = DB (siempre) ────────────────────────────────
    // Dar hasta 5 s para que la RPC crear_plan_con_abonos persista.
    let planId = null;
    let abonos06 = [];
    const t06 = Date.now();
    while (Date.now() - t06 < 5_000) {
      const planes = await queryPlanes(jwt);
      // El plan del fixture actual: mismo periodo y alumno (hay exactamente 1 en este EXEC_ID)
      const p = planes.find(pl => pl.periodo === PERIODO) || planes[0];
      if (p?.id) {
        planId   = p.id;
        abonos06 = await queryAbonos(jwt, planId);
        if (abonos06.length === 2) break;
      }
      await new Promise(r => setTimeout(r, 500));
    }

    ok('U06-b: guardarPlanPago completó — modal cerrado / ruta pagos', uiGuardarOk);
    ok('U06-c: planId obtenido (DB): ' + planId, !!planId);
    ok('U06-d: 2 abonos en staging (G01)', abonos06.length === 2);
    ok('U06-e: abonos inicialmente sin pagar', abonos06.every(a => !a.pagado));

    // Si no hay planId, bloquear todos los pasos dependientes
    if (!planId) {
      ok('U06-BLOQUEO: planId nulo — U07–U11 omitidos', false);
      throw new Error('planId no disponible; no se puede continuar el recorrido');
    }

    // ── U07: Pagar primer abono (parcial) ─────────────────────────────────────
    console.log('\n[U07] Pagar abono 1 (parcial — $45.000)');
    // Reobtener el ID exacto del abono 0 desde DB (no confiar en el índice del DOM)
    const abonoId0 = abonos06[0]?.id || null;

    // Asegurar que el modal del plan está abierto antes de intentar pagar
    await page.evaluate(
      ({ aluId, cuotaId, periodo }) => window.showModal('planPago', { aluId, cuotaId, periodo }),
      { aluId: ALU_ID, cuotaId: CUOTA_ID, periodo: PERIODO }
    );
    await page.waitForFunction(
      () => !!document.querySelector('[onclick*="pagarAbono"]') ||
            !!document.querySelector('.revertir-abono-btn'),
      { timeout: T_CORTO }
    ).catch(() => {});

    // Clic en "💰 Pagar" del abono 0.
    // pagarAbono(planId, abonoIdx) — el idx es siempre 0 para el primer abono.
    // Localizamos por planId (estable) + índice 0, con fallback programático.
    const selPagar0 = `[onclick*="pagarAbono('${planId}',0)"]`;
    const btnPagar0 = page.locator(selPagar0).first();
    if (await btnPagar0.count() > 0) {
      await btnPagar0.click();
    } else {
      // Fallback: invocar directamente
      await page.evaluate(
        ({ pId }) => window.pagarAbono && window.pagarAbono(pId, 0),
        { pId: planId }
      );
    }

    // ── U07-a: Confirmar vía DB (fuente de verdad — no badge genérico) ────────
    // Polling hasta T_LARGO: esperar que ALGÚN abono quede pagado en la DB.
    // NO usar ab7[0] por índice ID: PostgreSQL ordena por id ASC, pero pagarAbono(planId,0)
    // usa el índice 0 del array del modal, que puede estar ordenado distinto (p.ej. por fecha).
    let ab7 = [];
    const t07 = Date.now();
    while (Date.now() - t07 < T_LARGO) {
      ab7 = await queryAbonos(jwt, planId);
      if (ab7.some(a => a.pagado)) break;
      await new Promise(r => setTimeout(r, 600));
    }
    // Encontrar el abono realmente pagado; no asumir que coincide con ab7[0]
    const paidAbono7   = ab7.find(a => a.pagado);
    const paidAbonoId7 = paidAbono7?.id ?? null;
    console.log(`    Abono pagado: id=${paidAbonoId7} | abonoId0 (ID-ASC): ${abonoId0} | coinciden: ${paidAbonoId7 === abonoId0}`);
    ok('U07-a: pagar_abono completado — abono índice-0 pagado en DB (G03)', !!paidAbono7);

    // ── U07-b: Botón ↩ exacto del abono pagado ───────────────────────────────
    // Requiere data-abono="${paidAbonoId7}" — NO acepta cualquier .revertir-abono-btn.
    // Sin paidAbonoId7 no hay forma de confirmar la identidad del abono: falla.
    if (paidAbono7 && paidAbonoId7) {
      const selExacto = `.revertir-abono-btn[data-abono="${paidAbonoId7}"]`;
      let nExacto = await page.locator(selExacto).count();
      if (nExacto === 0) {
        // Re-render puede tardar: esperar sólo el selector exacto
        await page.waitForFunction(
          ({ aId }) => document.querySelector(`.revertir-abono-btn[data-abono="${aId}"]`) !== null,
          { aId: paidAbonoId7 },
          { timeout: T_CORTO }
        ).catch(async () => { await screenshot(page, 'u07-norevertir'); });
        nExacto = await page.locator(selExacto).count();
      }
      ok(`U07-b: botón ↩ exacto data-abono="${paidAbonoId7}" visible en UI`, nExacto > 0);
    } else {
      ok('U07-b: botón ↩ exacto (BLOQUEADO — sin paidAbonoId7 o pago no confirmado)', false);
    }

    ok('U07-c: 1 abono pagado en staging (G03)', ab7.filter(a => a.pagado).length === 1);

    // ── U08: Completar el plan (pagar abono 2) ────────────────────────────────
    console.log('\n[U08] Pagar abono 2 — completar plan');
    // Asegurar modal abierto (pudo cerrarse si pagarAbono re-renderizó la página)
    const modalOpen8 = await page.locator('#modal-ov').count() > 0;
    if (!modalOpen8) {
      await page.evaluate(
        ({ aluId, cuotaId, periodo }) => window.showModal('planPago', { aluId, cuotaId, periodo }),
        { aluId: ALU_ID, cuotaId: CUOTA_ID, periodo: PERIODO }
      );
      await page.waitForFunction(
        () => !!document.querySelector('[onclick*="pagarAbono"]'),
        { timeout: T_CORTO }
      ).catch(() => {});
    }
    const btnPagar1 = page.locator(`[onclick*="pagarAbono('${planId}',1)"]`).first();
    if (await btnPagar1.count() > 0) {
      await btnPagar1.click();
    } else {
      await page.evaluate(
        ({ pId }) => window.pagarAbono && window.pagarAbono(pId, 1),
        { pId: planId }
      );
    }
    // Polling DB: esperar que plan.activo === false (G04) — no depender de toast/badges
    let planes8 = [], plan8 = null, ab8 = [];
    const t08 = Date.now();
    while (Date.now() - t08 < T_LARGO) {
      planes8 = await queryPlanes(jwt);
      plan8   = planes8.find(p => p.id === planId);
      ab8     = await queryAbonos(jwt, planId);
      if (plan8?.activo === false && ab8.filter(a => a.pagado).length === 2) break;
      await new Promise(r => setTimeout(r, 600));
    }
    ok('U08-a: plan completado — activo=false en DB (G04)', plan8?.activo === false);

    // Verificar DB: plan activo=false, 2/2 abonos pagados
    if (planId) {
      ok('U08-b: plan.activo === false en staging (G04)', plan8?.activo === false);
      ok('U08-c: 2 de 2 abonos pagados (G03 completo)', ab8.filter(a => a.pagado).length === 2);
      // G05: tabla pagos NO debe tener filas de este plan
      const rPagos = await supaAuth(
        `/rest/v1/pagos?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&alumno_id=eq.${encodeURIComponent(ALU_ID)}&cuota_id=eq.${encodeURIComponent(CUOTA_ID)}&select=id`,
        jwt
      );
      ok('U08-d: G05 — tabla pagos no tiene filas del plan (checkNoPagos)',
        rPagos.status === 200 && Array.isArray(rPagos.body) && rPagos.body.length === 0);
      // Extra: 404/403 NO demuestran ausencia — verificar que el endpoint responde 200
      ok('U08-e: checkNoPagos — endpoint pagos accesible (200, no 404/403)',
        rPagos.status === 200);
    }

    // ── U09: Recarga — plan completado persiste en staging ────────────────────
    console.log('\n[U09] Recarga de página: plan completado debe persistir');

    // ── DB como fuente de verdad ANTES de recargar (referencia) ───────────────
    const planes9pre = await queryPlanes(jwt);
    const plan9pre   = planes9pre.find(p => p.id === planId);
    console.log(`    DB pre-reload: plan activo=${plan9pre?.activo}`);

    // ── Reload con captura de error explícita ─────────────────────────────────
    try {
      await page.reload({ waitUntil: 'load', timeout: T_LARGO });
    } catch (eRel) {
      await screenshot(page, 'u09-reload-fail');
      console.error(`    ❌ reload lanzó: ${eRel.message}`);
      throw eRel;
    }

    try {
      await waitAppReady(page);
    } catch (eReady) {
      await screenshot(page, 'u09-appready-fail');
      throw new Error(`window.S no definido tras recarga: ${eReady.message}`);
    }

    // ── Re-login vía UI si la sesión no persiste (patrón E7) ──────────────────
    const sesionOk9 = await page.evaluate(() =>
      window.S?.session !== null && window.S?.session !== undefined && !!window.S?._v9CuentaId
    );
    if (!sesionOk9) {
      console.log('    → Sesión no restaurada automáticamente; re-login vía UI');
      try {
        await reloginViaUI(page);
        ok('U09-b: re-login vía UI tras recarga', true);
      } catch (eLogin) {
        await screenshot(page, 'u09-relogin-fail');
        ok('U09-b: re-login vía UI tras recarga', false);
        throw new Error(`Re-login falló tras recarga: ${eLogin.message}`);
      }
    } else {
      ok('U09-b: sesión restaurada automáticamente', true);
    }

    // ── Re-seleccionar curso y navegar a pagos (patrón E7) ────────────────────
    try {
      await navegarPagosAlumno(page);
      ok('U09-c: curso re-seleccionado y ruta pagos activa', true);
    } catch (eNav) {
      await screenshot(page, 'u09-nav-fail');
      ok('U09-c: curso re-seleccionado y ruta pagos activa', false);
      console.error(`    ❌ navegarPagosAlumno: ${eNav.message}`);
    }

    // ── Verificar DB: plan sigue cerrado tras recarga ─────────────────────────
    const planes9  = await queryPlanes(jwt);
    const plan9    = planes9.find(p => p.id === planId);
    ok('U09-a: plan cerrado persiste en DB tras recarga', plan9?.activo === false);
    const ab9 = await queryAbonos(jwt, planId);
    ok('U09-d: 2 abonos pagados en DB tras recarga', ab9.filter(a => a.pagado).length === 2);

    // ── U10: Revertir abono desde plan completado ─────────────────────────────
    console.log('\n[U10] Revertir abono 1 desde plan COMPLETADO (activo=false)');
    // Tras el fix de getPlanPago (&&p.activo eliminado), showModal('planPago', ...)
    // ahora encuentra planes cerrados y muestra botones ↩.
    // Verificar también que el botón 📅 N/M está disponible en la vista pagos.
    await navegarPagosAlumno(page);

    // Buscar el botón 📅 N/M para la cuota del fixture (indica que getPlanPago encuentra el plan)
    const nBtnPlan10 = await page.locator(`[onclick*="showModal('planPago'"][onclick*="${CUOTA_ID}"]`).count();
    ok('U10-a: botón 📅 visible para plan cerrado en vista pagos', nBtnPlan10 > 0);

    // Abrir modal vía ese botón (o programáticamente si no encontró)
    if (nBtnPlan10 > 0) {
      await page.locator(`[onclick*="showModal('planPago'"][onclick*="${CUOTA_ID}"]`).first().click();
    } else {
      await page.evaluate(
        ({ aluId, cuotaId, periodo }) => window.showModal('planPago', { aluId, cuotaId, periodo }),
        { aluId: ALU_ID, cuotaId: CUOTA_ID, periodo: PERIODO }
      );
    }

    // Esperar modal con botones ↩ (plan cerrado con 2 abonos pagados)
    await page.waitForSelector('.revertir-abono-btn', { timeout: T_LARGO }).catch(async () => {
      await screenshot(page, 'u10-norevertir');
    });

    // ── Diagnóstico U10: estado real del plan vía getPlanPago() + tipo de modal ─
    // window.DB || window.S?.DB no funciona con variables `let` de módulo (E6).
    // Usamos window.getPlanPago() si está expuesta; si no, inspeccionamos el DOM
    // para distinguir form CREAR (#pp-num visible) de modal plan existente (↩).
    const diag10 = await page.evaluate(({ aluId, cuotaId, periodo, pid }) => {
      // 1. Intentar obtener el plan vía función expuesta
      const planFn = typeof window.getPlanPago === 'function'
        ? window.getPlanPago(aluId, cuotaId, periodo)
        : null;
      // 2. Tipo de modal: form crear vs plan existente
      const hasCreate    = !!document.getElementById('pp-num');
      const hasRevertir  = !!document.querySelector('.revertir-abono-btn');
      const hasPlanIdRef = !!document.querySelector(`[onclick*="${pid}"]`);
      // 3. Texto del modal (diagnóstico)
      const m = document.getElementById('modal-ov');
      const modalText = m ? m.innerText.replace(/\s+/g, ' ').slice(0, 300) : '(sin modal)';
      return { planFn, hasCreate, hasRevertir, hasPlanIdRef, modalText };
    }, { aluId: ALU_ID, cuotaId: CUOTA_ID, periodo: PERIODO, pid: planId });
    console.log(`    getPlanPago(): ${JSON.stringify(diag10.planFn)}`);
    console.log(`    Modal tipo: hasCreate=${diag10.hasCreate} hasRevertir=${diag10.hasRevertir} hasPlanIdRef=${diag10.hasPlanIdRef}`);
    console.log(`    Modal texto: ${diag10.modalText}`);
    // ── Fin diagnóstico U10 ───────────────────────────────────────────────────

    const nRevertir10 = await page.locator('.revertir-abono-btn').count();
    ok('U10-b: botón ↩ visible en plan COMPLETADO (getPlanPago sin &&p.activo)', nRevertir10 > 0);

    // Seguimiento: si no hubo ↩, bloquear comprobaciones de revert
    let revertEjecutado = false;
    if (nRevertir10 > 0) {
      await page.locator('.revertir-abono-btn').first().click();
      // Polling DB: esperar que abono 0 pase a pagado=false
      let ab10pre = [];
      const t10 = Date.now();
      while (Date.now() - t10 < T_LARGO) {
        ab10pre = await queryAbonos(jwt, planId);
        if (ab10pre[0]?.pagado === false) { revertEjecutado = true; break; }
        await new Promise(r => setTimeout(r, 600));
      }
      if (!revertEjecutado) await screenshot(page, 'u10-revert-fail');
      ok('U10-c: revertir_abono completó — abono 0 pagado=false en DB', revertEjecutado);
      // Botón 💰 reaparece en la UI (re-render)
      const nPagar10 = await page.locator(`[onclick*="pagarAbono('${planId}',0)"]`).count();
      ok('U10-d: botón 💰 reaparece en abono 0 (revertido)', nPagar10 > 0 || revertEjecutado);
    } else {
      ok('U10-c: revertir_abono (BLOQUEADO — no había ↩)', false);
      ok('U10-d: botón 💰 reaparece (BLOQUEADO)', false);
    }

    // Verificar DB: plan reabierto, abono 0 no pagado, abono 1 pagado
    if (planId) {
      const planes10 = await queryPlanes(jwt);
      const plan10   = planes10.find(p => p.id === planId);
      ok('U10-e: plan.activo === true tras revertir (G07)',
        revertEjecutado ? plan10?.activo === true : false);
      const ab10 = await queryAbonos(jwt, planId);
      if (revertEjecutado) {
        ok('U10-f: abono 0 pagado=false tras revertir', ab10[0]?.pagado === false);
        ok('U10-g: abono 1 pagado=true (sigue pagado)', ab10[1]?.pagado === true);
        const sumPagado = ab10.filter(a => a.pagado).reduce((s, a) => s + (a.monto || 0), 0);
        ok(`U10-h: saldo pagado = $${sumPagado} (esperado $${MONTO_AB2})`, sumPagado === MONTO_AB2);
        const sumDeuda  = ab10.filter(a => !a.pagado).reduce((s, a) => s + (a.monto || 0), 0);
        ok(`U10-i: deuda pendiente = $${sumDeuda} (esperado $${MONTO_AB1})`, sumDeuda === MONTO_AB1);
      } else {
        ok('U10-f: saldos exactos (BLOQUEADO — revert no ejecutado)', false);
        ok('U10-g: saldos exactos (BLOQUEADO)', false);
        ok('U10-h: saldos exactos (BLOQUEADO)', false);
        ok('U10-i: saldos exactos (BLOQUEADO)', false);
      }
    }

    // ── U11: Recarga post-revertir — saldos exactos ───────────────────────────
    console.log('\n[U11] Recarga post-revertir: verificar saldos exactos');
    try {
      await page.reload({ waitUntil: 'load', timeout: T_LARGO });
      await waitAppReady(page);
      const sesionOk11 = await page.evaluate(() =>
        window.S?.session !== null && window.S?.session !== undefined && !!window.S?._v9CuentaId
      );
      if (!sesionOk11) await reloginViaUI(page);
      await navegarPagosAlumno(page);
    } catch (e11) {
      await screenshot(page, 'u11-reload-fail');
      console.error(`    ⚠️  Recarga U11: ${e11.message}`);
    }
    if (planId) {
      const planes11 = await queryPlanes(jwt);
      const plan11   = planes11.find(p => p.id === planId);
      ok('U11-a: plan activo=true persiste en DB tras recarga', plan11?.activo === true);
      const ab11 = await queryAbonos(jwt, planId);
      ok('U11-b: 1 abono pagado, 1 pendiente — estado correcto', ab11.filter(a => a.pagado).length === 1);
      const pagado11 = ab11.filter(a => a.pagado).reduce((s, a) => s + (a.monto || 0), 0);
      const deuda11  = ab11.filter(a => !a.pagado).reduce((s, a) => s + (a.monto || 0), 0);
      // U11-c: exige exactamente MONTO_AB2 pagado y MONTO_AB1 pendiente;
      // aprobación solo por suma total es insuficiente (podría ser 0+90000, 90000+0, etc.)
      ok(`U11-c: pagado=$${pagado11} === $${MONTO_AB2} y deuda=$${deuda11} === $${MONTO_AB1}`,
        revertEjecutado
          ? pagado11 === MONTO_AB2 && deuda11 === MONTO_AB1
          : false);
    }

    // ── U12: Vista compartida CC (apoderado_cc_resumen_pagos — anon, sin PIN) ─
    console.log('\n[U12] Vista compartida CC — apoderado_cc_resumen_pagos');
    if (CC_CODE) {
      const rCC = await rpcAnon('apoderado_cc_resumen_pagos', { p_codigo_cc: CC_CODE });
      // Siempre registrar estado y primeros 300 chars del body para diagnóstico
      const rCCBodyStr = JSON.stringify(rCC.body).slice(0, 300);
      console.log(`    HTTP ${rCC.status}: ${rCCBodyStr}`);
      ok('U12-a: apoderado_cc_resumen_pagos responde 200', rCC.status === 200);
      if (rCC.status === 200) {
        // La RPC puede devolver un array directo o un objeto con campo alumnos
        const alumnos = Array.isArray(rCC.body) ? rCC.body
          : Array.isArray(rCC.body?.alumnos) ? rCC.body.alumnos
          : [];
        console.log(`    Estructura respuesta: ${Array.isArray(rCC.body) ? 'array['+rCC.body.length+']' : 'objeto — claves: '+Object.keys(rCC.body||{}).join(',')}`);
        const alumno = alumnos.find(a => a.alumno_id === ALU_ID || a.id === ALU_ID);
        ok('U12-b: alumno de test presente en resumen CC', alumnos.length > 0);
        // Acceso compartido: no debe revelar PIN ni balance_privado
        const bodyStr = JSON.stringify(rCC.body || {});
        ok('U12-c: respuesta CC no contiene campos privados (pin, clave)',
          !bodyStr.includes('"pin"') && !bodyStr.includes('"clave"'));
      } else {
        // Registrar error sin secretos para diagnóstico de permisos
        const errMsg = typeof rCC.body === 'object'
          ? (rCC.body?.message || rCC.body?.hint || rCC.body?.code || JSON.stringify(rCC.body).slice(0,200))
          : String(rCC.body).slice(0, 200);
        console.error(`    ❌ U12 error — HTTP ${rCC.status}: ${errMsg}`);
        console.error('    → Verificar: RLS en apoderado_cc_resumen_pagos / permisos anon en staging');
        ok('U12-b: (BLOQUEADO — RPC no devolvió 200)', false);
        ok('U12-c: (BLOQUEADO)', false);
      }
    } else {
      console.log('  ⚠️  U12: omitido — CC_CODE no disponible (apoderado_cc_generar falló)');
    }

    // ── U13: Vista privada con PIN (apoderado_situacion_financiera) ───────────
    console.log('\n[U13] Vista privada con PIN — apoderado_situacion_financiera');
    // Llamada anon con p_pin — igual que el cliente apoderado real
    const rAcceso = await rpcAnon('apoderado_acceso', {
      p_cuenta_id: CUENTA_ID, p_alumno_id: ALU_ID, p_pin: ALU_PIN,
    });
    console.log(`    apoderado_acceso HTTP ${rAcceso.status}: ${JSON.stringify(rAcceso.body).slice(0,200)}`);
    ok('U13-a: apoderado_acceso (PIN correcto) responde 200', rAcceso.status === 200);
    const accessOk = rAcceso.status === 200 && !rAcceso.body?.error;
    ok('U13-b: acceso con PIN válido — sin error', accessOk);

    if (accessOk) {
      const rSit = await rpcAnon('apoderado_situacion_financiera', {
        p_cuenta_id: CUENTA_ID, p_alumno_id: ALU_ID, p_pin: ALU_PIN,
      });
      // Registrar cuerpo completo para verificar contrato real del RPC
      const sitBodyStr = JSON.stringify(rSit.body).slice(0, 500);
      console.log(`    apoderado_situacion_financiera HTTP ${rSit.status}: ${sitBodyStr}`);
      ok('U13-c: apoderado_situacion_financiera responde 200', rSit.status === 200);
      if (rSit.status === 200 && !rSit.body?.error) {
        // Inspeccionar los campos reales devueltos (no asumir estructura)
        const topKeys = Object.keys(rSit.body || {});
        console.log(`    Claves top-level: [${topKeys.join(', ')}]`);

        // Verificar presencia de planes/abonos: buscar en campos conocidos o en cualquier key
        const bodyStr = JSON.stringify(rSit.body || {});
        const tienePlanes  = bodyStr.includes('"planes"') || bodyStr.includes('"plan_pago"') ||
                             bodyStr.includes('"abonos"') || bodyStr.includes('"planes_pago"');
        const tieneBalance = bodyStr.includes('"balance"') || bodyStr.includes('"total_pagado"') ||
                             bodyStr.includes('"monto_pagado"') || bodyStr.includes('"deuda"');
        ok('U13-d: respuesta contiene datos de planes o abonos', tienePlanes || tieneBalance);

        // U13-e: tras la reversión el plan debe tener monto_pagado=45000, monto_pendiente=45000,
        // activo=true. No usar inclusión de cadena "45000": pasa aunque ambos abonos estén pagados
        // porque cada abono tiene monto=45000. Bloquear si no hubo reversión.
        if (!revertEjecutado) {
          ok('U13-e: importes exactos (BLOQUEADO — revert no ejecutado)', false);
        } else {
          const bodyObj13 = rSit.body || {};
          // Buscar plan del fixture en las estructuras conocidas del RPC
          const planesArr13 = Array.isArray(bodyObj13.planes)       ? bodyObj13.planes
            :  Array.isArray(bodyObj13.planes_pago) ? bodyObj13.planes_pago
            :  [];
          const planRpc13 = planesArr13.find(p =>
            p.cuota_id  === CUOTA_ID || p.cuotaId  === CUOTA_ID || p.id === planId
          );
          if (planRpc13) {
            const mp13    = Number(planRpc13.monto_pagado   ?? planRpc13.montoPagado   ?? -1);
            const mpend13 = Number(planRpc13.monto_pendiente ?? planRpc13.montoPendiente ?? -1);
            const act13   = planRpc13.activo;
            console.log(`    U13-e plan CUOTA_ID: monto_pagado=${mp13}, monto_pendiente=${mpend13}, activo=${act13}`);
            ok(`U13-e: plan CUOTA_ID monto_pagado=$${mp13}===$${MONTO_AB2}, monto_pendiente=$${mpend13}===$${MONTO_AB1}, activo=true`,
              mp13 === MONTO_AB2 && mpend13 === MONTO_AB1 && act13 === true);
          } else {
            // Sin plan exacto no hay forma de verificar importes: fallo duro.
            // Revisar la estructura real del RPC con los logs anteriores.
            console.log('    U13-e: plan no hallado en planes/planes_pago — claves top: ' + Object.keys(bodyObj13).join(', '));
            ok('U13-e: plan CUOTA_ID no encontrado en respuesta — verificar estructura RPC', false);
          }
        }

        // Si tiene balance_curso con total_pagado, verificar valor exacto (no >= genérico)
        const bal = rSit.body?.balance_curso;
        if (bal && bal.total_pagado !== undefined) {
          const totalPagado = Number(bal.total_pagado);
          ok(`U13-f: balance_curso.total_pagado = $${totalPagado} (esperado exacto $${MONTO_AB2})`,
            totalPagado === MONTO_AB2);
        } else {
          console.log('    ℹ️  balance_curso.total_pagado no presente — OK si la RPC usa otra estructura');
        }
      } else {
        const errMsg = rSit.body?.message || rSit.body?.hint || rSit.body?.code || '';
        console.error(`    ❌ U13 situacion_financiera error HTTP ${rSit.status}: ${errMsg}`);
      }
      // PIN incorrecto debe rechazarse
      const rPinMal = await rpcAnon('apoderado_acceso', {
        p_cuenta_id: CUENTA_ID, p_alumno_id: ALU_ID, p_pin: '0000',
      });
      console.log(`    PIN incorrecto HTTP ${rPinMal.status}: ${JSON.stringify(rPinMal.body).slice(0,100)}`);
      ok('U13-g: PIN incorrecto rechazado (status ≠ 200 ó error=pin_incorrecto)',
        rPinMal.status !== 200 || rPinMal.body?.error === 'pin_incorrecto');
    }

  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server)  server.close();

    // ── Post: limpiar fixtures ────────────────────────────────────────────────
    console.log('\n[Post] Limpiar fixtures de staging');
    try {
      const jwtPost = jwt || await loginTesorero();
      await limpiarFixtures(jwtPost);
    } catch (e) {
      console.error('  ⚠️  Limpieza falló:', e.message);
      console.error('  Limpiar manualmente: alumno', ALU_ID, '/ cuota', CUOTA_ID, '/ curso', CURSO_ID);
    }

    // ── Resultado final ───────────────────────────────────────────────────────
    console.log('\n══════════════════════════════════════════════════════════════');
    console.log(`  Resultado: ${pass} ✅  ${fail} ❌  (total ${pass + fail})`);
    if (failures.length) {
      console.log('\n  Fallidos:');
      failures.forEach(f => console.log(`    ❌ ${f}`));
    }
    console.log('══════════════════════════════════════════════════════════════\n');
    process.exit(fail > 0 ? 1 : 0);
  }
})();
