/**
 * 05_prueba_funcional_ui.js — Prueba funcional UI v9 (Playwright)
 *
 * Flujo:
 *   login → V9_RELACIONAL activo → guardado rechazado (OBLIGATORIO) →
 *   pago válido → verificar en public.pagos → recarga → pago visible
 *
 * Selectores reales de la app:
 *   Login:   #l-email, #l-pass, button[onclick="doLogin()"]
 *   Error:   #login-err
 *   Modal:   showModal('addPago', ...) → button[onclick*="showModal('addPago'"]
 *   Guardar: button[onclick*="savePago"]
 *   Meses:   .p-mes-check
 *   Obs:     #p-obs
 *
 * Variables de entorno requeridas:
 *   STAGING_APP_URL            — URL de la app de staging
 *   STAGING_SUPABASE_URL       — URL del proyecto Supabase de staging
 *   STAGING_SUPABASE_ANON_KEY  — anon key (no service_role)
 *   STAGING_USER_A_EMAIL
 *   STAGING_USER_A_PASSWORD
 *
 * Restricciones:
 *   - Ninguna llamada de Node.js puede apuntar a producción
 *   - 0 filas en public.pagos tras el flujo = FALLO
 *   - La prueba de rechazo es OBLIGATORIA; omitirla es FALLO
 */

'use strict';

const { chromium } = require('playwright');
const {
  instalarBloqueoProduccion,
  verificarSinIntentos,
  HOSTS_PRODUCCION,
} = require('./helpers/bloqueo_produccion');

// ── Configuración ────────────────────────────────────────────────────────────
const APP_URL       = process.env.STAGING_APP_URL        || '';
const SUPA_URL      = process.env.STAGING_SUPABASE_URL   || '';
const SUPA_KEY      = process.env.STAGING_SUPABASE_ANON_KEY || '';
const USER_EMAIL    = process.env.STAGING_USER_A_EMAIL   || '';
const USER_PASSWORD = process.env.STAGING_USER_A_PASSWORD || '';

const CURSO_A       = 'cur-a-01';
const TIMEOUT       = 25_000;
const OBS_UNICA     = `test-05-${Date.now()}`;

// ── Validación de variables ──────────────────────────────────────────────────
if (!APP_URL || !SUPA_URL || !SUPA_KEY || !USER_EMAIL || !USER_PASSWORD) {
  console.error('[FALLO] Faltan variables de entorno:\n' +
    '  STAGING_APP_URL, STAGING_SUPABASE_URL, STAGING_SUPABASE_ANON_KEY,\n' +
    '  STAGING_USER_A_EMAIL, STAGING_USER_A_PASSWORD');
  process.exit(1);
}

// ── Protección: ninguna URL de Node puede apuntar a producción ───────────────
function validarUrlNode(url, contexto) {
  let hostname;
  try { hostname = new URL(url).hostname; } catch (_) { return; }
  const esProduccion = HOSTS_PRODUCCION.some(h => hostname === h || hostname.endsWith('.' + h));
  if (esProduccion) {
    throw new Error(
      `[FALLO] ${contexto}: URL de producción detectada en llamada Node.js: ${url}\n` +
      'Las llamadas de Node deben usar STAGING_SUPABASE_URL, nunca producción.'
    );
  }
}

// Validar las URLs de configuración antes de cualquier fetch
validarUrlNode(SUPA_URL, 'STAGING_SUPABASE_URL');
validarUrlNode(APP_URL,  'STAGING_APP_URL');

// ── Helper REST Supabase (Node, sin SDK) ─────────────────────────────────────
async function supaRest(path, opts = {}) {
  const url = `${SUPA_URL}/rest/v1${path}`;
  validarUrlNode(url, `supaRest(${path})`);

  const res = await fetch(url, {
    method: opts.method || 'GET',
    body:   opts.body   || undefined,
    headers: {
      'apikey':        SUPA_KEY,
      'Authorization': `Bearer ${opts._token || SUPA_KEY}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
      ...(opts.headers || {}),
    },
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(
      `supaRest ${opts.method || 'GET'} ${path} → HTTP ${res.status}: ${text}`
    );
  }

  return text ? JSON.parse(text) : null;
}

// ── Autenticar usuario A y obtener JWT ───────────────────────────────────────
async function obtenerJWT() {
  const authUrl = `${SUPA_URL}/auth/v1/token?grant_type=password`;
  validarUrlNode(authUrl, 'obtenerJWT');

  const res = await fetch(authUrl, {
    method: 'POST',
    headers: { 'apikey': SUPA_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: USER_EMAIL, password: USER_PASSWORD }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Auth falló (HTTP ${res.status}): ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

// ── Limpieza: eliminar pagos de test previos de esta sesión ──────────────────
async function limpiarPagosPrevios(jwt) {
  // Obtener cuenta_id del usuario para cumplir RLS en DELETE
  const cuentas = await supaRest('/tesorero_cuentas?select=id', { _token: jwt });
  if (!cuentas || !cuentas.length) return;
  const cuentaId = cuentas[0].id;

  const pagos = await supaRest(
    `/pagos?obs=like.test-05-%&cuenta_id=eq.${cuentaId}&select=id`,
    { _token: jwt }
  );
  if (!pagos || !pagos.length) return;

  for (const p of pagos) {
    await supaRest(
      `/pagos?id=eq.${p.id}&cuenta_id=eq.${cuentaId}`,
      { method: 'DELETE', _token: jwt }
    ).catch(e => console.warn(`  [limpieza] No se pudo eliminar ${p.id}: ${e.message}`));
  }
  console.log(`  [limpieza] ${pagos.length} pago(s) de test previo(s) eliminado(s)`);
}

// ── Esperar a que la app navegue al dashboard o al selector ─────────────────
async function esperarLoginCompletado(page) {
  await page.waitForFunction(
    () => typeof S !== 'undefined' && S.session && (S.route === 'dashboard' || S.route === 'selector'),
    { timeout: TIMEOUT }
  );
}

// ── Ir a la vista de pagos del alumno del curso ──────────────────────────────
async function navegarAPagos(page) {
  // Navegar a la sección pagos usando la función go() de la app
  await page.evaluate(() => { if (typeof go === 'function') go('pagos'); });
  // Esperar a que aparezca la vista de pagos con algún alumno
  await page.waitForSelector('[onclick*="showModal(\'addPago\'"]', { timeout: TIMEOUT });
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
  let exitCode = 0;
  let browser;
  let bloqueo;
  let pagoIdCreado = null;
  let jwt;
  let aluIdEsperado    = null;
  let cuotaIdEsperado  = null;
  let periodoEsperado  = null;
  const montoEsperado  = 5000;

  try {
    console.log('\n=== 05_prueba_funcional_ui.js ===');
    console.log(`APP:       ${APP_URL}`);
    console.log(`SUPA:      ${SUPA_URL}`);
    console.log(`OBS:       ${OBS_UNICA}`);

    // ── Pre-vuelo ────────────────────────────────────────────────────────────
    jwt = await obtenerJWT();
    console.log('  [ok] JWT obtenido para usuario A');

    await limpiarPagosPrevios(jwt);

    // ── Navegador ────────────────────────────────────────────────────────────
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ baseURL: APP_URL, locale: 'es-CL' });
    const page = await context.newPage();

    bloqueo = await instalarBloqueoProduccion(context, page);
    console.log(`  [ok] Bloqueo — HTTP: ${bloqueo.httpInstalado}, WS: ${bloqueo.wsInstalado}`);

    // ══════════════════════════════════════════════════════════════════════════
    // PASO 1 — Login
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[Paso 1] Login…');
    await page.goto('/', { waitUntil: 'networkidle', timeout: TIMEOUT });

    // Selectores reales de acceso.js
    await page.locator('#l-email').fill(USER_EMAIL);
    await page.locator('#l-pass').fill(USER_PASSWORD);
    await page.locator('button[onclick="doLogin()"]').click();

    await esperarLoginCompletado(page);
    console.log('  [ok] Login completado — ruta:', await page.evaluate(() => S.route));

    // ══════════════════════════════════════════════════════════════════════════
    // PASO 2 — Verificar V9_RELACIONAL
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[Paso 2] V9_RELACIONAL…');
    const v9Activo = await page.evaluate(() =>
      typeof V9_RELACIONAL !== 'undefined' && V9_RELACIONAL === true
    );
    if (!v9Activo) throw new Error('[FALLO] V9_RELACIONAL no está activo en la app');
    console.log('  [ok] V9_RELACIONAL === true');

    // ══════════════════════════════════════════════════════════════════════════
    // PASO 2B — DB relacional inmediatamente tras login (sin selectCurso aún)
    // Confirma que cargarSesionV9 pobló DB.cursos/alumnos/pagos ANTES de que
    // _setUserKeyV9 (o setUserKey) pudiera sobreescribirlos.
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[Paso 2B] DB relacional inmediatamente tras login…');
    const dbTrasLogin = await page.evaluate(() => ({
      cursos:  (typeof DB !== 'undefined' ? DB.cursos  || [] : []).length,
      alumnos: (typeof DB !== 'undefined' ? DB.alumnos || [] : []).length,
      pagos:   (typeof DB !== 'undefined' ? DB.pagos   || [] : []).length,
      v9CuentaId: (typeof S !== 'undefined' ? S._v9CuentaId : null),
    }));
    if (dbTrasLogin.cursos < 1) {
      throw new Error(`[FALLO] DB.cursos vacío tras login (${dbTrasLogin.cursos}). ` +
        'Indica que setUserKey sobreescribió DB o cargarSesionV9 no se ejecutó.');
    }
    if (!dbTrasLogin.v9CuentaId) {
      throw new Error('[FALLO] S._v9CuentaId nulo tras login — sesión v9 incompleta.');
    }
    console.log(`  [ok] DB.cursos=${dbTrasLogin.cursos} alumnos=${dbTrasLogin.alumnos} pagos=${dbTrasLogin.pagos} v9CuentaId=${dbTrasLogin.v9CuentaId}`);

    // ══════════════════════════════════════════════════════════════════════════
    // PASO 3 — Verificar cursos cargados
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[Paso 3] DB.cursos desde tablas…');
    const cursosLen = await page.evaluate(() =>
      typeof DB !== 'undefined' ? (DB.cursos || []).length : -1
    );
    if (cursosLen < 1) throw new Error(`[FALLO] DB.cursos vacío (${cursosLen})`);
    console.log(`  [ok] DB.cursos tiene ${cursosLen} elemento(s)`);

    // ══════════════════════════════════════════════════════════════════════════
    // PASO 4 — Seleccionar curso cur-a-01
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[Paso 4] Seleccionando cur-a-01…');
    const enSelector = await page.evaluate(() => S.route === 'selector');
    if (enSelector) {
      // Hacer clic en el div del selector de curso (rutas.js → selectCurso)
      await page.locator(`[onclick="selectCurso('${CURSO_A}')"]`).click();
      // Esperar que recargarCursoV9 resuelva y navegue a dashboard
      await page.waitForFunction(
        () => typeof S !== 'undefined' && S.route === 'dashboard' && S.cursoId,
        { timeout: TIMEOUT }
      );
    }

    const cursoActivo = await page.evaluate(() => typeof S !== 'undefined' ? S.cursoId : null);
    if (cursoActivo !== CURSO_A) {
      throw new Error(`[FALLO] S.cursoId = '${cursoActivo}', se esperaba '${CURSO_A}'`);
    }
    console.log(`  [ok] Curso activo: ${CURSO_A}`);

    // ══════════════════════════════════════════════════════════════════════════
    // PASO 5 — Verificar estado limpio en public.pagos
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[Paso 5] Estado inicial de public.pagos…');
    const pagosAntes = await supaRest(
      `/pagos?obs=eq.${OBS_UNICA}&select=id`,
      { _token: jwt }
    );
    if (pagosAntes.length !== 0) {
      throw new Error(`[FALLO] Ya existen ${pagosAntes.length} pagos con OBS_UNICA antes del test`);
    }
    console.log('  [ok] 0 filas previas con OBS_UNICA');

    // ══════════════════════════════════════════════════════════════════════════
    // PASO 5B — Guardado rechazado (OBLIGATORIO)
    // Si este paso no puede ejecutarse, es un FALLO del test, no una omisión.
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[Paso 5B] Prueba de guardado rechazado — OBLIGATORIA…');

    // Ir a vista de pagos y localizar el primer botón de registrar pago
    await navegarAPagos(page);

    // Registrar qué alumno y cuota usaremos (mismos para el flujo exitoso)
    const btnAddPago = page.locator('[onclick*="showModal(\'addPago\'"]').first();
    // Si no existe el botón, el test falla (no se puede omitir)
    await btnAddPago.waitFor({ timeout: TIMEOUT });

    const onclickAddPago = await btnAddPago.getAttribute('onclick');
    // onclick = "showModal('addPago',{aluId:'xxx',cuotaId:'yyy'})"
    const mAlu  = onclickAddPago?.match(/aluId:'([^']+)'/);
    const mCuota = onclickAddPago?.match(/cuotaId:'([^']+)'/);
    aluIdEsperado   = mAlu?.[1]   || null;
    cuotaIdEsperado = mCuota?.[1] || null;
    if (!aluIdEsperado || !cuotaIdEsperado) {
      throw new Error(`[FALLO] No se pudo extraer aluId/cuotaId del botón: ${onclickAddPago}`);
    }
    console.log(`  aluId=${aluIdEsperado}  cuotaId=${cuotaIdEsperado}`);

    // Abrir modal de pago
    await btnAddPago.click();
    await page.locator('#p-monto').waitFor({ timeout: TIMEOUT });

    // Seleccionar primer mes disponible y anotar el período
    const primerCheck = page.locator('.p-mes-check:not([disabled])').first();
    const hayMeses = await primerCheck.isVisible({ timeout: 2000 }).catch(() => false);
    if (hayMeses) {
      await primerCheck.check();
      periodoEsperado = await primerCheck.inputValue();
    } else {
      // cuota anual — leer el select
      periodoEsperado = await page.locator('#p-periodo').inputValue().catch(() => null);
    }
    console.log(`  periodo=${periodoEsperado}`);

    await page.locator('#p-monto').fill(String(montoEsperado));
    await page.locator('#p-obs').fill(`${OBS_UNICA}-rechazado`);

    const pagosEnMemoriaAntes = await page.evaluate(() => (DB.pagos || []).length);

    // Interceptar POST a /rest/v1/pagos y forzar 401.
    // Nota: asignar window._authToken NO modifica la variable `let _authToken`
    // interna del script de la app (scoping de módulo/script), por eso usamos
    // page.route() para inyectar el fallo a nivel de red.
    const urlPagos = /\/rest\/v1\/pagos/;
    const interceptar401 = route => route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'JWT expired', error: 'unauthorized' }),
    });
    await page.route(urlPagos, interceptar401);

    // Capturar el alert() que muestra la app cuando el guardado falla
    let mensajeErrorCapturado = null;
    const onDialog = async (dialog) => {
      mensajeErrorCapturado = dialog.message();
      await dialog.dismiss();
    };
    page.on('dialog', onDialog);

    // Pulsar guardar — el interceptor devolverá 401 al fetch interno
    await page.locator('button[onclick*="savePago"]').click();

    // Esperar a que el botón se rehabilite (Promise.allSettled terminó)
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('button[onclick*="savePago"]');
        return !btn || !btn.disabled;
      },
      { timeout: 15_000 }
    );

    // Quitar el interceptor antes del flujo exitoso
    await page.unroute(urlPagos, interceptar401);
    page.off('dialog', onDialog);

    // Verificar 1: error fue visible al usuario (alert de la app)
    if (!mensajeErrorCapturado) {
      throw new Error('[FALLO] El guardado rechazado no mostró ningún error al usuario (alert no disparado)');
    }
    console.log(`  [ok] Error visible al usuario: "${mensajeErrorCapturado.slice(0, 80)}"`);

    // Verificar 2: DB.pagos NO creció en memoria
    const pagosEnMemoriaDespues = await page.evaluate(() => (DB.pagos || []).length);
    if (pagosEnMemoriaDespues > pagosEnMemoriaAntes) {
      throw new Error(
        `[FALLO] El guardado rechazado añadió ${pagosEnMemoriaDespues - pagosEnMemoriaAntes} pago(s) a DB.pagos`
      );
    }
    console.log('  [ok] DB.pagos no creció con guardado rechazado');

    // Verificar 3: 0 filas llegaron al servidor
    const pagosRechazados = await supaRest(
      `/pagos?obs=eq.${OBS_UNICA}-rechazado&select=id`,
      { _token: jwt }
    );
    if (pagosRechazados.length > 0) {
      throw new Error('[FALLO] Un pago con token inválido llegó al servidor (RLS no funcionó)');
    }
    console.log('  [ok] 0 filas en public.pagos con obs rechazado');

    // Cerrar el modal si sigue abierto
    await page.keyboard.press('Escape');
    await page.locator('.modal').waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});

    console.log('  [ok] Prueba de guardado rechazado completada');

    // ══════════════════════════════════════════════════════════════════════════
    // PASO 6 — Pago válido
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[Paso 6] Registrando pago válido…');
    await navegarAPagos(page);

    // Abrir modal para el mismo alumno/cuota
    const btnPagoExacto = page.locator(
      `[onclick*="showModal('addPago',{aluId:'${aluIdEsperado}',cuotaId:'${cuotaIdEsperado}'"]`
    ).first();
    await btnPagoExacto.waitFor({ timeout: TIMEOUT });
    await btnPagoExacto.click();
    await page.locator('#p-monto').waitFor({ timeout: TIMEOUT });

    // Seleccionar mismo período
    if (hayMeses) {
      const check = page.locator(`.p-mes-check[value="${periodoEsperado}"]:not([disabled])`);
      const disponible = await check.isVisible({ timeout: 2000 }).catch(() => false);
      if (!disponible) {
        // Ya estaba pagado — elegir otro mes disponible
        const otroCheck = page.locator('.p-mes-check:not([disabled])').first();
        await otroCheck.waitFor({ timeout: 5000 });
        await otroCheck.check();
        periodoEsperado = await otroCheck.inputValue();
        console.log(`  [aviso] Período anterior ya pagado, usando: ${periodoEsperado}`);
      } else {
        await check.check();
      }
    }

    await page.locator('#p-monto').fill(String(montoEsperado));
    await page.locator('#p-obs').fill(OBS_UNICA);

    await page.locator('button[onclick*="savePago"]').click();
    console.log('  [ok] savePago pulsado — esperando confirmación del servidor…');

    // Esperar modal de éxito — sólo aparece tras confirmación del servidor
    await page.locator('.modal-title').waitFor({ timeout: TIMEOUT });
    const tituloModal = await page.locator('.modal-title').first().textContent();
    if (!tituloModal.includes('Pago registrado')) {
      throw new Error(`[FALLO] Modal inesperado: '${tituloModal}'`);
    }
    console.log('  [ok] Modal "Pago registrado" visible');

    // ══════════════════════════════════════════════════════════════════════════
    // PASO 7 — Verificar en public.pagos (0 filas = FALLO)
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[Paso 7] Verificando pago en public.pagos…');
    let pagosConfirmados = [];
    for (let intento = 0; intento < 6; intento++) {
      pagosConfirmados = await supaRest(
        `/pagos?obs=eq.${OBS_UNICA}&select=id,cuenta_id,alumno_id,cuota_id,monto,periodo,obs,estado`,
        { _token: jwt }
      );
      if (pagosConfirmados.length > 0) break;
      await new Promise(r => setTimeout(r, 1000));
    }

    if (pagosConfirmados.length === 0) {
      throw new Error('[FALLO] 0 filas en public.pagos — el INSERT no llegó al servidor');
    }

    const p = pagosConfirmados[0];
    pagoIdCreado = p.id;
    console.log(`  [ok] ${pagosConfirmados.length} fila(s). id=${p.id}`);

    // Verificación exacta campo a campo
    const errores = [];
    if (p.monto  !== montoEsperado)                   errores.push(`monto: ${p.monto} ≠ ${montoEsperado}`);
    if (p.estado !== 'pagado')                         errores.push(`estado: ${p.estado}`);
    if (aluIdEsperado   && p.alumno_id !== aluIdEsperado)   errores.push(`alumno_id: ${p.alumno_id} ≠ ${aluIdEsperado}`);
    if (cuotaIdEsperado && p.cuota_id  !== cuotaIdEsperado) errores.push(`cuota_id: ${p.cuota_id} ≠ ${cuotaIdEsperado}`);
    if (periodoEsperado && p.periodo   !== periodoEsperado)  errores.push(`periodo: ${p.periodo} ≠ ${periodoEsperado}`);
    if (errores.length) throw new Error('[FALLO] Campos incorrectos en public.pagos:\n  ' + errores.join('\n  '));

    console.log('  [ok] Campos exactos: id, alumno_id, cuota_id, monto, periodo, estado ✓');

    // ══════════════════════════════════════════════════════════════════════════
    // PASO 8 — Recarga: pago visible en DB.pagos
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[Paso 8] Recarga de página…');

    // Cerrar modal antes de recargar
    await page.keyboard.press('Escape');
    await page.reload({ waitUntil: 'networkidle', timeout: TIMEOUT });

    // Esperar restauración de sesión vía cargarSesionV9 (arranque.js)
    await page.waitForFunction(
      () => typeof S !== 'undefined' && S.session && S._v9CuentaId,
      { timeout: TIMEOUT }
    );
    console.log('  [ok] Sesión restaurada');

    // Verificar pago en DB.pagos con campos exactos
    const pagoEnMemoria = await page.evaluate((obs) => {
      return (typeof DB !== 'undefined' ? DB.pagos || [] : []).find(p => p.obs === obs) || null;
    }, OBS_UNICA);

    // Verificar también DB.cursos y DB.alumnos tras la recarga
    const dbTrasRecarga = await page.evaluate(() => ({
      cursos:     (typeof DB !== 'undefined' ? DB.cursos  || [] : []).length,
      alumnos:    (typeof DB !== 'undefined' ? DB.alumnos || [] : []).length,
      v9CuentaId: (typeof S !== 'undefined' ? S._v9CuentaId : null),
    }));
    if (dbTrasRecarga.cursos < 1) {
      throw new Error(`[FALLO] DB.cursos vacío tras recarga (${dbTrasRecarga.cursos}). ` +
        'Indica que setUserKey sobreescribió DB al restaurar sesión.');
    }
    if (dbTrasRecarga.alumnos < 1) {
      throw new Error(`[FALLO] DB.alumnos vacío tras recarga (${dbTrasRecarga.alumnos}).`);
    }
    if (!dbTrasRecarga.v9CuentaId) {
      throw new Error('[FALLO] S._v9CuentaId nulo tras recarga — sesión v9 no restaurada.');
    }
    console.log(`  [ok] DB relacional tras recarga: cursos=${dbTrasRecarga.cursos} alumnos=${dbTrasRecarga.alumnos} v9CuentaId=${dbTrasRecarga.v9CuentaId}`);

    if (!pagoEnMemoria) {
      throw new Error('[FALLO] Pago no encontrado en DB.pagos tras recarga');
    }

    const erroresRecarga = [];
    const aluMemoria = pagoEnMemoria.alumnoId || pagoEnMemoria.aluId;
    if (pagoEnMemoria.monto !== montoEsperado)                  erroresRecarga.push(`monto: ${pagoEnMemoria.monto} ≠ ${montoEsperado}`);
    if (pagoEnMemoria.estado !== 'pagado')                       erroresRecarga.push(`estado: ${pagoEnMemoria.estado}`);
    if (aluIdEsperado   && aluMemoria !== aluIdEsperado)         erroresRecarga.push(`alumnoId: ${aluMemoria} ≠ ${aluIdEsperado}`);
    if (cuotaIdEsperado && pagoEnMemoria.cuotaId !== cuotaIdEsperado) erroresRecarga.push(`cuotaId: ${pagoEnMemoria.cuotaId} ≠ ${cuotaIdEsperado}`);
    if (periodoEsperado && pagoEnMemoria.periodo !== periodoEsperado) erroresRecarga.push(`periodo: ${pagoEnMemoria.periodo} ≠ ${periodoEsperado}`);
    if (erroresRecarga.length) {
      throw new Error('[FALLO] Campos incorrectos en DB.pagos tras recarga:\n  ' + erroresRecarga.join('\n  '));
    }
    console.log('  [ok] Pago en DB.pagos con campos exactos ✓');

    // ══════════════════════════════════════════════════════════════════════════
    // PASO 9 — Aislamiento de producción
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[Paso 9] Verificando aislamiento de producción…');
    verificarSinIntentos(bloqueo);
    console.log('  [ok] Ningún intento a producción');

    console.log('\n✅ TODAS LAS PRUEBAS PASARON\n');

  } catch (err) {
    console.error('\n❌ FALLO:', err.message);
    exitCode = 1;
  } finally {
    // Limpieza del pago creado
    if (jwt) {
      try {
        const cuentas = await supaRest('/tesorero_cuentas?select=id', { _token: jwt }).catch(() => []);
        const cuentaId = cuentas?.[0]?.id;
        if (cuentaId) {
          const aLimpiar = await supaRest(
            `/pagos?obs=like.test-05-%&cuenta_id=eq.${cuentaId}&select=id`,
            { _token: jwt }
          ).catch(() => []);
          for (const r of (aLimpiar || [])) {
            await supaRest(
              `/pagos?id=eq.${r.id}&cuenta_id=eq.${cuentaId}`,
              { method: 'DELETE', _token: jwt }
            ).catch(() => {});
          }
          if (aLimpiar?.length) console.log(`[limpieza] ${aLimpiar.length} pago(s) de test eliminado(s)`);
        }
      } catch (e) {
        console.warn('[limpieza] Error:', e.message);
      }
    }
    if (browser) await browser.close();
    process.exit(exitCode);
  }
})();
