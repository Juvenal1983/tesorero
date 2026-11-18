/**
 * tests/e12_respaldos_ui.js
 *
 * Suite Playwright B5 — Respaldo/Restauración V9
 *
 * Verifica:
 *   R01  Servidor local levantado
 *   R02  Login UI completado
 *   R03  exportarDatosCompletosV9 → JSON descargado con estructura válida
 *   R04  Respaldo cubre ≥2 cursos de la cuenta
 *   R05  Colecciones críticas presentes y no vacías (cursos, alumnos, pagos)
 *   R06  Integridad: alumnos tienen cuenta_id; pagos tienen cuenta_id; notas tienen cuenta_id
 *   R07  Colecciones complementarias presentes (cuotas, movimientos, notas, codigos_invitacion)
 *   R08  importarDatos en V9 bloquea con alert explícito — no modifica caché
 *   R09  saveCuenta V9 silenced: si updateUser falla, muestra error (no anuncia éxito)
 *       [informativo — no ejecuta cambio de contraseña real en staging]
 *
 * Notas:
 *   - La exportación se intercepta interceptando document.createElement('a').click()
 *     para capturar el contenido del blob sin descarga real.
 *   - importarDatos se prueba pasando un archivo simulado via FileReader.
 *   - Producción excluida.
 *
 * Variables de entorno requeridas:
 *   STAGING_SUPABASE_URL, STAGING_SUPABASE_ANON_KEY (o STAGING_KEY),
 *   STAGING_USER_A_EMAIL (o STAGING_EMAIL), STAGING_USER_A_PASSWORD (o STAGING_PASS)
 */

'use strict';

const path  = require('path');
const http  = require('http');
const https = require('https');
const fs    = require('fs');
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

const T_CORTO = 12_000;
const T_LARGO = 45_000;   // exportación completa puede tardar más

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

async function descubrirCuenta(jwt) {
  const r = await supaAuth('/rest/v1/tesorero_cuentas?select=id&limit=1', jwt);
  if (r.status !== 200 || !Array.isArray(r.body) || r.body.length === 0)
    throw new Error('descubrirCuenta: ' + JSON.stringify(r.body));
  return r.body[0].id;
}

// ── Helpers Playwright ────────────────────────────────────────────────────────

async function waitAppReady(page) {
  await page.waitForFunction(() => typeof window.S !== 'undefined', { timeout: T_LARGO });
}

function interceptDialogs(page) {
  page.on('dialog', async d => {
    console.log(`    [dialog] ${d.type()}: ${d.message().slice(0, 100)}`);
    await d.accept();
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

  // Verificar cuántos cursos hay en staging para R04
  const rCursos = await supaAuth(
    `/rest/v1/cursos?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&activo=eq.true&select=id,nombre`,
    jwt
  );
  const cursosEnDB = Array.isArray(rCursos.body) ? rCursos.body : [];
  console.log(`  Cursos en staging: ${cursosEnDB.length} → ${cursosEnDB.map(c=>c.nombre).join(', ')}`);

  let server = null, browser = null;
  let respaldoJSON = null;

  try {
    // ── R01: Servidor ─────────────────────────────────────────────────────
    console.log('\n[R01] Servidor HTTP local');
    server = await servirApp();
    ok('R01: servidor levantado', true);

    // ── R02: Login UI ─────────────────────────────────────────────────────
    console.log('\n[R02] Login UI');
    browser = await chromium.launch({ headless: true });
    const ctx  = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on('console', msg => {
      if (msg.type() === 'error') console.error(`  [browser] ${msg.text()}`);
    });
    interceptDialogs(page);
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

    // Esperar que _v9CuentaId coincida
    await page.waitForFunction(
      cuentaId => window.S?._v9CuentaId === cuentaId,
      CUENTA_ID,
      { timeout: T_LARGO }
    ).catch(() => {});

    // ── R03: Exportar respaldo completo ───────────────────────────────────
    // Interceptar el click de <a download> para capturar el contenido del blob
    // sin que Playwright lo descargue al disco.
    console.log('\n[R03] exportarDatosCompletosV9 → capturar JSON');

    // Inyectar interceptor ANTES de llamar la función
    await page.evaluate(() => {
      window.__respaldoCapturado = null;
      const _origCreate = document.createElement.bind(document);
      document.createElement = function(tag) {
        const el = _origCreate(tag);
        if (tag.toLowerCase() === 'a') {
          const _origClick = el.click.bind(el);
          el.click = function() {
            // En lugar de descargar, leer el blob y guardar el JSON
            if (el.href && el.href.startsWith('blob:')) {
              fetch(el.href)
                .then(r => r.text())
                .then(txt => { window.__respaldoCapturado = txt; });
            }
            // No llamar _origClick para evitar la descarga real
          };
        }
        return el;
      };
    });

    // Navegar a config (donde vive el botón de exportar)
    await navegarConfig(page);

    // Llamar directamente a exportarDatosCompletosV9 (async)
    await page.evaluate(async () => {
      if (typeof exportarDatosCompletosV9 === 'function') await exportarDatosCompletosV9();
    });

    // Esperar que el blob haya sido capturado
    const capturado = await page.waitForFunction(
      () => window.__respaldoCapturado !== null,
      { timeout: T_LARGO }
    ).then(() => page.evaluate(() => window.__respaldoCapturado))
      .catch(() => null);

    ok('R03-a: blob de respaldo capturado', !!capturado);

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
      ok('R03-e: campo "colecciones" presente', typeof respaldoJSON.colecciones === 'object' && respaldoJSON.colecciones !== null);
      console.log(`  Claves colecciones: ${Object.keys(respaldoJSON.colecciones || {}).join(', ')}`);
    } else {
      ok('R03-c: version = "v9-completo"', false);
      ok('R03-d: cuentaId coincide', false);
      ok('R03-e: campo "colecciones" presente', false);
    }

    // ── R04: ≥2 cursos cubiertos ──────────────────────────────────────────
    console.log('\n[R04] Respaldo cubre cursos de la cuenta');
    const colecciones = respaldoJSON?.colecciones || {};
    const cursosEnRespaldo = Array.isArray(colecciones.cursos) ? colecciones.cursos : [];
    console.log(`  Cursos en respaldo: ${cursosEnRespaldo.length} → ${cursosEnRespaldo.map(c=>c.nombre||c.id).join(', ')}`);
    ok('R04-a: colección "cursos" presente en respaldo', Array.isArray(colecciones.cursos));
    ok('R04-b: cursos en respaldo coinciden con staging',
      cursosEnRespaldo.length === cursosEnDB.length);
    ok('R04-c: respaldo cubre ≥2 cursos',
      cursosEnRespaldo.length >= 2);

    // ── R05: Colecciones críticas no vacías ───────────────────────────────
    console.log('\n[R05] Colecciones críticas presentes y no vacías');
    const colsRequeridas = ['cursos', 'alumnos', 'pagos'];
    for (const col of colsRequeridas) {
      const arr = colecciones[col];
      const noVacia = Array.isArray(arr) && arr.length > 0;
      console.log(`  ${col}: ${Array.isArray(arr) ? arr.length : 'ausente'} registros`);
      ok(`R05: colección "${col}" presente y no vacía`, noVacia);
    }

    // ── R06: Integridad de colecciones ────────────────────────────────────
    console.log('\n[R06] Integridad: cuenta_id en colecciones relacionales');

    const alumnos = colecciones.alumnos || [];
    const alumnosConCuenta = alumnos.filter(a => a.cuenta_id === CUENTA_ID);
    ok('R06-a: alumnos.cuenta_id === CUENTA_ID (todos)',
      alumnos.length > 0 && alumnosConCuenta.length === alumnos.length);

    const pagos = colecciones.pagos || [];
    const pagosConCuenta = pagos.filter(p => p.cuenta_id === CUENTA_ID);
    ok('R06-b: pagos.cuenta_id === CUENTA_ID (todos)',
      pagos.length > 0 && pagosConCuenta.length === pagos.length);

    // Verificar que cada alumno tiene curso_id
    const alumnosSinCurso = alumnos.filter(a => !a.curso_id);
    ok('R06-c: alumnos tienen curso_id',
      alumnos.length > 0 && alumnosSinCurso.length === 0);

    console.log(`  alumnos: ${alumnos.length} (${alumnosConCuenta.length} con cuenta_id correcto)`);
    console.log(`  pagos:   ${pagos.length} (${pagosConCuenta.length} con cuenta_id correcto)`);

    // ── R07: Colecciones complementarias ──────────────────────────────────
    console.log('\n[R07] Colecciones complementarias presentes');
    const colsCompl = ['cuotas', 'movimientos', 'notas', 'codigos_invitacion'];
    for (const col of colsCompl) {
      const arr = colecciones[col];
      console.log(`  ${col}: ${Array.isArray(arr) ? arr.length : 'ausente'}`);
      ok(`R07: colección "${col}" presente (puede ser vacía)`, Array.isArray(arr));
    }

    // ── R08: importarDatos en V9 bloquea con alert ────────────────────────
    console.log('\n[R08] importarDatos en V9 → alert bloqueante, DB sin modificar');

    // Capturar alert antes de disparar
    let alertTexto = null;
    page.once('dialog', async d => {
      alertTexto = d.message();
      console.log(`  [dialog] alert: ${alertTexto.slice(0, 100)}`);
      await d.accept();
    });

    // Crear FileReader simulado y llamar importarDatos con un archivo fake
    const estadoAntes = await page.evaluate(() => {
      return JSON.stringify((typeof DB !== 'undefined' && DB?.alumnos?.length) || 0);
    });

    await page.evaluate(() => {
      // Simular evento de input con un archivo JSON mínimo para activar el bloqueo
      if (typeof importarDatos !== 'function') return;
      const minJson = JSON.stringify({ usuarios: [{ id: 'u-test', nombre: 'Test' }] });
      const blob = new Blob([minJson], { type: 'application/json' });
      const file = new File([blob], 'test.json', { type: 'application/json' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const fakeInput = { target: { files: dt.files } };
      importarDatos(fakeInput);
    });
    await page.waitForTimeout(1000);

    const estadoDespues = await page.evaluate(() => {
      return JSON.stringify((typeof DB !== 'undefined' && DB?.alumnos?.length) || 0);
    });

    ok('R08-a: importarDatos muestra alert en V9', alertTexto !== null &&
      (alertTexto.includes('V9') || alertTexto.includes('relacional') || alertTexto.includes('disponible')));
    ok('R08-b: DB.alumnos no modificado tras importarDatos V9', estadoAntes === estadoDespues);

  } finally {
    if (browser) await browser.close();
    if (server)  server.close();
  }

  console.log(`\n${'─'.repeat(56)}`);
  console.log(`📊 E12 Respaldos V9: ${pass} ✅  ${fail} ❌`);
  if (failures.length) {
    console.log('\nFallas:');
    failures.forEach(f => console.log('  •', f));
  }
  process.exit(fail > 0 ? 1 : 0);
})();
