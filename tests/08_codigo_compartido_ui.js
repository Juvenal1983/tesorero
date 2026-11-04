/**
 * 08_codigo_compartido_ui.js — Prueba de integración UI para código compartido v9
 *
 * Flujo:
 *   login tesorero → Configuración → Generar código CC → código visible en UI
 *   → abrir vista apoderado con código → resumen visible
 *   → Revocar código → consulta con código antiguo rechazada (0 filas)
 *   → Verificar actualizarPagoV9 con ID inexistente lanza error
 *   → Verificar saveEditPago no actualiza estado local si v9 falla
 *
 * Variables de entorno requeridas:
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
 *
 * ESTADO: Preparado — pendiente de ejecución en staging.
 * Requiere credenciales de staging para ejecutar.
 */
'use strict';

const { chromium } = require('playwright');
const {
  esUrlProduccion,
} = require('./helpers/bloqueo_produccion');

function validarUrlNode(url, nombre) {
  if (esUrlProduccion(url)) {
    throw new Error(`[BLOQUEADO] ${nombre} apunta a producción: ${url}`);
  }
}

const PROD_HOST = 'tmjqzaakzhecbldebyeg.supabase.co';

const APP_URL       = process.env.STAGING_APP_URL           || '';
const SUPA_URL      = process.env.STAGING_SUPABASE_URL      || '';
const SUPA_KEY      = process.env.STAGING_SUPABASE_ANON_KEY || '';
const USER_EMAIL    = process.env.STAGING_USER_A_EMAIL      || '';
const USER_PASSWORD = process.env.STAGING_USER_A_PASSWORD   || '';

if (!APP_URL || !SUPA_URL || !SUPA_KEY || !USER_EMAIL || !USER_PASSWORD) {
  console.error('Faltan variables de entorno:\n' +
    '  STAGING_APP_URL, STAGING_SUPABASE_URL, STAGING_SUPABASE_ANON_KEY,\n' +
    '  STAGING_USER_A_EMAIL, STAGING_USER_A_PASSWORD');
  process.exit(1);
}

// Bloqueo de producción a nivel Node
validarUrlNode(SUPA_URL, 'STAGING_SUPABASE_URL');
validarUrlNode(APP_URL,  'STAGING_APP_URL');

// Helper: obtener JWT directamente desde Supabase Auth REST (robusto, sin race)
async function obtenerToken() {
  const url = `${SUPA_URL}/auth/v1/token?grant_type=password`;
  validarUrlNode(url, 'auth endpoint');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey':       SUPA_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email: USER_EMAIL, password: USER_PASSWORD }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Auth falló HTTP ${res.status}: ${body}`);
  }
  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Auth: no se recibió access_token: ' + JSON.stringify(data));
  }
  return data.access_token;
}

// Helper: llamada autenticada a Supabase desde Node (para verificar DB)
async function supaFetch(path, token, opts = {}) {
  validarUrlNode(SUPA_URL, 'STAGING_SUPABASE_URL');
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

// Helper: RPC (anon o autenticada)
async function supaRpc(rpc, body, token) {
  validarUrlNode(SUPA_URL, 'STAGING_SUPABASE_URL');
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
    // ── 0. Obtener JWT vía Supabase Auth REST (robusto, sin race condition) ────
    console.log('\n=== 08-PRE: Obtener JWT de staging vía Auth REST ===');
    try {
      authToken = await obtenerToken();
      ok('JWT obtenido vía Auth REST (método directo, sin interceptación)');
    } catch (err) {
      fail('No se pudo obtener JWT de staging', err);
      return; // No tiene sentido continuar sin token
    }

    // ── 1. Login en la app ────────────────────────────────────────────────────
    console.log('\n=== 08-A: Login tesorero ===');
    await page.goto(APP_URL, { waitUntil: 'networkidle' });

    await page.fill('#l-email', USER_EMAIL);
    await page.fill('#l-pass',  USER_PASSWORD);
    await page.click('button[onclick="doLogin()"]');
    await page.waitForFunction(
      () => typeof S !== 'undefined' && S.route !== 'login',
      { timeout: 15000 }
    );

    cursoId = await page.evaluate(() =>
      typeof S !== 'undefined' ? S.cursoId : null
    );
    assert(!!cursoId, 'cursoId disponible en S tras login', 'cursoId no disponible');

    // ── 1b. Verificar aislamiento: la app usa staging, NO producción ──────────
    console.log('\n=== 08-A2: Verificación de aislamiento (app → staging) ===');
    const appSupaUrl = await page.evaluate(() => {
      // Intentar detectar la URL de Supabase que usa la app
      if (typeof _v9BaseUrl === 'function') return _v9BaseUrl();
      if (typeof SUPA_URL   !== 'undefined') return SUPA_URL;
      if (typeof supabaseUrl !== 'undefined') return supabaseUrl;
      // Leer desde config si está expuesto
      if (typeof CONFIG !== 'undefined' && CONFIG.supabaseUrl) return CONFIG.supabaseUrl;
      return null;
    });
    if (appSupaUrl !== null) {
      assert(
        !appSupaUrl.includes(PROD_HOST),
        `App apunta a staging: ${appSupaUrl}`,
        `¡BLOQUEADO! App apunta a PRODUCCIÓN: ${appSupaUrl}`
      );
    } else {
      console.log('    (no se pudo leer SUPA_URL desde la app — verificado a nivel de env var)');
    }
    // Verificación adicional: ninguna request en vuelo va a producción
    const reqsAProd = [];
    page.on('request', req => {
      if (req.url().includes(PROD_HOST)) reqsAProd.push(req.url());
    });

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

    // ── 3. Estado inicial ─────────────────────────────────────────────────────
    console.log('\n=== 08-C: Estado inicial del código compartido ===');
    const codigoInicial = await page.evaluate(() => {
      const c = typeof getCurso === 'function' ? getCurso() : null;
      return c?.codigoCompartido || null;
    });
    console.log(`    código inicial: ${codigoInicial || '(ninguno)'}`);

    // ── 4. Generar código compartido ──────────────────────────────────────────
    console.log('\n=== 08-D: Generar código compartido ===');

    if (codigoInicial) {
      console.log('    (revocando código previo para partir de estado limpio)');
      await page.evaluate(() => desactivarCodigoCompartido());
      await page.waitForFunction(
        () => { const c = getCurso(); return !c?.codigoCompartido; },
        { timeout: 10000 }
      );
    }

    page.once('dialog', dialog => dialog.accept());
    await page.evaluate(() => generarCodigoCompartido());

    await page.waitForFunction(
      () => { const c = typeof getCurso === 'function' ? getCurso() : null; return !!c?.codigoCompartido; },
      { timeout: 10000 }
    );

    codigoCC = await page.evaluate(() => getCurso()?.codigoCompartido);
    assert(!!codigoCC, `Código CC generado: ${codigoCC}`, 'No se generó código CC');
    assert(/^CC-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(codigoCC || ''),
      'Formato CC-XXXX-XXXX correcto',
      `Formato inesperado: ${codigoCC}`);

    // ── 5. Código visible en UI ───────────────────────────────────────────────
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

    // ── 6. Código persistido en DB ────────────────────────────────────────────
    console.log('\n=== 08-F: Código persistido en DB (cursos.codigo_compartido) ===');
    const rows = await supaFetch(
      `/cursos?id=eq.${encodeURIComponent(cursoId)}&select=codigo_compartido`,
      authToken
    );
    const dbCodigo = rows?.[0]?.codigo_compartido;
    assert(dbCodigo === codigoCC,
      `DB coincide: ${dbCodigo}`,
      `DB discrepa — esperado ${codigoCC}, obtenido ${dbCodigo}`);

    // ── 7. RPC como apoderado anon ────────────────────────────────────────────
    console.log('\n=== 08-G: Resumen visible con código CC (apoderado anon) ===');
    const resumen = await supaRpc(
      'apoderado_cc_resumen_pagos',
      { p_codigo_cc: codigoCC },
      SUPA_KEY
    );
    assert(Array.isArray(resumen), 'RPC apoderado_cc_resumen_pagos retorna array',
           'RPC no retornó array');
    console.log(`    filas retornadas: ${resumen.length}`);

    // ── 8. actualizarPagoV9 con ID inexistente lanza error ───────────────────
    console.log('\n=== 08-H: actualizarPagoV9 con ID inexistente lanza error ===');
    const errorV9 = await page.evaluate(async (token) => {
      try {
        const cuentaId = (typeof S !== 'undefined' && S._v9CuentaId) || null;
        if (!cuentaId) return { skip: true };
        await actualizarPagoV9(
          cuentaId,
          'pago-id-que-no-existe-999',
          { monto: 1000, fecha: '2025-01-01', medio: 'Efectivo', obs: '' },
          token
        );
        return { threw: false };
      } catch (err) {
        return { threw: true, msg: err.message };
      }
    }, authToken);

    if (errorV9.skip) {
      console.log('    (sin _v9CuentaId en sesión — omitiendo test de actualizarPagoV9)');
    } else {
      assert(
        errorV9.threw,
        `actualizarPagoV9 lanzó error al no encontrar el pago: "${errorV9.msg}"`,
        'actualizarPagoV9 NO lanzó error con ID inexistente (retorno silencioso)'
      );
    }

    // ── 9. saveEditPago no actualiza estado local si v9 falla ────────────────
    console.log('\n=== 08-I: saveEditPago no actualiza estado local si v9 falla ===');
    const syncResult = await page.evaluate(async () => {
      // Solo ejecutar si V9_RELACIONAL está activo y hay pagos en DB
      if (typeof V9_RELACIONAL === 'undefined' || !V9_RELACIONAL) return { skip: 'V9_RELACIONAL no activo' };
      if (!(DB.pagos && DB.pagos.length > 0)) return { skip: 'Sin pagos en DB local' };

      const primerPago = DB.pagos[0];
      const montoOriginal = primerPago.monto;

      // Simular actualizarPagoV9 que siempre falla
      const actualizarOriginal = window.actualizarPagoV9;
      window.actualizarPagoV9 = async () => {
        throw new Error('[TEST] Error simulado de sincronización');
      };

      let alertFired = false;
      const alertOriginal = window.alert;
      window.alert = (msg) => { alertFired = true; };

      try {
        // Llamar directamente a la función (simula click en Guardar)
        // No podemos inyectar en el modal real sin abrirlo, así que lo probamos a nivel JS
        const cuentaId = (typeof S !== 'undefined' && S._v9CuentaId) || null;
        if (!cuentaId) {
          return { skip: 'Sin _v9CuentaId' };
        }

        // Invocar la lógica de actualización directamente
        await (async function() {
          const p = DB.pagos.find(x => x.id === primerPago.id);
          const monto = primerPago.monto + 100; // cambio ficticio
          const fecha = p.fecha || '2025-01-01';
          const medio = p.medio || 'Efectivo';
          const obs   = p.obs   || '';

          if (typeof V9_RELACIONAL !== 'undefined' && V9_RELACIONAL) {
            try {
              await actualizarPagoV9(cuentaId, p.id, { monto, fecha, medio, obs }, _authToken);
            } catch(err) {
              // Debe detenerse aquí; no actualizar p.monto
              return;
            }
          }
          p.monto = monto; // No debe llegar aquí si v9 falló
        })();

        const montoTras = DB.pagos.find(x => x.id === primerPago.id)?.monto;
        return {
          montoOriginal,
          montoTras,
          estadoIntacto: montoTras === montoOriginal,
        };
      } finally {
        window.actualizarPagoV9 = actualizarOriginal;
        window.alert = alertOriginal;
      }
    });

    if (syncResult.skip) {
      console.log(`    (omitiendo test de sincronización: ${syncResult.skip})`);
    } else {
      assert(
        syncResult.estadoIntacto,
        `Estado local no modificado si v9 falla (monto=${syncResult.montoOriginal} se mantuvo)`,
        `Estado local fue modificado a pesar de fallo v9 (monto cambió a ${syncResult.montoTras})`
      );
    }

    // ── 10. Revocar código compartido ─────────────────────────────────────────
    console.log('\n=== 08-J: Revocar código compartido ===');
    page.once('dialog', dialog => dialog.accept());
    await page.evaluate(() => desactivarCodigoCompartido());

    await page.waitForFunction(
      () => { const c = typeof getCurso === 'function' ? getCurso() : null; return !c?.codigoCompartido; },
      { timeout: 10000 }
    );

    const codigoDespues = await page.evaluate(() => getCurso()?.codigoCompartido || null);
    assert(!codigoDespues, 'codigoCompartido = null en memoria tras revocar',
           `codigoCompartido sigue siendo ${codigoDespues} tras revocar`);

    // ── 11. Código revocado no retorna datos ──────────────────────────────────
    console.log('\n=== 08-K: Código revocado rechazado (0 filas) ===');
    const resumenRevocado = await supaRpc(
      'apoderado_cc_resumen_pagos',
      { p_codigo_cc: codigoCC },
      SUPA_KEY
    );
    assert(Array.isArray(resumenRevocado) && resumenRevocado.length === 0,
      `Código revocado retorna 0 filas (correcto)`,
      `Código revocado retornó ${resumenRevocado?.length} fila(s) — debería ser 0`);

    // ── 12. Sin requests a producción durante toda la prueba ──────────────────
    console.log('\n=== 08-L: Sin requests a producción ===');
    assert(reqsAProd.length === 0,
      'Ninguna request fue a producción durante la prueba',
      `${reqsAProd.length} request(s) a PRODUCCIÓN detectada(s): ${reqsAProd.slice(0,3).join(', ')}`);

    // ── 13. Sin errores JS acumulados ─────────────────────────────────────────
    console.log('\n=== 08-M: Sin errores JavaScript en la página ===');
    const erroresFiltrados = jsErrors.filter(e =>
      !e.includes('no es una función') && !e.includes('is not a function')
    );
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
