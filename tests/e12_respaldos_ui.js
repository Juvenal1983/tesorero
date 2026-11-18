/**
 * tests/e12_respaldos_ui.js
 *
 * Suite Playwright B5 — Respaldo/Restauración V9
 *
 * Estrategia de fixtures:
 *   - `fixtureCreados` vive fuera del try/finally y registra cada registro
 *     insertado en tiempo real (cursos, alumnos, pagos).
 *   - Toda la preparación (inserción + browser) está dentro del try/finally.
 *   - `eliminarFixtures` hace un GET de verificación por cada registro;
 *     devuelve el número de fallos. Cualquier fallo cuenta como FAIL en el
 *     resumen final (no solo se imprime).
 *   - Si `insertarFixtures` falla a mitad, `fixtureCreados` contiene lo ya
 *     insertado y el finally lo limpia.
 *
 * Verifica:
 *   R01  Servidor local levantado
 *   R02  Login UI completado
 *   R03  exportarDatosCompletosV9 → JSON descargado con estructura válida
 *   R04  Respaldo incluye los dos cursos fixture (por ID exacto)
 *   R05  Alumnos y pagos fixture aparecen en el respaldo (IDs exactos)
 *   R06  Integridad: cuenta_id y curso_id en alumnos y pagos fixture
 *   R07  Colecciones complementarias presentes (actividades, abonos, notas, etc.)
 *   R08  importarDatos en V9 bloquea con alert explícito — no modifica caché
 *   R09  Limpieza: todos los fixtures eliminados y verificados por GET
 *
 * Notas:
 *   - B5 (importación/restauración) sigue PENDIENTE de implementar.
 *     R08 comprueba el bloqueo; eso no cierra B5.
 *   - Producción excluida.
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

const PROD_HOST    = 'tmjqzaakzhecbldebyeg.supabase.co';
const STAGING_HOST = 'rucgmytyxpfowznowxwd.supabase.co';
const SUPA_URL     = SUPA_URL_RAW;
let parsedHost;
try { parsedHost = new URL(SUPA_URL).hostname; } catch(_) { process.exit(2); }
if (parsedHost === PROD_HOST || parsedHost !== STAGING_HOST) {
  console.error('❌ URL no autorizada:', parsedHost); process.exit(2);
}

const EXEC_ID  = Date.now().toString(36);
const APP_PORT = 8801;
let CUENTA_ID  = process.env.STAGING_CUENTA_ID || null;

let pass = 0, fail = 0;
const failures = [];
function ok(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else       { console.error(`  ❌ ${label}`); fail++; failures.push(label); }
}
/** Marca una aserción como bloqueada (prerequisito falló); no cuenta como fallo. */
function skip(label, razon) {
  console.log(`  ⏭  ${label} [bloqueado: ${razon}]`);
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
function supaAnon(urlPath, opts = {}) {
  return _fetch(urlPath, { ...opts, authHeader: null });
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

// ── Login REST ────────────────────────────────────────────────────────────────

async function loginTesorero() {
  const r = await supaAnon('/auth/v1/token?grant_type=password', {
    method: 'POST', body: { email: USER_EMAIL, password: USER_PASS }, prefer: '',
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

/**
 * Instala un único manejador de diálogos en la página.
 * Acepta siempre (para no bloquear la UI) y guarda el mensaje en el objeto
 * compartido `estado.ultimoDialog`.  R08 lee ese objeto en lugar de registrar
 * un segundo handler que intentaría aceptar un diálogo ya aceptado.
 *
 * @param {import('playwright').Page} page
 * @param {{ ultimoDialog: {type:string, message:string}|null }} estado
 */
function instalarManejadorDialogos(page, estado) {
  page.on('dialog', async d => {
    const tipo = d.type();
    const msg  = d.message();
    console.log(`    [dialog] ${tipo}: ${msg.slice(0, 120)}`);
    estado.ultimoDialog = { type: tipo, message: msg };
    await d.accept().catch(() => {}); // accept puede fallar si ya fue manejado
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

// ── Gestión de fixtures ───────────────────────────────────────────────────────
//
// fixtureCreados se pasa por referencia y se va llenando durante la inserción.
// Si insertarFixtures lanza a mitad, el finally del caller puede limpiar lo
// que ya fue insertado.

async function insertarFixtures(jwt, cuentaId, fixtureCreados) {
  const uid = () => crypto.randomUUID();
  const hoy = new Date().toISOString().slice(0, 10);

  for (let i = 1; i <= 2; i++) {
    const cursoId = uid();
    const r = await supaAuth('/rest/v1/cursos', jwt, {
      method: 'POST',
      body: {
        id:        cursoId,
        cuenta_id: cuentaId,
        nombre:    `FixtureCurso-${EXEC_ID}-${i}`,
        activo:    true,
        anio:      2026,
        // Sin 'descripcion' — columna inexistente en el esquema
      },
      prefer: 'return=representation',
    });
    if (r.status < 200 || r.status >= 300)
      throw new Error(`insertarFixtures: curso ${i} falló HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    // Registrar inmediatamente — antes de intentar los siguientes registros
    fixtureCreados.cursos.push(cursoId);
    console.log(`  [fixture] curso ${i} insertado: ${cursoId}`);

    // Recordar el primer alumno de cada curso para el pago (FK alumno_id requerida)
    let primerAlumnoId = null;
    for (let j = 1; j <= 2; j++) {
      const alumnoId = uid();
      const rA = await supaAuth('/rest/v1/alumnos', jwt, {
        method: 'POST',
        body: {
          id:        alumnoId,
          cuenta_id: cuentaId,
          curso_id:  cursoId,
          nombres:   `FixtureAlumno${j}`,
          apellidos: `${EXEC_ID}`,
          estado:    'activo',          // TEXT — no existe columna boolean 'activo'
        },
        prefer: 'return=representation',
      });
      if (rA.status < 200 || rA.status >= 300)
        throw new Error(`insertarFixtures: alumno ${j} en curso ${i} falló HTTP ${rA.status}: ${JSON.stringify(rA.body)}`);
      fixtureCreados.alumnos.push(alumnoId);
      if (j === 1) primerAlumnoId = alumnoId;
    }
    console.log(`  [fixture] 2 alumnos insertados en curso ${i}`);

    const pagoId = uid();
    const rP = await supaAuth('/rest/v1/pagos', jwt, {
      method: 'POST',
      body: {
        id:         pagoId,
        cuenta_id:  cuentaId,
        alumno_id:  primerAlumnoId,          // FK requerida; apunta al primer alumno del curso
        monto:      10000,
        fecha:      hoy,
        medio:      'efectivo',
        estado:     'pagado',
        periodo:    `Fixture-${EXEC_ID}-${i}`, // único por run → identifica el fixture en el respaldo
        obs:        `FixturePago E12 ${EXEC_ID}`,
        // Sin 'curso_id', 'tipo', 'descripcion' — columnas inexistentes en pagos
      },
      prefer: 'return=representation',
    });
    if (rP.status < 200 || rP.status >= 300)
      throw new Error(`insertarFixtures: pago en curso ${i} falló HTTP ${rP.status}: ${JSON.stringify(rP.body)}`);
    fixtureCreados.pagos.push(pagoId);
    console.log(`  [fixture] pago insertado en curso ${i}: ${pagoId}`);
  }
}

/**
 * Elimina todos los fixtures y verifica por GET que fueron eliminados.
 * Devuelve el número de fallos (0 = limpieza completa).
 * No lanza — el caller usa el conteo para decidir.
 */
async function eliminarFixtures(jwt, cuentaId, fixtureCreados) {
  let fallos = 0;

  // Eliminar y verificar pagos
  for (const id of fixtureCreados.pagos) {
    try {
      const rDel = await supaAuth(
        `/rest/v1/pagos?id=eq.${encodeURIComponent(id)}&cuenta_id=eq.${encodeURIComponent(cuentaId)}`,
        jwt, { method: 'DELETE', prefer: '' }
      );
      if (rDel.status < 200 || rDel.status >= 300) {
        console.error(`  [cleanup] pago ${id} DELETE falló: HTTP ${rDel.status}`);
        fallos++;
        continue;
      }
      // GET de verificación
      const rGet = await supaAuth(
        `/rest/v1/pagos?id=eq.${encodeURIComponent(id)}&select=id`,
        jwt
      );
      if (rGet.status !== 200 || !Array.isArray(rGet.body)) {
        console.error(`  [cleanup] pago ${id} GET verificación falló: HTTP ${rGet.status}`);
        fallos++;
      } else if (rGet.body.length > 0) {
        console.error(`  [cleanup] pago ${id} sigue en DB después de DELETE`);
        fallos++;
      } else {
        console.log(`  [cleanup] pago ${id} eliminado ✓`);
      }
    } catch (e) {
      console.error(`  [cleanup] pago ${id} excepción: ${e.message}`);
      fallos++;
    }
  }

  // Eliminar y verificar alumnos
  for (const id of fixtureCreados.alumnos) {
    try {
      const rDel = await supaAuth(
        `/rest/v1/alumnos?id=eq.${encodeURIComponent(id)}&cuenta_id=eq.${encodeURIComponent(cuentaId)}`,
        jwt, { method: 'DELETE', prefer: '' }
      );
      if (rDel.status < 200 || rDel.status >= 300) {
        console.error(`  [cleanup] alumno ${id} DELETE falló: HTTP ${rDel.status}`);
        fallos++;
        continue;
      }
      const rGet = await supaAuth(
        `/rest/v1/alumnos?id=eq.${encodeURIComponent(id)}&select=id`,
        jwt
      );
      if (rGet.status !== 200 || !Array.isArray(rGet.body)) {
        console.error(`  [cleanup] alumno ${id} GET verificación falló: HTTP ${rGet.status}`);
        fallos++;
      } else if (rGet.body.length > 0) {
        console.error(`  [cleanup] alumno ${id} sigue en DB después de DELETE`);
        fallos++;
      } else {
        console.log(`  [cleanup] alumno ${id} eliminado ✓`);
      }
    } catch (e) {
      console.error(`  [cleanup] alumno ${id} excepción: ${e.message}`);
      fallos++;
    }
  }

  // Eliminar y verificar cursos
  for (const id of fixtureCreados.cursos) {
    try {
      const rDel = await supaAuth(
        `/rest/v1/cursos?id=eq.${encodeURIComponent(id)}&cuenta_id=eq.${encodeURIComponent(cuentaId)}`,
        jwt, { method: 'DELETE', prefer: '' }
      );
      if (rDel.status < 200 || rDel.status >= 300) {
        console.error(`  [cleanup] curso ${id} DELETE falló: HTTP ${rDel.status}`);
        fallos++;
        continue;
      }
      const rGet = await supaAuth(
        `/rest/v1/cursos?id=eq.${encodeURIComponent(id)}&select=id`,
        jwt
      );
      if (rGet.status !== 200 || !Array.isArray(rGet.body)) {
        console.error(`  [cleanup] curso ${id} GET verificación falló: HTTP ${rGet.status}`);
        fallos++;
      } else if (rGet.body.length > 0) {
        console.error(`  [cleanup] curso ${id} sigue en DB después de DELETE`);
        fallos++;
      } else {
        console.log(`  [cleanup] curso ${id} eliminado ✓`);
      }
    } catch (e) {
      console.error(`  [cleanup] curso ${id} excepción: ${e.message}`);
      fallos++;
    }
  }

  return fallos;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  E12 B5 — Playwright: Respaldo/Restauración V9');
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
    console.error('❌ Setup falló:', e.message); process.exit(3);
  }

  // fixtureCreados vive FUERA del try/finally para que el finally siempre pueda
  // limpiar lo que se haya insertado, incluso si insertarFixtures lanzó a mitad.
  const fixtureCreados = { cursos: [], alumnos: [], pagos: [] };

  let server       = null;
  let browser      = null;
  let respaldoJSON = null;
  let fallosCleanup = 0;
  // Estado compartido para el manejador único de diálogos
  const dialogState = { ultimoDialog: null };

  try {
    // ── R01: Servidor ─────────────────────────────────────────────────────
    console.log('\n[R01] Servidor HTTP local');
    server = await servirApp();
    ok('R01: servidor levantado', true);

    // ── R02: Login UI ─────────────────────────────────────────────────────
    console.log('\n[R02] Login UI');
    browser = await chromium.launch({ headless: true });
    const ctx  = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      acceptDownloads: true,   // Playwright captura descargas en un directorio temp
    });
    const page = await ctx.newPage();
    page.on('console', msg => {
      if (msg.type() === 'error') console.error(`  [browser] ${msg.text()}`);
    });
    // Un único manejador de diálogos — R08 lee dialogState.ultimoDialog, no registra otro handler
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
      ok('R02: login completado (_v9CuentaId disponible)', true);
    } catch (_) {
      ok('R02: login completado', false);
      throw new Error('Login UI no completó');
    }

    // Validar coherencia de cuenta REST ↔ UI.
    // DEBE ejecutarse ANTES del primer INSERT de fixtures.
    // Si difieren, abortar sin escribir nada en staging.
    const cuentaUI = await page.evaluate(() => window.S?._v9CuentaId ?? null);
    if (!cuentaUI) throw new Error('_v9CuentaId no disponible en window.S tras login');
    if (cuentaUI !== CUENTA_ID) {
      throw new Error(
        `Discrepancia de cuenta: REST descubrió "${CUENTA_ID}" pero la UI usó "${cuentaUI}".\n` +
        `  → Fija STAGING_CUENTA_ID=${cuentaUI} en .env para usar la misma cuenta en ambos lados.`
      );
    }
    console.log(`  Cuenta REST = Cuenta UI = ${CUENTA_ID} ✓`);

    // Insertar fixtures DESPUÉS de la validación de coherencia y DENTRO del try
    // (si falla parcialmente, el finally limpia lo que ya se insertó).
    console.log('\n[Pre] Insertar fixtures propios (2 cursos, 4 alumnos, 2 pagos)');
    await insertarFixtures(jwt, CUENTA_ID, fixtureCreados);
    console.log(`  Fixtures insertados: cursos=${fixtureCreados.cursos.length}, alumnos=${fixtureCreados.alumnos.length}, pagos=${fixtureCreados.pagos.length}`);

    // ── R03: Exportar respaldo completo ───────────────────────────────────
    // exportarDatosCompletosV9 crea un <a download="..."> y llama .click().
    // Playwright captura el evento download del navegador (no requiere parchear
    // DOM ni fetch de blob:URL — sin impacto en CSP de la app).
    console.log('\n[R03] exportarDatosCompletosV9 → waitForEvent("download")');

    await navegarConfig(page);

    let capturado = null;
    let tmpFile   = null;
    try {
      // Iniciar escucha ANTES de disparar la función — Promise.all garantiza el orden
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: T_LARGO }),
        page.evaluate(async () => {
          if (typeof exportarDatosCompletosV9 === 'function') await exportarDatosCompletosV9();
        }),
      ]);
      // Playwright guarda la descarga en un directorio temporal automáticamente
      tmpFile = path.join(os.tmpdir(), `e12-backup-${EXEC_ID}.json`);
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
        respaldoJSON = JSON.parse(capturado);
        ok('R03-b: JSON válido (parse sin error)', true);
      } catch (e) {
        ok('R03-b: JSON válido (parse sin error)', false);
        console.error('  Parse error:', e.message);
      }
    } else {
      ok('R03-b: JSON válido', false);
    }

    if (respaldoJSON) {
      ok('R03-c: version = "v9-completo"', respaldoJSON.version === 'v9-completo');
      ok('R03-d: cuentaId coincide', respaldoJSON.cuentaId === CUENTA_ID);
      ok('R03-e: campo "colecciones" presente',
        typeof respaldoJSON.colecciones === 'object' && respaldoJSON.colecciones !== null);
      console.log(`  Claves colecciones: ${Object.keys(respaldoJSON.colecciones || {}).join(', ')}`);
    } else {
      ok('R03-c: version', false);
      ok('R03-d: cuentaId', false);
      ok('R03-e: colecciones', false);
    }

    // ── R04–R07: solo si R03 obtuvo el JSON ──────────────────────────────
    if (!respaldoJSON) {
      const BLOQ = 'R03 no obtuvo JSON de respaldo';
      console.log(`\n  ⚠️  R04–R07 bloqueados — ${BLOQ}`);
      for (const lbl of [
        ...fixtureCreados.cursos.map((_, k) => `R04: curso fixture ${k+1} en respaldo`),
        'R05-a: alumnos fixture en respaldo',
        'R05-b: pagos fixture en respaldo',
        'R06-a: alumnos fixture tienen cuenta_id correcto',
        'R06-b: alumnos fixture tienen curso_id',
        'R06-c: pagos fixture tienen cuenta_id correcto',
        'R07: colecciones complementarias',
      ]) skip(lbl, BLOQ);
    } else {
      const colecciones = respaldoJSON.colecciones || {};

      // ── R04: Cursos fixture presentes en el respaldo ────────────────────
      console.log('\n[R04] Cursos fixture presentes en el respaldo (IDs exactos)');
      const cursosEnRespaldo = Array.isArray(colecciones.cursos) ? colecciones.cursos : [];
      console.log(`  Cursos en respaldo: ${cursosEnRespaldo.length}`);
      for (const cursoId of fixtureCreados.cursos) {
        const encontrado = cursosEnRespaldo.some(c => c.id === cursoId);
        console.log(`  Curso fixture ${cursoId.slice(0,8)}…: ${encontrado ? '✓' : '✗'}`);
        ok(`R04: curso fixture ${cursoId.slice(0,8)}… en respaldo`, encontrado);
      }

      // ── R05: Alumnos y pagos fixture en el respaldo ─────────────────────
      console.log('\n[R05] Alumnos y pagos fixture en el respaldo (IDs exactos)');
      const alumnosEnRespaldo = Array.isArray(colecciones.alumnos) ? colecciones.alumnos : [];
      const pagosEnRespaldo   = Array.isArray(colecciones.pagos)   ? colecciones.pagos   : [];

      let alumnosFixtureOk = true;
      for (const id of fixtureCreados.alumnos) {
        if (!alumnosEnRespaldo.some(a => a.id === id)) { alumnosFixtureOk = false; break; }
      }
      ok(`R05-a: ${fixtureCreados.alumnos.length} alumnos fixture en respaldo`, alumnosFixtureOk);

      let pagosFixtureOk = true;
      for (const id of fixtureCreados.pagos) {
        if (!pagosEnRespaldo.some(p => p.id === id)) { pagosFixtureOk = false; break; }
      }
      ok(`R05-b: ${fixtureCreados.pagos.length} pagos fixture en respaldo`, pagosFixtureOk);
      console.log(`  Alumnos en respaldo: ${alumnosEnRespaldo.length} (${fixtureCreados.alumnos.length} fixture)`);
      console.log(`  Pagos en respaldo:   ${pagosEnRespaldo.length} (${fixtureCreados.pagos.length} fixture)`);

      // ── R06: Integridad de colecciones ──────────────────────────────────
      console.log('\n[R06] Integridad: cuenta_id y curso_id en alumnos y pagos fixture');
      const alumnosFixture = alumnosEnRespaldo.filter(a => fixtureCreados.alumnos.includes(a.id));
      ok('R06-a: alumnos fixture tienen cuenta_id correcto',
        alumnosFixture.length > 0 && alumnosFixture.every(a => a.cuenta_id === CUENTA_ID));
      ok('R06-b: alumnos fixture tienen curso_id',
        alumnosFixture.length > 0 && alumnosFixture.every(a => !!a.curso_id));

      const pagosFixture = pagosEnRespaldo.filter(p => fixtureCreados.pagos.includes(p.id));
      ok('R06-c: pagos fixture tienen cuenta_id correcto',
        pagosFixture.length > 0 && pagosFixture.every(p => p.cuenta_id === CUENTA_ID));

      // ── R07: Colecciones complementarias ────────────────────────────────
      console.log('\n[R07] Colecciones complementarias presentes');
      const colsCompl = ['cuotas', 'movimientos', 'notas', 'codigos_invitacion', 'actividades', 'abonos'];
      for (const col of colsCompl) {
        const arr = colecciones[col];
        console.log(`  ${col}: ${Array.isArray(arr) ? arr.length + ' registros' : 'ausente'}`);
        ok(`R07: colección "${col}" presente`, Array.isArray(arr));
      }
    } // fin bloque respaldoJSON

    // ── R08: importarDatos en V9 bloquea ──────────────────────────────────
    // El manejador de diálogos ya está instalado (instalarManejadorDialogos).
    // No registramos un segundo handler — solo reseteamos el estado y leemos
    // lo que capturó el handler único después del timeout.
    console.log('\n[R08] importarDatos en V9 → alert bloqueante, DB sin modificar');

    dialogState.ultimoDialog = null; // reset para aislar el diálogo de R08

    const estadoAntes = await page.evaluate(() =>
      JSON.stringify((typeof DB !== 'undefined' && DB?.alumnos?.length) || 0)
    );

    await page.evaluate(() => {
      if (typeof importarDatos !== 'function') return;
      const minJson = JSON.stringify({ usuarios: [{ id: 'u-test', nombre: 'Test' }] });
      const blob = new Blob([minJson], { type: 'application/json' });
      const file = new File([blob], 'test.json', { type: 'application/json' });
      const dt = new DataTransfer();
      dt.items.add(file);
      importarDatos({ target: { files: dt.files } });
    });
    await page.waitForTimeout(1500);

    const estadoDespues = await page.evaluate(() =>
      JSON.stringify((typeof DB !== 'undefined' && DB?.alumnos?.length) || 0)
    );

    const alertTexto = dialogState.ultimoDialog?.message ?? null;
    ok('R08-a: importarDatos muestra alert en V9',
      alertTexto !== null &&
      (alertTexto.includes('V9') || alertTexto.includes('relacional') || alertTexto.includes('disponible')));
    ok('R08-b: DB.alumnos no modificado tras importarDatos V9', estadoAntes === estadoDespues);

    console.log('\n⚠️  NOTA: B5 (importación/restauración) sigue PENDIENTE de implementar.');

  } catch (e) {
    // Capturar cualquier error no controlado dentro del try (p.ej. fallo de setup,
    // discrepancia de cuenta, error de red) para que el finally pueda limpiar y
    // R09 + el resumen siempre se ejecuten.  No volver a lanzar.
    console.error(`\n❌ Error inesperado durante el test: ${e.message}`);
    // Marcar el test como fallido sin un ok() específico
    fail++;
    failures.push(`Error inesperado: ${e.message.split('\n')[0].slice(0, 120)}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server)  server.close();

    // Limpiar fixtures siempre — devuelve conteo de fallos
    if (jwt && CUENTA_ID &&
        (fixtureCreados.cursos.length + fixtureCreados.alumnos.length + fixtureCreados.pagos.length) > 0) {
      console.log(`\n[R09/finally] Eliminar fixtures (${fixtureCreados.cursos.length} cursos, ${fixtureCreados.alumnos.length} alumnos, ${fixtureCreados.pagos.length} pagos)`);
      fallosCleanup = await eliminarFixtures(jwt, CUENTA_ID, fixtureCreados).catch(e => {
        console.error('  [finally] eliminarFixtures excepción inesperada:', e.message);
        return 99;
      });
    }
  }

  // R09: limpieza verificada — falla si algún registro no fue eliminado
  const totalFixtures = fixtureCreados.cursos.length + fixtureCreados.alumnos.length + fixtureCreados.pagos.length;
  if (totalFixtures > 0)
    ok(`R09: limpieza completa (${totalFixtures} fixtures, ${fallosCleanup} fallos)`, fallosCleanup === 0);

  console.log(`\n${'─'.repeat(56)}`);
  console.log(`📊 E12 Respaldos V9: ${pass} ✅  ${fail} ❌`);
  if (failures.length) {
    console.log('\nFallas:');
    failures.forEach(f => console.log('  •', f));
  }
  process.exit(fail > 0 ? 1 : 0);
})();
