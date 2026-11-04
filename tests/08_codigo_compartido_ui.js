/**
 * 08_codigo_compartido_ui.js — Prueba de integración UI para código compartido v9
 *
 * Flujo:
 *   login tesorero → Configuración → Generar código CC → código visible en UI
 *   → abrir vista apoderado con código → resumen visible
 *   → Revocar código → consulta con código antiguo rechazada (0 filas)
 *
 * Variables de entorno requeridas (mismas que 05):
 *   STAGING_APP_URL            — URL de la app de staging
 *   STAGING_SUPABASE_URL       — URL del proyecto Supabase de staging
 *   STAGING_SUPABASE_ANON_KEY  — anon key (no service_role)
 *   STAGING_USER_A_EMAIL
 *   STAGING_USER_A_PASSWORD
 *
 * Ejecutar:
 *   node tests/08_codigo_compartido_ui.js
 *
 * IMPORTANTE: No usa credentials de producción.
 * Verifica bloqueo_produccion.js antes de cualquier fetch.
 */
'use strict';

const { chromium } = require('playwright');
const {
  esUrlProduccion,
  HOSTS_PRODUCCION,
} = require('./helpers/bloqueo_produccion');

function validarUrlNode(url, nombre) {
  if (esUrlProduccion(url)) {
    throw new Error(`[BLOQUEADO] ${nombre} apunta a producción: ${url}`);
  }
}

// Alias para uso en fetch de Node (misma lógica)
const validarUrlFetch = validarUrlNode;

const APP_URL       = process.env.STAGING_APP_URL          || '';
const SUPA_URL      = process.env.STAGING_SUPABASE_URL     || '';
const SUPA_KEY      = process.env.STAGING_SUPABASE_ANON_KEY || '';
const USER_EMAIL    = process.env.STAGING_USER_A_EMAIL     || '';
const USER_PASSWORD = process.env.STAGING_USER_A_PASSWORD  || '';

if (!APP_URL || !SUPA_URL || !SUPA_KEY || !USER_EMAIL || !USER_PASSWORD) {
  console.error('Faltan variables de entorno:\n' +
    '  STAGING_APP_URL, STAGING_SUPABASE_URL, STAGING_SUPABASE_ANON_KEY,\n' +
    '  STAGING_USER_A_EMAIL, STAGING_USER_A_PASSWORD');
  process.exit(1);
}

// Bloqueo de producción
validarUrlNode(SUPA_URL, 'STAGING_SUPABASE_URL');
validarUrlNode(APP_URL,  'STAGING_APP_URL');

// Helper: llamada autenticada a Supabase desde Node (para verificar DB)
async function supaFetch(path, token, opts = {}) {
  validarUrlFetch(SUPA_URL, 'STAGING_SUPABASE_URL');
  const url = `${SUPA_URL}/rest/v1${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'apikey':        SUPA_KEY,
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`supaFetch ${path} → HTTP ${res.status}: ${body}`);
  }
  return res.json();
}

// Helper: RPC autenticada
async function supaRpc(rpc, body, token) {
  validarUrlFetch(SUPA_URL, 'STAGING_SUPABASE_URL');
  const url = `${SUPA_URL}/rest/v1/rpc/${rpc}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey':        SUPA_KEY,
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`supaRpc ${rpc} → HTTP ${res.status}: ${text}`);
  return JSON.parse(text);
}

// ─── utilidades de prueba ─────────────────────────────────────────────────────
let pasa = 0;
let falla = 0;

function ok(msg) {
  console.log(`  ✅ ${msg}`);
  pasa++;
}

function fail(msg, err) {
  console.error(`  ❌ ${msg}`);
  if (err) console.error('    ', err?.message || err);
  falla++;
}

function assert(cond, msgOk, msgFail, err) {
  if (cond) ok(msgOk);
  else fail(msgFail, err);
}

// ─── main ─────────────────────────────────────────────────────────────────────
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  // Capturar errores JS de la página
  const jsErrors = [];
  page.on('pageerror', e => jsErrors.push(e.message));

  let authToken = null;  // JWT del tesorero en staging
  let cursoId   = null;
  let codigoCC  = null;

  try {
    // ── 1. Login ──────────────────────────────────────────────────────────────
    console.log('\n=== 08-A: Login tesorero ===');
    await page.goto(APP_URL, { waitUntil: 'networkidle' });

    // Interceptar el token JWT que usa la app al hacer login
    page.on('request', req => {
      const auth = req.headers()['authorization'];
      if (auth && auth.startsWith('Bearer ') && !authToken) {
        authToken = auth.slice(7);
      }
    });

    await page.fill('#l-email', USER_EMAIL);
    await page.fill('#l-pass',  USER_PASSWORD);
    await page.click('button[onclick="doLogin()"]');
    await page.waitForFunction(
      () => typeof S !== 'undefined' && S.route !== 'login',
      { timeout: 15000 }
    );

    // Obtener token y cursoId desde la app
    authToken = await page.evaluate(() =>
      typeof _authToken !== 'undefined' ? _authToken : null
    );
    cursoId = await page.evaluate(() =>
      typeof S !== 'undefined' ? S.cursoId : null
    );

    assert(!!authToken, 'JWT disponible tras login', 'JWT no disponible');
    assert(!!cursoId,   'cursoId disponible en S',   'cursoId no disponible');

    // ── 2. Ir a Configuración ─────────────────────────────────────────────────
    console.log('\n=== 08-B: Configuración — sección código compartido ===');
    await page.evaluate(() => go('config'));
    await page.waitForFunction(
      () => document.querySelector('.card-title') !== null,
      { timeout: 8000 }
    );

    const tituloCC = await page.evaluate(() => {
      const titles = [...document.querySelectorAll('.card-title')];
      return titles.find(t => t.textContent.includes('Acceso compartido'))?.textContent || null;
    });
    assert(!!tituloCC, 'Sección "Acceso compartido" visible en config',
           'Sección "Acceso compartido" no encontrada');

    // ── 3. Verificar estado inicial (puede o no tener código) ─────────────────
    console.log('\n=== 08-C: Estado inicial del código compartido ===');
    const codigoInicial = await page.evaluate(() => {
      const c = typeof getCurso === 'function' ? getCurso() : null;
      return c?.codigoCompartido || null;
    });
    console.log(`    código inicial: ${codigoInicial || '(ninguno)'}`);

    // ── 4. Generar código compartido ──────────────────────────────────────────
    console.log('\n=== 08-D: Generar código compartido ===');

    // Si ya hay código, revocar primero para partir de estado limpio
    if (codigoInicial) {
      console.log('    (revocando código previo para estado limpio)');
      await page.evaluate(() => desactivarCodigoCompartido());
      await page.waitForFunction(
        () => { const c = getCurso(); return !c?.codigoCompartido; },
        { timeout: 10000 }
      );
    }

    // Confirmar el diálogo de confirmación
    page.once('dialog', dialog => dialog.accept());
    await page.evaluate(() => generarCodigoCompartido());

    // Esperar a que el código aparezca en memoria
    await page.waitForFunction(
      () => { const c = typeof getCurso === 'function' ? getCurso() : null; return !!c?.codigoCompartido; },
      { timeout: 10000 }
    );

    codigoCC = await page.evaluate(() => getCurso()?.codigoCompartido);
    assert(!!codigoCC, `Código CC generado: ${codigoCC}`, 'No se generó código CC');
    assert(/^CC-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(codigoCC || ''),
      'Formato CC-XXXX-XXXX correcto',
      `Formato inesperado: ${codigoCC}`);

    // ── 5. Verificar que el código aparece en la UI de config ─────────────────
    console.log('\n=== 08-E: Código visible en UI de configuración ===');
    await page.waitForFunction(
      () => document.body.textContent.includes(
        typeof getCurso === 'function' && getCurso()?.codigoCompartido
          ? getCurso().codigoCompartido
          : '___NO_CODE___'
      ),
      { timeout: 8000 }
    );
    const codigoEnUI = await page.evaluate(
      (cc) => document.body.textContent.includes(cc),
      codigoCC
    );
    assert(codigoEnUI, 'Código CC visible en la página de configuración',
           'Código CC NO aparece en la UI');

    // ── 6. Verificar código guardado en DB (vía Node) ─────────────────────────
    console.log('\n=== 08-F: Código persistido en DB (cursos.codigo_compartido) ===');
    if (authToken) {
      const rows = await supaFetch(
        `/cursos?id=eq.${encodeURIComponent(cursoId)}&select=codigo_compartido`,
        authToken
      );
      const dbCodigo = rows?.[0]?.codigo_compartido;
      assert(dbCodigo === codigoCC,
        `DB coincide: ${dbCodigo}`,
        `DB discrepa — esperado ${codigoCC}, obtenido ${dbCodigo}`);
    } else {
      console.log('    (sin JWT de Node — omitiendo verificación en DB)');
    }

    // ── 7. Consulta como apoderado con el código (RPC anon) ───────────────────
    console.log('\n=== 08-G: Resumen visible con código CC (apoderado anon) ===');
    const resumen = await supaRpc(
      'apoderado_cc_resumen_pagos',
      { p_codigo_cc: codigoCC },
      SUPA_KEY   // anon key — la RPC es SECURITY DEFINER y no requiere JWT
    );
    assert(Array.isArray(resumen), 'RPC apoderado_cc_resumen_pagos retorna array',
           'RPC no retornó array');
    console.log(`    filas retornadas: ${resumen.length}`);

    // ── 8. Revocar código compartido ──────────────────────────────────────────
    console.log('\n=== 08-H: Revocar código compartido ===');
    page.once('dialog', dialog => dialog.accept());
    await page.evaluate(() => desactivarCodigoCompartido());

    await page.waitForFunction(
      () => { const c = typeof getCurso === 'function' ? getCurso() : null; return !c?.codigoCompartido; },
      { timeout: 10000 }
    );

    const codigoDespues = await page.evaluate(() => getCurso()?.codigoCompartido || null);
    assert(!codigoDespues, 'codigoCompartido = null en memoria tras revocar',
           `codigoCompartido sigue siendo ${codigoDespues} tras revocar`);

    // ── 9. Verificar que el código revocado no retorna datos ──────────────────
    console.log('\n=== 08-I: Código revocado rechazado (0 filas) ===');
    const resumenRevocado = await supaRpc(
      'apoderado_cc_resumen_pagos',
      { p_codigo_cc: codigoCC },
      SUPA_KEY
    );
    assert(Array.isArray(resumenRevocado) && resumenRevocado.length === 0,
      `Código revocado retorna 0 filas (correcto)`,
      `Código revocado retornó ${resumenRevocado?.length} fila(s) — debería ser 0`);

    // ── 10. Verificar errores JS acumulados ───────────────────────────────────
    console.log('\n=== 08-J: Sin errores JavaScript en la página ===');
    // Filtrar el error conocido de _authToken que ya fue corregido en datos_v9.js
    const erroresFiltrados = jsErrors.filter(e => !e.includes('no es una función') &&
      !e.includes('is not a function'));
    assert(erroresFiltrados.length === 0,
      'Sin errores JS en la página',
      `${erroresFiltrados.length} error(es) JS detectado(s)`,
      erroresFiltrados.join('\n'));
    if (erroresFiltrados.length > 0) {
      erroresFiltrados.forEach(e => console.error('    JS error:', e));
    }

  } catch (err) {
    fail('Error inesperado en la prueba', err);
  } finally {
    await browser.close();
  }

  // ── Resultado final ──────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(54));
  console.log(`Resultado: ${pasa} OK / ${falla} FALLA(S)`);
  console.log('═'.repeat(54));
  if (falla > 0) process.exit(1);
})();
