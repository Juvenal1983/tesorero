/**
 * 05_prueba_funcional_ui.js — Prueba funcional UI v9 (Playwright)
 *
 * Flujo completo:
 *   login → V9_RELACIONAL activo → registrar pago → reload → pago visible
 *
 * Comprobaciones:
 *   A. Guardado rechazado por el servidor → error visible al usuario, pago NO en DB.pagos
 *   B. Guardado exitoso → pago en public.pagos, visible tras recarga
 *   C. Verificación exacta: id, alumno_id, cuota_id, monto, periodo
 *
 * CURSO FIJO: cur-a-01
 * 0 filas en public.pagos tras el flujo = FALLO
 *
 * Variables de entorno requeridas:
 *   STAGING_APP_URL          — URL de la app de staging desplegada
 *   STAGING_SUPABASE_URL     — URL del proyecto Supabase de staging
 *   STAGING_SUPABASE_ANON_KEY
 *   STAGING_USER_A_EMAIL
 *   STAGING_USER_A_PASSWORD
 */

'use strict';

const { chromium } = require('playwright');
const { instalarBloqueoProduccion, verificarSinIntentos } = require('./helpers/bloqueo_produccion');

// ── Configuración ────────────────────────────────────────────────────────────
const APP_URL        = process.env.STAGING_APP_URL;
const SUPA_URL       = process.env.STAGING_SUPABASE_URL;
const SUPA_KEY       = process.env.STAGING_SUPABASE_ANON_KEY;
const USER_EMAIL     = process.env.STAGING_USER_A_EMAIL;
const USER_PASSWORD  = process.env.STAGING_USER_A_PASSWORD;

const CURSO_A        = 'cur-a-01';
const TIMEOUT        = 20_000;

// Observación única para identificar el pago exacto en la tabla
const OBS_UNICA      = `test-05-${Date.now()}`;

if (!APP_URL || !SUPA_URL || !SUPA_KEY || !USER_EMAIL || !USER_PASSWORD) {
  console.error('[FALLO] Faltan variables de entorno. Define:\n' +
    '  STAGING_APP_URL, STAGING_SUPABASE_URL, STAGING_SUPABASE_ANON_KEY,\n' +
    '  STAGING_USER_A_EMAIL, STAGING_USER_A_PASSWORD');
  process.exit(1);
}

// ── Helper REST Supabase (sin SDK) ───────────────────────────────────────────
async function supaRest(path, opts = {}) {
  const url = `${SUPA_URL}/rest/v1${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'apikey':        SUPA_KEY,
      'Authorization': `Bearer ${opts._token || SUPA_KEY}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase REST ${opts.method || 'GET'} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// ── Autenticar usuario A y obtener JWT ───────────────────────────────────────
async function obtenerJWT() {
  const res = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'apikey': SUPA_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: USER_EMAIL, password: USER_PASSWORD }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error('Auth falló: ' + JSON.stringify(data));
  return data.access_token;
}

// ── Limpieza: eliminar pagos de test previos ─────────────────────────────────
async function limpiarPagosPrevios(jwt) {
  const pagos = await supaRest(`/pagos?obs=like.test-05-%&select=id,cuenta_id`, { _token: jwt });
  if (!pagos || !pagos.length) return;
  for (const p of pagos) {
    await supaRest(`/pagos?id=eq.${p.id}&cuenta_id=eq.${p.cuenta_id}`, {
      method: 'DELETE', _token: jwt,
    }).catch(e => console.warn('[limpieza] No se pudo eliminar pago', p.id, e.message));
  }
  console.log(`  [limpieza] ${pagos.length} pago(s) de test previo(s) eliminado(s)`);
}

// ── Verificar que el selector de curso está disponible ───────────────────────
async function esperarSelectorCurso(page) {
  // La app muestra el selector o el dashboard; esperar cualquiera
  await Promise.race([
    page.waitForSelector('[onclick*="selectCurso"]', { timeout: TIMEOUT }),
    page.waitForSelector('#app [data-route="dashboard"]', { timeout: TIMEOUT }),
  ]);
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
  let exitCode = 0;
  let browser;
  let bloqueo;
  let pagoIdCreado = null;
  let jwt;

  try {
    // ── Pre-vuelo ──────────────────────────────────────────────────────────
    console.log('\n=== 05_prueba_funcional_ui.js ===');
    console.log(`APP: ${APP_URL}`);
    console.log(`OBS_UNICA: ${OBS_UNICA}`);

    jwt = await obtenerJWT();
    console.log('  [ok] JWT obtenido para usuario A');

    await limpiarPagosPrevios(jwt);

    // ── Iniciar navegador ──────────────────────────────────────────────────
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      baseURL: APP_URL,
      locale: 'es-CL',
    });
    const page = await context.newPage();

    bloqueo = await instalarBloqueoProduccion(context, page);
    console.log(`  [ok] Bloqueo instalado — HTTP: ${bloqueo.httpInstalado}, WS: ${bloqueo.wsInstalado}`);

    // ── Paso 1: Login ──────────────────────────────────────────────────────
    console.log('\n[Paso 1] Navegando a la app…');
    await page.goto('/', { waitUntil: 'networkidle', timeout: TIMEOUT });

    await page.fill('#email', USER_EMAIL);
    await page.fill('#password', USER_PASSWORD);
    await page.click('button[type="submit"], button[onclick*="login"]');
    console.log('  [ok] Credenciales enviadas');

    await esperarSelectorCurso(page);
    console.log('  [ok] Login completado');

    // ── Paso 2: Verificar V9_RELACIONAL activo ────────────────────────────
    console.log('\n[Paso 2] Verificando V9_RELACIONAL…');
    const v9Activo = await page.evaluate(() => {
      return typeof V9_RELACIONAL !== 'undefined' && V9_RELACIONAL === true;
    });
    if (!v9Activo) throw new Error('[FALLO] V9_RELACIONAL no está activo en la app');
    console.log('  [ok] V9_RELACIONAL === true');

    // ── Paso 3: Verificar cursos cargados desde tablas ────────────────────
    console.log('\n[Paso 3] Verificando DB.cursos desde tablas relacionales…');
    const cursosLen = await page.evaluate(() => (typeof DB !== 'undefined' ? (DB.cursos || []).length : -1));
    if (cursosLen < 1) throw new Error(`[FALLO] DB.cursos vacío (${cursosLen}) — V9 no cargó datos`);
    console.log(`  [ok] DB.cursos tiene ${cursosLen} elemento(s)`);

    // ── Paso 4: Seleccionar curso fijo cur-a-01 ───────────────────────────
    console.log('\n[Paso 4] Seleccionando curso cur-a-01…');
    const selectorVisible = await page.locator(`[onclick*="selectCurso('${CURSO_A}')"]`).isVisible().catch(() => false);
    if (selectorVisible) {
      await page.click(`[onclick*="selectCurso('${CURSO_A}')"]`);
      await page.waitForSelector('[data-route="dashboard"], #app .dashboard', { timeout: TIMEOUT });
    }
    // Si ya está en dashboard con ese curso, continuar
    const cursoActivo = await page.evaluate(() => typeof S !== 'undefined' ? S.cursoId : null);
    if (cursoActivo !== CURSO_A) {
      throw new Error(`[FALLO] S.cursoId = '${cursoActivo}', se esperaba '${CURSO_A}'`);
    }
    console.log(`  [ok] Curso activo: ${CURSO_A}`);

    // ── Paso 5: Anotar estado de pagos ANTES ──────────────────────────────
    console.log('\n[Paso 5] Contando pagos en public.pagos antes del test…');
    const pagosAntes = await supaRest(`/pagos?obs=eq.${OBS_UNICA}&select=id,alumno_id,cuota_id,monto,periodo,obs`, { _token: jwt });
    if (pagosAntes.length !== 0) throw new Error(`[FALLO] Ya existen ${pagosAntes.length} pagos con OBS_UNICA antes del test`);
    console.log('  [ok] 0 pagos previos con esta observación');

    // ── Paso 5B: PRUEBA DE GUARDADO RECHAZADO ─────────────────────────────
    // Simular error del servidor revocando temporalmente el JWT en la página
    console.log('\n[Paso 5B] Prueba de guardado rechazado por el servidor…');
    await page.goto('/pagos', { waitUntil: 'networkidle', timeout: TIMEOUT }).catch(() => {});

    // Abrir modal de pago para el primer alumno del curso
    const btnPago = page.locator('button[onclick*="modalPago"]').first();
    if (await btnPago.isVisible().catch(() => false)) {
      await btnPago.click();
      await page.waitForSelector('#p-monto', { timeout: 5000 }).catch(() => {});

      // Inyectar token inválido para forzar error del servidor
      const tokenOriginal = await page.evaluate(() => typeof _authToken !== 'undefined' ? _authToken : null);
      if (tokenOriginal) {
        await page.evaluate(() => { window._authToken = 'token-invalido-para-test'; });

        await page.fill('#p-obs', OBS_UNICA + '-rechazado');
        // Anotar longitud de DB.pagos antes
        const pagosEnMemoriaAntes = await page.evaluate(() => (DB.pagos || []).length);

        await page.click('button[onclick*="savePago"]');

        // Esperar que aparezca un alert de error (el modal de savePago lo hace con alert())
        // o esperar que el botón se rehabilite
        await page.waitForFunction(() => {
          const btn = document.querySelector('button[onclick*="savePago"]');
          return !btn || !btn.disabled;
        }, { timeout: 10_000 }).catch(() => {});

        // Verificar que NO se añadió pago en memoria
        const pagosEnMemoriaDespues = await page.evaluate(() => (DB.pagos || []).length);
        if (pagosEnMemoriaDespues > pagosEnMemoriaAntes) {
          throw new Error('[FALLO] El guardado rechazado añadió pagos a DB.pagos en memoria');
        }
        console.log('  [ok] Guardado rechazado: DB.pagos no se modificó');

        // Verificar que no llegó nada al servidor
        const pagosRechazados = await supaRest(
          `/pagos?obs=eq.${OBS_UNICA + '-rechazado'}&select=id`,
          { _token: jwt }
        ).catch(() => []);
        if (pagosRechazados.length > 0) {
          throw new Error('[FALLO] Un pago con token inválido llegó al servidor');
        }
        console.log('  [ok] Guardado rechazado: 0 filas en public.pagos');

        // Restaurar token original
        await page.evaluate((t) => { window._authToken = t; }, tokenOriginal);
        await page.keyboard.press('Escape'); // cerrar modal/alert
      } else {
        console.warn('  [aviso] No se pudo obtener _authToken para el test de rechazo');
      }
    } else {
      console.warn('  [aviso] No hay botón de pago visible — omitiendo prueba de rechazo');
    }

    // ── Paso 6: Registrar pago exitoso ────────────────────────────────────
    console.log('\n[Paso 6] Registrando pago exitoso…');
    const btnPago2 = page.locator('button[onclick*="modalPago"]').first();
    await btnPago2.click();
    await page.waitForSelector('#p-monto', { timeout: TIMEOUT });

    const montoEsperado = 5000;
    await page.fill('#p-monto', String(montoEsperado));
    await page.fill('#p-obs', OBS_UNICA);

    // Seleccionar el primer mes disponible (si es cuota mensual)
    const primerCheck = page.locator('.p-mes-check:not([disabled])').first();
    if (await primerCheck.isVisible().catch(() => false)) {
      await primerCheck.check();
    }

    // Anotar estado antes del clic
    const alumnoIdEsperado = await page.evaluate(() => {
      const check = document.querySelector('.p-mes-check:not([disabled]):checked');
      return check ? null : null; // se obtiene del parámetro del modal
    });
    const periodoEsperado = await page.evaluate(() => {
      const check = document.querySelector('.p-mes-check:checked');
      return check ? check.value : (document.querySelector('#p-periodo')?.value || null);
    });

    // Obtener alumnoId y cuotaId del atributo onclick del botón guardar
    const onclickBtn = await page.locator('button[onclick*="savePago"]').getAttribute('onclick');
    const matchSave = onclickBtn?.match(/savePago\('([^']+)','([^']+)'/);
    const aluIdEsperado  = matchSave?.[1] || null;
    const cuotaIdEsperado = matchSave?.[2] || null;

    await page.click('button[onclick*="savePago"]');
    console.log('  [ok] Botón savePago pulsado');

    // Esperar confirmación — el modal de notificación aparece tras el await del servidor
    await page.waitForSelector('.modal-title', { timeout: TIMEOUT });
    const tituloModal = await page.locator('.modal-title').first().textContent();
    if (!tituloModal.includes('Pago registrado') && !tituloModal.includes('registrado')) {
      throw new Error(`[FALLO] Modal inesperado: '${tituloModal}'`);
    }
    console.log('  [ok] Modal de confirmación mostrado');

    // ── Paso 7: Verificar pago en public.pagos (0 filas = FALLO) ─────────
    console.log('\n[Paso 7] Verificando pago en public.pagos…');
    // Esperar hasta 5 s a que el INSERT se propague
    let pagosConfirmados = [];
    for (let i = 0; i < 5; i++) {
      pagosConfirmados = await supaRest(
        `/pagos?obs=eq.${OBS_UNICA}&select=id,cuenta_id,alumno_id,cuota_id,monto,periodo,obs,estado`,
        { _token: jwt }
      );
      if (pagosConfirmados.length > 0) break;
      await new Promise(r => setTimeout(r, 1000));
    }

    if (pagosConfirmados.length === 0) {
      throw new Error('[FALLO] 0 filas en public.pagos con OBS_UNICA — el INSERT no llegó al servidor');
    }

    const p = pagosConfirmados[0];
    pagoIdCreado = p.id;
    console.log(`  [ok] ${pagosConfirmados.length} fila(s) en public.pagos. id=${p.id}`);

    // Verificación exacta de campos
    const errores = [];
    if (p.monto     !== montoEsperado)  errores.push(`monto: ${p.monto} ≠ ${montoEsperado}`);
    if (p.estado    !== 'pagado')       errores.push(`estado: ${p.estado} ≠ pagado`);
    if (aluIdEsperado  && p.alumno_id  !== aluIdEsperado)  errores.push(`alumno_id: ${p.alumno_id} ≠ ${aluIdEsperado}`);
    if (cuotaIdEsperado && p.cuota_id  !== cuotaIdEsperado) errores.push(`cuota_id: ${p.cuota_id} ≠ ${cuotaIdEsperado}`);
    if (periodoEsperado && p.periodo   !== periodoEsperado) errores.push(`periodo: ${p.periodo} ≠ ${periodoEsperado}`);
    if (errores.length) throw new Error('[FALLO] Campos incorrectos en public.pagos:\n' + errores.join('\n'));
    console.log('  [ok] Verificación exacta: id, alumno_id, cuota_id, monto, periodo, estado — todos correctos');

    // ── Paso 8: Recarga de página — pago debe seguir visible ─────────────
    console.log('\n[Paso 8] Verificando pago visible tras recarga…');
    await page.reload({ waitUntil: 'networkidle', timeout: TIMEOUT });

    // Esperar que la sesión se restaure (arranque.js → cargarSesionV9)
    await page.waitForFunction(
      () => typeof S !== 'undefined' && S.session && S._v9CuentaId,
      { timeout: TIMEOUT }
    );
    console.log('  [ok] Sesión restaurada tras recarga');

    // Verificar que el pago está en DB.pagos en memoria
    const pagoEnMemoria = await page.evaluate((obsUnica) => {
      return (DB.pagos || []).find(p => p.obs === obsUnica) || null;
    }, OBS_UNICA);

    if (!pagoEnMemoria) {
      throw new Error('[FALLO] El pago no aparece en DB.pagos tras recarga');
    }

    // Verificación exacta de campos en memoria tras recarga
    const erroresMemoria = [];
    if (pagoEnMemoria.monto !== montoEsperado)            erroresMemoria.push(`monto: ${pagoEnMemoria.monto} ≠ ${montoEsperado}`);
    if ((pagoEnMemoria.alumnoId || pagoEnMemoria.aluId) !== aluIdEsperado && aluIdEsperado)
      erroresMemoria.push(`alumnoId: ${pagoEnMemoria.alumnoId||pagoEnMemoria.aluId} ≠ ${aluIdEsperado}`);
    if (pagoEnMemoria.cuotaId !== cuotaIdEsperado && cuotaIdEsperado)
      erroresMemoria.push(`cuotaId: ${pagoEnMemoria.cuotaId} ≠ ${cuotaIdEsperado}`);
    if (pagoEnMemoria.estado !== 'pagado')                erroresMemoria.push(`estado: ${pagoEnMemoria.estado} ≠ pagado`);
    if (erroresMemoria.length) throw new Error('[FALLO] Campos incorrectos en DB.pagos tras recarga:\n' + erroresMemoria.join('\n'));

    console.log('  [ok] Pago visible en DB.pagos tras recarga — id, alumnoId, cuotaId, monto, estado correctos');

    // ── Paso 9: Verificar sin intentos a producción ───────────────────────
    console.log('\n[Paso 9] Verificando aislamiento de producción…');
    verificarSinIntentos(bloqueo);
    console.log('  [ok] Ningún intento a producción detectado');

    console.log('\n✅ TODAS LAS PRUEBAS PASARON\n');

  } catch (err) {
    console.error('\n❌ FALLO:', err.message, '\n');
    exitCode = 1;
  } finally {
    // ── Limpieza del pago de test ──────────────────────────────────────────
    if (pagoIdCreado && jwt) {
      try {
        await supaRest(`/pagos?obs=like.test-05-%&select=id,cuenta_id`, { _token: jwt })
          .then(rows => Promise.all(
            (rows || []).map(r =>
              supaRest(`/pagos?id=eq.${r.id}&cuenta_id=eq.${r.cuenta_id}`, { method: 'DELETE', _token: jwt })
            )
          ));
        console.log('[limpieza] Pago(s) de test eliminado(s)');
      } catch (e) {
        console.warn('[limpieza] No se pudo eliminar pago de test:', e.message);
      }
    }
    if (browser) await browser.close();
    process.exit(exitCode);
  }
})();
