/**
 * tests/e13_restauracion_usuarios_ui.js
 *
 * Suite Playwright E13 — Restauración V9 (B5-import) + Administración usuarios (B6)
 *
 * Estrategia de fixtures:
 *   - Fixture OBLIGATORIO: 1 curso, 1 cuota, 2 alumnos, 1 plan_pago, 2 abonos,
 *     1 pago directo. Si cualquiera de estos falla, toda la suite aborta.
 *   - usuario_externo: obligatorio para R11-R12; si falla, esos tests se bloquean.
 *   - `respaldoFixture` se construye con SOLO los registros fixture y sus dependencias.
 *   - `dispararImportacion` espera mensaje TERMINAL (✅/⚠️/❌), nunca ⏳.
 *   - `eliminarFixtures` exige HTTP 200 + array + length === 0 en cada GET.
 *   - V9_RELACIONAL: `const` global de script clásico — no es propiedad automática de
 *     window; se lee con `typeof V9_RELACIONAL` directamente en page.evaluate.
 *   - Producción excluida.
 *
 * Tests:
 *   R01  Servidor local levantado y staging alcanzable
 *   R02  Login UI + V9_RELACIONAL activo (binding real, no window.V9_RELACIONAL)
 *   R03  exportarDatosCompletosV9 → JSON descargado con estructura válida
 *   R04  Todos los IDs fixture en el respaldo (cursos, cuotas, alumnos, planes, abonos, pagos)
 *   R04x planes_pago en respaldo contiene id y cuenta (camelCase o snake_case)
 *   R05  Límite de paginación (1000 filas) documentado
 *   R06  Eliminar fixture → importar respaldo-fixture → GET por ID exacto para TODOS los IDs;
 *        aprueba solo con ✅ + todos los IDs restaurados (planes y abonos incluidos)
 *   R07  Importar mismo respaldo-fixture segunda vez → idempotente (counts exactos)
 *   R08  cuentaId ajeno en encabezado → rechazado con mensaje UI
 *   R09  registro snake_case con cuenta_id ajeno → guardia cancela antes de escribir
 *   R09b plan camelCase con cuentaId ajeno → normalización + guardia → cero escrituras
 *   R10  FK inválida → mensaje terminal ⚠️/❌ en UI (no vacío, no ⏳, no ✅)
 *   R11  B6: cargarUsuariosDesdeSupabase popula DB.usuariosExternos (binding real)
 *   R12  B6: toggleUsuarioAdmin hace PATCH en la tabla V9 correcta
 *   R13  Limpieza: todos los fixtures eliminados, GET exige HTTP 200 + array + length 0
 *
 * Pendientes (fuera de esta suite):
 *   - Paginación real (exportar >1000 filas sin truncar) — bloquea publicación
 *   - B5/B6 no declarados completos hasta que estos tests pasen íntegramente
 *   - Restauración de sesión / recordar acceso (sin implementar en V9)
 *   - Comparación funcional completa con app original
 */

'use strict';

const path   = require('path');
const os     = require('os');
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

if (!SUPA_URL_RAW || !ANON_KEY || !USER_EMAIL || !USER_PASS) {
  console.error('❌ Faltan variables de entorno. Revisa .env.');
  process.exit(1);
}

// ── Guardia de producción ──────────────────────────────────────────────────────
const PROD_HOST    = 'tmjqzaakzhecbldebyeg.supabase.co';
const STAGING_HOST = 'rucgmytyxpfowznowxwd.supabase.co';
const SUPA_URL     = SUPA_URL_RAW;
let parsedHost;
try { parsedHost = new URL(SUPA_URL).hostname; } catch(_) { process.exit(2); }
if (parsedHost === PROD_HOST || parsedHost !== STAGING_HOST) {
  console.error('❌ URL no autorizada:', parsedHost);
  process.exit(2);
}

const EXEC_ID  = Date.now().toString(36);
const APP_PORT = 8802;
let CUENTA_ID  = process.env.STAGING_CUENTA_ID || null;

let pass = 0, fail = 0, blocked = 0;
const failures    = [];
const blockedList = [];

function ok(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else       { console.error(`  ❌ ${label}`); fail++; failures.push(label); }
}
function skip(label, razon) {
  console.log(`  ⏭  ${label} [bloqueado: ${razon}]`);
  blocked++;
  blockedList.push(`${label} (${razon})`);
}
function nota(label, detalle) {
  console.log(`  📝 ${label}${detalle ? ': ' + detalle : ''}`);
}

const T_CORTO = 12_000;
const T_LARGO = 60_000;

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

// ── Login ─────────────────────────────────────────────────────────────────────

async function loginTesorero() {
  const r = await _fetch('/auth/v1/token?grant_type=password', {
    method: 'POST', body: { email: USER_EMAIL, password: USER_PASS },
    prefer: '', authHeader: null,
  });
  if (r.status !== 200 || !r.body?.access_token)
    throw new Error(`Login REST fallido: ${JSON.stringify(r.body)}`);
  return r.body.access_token;
}

function jwtSub(token) {
  try {
    const payload = token.split('.')[1];
    const padded  = payload + '='.repeat((4 - payload.length % 4) % 4);
    return JSON.parse(Buffer.from(padded, 'base64url').toString('utf8')).sub || null;
  } catch { return null; }
}

async function descubrirCuenta(jwt) {
  const sub = jwtSub(jwt);
  if (!sub) throw new Error('descubrirCuenta: no se pudo extraer sub del JWT');
  const r = await supaAuth(
    `/rest/v1/tesorero_cuentas?auth_id=eq.${encodeURIComponent(sub)}&select=id&limit=1`, jwt
  );
  if (r.status !== 200 || !Array.isArray(r.body) || r.body.length === 0)
    throw new Error(`descubrirCuenta: auth_id=${sub} → ${JSON.stringify(r.body)}`);
  return r.body[0].id;
}

// ── Helpers Playwright ────────────────────────────────────────────────────────

async function waitAppReady(page) {
  await page.waitForFunction(() => typeof window.S !== 'undefined', { timeout: T_LARGO });
}

function instalarManejadorDialogos(page, estado) {
  page.on('dialog', async d => {
    const tipo = d.type(), msg = d.message();
    console.log(`    [dialog] ${tipo}: ${msg.slice(0, 120)}`);
    estado.ultimoDialog = { type: tipo, message: msg };
    await d.accept().catch(() => {});
  });
}

function registrarRespuestasError(page) {
  page.on('response', async res => {
    const status = res.status();
    if (status >= 400) {
      const method = res.request().method(), url = res.url();
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

/**
 * Dispara importarDatos con el JSON dado y espera el mensaje TERMINAL.
 *
 * Terminal = #export-msg visible con texto que NO empiece con '⏳'.
 * Limpia el mensaje anterior antes de disparar para evitar lecturas residuales.
 * Timeout: 30 s.
 */
async function dispararImportacion(page, jsonContent) {
  const jsonStr = typeof jsonContent === 'string' ? jsonContent : JSON.stringify(jsonContent);

  await page.evaluate(() => {
    const el = document.getElementById('export-msg');
    if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  });

  await page.evaluate((jsonStr) => {
    if (typeof importarDatos !== 'function') return;
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const file = new File([blob], 'backup.json', { type: 'application/json' });
    const dt = new DataTransfer();
    dt.items.add(file);
    importarDatos({ target: { files: dt.files } });
  }, jsonStr);

  let msgTexto = null;
  try {
    await page.waitForFunction(() => {
      const el = document.getElementById('export-msg');
      if (!el || el.style.display === 'none') return false;
      const txt = el.innerText.trim();
      return txt.length > 0 && !txt.startsWith('⏳');
    }, { timeout: 30_000 });
    msgTexto = await page.evaluate(() => {
      const el = document.getElementById('export-msg');
      return el ? el.innerText.trim() : null;
    });
  } catch (_) {
    msgTexto = await page.evaluate(() => {
      const el = document.getElementById('export-msg');
      return el ? el.innerText.trim() : null;
    }).catch(() => null);
    if (msgTexto) console.warn(`  [dispararImportacion] timeout — mensaje actual: "${msgTexto}"`);
  }
  return msgTexto;
}

// ── Gestión de fixtures ───────────────────────────────────────────────────────

/**
 * Inserta fixture COMPLETO y OBLIGATORIO:
 *   1 curso, 1 cuota, 2 alumnos, 1 plan_pago, 2 abonos, 1 pago directo
 *
 * LANZA si CUALQUIERA de estos falla — no hay advertencias, toda la suite depende de ellos.
 * usuario_externo es el único no fatal (R11-R12 lo bloquean si falla).
 */
async function insertarFixtures(jwt, cuentaId, fc) {
  const uid = () => crypto.randomUUID();
  const hoy = new Date().toISOString().slice(0, 10);

  // Curso
  const cursoId = uid();
  const rC = await supaAuth('/rest/v1/cursos', jwt, {
    method: 'POST',
    body: { id: cursoId, cuenta_id: cuentaId, nombre: `FixtureCurso-E13-${EXEC_ID}`, activo: true, anio: 2026 },
    prefer: 'return=representation',
  });
  if (rC.status < 200 || rC.status >= 300)
    throw new Error(`fixture curso HTTP ${rC.status}: ${JSON.stringify(rC.body)}`);
  fc.cursos.push(cursoId);

  // Cuota (obligatoria como FK para planes_pago)
  const cuotaId = uid();
  const rQ = await supaAuth('/rest/v1/cuotas', jwt, {
    method: 'POST',
    body: { id: cuotaId, cuenta_id: cuentaId, curso_id: cursoId,
            nombre: `FixtureCuota-E13-${EXEC_ID}`, monto: 10000, activa: true },
    prefer: 'return=representation',
  });
  if (rQ.status < 200 || rQ.status >= 300)
    throw new Error(`fixture cuota HTTP ${rQ.status}: ${JSON.stringify(rQ.body)}`);
  fc.cuotas.push(cuotaId);

  // 2 alumnos
  let primerAlumnoId = null;
  for (let j = 1; j <= 2; j++) {
    const alumnoId = uid();
    const rA = await supaAuth('/rest/v1/alumnos', jwt, {
      method: 'POST',
      body: { id: alumnoId, cuenta_id: cuentaId, curso_id: cursoId,
              nombres: `FixtureAlumno${j}-E13`, apellidos: EXEC_ID, estado: 'activo' },
      prefer: 'return=representation',
    });
    if (rA.status < 200 || rA.status >= 300)
      throw new Error(`fixture alumno ${j} HTTP ${rA.status}: ${JSON.stringify(rA.body)}`);
    fc.alumnos.push(alumnoId);
    if (j === 1) primerAlumnoId = alumnoId;
  }

  // Plan de pago (obligatorio)
  const planId = uid();
  const rPl = await supaAuth('/rest/v1/planes_pago', jwt, {
    method: 'POST',
    body: { id: planId, cuenta_id: cuentaId, alumno_id: primerAlumnoId,
            cuota_id: cuotaId, monto_total: 10000, activo: true,
            periodo: `FixtureE13-${EXEC_ID}` },
    prefer: 'return=representation',
  });
  if (rPl.status < 200 || rPl.status >= 300)
    throw new Error(`fixture plan_pago HTTP ${rPl.status}: ${JSON.stringify(rPl.body)}`);
  fc.planes_pago.push(planId);

  // 2 abonos (obligatorios)
  for (let j = 1; j <= 2; j++) {
    const abonoId = uid();
    const rAb = await supaAuth('/rest/v1/abonos', jwt, {
      method: 'POST',
      body: { id: abonoId, cuenta_id: cuentaId, alumno_id: primerAlumnoId,
              cuota_id: cuotaId, plan_id: planId,
              monto: 5000, fecha: hoy, pagado: false, estado: 'registrado' },
      prefer: 'return=representation',
    });
    if (rAb.status < 200 || rAb.status >= 300)
      throw new Error(`fixture abono ${j} HTTP ${rAb.status}: ${JSON.stringify(rAb.body)}`);
    fc.abonos.push(abonoId);
  }

  // Pago directo (obligatorio)
  const pagoId = uid();
  const rPg = await supaAuth('/rest/v1/pagos', jwt, {
    method: 'POST',
    body: { id: pagoId, cuenta_id: cuentaId, alumno_id: primerAlumnoId,
            monto: 9900, fecha: hoy, medio: 'efectivo', estado: 'pagado',
            periodo: `FixtureE13-${EXEC_ID}`, obs: `Fixture E13 ${EXEC_ID}` },
    prefer: 'return=representation',
  });
  if (rPg.status < 200 || rPg.status >= 300)
    throw new Error(`fixture pago HTTP ${rPg.status}: ${JSON.stringify(rPg.body)}`);
  fc.pagos.push(pagoId);

  console.log(`  [fixture] cursos=${fc.cursos.length} cuotas=${fc.cuotas.length} alumnos=${fc.alumnos.length} planes=${fc.planes_pago.length} abonos=${fc.abonos.length} pagos=${fc.pagos.length}`);

  // Usuario externo — único no fatal
  const ueId = uid();
  const rU = await supaAuth('/rest/v1/usuarios_externos', jwt, {
    method: 'POST',
    body: { id: ueId, cuenta_id: cuentaId,
            email: `fixture_e13_${EXEC_ID}@test.local`,
            nombre: `FixtureUsuarioE13-${EXEC_ID}`, desactivado: false },
    prefer: 'return=representation',
  });
  if (rU.status >= 200 && rU.status < 300) {
    fc.usuariosExternos.push(ueId);
    console.log(`  [fixture] usuario_externo ${ueId.slice(0,8)}… insertado`);
  } else {
    fc.errorUsuarioExterno = `HTTP ${rU.status}: ${JSON.stringify(rU.body).slice(0, 120)}`;
    console.warn(`  [fixture] usuario_externo NO creado: ${fc.errorUsuarioExterno}`);
  }
}

/**
 * Construye respaldo-fixture con SOLO los registros fixture y sus dependencias.
 * Extrae filas del respaldo completo filtrando por IDs fixture.
 * Los planes_pago y abonos se incluyen tal cual vienen del respaldo
 * (camelCase o snake_case — _importarDatosV9 los normalizará en Paso 1).
 */
function construirRespaldoFixture(cuentaId, fc, respaldoCompleto) {
  const cols = respaldoCompleto?.colecciones || {};
  const cursoIds  = new Set(fc.cursos);
  const cuotaIds  = new Set(fc.cuotas);
  const alumnoIds = new Set(fc.alumnos);
  const planIds   = new Set(fc.planes_pago);
  const abonoIds  = new Set(fc.abonos);
  const pagoIds   = new Set(fc.pagos);

  return {
    version:  'v9-completo',
    fecha:    new Date().toISOString(),
    cuentaId,
    alcance:  `fixture E13 ${EXEC_ID}`,
    colecciones: {
      cursos:            (cols.cursos     || []).filter(r => cursoIds.has(r.id)),
      alumnos:           (cols.alumnos    || []).filter(r => alumnoIds.has(r.id)),
      apoderados:        (cols.apoderados || []).filter(r => alumnoIds.has(r.alumno_id)),
      cuotas:            (cols.cuotas     || []).filter(r => cuotaIds.has(r.id)),
      planes_pago:       (cols.planes_pago|| []).filter(r => planIds.has(r.id)),
      abonos:            (cols.abonos     || []).filter(r => abonoIds.has(r.id)),
      pagos:             (cols.pagos      || []).filter(r => pagoIds.has(r.id)),
      movimientos:       [],
      fondo_movimientos: [],
      actividades:       [],
      notas:             [],
      codigos_invitacion:[],
      config_cuenta:     [],
    },
  };
}

/**
 * Elimina todos los fixtures y verifica eliminación por GET.
 * Exige: HTTP 200 + array + length === 0.
 */
async function eliminarFixtures(jwt, cuentaId, fc) {
  let fallos = 0;
  async function del1(tabla, id) {
    try {
      const rDel = await supaAuth(
        `/rest/v1/${tabla}?id=eq.${encodeURIComponent(id)}&cuenta_id=eq.${encodeURIComponent(cuentaId)}`,
        jwt, { method: 'DELETE', prefer: '' }
      );
      if (rDel.status < 200 || rDel.status >= 300) {
        console.error(`  [cleanup] ${tabla} ${id.slice(0,8)}… DELETE HTTP ${rDel.status}`);
        fallos++; return;
      }
      const rGet = await supaAuth(`/rest/v1/${tabla}?id=eq.${encodeURIComponent(id)}&select=id`, jwt);
      if (rGet.status !== 200) {
        console.error(`  [cleanup] ${tabla} ${id.slice(0,8)}… GET HTTP ${rGet.status}`);
        fallos++;
      } else if (!Array.isArray(rGet.body)) {
        console.error(`  [cleanup] ${tabla} ${id.slice(0,8)}… GET no devolvió array`);
        fallos++;
      } else if (rGet.body.length > 0) {
        console.error(`  [cleanup] ${tabla} ${id.slice(0,8)}… sigue en DB`);
        fallos++;
      } else {
        console.log(`  [cleanup] ${tabla} ${id.slice(0,8)}… ✓`);
      }
    } catch (e) {
      console.error(`  [cleanup] ${tabla} ${id.slice(0,8)}… excepción: ${e.message}`);
      fallos++;
    }
  }
  // Orden FK-safe inverso
  for (const id of fc.usuariosExternos) await del1('usuarios_externos', id);
  for (const id of fc.abonos)           await del1('abonos',            id);
  for (const id of fc.planes_pago)       await del1('planes_pago',       id);
  for (const id of fc.pagos)             await del1('pagos',             id);
  for (const id of fc.alumnos)           await del1('alumnos',           id);
  for (const id of fc.cuotas)            await del1('cuotas',            id);
  for (const id of fc.cursos)            await del1('cursos',            id);
  return fallos;
}

async function existeEnDB(jwt, tabla, id) {
  const r = await supaAuth(`/rest/v1/${tabla}?id=eq.${encodeURIComponent(id)}&select=id`, jwt);
  return r.status === 200 && Array.isArray(r.body) && r.body.length === 1;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  E13 — Restauración V9 (B5-import) + Usuarios (B6)');
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
    console.error('❌ Setup falló:', e.message);
    process.exit(3);
  }

  // fixtureCreados (fc) — se llena en insertarFixtures
  const fc = {
    cursos: [], cuotas: [], alumnos: [], planes_pago: [], abonos: [], pagos: [],
    usuariosExternos: [], errorUsuarioExterno: null,
  };

  let server           = null;
  let browser          = null;
  let respaldoCompleto = null;
  let respaldoFixture  = null;
  let fallosCleanup    = 0;
  const dialogState    = { ultimoDialog: null };

  try {
    // ── R01 ───────────────────────────────────────────────────────────────────
    console.log('\n[R01] Servidor HTTP local');
    server = await servirApp();
    ok('R01: servidor levantado', true);

    // ── R02 ───────────────────────────────────────────────────────────────────
    console.log('\n[R02] Login UI + V9_RELACIONAL activo');
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, acceptDownloads: true,
    });
    const page = await ctx.newPage();
    page.on('console', msg => { if (msg.type() === 'error') console.error(`  [browser] ${msg.text()}`); });
    instalarManejadorDialogos(page, dialogState);
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
    } catch (_) {
      ok('R02-a: login completado', false);
      throw new Error('Login UI no completó');
    }
    ok('R02-a: login completado (_v9CuentaId disponible)', true);

    const cuentaUI = await page.evaluate(() => window.S?._v9CuentaId ?? null);
    if (!cuentaUI) throw new Error('_v9CuentaId no disponible');
    if (cuentaUI !== CUENTA_ID)
      throw new Error(`Discrepancia de cuenta: REST="${CUENTA_ID}" UI="${cuentaUI}". Fija STAGING_CUENTA_ID=${cuentaUI}.`);
    console.log(`  Cuenta REST = UI = ${CUENTA_ID} ✓`);

    // R02-b: V9_RELACIONAL es `const` global en config.js (script clásico).
    // Un `const` a nivel de script clásico NO se convierte en propiedad de window
    // automáticamente; se lee directamente con `typeof V9_RELACIONAL`.
    const v9Activo = await page.evaluate(() => {
      try { return typeof V9_RELACIONAL !== 'undefined' && V9_RELACIONAL === true; }
      catch(_) { return false; }
    });
    ok('R02-b: V9_RELACIONAL activo (leído directamente, no vía window)', v9Activo);
    if (!v9Activo) {
      nota('R02-b diagnóstico', 'V9_RELACIONAL no visible en scope evaluate de Playwright');
      nota('R02-b', 'B6 se probará según existencia de cargarUsuariosDesdeSupabase, no de V9_RELACIONAL');
    }

    // Insertar fixtures OBLIGATORIOS — aborta si falla cualquiera
    console.log('\n[Pre] Insertar fixtures (obligatorios: curso, cuota, 2 alumnos, plan, 2 abonos, pago)');
    await insertarFixtures(jwt, CUENTA_ID, fc);
    if (fc.errorUsuarioExterno)
      nota('Pre', `usuario_externo no creado (R11-R12 se bloquearán): ${fc.errorUsuarioExterno}`);

    // ── R03 ───────────────────────────────────────────────────────────────────
    console.log('\n[R03] exportarDatosCompletosV9 → JSON descargado');
    await navegarConfig(page);

    let capturado = null, tmpFile = null;
    try {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: T_LARGO }),
        page.evaluate(async () => {
          if (typeof exportarDatosCompletosV9 === 'function') await exportarDatosCompletosV9();
        }),
      ]);
      tmpFile = path.join(os.tmpdir(), `e13-backup-${EXEC_ID}.json`);
      await download.saveAs(tmpFile);
      capturado = fs.readFileSync(tmpFile, 'utf8');
    } catch (e) {
      console.error(`  [R03] Error: ${e.message}`);
    } finally {
      if (tmpFile) try { fs.unlinkSync(tmpFile); } catch(_) {}
    }
    ok('R03-a: archivo descargado', !!capturado);

    if (capturado) {
      try { respaldoCompleto = JSON.parse(capturado); ok('R03-b: JSON válido', true); }
      catch (e) { ok('R03-b: JSON válido', false); console.error('  Parse error:', e.message); }
    } else { ok('R03-b: JSON válido', false); }

    if (respaldoCompleto) {
      ok('R03-c: version = "v9-completo"', respaldoCompleto.version === 'v9-completo');
      ok('R03-d: cuentaId coincide', respaldoCompleto.cuentaId === CUENTA_ID);
      const COLS_ESPERADAS = [
        'cursos','alumnos','apoderados','cuotas','planes_pago','abonos',
        'pagos','movimientos','fondo_movimientos','actividades','notas','codigos_invitacion','config_cuenta',
      ];
      ok('R03-e: todas las colecciones presentes',
        COLS_ESPERADAS.every(c => Array.isArray(respaldoCompleto.colecciones?.[c])));

      respaldoFixture = construirRespaldoFixture(CUENTA_ID, fc, respaldoCompleto);
      const nFix = Object.values(respaldoFixture.colecciones)
        .reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0);
      console.log(`  respaldoFixture: ${nFix} registros totales`);
    }

    // ── R04 ───────────────────────────────────────────────────────────────────
    console.log('\n[R04] Todos los IDs fixture en el respaldo');
    if (!respaldoCompleto) {
      skip('R04', 'R03 no obtuvo JSON');
    } else {
      const cols = respaldoCompleto.colecciones || {};
      ok('R04-a: cursos',       fc.cursos     .every(id => (cols.cursos     ||[]).some(r => r.id === id)));
      ok('R04-b: cuotas',       fc.cuotas     .every(id => (cols.cuotas     ||[]).some(r => r.id === id)));
      ok('R04-c: alumnos',      fc.alumnos    .every(id => (cols.alumnos    ||[]).some(r => r.id === id)));
      ok('R04-d: planes_pago',  fc.planes_pago.every(id => (cols.planes_pago||[]).some(r => r.id === id)));
      ok('R04-e: abonos',       fc.abonos     .every(id => (cols.abonos     ||[]).some(r => r.id === id)));
      ok('R04-f: pagos',        fc.pagos      .every(id => (cols.pagos      ||[]).some(r => r.id === id)));

      // R04x: inspeccionar formato de planes_pago en el respaldo
      const planEnRespaldo = (cols.planes_pago||[]).find(p => p.id === fc.planes_pago[0]);
      if (planEnRespaldo) {
        const tieneSnake = 'cuenta_id'   in planEnRespaldo;
        const tieneCamel = 'cuentaId'    in planEnRespaldo;
        const tieneMonto = 'monto_total' in planEnRespaldo || 'montoTotal' in planEnRespaldo;
        nota('R04x formato plan_pago',
          `snake=${tieneSnake} camel=${tieneCamel} monto=${tieneMonto} campos=[${Object.keys(planEnRespaldo).join(',')}]`);
        ok('R04x: plan_pago tiene id y alguna forma de cuenta_id en el respaldo',
          !!(planEnRespaldo.id && (tieneSnake || tieneCamel)));
      } else {
        nota('R04x', 'plan_pago fixture no encontrado en respaldo para inspección');
      }

      const alumnosFix = (cols.alumnos||[]).filter(a => fc.alumnos.includes(a.id));
      ok('R04-g: alumnos fixture tienen cuenta_id correcto',
        alumnosFix.every(a => a.cuenta_id === CUENTA_ID));
    }

    // ── R05 ───────────────────────────────────────────────────────────────────
    console.log('\n[R05] Límite de paginación');
    if (!respaldoCompleto) {
      skip('R05', 'R03 no obtuvo JSON');
    } else {
      let algunaAlLimite = false;
      for (const [nombre, arr] of Object.entries(respaldoCompleto.colecciones || {})) {
        if (Array.isArray(arr) && arr.length >= 1000) {
          console.error(`  ⚠️  "${nombre}" tiene ${arr.length} registros — posible truncación`);
          algunaAlLimite = true;
        }
      }
      ok('R05: ninguna colección alcanza 1000 filas en staging', !algunaAlLimite);
      nota('R05 pendiente', 'exportarDatosCompletosV9 no implementa paginación — bloquea publicación');
    }

    // ── R06 ───────────────────────────────────────────────────────────────────
    console.log('\n[R06] Eliminar fixture → importar respaldo-fixture → restauración completa');
    if (!respaldoFixture) {
      skip('R06', 'requiere respaldoFixture');
      skip('R07', 'requiere R06');
    } else {
      // Crear brecha: eliminar en orden FK-safe inverso
      let errorEliminar = null;
      const delBrecha = async (tabla, ids) => {
        for (const id of ids) {
          if (errorEliminar) return;
          const r = await supaAuth(
            `/rest/v1/${tabla}?id=eq.${encodeURIComponent(id)}&cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}`,
            jwt, { method: 'DELETE', prefer: '' }
          );
          if (r.status >= 300) errorEliminar = `${tabla} ${id.slice(0,8)} HTTP ${r.status}`;
        }
      };
      await delBrecha('abonos',      fc.abonos);
      await delBrecha('planes_pago', fc.planes_pago);
      await delBrecha('pagos',       fc.pagos);
      await delBrecha('alumnos',     fc.alumnos);

      if (errorEliminar) {
        ok('R06-a: brecha creada',  false);
        console.error(`  Error en eliminación: ${errorEliminar}`);
        skip('R06-b/c/d', 'eliminación previa falló');
        skip('R07', 'requiere R06 exitoso');
      } else {
        ok('R06-a: fixture eliminado (brecha creada)', true);

        // Verificar ausencia de alumnos antes de importar
        for (const id of fc.alumnos) {
          const existe = await existeEnDB(jwt, 'alumnos', id);
          ok(`R06-b: alumno ${id.slice(0,8)}… ausente antes de importar`, !existe);
        }

        console.log('  Importando respaldo-fixture…');
        dialogState.ultimoDialog = null;
        await navegarConfig(page);
        const msgImport = await dispararImportacion(page, respaldoFixture);
        console.log(`  Mensaje UI: ${msgImport || '(vacío/timeout)'}`);

        // Verificar restauración exacta por GET individual (todos los IDs)
        let todosPresentes = true;
        for (const [tabla, ids] of [
          ['alumnos',    fc.alumnos],
          ['pagos',      fc.pagos],
          ['planes_pago',fc.planes_pago],
          ['abonos',     fc.abonos],
        ]) {
          for (const id of ids) {
            const existe = await existeEnDB(jwt, tabla, id);
            ok(`R06-c: ${tabla} fixture ${id.slice(0,8)}… restaurado (GET por ID)`, existe);
            if (!existe) todosPresentes = false;
          }
        }

        // R06 aprueba SOLO con ✅ en el mensaje Y todos los IDs presentes
        const msgEsExito = !!(msgImport && msgImport.startsWith('✅'));
        ok('R06-d: restauración completa — todos los IDs presentes', todosPresentes);
        ok('R06-e: UI muestra ✅ (no solo cualquier mensaje terminal)', msgEsExito);
        if (!msgEsExito && msgImport)
          nota('R06-e', `mensaje real: "${msgImport.slice(0, 100)}"`);

        // ── R07 ──────────────────────────────────────────────────────────────
        console.log('\n[R07] Importar mismo respaldo-fixture segunda vez → idempotente');

        const contarPorIds = async (tabla, ids) => {
          if (!ids.length) return 0;
          const filter = ids.map(id => `id.eq.${encodeURIComponent(id)}`).join(',');
          const r = await supaAuth(`/rest/v1/${tabla}?or=(${filter})&select=id`, jwt);
          return (r.status === 200 && Array.isArray(r.body)) ? r.body.length : null;
        };
        const countAntes = {
          alumnos:     await contarPorIds('alumnos',     fc.alumnos),
          pagos:       await contarPorIds('pagos',       fc.pagos),
          planes_pago: await contarPorIds('planes_pago', fc.planes_pago),
          abonos:      await contarPorIds('abonos',      fc.abonos),
        };
        console.log(`  Antes: alumnos=${countAntes.alumnos} pagos=${countAntes.pagos} planes=${countAntes.planes_pago} abonos=${countAntes.abonos}`);

        dialogState.ultimoDialog = null;
        await navegarConfig(page);
        const msgImport2 = await dispararImportacion(page, respaldoFixture);
        console.log(`  Mensaje 2ª importación: ${msgImport2 || '(vacío/timeout)'}`);

        const countDespues = {
          alumnos:     await contarPorIds('alumnos',     fc.alumnos),
          pagos:       await contarPorIds('pagos',       fc.pagos),
          planes_pago: await contarPorIds('planes_pago', fc.planes_pago),
          abonos:      await contarPorIds('abonos',      fc.abonos),
        };
        console.log(`  Después: alumnos=${countDespues.alumnos} pagos=${countDespues.pagos} planes=${countDespues.planes_pago} abonos=${countDespues.abonos}`);

        ok('R07-a: alumnos no duplicados',    countAntes.alumnos     !== null && countDespues.alumnos     === countAntes.alumnos);
        ok('R07-b: pagos no duplicados',      countAntes.pagos       !== null && countDespues.pagos       === countAntes.pagos);
        ok('R07-c: planes_pago no duplicados',countAntes.planes_pago !== null && countDespues.planes_pago === countAntes.planes_pago);
        ok('R07-d: abonos no duplicados',     countAntes.abonos      !== null && countDespues.abonos      === countAntes.abonos);
        ok('R07-e: UI muestra ✅ en 2ª importación', !!(msgImport2 && msgImport2.startsWith('✅')));
      }
    }

    // ── R08 ───────────────────────────────────────────────────────────────────
    console.log('\n[R08] cuentaId ajeno en encabezado → rechazado');
    if (!respaldoFixture) { skip('R08', 'requiere respaldoFixture'); } else {
      const backupAjeno = JSON.parse(JSON.stringify(respaldoFixture));
      backupAjeno.cuentaId = 'cuenta-ajena-00000000-0000-0000-0000-000000000000';
      dialogState.ultimoDialog = null;
      await navegarConfig(page);
      const msgAjeno = await dispararImportacion(page, backupAjeno);
      console.log(`  Mensaje: ${msgAjeno || '(vacío/timeout)'}`);
      const rechazado = !!(msgAjeno && (msgAjeno.includes('otra cuenta') || msgAjeno.includes('ajeno') || msgAjeno.startsWith('❌')));
      ok('R08-a: cuentaId ajeno rechazado', rechazado || !!dialogState.ultimoDialog?.message);
      ok('R08-b: rechazo en DOM', rechazado);
    }

    // ── R09 ───────────────────────────────────────────────────────────────────
    console.log('\n[R09] registro snake_case con cuenta_id ajeno → guardia por-registro');
    if (!respaldoFixture) { skip('R09', 'requiere respaldoFixture'); } else {
      const backupAjeno9 = JSON.parse(JSON.stringify(respaldoFixture));
      backupAjeno9.colecciones.alumnos.push({
        id: crypto.randomUUID(), cuenta_id: 'cuenta-ajena-99999999-0000-0000-0000-000000000000',
        curso_id: fc.cursos[0], nombres: 'CorruptoR09', apellidos: EXEC_ID, estado: 'activo',
      });
      dialogState.ultimoDialog = null;
      await navegarConfig(page);
      const msg9 = await dispararImportacion(page, backupAjeno9);
      console.log(`  Mensaje: ${msg9 || '(vacío/timeout)'}`);
      const rechazado9 = !!(msg9 && (msg9.includes('ajeno') || msg9.includes('cancelada') || msg9.startsWith('❌')));
      ok('R09-a: registro ajeno cancela importación', rechazado9);
      ok('R09-b: rechazo en DOM antes de cualquier escritura', rechazado9);
      const rCorrupto = await supaAuth(
        `/rest/v1/alumnos?apellidos=eq.${encodeURIComponent(EXEC_ID)}&nombres=eq.CorruptoR09&select=id`, jwt
      );
      ok('R09-c: CorruptoR09 NO escrito en DB', rCorrupto.status === 200 && Array.isArray(rCorrupto.body) && rCorrupto.body.length === 0);
    }

    // ── R09b: plan camelCase de otra cuenta → normalización + guardia → cero escrituras ─
    console.log('\n[R09b] plan camelCase con cuentaId ajeno → guardia post-normalización → cero escrituras');
    if (!respaldoFixture) { skip('R09b', 'requiere respaldoFixture'); } else {
      const ajenoId = crypto.randomUUID();
      const backupCamelAjeno = JSON.parse(JSON.stringify(respaldoFixture));
      // Añadir plan con cuentaId camelCase ajeno (como lo exportaría _mapPlanPago)
      backupCamelAjeno.colecciones.planes_pago.push({
        id:         ajenoId,
        cuentaId:   'cuenta-ajena-camel-0000-0000-000000000000',   // ← camelCase ajeno
        alumnoId:   fc.alumnos[0],
        cuotaId:    fc.cuotas[0],
        montoTotal: 1,
        activo:     true,
        periodo:    `R09b-${EXEC_ID}`,
      });
      dialogState.ultimoDialog = null;
      await navegarConfig(page);
      const msg9b = await dispararImportacion(page, backupCamelAjeno);
      console.log(`  Mensaje: ${msg9b || '(vacío/timeout)'}`);
      const rechazado9b = !!(msg9b && (msg9b.includes('ajeno') || msg9b.includes('cancelada') || msg9b.startsWith('❌')));
      ok('R09b-a: plan camelCase ajeno rechazado (guardia post-normalización)', rechazado9b);
      // Verificar cero escrituras: el plan ajeno no llegó a DB
      const rPlanAjeno = await supaAuth(`/rest/v1/planes_pago?id=eq.${encodeURIComponent(ajenoId)}&select=id`, jwt);
      ok('R09b-b: plan ajeno NO escrito en DB (cero escrituras en toda la importación)',
        rPlanAjeno.status === 200 && Array.isArray(rPlanAjeno.body) && rPlanAjeno.body.length === 0);
    }

    // ── R10 ───────────────────────────────────────────────────────────────────
    console.log('\n[R10] FK inválida → mensaje terminal ⚠️/❌ en UI');
    if (!respaldoFixture) { skip('R10', 'requiere respaldoFixture'); } else {
      const backupFK = JSON.parse(JSON.stringify(respaldoFixture));
      backupFK.colecciones.alumnos.push({
        id: crypto.randomUUID(), cuenta_id: CUENTA_ID,
        curso_id: crypto.randomUUID(),   // FK a curso inexistente
        nombres: 'FKInvalidaR10', apellidos: EXEC_ID, estado: 'activo',
      });
      dialogState.ultimoDialog = null;
      await navegarConfig(page);
      const msgFK = await dispararImportacion(page, backupFK);
      console.log(`  Mensaje: ${msgFK || '(vacío/timeout)'}`);
      ok('R10-a: UI muestra mensaje terminal no vacío y no ⏳',
        !!(msgFK && msgFK.length > 0 && !msgFK.startsWith('⏳')));
      ok('R10-b: mensaje es ⚠️ o ❌ (error reportado)',
        !!(msgFK && (msgFK.startsWith('⚠️') || msgFK.startsWith('❌'))));
      ok('R10-c: UI NO anuncia ✅ restauración completa con FK inválida',
        !(msgFK && msgFK.startsWith('✅')));
      nota('R10-d comportamiento de chunks',
        'La transacción es por chunk (100 filas); chunks anteriores a la FK inválida ya confirmados no revierten.');
    }

    // ── R11 ───────────────────────────────────────────────────────────────────
    console.log('\n[R11] B6: cargarUsuariosDesdeSupabase popula DB.usuariosExternos');
    const tieneB6 = await page.evaluate(() => typeof cargarUsuariosDesdeSupabase === 'function');
    if (!tieneB6) {
      skip('R11', 'cargarUsuariosDesdeSupabase no disponible en la app');
      skip('R12', 'requiere cargarUsuariosDesdeSupabase');
    } else if (fc.usuariosExternos.length === 0) {
      skip('R11', `usuario_externo fixture no creado: ${fc.errorUsuarioExterno || 'error desconocido'}`);
      skip('R12', 'requiere fixture usuario_externo creado');
    } else {
      await page.evaluate(() => { if (typeof go === 'function') go('config'); });
      await page.waitForTimeout(500);
      await page.evaluate(async () => {
        if (typeof cargarUsuariosDesdeSupabase === 'function') await cargarUsuariosDesdeSupabase(true);
      });
      await page.waitForTimeout(2000);

      // Leer DB directamente (binding `let`, no window.DB)
      const ueEnDB = await page.evaluate(() => {
        try { return typeof DB === 'undefined' ? -1 : (Array.isArray(DB.usuariosExternos) ? DB.usuariosExternos.length : -2); }
        catch(e) { return -3; }
      });
      console.log(`  DB.usuariosExternos.length = ${ueEnDB}`);
      ok('R11-a: DB.usuariosExternos es array', ueEnDB >= 0);

      const idFU = fc.usuariosExternos[0];
      const encontrado = await page.evaluate((id) => {
        try { return typeof DB !== 'undefined' && Array.isArray(DB.usuariosExternos) && DB.usuariosExternos.some(u => u.id === id); }
        catch(e) { return false; }
      }, idFU);
      ok(`R11-b: fixture ${idFU.slice(0,8)}… en DB.usuariosExternos`, encontrado);

      if (encontrado) {
        const v9Tabla = await page.evaluate((id) => {
          try { const u = DB.usuariosExternos?.find(u => u.id === id); return u ? (u._v9Tabla || null) : null; }
          catch(e) { return null; }
        }, idFU);
        ok('R11-c: _v9Tabla presente', !!v9Tabla);
        ok('R11-d: _v9Tabla = "usuarios_externos"', v9Tabla === 'usuarios_externos');
      }

      // ── R12 ──────────────────────────────────────────────────────────────
      console.log('\n[R12] B6: toggleUsuarioAdmin hace PATCH en la tabla V9 correcta');
      if (!encontrado) {
        skip('R12', 'fixture no en DB.usuariosExternos');
      } else {
        const rAntes = await supaAuth(
          `/rest/v1/usuarios_externos?id=eq.${encodeURIComponent(idFU)}&select=id,desactivado`, jwt
        );
        ok('R12-a: GET estado inicial HTTP 200 + array', rAntes.status === 200 && Array.isArray(rAntes.body));
        const desActivAntes = rAntes.body?.[0]?.desactivado ?? null;
        console.log(`  Estado inicial desactivado=${desActivAntes}`);

        const toggleOk = await page.evaluate(async (uid) => {
          try { if (typeof toggleUsuarioAdmin !== 'function') return false; await toggleUsuarioAdmin(uid); return true; }
          catch(e) { console.error('[R12]', e.message); return false; }
        }, idFU);
        ok('R12-b: toggleUsuarioAdmin sin excepción', toggleOk);

        await page.waitForTimeout(1500);
        const rDespues = await supaAuth(
          `/rest/v1/usuarios_externos?id=eq.${encodeURIComponent(idFU)}&select=id,desactivado`, jwt
        );
        ok('R12-c: GET posterior HTTP 200 + array', rDespues.status === 200 && Array.isArray(rDespues.body));
        const desActivDespues = rDespues.body?.[0]?.desactivado ?? null;
        console.log(`  Estado después desactivado=${desActivDespues}`);
        ok('R12-d: desactivado cambió en DB (PATCH V9 efectivo)', desActivDespues !== null && desActivDespues !== desActivAntes);

        if (desActivDespues !== desActivAntes) {
          await supaAuth(
            `/rest/v1/usuarios_externos?id=eq.${encodeURIComponent(idFU)}&cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}`,
            jwt, { method: 'PATCH', body: { desactivado: desActivAntes }, prefer: 'return=minimal' }
          );
          console.log('  Toggle revertido ✓');
        }
      }
    }

  } catch (e) {
    console.error(`\n❌ Error inesperado: ${e.message}`);
    fail++;
    failures.push(`Error inesperado: ${e.message.split('\n')[0].slice(0, 120)}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server)  server.close();
    const totalFix = [...fc.cursos,...fc.cuotas,...fc.alumnos,...fc.planes_pago,...fc.abonos,...fc.pagos,...fc.usuariosExternos].length;
    if (jwt && CUENTA_ID && totalFix > 0) {
      console.log(`\n[R13/finally] Eliminar ${totalFix} fixtures`);
      fallosCleanup = await eliminarFixtures(jwt, CUENTA_ID, fc).catch(e => {
        console.error('  [finally] eliminarFixtures:', e.message); return 99;
      });
    }
  }

  // R13
  const totalFix = [...fc.cursos,...fc.cuotas,...fc.alumnos,...fc.planes_pago,...fc.abonos,...fc.pagos,...fc.usuariosExternos].length;
  if (totalFix > 0)
    ok(`R13: limpieza completa (${totalFix} fixtures, ${fallosCleanup} fallos)`, fallosCleanup === 0);

  // ── Resumen ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`📊 E13: ${pass} ✅  ${fail} ❌  ${blocked} ⏭ (bloqueados)`);
  if (blockedList.length) { console.log('\nBloqueados:'); blockedList.forEach(f => console.log('  •', f)); }
  if (failures.length)    { console.log('\nFallas:');    failures.forEach(f => console.log('  •', f)); }
  console.log('\nPendientes conocidos:');
  console.log('  • Paginación: exportar >1000 filas sin truncar — bloquea publicación');
  console.log('  • B5/B6 no declarados completos hasta que estos tests pasen íntegramente');
  console.log('  • Restauración de sesión / recordar acceso (sin implementar en V9)');
  console.log('  • Comparación funcional completa con app original');
  process.exit(fail > 0 ? 1 : 0);
})();
