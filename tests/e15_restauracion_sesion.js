/**
 * tests/e15_restauracion_sesion.js
 *
 * Suite Playwright E15 — Restauración de sesión y "Recordar mi acceso"
 *
 * ── Fixtures propios (sin AP_CODIGO / AP_ALUMNO_ID / AP_PIN del entorno) ─────
 *
 * El setup crea en staging:
 *   • Un curso ficticio con código único TST15-<id>
 *   • Un alumno ficticio ligado a ese curso
 *   • Un PIN ficticio vía RPC tesorero_set_pin (server-side hash, nunca plaintext)
 * El teardown elimina esas filas al terminar (DELETE por ID).
 *
 * Verifica que:
 *   1. Tras un login con "Recordar mi acceso" marcado, cuentaId + alumnoId se
 *      persisten en localStorage. El PIN NUNCA se guarda.
 *   2. Al recargar, el panel de acceso rápido aparece con el nombre del alumno.
 *   3. El usuario va directo al paso-pin sin reingresar el código.
 *   4. Con PIN incorrecto, el error aparece y la sesión NO se abre.
 *   5. logoutLector conserva las claves V9 (para el próximo acceso rápido).
 *   6. logout (tesorero) limpia TODAS las claves, incluyendo V9.
 *   7. limpiarSesionApoderado borra el contexto V9.
 *
 * Tests:
 *   R01  Servidor local levantado y staging alcanzable
 *   R02  Login REST + cuenta descubierta
 *   R03  Fixture creado: curso + alumno + PIN vía tesorero_set_pin
 *   R04  Login apoderado con PIN correcto → sesión creada
 *   R05  "Recordar mi acceso" marcado: cuentaId + alumnoId en localStorage
 *   R06  PIN NO persistido en localStorage (seguridad)
 *   R07  Panel de acceso rápido visible tras recarga (nombre del alumno)
 *   R08  paso-pin visible directamente al hacer clic en "Ingresar a mi cuenta"
 *   R09  PIN incorrecto → error visible, sesión NO creada
 *   R10  PIN correcto vía acceso rápido → dashboard abierto
 *   R11  logoutLector conserva claves V9 en localStorage
 *   R12  logout (tesorero) limpia claves V9
 *   R13  "Ingresar con otro código" borra contexto V9
 *
 * Producción excluida.
 */

'use strict';

const path   = require('path');
const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const { chromium } = require('playwright');

try { require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') }); } catch(_) {}

// ── Configuración de entorno ─────────────────────────────────────────────────
const SUPA_URL_RAW = (process.env.STAGING_SUPABASE_URL || process.env.STAGING_URL || '').replace(/\/$/, '');
const ANON_KEY     = process.env.STAGING_SUPABASE_ANON_KEY || process.env.STAGING_KEY || '';
const USER_EMAIL   = process.env.STAGING_USER_A_EMAIL || process.env.STAGING_EMAIL || '';
const USER_PASS    = process.env.STAGING_USER_A_PASSWORD || process.env.STAGING_PASS || '';

if (!SUPA_URL_RAW || !ANON_KEY || !USER_EMAIL || !USER_PASS) {
  console.error('❌ Faltan variables de entorno básicas. Revisa .env.');
  console.error('   Requeridas: STAGING_SUPABASE_URL, STAGING_SUPABASE_ANON_KEY,');
  console.error('               STAGING_USER_A_EMAIL, STAGING_USER_A_PASSWORD');
  process.exit(1);
}

// ── Guardia de producción ────────────────────────────────────────────────────
const PROD_HOST    = 'tmjqzaakzhecbldebyeg.supabase.co';
const STAGING_HOST = 'rucgmytyxpfowznowxwd.supabase.co';

let parsedHost;
try { parsedHost = new URL(SUPA_URL_RAW).hostname; } catch(_) { process.exit(2); }
if (parsedHost === PROD_HOST || parsedHost !== STAGING_HOST) {
  console.error('❌ URL no autorizada:', parsedHost);
  process.exit(2);
}

const SUPA_URL = SUPA_URL_RAW;
const PORT     = 8805;

// ── PIN de fixture (constante en el test, NO viene del entorno ni del localStorage)
// No es un PIN real de ningún usuario: solo existe durante la ejecución del test.
const FIXTURE_PIN = '7391';   // ≥4 caracteres, cumple la validación de guardarPinV9

// ── ID único para esta ejecución ─────────────────────────────────────────────
const EXEC_ID = Date.now().toString(36).toUpperCase();
// IDs de fixture deterministas: TEXT explícito (cursos.id y alumnos.id son TEXT NOT NULL sin DEFAULT)
const FIXTURE_CURSO_ID = 'e15-curso-' + EXEC_ID.toLowerCase();
const FIXTURE_ALU_ID   = 'e15-alu-'   + EXEC_ID.toLowerCase();

// ── Utilidades ───────────────────────────────────────────────────────────────
function apiUrl(p) { return `${SUPA_URL}/rest/v1${p}`; }

async function apiFetch(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   opts.method || 'GET',
      headers:  opts.headers || {},
    };
    const req = lib.request(reqOpts, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

let results = [];
let passed = 0, failed = 0;
function ok(label, cond, detail = '') {
  results.push({ label, cond, detail });
  if (cond) { passed++; console.log(`  ✅ ${label}`); }
  else       { failed++; console.error(`  ❌ ${label}${detail ? ' — '+detail : ''}`); }
}

// ── Servidor local ────────────────────────────────────────────────────────────
let server;
function serveLocal(port) {
  const root = path.resolve(__dirname, '..');
  server = http.createServer((req, res) => {
    let filePath = path.join(root, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
    const ext  = path.extname(filePath);
    const mime = { '.html':'text/html', '.js':'application/javascript',
                   '.css':'text/css', '.json':'application/json' }[ext] || 'text/plain';
    let content = fs.readFileSync(filePath, 'utf8');
    content = content.replace(/https:\/\/STAGING_SUPA_HOST/g, `https://${STAGING_HOST}`);
    content = content.replace(/wss:\/\/STAGING_SUPA_HOST/g,   `wss://${STAGING_HOST}`);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
  });
  return new Promise(r => server.listen(port, '127.0.0.1', r));
}

// ── Setup / Teardown de fixtures ──────────────────────────────────────────────

// IDs guardados para teardown
let fixtureCursoId   = null;
let fixtureAluId     = null;
let fixtureCuentaId  = null;

async function crearFixtures(H, sub) {
  // Paso 1: obtener cuentaId del tesorero
  const cuentaRes = await apiFetch(
    apiUrl(`/tesorero_cuentas?auth_id=eq.${sub}&select=id&limit=1`),
    { headers: H }
  );
  const cuentas = JSON.parse(cuentaRes.body || '[]');
  if (!cuentas.length) throw new Error('No se encontró tesorero_cuentas para este usuario');
  fixtureCuentaId = cuentas[0].id;

  // Paso 2: crear curso fixture
  const FIXTURE_CODIGO = `TST15-${EXEC_ID}`;
  // cursos.id es TEXT NOT NULL sin DEFAULT → se pasa explícitamente
  const cursoRes = await apiFetch(apiUrl('/cursos'), {
    method: 'POST',
    headers: { ...H, 'Prefer': 'return=representation' },
    body: JSON.stringify({
      cuenta_id: fixtureCuentaId,
      id:        FIXTURE_CURSO_ID,
      nombre:    `Fixture E15 ${EXEC_ID}`,
      anio:      2099,
      codigo:    FIXTURE_CODIGO,
      activo:    true,   // cursos usa booleano 'activo' (filtro del RPC: c.activo = TRUE)
    }),
  });
  if (cursoRes.status !== 201) {
    throw new Error(`No se pudo crear curso fixture (${cursoRes.status}): ${cursoRes.body}`);
  }
  fixtureCursoId = FIXTURE_CURSO_ID;

  // Paso 3: crear alumno fixture
  const aluRes = await apiFetch(apiUrl('/alumnos'), {
    method: 'POST',
    headers: { ...H, 'Prefer': 'return=representation' },
    // alumnos.id es TEXT NOT NULL sin DEFAULT → se pasa explícitamente
    // estado TEXT DEFAULT 'activo' (no boolean 'activo') — el RPC filtra a.estado = 'activo'
    // nombre TEXT — el RPC apoderado_alumnos_curso devuelve a.nombre directamente
    body: JSON.stringify({
      cuenta_id: fixtureCuentaId,
      id:        FIXTURE_ALU_ID,
      curso_id:  FIXTURE_CURSO_ID,
      nombre:    `ALU FIXTURE-E15 ${EXEC_ID}`,
      nombres:   'ALU FIXTURE-E15',
      apellidos: EXEC_ID,
      estado:    'activo',
    }),
  });
  if (aluRes.status !== 201) {
    throw new Error(`No se pudo crear alumno fixture (${aluRes.status}): ${aluRes.body}`);
  }
  fixtureAluId = FIXTURE_ALU_ID;

  // Paso 4: establecer PIN vía RPC tesorero_set_pin (SECURITY DEFINER, hash server-side)
  // No se guarda el PIN en texto plano en ningún lado; solo se envía al RPC.
  const pinRes = await apiFetch(`${SUPA_URL}/rest/v1/rpc/tesorero_set_pin`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      p_cuenta_id: fixtureCuentaId,
      p_alumno_id: fixtureAluId,
      p_pin:       FIXTURE_PIN,
    }),
  });
  // tesorero_set_pin devuelve JSONB: {ok:true} o {ok:false,error:"..."}
  const pinData = (() => { try { return JSON.parse(pinRes.body || '{}'); } catch (_) { return {}; } })();
  if (pinRes.status !== 200 || pinData.ok !== true) {
    throw new Error(`tesorero_set_pin falló (${pinRes.status}): ${pinRes.body}`);
  }

  return { fixtureCuentaId, fixtureCursoId, fixtureAluId, FIXTURE_CODIGO };
}

async function eliminarFixtures(H) {
  // Eliminar alumno (el FK ON DELETE CASCADE borra también alumnos_credenciales)
  if (fixtureAluId) {
    const delAlu = await apiFetch(
      apiUrl(`/alumnos?id=eq.${fixtureAluId}&cuenta_id=eq.${fixtureCuentaId}`),
      { method: 'DELETE', headers: H }
    ).catch(e => ({ status: 'error', body: e.message }));
    ok('Teardown: alumno DELETE exitoso',
       delAlu.status === 200 || delAlu.status === 204,
       `status=${delAlu.status}`);

    // Verificar por GET que el alumno ya no existe
    const verAlu = await apiFetch(
      apiUrl(`/alumnos?id=eq.${fixtureAluId}&cuenta_id=eq.${fixtureCuentaId}&select=id`),
      { headers: H }
    ).catch(e => ({ status: 'error', body: e.message }));
    const aluRows = (() => {
      try { return JSON.parse(verAlu.body || '[]'); } catch (_) { return [1]; }
    })();
    ok('Teardown: fixture alumno eliminado (GET)',
       Array.isArray(aluRows) && aluRows.length === 0,
       `body=${verAlu.body}`);
  }

  // Eliminar curso
  if (fixtureCursoId) {
    const delCurso = await apiFetch(
      apiUrl(`/cursos?id=eq.${fixtureCursoId}&cuenta_id=eq.${fixtureCuentaId}`),
      { method: 'DELETE', headers: H }
    ).catch(e => ({ status: 'error', body: e.message }));
    ok('Teardown: curso DELETE exitoso',
       delCurso.status === 200 || delCurso.status === 204,
       `status=${delCurso.status}`);

    // Verificar por GET que el curso ya no existe
    const verCurso = await apiFetch(
      apiUrl(`/cursos?id=eq.${fixtureCursoId}&cuenta_id=eq.${fixtureCuentaId}&select=id`),
      { headers: H }
    ).catch(e => ({ status: 'error', body: e.message }));
    const cursoRows = (() => {
      try { return JSON.parse(verCurso.body || '[]'); } catch (_) { return [1]; }
    })();
    ok('Teardown: fixture curso eliminado (GET)',
       Array.isArray(cursoRows) && cursoRows.length === 0,
       `body=${verCurso.body}`);
  }

  console.log('  🧹 Teardown completado.');
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n════════════════════════════════════════════');
  console.log(' E15 — Restauración de sesión / Recordar acceso');
  console.log(`       exec=${EXEC_ID}  staging=${STAGING_HOST}`);
  console.log('════════════════════════════════════════════\n');

  // ── R01: Servidor local ──────────────────────────────────────────────────
  await serveLocal(PORT);
  ok('R01: servidor local en puerto '+PORT, true);

  // ── R02: Autenticación REST ──────────────────────────────────────────────
  const authRes  = await apiFetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: USER_EMAIL, password: USER_PASS }),
  });
  const authData = JSON.parse(authRes.body || '{}');
  const token    = authData.access_token;
  const sub      = authData.user?.id || '';
  ok('R02: token REST obtenido', !!token);
  if (!token) { server?.close(); process.exit(1); }

  const H = {
    'apikey':        ANON_KEY,
    'Authorization': 'Bearer ' + token,
    'Content-Type':  'application/json',
    'Accept':        'application/json',
  };

  // ── R03: Fixtures creados ────────────────────────────────────────────────
  let FIXTURE_CODIGO = '';
  let CUENTA_ID      = '';
  let ALU_ID         = '';

  try {
    const f = await crearFixtures(H, sub);
    FIXTURE_CODIGO = f.FIXTURE_CODIGO;
    CUENTA_ID      = f.fixtureCuentaId;
    ALU_ID         = f.fixtureAluId;

    // Verificar que el RPC apoderado_alumnos_curso encuentra el alumno fixture
    const rpcRes = await apiFetch(`${SUPA_URL}/rest/v1/rpc/apoderado_alumnos_curso`, {
      method: 'POST',
      headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ p_codigo: FIXTURE_CODIGO }),
    });
    const rpcData      = JSON.parse(rpcRes.body || '[]');
    const alumnoEnRpc  = Array.isArray(rpcData) && rpcData.some(
      a => a.id === ALU_ID || a.alumno_id === ALU_ID
    );
    ok('R03: fixture creado y visible en apoderado_alumnos_curso',
       alumnoEnRpc, `codigo=${FIXTURE_CODIGO} alumnoId=${ALU_ID}`);

    if (!alumnoEnRpc) {
      console.error('⚠️  RPC no devuelve el alumno fixture; no se puede continuar.');
      await eliminarFixtures(H);
      server?.close();
      process.exit(1);
    }
  } catch (err) {
    ok('R03: fixture creado y visible en apoderado_alumnos_curso', false, err.message);
    await eliminarFixtures(H);
    server?.close();
    process.exit(1);
  }

  // ── Pruebas Playwright ───────────────────────────────────────────────────
  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({ viewport: { width: 390, height: 844 } });

  try {
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#panel-codigo, #l-codigo, [onclick="switchLoginTab(\'codigo\')"]',
      { timeout: 10000 }).catch(() => {});

    // Ir a la pestaña "Soy apoderado"
    const tabCodigo = page.locator('[onclick="switchLoginTab(\'codigo\')"]');
    if (await tabCodigo.count()) await tabCodigo.click();

    // ── R04: Login apoderado con código + alumno fixture + PIN correcto ──────
    await page.waitForSelector('#l-codigo', { timeout: 5000 });
    await page.fill('#l-codigo', FIXTURE_CODIGO);
    await page.click('[onclick="doVerificarCodigo()"]');

    const paso2 = await page.waitForSelector(
      '#paso-alumnos, #lista-alumnos-selector', { timeout: 8000 }
    ).catch(() => null);
    ok('R04a: paso-alumnos visible', !!paso2);

    // Esperar la tarjeta V9 del fixture por ID exacto.
    // Las tarjetas V9 tienen onclick="_v9SeleccionarAlumno('alumnoId','nombre',this)"
    // y NO tienen atributo data-alu-id; el selector usa el ID entre comillas simples
    // dentro del onclick para evitar coincidencias parciales con otros alumnos.
    const alumnoCard = await page.waitForSelector(
      `.ap-alumno-card[onclick*="'${ALU_ID}'"]`, { timeout: 8000 }
    ).catch(() => null);
    ok('R04-alu: tarjeta fixture visible (.ap-alumno-card onclick contiene alumnoId)', !!alumnoCard,
       `alumnoId=${ALU_ID}`);
    if (alumnoCard) await alumnoCard.click();

    // El botón real que avanza desde paso-alumnos a paso-pin (V9: llama irPaso3V9)
    await page.click('[onclick="irPaso3()"]');

    const pasoPin = await page.waitForSelector('#paso-pin', { state: 'visible', timeout: 5000 })
      .catch(() => null);
    ok('R04b: paso-pin visible tras seleccionar alumno y clic irPaso3()', !!pasoPin);
    if (!pasoPin) {
      await eliminarFixtures(H);
      server?.close();
      await browser.close();
      process.exit(1);
    }

    // Marcar "Recordar mi acceso"
    const checkbox = page.locator('#ap-recordar');
    const checkboxVisible = await checkbox.isVisible().catch(() => false);
    ok('R04c: checkbox #ap-recordar visible', checkboxVisible);
    if (checkboxVisible) await checkbox.check();

    // Ingresar FIXTURE_PIN (correcto)
    await page.fill('#l-pin', FIXTURE_PIN);
    await page.click('[onclick="doAccesoCodigo()"]');

    const enDashboard = await page.waitForFunction(
      () => window.S?.route === 'dashboard', { timeout: 8000 }
    ).then(() => true).catch(() => false);
    ok('R04d: sesión abierta → dashboard', enDashboard);

    // ── R05: cuentaId + alumnoId en localStorage ─────────────────────────────
    const v9Recordar  = await page.evaluate(() => localStorage.getItem('tesorero_ap_v9_recordar'));
    const v9CuentaId  = await page.evaluate(() => localStorage.getItem('tesorero_ap_v9_cuentaId'));
    const v9AluId     = await page.evaluate(() => localStorage.getItem('tesorero_ap_v9_alumnoId'));
    const v9AluNombre = await page.evaluate(() => localStorage.getItem('tesorero_ap_v9_alumnoNombre'));

    ok('R05a: v9_recordar=1 en localStorage', v9Recordar === '1');
    ok('R05b: cuentaId guardado en localStorage', !!v9CuentaId);
    ok('R05c: alumnoId guardado en localStorage', !!v9AluId);
    ok('R05d: alumnoNombre guardado en localStorage', !!v9AluNombre);

    // ── R06: PIN NO persistido ───────────────────────────────────────────────
    const keysConPin = await page.evaluate(() => {
      const peligrosas = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.toLowerCase().includes('pin')) peligrosas.push(k);
      }
      return peligrosas;
    });
    ok('R06: PIN NO persistido en localStorage', keysConPin.length === 0,
       keysConPin.length > 0 ? 'claves peligrosas: ' + keysConPin.join(', ') : '');

    // ── R07: Panel de acceso rápido tras recarga ─────────────────────────────
    await page.reload({ waitUntil: 'domcontentloaded' });
    const tabCodigo2 = page.locator('[onclick="switchLoginTab(\'codigo\')"]');
    if (await tabCodigo2.count()) await tabCodigo2.click();

    const panelRapido = await page.waitForSelector(
      '#panel-ap-rapido', { state: 'visible', timeout: 6000 }
    ).catch(() => null);
    ok('R07: panel de acceso rápido visible tras recarga', !!panelRapido);
    if (panelRapido) {
      const nombrePanelText = await page.locator('#ap-rapido-nombre').textContent().catch(() => '');
      ok('R07b: nombre del alumno visible en panel rápido',
         !!nombrePanelText && nombrePanelText.trim().length > 3,
         `texto="${nombrePanelText}"`);
    }

    // ── R08: paso-pin visible directamente al presionar "Ingresar a mi cuenta" ─
    if (panelRapido) {
      const btnRapido = page.locator('[onclick="reingresarApoderado()"]');
      await btnRapido.click();
      const pinDirecto = await page.waitForSelector('#paso-pin', { state: 'visible', timeout: 4000 })
        .catch(() => null);
      ok('R08: paso-pin visible directamente (sin ingresar código)', !!pinDirecto);
      const codigoOculto = await page.evaluate(() => {
        const el = document.getElementById('paso-codigo');
        return el && (el.style.display === 'none' || el.offsetParent === null);
      });
      ok('R08b: paso-codigo oculto en acceso rápido', codigoOculto);
    } else {
      ok('R08: paso-pin visible directamente (skip — panel no encontrado)', false, 'skip');
      ok('R08b: paso-codigo oculto en acceso rápido', false, 'skip');
    }

    // ── R09: PIN incorrecto → error visible, sesión NO creada ───────────────
    await page.fill('#l-pin', '0000-incorrecto');
    await page.click('[onclick="doAccesoCodigo()"]');
    const pinErr = await page.waitForSelector('#pin-err', { state: 'visible', timeout: 5000 })
      .catch(() => null);
    ok('R09a: mensaje de error visible con PIN incorrecto', !!pinErr);
    const pinErrText = pinErr ? await page.locator('#pin-err').textContent() : '';
    ok('R09b: mensaje de error no vacío', !!pinErrText && pinErrText.trim().length > 0);
    const noSesion = await page.evaluate(() =>
      !window.S?.session || !String(window.S?.session?.id || '').startsWith('ap_v9'));
    ok('R09c: sesión NO creada con PIN incorrecto', noSesion);

    // ── R10: PIN correcto vía acceso rápido → dashboard ──────────────────────
    await page.fill('#l-pin', FIXTURE_PIN);
    await page.click('[onclick="doAccesoCodigo()"]');
    const enDash2 = await page.waitForFunction(
      () => window.S?.route === 'dashboard', { timeout: 8000 }
    ).then(() => true).catch(() => false);
    ok('R10: acceso rápido con PIN correcto → dashboard', enDash2);

    // ── R11: logoutLector conserva claves V9 ────────────────────────────────
    await page.evaluate(() => { if (typeof logoutLector === 'function') logoutLector(); });
    await page.waitForTimeout(500);
    const v9RecordarPost = await page.evaluate(() => localStorage.getItem('tesorero_ap_v9_recordar'));
    const v9CuentaPost   = await page.evaluate(() => localStorage.getItem('tesorero_ap_v9_cuentaId'));
    ok('R11a: v9_recordar conservado tras logoutLector', v9RecordarPost === '1');
    ok('R11b: v9_cuentaId conservado tras logoutLector', !!v9CuentaPost);

    // ── R12: logout (tesorero) limpia claves V9 ──────────────────────────────
    await page.evaluate(() => {
      localStorage.setItem('tesorero_ap_v9_recordar', '1');
      localStorage.setItem('tesorero_ap_v9_cuentaId', 'test-cuenta');
      localStorage.setItem('tesorero_ap_v9_alumnoId', 'test-alu');
      if (typeof logout === 'function') logout();
    });
    await page.waitForTimeout(1000);
    const v9RecordarLogout = await page.evaluate(() => localStorage.getItem('tesorero_ap_v9_recordar'));
    ok('R12: v9_recordar limpiado tras logout()', !v9RecordarLogout);

    // ── R13: limpiarSesionApoderado borra contexto V9 ────────────────────────
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      localStorage.setItem('tesorero_ap_v9_recordar', '1');
      localStorage.setItem('tesorero_ap_v9_cuentaId', 'test-cuenta');
    });
    const tabCodigo3 = page.locator('[onclick="switchLoginTab(\'codigo\')"]');
    if (await tabCodigo3.count()) await tabCodigo3.click();
    await page.evaluate(() => {
      if (typeof limpiarSesionApoderado === 'function') limpiarSesionApoderado();
    });
    await page.waitForTimeout(300);
    const v9RecordarLimpiado = await page.evaluate(() => localStorage.getItem('tesorero_ap_v9_recordar'));
    ok('R13: v9_recordar limpiado tras limpiarSesionApoderado()', !v9RecordarLimpiado);

  } finally {
    await browser.close();
    // ── Teardown: eliminar fixtures ─────────────────────────────────────────
    console.log('\n── Teardown fixtures ─────────────────────────');
    await eliminarFixtures(H);
    if (server) server.close();
  }

  // ── Resumen ──────────────────────────────────────────────────────────────
  console.log('\n────────────────────────────────────────────');
  console.log(` RESULTADO: ${passed}/${passed+failed} pruebas pasaron`);
  if (failed > 0) {
    console.log('\n Fallos:');
    results.filter(r => !r.cond).forEach(r =>
      console.error(`   ❌ ${r.label}${r.detail ? ' — '+r.detail : ''}`));
  }
  console.log('────────────────────────────────────────────\n');
  process.exit(failed > 0 ? 1 : 0);
})();
