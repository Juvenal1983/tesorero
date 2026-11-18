/**
 * tests/e13_restauracion_usuarios_ui.js
 *
 * Suite Playwright E13 — Restauración V9 (B5-import) + Administración usuarios (B6)
 *
 * Estrategia de fixtures:
 *   - `fixtureCreados` vive fuera del try/finally y registra cada registro
 *     insertado en tiempo real.
 *   - `respaldoFixture` se construye con SOLO los registros fixture y sus
 *     dependencias directas — R06/R07/R09 NO reimportan el respaldo completo.
 *   - `eliminarFixtures` exige HTTP 200 + body array + length === 0 en cada GET.
 *   - Si un fixture no puede crearse, los tests que dependen de él se marcan
 *     "bloqueados" y se cuentan en el resumen final.
 *   - Producción excluida.
 *
 * Verifica:
 *   R01  Servidor local levantado y staging alcanzable
 *   R02  Login UI + V9 mode activo (_v9CuentaId disponible)
 *   R03  exportarDatosCompletosV9 → JSON descargado con estructura válida
 *   R04  Cursos, alumnos y pagos fixture aparecen en el respaldo (IDs exactos)
 *   R05  Límite de paginación — colecciones que alcancen 1000 filas son marcadas
 *   R06  Eliminar fixtures → importar respaldo-fixture → GET por ID confirma restauración exacta
 *   R07  Importar mismo respaldo-fixture segunda vez → idempotente (counts exactos, sin duplicar)
 *   R08  Importar con cuentaId ajeno en el encabezado → rechazado con mensaje UI
 *   R09  Lote con cuentaId ajeno en un registro → rechazado antes de escribir (guardia por-registro)
 *   R10  Lote con FK inválida → error reportado por tabla, sin anuncio de restauración completa
 *   R11  B6: cargarUsuariosDesdeSupabase popula DB.usuariosExternos (binding real, no window.DB)
 *   R12  B6: toggleUsuarioAdmin hace PATCH en la tabla V9 correcta
 *   R13  Limpieza: todos los fixtures eliminados, GET exige HTTP 200 + array + length 0
 *
 * Pendientes conocidos (fuera de esta suite):
 *   - Paginación: exportarDatosCompletosV9 trunca en 1000 filas — bloquea publicación
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
  console.error('   Este test solo corre contra staging.');
  process.exit(2);
}

const EXEC_ID  = Date.now().toString(36);
const APP_PORT = 8802;
let CUENTA_ID  = process.env.STAGING_CUENTA_ID || null;

let pass = 0, fail = 0, blocked = 0;
const failures = [];
const blockedList = [];

function ok(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else       { console.error(`  ❌ ${label}`); fail++; failures.push(label); }
}
function skip(label, razon) {
  console.log(`  ⏭  ${label} [bloqueado: ${razon}]`);
  blocked++;
  blockedList.push(label);
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

// ── Servidor HTTP local (sirve la app real) ───────────────────────────────────

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

// ── Login + cuenta ────────────────────────────────────────────────────────────

async function loginTesorero() {
  const r = await _fetch('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email: USER_EMAIL, password: USER_PASS },
    prefer: '',
    authHeader: null,
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
    `/rest/v1/tesorero_cuentas?auth_id=eq.${encodeURIComponent(sub)}&select=id&limit=1`,
    jwt
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
    const tipo = d.type();
    const msg  = d.message();
    console.log(`    [dialog] ${tipo}: ${msg.slice(0, 120)}`);
    estado.ultimoDialog = { type: tipo, message: msg };
    await d.accept().catch(() => {});
  });
}

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

async function navegarConfig(page) {
  await page.evaluate(() => { if (typeof go === 'function') go('config'); });
  await page.waitForFunction(() => window.S?.route === 'config', { timeout: T_CORTO });
}

/**
 * Dispara importarDatos en la página pasando el contenido JSON dado.
 * El confirm() es aceptado por el manejador de diálogos ya instalado.
 * Espera a que #export-msg sea visible y devuelve su texto, o null si no aparece.
 */
async function dispararImportacion(page, jsonContent) {
  const jsonStr = typeof jsonContent === 'string' ? jsonContent : JSON.stringify(jsonContent);

  // Ocultar export-msg antes de importar para detectar el nuevo mensaje limpiamente
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

  // Esperar a que #export-msg sea visible con contenido
  let msgTexto = null;
  try {
    await page.waitForFunction(() => {
      const el = document.getElementById('export-msg');
      return el && el.style.display !== 'none' && el.innerText.trim().length > 0;
    }, { timeout: 15_000 });
    msgTexto = await page.evaluate(() => {
      const el = document.getElementById('export-msg');
      return el ? el.innerText.trim() : null;
    });
  } catch (_) {
    // Sin mensaje en DOM tras 15 s
  }
  return msgTexto;
}

// ── Gestión de fixtures ───────────────────────────────────────────────────────

/**
 * Inserta 1 curso, 2 alumnos, 1 pago, 1 usuario_externo aislados con EXEC_ID.
 * fixtureCreados se pasa por referencia y se va llenando durante la inserción.
 * Lanza si el curso/alumnos/pagos no se pueden crear (prerequisito para R06-R10).
 * Para usuarios_externos: registra el error pero no lanza (R11-R12 se bloquean).
 */
async function insertarFixtures(jwt, cuentaId, fixtureCreados) {
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
    throw new Error(`insertarFixtures: curso falló HTTP ${rC.status}: ${JSON.stringify(rC.body)}`);
  fixtureCreados.cursos.push(cursoId);
  console.log(`  [fixture] curso ${cursoId.slice(0,8)}… insertado`);

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
      throw new Error(`insertarFixtures: alumno ${j} falló HTTP ${rA.status}: ${JSON.stringify(rA.body)}`);
    fixtureCreados.alumnos.push(alumnoId);
    if (j === 1) primerAlumnoId = alumnoId;
  }
  console.log(`  [fixture] 2 alumnos insertados en curso ${cursoId.slice(0,8)}…`);

  // 1 pago
  const pagoId = uid();
  const rP = await supaAuth('/rest/v1/pagos', jwt, {
    method: 'POST',
    body: { id: pagoId, cuenta_id: cuentaId, alumno_id: primerAlumnoId,
            monto: 9900, fecha: hoy, medio: 'efectivo', estado: 'pagado',
            periodo: `FixtureE13-${EXEC_ID}`, obs: `Fixture E13 ${EXEC_ID}` },
    prefer: 'return=representation',
  });
  if (rP.status < 200 || rP.status >= 300)
    throw new Error(`insertarFixtures: pago falló HTTP ${rP.status}: ${JSON.stringify(rP.body)}`);
  fixtureCreados.pagos.push(pagoId);
  console.log(`  [fixture] pago ${pagoId.slice(0,8)}… insertado`);

  // 1 usuario externo (para B6) — no fatal si falla
  const ueId = uid();
  const rU = await supaAuth('/rest/v1/usuarios_externos', jwt, {
    method: 'POST',
    body: { id: ueId, cuenta_id: cuentaId,
            email: `fixture_e13_${EXEC_ID}@test.local`,
            nombre: `FixtureUsuarioE13-${EXEC_ID}`, desactivado: false },
    prefer: 'return=representation',
  });
  if (rU.status >= 200 && rU.status < 300) {
    fixtureCreados.usuariosExternos.push(ueId);
    console.log(`  [fixture] usuario_externo ${ueId.slice(0,8)}… insertado`);
  } else {
    fixtureCreados.errorUsuarioExterno =
      `HTTP ${rU.status}: ${JSON.stringify(rU.body).slice(0, 120)}`;
    console.warn(`  [fixture] usuario_externo NO creado: ${fixtureCreados.errorUsuarioExterno}`);
  }
}

/**
 * Construye un respaldo mínimo con SOLO los registros fixture y sus deps directas.
 * No incluye datos de otros alumnos, cursos o pagos de la cuenta.
 */
function construirRespaldoFixture(cuentaId, fixtureCreados, respaldoCompleto) {
  const cols = respaldoCompleto?.colecciones || {};
  const cursoIds  = new Set(fixtureCreados.cursos);
  const alumnoIds = new Set(fixtureCreados.alumnos);
  const pagoIds   = new Set(fixtureCreados.pagos);

  // Recoger cuotas y planes del fixture (si existen en el respaldo completo)
  const cuotasFixture = (cols.cuotas || []).filter(r => cursoIds.has(r.curso_id));
  const cuotaIds      = new Set(cuotasFixture.map(c => c.id));
  const planesFixture = (cols.planes_pago || []).filter(r =>
    alumnoIds.has(r.alumno_id) || cuotaIds.has(r.cuota_id));
  const planIds       = new Set(planesFixture.map(p => p.id));
  const abonosFixture = (cols.abonos || []).filter(r => planIds.has(r.plan_id));

  const colsFixture = {
    cursos:            (cols.cursos   || []).filter(r => cursoIds.has(r.id)),
    alumnos:           (cols.alumnos  || []).filter(r => alumnoIds.has(r.id)),
    apoderados:        (cols.apoderados || []).filter(r => alumnoIds.has(r.alumno_id)),
    cuotas:            cuotasFixture,
    planes_pago:       planesFixture,
    abonos:            abonosFixture,
    pagos:             (cols.pagos    || []).filter(r => pagoIds.has(r.id)),
    movimientos:       [],
    fondo_movimientos: [],
    actividades:       [],
    notas:             [],
    codigos_invitacion:[],
    config_cuenta:     [],
  };

  return {
    version:  'v9-completo',
    fecha:    new Date().toISOString(),
    cuentaId,
    alcance:  `fixture E13 ${EXEC_ID}`,
    colecciones: colsFixture,
  };
}

/**
 * Elimina todos los fixtures y verifica por GET que fueron eliminados.
 * Exige: HTTP 200 + body es Array + length === 0.
 * Devuelve el número de fallos (0 = limpieza completa).
 * No lanza — el caller usa el conteo para decidir.
 */
async function eliminarFixtures(jwt, cuentaId, fixtureCreados) {
  let fallos = 0;

  async function eliminarYVerificar(tabla, id) {
    try {
      const rDel = await supaAuth(
        `/rest/v1/${tabla}?id=eq.${encodeURIComponent(id)}&cuenta_id=eq.${encodeURIComponent(cuentaId)}`,
        jwt, { method: 'DELETE', prefer: '' }
      );
      if (rDel.status < 200 || rDel.status >= 300) {
        console.error(`  [cleanup] ${tabla} ${id.slice(0,8)}… DELETE falló: HTTP ${rDel.status}`);
        fallos++; return;
      }
      const rGet = await supaAuth(
        `/rest/v1/${tabla}?id=eq.${encodeURIComponent(id)}&select=id`,
        jwt
      );
      // Exigir HTTP 200 + array + length 0
      if (rGet.status !== 200) {
        console.error(`  [cleanup] ${tabla} ${id.slice(0,8)}… GET verificación HTTP ${rGet.status}`);
        fallos++;
      } else if (!Array.isArray(rGet.body)) {
        console.error(`  [cleanup] ${tabla} ${id.slice(0,8)}… GET no devolvió array: ${JSON.stringify(rGet.body).slice(0,80)}`);
        fallos++;
      } else if (rGet.body.length > 0) {
        console.error(`  [cleanup] ${tabla} ${id.slice(0,8)}… sigue en DB después de DELETE`);
        fallos++;
      } else {
        console.log(`  [cleanup] ${tabla} ${id.slice(0,8)}… eliminado ✓`);
      }
    } catch (e) {
      console.error(`  [cleanup] ${tabla} ${id.slice(0,8)}… excepción: ${e.message}`);
      fallos++;
    }
  }

  // Orden FK-safe: primero dependientes, luego padres
  for (const id of fixtureCreados.usuariosExternos) await eliminarYVerificar('usuarios_externos', id);
  for (const id of fixtureCreados.pagos)            await eliminarYVerificar('pagos',             id);
  for (const id of fixtureCreados.alumnos)          await eliminarYVerificar('alumnos',           id);
  for (const id of fixtureCreados.cursos)           await eliminarYVerificar('cursos',            id);

  return fallos;
}

// ── Verificar existencia exacta de un ID en DB ────────────────────────────────

async function existeEnDB(jwt, tabla, id) {
  const r = await supaAuth(
    `/rest/v1/${tabla}?id=eq.${encodeURIComponent(id)}&select=id`,
    jwt
  );
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

  const fixtureCreados = {
    cursos: [], alumnos: [], pagos: [], usuariosExternos: [],
    errorUsuarioExterno: null,
  };

  let server           = null;
  let browser          = null;
  let respaldoCompleto = null;   // respaldo completo de la cuenta (R03)
  let respaldoFixture  = null;   // respaldo mínimo solo con fixture (R06-R10)
  let fallosCleanup    = 0;
  const dialogState    = { ultimoDialog: null };

  try {
    // ── R01: Servidor ─────────────────────────────────────────────────────────
    console.log('\n[R01] Servidor HTTP local (app real contra staging)');
    server = await servirApp();
    ok('R01: servidor levantado', true);

    // ── R02: Login UI ─────────────────────────────────────────────────────────
    console.log('\n[R02] Login UI + V9 mode activo');
    browser = await chromium.launch({ headless: true });
    const ctx  = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      acceptDownloads: true,
    });
    const page = await ctx.newPage();
    page.on('console', msg => {
      if (msg.type() === 'error') console.error(`  [browser] ${msg.text()}`);
    });
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
      ok('R02-a: login completado (_v9CuentaId disponible)', true);
    } catch (_) {
      ok('R02-a: login completado', false);
      throw new Error('Login UI no completó');
    }

    const cuentaUI = await page.evaluate(() => window.S?._v9CuentaId ?? null);
    if (!cuentaUI) throw new Error('_v9CuentaId no disponible en window.S tras login');
    if (cuentaUI !== CUENTA_ID) {
      throw new Error(
        `Discrepancia de cuenta: REST="${CUENTA_ID}" UI="${cuentaUI}".\n` +
        `  → Fija STAGING_CUENTA_ID=${cuentaUI} en .env.`
      );
    }
    console.log(`  Cuenta REST = Cuenta UI = ${CUENTA_ID} ✓`);

    const v9Activo = await page.evaluate(() =>
      typeof window.V9_RELACIONAL !== 'undefined' && window.V9_RELACIONAL === true
    );
    ok('R02-b: V9_RELACIONAL activo en la app', v9Activo);

    // Insertar fixtures DESPUÉS de verificar coherencia, DENTRO del try
    console.log('\n[Pre] Insertar fixtures propios (1 curso, 2 alumnos, 1 pago, 1 usuario_externo)');
    await insertarFixtures(jwt, CUENTA_ID, fixtureCreados);
    console.log(`  Fixtures: cursos=${fixtureCreados.cursos.length}, alumnos=${fixtureCreados.alumnos.length}, pagos=${fixtureCreados.pagos.length}, usuariosExternos=${fixtureCreados.usuariosExternos.length}`);
    if (fixtureCreados.errorUsuarioExterno)
      nota('Pre', `usuario_externo no creado (R11-R12 se bloquearán): ${fixtureCreados.errorUsuarioExterno}`);

    // ── R03: Exportar respaldo completo ───────────────────────────────────────
    console.log('\n[R03] exportarDatosCompletosV9 → JSON descargado');
    await navegarConfig(page);

    let capturado = null;
    let tmpFile   = null;
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
      console.error(`  [R03] Error capturando descarga: ${e.message}`);
    } finally {
      if (tmpFile) try { fs.unlinkSync(tmpFile); } catch(_) {}
    }

    ok('R03-a: archivo de respaldo descargado', !!capturado);

    if (capturado) {
      try {
        respaldoCompleto = JSON.parse(capturado);
        ok('R03-b: JSON válido (parse sin error)', true);
      } catch (e) {
        ok('R03-b: JSON válido', false);
        console.error('  Parse error:', e.message);
      }
    } else {
      ok('R03-b: JSON válido', false);
    }

    if (respaldoCompleto) {
      ok('R03-c: version = "v9-completo"', respaldoCompleto.version === 'v9-completo');
      ok('R03-d: cuentaId coincide con la cuenta UI', respaldoCompleto.cuentaId === CUENTA_ID);
      ok('R03-e: campo "colecciones" presente',
        typeof respaldoCompleto.colecciones === 'object' && respaldoCompleto.colecciones !== null);

      const COLS_ESPERADAS = [
        'cursos','alumnos','apoderados','cuotas','planes_pago','abonos',
        'pagos','movimientos','fondo_movimientos','actividades',
        'notas','codigos_invitacion','config_cuenta',
      ];
      let todasPresentes = true;
      for (const col of COLS_ESPERADAS) {
        if (!Array.isArray(respaldoCompleto.colecciones[col])) {
          console.error(`  [R03-f] colección ausente: "${col}"`);
          todasPresentes = false;
        }
      }
      ok('R03-f: todas las colecciones esperadas en el respaldo', todasPresentes);

      // Construir respaldo-fixture (aislado) para R06-R10
      respaldoFixture = construirRespaldoFixture(CUENTA_ID, fixtureCreados, respaldoCompleto);
      const nFix = Object.values(respaldoFixture.colecciones)
        .reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0);
      console.log(`  respaldoFixture construido: ${nFix} registros totales (solo fixture)`);
    }

    // ── R04: Fixtures en el respaldo completo ─────────────────────────────────
    console.log('\n[R04] Fixtures propios aparecen en el respaldo completo (IDs exactos)');
    if (!respaldoCompleto) {
      skip('R04', 'R03 no obtuvo JSON');
    } else {
      const cols = respaldoCompleto.colecciones || {};
      const cursosResp  = Array.isArray(cols.cursos)  ? cols.cursos  : [];
      const alumnosResp = Array.isArray(cols.alumnos) ? cols.alumnos : [];
      const pagosResp   = Array.isArray(cols.pagos)   ? cols.pagos   : [];

      ok(`R04-a: curso fixture en respaldo`,
        fixtureCreados.cursos.every(id => cursosResp.some(c => c.id === id)));
      ok(`R04-b: ${fixtureCreados.alumnos.length} alumnos fixture en respaldo`,
        fixtureCreados.alumnos.every(id => alumnosResp.some(a => a.id === id)));
      ok(`R04-c: ${fixtureCreados.pagos.length} pagos fixture en respaldo`,
        fixtureCreados.pagos.every(id => pagosResp.some(p => p.id === id)));

      const alumnosFixture = alumnosResp.filter(a => fixtureCreados.alumnos.includes(a.id));
      ok('R04-d: alumnos fixture tienen cuenta_id correcto',
        alumnosFixture.length > 0 && alumnosFixture.every(a => a.cuenta_id === CUENTA_ID));
      ok('R04-e: alumnos fixture tienen curso_id',
        alumnosFixture.length > 0 && alumnosFixture.every(a => !!a.curso_id));

      const pagosFixture = pagosResp.filter(p => fixtureCreados.pagos.includes(p.id));
      ok('R04-f: pagos fixture tienen cuenta_id correcto',
        pagosFixture.length > 0 && pagosFixture.every(p => p.cuenta_id === CUENTA_ID));

      // Compatibilidad: planes_pago y abonos tienen cuenta_id
      const planesResp = Array.isArray(cols.planes_pago) ? cols.planes_pago : [];
      const abonosResp = Array.isArray(cols.abonos)      ? cols.abonos      : [];
      if (planesResp.length > 0) {
        ok('R04-g: planes_pago tiene campo cuenta_id', 'cuenta_id' in planesResp[0]);
        nota('R04-g campos planes_pago', Object.keys(planesResp[0]).join(', '));
      } else {
        nota('R04-g', 'planes_pago vacío en esta cuenta (OK)');
      }
      if (abonosResp.length > 0) {
        ok('R04-h: abonos tiene campo cuenta_id', 'cuenta_id' in abonosResp[0]);
        nota('R04-h campos abonos', Object.keys(abonosResp[0]).join(', '));
      } else {
        nota('R04-h', 'abonos vacío en esta cuenta (OK)');
      }
    }

    // ── R05: Límite de paginación ──────────────────────────────────────────────
    console.log('\n[R05] Límite de paginación — colecciones que alcancen 1000 filas');
    console.log('  exportarDatosCompletosV9 NO implementa paginación.');
    console.log('  Una tabla con ≥ 1000 filas devuelve solo las primeras 1000 sin aviso.');
    if (!respaldoCompleto) {
      skip('R05', 'R03 no obtuvo JSON');
    } else {
      const cols = respaldoCompleto.colecciones || {};
      let algunaAlLimite = false;
      for (const [nombre, arr] of Object.entries(cols)) {
        if (Array.isArray(arr)) {
          const n = arr.length;
          if (n >= 1000) {
            console.error(`  ⚠️  "${nombre}" tiene ${n} registros — posible truncación!`);
            algunaAlLimite = true;
          } else {
            console.log(`  ${nombre}: ${n} registros${n >= 900 ? ' ⚠️  (cerca del límite)' : ''}`);
          }
        }
      }
      nota('R05: paginación pendiente',
        algunaAlLimite
          ? 'UNA O MÁS COLECCIONES ALCANZAN 1000 — exportación potencialmente incompleta'
          : 'ninguna colección alcanza el límite en este staging');
      ok('R05: ninguna colección reporta 1000 filas exactos en staging', !algunaAlLimite);
    }

    // ── R06: Eliminar fixtures → importar respaldo-fixture → GET por ID exacto ─
    console.log('\n[R06] Eliminar fixtures → importar respaldo-fixture → verificar por ID exacto');
    if (!respaldoFixture || fixtureCreados.alumnos.length === 0) {
      skip('R06', 'requiere respaldoFixture y fixtures creados');
      skip('R07', 'requiere R06');
    } else {
      // Eliminar alumnos y pagos fixture (crear brecha)
      let errorEliminar = null;
      for (const id of [...fixtureCreados.pagos]) {
        if (errorEliminar) break;
        const r = await supaAuth(
          `/rest/v1/pagos?id=eq.${encodeURIComponent(id)}&cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}`,
          jwt, { method: 'DELETE', prefer: '' }
        );
        if (r.status >= 300) errorEliminar = `pago ${id.slice(0,8)} HTTP ${r.status}`;
      }
      for (const id of [...fixtureCreados.alumnos]) {
        if (errorEliminar) break;
        const r = await supaAuth(
          `/rest/v1/alumnos?id=eq.${encodeURIComponent(id)}&cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}`,
          jwt, { method: 'DELETE', prefer: '' }
        );
        if (r.status >= 300) errorEliminar = `alumno ${id.slice(0,8)} HTTP ${r.status}`;
      }

      if (errorEliminar) {
        ok('R06-a: fixtures eliminados para crear brecha', false);
        console.error(`  Error en eliminación: ${errorEliminar}`);
        skip('R06-b/c/d', 'eliminación previa falló');
        skip('R07', 'requiere R06 exitoso');
      } else {
        ok('R06-a: alumnos y pagos fixture eliminados', true);

        // Verificar que los fixtures ya no están en DB
        for (const id of fixtureCreados.alumnos) {
          const existe = await existeEnDB(jwt, 'alumnos', id);
          ok(`R06-b: alumno fixture ${id.slice(0,8)}… ausente en DB antes de importar`, !existe);
        }

        // Importar respaldo-fixture (solo los registros de este EXEC_ID)
        console.log('  Importando respaldo-fixture…');
        dialogState.ultimoDialog = null;
        await navegarConfig(page);
        const msgImport = await dispararImportacion(page, respaldoFixture);
        console.log(`  Mensaje UI: ${msgImport || '(vacío)'}`);

        // Verificar restauración exacta por ID (GET individual, no conteo >=)
        let alumnosRestaurados = 0;
        for (const id of fixtureCreados.alumnos) {
          const existe = await existeEnDB(jwt, 'alumnos', id);
          ok(`R06-c: alumno fixture ${id.slice(0,8)}… restaurado (GET por ID)`, existe);
          if (existe) alumnosRestaurados++;
        }
        let pagosRestaurados = 0;
        for (const id of fixtureCreados.pagos) {
          const existe = await existeEnDB(jwt, 'pagos', id);
          ok(`R06-d: pago fixture ${id.slice(0,8)}… restaurado (GET por ID)`, existe);
          if (existe) pagosRestaurados++;
        }

        // Exigir restauración completa y mensaje sin error parcial
        const restauracionCompleta =
          alumnosRestaurados === fixtureCreados.alumnos.length &&
          pagosRestaurados === fixtureCreados.pagos.length;
        ok('R06-e: restauración completa de fixture (todos los IDs presentes)', restauracionCompleta);

        const msgIndica_completa = msgImport &&
          (msgImport.includes('completa') || msgImport.includes('restaurado') || msgImport.includes('✅'));
        const msgIndica_error = msgImport &&
          (msgImport.includes('⚠️') || msgImport.toLowerCase().includes('error'));
        ok('R06-f: UI muestra resultado de restauración', !!(msgIndica_completa || msgIndica_error));
        if (msgIndica_error)
          nota('R06-f', 'importación fue parcial — revisar detalles del mensaje');

        // ── R07: Idempotencia ─────────────────────────────────────────────────
        console.log('\n[R07] Importar mismo respaldo-fixture segunda vez → idempotente');

        // Capturar counts exactos antes de segunda importación
        const contarQuery = async (tabla, ids) => {
          if (!ids.length) return 0;
          // Contar por OR de IDs (máx 10 en este fixture)
          const idsFilter = ids.map(id => `id.eq.${encodeURIComponent(id)}`).join(',');
          const r = await supaAuth(
            `/rest/v1/${tabla}?or=(${idsFilter})&select=id`,
            jwt
          );
          return (r.status === 200 && Array.isArray(r.body)) ? r.body.length : null;
        };

        const countAntes = {
          alumnos: await contarQuery('alumnos', fixtureCreados.alumnos),
          pagos:   await contarQuery('pagos',   fixtureCreados.pagos),
        };
        console.log(`  Antes de segunda importación: alumnos fixture=${countAntes.alumnos}, pagos fixture=${countAntes.pagos}`);

        dialogState.ultimoDialog = null;
        await navegarConfig(page);
        const msgImport2 = await dispararImportacion(page, respaldoFixture);
        console.log(`  Mensaje UI segunda importación: ${msgImport2 || '(vacío)'}`);

        const countDespues = {
          alumnos: await contarQuery('alumnos', fixtureCreados.alumnos),
          pagos:   await contarQuery('pagos',   fixtureCreados.pagos),
        };
        console.log(`  Tras segunda importación: alumnos fixture=${countDespues.alumnos}, pagos fixture=${countDespues.pagos}`);

        ok('R07-a: alumnos fixture no se duplican (count exacto)',
          countAntes.alumnos !== null && countDespues.alumnos === countAntes.alumnos);
        ok('R07-b: pagos fixture no se duplican (count exacto)',
          countAntes.pagos !== null && countDespues.pagos === countAntes.pagos);

        // IDs individuales existen y siguen siendo exactamente los fixture
        for (const id of fixtureCreados.alumnos) {
          const existe = await existeEnDB(jwt, 'alumnos', id);
          ok(`R07-c: alumno fixture ${id.slice(0,8)}… existe tras segunda importación`, existe);
        }
      }
    }

    // ── R08: cuentaId ajeno en encabezado → rechazado ─────────────────────────
    console.log('\n[R08] Importar con cuentaId ajeno en encabezado → rechazado con mensaje UI');
    if (!respaldoFixture) {
      skip('R08', 'requiere respaldoFixture');
    } else {
      const backupAjeno = JSON.parse(JSON.stringify(respaldoFixture));
      backupAjeno.cuentaId = 'cuenta-ajena-00000000-0000-0000-0000-000000000000';

      dialogState.ultimoDialog = null;
      await navegarConfig(page);
      const msgAjeno = await dispararImportacion(page, backupAjeno);
      console.log(`  Mensaje UI: ${msgAjeno || '(vacío)'}`);

      const rechazadoEnMsg = msgAjeno &&
        (msgAjeno.includes('otra cuenta') || msgAjeno.includes('ajeno') ||
         msgAjeno.includes('cuentaId') || msgAjeno.includes('❌'));
      const rechazadoEnAlert = !!(dialogState.ultimoDialog?.message);
      ok('R08-a: cuentaId ajeno es rechazado', rechazadoEnMsg || rechazadoEnAlert);
      ok('R08-b: rechazo aparece en DOM (no alert bloqueante en V9)', rechazadoEnMsg);
      if (rechazadoEnAlert && !rechazadoEnMsg)
        nota('R08', 'rechazo via dialog — se esperaba mensaje en #export-msg');
    }

    // ── R09: cuenta_id ajeno en un registro → guardia por-registro ────────────
    console.log('\n[R09] Registro con cuenta_id ajeno → guardia por-registro cancela antes de escribir');
    if (!respaldoFixture) {
      skip('R09', 'requiere respaldoFixture');
    } else {
      // Insertar un alumno con cuenta_id falso en el respaldo fixture
      const backupCuentaAjena = JSON.parse(JSON.stringify(respaldoFixture));
      backupCuentaAjena.colecciones.alumnos.push({
        id:        crypto.randomUUID(),
        cuenta_id: 'cuenta-ajena-99999999-0000-0000-0000-000000000000',
        curso_id:  fixtureCreados.cursos[0],
        nombres:   'CorruptoR09',
        apellidos: EXEC_ID,
        estado:    'activo',
      });

      dialogState.ultimoDialog = null;
      await navegarConfig(page);
      const msgCuentaAjena = await dispararImportacion(page, backupCuentaAjena);
      console.log(`  Mensaje UI: ${msgCuentaAjena || '(vacío)'}`);

      const rechazado = msgCuentaAjena &&
        (msgCuentaAjena.includes('cuenta_id ajeno') || msgCuentaAjena.includes('ajeno') ||
         msgCuentaAjena.includes('❌') || msgCuentaAjena.includes('cancelada'));
      ok('R09-a: registro con cuenta_id ajeno cancela la importación', rechazado);
      ok('R09-b: rechazo aparece en DOM antes de escribir', rechazado);

      // Verificar que el registro ajeno NO fue escrito (el cancel debe ser previo)
      const rCorrupto = await supaAuth(
        `/rest/v1/alumnos?apellidos=eq.${encodeURIComponent(EXEC_ID)}&nombres=eq.CorruptoR09&select=id`,
        jwt
      );
      const escritoAjeno = rCorrupto.status === 200 &&
                           Array.isArray(rCorrupto.body) && rCorrupto.body.length > 0;
      ok('R09-c: registro ajeno NO fue escrito en DB (cancelación previa a upsert)', !escritoAjeno);
    }

    // ── R10: FK inválida → error reportado por tabla ──────────────────────────
    console.log('\n[R10] FK inválida en un lote → error reportado por tabla, sin anuncio completo');
    console.log('  NOTA: Cada POST es una transacción independiente. Si falla un chunk,');
    console.log('  los chunks anteriores del mismo upsert ya están confirmados.');
    if (!respaldoFixture) {
      skip('R10', 'requiere respaldoFixture');
    } else {
      // Añadir alumno con curso_id inexistente (FK violation)
      const backupFKInvalida = JSON.parse(JSON.stringify(respaldoFixture));
      const cursoFalsoId = crypto.randomUUID();
      backupFKInvalida.colecciones.alumnos.push({
        id:        crypto.randomUUID(),
        cuenta_id: CUENTA_ID,
        curso_id:  cursoFalsoId,  // FK a curso inexistente
        nombres:   'FKInvalidaR10',
        apellidos: EXEC_ID,
        estado:    'activo',
      });

      dialogState.ultimoDialog = null;
      await navegarConfig(page);
      const msgFK = await dispararImportacion(page, backupFKInvalida);
      console.log(`  Mensaje UI: ${msgFK || '(vacío)'}`);

      const anuncia_completa = msgFK && msgFK.includes('completa') && !msgFK.includes('⚠️');
      const reporta_error    = msgFK && (msgFK.includes('⚠️') || msgFK.toLowerCase().includes('error'));
      ok('R10-a: error de FK es reportado en la UI', reporta_error);
      ok('R10-b: UI NO anuncia restauración completa cuando hay error', !anuncia_completa);
      nota('R10-c comportamiento de chunks',
        'Si la FK inválida está en chunk posterior a registros válidos, los anteriores ya confirmados.');
    }

    // ── R11: B6 — cargarUsuariosDesdeSupabase ─────────────────────────────────
    console.log('\n[R11] B6: cargarUsuariosDesdeSupabase popula DB.usuariosExternos');
    if (!v9Activo) {
      skip('R11', 'V9_RELACIONAL no activo');
    } else if (fixtureCreados.usuariosExternos.length === 0) {
      skip('R11', `usuario_externo fixture no creado: ${fixtureCreados.errorUsuarioExterno || 'error desconocido'}`);
      skip('R12', 'requiere fixture usuario_externo creado');
    } else {
      await page.evaluate(() => { if (typeof go === 'function') go('config'); });
      await page.waitForTimeout(500);

      // Forzar recarga — acceder al binding DB directamente, no vía window.DB
      // (DB declarado con `let` puede no estar en window en algunos entornos)
      await page.evaluate(async () => {
        if (typeof cargarUsuariosDesdeSupabase === 'function')
          await cargarUsuariosDesdeSupabase(true);
      });
      await page.waitForTimeout(2000);

      // Acceder al binding real de DB, no window.DB
      const ueEnDB = await page.evaluate(() => {
        try {
          // DB está en scope del módulo; en V9 debe ser un array tras carga
          if (typeof DB === 'undefined') return -1;
          return Array.isArray(DB.usuariosExternos) ? DB.usuariosExternos.length : -2;
        } catch(e) { return -3; }
      });
      console.log(`  DB.usuariosExternos.length = ${ueEnDB}`);
      ok('R11-a: DB.usuariosExternos es un array después de cargarUsuariosDesdeSupabase',
        ueEnDB >= 0);

      const idFixtureUser = fixtureCreados.usuariosExternos[0];
      const encontrado = await page.evaluate((id) => {
        try {
          if (typeof DB === 'undefined' || !Array.isArray(DB.usuariosExternos)) return false;
          return DB.usuariosExternos.some(u => u.id === id);
        } catch(e) { return false; }
      }, idFixtureUser);
      ok(`R11-b: usuario externo fixture ${idFixtureUser.slice(0,8)}… en DB.usuariosExternos`,
        encontrado);

      if (encontrado) {
        const v9Tabla = await page.evaluate((id) => {
          try {
            const u = DB.usuariosExternos?.find(u => u.id === id);
            return u ? (u._v9Tabla || null) : null;
          } catch(e) { return null; }
        }, idFixtureUser);
        ok('R11-c: usuario externo fixture tiene _v9Tabla asignado', !!v9Tabla);
        console.log(`  _v9Tabla: ${v9Tabla}`);
        ok('R11-d: _v9Tabla es "usuarios_externos" para el fixture externo',
          v9Tabla === 'usuarios_externos');
      }

      // ── R12: B6 — toggleUsuarioAdmin hace PATCH en la tabla correcta ──────
      console.log('\n[R12] B6: toggleUsuarioAdmin hace PATCH en la tabla V9 correcta');
      if (!encontrado) {
        skip('R12', 'fixture usuario_externo no aparece en DB.usuariosExternos');
      } else {
        const rAntes = await supaAuth(
          `/rest/v1/usuarios_externos?id=eq.${encodeURIComponent(idFixtureUser)}&select=id,desactivado`,
          jwt
        );
        ok('R12-a: GET estado inicial del fixture devuelve HTTP 200 + array',
          rAntes.status === 200 && Array.isArray(rAntes.body));

        const desactivadoAntes = rAntes.body?.[0]?.desactivado ?? null;
        console.log(`  Estado inicial desactivado=${desactivadoAntes}`);

        const toggleOk = await page.evaluate(async (uid) => {
          try {
            if (typeof toggleUsuarioAdmin !== 'function') return false;
            await toggleUsuarioAdmin(uid);
            return true;
          } catch(e) {
            console.error('[R12] toggleUsuarioAdmin error:', e.message);
            return false;
          }
        }, idFixtureUser);
        ok('R12-b: toggleUsuarioAdmin ejecutado sin excepción', toggleOk);

        await page.waitForTimeout(1500);

        const rDespues = await supaAuth(
          `/rest/v1/usuarios_externos?id=eq.${encodeURIComponent(idFixtureUser)}&select=id,desactivado`,
          jwt
        );
        ok('R12-c: GET estado posterior devuelve HTTP 200 + array',
          rDespues.status === 200 && Array.isArray(rDespues.body));

        const desactivadoDespues = rDespues.body?.[0]?.desactivado ?? null;
        console.log(`  Estado después de toggle desactivado=${desactivadoDespues}`);

        ok('R12-d: estado desactivado cambió en DB (PATCH V9 efectivo)',
          desactivadoDespues !== null && desactivadoDespues !== desactivadoAntes);

        // Revertir para dejar limpio
        if (desactivadoDespues !== desactivadoAntes) {
          await supaAuth(
            `/rest/v1/usuarios_externos?id=eq.${encodeURIComponent(idFixtureUser)}&cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}`,
            jwt, { method: 'PATCH', body: { desactivado: desactivadoAntes }, prefer: 'return=minimal' }
          );
          console.log('  Toggle revertido ✓');
        }
      }
    }

  } catch (e) {
    console.error(`\n❌ Error inesperado durante el test: ${e.message}`);
    fail++;
    failures.push(`Error inesperado: ${e.message.split('\n')[0].slice(0, 120)}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server)  server.close();

    const totalFixtures =
      fixtureCreados.cursos.length +
      fixtureCreados.alumnos.length +
      fixtureCreados.pagos.length +
      fixtureCreados.usuariosExternos.length;

    if (jwt && CUENTA_ID && totalFixtures > 0) {
      console.log(`\n[R13/finally] Eliminar todos los fixtures (${totalFixtures} registros)`);
      fallosCleanup = await eliminarFixtures(jwt, CUENTA_ID, fixtureCreados).catch(e => {
        console.error('  [finally] eliminarFixtures excepción:', e.message);
        return 99;
      });
    }
  }

  // R13: limpieza — siempre se ejecuta
  const totalFixtures =
    fixtureCreados.cursos.length +
    fixtureCreados.alumnos.length +
    fixtureCreados.pagos.length +
    fixtureCreados.usuariosExternos.length;

  if (totalFixtures > 0)
    ok(`R13: limpieza completa (${totalFixtures} fixtures, ${fallosCleanup} fallos)`, fallosCleanup === 0);

  // ── Resumen ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`📊 E13 B5-import + B6: ${pass} ✅  ${fail} ❌  ${blocked} ⏭ (bloqueados)`);
  if (blockedList.length) {
    console.log('\nBloqueados:');
    blockedList.forEach(f => console.log('  •', f));
  }
  if (failures.length) {
    console.log('\nFallas:');
    failures.forEach(f => console.log('  •', f));
  }
  console.log('\nPendientes conocidos (fuera de esta suite):');
  console.log('  • Paginación: exportarDatosCompletosV9 trunca en 1000 filas — bloquea publicación');
  console.log('  • Restauración de sesión / recordar acceso (sin implementar en V9)');
  console.log('  • Comparación funcional completa con app original');
  process.exit(fail > 0 ? 1 : 0);
})();
