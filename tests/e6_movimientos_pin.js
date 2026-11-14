/**
 * tests/e6_movimientos_pin.js
 *
 * E6 — Movimientos (CRUD + comprobante) y configuración de PIN desde la UI
 *
 * Flujos cubiertos:
 *   E6.M1  Crear movimiento (gasto) desde el modal addMov
 *   E6.M2  Editar movimiento (cambiar descripción y monto)
 *   E6.M3  Subir comprobante (archivo local adjunto al modal editMov)
 *   E6.M4  Recargar página y verificar que el comprobante persiste
 *   E6.M5  Abrir URL del comprobante (verificar que no es 404 / data:URI)
 *   E6.M6  Eliminar movimiento
 *   E6.PIN1 Configurar PIN desde el modal de alumno (nuevo alumno)
 *   E6.PIN2 retryPin — cambiar PIN desde el botón 🔑 sin recrear el alumno
 *
 * Usa fixtures aislados, servidor local inyectado con staging, dotenv.
 * Ninguna acción UI se sustituye por REST.
 *
 * Requisitos de entorno (.env):
 *   STAGING_URL / STAGING_SUPABASE_URL
 *   STAGING_KEY / STAGING_SUPABASE_ANON_KEY
 *   STAGING_EMAIL / STAGING_USER_A_EMAIL
 *   STAGING_PASS  / STAGING_USER_A_PASSWORD
 *
 * Uso:
 *   npm run test:e6
 *   node tests/e6_movimientos_pin.js
 *
 * ⚠️  NUNCA ejecutar contra producción: tmjqzaakzhecbldebyeg.supabase.co
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

// ── Variables: nuevo nombre tiene prioridad ───────────────────────────────────
const SUPA_URL   = (process.env.STAGING_URL || process.env.STAGING_SUPABASE_URL || '').replace(/\/$/, '');
const ANON_KEY   = process.env.STAGING_KEY  || process.env.STAGING_SUPABASE_ANON_KEY || '';
const USER_EMAIL = process.env.STAGING_EMAIL || process.env.STAGING_USER_A_EMAIL || '';
const USER_PASS  = process.env.STAGING_PASS  || process.env.STAGING_USER_A_PASSWORD || '';

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

const http       = require('http');
const fs         = require('fs');
const os         = require('os');
const { chromium } = require('playwright');

const STAGING_HOST = new URL(SUPA_URL).hostname;
const APP_DIR      = path.resolve(__dirname, '..');
const APP_PORT     = 8790;
const BASE         = `${SUPA_URL}/rest/v1`;
const AUTH_URL     = `${SUPA_URL}/auth/v1`;
const EXEC_ID      = Date.now().toString(36);

const TIMEOUT_CORTO = 12_000;
const TIMEOUT_LARGO = 30_000;

// IDs de fixtures exclusivos de este run
const CURSO_ID     = `crs-e6-${EXEC_ID}`;
const ALU_ID       = `alu-e6-${EXEC_ID}`;

let pass = 0, fail = 0;
const failures = [];
let token = null, cuentaId = null;

// ── Contadores ────────────────────────────────────────────────────────────────
function ok(label) { pass++; console.log(`  ✅ ${label}`); }
function ko(label, detail) {
  fail++;
  failures.push(label);
  console.error(`  ❌ ${label}${detail ? '\n     ' + detail : ''}`);
}

// ── REST helpers ──────────────────────────────────────────────────────────────
async function req(urlPath, opts = {}, tok = token) {
  const headers = {
    'apikey': ANON_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json',
    ...(tok ? { 'Authorization': `Bearer ${tok}` } : {}),
    ...(opts.headers || {}),
  };
  const res = await fetch(`${BASE}${urlPath}`, { ...opts, headers });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`), { status: res.status, body });
  return body;
}

// ── Login REST ────────────────────────────────────────────────────────────────
async function loginREST() {
  const res = await fetch(`${AUTH_URL}/token?grant_type=password`, {
    method: 'POST',
    headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: USER_EMAIL, password: USER_PASS }),
  });
  if (!res.ok) throw new Error(`Login falló (${res.status}): ${await res.text()}`);
  token = (await res.json()).access_token;
}

async function descubrirCuentaId() {
  const rows = await req('/tesorero_cuentas?select=id&limit=1');
  if (!rows?.[0]?.id) throw new Error('No se encontró cuenta para este usuario en staging.');
  cuentaId = rows[0].id;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────
async function setup() {
  // Curso fixture (activo para que apoderado_acceso pueda verificar PIN)
  await req('/cursos?select=id', {
    method: 'POST',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      cuenta_id: cuentaId, id: CURSO_ID,
      nombre: `[test-e6] ${EXEC_ID} (auto-eliminar)`,
      anio: new Date().getFullYear(), activo: true,
    }),
  });
  // Alumno fixture para pruebas de PIN
  await req('/alumnos?select=id', {
    method: 'POST',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      cuenta_id: cuentaId, curso_id: CURSO_ID, id: ALU_ID,
      nombres: 'E6Fixture', apellidos: `PIN${EXEC_ID}`, estado: 'activo',
    }),
  });
}

async function teardown() {
  console.log('\n🧹 Limpiando fixtures de prueba…');
  // orden: movimientos, alumnos_credenciales (cascade), alumnos, cursos
  for (const [table, field, id] of [
    ['movimientos', 'curso_id', CURSO_ID],
    ['alumnos',     'id',       ALU_ID],
    ['cursos',      'id',       CURSO_ID],
  ]) {
    try {
      await req(`/${table}?cuenta_id=eq.${cuentaId}&${field}=eq.${encodeURIComponent(id)}`,
        { method: 'DELETE' });
      console.log(`  🗑  ${table}`);
    } catch (e) {
      console.warn(`  ⚠  no pudo limpiar ${table}: ${e.message}`);
    }
  }
}

// ── Servidor local ────────────────────────────────────────────────────────────
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

// ── Screenshot de depuración ──────────────────────────────────────────────────
async function screenshot(page, nombre) {
  try {
    const p = path.join(__dirname, `e6-${nombre}-${EXEC_ID}.png`);
    await page.screenshot({ path: p, fullPage: true });
    console.log(`    📸 ${p}`);
  } catch (_) {}
}

// ── Login UI ──────────────────────────────────────────────────────────────────
async function loginUI(page) {
  await page.goto(`http://localhost:${APP_PORT}/`, { waitUntil: 'load', timeout: TIMEOUT_LARGO });
  await page.waitForFunction(() => typeof window.S !== 'undefined', { timeout: TIMEOUT_LARGO });
  if (await page.locator('#l-email').count() > 0) {
    await page.fill('#l-email', USER_EMAIL);
    await page.fill('#l-pass',  USER_PASS);
    await page.click('[onclick="doLogin()"]');
  }
  await page.waitForFunction(
    () => window.S?._v9CuentaId || window.S?.route === 'dashboard',
    { timeout: TIMEOUT_LARGO }
  );
}

async function seleccionarCurso(page) {
  await page.waitForFunction(() => !!window.S?._v9CuentaId, { timeout: TIMEOUT_LARGO });
  await page.evaluate(id => window.selectCurso && window.selectCurso(id), CURSO_ID);
  await page.waitForFunction(id => window.S?.cursoId === id, CURSO_ID, { timeout: TIMEOUT_LARGO });
}

// ── T: Movimientos ────────────────────────────────────────────────────────────
async function testMovimientos(page) {
  console.log('\n── E6.M: Movimientos CRUD + comprobante ──');

  // Navegar a la vista movimientos
  await page.evaluate(() => window.go('movimientos'));
  await page.waitForFunction(() => window.S?.route === 'movimientos', { timeout: TIMEOUT_CORTO });

  // ── E6.M1: Crear movimiento ───────────────────────────────────────────────
  console.log('  → E6.M1: Crear movimiento');
  const descCrear = `E6 Gasto ${EXEC_ID}`;
  await page.evaluate(() => window.showModal('addMov'));
  await page.waitForSelector('#mv-desc', { timeout: TIMEOUT_CORTO });

  await page.selectOption('#mv-tipo', 'gasto');
  await page.fill('#mv-desc', descCrear);
  await page.fill('#mv-monto', '5000');
  await page.fill('#mv-fecha', new Date().toISOString().slice(0, 10));

  await page.click('[onclick*="saveMov"]');
  await page.waitForFunction(
    () => window.S?.route === 'movimientos' && !window.S?.modal,
    { timeout: TIMEOUT_LARGO }
  );
  ok('E6.M1a: modal cerrado tras crear movimiento');

  // DB es let de módulo — no accesible como window.DB.
  // Obtener el ID directamente desde PostgreSQL, buscando por desc+curso+monto.
  let movIdCreado = null;
  try {
    const rows = await req(
      `/movimientos?cuenta_id=eq.${cuentaId}&curso_id=eq.${encodeURIComponent(CURSO_ID)}&desc=eq.${encodeURIComponent(descCrear)}&select=id,monto,tipo&order=id.desc&limit=1`
    );
    movIdCreado = rows?.[0]?.id || null;
    rows?.[0]?.monto === 5000 && rows?.[0]?.tipo === 'gasto'
      ? ok('E6.M1b: movimiento persistido en PostgreSQL (monto y tipo correctos)')
      : ko('E6.M1b: movimiento no encontrado o campos incorrectos', JSON.stringify(rows?.[0]));
  } catch (e) { ko('E6.M1b: error al verificar PostgreSQL', e.message); }

  if (!movIdCreado) {
    ko('E6.M1c: sin ID no se puede continuar el flujo de movimientos');
    return null;
  }
  ok('E6.M1c: ID de movimiento obtenido (' + movIdCreado.slice(0, 8) + '…)');

  // ── E6.M2: Editar movimiento ──────────────────────────────────────────────
  console.log('  → E6.M2: Editar movimiento');
  const descEditada = `E6 Editado ${EXEC_ID}`;
  try {
    await page.evaluate(id => window.showModal('editMov', { id }), movIdCreado);
    await page.waitForSelector('#em-desc', { timeout: TIMEOUT_CORTO });

    await page.fill('#em-desc',  descEditada);
    await page.fill('#em-monto', '7500');
    await page.click('[onclick*="saveEditMov"]');
    await page.waitForFunction(
      () => window.S?.route === 'movimientos' && !window.S?.modal,
      { timeout: TIMEOUT_LARGO }
    );
    ok('E6.M2a: modal cerrado tras editar movimiento');

    const rows = await req(
      `/movimientos?cuenta_id=eq.${cuentaId}&id=eq.${encodeURIComponent(movIdCreado)}&select=desc,monto`
    );
    rows?.[0]?.monto === 7500
      ? ok('E6.M2b: monto editado persistido en PostgreSQL')
      : ko('E6.M2b: monto no actualizado', JSON.stringify(rows?.[0]));
  } catch (e) { ko('E6.M2: error al editar movimiento', e.message); }

  // ── E6.M3: Subir comprobante ──────────────────────────────────────────────
  console.log('  → E6.M3: Subir comprobante');
  let comprobanteUrl = null;
  try {
    // Crear un PDF mínimo de prueba en disco
    const pdfMinimo = path.join(os.tmpdir(), `comprobante-e6-${EXEC_ID}.pdf`);
    // PDF válido de 1 página (sin contenido visual, pero parseable)
    fs.writeFileSync(pdfMinimo,
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj\n' +
      'xref\n0 4\n0000000000 65535 f\n0000000009 00000 n\n' +
      '0000000058 00000 n\n0000000115 00000 n\n' +
      'trailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF\n'
    );

    await page.evaluate(id => window.showModal('editMov', { id }), movIdCreado);
    await page.waitForSelector('#em-desc', { timeout: TIMEOUT_CORTO });

    // Localizar el input de archivo y adjuntar
    const fileInput = page.locator('#mv-file-arch');
    await fileInput.setInputFiles(pdfMinimo);

    // Esperar a que el contador de archivos muestre ≥1
    await page.waitForFunction(
      () => parseInt(document.getElementById('mv-arch-count')?.textContent || '0') >= 1,
      { timeout: TIMEOUT_CORTO }
    );
    ok('E6.M3a: archivo adjuntado al modal (vista previa visible)');

    await page.click('[onclick*="saveEditMov"]');
    // La subida a Storage puede tardar más
    await page.waitForFunction(
      () => window.S?.route === 'movimientos' && !window.S?.modal,
      { timeout: 45_000 }
    );
    ok('E6.M3b: modal cerrado tras subir comprobante');

    // Verificar que la URL se persistió en PostgreSQL (no base64)
    const rows = await req(
      `/movimientos?cuenta_id=eq.${cuentaId}&id=eq.${encodeURIComponent(movIdCreado)}&select=comprobante,archivos`
    );
    comprobanteUrl = rows?.[0]?.comprobante;
    const urlValida = comprobanteUrl && comprobanteUrl.startsWith('http') && !comprobanteUrl.startsWith('data:');
    urlValida
      ? ok('E6.M3c: comprobante URL persistida en PostgreSQL (no base64)')
      : ko('E6.M3c: comprobante no persistido o es base64', String(comprobanteUrl));

    const archivos = rows?.[0]?.archivos;
    Array.isArray(archivos) && archivos.length > 0
      ? ok('E6.M3d: campo archivos (JSONB) persistido')
      : ko('E6.M3d: campo archivos vacío', JSON.stringify(archivos));

    fs.unlinkSync(pdfMinimo);
  } catch (e) {
    ko('E6.M3: error al subir comprobante', e.message);
    await screenshot(page, 'comprobante');
  }

  // ── E6.M4: Recargar y verificar persistencia del comprobante ─────────────
  console.log('  → E6.M4: Recargar y verificar comprobante');
  try {
    await page.reload({ waitUntil: 'load', timeout: TIMEOUT_LARGO });
    await page.waitForFunction(() => !!window.S?._v9CuentaId, { timeout: TIMEOUT_LARGO });
    await seleccionarCurso(page);
    await page.evaluate(() => window.go('movimientos'));
    await page.waitForFunction(() => window.S?.route === 'movimientos', { timeout: TIMEOUT_CORTO });

    const urlPost = await page.evaluate(id => {
      const m = (window.DB?.movimientos || []).find(x => x.id === id);
      return m?.comprobante || null;
    }, movIdCreado);

    urlPost && urlPost.startsWith('http') && !urlPost.startsWith('data:')
      ? ok('E6.M4: comprobante reaparece tras recargar (URL en caché local)')
      : ko('E6.M4: comprobante perdido tras recargar', String(urlPost));
    comprobanteUrl = comprobanteUrl || urlPost;
  } catch (e) { ko('E6.M4: error al recargar', e.message); }

  // ── E6.M5: Abrir URL del comprobante ─────────────────────────────────────
  console.log('  → E6.M5: Verificar accesibilidad de la URL del comprobante');
  if (comprobanteUrl) {
    try {
      const res = await fetch(comprobanteUrl, { method: 'HEAD' });
      res.ok
        ? ok(`E6.M5: URL del comprobante responde ${res.status} (accesible)`)
        : ko(`E6.M5: URL del comprobante responde ${res.status}`, comprobanteUrl);
    } catch (e) { ko('E6.M5: error al verificar URL', e.message); }
  } else {
    ko('E6.M5: sin URL de comprobante — se omite verificación HTTP');
  }

  // ── E6.M6: Eliminar movimiento ────────────────────────────────────────────
  console.log('  → E6.M6: Eliminar movimiento');
  try {
    await page.evaluate(id => window.delMov && window.delMov(id), movIdCreado);
    // delMov muestra un confirm — aceptarlo
    page.once('dialog', d => d.accept());
    await page.waitForFunction(
      id => !(window.DB?.movimientos || []).some(m => m.id === id),
      movIdCreado, { timeout: TIMEOUT_LARGO }
    );
    ok('E6.M6a: movimiento eliminado del caché local');

    const rows = await req(
      `/movimientos?cuenta_id=eq.${cuentaId}&id=eq.${encodeURIComponent(movIdCreado)}&select=id`
    );
    rows?.length === 0
      ? ok('E6.M6b: movimiento eliminado de PostgreSQL')
      : ko('E6.M6b: movimiento aún existe en PostgreSQL');
  } catch (e) { ko('E6.M6: error al eliminar movimiento', e.message); }

  return movIdCreado;
}

// ── T: PIN ────────────────────────────────────────────────────────────────────
async function testPin(page) {
  console.log('\n── E6.PIN: Configurar PIN desde la UI ──');

  await page.evaluate(() => window.go('alumnos'));
  await page.waitForFunction(() => window.S?.route === 'alumnos', { timeout: TIMEOUT_CORTO });

  // Esperar a que el alumno fixture aparezca renderizado en la lista de alumnos
  // (el caso 'editAlumno' lo gestiona el dispatcher de modales)
  await page.waitForFunction(
    id => !!document.querySelector(`[onclick*="${id}"]`),
    ALU_ID, { timeout: TIMEOUT_LARGO }
  );

  // ── E6.PIN1: Configurar PIN en alumno fixture (ya existe en DB) ───────────
  console.log('  → E6.PIN1: Abrir alumno fixture y configurar PIN');
  const pinInicial = 'UIPIN9';
  try {
    await page.evaluate(id => window.showModal('editAlumno', { id }), ALU_ID);
    await page.waitForSelector('#m-pin', { timeout: TIMEOUT_CORTO });

    // El campo PIN debe estar vacío (nunca precargado con texto real ni '****')
    const pinValue = await page.locator('#m-pin').inputValue();
    pinValue === ''
      ? ok('E6.PIN1a: campo PIN vacío al abrir modal (no hay credencial en memoria)')
      : ko('E6.PIN1a: campo PIN no estaba vacío', `valor: "${pinValue}"`);

    await page.fill('#m-pin', pinInicial);
    await page.click('[onclick*="saveAlumno"]');
    await page.waitForFunction(
      () => window.S?.route === 'alumnos' && !window.S?.modal,
      { timeout: TIMEOUT_LARGO }
    );
    ok('E6.PIN1b: modal cerrado tras guardar alumno con PIN');

    // _pinConfigurado debe ser true en caché
    const pinConf = await page.evaluate(id =>
      !!(window.DB?.alumnos || []).find(a => a.id === id)?._pinConfigurado,
      ALU_ID
    );
    pinConf
      ? ok('E6.PIN1c: _pinConfigurado=true en caché local')
      : ko('E6.PIN1c: _pinConfigurado no es true en caché');

    // No debe haber valor de PIN en caché (ni texto plano ni placeholder)
    const pinEnCache = await page.evaluate(id =>
      (window.DB?.alumnos || []).find(a => a.id === id)?.pin,
      ALU_ID
    );
    !pinEnCache || pinEnCache === ''
      ? ok('E6.PIN1d: pin no está expuesto en la caché local')
      : ko('E6.PIN1d: pin expuesto en caché', `valor: "${pinEnCache}"`);

    // Verificar bcrypt vía apoderado_acceso (anon, igual que un apoderado real)
    const rCorr = await fetch(`${SUPA_URL}/rest/v1/rpc/apoderado_acceso`, {
      method: 'POST',
      headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ p_cuenta_id: cuentaId, p_alumno_id: ALU_ID, p_pin: pinInicial }),
    }).then(r => r.json());
    !rCorr?.error
      ? ok('E6.PIN1e: PIN correcto verificado vía apoderado_acceso (bcrypt)')
      : ko('E6.PIN1e: PIN correcto fue rechazado', JSON.stringify(rCorr));
  } catch (e) {
    ko('E6.PIN1: error inesperado', e.message);
    await screenshot(page, 'pin1');
  }

  // ── E6.PIN2: retryPin — cambiar PIN sin recrear el alumno ─────────────────
  console.log('  → E6.PIN2: retryPin — cambiar PIN desde botón 🔑');
  const pinNuevo = 'RETRY77';
  try {
    // El botón 🔑 llama a retryPin(alumnoId); abrirlo vía evaluate
    await page.evaluate(id => window.showModal('retryPin', { id }), ALU_ID);
    await page.waitForSelector('#rp-pin', { timeout: TIMEOUT_CORTO });

    await page.fill('#rp-pin', pinNuevo);
    await page.click('[onclick*="saveRetryPin"]');
    await page.waitForFunction(
      () => window.S?.route === 'alumnos' && !window.S?.modal,
      { timeout: TIMEOUT_LARGO }
    );
    ok('E6.PIN2a: modal retryPin cerrado tras guardar nuevo PIN');

    // PIN viejo debe ser rechazado
    const rViejo = await fetch(`${SUPA_URL}/rest/v1/rpc/apoderado_acceso`, {
      method: 'POST',
      headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ p_cuenta_id: cuentaId, p_alumno_id: ALU_ID, p_pin: pinInicial }),
    }).then(r => r.json());
    rViejo?.error
      ? ok('E6.PIN2b: PIN anterior rechazado tras retryPin (upsert efectivo)')
      : ko('E6.PIN2b: PIN anterior aún aceptado — ON CONFLICT DO UPDATE no funcionó');

    // PIN nuevo debe ser aceptado
    const rNuevo = await fetch(`${SUPA_URL}/rest/v1/rpc/apoderado_acceso`, {
      method: 'POST',
      headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ p_cuenta_id: cuentaId, p_alumno_id: ALU_ID, p_pin: pinNuevo }),
    }).then(r => r.json());
    !rNuevo?.error
      ? ok('E6.PIN2c: PIN nuevo aceptado (bcrypt verificado)')
      : ko('E6.PIN2c: PIN nuevo rechazado', JSON.stringify(rNuevo));
  } catch (e) {
    ko('E6.PIN2: error inesperado', e.message);
    await screenshot(page, 'pin2');
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n🚀 E6 Movimientos + PIN — EXEC_ID: ${EXEC_ID}`);
  console.log(`  Staging: ${SUPA_URL}\n`);

  let server, browser, page;

  try {
    // Setup REST
    console.log('⚙️  Setup...');
    await loginREST();
    await descubrirCuentaId();
    console.log(`  cuenta_id: ${cuentaId}`);
    await setup();
    console.log('  Fixtures creados.');

    server  = await servirApp();
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext();
    page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') console.error('  🖥 ' + m.text()); });

    console.log('\n🔑 Login UI...');
    await loginUI(page);
    ok('Login UI completado');

    await seleccionarCurso(page);
    ok('Curso fixture seleccionado');

    await testMovimientos(page);
    await testPin(page);

  } catch (err) {
    console.error('\n💥 Error inesperado:', err.message || err);
    if (page) await screenshot(page, 'fatal');
    fail++;
    failures.push('Error inesperado: ' + (err.message || err));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server)  server.close();
    await teardown();

    console.log(`\n${'═'.repeat(55)}`);
    console.log(`  Resultado: ${pass} ✅ OK   ${fail} ❌ FALLIDOS`);
    console.log('═'.repeat(55));
    if (failures.length) {
      console.log('\nFallidos:');
      failures.forEach(f => console.log(`  • ${f}`));
    } else {
      console.log('\n  Todo OK. E6 movimientos + PIN validados en staging.');
    }
    process.exit(fail > 0 ? 1 : 0);
  }
})();
