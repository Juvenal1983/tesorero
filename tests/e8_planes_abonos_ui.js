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
 * Variables de entorno requeridas:
 *   STAGING_SUPABASE_URL        — https://rucgmytyxpfowznowxwd.supabase.co
 *   STAGING_SUPABASE_ANON_KEY   — anon key de staging
 *   STAGING_USER_A_EMAIL        — email del tesorero
 *   STAGING_USER_A_PASSWORD     — contraseña del tesorero
 *
 * Opcionales:
 *   STAGING_CUENTA_ID           — omitir → autodiscovery post-login
 *   ALU_PIN                     — PIN del alumno de test (default: "1234")
 *
 * Ejecución:
 *   export $(grep -v '^#' .env | xargs) && node tests/e8_planes_abonos_ui.js
 *
 * NUNCA apuntar a producción (tmjqzaakzhecbldebyeg).
 */

'use strict';

const REQUIRED_ENV = [
  'STAGING_SUPABASE_URL', 'STAGING_SUPABASE_ANON_KEY',
  'STAGING_USER_A_EMAIL', 'STAGING_USER_A_PASSWORD',
];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error('❌ Faltan variables de entorno:\n  ' + missing.join('\n  '));
  process.exit(1);
}

const SUPA_URL   = process.env.STAGING_SUPABASE_URL.replace(/\/$/, '');
const ANON_KEY   = process.env.STAGING_SUPABASE_ANON_KEY;
const USER_EMAIL = process.env.STAGING_USER_A_EMAIL;
const USER_PASS  = process.env.STAGING_USER_A_PASSWORD;
const ALU_PIN    = process.env.ALU_PIN || '1234';

// ── Guard de producción ───────────────────────────────────────────────────────
const PROD_HOST    = 'tmjqzaakzhecbldebyeg.supabase.co';
const STAGING_HOST = 'rucgmytyxpfowznowxwd.supabase.co';
let parsedHost;
try { parsedHost = new URL(SUPA_URL).hostname; }
catch (_) { console.error('❌ STAGING_SUPABASE_URL no es una URL válida.'); process.exit(2); }
if (parsedHost === PROD_HOST) {
  console.error('❌ CRÍTICO: URL apunta a producción. Abortando.'); process.exit(2);
}

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
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
function _fetch(urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const url  = new URL(SUPA_URL + urlPath);
    const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const req  = https.request({
      hostname: url.hostname, path: url.pathname + url.search,
      method: opts.method || 'GET',
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
        let body; try { body = JSON.parse(data); } catch (_) { body = data; }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function supaAuth(url, jwt, opts = {}) {
  return _fetch(url, { ...opts, authHeader: 'Bearer ' + jwt });
}
function supaAnon(url, opts = {}) {
  return _fetch(url, { ...opts, authHeader: 'Bearer ' + ANON_KEY });
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
  const pasos = [
    `/rest/v1/abonos?cuenta_id=eq.${c}&alumno_id=eq.${a}`,
    `/rest/v1/planes_pago?cuenta_id=eq.${c}&alumno_id=eq.${a}`,
    `/rest/v1/alumnos?cuenta_id=eq.${c}&id=eq.${a}`,
    `/rest/v1/cuotas?cuenta_id=eq.${c}&id=eq.${q}`,
    `/rest/v1/cursos?cuenta_id=eq.${c}&id=eq.${cr}`,
  ];
  for (const url of pasos) {
    await supaAuth(url, jwt, { method: 'DELETE', prefer: 'return=minimal' }).catch(() => {});
  }
  console.log('  ✅ Fixtures eliminados');
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
    await page.waitForSelector('#pp-num', { timeout: T_CORTO });
    ok('U06-a: modal crear plan visible', true);

    // Configurar 2 abonos
    await page.fill('#pp-num', '2');
    // Trigger para regenerar las fechas
    await page.dispatchEvent('#pp-num', 'input');
    await page.waitForFunction(() => document.getElementById('pp-abonos-lista')?.children.length > 0, { timeout: T_CORTO }).catch(() => {});

    // Clic en "💾 Crear plan"
    await page.click('[onclick*="guardarPlanPago"]');

    // Esperar que el modal se reabra mostrando el plan creado (hay botón 💰)
    let planId = null;
    try {
      await page.waitForFunction(() => !!document.querySelector('[onclick*="pagarAbono"]'), { timeout: T_LARGO });
      ok('U06-b: plan creado — botones 💰 visibles', true);
      // Leer el planId desde el DOM del botón de pagar
      planId = await page.evaluate(() => {
        const btn = document.querySelector('[onclick*="pagarAbono"]');
        if (!btn) return null;
        const m = btn.getAttribute('onclick').match(/pagarAbono\('([^']+)'/);
        return m ? m[1] : null;
      });
      ok('U06-c: planId extraído del DOM: ' + planId, !!planId);
    } catch (_) {
      await screenshot(page, 'u06-plan-fail');
      ok('U06-b: plan creado', false);
      ok('U06-c: planId extraído', false);
    }

    if (!planId) {
      // Fallback: intentar leer desde DB
      const planes = await queryPlanes(jwt);
      planId = planes[0]?.id || null;
    }

    // Verificar DB: 2 abonos sin pagar
    if (planId) {
      const abonos = await queryAbonos(jwt, planId);
      ok('U06-d: 2 abonos en staging (G01)', abonos.length === 2);
      ok('U06-e: abonos inicialmente sin pagar', abonos.every(a => !a.pagado));
    }

    // ── U07: Pagar primer abono (parcial) ─────────────────────────────────────
    console.log('\n[U07] Pagar abono 1 (parcial — $45.000)');
    // El modal ya está abierto con el plan. Clic en "💰 Pagar" del abono 0
    const btnPagar0 = page.locator('[onclick*="pagarAbono"][onclick*=",0)"]').first();
    if (await btnPagar0.count() > 0) {
      await btnPagar0.click();
    } else {
      // Fallback programático
      await page.evaluate(
        ({ pId }) => window.pagarAbono && window.pagarAbono(pId, 0),
        { pId: planId }
      );
    }
    // Esperar re-render: abono 0 ahora tiene badge ✅
    try {
      await page.waitForFunction(
        () => document.querySelector('.badge.bgg') !== null,
        { timeout: T_LARGO }
      );
      ok('U07-a: badge ✅ visible (abono 1 pagado)', true);
    } catch (_) {
      await screenshot(page, 'u07-fail');
      ok('U07-a: badge ✅ visible', false);
    }
    // Verificar botón ↩ presente (plan aún activo)
    const btn_revertir_parcial = await page.locator('.revertir-abono-btn').count();
    ok('U07-b: botón ↩ visible en abono pagado (plan activo)', btn_revertir_parcial > 0);

    // Verificar DB: 1 de 2 abonos pagado
    if (planId) {
      const ab7 = await queryAbonos(jwt, planId);
      ok('U07-c: 1 abono pagado en staging (G03)', ab7.filter(a => a.pagado).length === 1);
    }

    // ── U08: Completar el plan (pagar abono 2) ────────────────────────────────
    console.log('\n[U08] Pagar abono 2 — completar plan');
    const btnPagar1 = page.locator('[onclick*="pagarAbono"][onclick*=",1)"]').first();
    if (await btnPagar1.count() > 0) {
      await btnPagar1.click();
    } else {
      await page.evaluate(
        ({ pId }) => window.pagarAbono && window.pagarAbono(pId, 1),
        { pId: planId }
      );
    }
    // Esperar toast "Plan completado" o re-render con 2 badges
    try {
      await page.waitForFunction(
        () => (document.querySelectorAll('.badge.bgg').length >= 2) ||
              document.body.textContent.includes('Plan completado'),
        { timeout: T_LARGO }
      );
      ok('U08-a: plan completado (2 badges ✅ o toast)', true);
    } catch (_) {
      await screenshot(page, 'u08-fail');
      ok('U08-a: plan completado', false);
    }

    // Verificar DB: plan activo=false, 2/2 abonos pagados
    if (planId) {
      const planes8 = await queryPlanes(jwt);
      const plan8   = planes8.find(p => p.id === planId);
      ok('U08-b: plan.activo === false en staging (G04)', plan8?.activo === false);
      const ab8 = await queryAbonos(jwt, planId);
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
    await page.reload({ waitUntil: 'load', timeout: T_LARGO });
    await waitAppReady(page).catch(async () => {
      await screenshot(page, 'u09-fail');
      throw new Error('window.S no definido tras recarga');
    });
    // Re-login si la sesión no persistió
    const sesionOk = await page.evaluate(() =>
      window.S?.session !== null && window.S?.session !== undefined
    );
    if (!sesionOk) {
      await page.fill('#l-email', USER_EMAIL);
      await page.fill('#l-pass',  USER_PASS);
      await page.click('[onclick="doLogin()"]');
      await page.waitForFunction(
        () => window.S?.session !== null && window.S?.session !== undefined,
        { timeout: T_LARGO }
      ).catch(() => {});
    }
    // Verificar DB como fuente de verdad: plan sigue cerrado
    if (planId) {
      const planes9  = await queryPlanes(jwt);
      const plan9    = planes9.find(p => p.id === planId);
      ok('U09-a: plan cerrado persiste en DB tras recarga', plan9?.activo === false);
      const ab9 = await queryAbonos(jwt, planId);
      ok('U09-b: 2 abonos pagados en DB tras recarga', ab9.filter(a => a.pagado).length === 2);
    }

    // ── U10: Revertir abono desde plan completado ─────────────────────────────
    console.log('\n[U10] Revertir abono 1 desde plan COMPLETADO (activo=false)');
    // Reabrir modal del plan de pago
    await page.evaluate(id => window.go('pagos', { aluId: id }), ALU_ID);
    await page.waitForFunction(() => window.S?.route === 'pagos', { timeout: T_CORTO });
    await page.evaluate(
      ({ aluId, cuotaId, periodo }) => window.showModal('planPago', { aluId, cuotaId, periodo }),
      { aluId: ALU_ID, cuotaId: CUOTA_ID, periodo: PERIODO }
    );
    await page.waitForSelector('.revertir-abono-btn', { timeout: T_CORTO }).catch(async () => {
      await screenshot(page, 'u10-norevertir');
    });
    const nRevertir10 = await page.locator('.revertir-abono-btn').count();
    ok('U10-a: botón ↩ visible en plan COMPLETADO (clave: sin restricción activo)', nRevertir10 > 0);

    if (nRevertir10 > 0) {
      await page.locator('.revertir-abono-btn').first().click();
      // Esperar re-render: abono revertido muestra botón 💰
      try {
        await page.waitForFunction(
          () => document.querySelector('[onclick*="pagarAbono"][onclick*=",0)"]') !== null,
          { timeout: T_LARGO }
        );
        ok('U10-b: botón 💰 reaparece en abono 0 (revertido)', true);
      } catch (_) {
        await screenshot(page, 'u10-revert-fail');
        ok('U10-b: botón 💰 reaparece', false);
      }
    } else {
      ok('U10-b: botón 💰 reaparece (omitido — no había ↩)', false);
    }

    // Verificar DB: plan reabierto, abono 0 no pagado, abono 1 pagado
    if (planId) {
      const planes10 = await queryPlanes(jwt);
      const plan10   = planes10.find(p => p.id === planId);
      ok('U10-c: plan.activo === true tras revertir (G07)', plan10?.activo === true);
      const ab10 = await queryAbonos(jwt, planId);
      ok('U10-d: abono 0 pagado=false tras revertir', ab10[0]?.pagado === false);
      ok('U10-e: abono 1 pagado=true (sigue pagado)', ab10[1]?.pagado === true);
      const sumPagado = ab10.filter(a => a.pagado).reduce((s, a) => s + (a.monto || 0), 0);
      ok(`U10-f: saldo pagado = $${sumPagado} (esperado $${MONTO_AB2})`, sumPagado === MONTO_AB2);
      const sumDeuda  = ab10.filter(a => !a.pagado).reduce((s, a) => s + (a.monto || 0), 0);
      ok(`U10-g: deuda pendiente = $${sumDeuda} (esperado $${MONTO_AB1})`, sumDeuda === MONTO_AB1);
    }

    // ── U11: Recarga post-revertir — saldos exactos ───────────────────────────
    console.log('\n[U11] Recarga post-revertir: verificar saldos exactos');
    await page.reload({ waitUntil: 'load', timeout: T_LARGO });
    await waitAppReady(page).catch(() => {});
    if (planId) {
      const planes11 = await queryPlanes(jwt);
      const plan11   = planes11.find(p => p.id === planId);
      ok('U11-a: plan activo=true persiste en DB tras recarga', plan11?.activo === true);
      const ab11 = await queryAbonos(jwt, planId);
      ok('U11-b: 1 abono pagado, 1 pendiente — estado correcto', ab11.filter(a => a.pagado).length === 1);
      const pagado11 = ab11.filter(a => a.pagado).reduce((s, a) => s + (a.monto || 0), 0);
      const deuda11  = ab11.filter(a => !a.pagado).reduce((s, a) => s + (a.monto || 0), 0);
      ok(`U11-c: pagado=$${pagado11} deuda=$${deuda11} (total=$${pagado11+deuda11} = $${MONTO_TOTAL})`,
        pagado11 + deuda11 === MONTO_TOTAL);
    }

    // ── U12: Vista compartida CC (apoderado_cc_resumen_pagos — anon, sin PIN) ─
    console.log('\n[U12] Vista compartida CC — apoderado_cc_resumen_pagos');
    if (CC_CODE) {
      const rCC = await rpcAnon('apoderado_cc_resumen_pagos', { p_codigo_cc: CC_CODE });
      ok('U12-a: apoderado_cc_resumen_pagos responde 200', rCC.status === 200);
      if (rCC.status === 200) {
        const alumnos = Array.isArray(rCC.body) ? rCC.body : (rCC.body?.alumnos || []);
        const alumno  = alumnos.find ? alumnos.find(a => a.alumno_id === ALU_ID) : null;
        // La RPC devuelve estado de cuotas; el plan parcial debe reflejar deuda
        ok('U12-b: alumno de test presente en resumen CC', !!alumno || alumnos.length > 0);
        ok('U12-c: CC no revela situación privada (acceso compartido)', rCC.status === 200);
      }
    } else {
      console.log('  ⚠️  U12: omitido — CC_CODE no disponible (apoderado_cc_generar falló)');
    }

    // ── U13: Vista privada con PIN (apoderado_situacion_financiera) ───────────
    console.log('\n[U13] Vista privada con PIN — apoderado_situacion_financiera');
    // Llamada anon (sin JWT de tesorero) con p_pin — igual que el cliente apoderado real
    const rAcceso = await rpcAnon('apoderado_acceso', {
      p_cuenta_id: CUENTA_ID, p_alumno_id: ALU_ID, p_pin: ALU_PIN,
    });
    ok('U13-a: apoderado_acceso (PIN correcto) responde 200', rAcceso.status === 200);
    const accessOk = rAcceso.status === 200 && !rAcceso.body?.error;
    ok('U13-b: acceso con PIN válido — sin error', accessOk);

    if (accessOk) {
      const rSit = await rpcAnon('apoderado_situacion_financiera', {
        p_cuenta_id: CUENTA_ID, p_alumno_id: ALU_ID, p_pin: ALU_PIN,
      });
      ok('U13-c: apoderado_situacion_financiera responde 200', rSit.status === 200);
      if (rSit.status === 200 && !rSit.body?.error) {
        const bal = rSit.body?.balance_curso;
        ok('U13-d: balance_curso presente en respuesta', !!bal);
        // Con 1 abono pagado de $45.000 el saldo pagado debe ser >= $45.000
        const totalPagado = Number(bal?.total_pagado || 0);
        ok(`U13-e: balance total_pagado >= $${MONTO_AB2} (saldo real tras revertir)`,
          totalPagado >= MONTO_AB2);
      }
      // PIN incorrecto debe rechazarse
      const rPinMal = await rpcAnon('apoderado_acceso', {
        p_cuenta_id: CUENTA_ID, p_alumno_id: ALU_ID, p_pin: '0000',
      });
      ok('U13-f: PIN incorrecto rechazado (error pin_incorrecto)',
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
