/**
 * tests/e7_ui.js — E7 recorrido UI (Playwright)
 *
 * Verifica los handlers reales de la app con formularios reales:
 *   UI-CFG  Activar fondo especial + renombrar (toggleFondoEspecial / guardarNombreFondo)
 *   UI-FM   CRUD movimientos de fondo (saveMovFondo / guardarEditMovFondo / eliminarMovFondo)
 *   UI-FM-R Recarga de página: movimiento persiste en DOM
 *   UI-FM-I Cambio de curso: datos del fixture no aparecen en curso 2
 *   UI-ACT  CRUD actividades (saveActividad / eliminarActividad)
 *   UI-RPT  Reporte renderizado: canvas#chartRepBar con datos (drawReporteCharts)
 *   UI-VIS  Usuario C puede SELECT del curso fixture (REST) antes del rechazo
 *
 * Setup independiente: crea fixtures propios via REST (no depende de e7_fondos_actividades.js).
 * Teardown: elimina solo los datos y la membresía creados por esta ejecución.
 *
 * Variables de entorno requeridas:
 *   STAGING_APP_URL                            — URL de la app de staging
 *   STAGING_URL (o STAGING_SUPABASE_URL)       — URL Supabase staging
 *   STAGING_KEY (o STAGING_SUPABASE_ANON_KEY)  — anon key staging
 *   STAGING_EMAIL (o STAGING_USER_A_EMAIL)     — usuario A (dueño)
 *   STAGING_PASS  (o STAGING_USER_A_PASSWORD)
 *
 * Opcionales (si faltan, UI-VIS queda PENDING):
 *   STAGING_USER_C_EMAIL / STAGING_USER_C_PASSWORD  — visor
 *
 * ⚠️  NUNCA ejecutar contra producción: tmjqzaakzhecbldebyeg.supabase.co
 */

'use strict';

const path = require('path');
const { chromium } = require('playwright');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

// ── Entorno ───────────────────────────────────────────────────────────────────
const APP_URL    = (process.env.STAGING_APP_URL || '').replace(/\/$/, '');
const SUPA_URL   = (process.env.STAGING_URL || process.env.STAGING_SUPABASE_URL || '').replace(/\/$/, '');
const ANON_KEY   = process.env.STAGING_KEY  || process.env.STAGING_SUPABASE_ANON_KEY || '';
const USER_EMAIL = process.env.STAGING_EMAIL || process.env.STAGING_USER_A_EMAIL || '';
const USER_PASS  = process.env.STAGING_PASS  || process.env.STAGING_USER_A_PASSWORD || '';
const USER_C_EMAIL = process.env.STAGING_USER_C_EMAIL || '';
const USER_C_PASS  = process.env.STAGING_USER_C_PASSWORD || '';

const TIMEOUT = 30_000;
const TAG     = `e7ui-${Date.now()}`;   // Tag único para limpiar datos de esta ejecución

// ── Guard producción ──────────────────────────────────────────────────────────
if (SUPA_URL.includes('tmjqzaakzhecbldebyeg') || APP_URL.includes('eltesorero.cl')) {
  console.error('🚫 URL apunta a producción. Abortando.');
  process.exit(1);
}

// ── Validación de variables ───────────────────────────────────────────────────
if (!APP_URL || !SUPA_URL || !ANON_KEY || !USER_EMAIL || !USER_PASS) {
  console.error('[FALLO] Faltan variables de entorno:\n' +
    '  STAGING_APP_URL, STAGING_URL/STAGING_SUPABASE_URL,\n' +
    '  STAGING_KEY/STAGING_SUPABASE_ANON_KEY,\n' +
    '  STAGING_EMAIL/STAGING_USER_A_EMAIL, STAGING_PASS/STAGING_USER_A_PASSWORD');
  process.exit(1);
}

// ── Contadores ────────────────────────────────────────────────────────────────
let ok = 0, fail = 0, pend = 0;
const fallos = [];

function pass(id, desc) {
  ok++;
  console.log(`  ✅ ${id.padEnd(12)} ${desc}`);
}
function fail_(id, desc, err) {
  fail++;
  const msg = `  ❌ ${id.padEnd(12)} ${desc}: ${err?.message || err}`;
  console.error(msg);
  fallos.push({ id, desc, err: err?.message || String(err) });
}
function pend_(id, desc, reason) {
  pend++;
  console.log(`  ⏳ ${id.padEnd(12)} ${desc} [PENDING: ${reason}]`);
}

// ── REST helper (Node) ────────────────────────────────────────────────────────
async function rest(path_, opts = {}) {
  const url = `${SUPA_URL}/rest/v1${path_}`;
  const res = await fetch(url, {
    method: opts.method || 'GET',
    body:   opts.body   || undefined,
    headers: {
      'apikey':        ANON_KEY,
      'Authorization': `Bearer ${opts._token || ANON_KEY}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
      'Prefer':        opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, body: text ? JSON.parse(text) : null };
}

// ── Autenticar ────────────────────────────────────────────────────────────────
async function autenticar(email, pass) {
  const url = `${SUPA_URL}/auth/v1/token?grant_type=password`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: pass }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token)
    throw new Error(`Auth falló (HTTP ${res.status}): ${JSON.stringify(data)}`);
  return { token: data.access_token, userId: data.user?.id };
}

// ── Helpers Supabase ──────────────────────────────────────────────────────────
async function getCuentaId(jwt) {
  const r = await rest('/tesorero_cuentas?select=id', { _token: jwt });
  if (!r.ok || !r.body?.length) throw new Error('No se encontró cuenta para usuario A');
  return r.body[0].id;
}

async function getCursoFixture(jwt, cuentaId) {
  // Busca curso fixture creado por esta sesión (tag en nombre)
  const r = await rest(
    `/cursos?cuenta_id=eq.${cuentaId}&nombre=like.${encodeURIComponent(`%${TAG}%`)}&select=id,nombre`,
    { _token: jwt }
  );
  if (!r.ok) throw new Error(`getCursoFixture error: ${JSON.stringify(r.body)}`);
  return r.body?.[0] || null;
}

// ── Setup: crear fixtures independientes ──────────────────────────────────────
async function setup(jwt, cuentaId) {
  console.log('\n[Setup] Creando fixtures UI...');

  // Crear curso fixture
  const rCurso = await rest('/cursos', {
    method: 'POST',
    _token: jwt,
    body: JSON.stringify({
      cuenta_id: cuentaId,
      nombre: `Curso UI ${TAG}`,
      colegio: 'Test UI',
      tipo_org: 'curso',
      fondo_especial: { activo: false, nombre: 'Fondo Especial' },
    }),
  });
  if (!rCurso.ok) throw new Error(`No se pudo crear curso: ${JSON.stringify(rCurso.body)}`);
  const cursoId = Array.isArray(rCurso.body) ? rCurso.body[0].id : rCurso.body.id;
  console.log(`  [setup] Curso fixture: ${cursoId}`);

  // Crear 3 alumnos fixture
  const alumnos = [];
  for (let i = 1; i <= 3; i++) {
    const rA = await rest('/alumnos', {
      method: 'POST',
      _token: jwt,
      body: JSON.stringify({
        cuenta_id: cuentaId,
        curso_id: cursoId,
        nombre: `Alumno UI ${TAG} ${i}`,
      }),
    });
    if (!rA.ok) throw new Error(`No se pudo crear alumno ${i}: ${JSON.stringify(rA.body)}`);
    const alu = Array.isArray(rA.body) ? rA.body[0] : rA.body;
    alumnos.push(alu);
  }
  console.log(`  [setup] 3 alumnos creados`);

  // Crear un segundo curso para prueba de aislamiento
  const rCurso2 = await rest('/cursos', {
    method: 'POST',
    _token: jwt,
    body: JSON.stringify({
      cuenta_id: cuentaId,
      nombre: `Curso UI2 ${TAG}`,
      colegio: 'Test UI2',
      tipo_org: 'curso',
      fondo_especial: { activo: false, nombre: 'Fondo Especial' },
    }),
  });
  if (!rCurso2.ok) throw new Error(`No se pudo crear curso2: ${JSON.stringify(rCurso2.body)}`);
  const curso2Id = Array.isArray(rCurso2.body) ? rCurso2.body[0].id : rCurso2.body.id;
  console.log(`  [setup] Curso2 fixture: ${curso2Id}`);

  return { cursoId, curso2Id, alumnos };
}

// ── Teardown ──────────────────────────────────────────────────────────────────
async function teardown(jwt, cuentaId, state) {
  console.log('\n[Teardown] Limpiando datos de esta ejecución...');
  const { cursoId, curso2Id, membershipCId } = state;

  // Eliminar membresía visor C si se creó
  if (membershipCId) {
    await rest(`/usuarios_cuenta?id=eq.${membershipCId}`, { method: 'DELETE', _token: jwt })
      .catch(e => console.warn(`  [teardown] membresía C: ${e.message}`));
    console.log('  [teardown] membresía visor C eliminada');
  }

  // Eliminar fondo_movimientos del curso fixture
  if (cursoId) {
    await rest(`/fondo_movimientos?cuenta_id=eq.${cuentaId}&curso_id=eq.${cursoId}`,
      { method: 'DELETE', _token: jwt })
      .catch(e => console.warn(`  [teardown] fondo_movimientos: ${e.message}`));

    // Eliminar actividades del curso fixture
    await rest(`/actividades?cuenta_id=eq.${cuentaId}&curso_id=eq.${cursoId}`,
      { method: 'DELETE', _token: jwt })
      .catch(e => console.warn(`  [teardown] actividades: ${e.message}`));

    // Eliminar alumnos
    await rest(`/alumnos?cuenta_id=eq.${cuentaId}&curso_id=eq.${cursoId}`,
      { method: 'DELETE', _token: jwt })
      .catch(e => console.warn(`  [teardown] alumnos: ${e.message}`));

    // Eliminar curso fixture
    await rest(`/cursos?id=eq.${cursoId}&cuenta_id=eq.${cuentaId}`,
      { method: 'DELETE', _token: jwt })
      .catch(e => console.warn(`  [teardown] curso: ${e.message}`));
  }

  // Eliminar curso2
  if (curso2Id) {
    await rest(`/cursos?id=eq.${curso2Id}&cuenta_id=eq.${cuentaId}`,
      { method: 'DELETE', _token: jwt })
      .catch(e => console.warn(`  [teardown] curso2: ${e.message}`));
  }

  console.log('  [teardown] completado');
}

// ── Login UI ──────────────────────────────────────────────────────────────────
async function loginUI(page) {
  await page.goto('/', { waitUntil: 'networkidle', timeout: TIMEOUT });
  await page.locator('#l-email').fill(USER_EMAIL);
  await page.locator('#l-pass').fill(USER_PASS);
  await page.locator('button[onclick="doLogin()"]').click();
  await page.waitForFunction(
    () => typeof S !== 'undefined' && S.session && (S.route === 'dashboard' || S.route === 'selector'),
    { timeout: TIMEOUT }
  );
  console.log('  [ui] login completado');
}

// ── Seleccionar curso ─────────────────────────────────────────────────────────
async function seleccionarCurso(page, cursoId) {
  // Ir al selector de cursos
  await page.evaluate(() => { if (typeof go === 'function') go('selector'); });
  await page.waitForSelector(`[onclick="selectCurso('${cursoId}')"]`, { timeout: TIMEOUT });
  await page.locator(`[onclick="selectCurso('${cursoId}')"]`).click();
  // Esperar a que cargue el dashboard del curso
  await page.waitForFunction(
    (id) => typeof S !== 'undefined' && S.cursoId === id,
    cursoId,
    { timeout: TIMEOUT }
  );
  console.log(`  [ui] curso seleccionado: ${cursoId}`);
}

// ── Navegar a ruta de la app ──────────────────────────────────────────────────
async function navegar(page, ruta, waitSelector) {
  await page.evaluate((r) => { if (typeof go === 'function') go(r); }, ruta);
  if (waitSelector) {
    await page.waitForSelector(waitSelector, { timeout: TIMEOUT });
  } else {
    await page.waitForFunction(
      (r) => typeof S !== 'undefined' && S.route === r,
      ruta,
      { timeout: TIMEOUT }
    );
  }
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
(async () => {
  let browser;
  let jwt, cuentaId;
  let fixtures = {};   // { cursoId, curso2Id, alumnos }
  let state   = {};    // acumula IDs para teardown

  console.log('\n=== E7 UI — Recorrido con handlers reales ===');
  console.log(`APP:  ${APP_URL}`);
  console.log(`SUPA: ${SUPA_URL}`);
  console.log(`TAG:  ${TAG}`);

  try {
    // ── Pre-vuelo ─────────────────────────────────────────────────────────────
    const auth = await autenticar(USER_EMAIL, USER_PASS);
    jwt       = auth.token;
    cuentaId  = await getCuentaId(jwt);
    console.log(`  [ok] JWT obtenido; cuenta: ${cuentaId}`);

    fixtures = await setup(jwt, cuentaId);
    state = { cursoId: fixtures.cursoId, curso2Id: fixtures.curso2Id };
    const { cursoId, curso2Id, alumnos } = fixtures;
    const aluIds = alumnos.map(a => a.id);

    // ── Navegador ─────────────────────────────────────────────────────────────
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ baseURL: APP_URL, locale: 'es-CL' });
    const page = await context.newPage();

    // Suprimir errores JS de la app no relacionados con el test
    page.on('pageerror', e => {
      if (!e.message.includes('STAGING_URL_PENDIENTE')) {
        console.warn(`  [browser-err] ${e.message.substring(0, 120)}`);
      }
    });

    // ── LOGIN ─────────────────────────────────────────────────────────────────
    console.log('\n[Paso Login]');
    await loginUI(page);
    await seleccionarCurso(page, cursoId);

    // ══════════════════════════════════════════════════════════════════════════
    // UI-CFG — Configuración del fondo especial
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[Bloque UI-CFG]');

    try {
      // Navegar a config
      await navegar(page, 'config', 'button[onclick="toggleFondoEspecial(true)"], button[onclick="toggleFondoEspecial(false)"]');

      // Verificar que el botón de activar está visible (fondo debe estar inactivo)
      const btnActivar = page.locator('button[onclick="toggleFondoEspecial(true)"]');
      await btnActivar.waitFor({ timeout: TIMEOUT });
      await btnActivar.click();

      // Esperar a que el botón cambie a "desactivar"
      await page.waitForSelector('button[onclick="toggleFondoEspecial(false)"]', { timeout: TIMEOUT });

      // Verificar vía REST que persiste en PostgreSQL
      const rCfg = await rest(`/cursos?id=eq.${cursoId}&select=fondo_especial`, { _token: jwt });
      const fondoActivo = rCfg.body?.[0]?.fondo_especial?.activo === true;
      if (!fondoActivo) throw new Error(`fondo_especial.activo no es true; body=${JSON.stringify(rCfg.body)}`);
      pass('UI-CFG.1', 'toggleFondoEspecial(true) → activo en DB');
    } catch (e) {
      fail_('UI-CFG.1', 'toggleFondoEspecial', e);
    }

    try {
      // Renombrar fondo
      const NOMBRE_FONDO = `Fondo Egreso ${TAG}`;
      await navegar(page, 'config', '#cfg-fondo-nombre');
      await page.locator('#cfg-fondo-nombre').clear();
      await page.locator('#cfg-fondo-nombre').fill(NOMBRE_FONDO);
      await page.locator('button[onclick="guardarNombreFondo()"]').click();

      // Esperar confirmación (alert o cambio en DOM) y verificar en DB
      await page.waitForTimeout(1500);
      const rNom = await rest(`/cursos?id=eq.${cursoId}&select=fondo_especial`, { _token: jwt });
      const nombreGuardado = rNom.body?.[0]?.fondo_especial?.nombre;
      if (nombreGuardado !== NOMBRE_FONDO)
        throw new Error(`Nombre esperado "${NOMBRE_FONDO}", obtenido "${nombreGuardado}"`);
      pass('UI-CFG.2', `guardarNombreFondo → nombre "${NOMBRE_FONDO}" persistido`);
    } catch (e) {
      fail_('UI-CFG.2', 'guardarNombreFondo', e);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // UI-FM — CRUD de movimientos de fondo
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[Bloque UI-FM]');

    let movId = null;

    try {
      // Navegar a fondo-especial
      await navegar(page, 'fondo-especial', 'button[onclick*="showModal"]');

      // Abrir modal nuevo movimiento
      await page.locator('button[onclick*="showModal"][onclick*="nuevoMovFondo"]').click();
      await page.waitForSelector('#fmov-nombre', { timeout: TIMEOUT });

      // Seleccionar tipo "aporte"
      await page.selectOption('#fmov-tipo', 'aporte');
      await page.waitForTimeout(300);

      // Rellenar formulario
      await page.locator('#fmov-nombre').fill(`Aporte ${TAG}`);
      await page.locator('#fmov-fecha').fill('2026-08-15');
      await page.locator('#fmov-monto').fill('30000');

      // Guardar
      await page.locator('button[onclick="saveMovFondo()"]').click();
      await page.waitForTimeout(2000);

      // Verificar en DB
      const rMov = await rest(
        `/fondo_movimientos?cuenta_id=eq.${cuentaId}&curso_id=eq.${cursoId}&nombre=like.${encodeURIComponent('Aporte ' + TAG + '%')}&select=id,nombre,monto_total`,
        { _token: jwt }
      );
      if (!rMov.ok || !rMov.body?.length)
        throw new Error(`Movimiento no encontrado en DB; body=${JSON.stringify(rMov.body)}`);
      movId = rMov.body[0].id;
      pass('UI-FM.1', `saveMovFondo → aporte creado (id=${movId})`);
    } catch (e) {
      fail_('UI-FM.1', 'saveMovFondo', e);
    }

    try {
      if (!movId) throw new Error('movId no disponible (FM.1 falló)');

      // Abrir modal edición — botón de editar en la fila del movimiento
      await page.locator(`button[onclick*="editarMovFondo"][onclick*="${movId}"]`).click();
      await page.waitForSelector('#emov-nombre', { timeout: TIMEOUT });

      // Cambiar monto
      await page.locator('#emov-monto').clear();
      await page.locator('#emov-monto').fill('31000');
      await page.locator(`button[onclick*="guardarEditMovFondo"][onclick*="${movId}"]`).click();
      await page.waitForTimeout(2000);

      // Verificar en DB
      const rEdit = await rest(
        `/fondo_movimientos?id=eq.${movId}&select=monto_total`,
        { _token: jwt }
      );
      const montoGuardado = rEdit.body?.[0]?.monto_total;
      if (montoGuardado !== 31000)
        throw new Error(`monto_total esperado 31000, obtenido ${montoGuardado}`);
      pass('UI-FM.2', `guardarEditMovFondo → monto_total=31000 persistido`);
    } catch (e) {
      fail_('UI-FM.2', 'guardarEditMovFondo', e);
    }

    // UI-FM-R: recarga de página
    try {
      await page.reload({ waitUntil: 'networkidle', timeout: TIMEOUT });
      // Esperar a que la sesión se restaure
      await page.waitForFunction(
        (id) => typeof S !== 'undefined' && S.cursoId === id,
        cursoId,
        { timeout: TIMEOUT }
      );
      await navegar(page, 'fondo-especial', 'button[onclick*="showModal"]');

      // El movimiento debe seguir visible en el DOM
      if (movId) {
        await page.waitForSelector(`button[onclick*="editarMovFondo"][onclick*="${movId}"]`, { timeout: TIMEOUT });
      }
      pass('UI-FM.3', 'recarga → movimiento visible en DOM tras page.reload()');
    } catch (e) {
      fail_('UI-FM.3', 'recarga página', e);
    }

    // UI-FM-I: cambio de curso — datos no deben aparecer en curso2
    try {
      await seleccionarCurso(page, curso2Id);
      await navegar(page, 'fondo-especial');
      await page.waitForTimeout(1500);

      // No debe existir el botón de edición del movimiento de curso1
      const domPresente = movId
        ? await page.locator(`button[onclick*="editarMovFondo"][onclick*="${movId}"]`).count()
        : 0;
      if (domPresente > 0)
        throw new Error(`Movimiento de curso1 visible en curso2 (aislamiento fallido)`);
      pass('UI-FM.4', 'cambio de curso → datos de curso1 no aparecen en curso2');

      // Volver al curso fixture
      await seleccionarCurso(page, cursoId);
    } catch (e) {
      fail_('UI-FM.4', 'cambio de curso / aislamiento', e);
    }

    // UI-FM eliminar
    try {
      if (!movId) throw new Error('movId no disponible (FM.1 falló)');

      await navegar(page, 'fondo-especial', `button[onclick*="eliminarMovFondo"][onclick*="${movId}"]`);

      // Interceptar el diálogo de confirmación
      page.once('dialog', dialog => dialog.accept());
      await page.locator(`button[onclick*="eliminarMovFondo"][onclick*="${movId}"]`).click();
      await page.waitForTimeout(2000);

      // Verificar que no existe en DB
      const rDel = await rest(`/fondo_movimientos?id=eq.${movId}&select=id`, { _token: jwt });
      if (rDel.body?.length > 0)
        throw new Error(`Movimiento sigue en DB tras eliminar; id=${movId}`);
      pass('UI-FM.5', `eliminarMovFondo → ausente en DB`);
      movId = null;
    } catch (e) {
      fail_('UI-FM.5', 'eliminarMovFondo', e);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // UI-ACT — CRUD de actividades
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[Bloque UI-ACT]');

    let actId = null;

    // Volver al curso fixture por si acaso
    await seleccionarCurso(page, cursoId).catch(() => {});

    try {
      await navegar(page, 'fondo-especial', 'button[onclick*="addActividad"]');

      // Abrir modal nueva actividad
      await page.locator('button[onclick*="addActividad"]').click();
      await page.waitForSelector('#act-nombre', { timeout: TIMEOUT });

      await page.locator('#act-nombre').fill(`Actividad ${TAG}`);
      await page.locator('#act-fecha').fill('2026-08-20');
      await page.locator('#act-monto').fill('48000');
      await page.locator('#act-obs').fill(`obs-${TAG}`);

      // Guardar actividad (nueva, sin id)
      await page.locator('button[onclick*="saveActividad"]').click();
      await page.waitForTimeout(2000);

      // Verificar en DB
      const rAct = await rest(
        `/actividades?cuenta_id=eq.${cuentaId}&curso_id=eq.${cursoId}&nombre=like.${encodeURIComponent('Actividad ' + TAG + '%')}&select=id,nombre,monto_total`,
        { _token: jwt }
      );
      if (!rAct.ok || !rAct.body?.length)
        throw new Error(`Actividad no encontrada en DB; body=${JSON.stringify(rAct.body)}`);
      actId = rAct.body[0].id;
      pass('UI-ACT.1', `saveActividad → creada (id=${actId})`);
    } catch (e) {
      fail_('UI-ACT.1', 'saveActividad crear', e);
    }

    try {
      if (!actId) throw new Error('actId no disponible (ACT.1 falló)');

      // Abrir modal edición de actividad
      await page.locator(`button[onclick*="editActividad"][onclick*="${actId}"]`).click();
      await page.waitForSelector('#act-nombre', { timeout: TIMEOUT });

      // Editar nombre y monto
      await page.locator('#act-nombre').clear();
      await page.locator('#act-nombre').fill(`Actividad Editada ${TAG}`);
      await page.locator('#act-monto').clear();
      await page.locator('#act-monto').fill('50000');

      await page.locator(`button[onclick*="saveActividad"][onclick*="${actId}"]`).click();
      await page.waitForTimeout(2000);

      // Verificar en DB
      const rActEdit = await rest(
        `/actividades?id=eq.${actId}&select=nombre,monto_total`,
        { _token: jwt }
      );
      const nomGuardado   = rActEdit.body?.[0]?.nombre || '';
      const montoGuardado = rActEdit.body?.[0]?.monto_total;
      if (!nomGuardado.includes('Editada') || montoGuardado !== 50000)
        throw new Error(`Edición no persistida; nombre="${nomGuardado}", monto=${montoGuardado}`);
      pass('UI-ACT.2', `saveActividad editar → nombre y monto_total=50000 persistidos`);
    } catch (e) {
      fail_('UI-ACT.2', 'saveActividad editar', e);
    }

    // Recarga: actividad debe seguir visible
    try {
      await page.reload({ waitUntil: 'networkidle', timeout: TIMEOUT });
      await page.waitForFunction(
        (id) => typeof S !== 'undefined' && S.cursoId === id,
        cursoId,
        { timeout: TIMEOUT }
      );
      await navegar(page, 'fondo-especial');
      await page.waitForTimeout(1500);

      if (actId) {
        await page.waitForSelector(`button[onclick*="editActividad"][onclick*="${actId}"]`, { timeout: TIMEOUT });
      }
      pass('UI-ACT.3', 'recarga → actividad editada visible en DOM');
    } catch (e) {
      fail_('UI-ACT.3', 'recarga actividad', e);
    }

    // Eliminar actividad
    try {
      if (!actId) throw new Error('actId no disponible (ACT.1 falló)');

      page.once('dialog', dialog => dialog.accept());
      await page.locator(`button[onclick*="eliminarActividad"][onclick*="${actId}"]`).click();
      await page.waitForTimeout(2000);

      const rActDel = await rest(`/actividades?id=eq.${actId}&select=id`, { _token: jwt });
      if (rActDel.body?.length > 0)
        throw new Error(`Actividad sigue en DB tras eliminar; id=${actId}`);
      pass('UI-ACT.4', `eliminarActividad → ausente en DB`);
      actId = null;
    } catch (e) {
      fail_('UI-ACT.4', 'eliminarActividad', e);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // UI-RPT — Reporte con canvas
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[Bloque UI-RPT]');

    try {
      // Crear un movimiento de actividad para que haya datos en el reporte
      const rMovAct = await rest('/fondo_movimientos', {
        method: 'POST',
        _token: jwt,
        body: JSON.stringify({
          cuenta_id: cuentaId,
          curso_id: cursoId,
          tipo: 'actividad',
          nombre: `Actividad RPT ${TAG}`,
          fecha: '2026-08-25',
          monto_total: 20000,
          participantes: aluIds.slice(0, 2),
        }),
        prefer: 'return=representation',
      });
      if (rMovAct.ok) {
        const movActId = Array.isArray(rMovAct.body) ? rMovAct.body[0]?.id : rMovAct.body?.id;
        console.log(`  [setup-rpt] movimiento actividad creado para reporte: ${movActId}`);
      }

      // Navegar a reportes
      await navegar(page, 'reportes');
      // Esperar a que aparezca el canvas (drawReporteCharts tiene setTimeout 50ms)
      await page.waitForSelector('canvas#chartRepBar', { timeout: TIMEOUT });
      await page.waitForTimeout(1000);  // Dar tiempo a Chart.js para pintar

      // Verificar que Chart.js registró datos en el canvas
      const chartDatosPresentes = await page.evaluate(() => {
        const c = document.getElementById('chartRepBar');
        if (!c) return false;
        // Chart.js adjunta la instancia al elemento
        const chart = c._chart || (window.Chart && Chart.getChart && Chart.getChart(c));
        if (!chart) {
          // Fallback: canvas tiene píxeles pintados (no está en blanco)
          const ctx2d = c.getContext('2d');
          const data = ctx2d.getImageData(0, 0, c.width, c.height).data;
          return data.some(v => v !== 0);
        }
        // Verificar que hay al menos una serie con algún dato > 0
        return chart.data?.datasets?.some(ds => ds.data?.some(v => v > 0)) ?? false;
      });

      if (!chartDatosPresentes)
        throw new Error('canvas#chartRepBar no tiene datos pintados');
      pass('UI-RPT.1', 'drawReporteCharts → canvas#chartRepBar con datos visibles');
    } catch (e) {
      fail_('UI-RPT.1', 'drawReporteCharts canvas', e);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // UI-VIS — Usuario C puede SELECT antes del rechazo
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[Bloque UI-VIS]');

    if (!USER_C_EMAIL || !USER_C_PASS) {
      pend_('UI-VIS.1', 'SELECT usuario C', 'STAGING_USER_C_EMAIL / _PASSWORD no configurados');
    } else {
      try {
        // Autenticar usuario C
        const authC = await autenticar(USER_C_EMAIL, USER_C_PASS);
        const jwtC  = authC.token;

        // Insertar membresía visor para usuario C en el curso fixture (si no existe)
        const rMem = await rest('/usuarios_cuenta', {
          method: 'POST',
          _token: jwt,  // Lo inserta el dueño (usuario A)
          body: JSON.stringify({
            user_id: authC.userId,
            cuenta_id: cuentaId,
            curso_id: cursoId,
            rol: 'visor',
          }),
          prefer: 'return=representation',
        });
        let membershipId = null;
        if (rMem.ok) {
          membershipId = Array.isArray(rMem.body) ? rMem.body[0]?.id : rMem.body?.id;
          state.membershipCId = membershipId;
          console.log(`  [ui-vis] membresía visor C creada: ${membershipId}`);
        } else {
          // Puede ya existir; buscar
          const rMemExist = await rest(
            `/usuarios_cuenta?user_id=eq.${authC.userId}&curso_id=eq.${cursoId}&select=id`,
            { _token: jwt }
          );
          if (rMemExist.body?.length) {
            membershipId = rMemExist.body[0].id;
            console.log(`  [ui-vis] membresía existente encontrada: ${membershipId}`);
          }
        }

        // Usuario C puede SELECT del curso fixture (RLS permite lectura al visor)
        const rSelect = await rest(
          `/fondo_movimientos?cuenta_id=eq.${cuentaId}&curso_id=eq.${cursoId}&select=id`,
          { _token: jwtC }
        );
        if (!rSelect.ok)
          throw new Error(`SELECT como visor falló HTTP ${rSelect.status}: ${JSON.stringify(rSelect.body)}`);
        pass('UI-VIS.1', `Usuario C (visor) puede SELECT fondo_movimientos del curso fixture`);
      } catch (e) {
        fail_('UI-VIS.1', 'SELECT usuario C', e);
      }
    }

  } catch (setupErr) {
    console.error(`\n[ERROR CRÍTICO] ${setupErr.message}`);
    fail++;
    fallos.push({ id: 'SETUP', desc: 'Setup/Login', err: setupErr.message });
  } finally {
    // ── Teardown ──────────────────────────────────────────────────────────────
    try {
      if (jwt && cuentaId && (state.cursoId || state.curso2Id)) {
        await teardown(jwt, cuentaId, state);
      }
    } catch (te) {
      console.warn(`  [teardown-error] ${te.message}`);
    }

    if (browser) await browser.close();
  }

  // ── Resumen ────────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════');
  console.log(`RESULTADO E7-UI: ${ok} OK / ${fail} FALLIDO(S) / ${pend} PENDIENTE(S)`);
  if (fallos.length) {
    console.log('\nFallos:');
    fallos.forEach(f => console.log(`  ❌ ${f.id}: ${f.desc} — ${f.err}`));
  }
  console.log('══════════════════════════════════════════\n');

  process.exit(fail > 0 ? 1 : 0);
})();
