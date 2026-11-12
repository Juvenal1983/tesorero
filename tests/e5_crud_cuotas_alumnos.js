/**
 * tests/e5_crud_cuotas_alumnos.js
 *
 * E5 — CRUD relacional cuotas y alumnos/apoderados
 *
 * Verifica que crear / editar / eliminar cuotas, alumnos y apoderados
 * persiste correctamente en Supabase staging cuando V9_RELACIONAL=true.
 *
 * Requisitos de entorno (mismos que browser_test_staging_ui.js):
 *   STAGING_SUPABASE_URL        — https://rucgmytyxpfowznowxwd.supabase.co
 *   STAGING_SUPABASE_ANON_KEY   — anon key del proyecto de staging
 *   STAGING_USER_A_EMAIL        — email del tesorero A
 *   STAGING_USER_A_PASSWORD     — contraseña del tesorero A
 *
 * Ejecución:
 *   bash/zsh : export $(grep -v '^#' .env | xargs) && node tests/e5_crud_cuotas_alumnos.js
 *   CMD      : for /f "usebackq tokens=1,* delims==" %A in (`type .env ^| findstr /v "^#"`) do set %A=%B
 *              node tests/e5_crud_cuotas_alumnos.js
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

const SUPA_URL   = process.env.STAGING_SUPABASE_URL;
const ANON_KEY   = process.env.STAGING_SUPABASE_ANON_KEY;
const USER_EMAIL = process.env.STAGING_USER_A_EMAIL;
const USER_PASS  = process.env.STAGING_USER_A_PASSWORD;

// ── Guard producción ─────────────────────────────────────────────────────────
const STAGING_HOSTNAME = 'rucgmytyxpfowznowxwd.supabase.co';
const PROD_HOSTNAME    = 'tmjqzaakzhecbldebyeg.supabase.co';
let parsedHost;
try { parsedHost = new URL(SUPA_URL).hostname; }
catch (_) { console.error('❌ STAGING_SUPABASE_URL no es una URL válida.'); process.exit(2); }
if (parsedHost === PROD_HOSTNAME) {
  console.error('❌ CRÍTICO: URL apunta a producción. Abortando.'); process.exit(2);
}
if (parsedHost !== STAGING_HOSTNAME) {
  console.error(`❌ Hostname inesperado: ${parsedHost}`); process.exit(2);
}

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { chromium } = require('playwright');

// ── EXEC_ID: delimita fixtures de este run ────────────────────────────────────
const EXEC_ID     = Date.now().toString(36);
const APP_PORT    = 8788;   // puerto diferente al test UI principal
const APP_DIR     = path.resolve(__dirname, '..');

// IDs de fixtures — serán creados en el setup y limpiados en teardown
const CURSO_ID    = `crs-e5-${EXEC_ID}`;
const CUOTA_ID    = `cuo-e5-${EXEC_ID}`;
const ALU_ID      = `alu-e5-${EXEC_ID}`;
const AP_ID       = `ap-e5-${EXEC_ID}`;

const CURSO_NOMBRE  = `E5 Test ${EXEC_ID}`;
const CUOTA_NOMBRE  = `Cuota E5 ${EXEC_ID}`;
const ALU_NOMBRES   = 'E5';
const ALU_APELLIDOS = `Test${EXEC_ID}`;
const AP_NOMBRE     = `Apoderado E5 ${EXEC_ID}`;

const TIMEOUT_CORTO = 10_000;
const TIMEOUT_LARGO = 25_000;

let pass = 0, fail = 0;
const failures = [];
let jwt = null, cuentaId = null;

function ok(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else       { console.error(`  ❌ ${label}`); fail++; failures.push(label); }
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
function _fetch(urlPath, opts = {}) {
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
        let parsed;
        try { parsed = JSON.parse(data); } catch (_) { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function supaAuth(urlPath, opts = {}) {
  return _fetch(urlPath, { ...opts, authHeader: 'Bearer ' + jwt });
}

// ── Login REST ────────────────────────────────────────────────────────────────
async function loginREST() {
  const res = await _fetch('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body:   { email: USER_EMAIL, password: USER_PASS },
    prefer: '',
  });
  if (res.status !== 200 || !res.body?.access_token)
    throw new Error(`Login falló (HTTP ${res.status}): ${JSON.stringify(res.body)}`);
  jwt = res.body.access_token;
}

async function descubrirCuentaId() {
  const res = await supaAuth('/rest/v1/tesorero_cuentas?select=id&limit=1');
  if (res.status !== 200 || !Array.isArray(res.body) || res.body.length === 0)
    throw new Error(`tesorero_cuentas vacío (HTTP ${res.status}): ${JSON.stringify(res.body)}`);
  cuentaId = res.body[0].id;
}

// ── Setup: crear curso fixture en DB directamente ────────────────────────────
async function setupCurso() {
  const res = await supaAuth('/rest/v1/cursos', {
    method: 'POST',
    body: {
      cuenta_id: cuentaId,
      id:        CURSO_ID,
      nombre:    CURSO_NOMBRE,
      anio:      new Date().getFullYear(),
      activo:    true,
    },
  });
  if (res.status < 200 || res.status >= 300)
    throw new Error(`No se pudo crear curso fixture (HTTP ${res.status}): ${JSON.stringify(res.body)}`);
  console.log(`  📦 Curso fixture creado: ${CURSO_ID}`);
}

// ── Teardown: limpiar fixtures ────────────────────────────────────────────────
async function teardown() {
  console.log('\n🧹 Limpieza de fixtures E5...');
  // Eliminar en orden FK: apoderados → pagos → alumnos → cuotas → cursos
  await supaAuth(`/rest/v1/apoderados?cuenta_id=eq.${cuentaId}&id=like.ap-e5-${EXEC_ID}%`, { method: 'DELETE', prefer: '' });
  await supaAuth(`/rest/v1/alumnos?cuenta_id=eq.${cuentaId}&id=like.alu-e5-${EXEC_ID}%`, { method: 'DELETE', prefer: '' });
  await supaAuth(`/rest/v1/cuotas?cuenta_id=eq.${cuentaId}&id=like.cuo-e5-${EXEC_ID}%`,  { method: 'DELETE', prefer: '' });
  await supaAuth(`/rest/v1/cursos?cuenta_id=eq.${cuentaId}&id=like.crs-e5-${EXEC_ID}%`,  { method: 'DELETE', prefer: '' });
  console.log('  ✓ Fixtures eliminados');

  console.log('\n  📋 SQL admin para limpiar manualmente si es necesario:');
  console.log(`  DELETE FROM apoderados WHERE cuenta_id='${cuentaId}' AND id LIKE 'ap-e5-${EXEC_ID}%';`);
  console.log(`  DELETE FROM alumnos    WHERE cuenta_id='${cuentaId}' AND id LIKE 'alu-e5-${EXEC_ID}%';`);
  console.log(`  DELETE FROM cuotas     WHERE cuenta_id='${cuentaId}' AND id LIKE 'cuo-e5-${EXEC_ID}%';`);
  console.log(`  DELETE FROM cursos     WHERE cuenta_id='${cuentaId}' AND id LIKE 'crs-e5-${EXEC_ID}%';`);
}

// ── Verificación directa en PostgreSQL ───────────────────────────────────────
async function verificarCuota(id, expectedFields) {
  const res = await supaAuth(`/rest/v1/cuotas?cuenta_id=eq.${cuentaId}&id=eq.${id}&select=*&limit=1`);
  if (res.status !== 200 || !Array.isArray(res.body) || res.body.length === 0) return null;
  const row = res.body[0];
  for (const [k, v] of Object.entries(expectedFields)) {
    if (row[k] !== v) {
      console.error(`    ⚠ cuotas.${k}: esperado ${JSON.stringify(v)}, obtenido ${JSON.stringify(row[k])}`);
      return false;
    }
  }
  return true;
}

async function verificarAlumno(id, expectedFields) {
  const res = await supaAuth(`/rest/v1/alumnos?cuenta_id=eq.${cuentaId}&id=eq.${id}&select=*&limit=1`);
  if (res.status !== 200 || !Array.isArray(res.body) || res.body.length === 0) return null;
  const row = res.body[0];
  for (const [k, v] of Object.entries(expectedFields)) {
    if (row[k] !== v) {
      console.error(`    ⚠ alumnos.${k}: esperado ${JSON.stringify(v)}, obtenido ${JSON.stringify(row[k])}`);
      return false;
    }
  }
  return true;
}

async function verificarApoderado(id, expectedFields) {
  const res = await supaAuth(`/rest/v1/apoderados?cuenta_id=eq.${cuentaId}&id=eq.${id}&select=*&limit=1`);
  if (res.status !== 200 || !Array.isArray(res.body) || res.body.length === 0) return null;
  const row = res.body[0];
  for (const [k, v] of Object.entries(expectedFields)) {
    if (row[k] !== v) {
      console.error(`    ⚠ apoderados.${k}: esperado ${JSON.stringify(v)}, obtenido ${JSON.stringify(row[k])}`);
      return false;
    }
  }
  return true;
}

async function verificarEliminado(tabla, id) {
  const res = await supaAuth(`/rest/v1/${tabla}?cuenta_id=eq.${cuentaId}&id=eq.${id}&select=id&limit=1`);
  return res.status === 200 && Array.isArray(res.body) && res.body.length === 0;
}

// ── Servidor HTTP local ───────────────────────────────────────────────────────
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
        html = html.replace(/https:\/\/STAGING_SUPA_HOST/g, `https://${STAGING_HOSTNAME}`);
        html = html.replace(/wss:\/\/STAGING_SUPA_HOST/g,   `wss://${STAGING_HOSTNAME}`);
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

async function screenshot(page, nombre) {
  try {
    const p = path.join(__dirname, `e5-${nombre}-${EXEC_ID}.png`);
    await page.screenshot({ path: p, fullPage: true });
    console.log(`    📸 ${p}`);
  } catch (_) {}
}

// ── Login UI + esperar sesión relacional ──────────────────────────────────────
async function loginUI(page) {
  await page.goto(`http://localhost:${APP_PORT}/`, { waitUntil: 'load', timeout: TIMEOUT_LARGO });
  await page.waitForFunction(() => typeof window.S !== 'undefined', { timeout: TIMEOUT_LARGO });

  const tieneForm = await page.locator('#l-email').count() > 0;
  if (!tieneForm) return; // ya con sesión
  await page.fill('#l-email', USER_EMAIL);
  await page.fill('#l-pass',  USER_PASS);
  await page.click('[onclick="doLogin()"]');
  await page.waitForFunction(
    () => window.S?.session !== null && window.S?.session !== undefined && !!window.S?._v9CuentaId,
    { timeout: TIMEOUT_LARGO }
  );
}

// ── Seleccionar curso fixture ─────────────────────────────────────────────────
async function seleccionarCurso(page) {
  // Esperar a que la sesión esté lista
  await page.waitForFunction(() => !!window.S?._v9CuentaId, { timeout: TIMEOUT_LARGO });
  await page.evaluate(id => window.selectCurso && window.selectCurso(id), CURSO_ID);
  await page.waitForFunction(id => window.S?.cursoId === id, CURSO_ID, { timeout: TIMEOUT_LARGO });
}

// ── Recorrido UI cuotas ───────────────────────────────────────────────────────
async function testCuotas(page) {
  console.log('\n📋 Cuotas CRUD...');

  // Navegar a cuotas
  await page.evaluate(() => window.go('cuotas'));
  await page.waitForFunction(() => window.S?.route === 'cuotas', { timeout: TIMEOUT_CORTO });

  // ── E5.C1: Crear cuota ──────────────────────────────────────────────────────
  console.log('  → E5.C1: Crear cuota');
  await page.evaluate(() => window.showModal('addCuota'));
  await page.waitForSelector('#q-nombre', { timeout: TIMEOUT_CORTO });

  await page.fill('#q-nombre', CUOTA_NOMBRE);
  await page.fill('#q-monto',  '15000');

  // Limpiar el modal antes de guardar para capturar el ID asignado
  // Escuchar cuál ID recibirá la cuota (lo veremos en DB)
  await page.click('[onclick*="saveCuota"]');

  // Esperar que el modal se cierre y volvamos a cuotas
  await page.waitForFunction(() => window.S?.route === 'cuotas' && !window.S?.modal, { timeout: TIMEOUT_LARGO });
  ok('E5.C1a: modal cuota cerrado tras guardar', true);

  // Buscar el ID de la cuota recién creada en DB.cuotas (caché local)
  const cuotaIdCreada = await page.evaluate(nombre =>
    (window.DB?.cuotas || []).find(q => q.nombre === nombre)?.id || null,
    CUOTA_NOMBRE
  );
  ok('E5.C1b: cuota aparece en caché local', !!cuotaIdCreada);

  // Verificar en PostgreSQL
  if (cuotaIdCreada) {
    const enDB = await verificarCuota(cuotaIdCreada, { nombre: CUOTA_NOMBRE, monto: 15000 });
    ok('E5.C1c: cuota persistida en PostgreSQL', enDB === true);
  }

  // ── E5.C2: Editar cuota ─────────────────────────────────────────────────────
  if (cuotaIdCreada) {
    console.log('  → E5.C2: Editar cuota');
    await page.evaluate(id => window.showModal('editCuota', { id }), cuotaIdCreada);
    await page.waitForSelector('#q-nombre', { timeout: TIMEOUT_CORTO });

    // Limpiar y cambiar monto
    await page.fill('#q-monto', '20000');
    await page.click('[onclick*="saveCuota"]');
    await page.waitForFunction(() => window.S?.route === 'cuotas' && !window.S?.modal, { timeout: TIMEOUT_LARGO });
    ok('E5.C2a: modal cuota cerrado tras editar', true);

    const enDB = await verificarCuota(cuotaIdCreada, { monto: 20000 });
    ok('E5.C2b: monto actualizado en PostgreSQL', enDB === true);
  }

  // ── E5.C3: Eliminar cuota ───────────────────────────────────────────────────
  if (cuotaIdCreada) {
    console.log('  → E5.C3: Eliminar cuota');
    // Interceptar el confirm
    await page.evaluate(() => { window._origConfirm = window.confirm; window.confirm = () => true; });
    await page.evaluate(id => window.delCuota(id), cuotaIdCreada);

    // Esperar que la cuota desaparezca del caché local
    await page.waitForFunction(
      id => !(window.DB?.cuotas || []).some(q => q.id === id),
      cuotaIdCreada, { timeout: TIMEOUT_LARGO }
    );
    ok('E5.C3a: cuota eliminada del caché local', true);

    const eliminada = await verificarEliminado('cuotas', cuotaIdCreada);
    ok('E5.C3b: cuota eliminada de PostgreSQL', eliminada);

    // Restaurar confirm
    await page.evaluate(() => { if (window._origConfirm) window.confirm = window._origConfirm; });
  }
}

// ── Recorrido UI alumnos ──────────────────────────────────────────────────────
async function testAlumnos(page) {
  console.log('\n👥 Alumnos CRUD...');
  let aluIdCreado = null;

  // Navegar a alumnos
  await page.evaluate(() => window.go('alumnos'));
  await page.waitForFunction(() => window.S?.route === 'alumnos', { timeout: TIMEOUT_CORTO });

  // ── E5.A1: Crear alumno ─────────────────────────────────────────────────────
  console.log('  → E5.A1: Crear alumno');
  await page.evaluate(() => window.showModal('addAlumno'));
  await page.waitForSelector('#m-nombres', { timeout: TIMEOUT_CORTO });

  await page.fill('#m-nombres',   ALU_NOMBRES);
  await page.fill('#m-apellidos', ALU_APELLIDOS);

  await page.click('[onclick*="saveAlumno(\'\')"]');
  await page.waitForFunction(() => window.S?.route === 'alumnos' && !window.S?.modal, { timeout: TIMEOUT_LARGO });
  ok('E5.A1a: modal alumno cerrado tras crear', true);

  aluIdCreado = await page.evaluate(apellidos =>
    (window.DB?.alumnos || []).find(a => a.apellidos === apellidos)?.id || null,
    ALU_APELLIDOS
  );
  ok('E5.A1b: alumno aparece en caché local', !!aluIdCreado);

  if (aluIdCreado) {
    const enDB = await verificarAlumno(aluIdCreado, { nombres: ALU_NOMBRES, apellidos: ALU_APELLIDOS, estado: 'activo' });
    ok('E5.A1c: alumno persistido en PostgreSQL', enDB === true);
  }

  // ── E5.A2: Editar alumno ────────────────────────────────────────────────────
  if (aluIdCreado) {
    console.log('  → E5.A2: Editar alumno (marcar eximido)');
    await page.evaluate(id => window.showModal('editAlumno', { id }), aluIdCreado);
    await page.waitForSelector('#m-nombres', { timeout: TIMEOUT_CORTO });

    // Marcar eximido
    const eximidoCheck = page.locator('#m-eximido');
    const estaChecked  = await eximidoCheck.isChecked();
    if (!estaChecked) await eximidoCheck.check();

    await page.click(`[onclick*="saveAlumno('${aluIdCreado}')"]`);
    await page.waitForFunction(() => window.S?.route === 'alumnos' && !window.S?.modal, { timeout: TIMEOUT_LARGO });
    ok('E5.A2a: modal alumno cerrado tras editar', true);

    const enDB = await verificarAlumno(aluIdCreado, { eximido: true });
    ok('E5.A2b: eximido=true persistido en PostgreSQL', enDB === true);
  }

  // ── E5.P1/P2/P3: Apoderados ─────────────────────────────────────────────────
  if (aluIdCreado) {
    await testApoderados(page, aluIdCreado);
  }

  // ── E5.A3: Eliminar alumno ──────────────────────────────────────────────────
  if (aluIdCreado) {
    console.log('  → E5.A3: Eliminar alumno');
    await page.evaluate(() => window.go('alumnos'));
    await page.waitForFunction(() => window.S?.route === 'alumnos', { timeout: TIMEOUT_CORTO });

    await page.evaluate(() => { window._origConfirm = window.confirm; window.confirm = () => true; });
    await page.evaluate(id => window.delAlumno(id), aluIdCreado);

    await page.waitForFunction(
      id => !(window.DB?.alumnos || []).some(a => a.id === id),
      aluIdCreado, { timeout: TIMEOUT_LARGO }
    );
    ok('E5.A3a: alumno eliminado del caché local', true);

    const eliminado = await verificarEliminado('alumnos', aluIdCreado);
    ok('E5.A3b: alumno eliminado de PostgreSQL', eliminado);

    await page.evaluate(() => { if (window._origConfirm) window.confirm = window._origConfirm; });
  }

  return aluIdCreado;
}

// ── Recorrido UI apoderados ───────────────────────────────────────────────────
async function testApoderados(page, alumnoId) {
  console.log('\n  👤 Apoderados CRUD...');
  let apIdCreado = null;

  // ── E5.P1: Crear apoderado ──────────────────────────────────────────────────
  console.log('    → E5.P1: Crear apoderado');
  await page.evaluate(id => window.showModal('apoderadosAlumno', { id }), alumnoId);
  await page.waitForSelector('#ap-nombre', { timeout: TIMEOUT_CORTO });

  await page.fill('#ap-nombre', AP_NOMBRE);
  await page.locator('#ap-rel').selectOption('Madre');
  await page.fill('#ap-tel',   '+56 9 1234 5678');

  await page.click(`[onclick*="saveAp('${alumnoId}')"]`);
  // Esperar que el modal se reabra en apoderadosAlumno (vuelve a listar)
  await page.waitForFunction(
    id => window.S?.modal?.type === 'apoderadosAlumno' && window.S?.modal?.data?.id === id,
    alumnoId, { timeout: TIMEOUT_LARGO }
  );
  ok('E5.P1a: modal vuelve a listar apoderados', true);

  apIdCreado = await page.evaluate(nombre =>
    (window.DB?.apoderados || []).find(a => a.nombre === nombre)?.id || null,
    AP_NOMBRE
  );
  ok('E5.P1b: apoderado en caché local', !!apIdCreado);

  if (apIdCreado) {
    const enDB = await verificarApoderado(apIdCreado, { nombre: AP_NOMBRE, alumno_id: alumnoId, relacion: 'Madre' });
    ok('E5.P1c: apoderado persistido en PostgreSQL', enDB === true);
  }

  // ── E5.P2: Editar apoderado ─────────────────────────────────────────────────
  if (apIdCreado) {
    console.log('    → E5.P2: Editar apoderado');
    await page.evaluate((apId, aluId) => window.showModal('editApoderadoTesorero', { apId, alumnoId: aluId }), apIdCreado, alumnoId);
    await page.waitForSelector('#eapt-nombre', { timeout: TIMEOUT_CORTO });

    // Cambiar relación a Padre
    await page.locator('#eapt-rel').selectOption('Padre');
    await page.click(`[onclick*="saveEditApTesorero('${apIdCreado}'"]`);

    await page.waitForFunction(
      id => window.S?.modal?.type === 'apoderadosAlumno' && window.S?.modal?.data?.id === id,
      alumnoId, { timeout: TIMEOUT_LARGO }
    );
    ok('E5.P2a: modal vuelve a listar tras editar', true);

    const enDB = await verificarApoderado(apIdCreado, { relacion: 'Padre' });
    ok('E5.P2b: relacion=Padre persistido en PostgreSQL', enDB === true);
  }

  // ── E5.P3: Eliminar apoderado ───────────────────────────────────────────────
  if (apIdCreado) {
    console.log('    → E5.P3: Eliminar apoderado');
    await page.evaluate(() => { window._origConfirm = window.confirm; window.confirm = () => true; });
    await page.evaluate(id => window.delAp(id), apIdCreado);

    await page.waitForFunction(
      id => !(window.DB?.apoderados || []).some(a => a.id === id),
      apIdCreado, { timeout: TIMEOUT_LARGO }
    );
    ok('E5.P3a: apoderado eliminado del caché local', true);

    const eliminado = await verificarEliminado('apoderados', apIdCreado);
    ok('E5.P3b: apoderado eliminado de PostgreSQL', eliminado);

    await page.evaluate(() => { if (window._origConfirm) window.confirm = window._origConfirm; });
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n🚀 E5 CRUD cuotas + alumnos/apoderados — EXEC_ID: ${EXEC_ID}`);
  console.log('  Staging:', SUPA_URL);

  let server, browser, page;

  try {
    // Setup REST
    console.log('\n⚙️  Setup...');
    await loginREST();
    await descubrirCuentaId();
    console.log(`  cuenta_id: ${cuentaId}`);

    await setupCurso();

    // Levantar servidor app
    server = await servirApp();

    // Lanzar Playwright
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext();
    page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') console.error('  🖥 ' + m.text()); });

    // Login UI
    console.log('\n🔑 Login UI...');
    await loginUI(page);
    ok('Login UI completado', true);

    // Seleccionar curso fixture
    await seleccionarCurso(page);
    ok('Curso fixture seleccionado', true);

    // ── Cuotas CRUD ──────────────────────────────────────────────────────────
    await testCuotas(page);

    // ── Alumnos + Apoderados CRUD ─────────────────────────────────────────────
    await testAlumnos(page);

  } catch (err) {
    console.error('\n💥 Error inesperado:', err.message);
    if (page) await screenshot(page, 'fatal');
    fail++;
    failures.push('Error inesperado: ' + err.message);
  } finally {
    if (browser) await browser.close();
    if (server)  server.close();
    await teardown();

    // ── Resumen ───────────────────────────────────────────────────────────────
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Total: ${pass + fail}  ✅ ${pass}  ❌ ${fail}`);
    if (failures.length) {
      console.log('\nFallidos:');
      failures.forEach(f => console.log('  • ' + f));
    } else {
      console.log('\n✅ E5 CRUD relacional cuotas + alumnos/apoderados — TODO OK');
    }
    process.exit(fail > 0 ? 1 : 0);
  }
})();
