/**
 * tests/e7_ui.js — E7 recorrido UI (Playwright + servidor local)
 *
 * Levanta la app en localhost (igual que E6), inyecta credenciales de staging
 * desde el .env existente — no requiere STAGING_APP_URL.
 *
 * Flujos cubiertos:
 *   UI-CFG.1  toggleFondoEspecial(true) → fondo_especial.activo=true en DB
 *   UI-CFG.2  guardarNombreFondo() → nombre persistido en PostgreSQL
 *   UI-FM.1   saveMovFondo() aporte 30000/3 → fondo_movimientos + sum(asignaciones)=30000
 *   UI-FM.2   guardarEditMovFondo() → monto_total=31000 + sum(asignaciones)=31000
 *   UI-FM.3   page.reload() → movimiento sigue visible en DOM
 *   UI-FM.4   cambio de curso → datos de curso1 no aparecen en curso2
 *   UI-FM.5   eliminarMovFondo() → ausente en DB
 *   UI-ACT.1  saveActividad() crear → actividad en DB
 *   UI-ACT.2  saveActividad() editar → nombre + monto_total persistidos
 *   UI-ACT.3  page.reload() → actividad editada visible
 *   UI-ACT.4  eliminarActividad() → ausente en DB
 *   UI-RPT.1  drawReporteCharts() → datasets[0].data[7] === montoTotal actividad (agosto)
 *   UI-VIS.1  Usuario C (visor) puede SELECT del curso fixture (REST) antes del rechazo
 *
 * Fixtures: exclusivos por ejecución (EXEC_ID), limpieza en finally.
 * Teardown: solo la membresía visor creada por este run.
 * Guard: aborta si SUPA_URL apunta a tmjqzaakzhecbldebyeg.supabase.co.
 *
 * Variables de entorno (.env en raíz del repo):
 *   STAGING_URL (o STAGING_SUPABASE_URL)
 *   STAGING_KEY (o STAGING_SUPABASE_ANON_KEY)
 *   STAGING_EMAIL (o STAGING_USER_A_EMAIL)
 *   STAGING_PASS  (o STAGING_USER_A_PASSWORD)
 *
 * Opcionales (si faltan, UI-VIS.1 queda PENDING):
 *   STAGING_USER_C_EMAIL / STAGING_USER_C_PASSWORD
 *
 * Uso:
 *   npm run test:e7ui
 *   node tests/e7_ui.js
 *
 * ⚠️  NUNCA ejecutar contra producción: tmjqzaakzhecbldebyeg.supabase.co
 */

'use strict';

const path = require('path');
const http = require('http');
const fs   = require('fs');
const vm   = require('vm');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

// ── Entorno ───────────────────────────────────────────────────────────────────
const SUPA_URL   = (process.env.STAGING_URL || process.env.STAGING_SUPABASE_URL || '').replace(/\/$/, '');
const ANON_KEY   = process.env.STAGING_KEY  || process.env.STAGING_SUPABASE_ANON_KEY || '';
const USER_EMAIL = process.env.STAGING_EMAIL || process.env.STAGING_USER_A_EMAIL || '';
const USER_PASS  = process.env.STAGING_PASS  || process.env.STAGING_USER_A_PASSWORD || '';
const USER_C_EMAIL = process.env.STAGING_USER_C_EMAIL || '';
const USER_C_PASS  = process.env.STAGING_USER_C_PASSWORD || '';

// ── Guard producción ──────────────────────────────────────────────────────────
if (SUPA_URL.includes('tmjqzaakzhecbldebyeg')) {
  console.error('🚫 URL apunta a producción. Abortando.');
  process.exit(1);
}

const faltantes = [
  ['STAGING_URL / STAGING_SUPABASE_URL',      SUPA_URL],
  ['STAGING_KEY / STAGING_SUPABASE_ANON_KEY', ANON_KEY],
  ['STAGING_EMAIL / STAGING_USER_A_EMAIL',    USER_EMAIL],
  ['STAGING_PASS / STAGING_USER_A_PASSWORD',  USER_PASS],
].filter(([, v]) => !v).map(([k]) => k);

if (faltantes.length) {
  console.error('❌ Faltan variables en .env:\n  ' + faltantes.join('\n  '));
  process.exit(1);
}

// ── Constantes ────────────────────────────────────────────────────────────────
const { chromium } = require('playwright');

const STAGING_HOST = new URL(SUPA_URL).hostname;
const APP_DIR      = path.resolve(__dirname, '..');
const APP_PORT     = 8792;                        // Puerto distinto al de E6 (8790)
const BASE_URL     = `http://localhost:${APP_PORT}`;
const EXEC_ID      = Date.now().toString(36);

const TIMEOUT_CORTO = 15_000;
const TIMEOUT_LARGO = 30_000;

// ── Contadores ────────────────────────────────────────────────────────────────
let pass_ = 0, fail_ = 0, pend_ = 0;
const failures = [];

function ok(id, desc) {
  pass_++;
  console.log(`  ✅ ${id.padEnd(12)} ${desc}`);
}
function ko(id, desc, err) {
  fail_++;
  const msg = err?.message || String(err);
  console.error(`  ❌ ${id.padEnd(12)} ${desc}: ${msg}`);
  failures.push({ id, desc, err: msg });
}
function pend(id, desc, reason) {
  pend_++;
  console.log(`  ⏳ ${id.padEnd(12)} ${desc} [PENDING: ${reason}]`);
}

// ── Servidor local (mismo patrón que E6) ─────────────────────────────────────
function servirApp() {
  const MIME = {
    '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
    '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
  };
  const server = http.createServer((req, res) => {
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
        // Reemplazar placeholder CSP
        html = html.replace(/https:\/\/STAGING_SUPA_HOST/g, `https://${STAGING_HOST}`);
        html = html.replace(/wss:\/\/STAGING_SUPA_HOST/g,   `wss://${STAGING_HOST}`);
        // Inyectar credenciales de staging (equivale a __env.js)
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
      console.log(`  Servidor app: ${BASE_URL}`);
      resolve(server);
    });
    server.on('error', reject);
  });
}

// ── Screenshot de depuración ──────────────────────────────────────────────────
async function screenshot(page, nombre) {
  try {
    const p = path.join(__dirname, `e7ui-${nombre}-${EXEC_ID}.png`);
    await page.screenshot({ path: p, fullPage: true });
    console.log(`    📸 ${p}`);
  } catch (_) {}
}

// ── REST helper (Node) ────────────────────────────────────────────────────────
async function rest(urlPath, opts = {}, token = '') {
  const url = `${SUPA_URL}/rest/v1${urlPath}`;
  const res = await fetch(url, {
    method: opts.method || 'GET',
    body:   opts.body   || undefined,
    headers: {
      'apikey':        ANON_KEY,
      'Authorization': `Bearer ${token || ANON_KEY}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
      'Prefer':        opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  return { status: res.status, ok: res.ok, body };
}

// ── Autenticar ────────────────────────────────────────────────────────────────
async function autenticar(email, pass) {
  const url = `${SUPA_URL}/auth/v1/token?grant_type=password`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: pass }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token)
    throw new Error(`Auth falló (HTTP ${res.status}): ${JSON.stringify(data)}`);
  return { token: data.access_token, userId: data.user?.id };
}

// ── Cargar getFondoAlumno real (vm.runInNewContext) ────────────────────────────
// Permite verificar sumas de asignaciones individuales sin reconstruir la lógica.
function cargarFuncionesReales(mockDB, mockS, mockAlumnos) {
  const fondosSource = fs.readFileSync(
    path.resolve(__dirname, '..', 'js', 'features', 'fondos.js'), 'utf8'
  );
  const ctx = vm.createContext({
    DB:         mockDB,
    S:          mockS,
    getAlumnos: () => mockAlumnos,
    getCurso:   () => null,
    clp:        v  => v,
    go:         () => {},
    document:   { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null },
    console,
  });
  vm.runInContext(fondosSource, ctx);
  return {
    getFondoAlumno:      ctx.getFondoAlumno.bind(ctx),
    getFondoAlumnoHasta: ctx.getFondoAlumnoHasta.bind(ctx),
  };
}

// ── Verificar suma de asignaciones individuales (via funciones reales) ─────────
// Reconstruye el estado mínimo de DB/S para llamar getFondoAlumno por cada alumno
// y verifica que sum(saldos) === montoTotal.
function verificarSumaAsignaciones(movimientos, alumnos, cursoId, montoEsperado) {
  const mockDB = { fondoMovimientos: movimientos };
  const mockS  = { cursoId, _v9CuentaId: 'cta-test' };
  const { getFondoAlumno } = cargarFuncionesReales(mockDB, mockS, alumnos);
  const saldos = alumnos.map(a => getFondoAlumno(a.id).total);
  const suma   = saldos.reduce((a, b) => a + b, 0);
  if (suma !== montoEsperado)
    throw new Error(`sum(asignaciones)=${suma} ≠ montoTotal=${montoEsperado}; saldos=[${saldos}]`);
  return saldos;
}

// ── Setup: crear fixtures independientes ──────────────────────────────────────
async function setup(jwt, cuentaId) {
  console.log('\n[Setup] Creando fixtures UI...');

  // Curso fixture principal
  const rC = await rest('/cursos', {
    method: 'POST', _token: jwt,
    body: JSON.stringify({
      cuenta_id: cuentaId,
      nombre:    `Curso-E7UI-${EXEC_ID}`,
      colegio:   'Test-E7UI',
      tipo_org:  'curso',
      fondo_especial: { activo: false, nombre: 'Fondo Especial' },
    }),
  }, jwt);
  if (!rC.ok) throw new Error(`Crear curso: ${JSON.stringify(rC.body)}`);
  const cursoId = (Array.isArray(rC.body) ? rC.body[0] : rC.body).id;
  console.log(`  [setup] Curso fixture: ${cursoId}`);

  // 3 alumnos
  const alumnos = [];
  for (let i = 1; i <= 3; i++) {
    const rA = await rest('/alumnos', {
      method: 'POST', _token: jwt,
      body: JSON.stringify({ cuenta_id: cuentaId, curso_id: cursoId, nombre: `Alu-E7UI-${EXEC_ID}-${i}` }),
    }, jwt);
    if (!rA.ok) throw new Error(`Crear alumno ${i}: ${JSON.stringify(rA.body)}`);
    alumnos.push(Array.isArray(rA.body) ? rA.body[0] : rA.body);
  }
  console.log(`  [setup] 3 alumnos creados`);

  // Curso 2 para prueba de aislamiento
  const rC2 = await rest('/cursos', {
    method: 'POST', _token: jwt,
    body: JSON.stringify({
      cuenta_id: cuentaId,
      nombre:    `Curso-E7UI2-${EXEC_ID}`,
      colegio:   'Test-E7UI2',
      tipo_org:  'curso',
      fondo_especial: { activo: false, nombre: 'Fondo Especial' },
    }),
  }, jwt);
  if (!rC2.ok) throw new Error(`Crear curso2: ${JSON.stringify(rC2.body)}`);
  const curso2Id = (Array.isArray(rC2.body) ? rC2.body[0] : rC2.body).id;
  console.log(`  [setup] Curso2 fixture: ${curso2Id}`);

  return { cursoId, curso2Id, alumnos };
}

// ── Teardown ──────────────────────────────────────────────────────────────────
async function teardown(jwt, cuentaId, state) {
  console.log('\n[Teardown] Limpiando fixtures de esta ejecución...');
  const { cursoId, curso2Id, membershipCId } = state;

  if (membershipCId) {
    await rest(`/usuarios_cuenta?id=eq.${membershipCId}`,
      { method: 'DELETE', prefer: '' }, jwt).catch(e => console.warn(`  membresía C: ${e.message}`));
    console.log('  [teardown] membresía visor C eliminada');
  }
  if (cursoId) {
    await rest(`/fondo_movimientos?cuenta_id=eq.${cuentaId}&curso_id=eq.${cursoId}`,
      { method: 'DELETE', prefer: '' }, jwt).catch(() => {});
    await rest(`/actividades?cuenta_id=eq.${cuentaId}&curso_id=eq.${cursoId}`,
      { method: 'DELETE', prefer: '' }, jwt).catch(() => {});
    await rest(`/alumnos?cuenta_id=eq.${cuentaId}&curso_id=eq.${cursoId}`,
      { method: 'DELETE', prefer: '' }, jwt).catch(() => {});
    await rest(`/cursos?id=eq.${cursoId}&cuenta_id=eq.${cuentaId}`,
      { method: 'DELETE', prefer: '' }, jwt).catch(() => {});
  }
  if (curso2Id) {
    await rest(`/cursos?id=eq.${curso2Id}&cuenta_id=eq.${cuentaId}`,
      { method: 'DELETE', prefer: '' }, jwt).catch(() => {});
  }
  console.log('  [teardown] completado');
}

// ── Login UI ──────────────────────────────────────────────────────────────────
async function loginUI(page) {
  await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: TIMEOUT_LARGO });
  await page.locator('#l-email').fill(USER_EMAIL);
  await page.locator('#l-pass').fill(USER_PASS);
  await page.locator('button[onclick="doLogin()"]').click();
  await page.waitForFunction(
    () => typeof S !== 'undefined' && S.session && (S.route === 'dashboard' || S.route === 'selector'),
    { timeout: TIMEOUT_LARGO }
  );
  console.log('  [ui] login completado');
}

// ── Seleccionar curso ─────────────────────────────────────────────────────────
async function seleccionarCurso(page, cursoId) {
  await page.evaluate(() => { if (typeof go === 'function') go('selector'); });
  await page.waitForSelector(`[onclick="selectCurso('${cursoId}')"]`, { timeout: TIMEOUT_CORTO });
  await page.locator(`[onclick="selectCurso('${cursoId}')"]`).click();
  await page.waitForFunction(
    (id) => typeof S !== 'undefined' && S.cursoId === id,
    cursoId,
    { timeout: TIMEOUT_LARGO }
  );
  console.log(`  [ui] curso seleccionado: ${cursoId}`);
}

// ── Navegar a ruta ────────────────────────────────────────────────────────────
async function navegar(page, ruta, waitSelector) {
  await page.evaluate((r) => { if (typeof go === 'function') go(r); }, ruta);
  if (waitSelector) {
    await page.waitForSelector(waitSelector, { timeout: TIMEOUT_CORTO });
  } else {
    await page.waitForFunction(
      (r) => typeof S !== 'undefined' && S.route === r,
      ruta,
      { timeout: TIMEOUT_CORTO }
    );
  }
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
(async () => {
  let server, browser;
  let jwt, cuentaId;
  let fixtures = {};
  let state    = {};   // Acumula IDs para teardown

  console.log('\n=== E7 UI — Recorrido con handlers reales ===');
  console.log(`SUPA: ${SUPA_URL}`);
  console.log(`ID:   ${EXEC_ID}`);

  try {
    // ── Pre-vuelo ─────────────────────────────────────────────────────────────
    const authA = await autenticar(USER_EMAIL, USER_PASS);
    jwt = authA.token;

    const rCta = await rest('/tesorero_cuentas?select=id', {}, jwt);
    if (!rCta.ok || !rCta.body?.length) throw new Error('No se encontró cuenta para usuario A');
    cuentaId = rCta.body[0].id;
    console.log(`  [ok] cuenta: ${cuentaId}`);

    fixtures = await setup(jwt, cuentaId);
    state = { cursoId: fixtures.cursoId, curso2Id: fixtures.curso2Id };
    const { cursoId, curso2Id, alumnos } = fixtures;
    const aluIds = alumnos.map(a => a.id);

    // ── Servidor local ────────────────────────────────────────────────────────
    server = await servirApp();

    // ── Navegador ─────────────────────────────────────────────────────────────
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ baseURL: BASE_URL, locale: 'es-CL' });
    const page = await context.newPage();

    page.on('pageerror', e => {
      if (!e.message.includes('STAGING_URL_PENDIENTE'))
        console.warn(`  [browser-err] ${e.message.substring(0, 120)}`);
    });

    // ── LOGIN ─────────────────────────────────────────────────────────────────
    console.log('\n[Paso Login]');
    await loginUI(page);
    await seleccionarCurso(page, cursoId);

    // ══════════════════════════════════════════════════════════════════════════
    // UI-CFG — Configuración del fondo especial
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[UI-CFG]');

    try {
      await navegar(page, 'config',
        'button[onclick="toggleFondoEspecial(true)"], button[onclick="toggleFondoEspecial(false)"]');

      const btnActivar = page.locator('button[onclick="toggleFondoEspecial(true)"]');
      await btnActivar.waitFor({ timeout: TIMEOUT_CORTO });
      await btnActivar.click();
      await page.waitForSelector('button[onclick="toggleFondoEspecial(false)"]', { timeout: TIMEOUT_CORTO });

      const rCfg = await rest(`/cursos?id=eq.${cursoId}&select=fondo_especial`, {}, jwt);
      if (rCfg.body?.[0]?.fondo_especial?.activo !== true)
        throw new Error(`fondo_especial.activo no es true; body=${JSON.stringify(rCfg.body)}`);
      ok('UI-CFG.1', 'toggleFondoEspecial(true) → activo=true en DB');
    } catch (e) { ko('UI-CFG.1', 'toggleFondoEspecial', e); await screenshot(page, 'cfg1'); }

    const NOMBRE_FONDO = `Fondo-${EXEC_ID}`;
    try {
      await navegar(page, 'config', '#cfg-fondo-nombre');
      await page.locator('#cfg-fondo-nombre').clear();
      await page.locator('#cfg-fondo-nombre').fill(NOMBRE_FONDO);
      await page.locator('button[onclick="guardarNombreFondo()"]').click();
      await page.waitForTimeout(1500);

      const rNom = await rest(`/cursos?id=eq.${cursoId}&select=fondo_especial`, {}, jwt);
      const guardado = rNom.body?.[0]?.fondo_especial?.nombre;
      if (guardado !== NOMBRE_FONDO)
        throw new Error(`Esperado "${NOMBRE_FONDO}", obtenido "${guardado}"`);
      ok('UI-CFG.2', `guardarNombreFondo → nombre "${NOMBRE_FONDO}" persistido`);
    } catch (e) { ko('UI-CFG.2', 'guardarNombreFondo', e); await screenshot(page, 'cfg2'); }

    // ══════════════════════════════════════════════════════════════════════════
    // UI-FM — CRUD movimientos + verificación de sumas con funciones reales
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[UI-FM]');

    let movId = null;
    const MONTO_APORTE_1 = 30000;
    const MONTO_APORTE_2 = 31000;

    // FM.1 — crear aporte
    try {
      await navegar(page, 'fondo-especial', 'button[onclick*="showModal"]');
      await page.locator('button[onclick*="showModal"][onclick*="nuevoMovFondo"]').click();
      await page.waitForSelector('#fmov-nombre', { timeout: TIMEOUT_CORTO });

      await page.selectOption('#fmov-tipo', 'aporte');
      await page.waitForTimeout(400);
      await page.locator('#fmov-nombre').fill(`Aporte-${EXEC_ID}`);
      await page.locator('#fmov-fecha').fill('2026-08-15');
      await page.locator('#fmov-monto').fill(String(MONTO_APORTE_1));
      await page.locator('button[onclick="saveMovFondo()"]').click();
      await page.waitForTimeout(2000);

      // Verificar persistencia en DB
      const rMov = await rest(
        `/fondo_movimientos?cuenta_id=eq.${cuentaId}&curso_id=eq.${cursoId}&nombre=like.${encodeURIComponent(`Aporte-${EXEC_ID}%`)}&select=id,nombre,monto_total,montos_individuales`,
        {}, jwt
      );
      if (!rMov.ok || !rMov.body?.length)
        throw new Error(`Movimiento no encontrado; body=${JSON.stringify(rMov.body)}`);
      movId = rMov.body[0].id;

      // Verificar suma de asignaciones individuales con getFondoAlumno real
      // Necesitamos los movimientos del curso para el mock
      const rMovAll = await rest(
        `/fondo_movimientos?cuenta_id=eq.${cuentaId}&curso_id=eq.${cursoId}&select=*`,
        {}, jwt
      );
      // Mapear al formato que usa fondos.js (camelCase)
      const movsMapped = (rMovAll.body || []).map(m => ({
        id: m.id, tipo: m.tipo, nombre: m.nombre,
        fecha: m.fecha, montoTotal: m.monto_total || 0,
        participantes: m.participantes || [],
        montosIndividuales: m.montos_individuales || {},
        cursoId: m.curso_id,
      }));
      const aluMapped = alumnos.map(a => ({ id: a.id, nombre: a.nombre, cursoId }));
      const saldos = verificarSumaAsignaciones(movsMapped, aluMapped, cursoId, MONTO_APORTE_1);

      ok('UI-FM.1', `saveMovFondo aporte ${MONTO_APORTE_1} → id=${movId}; sum(asignaciones)=${MONTO_APORTE_1} ✓; saldos=[${saldos}]`);
    } catch (e) { ko('UI-FM.1', 'saveMovFondo', e); await screenshot(page, 'fm1'); }

    // FM.2 — editar monto
    try {
      if (!movId) throw new Error('movId no disponible (FM.1 falló)');

      await page.locator(`button[onclick*="editarMovFondo"][onclick*="${movId}"]`).click();
      await page.waitForSelector('#emov-monto', { timeout: TIMEOUT_CORTO });

      await page.locator('#emov-monto').clear();
      await page.locator('#emov-monto').fill(String(MONTO_APORTE_2));
      await page.locator(`button[onclick*="guardarEditMovFondo"][onclick*="${movId}"]`).click();
      await page.waitForTimeout(2000);

      // Verificar persistencia
      const rEdit = await rest(`/fondo_movimientos?id=eq.${movId}&select=monto_total`, {}, jwt);
      const montoGuardado = rEdit.body?.[0]?.monto_total;
      if (montoGuardado !== MONTO_APORTE_2)
        throw new Error(`monto_total esperado ${MONTO_APORTE_2}, obtenido ${montoGuardado}`);

      // Verificar suma de asignaciones después de editar
      const rMovAll = await rest(
        `/fondo_movimientos?cuenta_id=eq.${cuentaId}&curso_id=eq.${cursoId}&select=*`,
        {}, jwt
      );
      const movsMapped = (rMovAll.body || []).map(m => ({
        id: m.id, tipo: m.tipo, nombre: m.nombre,
        fecha: m.fecha, montoTotal: m.monto_total || 0,
        participantes: m.participantes || [],
        montosIndividuales: m.montos_individuales || {},
        cursoId: m.curso_id,
      }));
      const aluMapped = alumnos.map(a => ({ id: a.id, nombre: a.nombre, cursoId }));
      const saldos = verificarSumaAsignaciones(movsMapped, aluMapped, cursoId, MONTO_APORTE_2);

      ok('UI-FM.2', `guardarEditMovFondo → monto_total=${MONTO_APORTE_2}; sum(asignaciones)=${MONTO_APORTE_2} ✓; saldos=[${saldos}]`);
    } catch (e) { ko('UI-FM.2', 'guardarEditMovFondo', e); await screenshot(page, 'fm2'); }

    // FM.3 — recarga de página
    try {
      await page.reload({ waitUntil: 'networkidle', timeout: TIMEOUT_LARGO });
      await page.waitForFunction(
        (id) => typeof S !== 'undefined' && S.cursoId === id,
        cursoId,
        { timeout: TIMEOUT_LARGO }
      );
      await navegar(page, 'fondo-especial', 'button[onclick*="showModal"]');

      if (movId) {
        await page.waitForSelector(`button[onclick*="editarMovFondo"][onclick*="${movId}"]`, { timeout: TIMEOUT_CORTO });
      }

      // Verificar suma tras recarga (datos frescos del servidor)
      const rMovAll = await rest(
        `/fondo_movimientos?cuenta_id=eq.${cuentaId}&curso_id=eq.${cursoId}&select=*`,
        {}, jwt
      );
      const movsMapped = (rMovAll.body || []).map(m => ({
        id: m.id, tipo: m.tipo, nombre: m.nombre,
        fecha: m.fecha, montoTotal: m.monto_total || 0,
        participantes: m.participantes || [],
        montosIndividuales: m.montos_individuales || {},
        cursoId: m.curso_id,
      }));
      const aluMapped = alumnos.map(a => ({ id: a.id, nombre: a.nombre, cursoId }));
      const saldos = verificarSumaAsignaciones(movsMapped, aluMapped, cursoId, MONTO_APORTE_2);

      ok('UI-FM.3', `recarga → movimiento visible; sum(asignaciones)=${MONTO_APORTE_2} ✓ tras reload; saldos=[${saldos}]`);
    } catch (e) { ko('UI-FM.3', 'recarga página', e); await screenshot(page, 'fm3'); }

    // FM.4 — cambio de curso (aislamiento)
    try {
      await seleccionarCurso(page, curso2Id);
      await navegar(page, 'fondo-especial');
      await page.waitForTimeout(1500);

      const domPresente = movId
        ? await page.locator(`button[onclick*="editarMovFondo"][onclick*="${movId}"]`).count()
        : 0;
      if (domPresente > 0)
        throw new Error('Movimiento de curso1 visible en curso2 (aislamiento fallido)');
      ok('UI-FM.4', 'cambio de curso → datos de curso1 no aparecen en curso2');

      await seleccionarCurso(page, cursoId);
    } catch (e) { ko('UI-FM.4', 'aislamiento de cursos', e); await screenshot(page, 'fm4'); }

    // FM.5 — eliminar movimiento
    try {
      if (!movId) throw new Error('movId no disponible (FM.1 falló)');

      await navegar(page, 'fondo-especial',
        `button[onclick*="eliminarMovFondo"][onclick*="${movId}"]`);
      page.once('dialog', d => d.accept());
      await page.locator(`button[onclick*="eliminarMovFondo"][onclick*="${movId}"]`).click();
      await page.waitForTimeout(2000);

      const rDel = await rest(`/fondo_movimientos?id=eq.${movId}&select=id`, {}, jwt);
      if (rDel.body?.length > 0)
        throw new Error(`Movimiento sigue en DB tras eliminar; id=${movId}`);
      ok('UI-FM.5', `eliminarMovFondo → ausente en DB`);
      movId = null;
    } catch (e) { ko('UI-FM.5', 'eliminarMovFondo', e); await screenshot(page, 'fm5'); }

    // ══════════════════════════════════════════════════════════════════════════
    // UI-ACT — CRUD actividades
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[UI-ACT]');

    let actId = null;
    const MONTO_ACT = 48000;
    const MONTO_ACT_EDIT = 50000;

    // Asegurarse de estar en el curso fixture
    if (fixtures.cursoId) {
      try { await seleccionarCurso(page, cursoId); } catch (_) {}
    }

    // ACT.1 — crear actividad
    try {
      await navegar(page, 'fondo-especial', 'button[onclick*="addActividad"]');
      await page.locator('button[onclick*="addActividad"]').click();
      await page.waitForSelector('#act-nombre', { timeout: TIMEOUT_CORTO });

      await page.locator('#act-nombre').fill(`Act-${EXEC_ID}`);
      await page.locator('#act-fecha').fill('2026-08-20');
      await page.locator('#act-monto').fill(String(MONTO_ACT));
      await page.locator('#act-obs').fill(`obs-e7ui-${EXEC_ID}`);
      await page.locator('button[onclick*="saveActividad"]').click();
      await page.waitForTimeout(2000);

      const rAct = await rest(
        `/actividades?cuenta_id=eq.${cuentaId}&curso_id=eq.${cursoId}&nombre=like.${encodeURIComponent(`Act-${EXEC_ID}%`)}&select=id,nombre,monto_total`,
        {}, jwt
      );
      if (!rAct.ok || !rAct.body?.length)
        throw new Error(`Actividad no encontrada; body=${JSON.stringify(rAct.body)}`);
      actId = rAct.body[0].id;
      ok('UI-ACT.1', `saveActividad crear → id=${actId}, monto_total=${rAct.body[0].monto_total}`);
    } catch (e) { ko('UI-ACT.1', 'saveActividad crear', e); await screenshot(page, 'act1'); }

    // ACT.2 — editar actividad
    try {
      if (!actId) throw new Error('actId no disponible (ACT.1 falló)');

      await page.locator(`button[onclick*="editActividad"][onclick*="${actId}"]`).click();
      await page.waitForSelector('#act-nombre', { timeout: TIMEOUT_CORTO });

      await page.locator('#act-nombre').clear();
      await page.locator('#act-nombre').fill(`Act-Edit-${EXEC_ID}`);
      await page.locator('#act-monto').clear();
      await page.locator('#act-monto').fill(String(MONTO_ACT_EDIT));
      await page.locator(`button[onclick*="saveActividad"][onclick*="${actId}"]`).click();
      await page.waitForTimeout(2000);

      const rActEdit = await rest(`/actividades?id=eq.${actId}&select=nombre,monto_total`, {}, jwt);
      const nom   = rActEdit.body?.[0]?.nombre || '';
      const monto = rActEdit.body?.[0]?.monto_total;
      if (!nom.includes('Edit') || monto !== MONTO_ACT_EDIT)
        throw new Error(`Edición no persistida; nombre="${nom}", monto=${monto}`);
      ok('UI-ACT.2', `saveActividad editar → "${nom}", monto_total=${monto}`);
    } catch (e) { ko('UI-ACT.2', 'saveActividad editar', e); await screenshot(page, 'act2'); }

    // ACT.3 — recarga
    try {
      await page.reload({ waitUntil: 'networkidle', timeout: TIMEOUT_LARGO });
      await page.waitForFunction(
        (id) => typeof S !== 'undefined' && S.cursoId === id,
        cursoId,
        { timeout: TIMEOUT_LARGO }
      );
      await navegar(page, 'fondo-especial');
      await page.waitForTimeout(1500);

      if (actId) {
        await page.waitForSelector(`button[onclick*="editActividad"][onclick*="${actId}"]`,
          { timeout: TIMEOUT_CORTO });
      }
      ok('UI-ACT.3', 'recarga → actividad editada visible en DOM');
    } catch (e) { ko('UI-ACT.3', 'recarga actividad', e); await screenshot(page, 'act3'); }

    // ACT.4 — eliminar actividad
    try {
      if (!actId) throw new Error('actId no disponible (ACT.1 falló)');

      page.once('dialog', d => d.accept());
      await page.locator(`button[onclick*="eliminarActividad"][onclick*="${actId}"]`).click();
      await page.waitForTimeout(2000);

      const rActDel = await rest(`/actividades?id=eq.${actId}&select=id`, {}, jwt);
      if (rActDel.body?.length > 0)
        throw new Error(`Actividad sigue en DB tras eliminar; id=${actId}`);
      ok('UI-ACT.4', `eliminarActividad → ausente en DB`);
      actId = null;
    } catch (e) { ko('UI-ACT.4', 'eliminarActividad', e); await screenshot(page, 'act4'); }

    // ══════════════════════════════════════════════════════════════════════════
    // UI-RPT — Reporte: datasets de Chart.js contra importes exactos del fixture
    //
    // La app acumula ingMes[mes-1] += actividad.montoTotal para cada actividad.
    // Creamos una actividad en agosto (mes 8, índice 7) con monto conocido y
    // verificamos que datasets[0].data[7] === montoTotal de la actividad.
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[UI-RPT]');

    const MONTO_RPT    = 20000;
    const MES_RPT      = 8;       // agosto
    const IDX_RPT      = MES_RPT - 1;  // índice 0-based en Chart.js

    try {
      // Crear movimiento tipo 'actividad' con monto conocido en agosto
      const rMovRpt = await rest('/fondo_movimientos', {
        method: 'POST',
        body: JSON.stringify({
          cuenta_id:    cuentaId,
          curso_id:     cursoId,
          tipo:         'actividad',
          nombre:       `RPT-${EXEC_ID}`,
          fecha:        '2026-08-25',
          monto_total:  MONTO_RPT,
          participantes: aluIds.slice(0, 2),
        }),
        prefer: 'return=representation',
      }, jwt);
      if (!rMovRpt.ok) throw new Error(`Crear movimiento RPT: ${JSON.stringify(rMovRpt.body)}`);
      const movRptId = (Array.isArray(rMovRpt.body) ? rMovRpt.body[0] : rMovRpt.body)?.id;
      console.log(`  [rpt] movimiento actividad creado: ${movRptId}, monto=${MONTO_RPT}, mes=${MES_RPT}`);

      // Recargar la app y navegar a reportes para que drawReporteCharts use datos frescos
      await page.reload({ waitUntil: 'networkidle', timeout: TIMEOUT_LARGO });
      await page.waitForFunction(
        (id) => typeof S !== 'undefined' && S.cursoId === id,
        cursoId,
        { timeout: TIMEOUT_LARGO }
      );
      await navegar(page, 'reportes');
      await page.waitForSelector('canvas#chartRepBar', { timeout: TIMEOUT_CORTO });
      // Esperar a que Chart.js termine de dibujar (setTimeout 50ms interno + render)
      await page.waitForTimeout(1500);

      // Leer el dataset de Chart.js directamente desde la instancia adjunta al canvas
      const { datasetLabel, valorMes, chartExiste } = await page.evaluate((idx) => {
        const c = document.getElementById('chartRepBar');
        if (!c) return { chartExiste: false, datasetLabel: null, valorMes: null };

        // Chart.js ≥ 3.x: Chart.getChart(element)
        // Chart.js 2.x: element._chartjs?.listeners o element.chart
        let chart = null;
        if (window.Chart && typeof Chart.getChart === 'function') {
          chart = Chart.getChart(c);
        }
        if (!chart && c._chartjs) {
          // Fallback Chart.js 2.x interno
          const listeners = c._chartjs?.listeners;
          if (listeners && listeners.length) chart = listeners[0];
        }
        if (!chart) return { chartExiste: false, datasetLabel: null, valorMes: null };

        const ds = chart.data?.datasets?.[0];   // Primer dataset = Ingresos
        if (!ds) return { chartExiste: true, datasetLabel: null, valorMes: null };

        return {
          chartExiste:  true,
          datasetLabel: ds.label,
          valorMes:     ds.data?.[idx] ?? null,
        };
      }, IDX_RPT);

      if (!chartExiste) throw new Error('Chart.js no inicializó canvas#chartRepBar');
      if (valorMes === null) throw new Error(`datasets[0].data[${IDX_RPT}] es null`);
      if (valorMes !== MONTO_RPT)
        throw new Error(
          `datasets[0].data[${IDX_RPT}] (mes ${MES_RPT}) = ${valorMes}, esperado ${MONTO_RPT}\n` +
          `  dataset="${datasetLabel}"`
        );
      ok('UI-RPT.1',
        `drawReporteCharts → datasets[0].data[${IDX_RPT}]=${valorMes} === ${MONTO_RPT} (agosto) ✓`);
    } catch (e) { ko('UI-RPT.1', 'drawReporteCharts datasets', e); await screenshot(page, 'rpt1'); }

    // ══════════════════════════════════════════════════════════════════════════
    // UI-VIS — Usuario C puede SELECT del curso fixture (REST) antes del rechazo
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[UI-VIS]');

    if (!USER_C_EMAIL || !USER_C_PASS) {
      pend('UI-VIS.1', 'SELECT usuario C', 'STAGING_USER_C_EMAIL / _PASSWORD no configurados');
    } else {
      try {
        const authC = await autenticar(USER_C_EMAIL, USER_C_PASS);
        const jwtC  = authC.token;

        // Insertar membresía visor para C en el curso fixture (usuario A la crea)
        const rMem = await rest('/usuarios_cuenta', {
          method: 'POST',
          body: JSON.stringify({
            user_id:   authC.userId,
            cuenta_id: cuentaId,
            curso_id:  cursoId,
            rol:       'visor',
          }),
          prefer: 'return=representation',
        }, jwt);

        let membershipId = null;
        if (rMem.ok) {
          membershipId = (Array.isArray(rMem.body) ? rMem.body[0] : rMem.body)?.id;
          state.membershipCId = membershipId;
          console.log(`  [vis] membresía visor C: ${membershipId}`);
        } else {
          // Puede que ya exista; buscar
          const rEx = await rest(
            `/usuarios_cuenta?user_id=eq.${authC.userId}&curso_id=eq.${cursoId}&select=id`,
            {}, jwt
          );
          if (rEx.body?.length) {
            membershipId = rEx.body[0].id;
            console.log(`  [vis] membresía existente: ${membershipId}`);
          }
        }

        // Usuario C lee fondo_movimientos del curso fixture (debe funcionar como visor)
        const rSelect = await rest(
          `/fondo_movimientos?cuenta_id=eq.${cuentaId}&curso_id=eq.${cursoId}&select=id`,
          {}, jwtC
        );
        if (!rSelect.ok)
          throw new Error(`SELECT como visor falló HTTP ${rSelect.status}: ${JSON.stringify(rSelect.body)}`);
        ok('UI-VIS.1', `Usuario C (visor) puede SELECT fondo_movimientos del curso fixture (HTTP ${rSelect.status})`);
      } catch (e) { ko('UI-VIS.1', 'SELECT usuario C', e); }
    }

  } catch (critErr) {
    console.error(`\n[ERROR CRÍTICO] ${critErr.message}`);
    fail_++;
    failures.push({ id: 'SETUP', desc: 'Setup/Login crítico', err: critErr.message });
  } finally {
    // ── Teardown ──────────────────────────────────────────────────────────────
    try {
      if (jwt && cuentaId && (state.cursoId || state.curso2Id)) {
        await teardown(jwt, cuentaId, state);
      }
    } catch (te) {
      console.warn(`  [teardown-error] ${te.message}`);
    }
    if (browser) await browser.close().catch(() => {});
    if (server)  server.close();
  }

  // ── Resumen ────────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════');
  console.log(`RESULTADO E7-UI: ${pass_} OK / ${fail_} FALLIDO(S) / ${pend_} PENDIENTE(S)`);
  if (failures.length) {
    console.log('\nFallos:');
    failures.forEach(f => console.log(`  ❌ ${f.id}: ${f.desc} — ${f.err}`));
  }
  console.log('══════════════════════════════════════════\n');

  process.exit(fail_ > 0 ? 1 : 0);
})();
