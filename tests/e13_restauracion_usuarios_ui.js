/**
 * tests/e13_restauracion_usuarios_ui.js
 *
 * Suite Playwright E13 — Restauración V9 (B5-import) + Administración usuarios (B6)
 *
 * Estrategia de fixtures:
 *   - Fixture propio: 1 curso, 1 cuota, 2 alumnos, 1 plan_pago con 2 abonos,
 *     1 pago directo, 1 usuario_externo. Se crean al inicio, se limpian al final.
 *   - `respaldoFixture` se construye SOLO con esos registros y sus dependencias;
 *     R06/R07/R09/R10 no reimportan el respaldo completo de la cuenta.
 *   - `dispararImportacion` espera la señal TERMINAL del DOM (✅/⚠️/❌), no el ⏳.
 *   - `eliminarFixtures` exige HTTP 200 + body array + length === 0 en cada GET.
 *   - Si un fixture no puede crearse los tests dependientes se bloquean y se cuentan.
 *   - Producción excluida.
 *
 * Tests:
 *   R01  Servidor local levantado y staging alcanzable
 *   R02  Login UI + V9_RELACIONAL activo (binding real, no window.V9_RELACIONAL en módulo)
 *   R03  exportarDatosCompletosV9 → JSON descargado con estructura válida
 *   R04  Cursos, cuotas, alumnos, planes_pago, abonos y pagos fixture en el respaldo
 *   R04x planes_pago y abonos exportados con campos SQL (snake_case) o normalizados
 *   R05  Límite de paginación (1000 filas) documentado — colecciones que lo alcancen
 *   R06  Eliminar fixture → importar respaldo-fixture → GET por ID exacto; completo ó error
 *   R07  Importar mismo respaldo-fixture segunda vez → idempotente (counts exactos)
 *   R08  Importar con cuentaId ajeno en encabezado → rechazado con mensaje UI
 *   R09  Registro con cuenta_id ajeno en lote → guardia por-registro cancela antes de escribir
 *   R10  FK inválida → mensaje terminal de error en UI (no vacío, no "completa")
 *   R11  B6: cargarUsuariosDesdeSupabase popula DB.usuariosExternos (binding real, no window.DB)
 *   R12  B6: toggleUsuarioAdmin hace PATCH en la tabla V9 correcta
 *   R13  Limpieza: todos los fixtures eliminados, GET exige HTTP 200 + array + length 0
 *
 * Pendientes (fuera de esta suite):
 *   - Paginación real (exportar >1000 filas sin truncar) — bloquea publicación
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
 *
 * ESPERA EL MENSAJE TERMINAL: aguarda hasta que #export-msg contenga un
 * texto que empiece con ✅, ⚠️ o ❌ (no ⏳). Timeout: 30 s.
 *
 * Devuelve el texto del mensaje terminal, o null si no aparece en el plazo.
 */
async function dispararImportacion(page, jsonContent) {
  const jsonStr = typeof jsonContent === 'string' ? jsonContent : JSON.stringify(jsonContent);

  // Limpiar mensaje previo para detectar el nuevo limpiamente
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

  // Esperar mensaje TERMINAL (✅ / ⚠️ / ❌) — no el ⏳ de inicio
  let msgTexto = null;
  try {
    await page.waitForFunction(() => {
      const el = document.getElementById('export-msg');
      if (!el || el.style.display === 'none') return false;
      const txt = el.innerText.trim();
      if (!txt) return false;
      // ⏳ es el mensaje de progreso, no terminal; esperar reemplazo
      if (txt.startsWith('⏳')) return false;
      return true;
    }, { timeout: 30_000 });
    msgTexto = await page.evaluate(() => {
      const el = document.getElementById('export-msg');
      return el ? el.innerText.trim() : null;
    });
  } catch (_) {
    // Sin mensaje terminal en DOM tras 30 s
    // Intentar leer lo que haya (podría ser ⏳ o vacío)
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
 * Inserta fixture completo:
 *   1 curso, 1 cuota, 2 alumnos, 1 plan_pago (con 2 abonos), 1 pago, 1 usuario_externo
 *
 * fixtureCreados se llena en tiempo real (por referencia).
 * Lanza si falla curso/cuota/alumnos/pago (prerequisito para R06-R10).
 * Para plan_pago, abonos y usuario_externo: registra error y no lanza (R11-R12 se bloquean).
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

  // Cuota para ese curso (necesaria como FK para planes_pago)
  const cuotaId = uid();
  const rQ = await supaAuth('/rest/v1/cuotas', jwt, {
    method: 'POST',
    body: {
      id: cuotaId, cuenta_id: cuentaId, curso_id: cursoId,
      nombre: `FixtureCuota-E13-${EXEC_ID}`, monto: 10000, activa: true,
    },
    prefer: 'return=representation',
  });
  if (rQ.status < 200 || rQ.status >= 300)
    throw new Error(`insertarFixtures: cuota falló HTTP ${rQ.status}: ${JSON.stringify(rQ.body)}`);
  fixtureCreados.cuotas.push(cuotaId);
  console.log(`  [fixture] cuota ${cuotaId.slice(0,8)}… insertada`);

  // 2 alumnos
  let primerAlumnoId = null;
  for (let j = 1; j <= 2; j++) {
    const alumnoId = uid();
    const rA = await supaAuth('/rest/v1/alumnos', jwt, {
      method: 'POST',
      body: {
        id: alumnoId, cuenta_id: cuentaId, curso_id: cursoId,
        nombres: `FixtureAlumno${j}-E13`, apellidos: EXEC_ID, estado: 'activo',
      },
      prefer: 'return=representation',
    });
    if (rA.status < 200 || rA.status >= 300)
      throw new Error(`insertarFixtures: alumno ${j} falló HTTP ${rA.status}: ${JSON.stringify(rA.body)}`);
    fixtureCreados.alumnos.push(alumnoId);
    if (j === 1) primerAlumnoId = alumnoId;
  }
  console.log(`  [fixture] 2 alumnos insertados`);

  // Plan de pago para el primer alumno (FK: alumno_id + cuota_id)
  const planId = uid();
  const rPl = await supaAuth('/rest/v1/planes_pago', jwt, {
    method: 'POST',
    body: {
      id: planId, cuenta_id: cuentaId, alumno_id: primerAlumnoId,
      cuota_id: cuotaId, monto_total: 10000, activo: true,
      periodo: `FixtureE13-${EXEC_ID}`,
    },
    prefer: 'return=representation',
  });
  if (rPl.status >= 200 && rPl.status < 300) {
    fixtureCreados.planes_pago.push(planId);
    console.log(`  [fixture] plan_pago ${planId.slice(0,8)}… insertado`);

    // 2 abonos para ese plan
    for (let j = 1; j <= 2; j++) {
      const abonoId = uid();
      const rAb = await supaAuth('/rest/v1/abonos', jwt, {
        method: 'POST',
        body: {
          id: abonoId, cuenta_id: cuentaId, alumno_id: primerAlumnoId,
          cuota_id: cuotaId, plan_id: planId,
          monto: 5000, fecha: hoy, pagado: false, estado: 'registrado',
        },
        prefer: 'return=representation',
      });
      if (rAb.status >= 200 && rAb.status < 300) {
        fixtureCreados.abonos.push(abonoId);
      } else {
        console.warn(`  [fixture] abono ${j} no creado: HTTP ${rAb.status}`);
      }
    }
    console.log(`  [fixture] ${fixtureCreados.abonos.length} abono(s) insertado(s)`);
  } else {
    fixtureCreados.errorPlanPago = `HTTP ${rPl.status}: ${JSON.stringify(rPl.body).slice(0, 120)}`;
    console.warn(`  [fixture] plan_pago NO creado: ${fixtureCreados.errorPlanPago}`);
  }

  // Pago directo
  const pagoId = uid();
  const rPg = await supaAuth('/rest/v1/pagos', jwt, {
    method: 'POST',
    body: {
      id: pagoId, cuenta_id: cuentaId, alumno_id: primerAlumnoId,
      monto: 9900, fecha: hoy, medio: 'efectivo', estado: 'pagado',
      periodo: `FixtureE13-${EXEC_ID}`, obs: `Fixture E13 ${EXEC_ID}`,
    },
    prefer: 'return=representation',
  });
  if (rPg.status < 200 || rPg.status >= 300)
    throw new Error(`insertarFixtures: pago falló HTTP ${rPg.status}: ${JSON.stringify(rPg.body)}`);
  fixtureCreados.pagos.push(pagoId);
  console.log(`  [fixture] pago ${pagoId.slice(0,8)}… insertado`);

  // Usuario externo (para B6) — no fatal si falla
  const ueId = uid();
  const rU = await supaAuth('/rest/v1/usuarios_externos', jwt, {
    method: 'POST',
    body: {
      id: ueId, cuenta_id: cuentaId,
      email: `fixture_e13_${EXEC_ID}@test.local`,
      nombre: `FixtureUsuarioE13-${EXEC_ID}`, desactivado: false,
    },
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
 * Construye un respaldo mínimo con SOLO los registros fixture.
 * Extrae filas del respaldo completo filtrando por IDs fixture.
 * Los planes_pago y abonos se incluyen en snake_case (columnas SQL),
 * porque la normalización se hace en _b5UpsertColeccion pero también
 * queremos verificar que el respaldo completo los exporta correctamente.
 */
function construirRespaldoFixture(cuentaId, fixtureCreados, respaldoCompleto) {
  const cols = respaldoCompleto?.colecciones || {};
  const cursoIds  = new Set(fixtureCreados.cursos);
  const cuotaIds  = new Set(fixtureCreados.cuotas);
  const alumnoIds = new Set(fixtureCreados.alumnos);
  const planIds   = new Set(fixtureCreados.planes_pago);
  const abonoIds  = new Set(fixtureCreados.abonos);
  const pagoIds   = new Set(fixtureCreados.pagos);

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
 * Devuelve número de fallos.
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
        console.error(`  [cleanup] ${tabla} ${id.slice(0,8)}… DELETE HTTP ${rDel.status}`);
        fallos++; return;
      }
      const rGet = await supaAuth(`/rest/v1/${tabla}?id=eq.${encodeURIComponent(id)}&select=id`, jwt);
      if (rGet.status !== 200) {
        console.error(`  [cleanup] ${tabla} ${id.slice(0,8)}… GET verificación HTTP ${rGet.status}`);
        fallos++;
      } else if (!Array.isArray(rGet.body)) {
        console.error(`  [cleanup] ${tabla} ${id.slice(0,8)}… GET no devolvió array`);
        fallos++;
      } else if (rGet.body.length > 0) {
        console.error(`  [cleanup] ${tabla} ${id.slice(0,8)}… sigue en DB`);
        fallos++;
      } else {
        console.log(`  [cleanup] ${tabla} ${id.slice(0,8)}… eliminado ✓`);
      }
    } catch (e) {
      console.error(`  [cleanup] ${tabla} ${id.slice(0,8)}… excepción: ${e.message}`);
      fallos++;
    }
  }

  // Orden FK-safe inverso
  for (const id of fixtureCreados.usuariosExternos) await eliminarYVerificar('usuarios_externos', id);
  for (const id of fixtureCreados.abonos)           await eliminarYVerificar('abonos',            id);
  for (const id of fixtureCreados.planes_pago)       await eliminarYVerificar('planes_pago',       id);
  for (const id of fixtureCreados.pagos)             await eliminarYVerificar('pagos',             id);
  for (const id of fixtureCreados.alumnos)           await eliminarYVerificar('alumnos',           id);
  for (const id of fixtureCreados.cuotas)            await eliminarYVerificar('cuotas',            id);
  for (const id of fixtureCreados.cursos)            await eliminarYVerificar('cursos',            id);
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

  const fixtureCreados = {
    cursos: [], cuotas: [], alumnos: [], planes_pago: [], abonos: [], pagos: [],
    usuariosExternos: [],
    errorPlanPago: null, errorUsuarioExterno: null,
  };

  let server           = null;
  let browser          = null;
  let respaldoCompleto = null;
  let respaldoFixture  = null;
  let fallosCleanup    = 0;
  const dialogState    = { ultimoDialog: null };

  try {
    // ── R01 ───────────────────────────────────────────────────────────────────
    console.log('\n[R01] Servidor HTTP local (app real contra staging)');
    server = await servirApp();
    ok('R01: servidor levantado', true);

    // ── R02 ───────────────────────────────────────────────────────────────────
    console.log('\n[R02] Login UI + V9_RELACIONAL activo');
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
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

    // R02-b: V9_RELACIONAL — config.js lo declara como `const` a nivel de script,
    // por lo que está en window en la mayoría de entornos, pero lo evaluamos
    // directamente (no como propiedad de window) para coincidir con el scope de los módulos.
    const v9Activo = await page.evaluate(() => {
      try {
        // Intentar acceder como variable de scope (const declarada en script)
        // eslint-disable-next-line no-undef
        return typeof V9_RELACIONAL !== 'undefined' && V9_RELACIONAL === true;
      } catch(_) { return false; }
    });
    ok('R02-b: V9_RELACIONAL activo en la app', v9Activo);
    if (!v9Activo) {
      // Diagnóstico: verificar que las funciones V9 existen aunque la variable
      // no sea accesible desde el contexto evaluate
      const tieneExport = await page.evaluate(
        () => typeof exportarDatosCompletosV9 === 'function'
      );
      nota('R02-b diagnóstico', `V9_RELACIONAL no encontrado en scope evaluate; exportarDatosCompletosV9 existe: ${tieneExport}`);
      nota('R02-b', 'B6 NO se omite por esto — se probará independientemente');
    }

    // Insertar fixtures
    console.log('\n[Pre] Insertar fixtures propios');
    await insertarFixtures(jwt, CUENTA_ID, fixtureCreados);
    console.log(`  Resumen: cursos=${fixtureCreados.cursos.length}, cuotas=${fixtureCreados.cuotas.length}, alumnos=${fixtureCreados.alumnos.length}, planes=${fixtureCreados.planes_pago.length}, abonos=${fixtureCreados.abonos.length}, pagos=${fixtureCreados.pagos.length}, usuarios_ext=${fixtureCreados.usuariosExternos.length}`);
    if (fixtureCreados.errorPlanPago)
      nota('Pre', `plan_pago no creado (R04x, R06 planes): ${fixtureCreados.errorPlanPago}`);
    if (fixtureCreados.errorUsuarioExterno)
      nota('Pre', `usuario_externo no creado (R11-R12 se bloquearán): ${fixtureCreados.errorUsuarioExterno}`);

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
      console.error(`  [R03] Error capturando descarga: ${e.message}`);
    } finally {
      if (tmpFile) try { fs.unlinkSync(tmpFile); } catch(_) {}
    }

    ok('R03-a: archivo de respaldo descargado', !!capturado);

    if (capturado) {
      try {
        respaldoCompleto = JSON.parse(capturado);
        ok('R03-b: JSON válido', true);
      } catch (e) {
        ok('R03-b: JSON válido', false);
        console.error('  Parse error:', e.message);
      }
    } else {
      ok('R03-b: JSON válido', false);
    }

    if (respaldoCompleto) {
      ok('R03-c: version = "v9-completo"', respaldoCompleto.version === 'v9-completo');
      ok('R03-d: cuentaId coincide', respaldoCompleto.cuentaId === CUENTA_ID);
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
      ok('R03-f: todas las colecciones esperadas', todasPresentes);

      respaldoFixture = construirRespaldoFixture(CUENTA_ID, fixtureCreados, respaldoCompleto);
      const nFix = Object.values(respaldoFixture.colecciones)
        .reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0);
      console.log(`  respaldoFixture: ${nFix} registros totales`);
    }

    // ── R04 ───────────────────────────────────────────────────────────────────
    console.log('\n[R04] Fixtures propios aparecen en el respaldo (IDs exactos)');
    if (!respaldoCompleto) {
      skip('R04', 'R03 no obtuvo JSON');
    } else {
      const cols = respaldoCompleto.colecciones || {};
      ok('R04-a: curso fixture en respaldo',
        fixtureCreados.cursos.every(id => (cols.cursos||[]).some(c => c.id === id)));
      ok('R04-b: cuota fixture en respaldo',
        fixtureCreados.cuotas.every(id => (cols.cuotas||[]).some(c => c.id === id)));
      ok('R04-c: alumnos fixture en respaldo',
        fixtureCreados.alumnos.every(id => (cols.alumnos||[]).some(a => a.id === id)));
      ok('R04-d: pago fixture en respaldo',
        fixtureCreados.pagos.every(id => (cols.pagos||[]).some(p => p.id === id)));

      if (fixtureCreados.planes_pago.length > 0) {
        ok('R04-e: plan_pago fixture en respaldo',
          fixtureCreados.planes_pago.every(id => (cols.planes_pago||[]).some(p => p.id === id)));
        if (fixtureCreados.abonos.length > 0) {
          ok('R04-f: abonos fixture en respaldo',
            fixtureCreados.abonos.every(id => (cols.abonos||[]).some(a => a.id === id)));
        }

        // R04x: formato de exportación de planes_pago
        const planEnRespaldo = (cols.planes_pago||[]).find(p => p.id === fixtureCreados.planes_pago[0]);
        if (planEnRespaldo) {
          const tieneSnake  = 'cuenta_id'  in planEnRespaldo;
          const tieneCamel  = 'cuentaId'   in planEnRespaldo;
          const tieneMonto  = 'monto_total' in planEnRespaldo || 'montoTotal' in planEnRespaldo;
          nota('R04x formato plan_pago',
            `snake_case=${tieneSnake}, camelCase=${tieneCamel}, monto presente=${tieneMonto}`);
          nota('R04x campos plan_pago', Object.keys(planEnRespaldo).join(', '));
          if (tieneCamel && !tieneSnake) {
            nota('R04x', 'plan_pago exportado en camelCase → la normalización en _b5UpsertColeccion lo convierte al importar');
          }
          ok('R04x: plan_pago tiene id y alguna forma de cuenta', !!(planEnRespaldo.id && (tieneSnake || tieneCamel)));
        } else {
          nota('R04x', 'plan_pago fixture no encontrado en respaldo para inspección de formato');
        }
      } else {
        nota('R04-e', 'plan_pago no creado como fixture (error en inserción)');
      }

      const alumnosFixture = (cols.alumnos||[]).filter(a => fixtureCreados.alumnos.includes(a.id));
      ok('R04-g: alumnos fixture tienen cuenta_id correcto',
        alumnosFixture.length > 0 && alumnosFixture.every(a => a.cuenta_id === CUENTA_ID));
    }

    // ── R05 ───────────────────────────────────────────────────────────────────
    console.log('\n[R05] Límite de paginación (1000 filas)');
    if (!respaldoCompleto) {
      skip('R05', 'R03 no obtuvo JSON');
    } else {
      const cols = respaldoCompleto.colecciones || {};
      let algunaAlLimite = false;
      for (const [nombre, arr] of Object.entries(cols)) {
        if (Array.isArray(arr) && arr.length >= 1000) {
          console.error(`  ⚠️  "${nombre}" tiene ${arr.length} registros — posible truncación`);
          algunaAlLimite = true;
        } else if (Array.isArray(arr) && arr.length >= 900) {
          console.warn(`  ⚠️  "${nombre}" tiene ${arr.length} registros (cerca del límite 1000)`);
        }
      }
      ok('R05: ninguna colección alcanza 1000 filas en staging', !algunaAlLimite);
      nota('R05 pendiente', 'exportarDatosCompletosV9 no implementa paginación — bloquea publicación');
    }

    // ── R06 ───────────────────────────────────────────────────────────────────
    console.log('\n[R06] Eliminar fixture → importar respaldo-fixture → GET por ID exacto');
    if (!respaldoFixture || fixtureCreados.alumnos.length === 0) {
      skip('R06', 'requiere respaldoFixture y fixtures creados');
      skip('R07', 'requiere R06');
    } else {
      // Crear brecha: eliminar alumnos, pagos, abonos y planes_pago fixture
      let errorEliminar = null;
      const eliminarBrecha = async (tabla, ids) => {
        for (const id of ids) {
          if (errorEliminar) return;
          const r = await supaAuth(
            `/rest/v1/${tabla}?id=eq.${encodeURIComponent(id)}&cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}`,
            jwt, { method: 'DELETE', prefer: '' }
          );
          if (r.status >= 300) errorEliminar = `${tabla} ${id.slice(0,8)} HTTP ${r.status}`;
        }
      };
      await eliminarBrecha('abonos',     fixtureCreados.abonos);
      await eliminarBrecha('planes_pago', fixtureCreados.planes_pago);
      await eliminarBrecha('pagos',       fixtureCreados.pagos);
      await eliminarBrecha('alumnos',     fixtureCreados.alumnos);

      if (errorEliminar) {
        ok('R06-a: fixture eliminado para crear brecha', false);
        console.error(`  Error en eliminación: ${errorEliminar}`);
        skip('R06-b/c/d', 'eliminación previa falló');
        skip('R07', 'requiere R06 exitoso');
      } else {
        ok('R06-a: fixture eliminado (brecha creada)', true);

        for (const id of fixtureCreados.alumnos) {
          const existe = await existeEnDB(jwt, 'alumnos', id);
          ok(`R06-b: alumno fixture ${id.slice(0,8)}… ausente en DB antes de importar`, !existe);
        }

        console.log('  Importando respaldo-fixture…');
        dialogState.ultimoDialog = null;
        await navegarConfig(page);
        const msgImport = await dispararImportacion(page, respaldoFixture);
        console.log(`  Mensaje UI: ${msgImport || '(vacío/timeout)'}`);

        // Verificar restauración exacta por GET individual
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
        // planes_pago y abonos si existen en fixture
        for (const id of fixtureCreados.planes_pago) {
          const existe = await existeEnDB(jwt, 'planes_pago', id);
          ok(`R06-e: plan_pago fixture ${id.slice(0,8)}… restaurado`, existe);
        }
        for (const id of fixtureCreados.abonos) {
          const existe = await existeEnDB(jwt, 'abonos', id);
          ok(`R06-f: abono fixture ${id.slice(0,8)}… restaurado`, existe);
        }

        const restauracionCompleta =
          alumnosRestaurados === fixtureCreados.alumnos.length &&
          pagosRestaurados   === fixtureCreados.pagos.length;
        ok('R06-g: restauración completa (todos los IDs presentes)', restauracionCompleta);

        const msgTerminal = msgImport &&
          (msgImport.startsWith('✅') || msgImport.startsWith('⚠️') || msgImport.startsWith('❌'));
        ok('R06-h: UI mostró mensaje terminal (no vacío, no ⏳)', msgTerminal);

        // ── R07 ──────────────────────────────────────────────────────────────
        console.log('\n[R07] Importar mismo respaldo-fixture segunda vez → idempotente');

        const contarPorIds = async (tabla, ids) => {
          if (!ids.length) return 0;
          const filter = ids.map(id => `id.eq.${encodeURIComponent(id)}`).join(',');
          const r = await supaAuth(`/rest/v1/${tabla}?or=(${filter})&select=id`, jwt);
          return (r.status === 200 && Array.isArray(r.body)) ? r.body.length : null;
        };

        const countAntes = {
          alumnos:    await contarPorIds('alumnos',    fixtureCreados.alumnos),
          pagos:      await contarPorIds('pagos',      fixtureCreados.pagos),
          planes_pago:await contarPorIds('planes_pago',fixtureCreados.planes_pago),
        };
        console.log(`  Antes: alumnos=${countAntes.alumnos}, pagos=${countAntes.pagos}, planes=${countAntes.planes_pago}`);

        dialogState.ultimoDialog = null;
        await navegarConfig(page);
        const msgImport2 = await dispararImportacion(page, respaldoFixture);
        console.log(`  Mensaje 2ª importación: ${msgImport2 || '(vacío/timeout)'}`);

        const countDespues = {
          alumnos:    await contarPorIds('alumnos',    fixtureCreados.alumnos),
          pagos:      await contarPorIds('pagos',      fixtureCreados.pagos),
          planes_pago:await contarPorIds('planes_pago',fixtureCreados.planes_pago),
        };
        console.log(`  Después: alumnos=${countDespues.alumnos}, pagos=${countDespues.pagos}, planes=${countDespues.planes_pago}`);

        ok('R07-a: alumnos no se duplican', countAntes.alumnos !== null && countDespues.alumnos === countAntes.alumnos);
        ok('R07-b: pagos no se duplican',   countAntes.pagos   !== null && countDespues.pagos   === countAntes.pagos);
        if (fixtureCreados.planes_pago.length > 0)
          ok('R07-c: planes_pago no se duplican', countAntes.planes_pago !== null && countDespues.planes_pago === countAntes.planes_pago);

        for (const id of fixtureCreados.alumnos) {
          const existe = await existeEnDB(jwt, 'alumnos', id);
          ok(`R07-d: alumno fixture ${id.slice(0,8)}… existe tras 2ª importación`, existe);
        }

        const msgTerminal2 = msgImport2 &&
          (msgImport2.startsWith('✅') || msgImport2.startsWith('⚠️') || msgImport2.startsWith('❌'));
        ok('R07-e: UI mostró mensaje terminal en 2ª importación', msgTerminal2);
      }
    }

    // ── R08 ───────────────────────────────────────────────────────────────────
    console.log('\n[R08] Importar con cuentaId ajeno en encabezado → rechazado');
    if (!respaldoFixture) {
      skip('R08', 'requiere respaldoFixture');
    } else {
      const backupAjeno = JSON.parse(JSON.stringify(respaldoFixture));
      backupAjeno.cuentaId = 'cuenta-ajena-00000000-0000-0000-0000-000000000000';

      dialogState.ultimoDialog = null;
      await navegarConfig(page);
      const msgAjeno = await dispararImportacion(page, backupAjeno);
      console.log(`  Mensaje UI: ${msgAjeno || '(vacío/timeout)'}`);

      const rechazadoEnMsg = msgAjeno &&
        (msgAjeno.includes('otra cuenta') || msgAjeno.includes('ajeno') ||
         msgAjeno.includes('cuentaId') || msgAjeno.startsWith('❌'));
      ok('R08-a: cuentaId ajeno es rechazado', rechazadoEnMsg || !!dialogState.ultimoDialog?.message);
      ok('R08-b: rechazo aparece en DOM', rechazadoEnMsg);
    }

    // ── R09 ───────────────────────────────────────────────────────────────────
    console.log('\n[R09] Registro con cuenta_id ajeno → guardia por-registro cancela antes de escribir');
    if (!respaldoFixture) {
      skip('R09', 'requiere respaldoFixture');
    } else {
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
      console.log(`  Mensaje UI: ${msgCuentaAjena || '(vacío/timeout)'}`);

      const rechazado = msgCuentaAjena &&
        (msgCuentaAjena.includes('cuenta_id ajeno') || msgCuentaAjena.includes('ajeno') ||
         msgCuentaAjena.includes('cancelada') || msgCuentaAjena.startsWith('❌'));
      ok('R09-a: registro ajeno cancela importación', rechazado);
      ok('R09-b: rechazo visible en DOM', rechazado);

      const rCorrupto = await supaAuth(
        `/rest/v1/alumnos?apellidos=eq.${encodeURIComponent(EXEC_ID)}&nombres=eq.CorruptoR09&select=id`,
        jwt
      );
      const escritoAjeno = rCorrupto.status === 200 &&
                           Array.isArray(rCorrupto.body) && rCorrupto.body.length > 0;
      ok('R09-c: registro ajeno NO fue escrito en DB', !escritoAjeno);
    }

    // ── R10 ───────────────────────────────────────────────────────────────────
    console.log('\n[R10] FK inválida → mensaje terminal de error en UI');
    console.log('  NOTA: Cada POST es transacción independiente. Un chunk anterior ya confirmado no revierte.');
    if (!respaldoFixture) {
      skip('R10', 'requiere respaldoFixture');
    } else {
      const backupFKInvalida = JSON.parse(JSON.stringify(respaldoFixture));
      const cursoFalsoId = crypto.randomUUID();
      backupFKInvalida.colecciones.alumnos.push({
        id:        crypto.randomUUID(),
        cuenta_id: CUENTA_ID,
        curso_id:  cursoFalsoId,       // FK a curso inexistente
        nombres:   'FKInvalidaR10',
        apellidos: EXEC_ID,
        estado:    'activo',
      });

      dialogState.ultimoDialog = null;
      await navegarConfig(page);
      const msgFK = await dispararImportacion(page, backupFKInvalida);
      console.log(`  Mensaje UI: ${msgFK || '(vacío/timeout)'}`);

      // Exigir mensaje terminal no vacío
      const tieneTerminal = !!(msgFK && msgFK.length > 0 && !msgFK.startsWith('⏳'));
      ok('R10-a: UI muestra mensaje terminal (no vacío, no ⏳)', tieneTerminal);

      const anuncia_completa = msgFK && msgFK.startsWith('✅') && !msgFK.includes('⚠️');
      const reporta_error    = msgFK && (msgFK.startsWith('⚠️') || msgFK.startsWith('❌'));
      ok('R10-b: error de FK reportado en UI (⚠️ o ❌)', reporta_error);
      ok('R10-c: UI NO anuncia restauración completa cuando hay FK inválida', !anuncia_completa);

      nota('R10-d comportamiento de chunks',
        'Si la FK inválida está en un chunk posterior a registros válidos, los anteriores ya confirmados no revierten.');
    }

    // ── R11 ───────────────────────────────────────────────────────────────────
    console.log('\n[R11] B6: cargarUsuariosDesdeSupabase popula DB.usuariosExternos');
    // No omitir B6 por V9_RELACIONAL — probar independientemente si las funciones existen
    const tieneB6 = await page.evaluate(() => typeof cargarUsuariosDesdeSupabase === 'function');
    if (!tieneB6) {
      skip('R11', 'cargarUsuariosDesdeSupabase no disponible en la app');
      skip('R12', 'requiere cargarUsuariosDesdeSupabase');
    } else if (fixtureCreados.usuariosExternos.length === 0) {
      skip('R11', `usuario_externo fixture no creado: ${fixtureCreados.errorUsuarioExterno || 'error'}`);
      skip('R12', 'requiere fixture usuario_externo creado');
    } else {
      await page.evaluate(() => { if (typeof go === 'function') go('config'); });
      await page.waitForTimeout(500);

      await page.evaluate(async () => {
        if (typeof cargarUsuariosDesdeSupabase === 'function')
          await cargarUsuariosDesdeSupabase(true);
      });
      await page.waitForTimeout(2000);

      // Acceder al binding real de DB, no window.DB
      // (DB declarado con `let` puede no estar en window en algunos entornos)
      const ueEnDB = await page.evaluate(() => {
        try {
          // DB está en scope del módulo; en V9 debe ser un array tras carga
          if (typeof DB === 'undefined') return -1;
          return Array.isArray(DB.usuariosExternos) ? DB.usuariosExternos.length : -2;
        } catch(e) { return -3; }
      });
      console.log(`  DB.usuariosExternos.length = ${ueEnDB}`);
      ok('R11-a: DB.usuariosExternos es array tras cargarUsuariosDesdeSupabase', ueEnDB >= 0);

      const idFixtureUser = fixtureCreados.usuariosExternos[0];
      const encontrado = await page.evaluate((id) => {
        try {
          if (typeof DB === 'undefined' || !Array.isArray(DB.usuariosExternos)) return false;
          return DB.usuariosExternos.some(u => u.id === id);
        } catch(e) { return false; }
      }, idFixtureUser);
      ok(`R11-b: usuario externo fixture ${idFixtureUser.slice(0,8)}… en DB.usuariosExternos`, encontrado);

      if (encontrado) {
        const v9Tabla = await page.evaluate((id) => {
          try {
            const u = DB.usuariosExternos?.find(u => u.id === id);
            return u ? (u._v9Tabla || null) : null;
          } catch(e) { return null; }
        }, idFixtureUser);
        ok('R11-c: usuario externo fixture tiene _v9Tabla', !!v9Tabla);
        ok('R11-d: _v9Tabla es "usuarios_externos"', v9Tabla === 'usuarios_externos');
        console.log(`  _v9Tabla: ${v9Tabla}`);
      }

      // ── R12 ──────────────────────────────────────────────────────────────
      console.log('\n[R12] B6: toggleUsuarioAdmin hace PATCH en la tabla V9 correcta');
      if (!encontrado) {
        skip('R12', 'fixture no aparece en DB.usuariosExternos');
      } else {
        const idFixtureUser = fixtureCreados.usuariosExternos[0];
        const rAntes = await supaAuth(
          `/rest/v1/usuarios_externos?id=eq.${encodeURIComponent(idFixtureUser)}&select=id,desactivado`,
          jwt
        );
        ok('R12-a: GET estado inicial HTTP 200 + array',
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
        ok('R12-c: GET estado posterior HTTP 200 + array',
          rDespues.status === 200 && Array.isArray(rDespues.body));

        const desactivadoDespues = rDespues.body?.[0]?.desactivado ?? null;
        console.log(`  Estado después desactivado=${desactivadoDespues}`);
        ok('R12-d: estado desactivado cambió en DB (PATCH V9 efectivo)',
          desactivadoDespues !== null && desactivadoDespues !== desactivadoAntes);

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
    console.error(`\n❌ Error inesperado: ${e.message}`);
    fail++;
    failures.push(`Error inesperado: ${e.message.split('\n')[0].slice(0, 120)}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server)  server.close();

    const totalFixtures = [
      ...fixtureCreados.cursos, ...fixtureCreados.cuotas,
      ...fixtureCreados.alumnos, ...fixtureCreados.planes_pago,
      ...fixtureCreados.abonos, ...fixtureCreados.pagos,
      ...fixtureCreados.usuariosExternos,
    ].length;

    if (jwt && CUENTA_ID && totalFixtures > 0) {
      console.log(`\n[R13/finally] Eliminar todos los fixtures (${totalFixtures} registros)`);
      fallosCleanup = await eliminarFixtures(jwt, CUENTA_ID, fixtureCreados).catch(e => {
        console.error('  [finally] eliminarFixtures excepción:', e.message);
        return 99;
      });
    }
  }

  // R13 siempre se evalúa
  const totalFixtures = [
    ...fixtureCreados.cursos, ...fixtureCreados.cuotas,
    ...fixtureCreados.alumnos, ...fixtureCreados.planes_pago,
    ...fixtureCreados.abonos, ...fixtureCreados.pagos,
    ...fixtureCreados.usuariosExternos,
  ].length;
  if (totalFixtures > 0)
    ok(`R13: limpieza completa (${totalFixtures} fixtures, ${fallosCleanup} fallos)`, fallosCleanup === 0);

  // ── Resumen ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`📊 E13: ${pass} ✅  ${fail} ❌  ${blocked} ⏭ (bloqueados)`);
  if (blockedList.length) {
    console.log('\nBloqueados:');
    blockedList.forEach(f => console.log('  •', f));
  }
  if (failures.length) {
    console.log('\nFallas:');
    failures.forEach(f => console.log('  •', f));
  }
  console.log('\nPendientes conocidos (fuera de esta suite):');
  console.log('  • Paginación: exportar >1000 filas sin truncar — bloquea publicación');
  console.log('  • B5/B6 no declarados completos hasta que estos tests pasen íntegramente');
  console.log('  • Restauración de sesión / recordar acceso (sin implementar en V9)');
  console.log('  • Comparación funcional completa con app original');
  process.exit(fail > 0 ? 1 : 0);
})();
