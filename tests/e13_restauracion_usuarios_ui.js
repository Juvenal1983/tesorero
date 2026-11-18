/**
 * tests/e13_restauracion_usuarios_ui.js
 *
 * Suite Playwright E13 — Restauración V9 (B5-import) + Administración usuarios (B6)
 *
 * Estrategia de fixtures:
 *   - `fixtureCreados` vive fuera del try/finally y registra cada registro
 *     insertado en tiempo real (cursos, alumnos, pagos, usuariosExternos).
 *   - Toda la preparación (inserción + browser) está dentro del try/finally.
 *   - `eliminarFixtures` hace un GET de verificación por cada registro;
 *     devuelve el número de fallos. Cualquier fallo cuenta como FAIL en el
 *     resumen final (no solo se imprime).
 *   - Si `insertarFixtures` falla a mitad, `fixtureCreados` contiene lo ya
 *     insertado y el finally lo limpia.
 *   - Los fixtures usan EXEC_ID como prefijo en campos de texto para aislamiento.
 *   - Registros ajenos (otras cuentas, otros cursos) no son tocados.
 *
 * Verifica:
 *   R01  Servidor local levantado y staging alcanzable
 *   R02  Login UI + V9 mode activo (_v9CuentaId disponible)
 *   R03  exportarDatosCompletosV9 → JSON descargado con estructura válida
 *   R04  Cursos, alumnos y pagos fixture aparecen en el respaldo (IDs exactos)
 *   R05  Límite de paginación — colecciones que alcancen 1000 filas son marcadas
 *        (exportación no puede llamarse completa sin resolver paginación)
 *   R06  Eliminar fixtures → importar vía UI → verificar restauración (GET counts)
 *   R07  Importar mismo archivo dos veces → idempotente (counts sin duplicar)
 *   R08  Importar con cuentaId ajeno → rechazado con mensaje de error (no alert bloqueante)
 *   R09  Importar con FK inválida en un lote → error reportado por tabla, estado parcial visible
 *        (nunca anuncia restauración completa si quedó parcial)
 *   R10  cuenta_id por registro — documentar el estado actual de validación
 *   R11  B6: cargarUsuariosDesdeSupabase popula DB.usuariosExternos desde usuarios_cuenta/externos
 *   R12  B6: toggleUsuarioAdmin hace PATCH en la tabla V9 correcta
 *   R13  Limpieza: todos los fixtures eliminados y verificados por GET
 *
 * Notas:
 *   - B5-import: varios POST de 100 filas NO constituyen una transacción global.
 *     Si falla un lote intermedio, los lotes anteriores ya están confirmados.
 *     R09 prueba y documenta este comportamiento.
 *   - Paginación: exportarDatosCompletosV9 trunca en 1000 filas por tabla (sin Range).
 *     R05 registra las colecciones que están cerca o en ese límite.
 *     La exportación NO puede llamarse completa para cuentas grandes hasta que se resuelva.
 *   - cuenta_id por registro: _importarDatosV9 valida el cuentaId del encabezado pero
 *     NO valida cuenta_id en cada registro individual. R10 documenta esta brecha.
 *   - Demo: este test levanta la app real (HTML+JS) contra staging, no es una maqueta.
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
const APP_PORT = 8802;   // puerto distinto de E11 (8800) y E12 (8801)
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
/** Documenta un comportamiento sin marcarlo como pase o fallo. */
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
 * Acepta el confirm() vía el manejador de diálogos ya instalado.
 * Devuelve el texto del mensaje de resultado (#export-msg) o null si no aparece.
 */
async function dispararImportacion(page, jsonContent) {
  const jsonStr = typeof jsonContent === 'string' ? jsonContent : JSON.stringify(jsonContent);
  await page.evaluate((jsonStr) => {
    if (typeof importarDatos !== 'function') return;
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const file = new File([blob], 'backup.json', { type: 'application/json' });
    const dt = new DataTransfer();
    dt.items.add(file);
    importarDatos({ target: { files: dt.files } });
  }, jsonStr);

  // Esperar a que aparezca el mensaje de resultado o un toast (máx 15 s)
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
    // Sin mensaje en DOM; revisar si hubo dialog
  }
  return msgTexto;
}

// ── Gestión de fixtures ───────────────────────────────────────────────────────

/**
 * Inserta 1 curso, 2 alumnos, 1 pago y 1 usuario externo aislados con EXEC_ID.
 * fixtureCreados se pasa por referencia y se va llenando durante la inserción.
 */
async function insertarFixtures(jwt, cuentaId, fixtureCreados) {
  const uid = () => crypto.randomUUID();
  const hoy = new Date().toISOString().slice(0, 10);

  // Curso
  const cursoId = uid();
  const rC = await supaAuth('/rest/v1/cursos', jwt, {
    method: 'POST',
    body: {
      id:        cursoId,
      cuenta_id: cuentaId,
      nombre:    `FixtureCurso-E13-${EXEC_ID}`,
      activo:    true,
      anio:      2026,
    },
    prefer: 'return=representation',
  });
  if (rC.status < 200 || rC.status >= 300)
    throw new Error(`insertarFixtures: curso falló HTTP ${rC.status}: ${JSON.stringify(rC.body)}`);
  fixtureCreados.cursos.push(cursoId);
  console.log(`  [fixture] curso insertado: ${cursoId}`);

  // 2 alumnos
  let primerAlumnoId = null;
  for (let j = 1; j <= 2; j++) {
    const alumnoId = uid();
    const rA = await supaAuth('/rest/v1/alumnos', jwt, {
      method: 'POST',
      body: {
        id:        alumnoId,
        cuenta_id: cuentaId,
        curso_id:  cursoId,
        nombres:   `FixtureAlumno${j}-E13`,
        apellidos: EXEC_ID,
        estado:    'activo',
      },
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
    body: {
      id:        pagoId,
      cuenta_id: cuentaId,
      alumno_id: primerAlumnoId,
      monto:     9900,
      fecha:     hoy,
      medio:     'efectivo',
      estado:    'pagado',
      periodo:   `FixtureE13-${EXEC_ID}`,
      obs:       `Fixture E13 ${EXEC_ID}`,
    },
    prefer: 'return=representation',
  });
  if (rP.status < 200 || rP.status >= 300)
    throw new Error(`insertarFixtures: pago falló HTTP ${rP.status}: ${JSON.stringify(rP.body)}`);
  fixtureCreados.pagos.push(pagoId);
  console.log(`  [fixture] pago insertado: ${pagoId}`);

  // 1 usuario externo (para B6)
  const usuarioExternoId = uid();
  const rU = await supaAuth('/rest/v1/usuarios_externos', jwt, {
    method: 'POST',
    body: {
      id:          usuarioExternoId,
      cuenta_id:   cuentaId,
      email:       `fixture_e13_${EXEC_ID}@test.local`,
      nombre:      `FixtureUsuarioE13-${EXEC_ID}`,
      desactivado: false,
    },
    prefer: 'return=representation',
  });
  if (rU.status < 200 || rU.status >= 300) {
    // usuarios_externos puede tener restricciones — no es fatal para la suite principal
    console.warn(`  [fixture] usuario externo no insertado HTTP ${rU.status}: ${JSON.stringify(rU.body)}`);
    console.warn(`  [fixture] R11-R12 se basarán en usuarios_cuenta (propios, si existen)`);
  } else {
    fixtureCreados.usuariosExternos.push(usuarioExternoId);
    console.log(`  [fixture] usuario externo insertado: ${usuarioExternoId}`);
  }
}

/**
 * Elimina todos los fixtures y verifica por GET que fueron eliminados.
 * Devuelve el número de fallos (0 = limpieza completa).
 * No lanza — el caller usa el conteo para decidir.
 */
async function eliminarFixtures(jwt, cuentaId, fixtureCreados) {
  let fallos = 0;

  // Eliminar y verificar usuarios_externos
  for (const id of fixtureCreados.usuariosExternos) {
    try {
      const rDel = await supaAuth(
        `/rest/v1/usuarios_externos?id=eq.${encodeURIComponent(id)}&cuenta_id=eq.${encodeURIComponent(cuentaId)}`,
        jwt, { method: 'DELETE', prefer: '' }
      );
      if (rDel.status < 200 || rDel.status >= 300) {
        console.error(`  [cleanup] usuario_externo ${id.slice(0,8)}… DELETE falló: HTTP ${rDel.status}`);
        fallos++; continue;
      }
      const rGet = await supaAuth(
        `/rest/v1/usuarios_externos?id=eq.${encodeURIComponent(id)}&select=id`,
        jwt
      );
      if (rGet.body?.length > 0) {
        console.error(`  [cleanup] usuario_externo ${id.slice(0,8)}… sigue en DB después de DELETE`);
        fallos++;
      } else {
        console.log(`  [cleanup] usuario_externo ${id.slice(0,8)}… eliminado ✓`);
      }
    } catch (e) {
      console.error(`  [cleanup] usuario_externo ${id.slice(0,8)}… excepción: ${e.message}`);
      fallos++;
    }
  }

  // Eliminar y verificar pagos
  for (const id of fixtureCreados.pagos) {
    try {
      const rDel = await supaAuth(
        `/rest/v1/pagos?id=eq.${encodeURIComponent(id)}&cuenta_id=eq.${encodeURIComponent(cuentaId)}`,
        jwt, { method: 'DELETE', prefer: '' }
      );
      if (rDel.status < 200 || rDel.status >= 300) {
        console.error(`  [cleanup] pago ${id.slice(0,8)}… DELETE falló: HTTP ${rDel.status}`);
        fallos++; continue;
      }
      const rGet = await supaAuth(
        `/rest/v1/pagos?id=eq.${encodeURIComponent(id)}&select=id`, jwt
      );
      if (rGet.body?.length > 0) {
        console.error(`  [cleanup] pago ${id.slice(0,8)}… sigue en DB después de DELETE`);
        fallos++;
      } else {
        console.log(`  [cleanup] pago ${id.slice(0,8)}… eliminado ✓`);
      }
    } catch (e) {
      console.error(`  [cleanup] pago ${id.slice(0,8)}… excepción: ${e.message}`);
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
        console.error(`  [cleanup] alumno ${id.slice(0,8)}… DELETE falló: HTTP ${rDel.status}`);
        fallos++; continue;
      }
      const rGet = await supaAuth(
        `/rest/v1/alumnos?id=eq.${encodeURIComponent(id)}&select=id`, jwt
      );
      if (rGet.body?.length > 0) {
        console.error(`  [cleanup] alumno ${id.slice(0,8)}… sigue en DB después de DELETE`);
        fallos++;
      } else {
        console.log(`  [cleanup] alumno ${id.slice(0,8)}… eliminado ✓`);
      }
    } catch (e) {
      console.error(`  [cleanup] alumno ${id.slice(0,8)}… excepción: ${e.message}`);
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
        console.error(`  [cleanup] curso ${id.slice(0,8)}… DELETE falló: HTTP ${rDel.status}`);
        fallos++; continue;
      }
      const rGet = await supaAuth(
        `/rest/v1/cursos?id=eq.${encodeURIComponent(id)}&select=id`, jwt
      );
      if (rGet.body?.length > 0) {
        console.error(`  [cleanup] curso ${id.slice(0,8)}… sigue en DB después de DELETE`);
        fallos++;
      } else {
        console.log(`  [cleanup] curso ${id.slice(0,8)}… eliminado ✓`);
      }
    } catch (e) {
      console.error(`  [cleanup] curso ${id.slice(0,8)}… excepción: ${e.message}`);
      fallos++;
    }
  }

  return fallos;
}

// ── Helpers de comparación ────────────────────────────────────────────────────

/** Cuenta registros en una tabla via REST (máx 1000 sin paginación). */
async function contarRegistros(jwt, cuentaId, tabla) {
  const r = await supaAuth(
    `/rest/v1/${tabla}?cuenta_id=eq.${encodeURIComponent(cuentaId)}&select=id`,
    jwt, { headers: { 'Prefer': 'count=exact' } }
  );
  if (r.status !== 200) return null;
  return Array.isArray(r.body) ? r.body.length : null;
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

  const fixtureCreados = { cursos: [], alumnos: [], pagos: [], usuariosExternos: [] };

  let server         = null;
  let browser        = null;
  let respaldoJSON   = null;    // capturado en R03; reutilizado en R06-R10
  let fallosCleanup  = 0;
  const dialogState  = { ultimoDialog: null };

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

    // Verificar V9_RELACIONAL activo
    const v9Activo = await page.evaluate(() =>
      typeof window.V9_RELACIONAL !== 'undefined' && window.V9_RELACIONAL === true
    );
    ok('R02-b: V9_RELACIONAL activo en la app', v9Activo);

    // Insertar fixtures DESPUÉS de verificar coherencia, DENTRO del try
    console.log('\n[Pre] Insertar fixtures propios (1 curso, 2 alumnos, 1 pago, 1 usuario_externo)');
    await insertarFixtures(jwt, CUENTA_ID, fixtureCreados);
    console.log(`  Fixtures: cursos=${fixtureCreados.cursos.length}, alumnos=${fixtureCreados.alumnos.length}, pagos=${fixtureCreados.pagos.length}, usuariosExternos=${fixtureCreados.usuariosExternos.length}`);

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
        respaldoJSON = JSON.parse(capturado);
        ok('R03-b: JSON válido (parse sin error)', true);
      } catch (e) {
        ok('R03-b: JSON válido', false);
        console.error('  Parse error:', e.message);
      }
    } else {
      ok('R03-b: JSON válido', false);
    }

    if (respaldoJSON) {
      ok('R03-c: version = "v9-completo"', respaldoJSON.version === 'v9-completo');
      ok('R03-d: cuentaId coincide con la cuenta UI', respaldoJSON.cuentaId === CUENTA_ID);
      ok('R03-e: campo "colecciones" presente',
        typeof respaldoJSON.colecciones === 'object' && respaldoJSON.colecciones !== null);

      const claves = Object.keys(respaldoJSON.colecciones || {});
      console.log(`  Claves colecciones: ${claves.join(', ')}`);

      // Verificar que la colección exportada es importable: mismo formato relacional
      const COLS_ESPERADAS = [
        'cursos','alumnos','apoderados','cuotas','planes_pago','abonos',
        'pagos','movimientos','fondo_movimientos','actividades',
        'notas','codigos_invitacion','config_cuenta',
      ];
      let todasPresentes = true;
      for (const col of COLS_ESPERADAS) {
        if (!Array.isArray(respaldoJSON.colecciones[col])) {
          console.error(`  [R03-f] colección ausente o no array: "${col}"`);
          todasPresentes = false;
        }
      }
      ok('R03-f: todas las colecciones esperadas presentes en export', todasPresentes);
    }

    // ── R04: Fixtures en el respaldo ──────────────────────────────────────────
    console.log('\n[R04] Fixtures propios aparecen en el respaldo (IDs exactos)');
    if (!respaldoJSON) {
      skip('R04', 'R03 no obtuvo JSON');
    } else {
      const cols = respaldoJSON.colecciones || {};

      // Cursos
      const cursosResp = Array.isArray(cols.cursos) ? cols.cursos : [];
      for (const id of fixtureCreados.cursos) {
        ok(`R04-a: curso fixture ${id.slice(0,8)}… en respaldo`,
          cursosResp.some(c => c.id === id));
      }

      // Alumnos
      const alumnosResp = Array.isArray(cols.alumnos) ? cols.alumnos : [];
      ok(`R04-b: ${fixtureCreados.alumnos.length} alumnos fixture en respaldo`,
        fixtureCreados.alumnos.every(id => alumnosResp.some(a => a.id === id)));

      // Pagos
      const pagosResp = Array.isArray(cols.pagos) ? cols.pagos : [];
      ok(`R04-c: ${fixtureCreados.pagos.length} pagos fixture en respaldo`,
        fixtureCreados.pagos.every(id => pagosResp.some(p => p.id === id)));

      // cuenta_id en registros fixture (integridad)
      const alumnosFixture = alumnosResp.filter(a => fixtureCreados.alumnos.includes(a.id));
      ok('R04-d: alumnos fixture tienen cuenta_id correcto',
        alumnosFixture.length > 0 && alumnosFixture.every(a => a.cuenta_id === CUENTA_ID));
      ok('R04-e: alumnos fixture tienen curso_id',
        alumnosFixture.length > 0 && alumnosFixture.every(a => !!a.curso_id));

      const pagosFixture = pagosResp.filter(p => fixtureCreados.pagos.includes(p.id));
      ok('R04-f: pagos fixture tienen cuenta_id correcto',
        pagosFixture.length > 0 && pagosFixture.every(p => p.cuenta_id === CUENTA_ID));

      // Verificar compatibilidad de campos críticos: planes_pago y abonos
      const planesResp = Array.isArray(cols.planes_pago) ? cols.planes_pago : [];
      const abonosResp = Array.isArray(cols.abonos)      ? cols.abonos      : [];
      if (planesResp.length > 0) {
        const primerPlan = planesResp[0];
        nota('R04-g: campos de planes_pago',
          `${Object.keys(primerPlan).join(', ')} (${planesResp.length} registros)`);
        ok('R04-g: planes_pago tiene campo cuenta_id',
          'cuenta_id' in primerPlan);
      } else {
        nota('R04-g: planes_pago', 'vacío en staging (OK para esta cuenta fixture)');
      }
      if (abonosResp.length > 0) {
        const primerAbono = abonosResp[0];
        nota('R04-h: campos de abonos',
          `${Object.keys(primerAbono).join(', ')} (${abonosResp.length} registros)`);
        ok('R04-h: abonos tiene campo cuenta_id', 'cuenta_id' in primerAbono);
      } else {
        nota('R04-h: abonos', 'vacío en staging (OK)');
      }
    }

    // ── R05: Límite de paginación ──────────────────────────────────────────────
    console.log('\n[R05] Límite de paginación: 1000 filas por tabla');
    console.log('  NOTA: exportarDatosCompletosV9 NO implementa paginación.');
    console.log('  Una tabla con ≥ 1000 filas devolvería solo las primeras 1000 sin aviso.');
    if (!respaldoJSON) {
      skip('R05', 'R03 no obtuvo JSON');
    } else {
      const cols = respaldoJSON.colecciones || {};
      let algunaAlLimite = false;
      for (const [nombre, arr] of Object.entries(cols)) {
        if (Array.isArray(arr)) {
          const n = arr.length;
          if (n >= 1000) {
            console.error(`  ⚠️  [R05] "${nombre}" tiene ${n} registros — posible truncación!`);
            algunaAlLimite = true;
          } else {
            console.log(`  ${nombre}: ${n} registros${n >= 900 ? ' ⚠️  (cerca del límite)' : ''}`);
          }
        }
      }
      // No es un fallo del test sino documentación del estado
      nota('R05: paginación pendiente',
        algunaAlLimite
          ? 'UNA O MÁS COLECCIONES ALCANZAN 1000 FILAS — exportación potencialmente incompleta'
          : 'ninguna colección alcanza el límite en staging (cuentas pequeñas)');
      ok('R05: ninguna colección reporta 1000 filas exactos (staging fixture)', !algunaAlLimite);
    }

    // ── R06: Eliminar fixtures → importar → verificar restauración ────────────
    console.log('\n[R06] Eliminar fixtures → importar vía UI → verificar restauración');
    if (!respaldoJSON || fixtureCreados.cursos.length === 0) {
      skip('R06', 'requiere respaldoJSON y fixtures creados');
      skip('R07', 'requiere R06 exitoso');
    } else {
      // Contar antes de eliminar
      const countAntes = {
        alumnos: await contarRegistros(jwt, CUENTA_ID, 'alumnos'),
        pagos:   await contarRegistros(jwt, CUENTA_ID, 'pagos'),
      };
      console.log(`  Antes de eliminar: alumnos=${countAntes.alumnos}, pagos=${countAntes.pagos}`);

      // Eliminar solo los fixtures de este run (sin tocar otros registros)
      let errorEliminar = null;
      for (const id of [...fixtureCreados.pagos]) {
        const r = await supaAuth(
          `/rest/v1/pagos?id=eq.${encodeURIComponent(id)}&cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}`,
          jwt, { method: 'DELETE', prefer: '' }
        );
        if (r.status >= 300) { errorEliminar = `pago ${id.slice(0,8)} HTTP ${r.status}`; break; }
      }
      for (const id of [...fixtureCreados.alumnos]) {
        if (errorEliminar) break;
        const r = await supaAuth(
          `/rest/v1/alumnos?id=eq.${encodeURIComponent(id)}&cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}`,
          jwt, { method: 'DELETE', prefer: '' }
        );
        if (r.status >= 300) { errorEliminar = `alumno ${id.slice(0,8)} HTTP ${r.status}`; break; }
      }
      // Nota: el curso NO se elimina aquí para mantener FK válida en abonos/cuotas si las hay.
      // Solo alumnos y pagos se eliminan para simular "brecha a restaurar".

      if (errorEliminar) {
        ok('R06-a: fixtures eliminados para crear brecha', false);
        console.error(`  Error en eliminación: ${errorEliminar}`);
        skip('R06-b/c/d', 'eliminación previa falló');
        skip('R07', 'requiere R06 exitoso');
      } else {
        const countTras = {
          alumnos: await contarRegistros(jwt, CUENTA_ID, 'alumnos'),
          pagos:   await contarRegistros(jwt, CUENTA_ID, 'pagos'),
        };
        console.log(`  Tras eliminar: alumnos=${countTras.alumnos}, pagos=${countTras.pagos}`);
        ok('R06-a: alumnos fixture eliminados (reducción esperada)',
          countAntes.alumnos !== null && countTras.alumnos !== null &&
          countTras.alumnos === countAntes.alumnos - fixtureCreados.alumnos.length);
        ok('R06-b: pagos fixture eliminados (reducción esperada)',
          countAntes.pagos !== null && countTras.pagos !== null &&
          countTras.pagos === countAntes.pagos - fixtureCreados.pagos.length);

        // Importar vía UI
        console.log('  Disparando importación vía UI…');
        dialogState.ultimoDialog = null;
        await navegarConfig(page);
        const msgImport = await dispararImportacion(page, respaldoJSON);
        console.log(`  Mensaje UI: ${msgImport || '(vacío)'}`);

        // Verificar restauración via GET
        const countDespues = {
          alumnos: await contarRegistros(jwt, CUENTA_ID, 'alumnos'),
          pagos:   await contarRegistros(jwt, CUENTA_ID, 'pagos'),
        };
        console.log(`  Después de importar: alumnos=${countDespues.alumnos}, pagos=${countDespues.pagos}`);

        ok('R06-c: alumnos restaurados (count recuperado)',
          countDespues.alumnos !== null && countDespues.alumnos >= countAntes.alumnos);
        ok('R06-d: pagos restaurados (count recuperado)',
          countDespues.pagos !== null && countDespues.pagos >= countAntes.pagos);

        const msgOk = msgImport &&
          (msgImport.includes('completa') || msgImport.includes('restaurado') || msgImport.includes('✅'));
        const msgParcial = msgImport &&
          (msgImport.includes('errores') || msgImport.includes('⚠️'));
        ok('R06-e: UI muestra resultado de importación (completo o parcial)',
          !!(msgOk || msgParcial));
        if (msgParcial) {
          nota('R06-e', 'importación fue parcial — revisar detalles del mensaje');
        }

        // ── R07: Idempotencia ─────────────────────────────────────────────────
        console.log('\n[R07] Importar mismo archivo dos veces → idempotente');
        const countAntes2 = {
          alumnos: await contarRegistros(jwt, CUENTA_ID, 'alumnos'),
          pagos:   await contarRegistros(jwt, CUENTA_ID, 'pagos'),
        };
        dialogState.ultimoDialog = null;
        await navegarConfig(page);
        const msgImport2 = await dispararImportacion(page, respaldoJSON);
        console.log(`  Mensaje UI segunda importación: ${msgImport2 || '(vacío)'}`);

        const countDespues2 = {
          alumnos: await contarRegistros(jwt, CUENTA_ID, 'alumnos'),
          pagos:   await contarRegistros(jwt, CUENTA_ID, 'pagos'),
        };
        console.log(`  Tras segunda importación: alumnos=${countDespues2.alumnos}, pagos=${countDespues2.pagos}`);

        ok('R07-a: alumnos no se duplican en segunda importación',
          countAntes2.alumnos !== null && countDespues2.alumnos === countAntes2.alumnos);
        ok('R07-b: pagos no se duplican en segunda importación',
          countAntes2.pagos !== null && countDespues2.pagos === countAntes2.pagos);

        // Alumnos fixture siguen existiendo con sus IDs
        for (const id of fixtureCreados.alumnos) {
          const r = await supaAuth(
            `/rest/v1/alumnos?id=eq.${encodeURIComponent(id)}&select=id`, jwt
          );
          ok(`R07-c: alumno fixture ${id.slice(0,8)}… existe tras segunda importación`,
            Array.isArray(r.body) && r.body.length === 1);
        }
      }
    }

    // ── R08: cuentaId ajeno → rechazado ───────────────────────────────────────
    console.log('\n[R08] Importar con cuentaId ajeno → rechazado con mensaje (no alert)');
    if (!respaldoJSON) {
      skip('R08', 'requiere respaldoJSON');
    } else {
      const backupAjeno = JSON.parse(JSON.stringify(respaldoJSON));
      backupAjeno.cuentaId = 'cuenta-ajena-00000000-0000-0000-0000-000000000000';

      dialogState.ultimoDialog = null;
      await navegarConfig(page);
      const msgAjeno = await dispararImportacion(page, backupAjeno);
      console.log(`  Mensaje UI: ${msgAjeno || '(vacío)'}`);

      // En V9, el rechazo debe aparecer en #export-msg, no en un alert bloqueante
      const rechazadoEnMsg = msgAjeno &&
        (msgAjeno.includes('otra cuenta') || msgAjeno.includes('ajeno') ||
         msgAjeno.includes('cuentaId') || msgAjeno.includes('❌'));
      const rechazadoEnAlert = dialogState.ultimoDialog?.message?.includes('ajena') ||
                               dialogState.ultimoDialog?.message?.includes('otra cuenta');
      ok('R08-a: importación con cuentaId ajeno es rechazada',
        rechazadoEnMsg || rechazadoEnAlert);
      ok('R08-b: rechazo aparece como mensaje UI (no alert bloqueante en V9)',
        rechazadoEnMsg && !rechazadoEnAlert);
      if (!rechazadoEnMsg && rechazadoEnAlert)
        nota('R08', 'rechazo via alert en V9 — se esperaba mensaje en DOM');
    }

    // ── R09: FK inválida en un lote → error por tabla, sin anuncio total ──────
    console.log('\n[R09] Lote con FK inválida → error reportado, sin anuncio de restauración completa');
    console.log('  NOTA: En _b5UpsertColeccion, si falla un chunk, los chunks anteriores');
    console.log('  ya están confirmados en Supabase (cada POST es transacción independiente).');
    if (!respaldoJSON) {
      skip('R09', 'requiere respaldoJSON');
    } else {
      // Crear backup con alumno que tiene FK inválida (curso_id inexistente)
      const backupCorrupto = JSON.parse(JSON.stringify(respaldoJSON));
      const cursoFalsoId = crypto.randomUUID();
      backupCorrupto.colecciones.alumnos.push({
        id:        crypto.randomUUID(),
        cuenta_id: CUENTA_ID,
        curso_id:  cursoFalsoId,  // FK a un curso que no existe → violación FK
        nombres:   `FixtureCorrupto-R09`,
        apellidos: EXEC_ID,
        estado:    'activo',
      });

      dialogState.ultimoDialog = null;
      await navegarConfig(page);
      const msgCorrupto = await dispararImportacion(page, backupCorrupto);
      console.log(`  Mensaje UI: ${msgCorrupto || '(vacío)'}`);

      // La UI debe reportar el error, no anunciar restauración completa
      const anuncia_completa = msgCorrupto && msgCorrupto.includes('completa') && !msgCorrupto.includes('⚠️');
      const reporta_error    = msgCorrupto && (msgCorrupto.includes('⚠️') || msgCorrupto.includes('error') || msgCorrupto.includes('Error'));
      ok('R09-a: error de FK es reportado en la UI', reporta_error);
      ok('R09-b: UI NO anuncia restauración completa cuando hay error', !anuncia_completa);
      nota('R09-c: comportamiento de lotes parciales',
        'Si la FK inválida está en chunk posterior a registros válidos, los anteriores ya fueron confirmados.');
    }

    // ── R10: Validación cuenta_id por registro ────────────────────────────────
    console.log('\n[R10] Validación de cuenta_id por registro (documentación de estado actual)');
    console.log('  _importarDatosV9 valida backup.cuentaId (encabezado) pero NO valida');
    console.log('  cuenta_id en cada registro individual antes del upsert.');
    console.log('  Un registro con cuenta_id manipulado podría upsertarse en otra cuenta');
    console.log('  si la RLS lo permite (en staging: RLS previene cross-account por es_dueno).');
    nota('R10', 'Brecha documentada: validación por-registro pendiente de implementar en _importarDatosV9');

    if (respaldoJSON && CUENTA_ID) {
      // Verificar con un GET directo que los fixture tienen cuenta_id correcto en DB
      // después de la restauración (no confiamos solo en el encabezado del JSON)
      let cuentaIdOk = true;
      for (const id of fixtureCreados.alumnos) {
        const r = await supaAuth(
          `/rest/v1/alumnos?id=eq.${encodeURIComponent(id)}&select=id,cuenta_id`, jwt
        );
        if (!Array.isArray(r.body) || r.body.length === 0) continue;
        if (r.body[0].cuenta_id !== CUENTA_ID) { cuentaIdOk = false; break; }
      }
      ok('R10: alumnos fixture tienen cuenta_id correcto en DB (verificación GET)', cuentaIdOk);
    } else {
      skip('R10', 'requiere fixtures y respaldo');
    }

    // ── R11: B6 — cargarUsuariosDesdeSupabase ─────────────────────────────────
    console.log('\n[R11] B6: cargarUsuariosDesdeSupabase popula DB.usuariosExternos');
    if (!v9Activo) {
      skip('R11', 'V9_RELACIONAL no activo');
    } else {
      // Navegar a sección de administración para disparar carga
      await page.evaluate(() => { if (typeof go === 'function') go('config'); });
      await page.waitForTimeout(500);

      // Forzar recarga de usuarios
      await page.evaluate(async () => {
        if (typeof cargarUsuariosDesdeSupabase === 'function')
          await cargarUsuariosDesdeSupabase(true);
      });
      await page.waitForTimeout(2000);

      const usuariosExternosEnDB = await page.evaluate(() =>
        Array.isArray(window.DB?.usuariosExternos) ? window.DB.usuariosExternos.length : -1
      );
      console.log(`  DB.usuariosExternos.length = ${usuariosExternosEnDB}`);
      ok('R11-a: DB.usuariosExternos es un array después de cargarUsuariosDesdeSupabase',
        usuariosExternosEnDB >= 0);

      if (fixtureCreados.usuariosExternos.length > 0) {
        const idFixtureUser = fixtureCreados.usuariosExternos[0];
        const encontrado = await page.evaluate((id) =>
          Array.isArray(window.DB?.usuariosExternos) &&
          window.DB.usuariosExternos.some(u => u.id === id),
          idFixtureUser
        );
        ok(`R11-b: usuario externo fixture ${idFixtureUser.slice(0,8)}… aparece en DB.usuariosExternos`,
          encontrado);
        if (encontrado) {
          const v9Tabla = await page.evaluate((id) => {
            const u = window.DB?.usuariosExternos?.find(u => u.id === id);
            return u ? u._v9Tabla : null;
          }, idFixtureUser);
          ok('R11-c: usuario externo fixture tiene _v9Tabla asignado', !!v9Tabla);
          console.log(`  _v9Tabla del fixture: ${v9Tabla}`);
        }
      } else {
        nota('R11-b', 'fixture de usuario_externo no fue insertado — verificando con usuarios existentes');
        const tieneTabla = await page.evaluate(() =>
          Array.isArray(window.DB?.usuariosExternos) &&
          window.DB.usuariosExternos.length > 0 &&
          !!window.DB.usuariosExternos[0]._v9Tabla
        );
        ok('R11-b: usuarios existentes tienen _v9Tabla asignado', tieneTabla);
      }
    }

    // ── R12: B6 — toggleUsuarioAdmin hace PATCH en la tabla correcta ──────────
    console.log('\n[R12] B6: toggleUsuarioAdmin hace PATCH en la tabla V9 correcta');
    if (!v9Activo) {
      skip('R12', 'V9_RELACIONAL no activo');
    } else {
      // Usar el fixture de usuario externo si está disponible
      const targetUserId = fixtureCreados.usuariosExternos.length > 0
        ? fixtureCreados.usuariosExternos[0]
        : null;

      if (!targetUserId) {
        skip('R12', 'requiere usuario externo fixture (no fue insertado)');
      } else {
        // Estado inicial de desactivado
        const rAntes = await supaAuth(
          `/rest/v1/usuarios_externos?id=eq.${encodeURIComponent(targetUserId)}&select=id,desactivado`,
          jwt
        );
        const desactivadoAntes = rAntes.body?.[0]?.desactivado ?? null;
        console.log(`  Estado inicial desactivado=${desactivadoAntes}`);

        // Disparar toggleUsuarioAdmin desde la UI
        const toggleOk = await page.evaluate(async (uid) => {
          if (typeof toggleUsuarioAdmin !== 'function') return false;
          try {
            await toggleUsuarioAdmin(uid);
            return true;
          } catch(e) {
            console.error('[R12] toggleUsuarioAdmin error:', e.message);
            return false;
          }
        }, targetUserId);
        ok('R12-a: toggleUsuarioAdmin ejecutado sin excepción', toggleOk);

        await page.waitForTimeout(1500);

        // Verificar que el PATCH llegó a Supabase
        const rDespues = await supaAuth(
          `/rest/v1/usuarios_externos?id=eq.${encodeURIComponent(targetUserId)}&select=id,desactivado`,
          jwt
        );
        const desactivadoDespues = rDespues.body?.[0]?.desactivado ?? null;
        console.log(`  Estado después de toggle desactivado=${desactivadoDespues}`);

        ok('R12-b: estado desactivado cambió en DB (PATCH V9 efectivo)',
          desactivadoDespues !== null && desactivadoDespues !== desactivadoAntes);
        ok('R12-c: tabla correcta — usuarios_externos (fixture externo)',
          desactivadoDespues !== desactivadoAntes); // implícito si cambió en la tabla correcta

        // Revertir para dejar limpio
        if (desactivadoDespues !== desactivadoAntes) {
          await supaAuth(
            `/rest/v1/usuarios_externos?id=eq.${encodeURIComponent(targetUserId)}&cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}`,
            jwt, {
              method: 'PATCH',
              body: { desactivado: desactivadoAntes },
              prefer: 'return=minimal',
            }
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

    // ── R13: Limpieza ─────────────────────────────────────────────────────────
    const totalFixtures =
      fixtureCreados.cursos.length +
      fixtureCreados.alumnos.length +
      fixtureCreados.pagos.length +
      fixtureCreados.usuariosExternos.length;

    if (jwt && CUENTA_ID && totalFixtures > 0) {
      console.log(`\n[R13/finally] Eliminar todos los fixtures (${totalFixtures} registros)`);
      fallosCleanup = await eliminarFixtures(jwt, CUENTA_ID, fixtureCreados).catch(e => {
        console.error('  [finally] eliminarFixtures excepción inesperada:', e.message);
        return 99;
      });
    }
  }

  // R13 se ejecuta siempre — falla si algún fixture no fue eliminado
  const totalFixtures =
    fixtureCreados.cursos.length +
    fixtureCreados.alumnos.length +
    fixtureCreados.pagos.length +
    fixtureCreados.usuariosExternos.length;

  if (totalFixtures > 0)
    ok(`R13: limpieza completa (${totalFixtures} fixtures, ${fallosCleanup} fallos)`, fallosCleanup === 0);

  // ── Resumen ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`📊 E13 Restauración + Usuarios V9: ${pass} ✅  ${fail} ❌`);
  console.log('\nPendientes conocidos (fuera de esta suite):');
  console.log('  • Paginación: exportarDatosCompletosV9 trunca en 1000 filas — bloquea publicación');
  console.log('  • Validación cuenta_id por-registro en _importarDatosV9 (brecha documentada R10)');
  console.log('  • Restauración de sesión / recordar acceso (sin implementar en V9)');
  console.log('  • Comparación funcional completa con app original');
  if (failures.length) {
    console.log('\nFallas:');
    failures.forEach(f => console.log('  •', f));
  }
  process.exit(fail > 0 ? 1 : 0);
})();
