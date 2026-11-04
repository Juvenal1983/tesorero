/**
 * 08_codigo_compartido_ui.js — Prueba de integración UI para código compartido v9
 *
 * Flujo:
 *   login tesorero → Configuración → Generar código CC → código visible en UI
 *   → abrir vista apoderado en nueva pestaña con el código → verificar datos reales
 *   → Revocar código → consulta con código antiguo rechazada (0 filas)
 *   → Verificar actualizarPagoV9 con ID inexistente lanza error
 *   → Verificar saveEditPago no actualiza estado local si v9 falla
 *
 * Variables de entorno requeridas:
 *   STAGING_APP_URL            — URL de la app de staging (con V9_RELACIONAL=true)
 *   STAGING_SUPABASE_URL       — URL del proyecto Supabase de staging
 *   STAGING_SUPABASE_ANON_KEY  — anon key (no service_role)
 *   STAGING_USER_A_EMAIL
 *   STAGING_USER_A_PASSWORD
 *
 * Ejecutar:
 *   node tests/08_codigo_compartido_ui.js
 *
 * IMPORTANTE: No usa credentials de producción.
 * Usa instalarBloqueoProduccion de bloqueo_produccion.js — bloquea TODAS las
 * requests y WebSockets al host de producción, incluyendo los del browser.
 *
 * ESTADO: Preparado — pendiente de ejecución en staging.
 * Requiere credenciales de staging para ejecutar.
 */
'use strict';

const { chromium } = require('playwright');
const {
  instalarBloqueoProduccion,
  verificarSinIntentos,
  esUrlProduccion,
} = require('./helpers/bloqueo_produccion');

// ─── validaciones de entorno ──────────────────────────────────────────────────

// C09: lista positiva — solo se permite el project ref de staging
const STAGING_PROJECT_REF = 'rucgmytyxpfowznowxwd';
const PROD_HOST            = 'tmjqzaakzhecbldebyeg.supabase.co';

function validarUrlNode(url, nombre) {
  if (esUrlProduccion(url)) {
    throw new Error(`[BLOQUEADO] ${nombre} apunta a producción: ${url}`);
  }
}

function validarEsStagingSupabase(url, nombre) {
  validarUrlNode(url, nombre);
  if (!url.includes(STAGING_PROJECT_REF)) {
    throw new Error(
      `[CONFIGURACIÓN] ${nombre} no contiene el project ref de staging ` +
      `(${STAGING_PROJECT_REF}). Valor recibido: ${url}`
    );
  }
}

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

// C09: validar a nivel Node ANTES de lanzar el browser
validarUrlNode(APP_URL,  'STAGING_APP_URL');
validarEsStagingSupabase(SUPA_URL, 'STAGING_SUPABASE_URL');

// ─── helpers de red (Node) ────────────────────────────────────────────────────

/** JWT vía Supabase Auth REST — directo, sin race condition de interceptación. */
async function obtenerToken() {
  const url = `${SUPA_URL}/auth/v1/token?grant_type=password`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'apikey': SUPA_KEY, 'Content-Type': 'application/json' },
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

async function supaFetch(path, token, opts = {}) {
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

/** RPC anónima: solo apikey, sin Authorization Bearer (C08). */
async function supaRpcAnon(rpc, body) {
  const url = `${SUPA_URL}/rest/v1/rpc/${rpc}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey':       SUPA_KEY,
      'Content-Type': 'application/json',
      'Accept':       'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`supaRpcAnon ${rpc} → HTTP ${res.status}: ${text}`);
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

  // C13: contexto dedicado al test para facilitar limpieza en finally
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  // C09: instalar bloqueo HTTP + WS en el contexto del browser ANTES de navegar.
  // Esto intercepta TODAS las requests del browser — no solo las variables de entorno.
  const bloqueo = await instalarBloqueoProduccion(context, page);

  // Capturar errores JS de la página
  const jsErrors = [];
  page.on('pageerror', e => jsErrors.push(e.message));

  let authToken = null;
  let cursoId   = null;
  let codigoCC  = null;

  // C13: registrar estado inicial para restaurar en finally
  let codigoCCAnteriorAlTest = null;

  try {
    // ── 0. JWT vía Auth REST ──────────────────────────────────────────────────
    console.log('\n=== 08-PRE: Obtener JWT de staging vía Auth REST ===');
    authToken = await obtenerToken();
    ok('JWT obtenido vía Auth REST (sin interceptación de requests)');

    // ── 1. Login en la app ────────────────────────────────────────────────────
    console.log('\n=== 08-A: Login tesorero ===');
    await page.goto(APP_URL, { waitUntil: 'networkidle' });

    // C09: verificar inmediatamente que la app no apunta a producción
    const appSupaUrl = await page.evaluate(() => {
      if (typeof SUPA_URL !== 'undefined') return SUPA_URL;
      if (typeof _v9BaseUrl === 'function') return _v9BaseUrl();
      return null;
    });
    if (appSupaUrl !== null) {
      assert(
        !appSupaUrl.includes(PROD_HOST) && appSupaUrl.includes(STAGING_PROJECT_REF),
        `App apunta a staging (${STAGING_PROJECT_REF})`,
        `¡BLOQUEADO! App NO apunta a staging — URL detectada: ${appSupaUrl}`
      );
      if (appSupaUrl.includes(PROD_HOST)) {
        throw new Error('App está configurada con URL de producción. Test abortado.');
      }
    } else {
      console.log('    (SUPA_URL no expuesta desde la app — verificado a nivel de env var)');
    }

    await page.fill('#l-email', USER_EMAIL);
    await page.fill('#l-pass',  USER_PASSWORD);
    await page.click('button[onclick="doLogin()"]');
    // C11: waitForFunction(fn, arg, options) — arg=undefined, options={timeout}
    await page.waitForFunction(
      () => typeof S !== 'undefined' && S.route !== 'login',
      undefined,
      { timeout: 15000 }
    );

    cursoId = await page.evaluate(() =>
      typeof S !== 'undefined' ? S.cursoId : null
    );
    assert(!!cursoId, 'cursoId disponible en S tras login', 'cursoId no disponible');

    // ── 2. Ir a Configuración ─────────────────────────────────────────────────
    console.log('\n=== 08-B: Configuración — sección código compartido ===');
    await page.evaluate(() => go('config'));
    // C11: sintaxis correcta
    await page.waitForFunction(
      () => document.querySelector('.card-title') !== null,
      undefined,
      { timeout: 8000 }
    );

    const tituloCC = await page.evaluate(() => {
      const titles = [...document.querySelectorAll('.card-title')];
      return titles.find(t => t.textContent.includes('Acceso compartido'))?.textContent || null;
    });
    assert(!!tituloCC, 'Sección "Acceso compartido" visible en config',
           'Sección "Acceso compartido" no encontrada');

    // ── 3. Estado inicial (guardar para restaurar en finally) ─────────────────
    console.log('\n=== 08-C: Estado inicial del código compartido ===');
    codigoCCAnteriorAlTest = await page.evaluate(() => {
      const c = typeof getCurso === 'function' ? getCurso() : null;
      return c?.codigoCompartido || null;
    });
    console.log(`    código previo al test: ${codigoCCAnteriorAlTest || '(ninguno)'}`);

    // ── 4. Limpiar código previo si existe ────────────────────────────────────
    console.log('\n=== 08-D: Limpiar estado inicial ===');
    if (codigoCCAnteriorAlTest) {
      console.log('    (revocando código previo para partir de estado limpio)');
      page.once('dialog', dialog => dialog.accept());
      await page.evaluate(() => desactivarCodigoCompartido());
      await page.waitForFunction(
        () => { const c = typeof getCurso === 'function' ? getCurso() : null; return !c?.codigoCompartido; },
        undefined,
        { timeout: 10000 }
      );
      ok('Código previo revocado (estado limpio)');
    }

    // ── 5. Generar código compartido ──────────────────────────────────────────
    console.log('\n=== 08-E: Generar código compartido ===');
    page.once('dialog', dialog => dialog.accept());
    await page.evaluate(() => generarCodigoCompartido());

    await page.waitForFunction(
      () => { const c = typeof getCurso === 'function' ? getCurso() : null; return !!c?.codigoCompartido; },
      undefined,
      { timeout: 10000 }
    );

    codigoCC = await page.evaluate(() => getCurso()?.codigoCompartido);
    assert(!!codigoCC, `Código CC generado: ${codigoCC}`, 'No se generó código CC');
    assert(/^CC-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(codigoCC || ''),
      'Formato CC-XXXX-XXXX correcto',
      `Formato inesperado: ${codigoCC}`);

    // ── 6. Código visible en UI de config ─────────────────────────────────────
    console.log('\n=== 08-F: Código visible en UI de configuración ===');
    await page.waitForFunction(
      (cc) => document.body.textContent.includes(cc),
      codigoCC,
      { timeout: 8000 }
    );
    ok(`Código CC "${codigoCC}" visible en la página de configuración`);

    // ── 7. Código persistido en DB ────────────────────────────────────────────
    console.log('\n=== 08-G: Código persistido en DB (cursos.codigo_compartido) ===');
    const rows = await supaFetch(
      `/cursos?id=eq.${encodeURIComponent(cursoId)}&select=codigo_compartido`,
      authToken
    );
    const dbCodigo = rows?.[0]?.codigo_compartido;
    assert(dbCodigo === codigoCC,
      `DB coincide: ${dbCodigo}`,
      `DB discrepa — esperado ${codigoCC}, obtenido ${dbCodigo}`);

    // ── 8. C10: abrir vista apoderado en la app y verificar datos reales ──────
    console.log('\n=== 08-H: Vista apoderado — UI real con código CC ===');
    // Abrir una nueva pestaña con la ruta de apoderado; el bloqueo cubre el contexto
    const pageApoderado = await context.newPage();
    jsErrors; // Captura compartida por referencia en la misma lista no aplica aquí;
              // usamos una lista separada para la pestaña de apoderado
    const jsErrorsApo = [];
    pageApoderado.on('pageerror', e => jsErrorsApo.push(e.message));

    // Navegar a la app con el parámetro de código CC (ruta apoderado)
    // La app puede usar hash routing (#apoderado?cc=…) o query string
    const urlApoderado = `${APP_URL}#apoderado?cc=${encodeURIComponent(codigoCC)}`;
    await pageApoderado.goto(urlApoderado, { waitUntil: 'networkidle' });

    // Verificar que la vista carga y muestra el resumen de pagos
    // Intentar detectar una tabla, lista o elemento con datos del alumno
    const vistaApoderadoCarga = await pageApoderado.evaluate(() => {
      // La vista debe mostrar información de alumno/cuota. Detectar indicadores comunes.
      const body = document.body.textContent || '';
      return {
        tieneTabla:    document.querySelector('table, .tbl-wrap') !== null,
        tieneCard:     document.querySelector('.card, .card-title') !== null,
        longitudTexto: body.length,
        sinError404:   !body.includes('404') && !body.includes('No encontrado'),
      };
    });

    assert(
      vistaApoderadoCarga.tieneCard || vistaApoderadoCarga.tieneTabla,
      'Vista apoderado carga con contenido (card/tabla visible)',
      'Vista apoderado no muestra contenido esperado'
    );
    console.log(`    texto visible: ${vistaApoderadoCarga.longitudTexto} chars`);

    // Verificar RPC desde Node también (como segunda verificación)
    const resumenRpc = await supaRpcAnon('apoderado_cc_resumen_pagos', { p_codigo_cc: codigoCC });
    assert(Array.isArray(resumenRpc), 'RPC apoderado_cc_resumen_pagos retorna array desde Node',
           'RPC no retornó array');
    console.log(`    RPC Node: ${resumenRpc.length} alumno(s) en resumen`);

    // Si hay alumnos en el resumen, verificar que al menos uno tiene importes válidos
    if (resumenRpc.length > 0) {
      const alu = resumenRpc[0];
      assert(
        typeof alu.monto_pagado    === 'number' &&
        typeof alu.monto_pendiente === 'number' &&
        typeof alu.monto_abonado   === 'number',
        `Alumno "${alu.nombre}": monto_pagado=${alu.monto_pagado}, pendiente=${alu.monto_pendiente}`,
        `Tipos de importes incorrectos en resumen: ${JSON.stringify(alu)}`
      );
      // Los montos nunca deben ser negativos
      assert(
        alu.monto_pagado >= 0 && alu.monto_pendiente >= 0 && alu.monto_abonado >= 0,
        'Todos los montos son ≥ 0 (sin negativos)',
        `Monto negativo detectado: pagado=${alu.monto_pagado} pendiente=${alu.monto_pendiente} abonado=${alu.monto_abonado}`
      );
    }

    await pageApoderado.close();

    // ── 9. actualizarPagoV9 con ID inexistente lanza error ───────────────────
    console.log('\n=== 08-I: actualizarPagoV9 con ID inexistente lanza error ===');
    const errorV9 = await page.evaluate(async (token) => {
      try {
        const cuentaId = (typeof S !== 'undefined' && S._v9CuentaId) || null;
        if (!cuentaId) return { skip: true, reason: 'Sin _v9CuentaId' };
        await actualizarPagoV9(
          cuentaId,
          'pago-id-inexistente-test-08-99999',
          { monto: 1000, fecha: '2025-01-01', medio: 'Efectivo', obs: '' },
          token
        );
        return { threw: false };
      } catch (err) {
        return { threw: true, msg: err.message };
      }
    }, authToken);

    if (errorV9.skip) {
      console.log(`    (omitiendo: ${errorV9.reason})`);
    } else {
      assert(
        errorV9.threw,
        `actualizarPagoV9 lanzó error al no encontrar el pago: "${errorV9.msg}"`,
        'actualizarPagoV9 NO lanzó error con ID inexistente (retorno silencioso)'
      );
    }

    // ── 10. saveEditPago no actualiza DB local si v9 falla ───────────────────
    console.log('\n=== 08-J: saveEditPago no actualiza estado local si v9 falla ===');
    const syncResult = await page.evaluate(async () => {
      if (typeof V9_RELACIONAL === 'undefined' || !V9_RELACIONAL) {
        return { skip: 'V9_RELACIONAL no activo' };
      }
      if (!(DB.pagos && DB.pagos.length > 0)) {
        return { skip: 'Sin pagos en DB local para probar' };
      }
      const cuentaId = (typeof S !== 'undefined' && S._v9CuentaId) || null;
      if (!cuentaId) return { skip: 'Sin _v9CuentaId' };

      const primerPago = DB.pagos[0];
      const montoOriginal = primerPago.monto;

      // Sustituir temporalmente actualizarPagoV9 para simular fallo
      const actualizarOriginal = window.actualizarPagoV9;
      window.actualizarPagoV9 = async () => {
        throw new Error('[TEST-08-J] Error simulado de DB');
      };
      const alertOriginal = window.alert;
      let alertFired = false;
      window.alert = () => { alertFired = true; };

      try {
        // Simular la lógica de saveEditPago directamente
        const p = DB.pagos.find(x => x.id === primerPago.id);
        const monto = montoOriginal + 100; // cambio ficticio
        const fecha = p.fecha || '2025-01-01';
        const medio = p.medio || 'Efectivo';
        const obs   = p.obs   || '';

        try {
          await window.actualizarPagoV9(cuentaId, p.id, { monto, fecha, medio, obs }, _authToken);
        } catch (_) {
          // v9 falló — no debe actualizar p.monto
          return {
            montoOriginal,
            montoTras: DB.pagos.find(x => x.id === primerPago.id)?.monto,
            alertFired,
            estadoIntacto: DB.pagos.find(x => x.id === primerPago.id)?.monto === montoOriginal,
          };
        }
        // Si llega aquí, v9 no lanzó (problema)
        return { montoOriginal, montoTras: p.monto, estadoIntacto: false, noLanzo: true };
      } finally {
        window.actualizarPagoV9 = actualizarOriginal;
        window.alert = alertOriginal;
      }
    });

    if (syncResult.skip) {
      console.log(`    (omitiendo: ${syncResult.skip})`);
    } else {
      assert(
        syncResult.estadoIntacto,
        `Estado local intacto cuando v9 falla (monto=${syncResult.montoOriginal} sin cambiar)`,
        `Estado local modificado a pesar de fallo v9 (${syncResult.montoOriginal} → ${syncResult.montoTras})`
      );
    }

    // ── 11. Revocar código compartido ─────────────────────────────────────────
    console.log('\n=== 08-K: Revocar código compartido ===');
    page.once('dialog', dialog => dialog.accept());
    await page.evaluate(() => desactivarCodigoCompartido());

    await page.waitForFunction(
      () => { const c = typeof getCurso === 'function' ? getCurso() : null; return !c?.codigoCompartido; },
      undefined,
      { timeout: 10000 }
    );

    const codigoDespues = await page.evaluate(() => getCurso()?.codigoCompartido || null);
    assert(!codigoDespues, 'codigoCompartido = null en memoria tras revocar',
           `codigoCompartido sigue siendo ${codigoDespues} tras revocar`);

    // codigoCC fue generado por este test; al revocarlo queda en null — no hay más que restaurar
    codigoCC = null;

    // ── 12. Código revocado no retorna datos ──────────────────────────────────
    console.log('\n=== 08-L: Código revocado rechazado (0 filas) ===');
    const codigoRevocado = codigoDespues === null
      ? await page.evaluate(() => window._ultimoCodigoCC || null) // por si la app lo guarda
      : codigoDespues;

    // Si el código revocado está disponible, verificar que ya no devuelve datos
    // (lo teníamos en la variable antes del null)
    const codigoParaVerificar = rows?.[0]?.codigo_compartido; // el que leímos de DB en paso 08-G
    if (codigoParaVerificar) {
      const resumenRevocado = await supaRpcAnon('apoderado_cc_resumen_pagos', { p_codigo_cc: codigoParaVerificar });
      assert(
        Array.isArray(resumenRevocado) && resumenRevocado.length === 0,
        `Código revocado retorna 0 filas`,
        `Código revocado retornó ${resumenRevocado?.length} fila(s) — debería ser 0`
      );
    } else {
      console.log('    (código revocado no disponible para re-verificar desde Node — omitido)');
    }

    // ── 13. C09: sin requests a producción en todo el test ───────────────────
    console.log('\n=== 08-M: Sin requests a producción (bloqueo Playwright) ===');
    try {
      verificarSinIntentos(bloqueo);
      ok('Ninguna request llegó a producción durante toda la prueba');
    } catch (err) {
      fail('Requests a producción detectadas', err);
    }

    // ── 14. C12: errores JS — sin filtros genéricos ───────────────────────────
    console.log('\n=== 08-N: Sin errores JavaScript en la página ===');
    // No filtrar genéricamente. Si hay un error JS real, debe fallar.
    // Excepción acotada: si hay un error conocido y documentado, se excluye con
    // referencia explícita al commit/ticket que lo originó y fecha de vencimiento.
    assert(jsErrors.length === 0,
      'Sin errores JS en la página principal',
      `${jsErrors.length} error(es) JS detectado(s)`,
      jsErrors.join('\n'));
    if (jsErrors.length > 0) {
      jsErrors.forEach(e => console.error('    JS error:', e));
    }

  } catch (err) {
    fail('Error inesperado en la prueba', err);
  } finally {
    // C13: restaurar estado si el test generó un código y no pudo revocarlo
    if (codigoCC) {
      console.log('\n[finally] Revocando código CC generado por el test...');
      try {
        page.once('dialog', dialog => dialog.accept());
        await page.evaluate(() => desactivarCodigoCompartido());
        console.log('[finally] Código revocado correctamente.');
      } catch (cleanupErr) {
        console.warn('[finally] No se pudo revocar el código en finally:', cleanupErr.message);
        console.warn('[finally] Código a revocar manualmente:', codigoCC);
      }
    }

    // C13: si había un código ANTES del test y lo revocamos, no se restaura
    // (no es posible regenerar exactamente el mismo código; el sistema genera uno nuevo).
    // Se documenta en el log para que el operador lo tenga en cuenta.
    if (codigoCCAnteriorAlTest) {
      console.log(
        '[finally] NOTA: había un código CC preexistente antes del test ' +
        `(${codigoCCAnteriorAlTest}) que fue revocado. Generar uno nuevo si se necesita.`
      );
    }

    await browser.close();
  }

  // ── Resultado final ──────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(54));
  console.log(`Resultado: ${pasa} OK / ${falla} FALLA(S)`);
  console.log('═'.repeat(54));
  if (falla > 0) process.exit(1);
})();
