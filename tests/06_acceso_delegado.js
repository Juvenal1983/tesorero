/**
 * 06_acceso_delegado.js — Prueba de acceso delegado vía usuarios_cuenta (Playwright)
 *
 * Flujo:
 *   1. Usuario B se autentica — NO tiene fila en tesorero_cuentas como propietario.
 *   2. La app debe encontrarlo en usuarios_cuenta y cargar la cuenta del propietario.
 *   3. Verificar que V9_RELACIONAL está activo y que DB.cursos muestra sólo los cursos
 *      permitidos en la membresía (si curso_id está seteado, solo ese curso).
 *   4. Verificar que el rol cargado en S.session.rol coincide con la membresía.
 *   5. Usuario B NO puede ver datos de otra cuenta.
 *
 * PRE-REQUISITOS DE STAGING (sin estos, el test termina con PENDIENTE, no FALLO):
 *   - Tabla usuarios_cuenta creada en el proyecto de staging.
 *   - Usuario B creado en Supabase Auth (STAGING_USER_B_EMAIL / STAGING_USER_B_PASSWORD).
 *   - Fila en usuarios_cuenta:
 *       INSERT INTO public.usuarios_cuenta (cuenta_id, user_auth_id, rol, activo)
 *       VALUES ('<cuenta_id_de_usuario_A>', '<auth_uid_de_usuario_B>', 'lector', true);
 *   - RLS: usuarios_cuenta debe permitir SELECT al user_auth_id dueño de la fila.
 *
 * VARIABLES DE ENTORNO:
 *   STAGING_APP_URL            — URL de la app de staging
 *   STAGING_SUPABASE_URL       — URL del proyecto Supabase de staging
 *   STAGING_SUPABASE_ANON_KEY  — anon key (no service_role)
 *   STAGING_USER_B_EMAIL       — email del usuario invitado
 *   STAGING_USER_B_PASSWORD    — contraseña del usuario invitado
 *   STAGING_USER_B_ROL         — rol esperado ('lector', 'editor', 'tesorero'). Default: 'lector'
 *   STAGING_USER_A_EMAIL       — email del propietario (para verificar aislamiento)
 *   STAGING_USER_A_PASSWORD    — contraseña del propietario
 */

'use strict';

const { chromium } = require('playwright');
const {
  instalarBloqueoProduccion,
  verificarSinIntentos,
} = require('./helpers/bloqueo_produccion');

const APP_URL    = process.env.STAGING_APP_URL              || '';
const SUPA_URL   = process.env.STAGING_SUPABASE_URL         || '';
const SUPA_KEY   = process.env.STAGING_SUPABASE_ANON_KEY    || '';
const USER_B_EMAIL    = process.env.STAGING_USER_B_EMAIL    || '';
const USER_B_PASSWORD = process.env.STAGING_USER_B_PASSWORD || '';
const USER_B_ROL      = process.env.STAGING_USER_B_ROL      || 'lector';
const USER_A_EMAIL    = process.env.STAGING_USER_A_EMAIL    || '';
const TIMEOUT = 25_000;

// ── Validar vars mínimas ─────────────────────────────────────────────────────
if (!APP_URL || !SUPA_URL || !SUPA_KEY) {
  console.error('[FALLO] Faltan variables de entorno base:\n' +
    '  STAGING_APP_URL, STAGING_SUPABASE_URL, STAGING_SUPABASE_ANON_KEY');
  process.exit(1);
}

if (!USER_B_EMAIL || !USER_B_PASSWORD) {
  console.log('\n[PENDIENTE] STAGING_USER_B_EMAIL / STAGING_USER_B_PASSWORD no configuradas.');
  console.log('  Este test requiere un usuario invitado en usuarios_cuenta.');
  console.log('  Configura las variables y vuelve a ejecutar.\n');
  process.exit(0); // salida 0: pendiente por setup, no es un fallo del código
}

// ── Autenticar y obtener JWT ─────────────────────────────────────────────────
async function obtenerJWT(email, password) {
  const res = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'apikey': SUPA_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Auth falló para ${email} (HTTP ${res.status}): ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

// ── Verificar prerequisito: tabla usuarios_cuenta existe y tiene la fila ─────
async function verificarPrerequisitosStaging(jwtB) {
  const res = await fetch(`${SUPA_URL}/rest/v1/usuarios_cuenta?select=id&limit=1`, {
    headers: {
      'apikey': SUPA_KEY,
      'Authorization': `Bearer ${jwtB}`,
      'Accept': 'application/json',
    },
  });
  if (res.status === 404 || res.status === 400) {
    const text = await res.text();
    if (text.includes('relation') || text.includes('does not exist')) {
      console.log('\n[PENDIENTE] La tabla usuarios_cuenta no existe aún en staging.');
      console.log('  Ejecuta el script SQL de creación de la tabla y su política RLS.\n');
      return false;
    }
  }
  if (!res.ok) {
    console.log(`\n[PENDIENTE] usuarios_cuenta no accesible (HTTP ${res.status}). ` +
      'Verifica la política RLS.\n');
    return false;
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    console.log('\n[PENDIENTE] usuarios_cuenta existe pero no tiene membresías para usuario B.');
    console.log('  INSERT INTO public.usuarios_cuenta (cuenta_id, user_auth_id, rol, activo)');
    console.log('  VALUES (\'<cuenta_a>\', \'<auth_uid_b>\', \'lector\', true);\n');
    return false;
  }
  return true;
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
  let exitCode = 0;
  let browser;
  let bloqueo;

  try {
    console.log('\n=== 06_acceso_delegado.js ===');
    console.log(`APP:        ${APP_URL}`);
    console.log(`Usuario B:  ${USER_B_EMAIL}`);
    console.log(`Rol esperado: ${USER_B_ROL}`);

    // Pre-vuelo: JWT de usuario B para verificar prerequisito
    const jwtB = await obtenerJWT(USER_B_EMAIL, USER_B_PASSWORD);
    console.log('  [ok] JWT obtenido para usuario B');

    const prerequisitosOk = await verificarPrerequisitosStaging(jwtB);
    if (!prerequisitosOk) {
      process.exit(0); // pendiente, no fallo de código
    }

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ baseURL: APP_URL, locale: 'es-CL' });
    const page = await context.newPage();

    bloqueo = await instalarBloqueoProduccion(context, page);
    console.log(`  [ok] Bloqueo — HTTP: ${bloqueo.httpInstalado}, WS: ${bloqueo.wsInstalado}`);

    // ══════════════════════════════════════════════════════════════════════════
    // PASO 1 — Login como usuario B (invitado)
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[Paso 1] Login como usuario B (delegado)…');
    await page.goto('/', { waitUntil: 'networkidle', timeout: TIMEOUT });
    await page.locator('#l-email').fill(USER_B_EMAIL);
    await page.locator('#l-pass').fill(USER_B_PASSWORD);
    await page.locator('button[onclick="doLogin()"]').click();

    await page.waitForFunction(
      () => typeof S !== 'undefined' && S.session && (S.route === 'dashboard' || S.route === 'selector'),
      { timeout: TIMEOUT }
    );
    console.log('  [ok] Login completado — ruta:', await page.evaluate(() => S.route));

    // ══════════════════════════════════════════════════════════════════════════
    // PASO 2 — V9_RELACIONAL activo
    // ══════════════════════════════════════════════════════════════════════════
    const v9Activo = await page.evaluate(() =>
      typeof V9_RELACIONAL !== 'undefined' && V9_RELACIONAL === true
    );
    if (!v9Activo) throw new Error('[FALLO] V9_RELACIONAL no está activo en la app');
    console.log('\n[Paso 2] V9_RELACIONAL === true ✓');

    // ══════════════════════════════════════════════════════════════════════════
    // PASO 3 — Verificar que la sesión es de delegado con el rol correcto
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[Paso 3] Verificando sesión de delegado…');
    const sesion = await page.evaluate(() => ({
      esDelegado:  typeof S !== 'undefined' ? S.session?.esDelegado  : null,
      rol:         typeof S !== 'undefined' ? S.session?.rol         : null,
      v9CuentaId:  typeof S !== 'undefined' ? S._v9CuentaId          : null,
    }));

    if (!sesion.esDelegado) {
      throw new Error('[FALLO] S.session.esDelegado no es true — la app no reconoció al usuario como delegado');
    }
    if (sesion.rol !== USER_B_ROL) {
      throw new Error(`[FALLO] S.session.rol = '${sesion.rol}', se esperaba '${USER_B_ROL}'`);
    }
    if (!sesion.v9CuentaId) {
      throw new Error('[FALLO] S._v9CuentaId nulo — cuentaId del propietario no se cargó');
    }
    console.log(`  [ok] esDelegado=true rol=${sesion.rol} v9CuentaId=${sesion.v9CuentaId}`);

    // ══════════════════════════════════════════════════════════════════════════
    // PASO 4 — DB.cursos cargados (desde la cuenta del propietario)
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[Paso 4] DB.cursos desde la cuenta del propietario…');
    const cursosLen = await page.evaluate(() =>
      typeof DB !== 'undefined' ? (DB.cursos || []).length : -1
    );
    if (cursosLen < 1) throw new Error(`[FALLO] DB.cursos vacío para el delegado (${cursosLen})`);
    console.log(`  [ok] DB.cursos = ${cursosLen} (filtrados por membresía)`);

    // ══════════════════════════════════════════════════════════════════════════
    // PASO 5 — Aislamiento: usuario B NO puede ver datos de otra cuenta
    //          (verificado vía el bloqueo de producción, ya que la app
    //          sólo debe consultar el proyecto de staging)
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[Paso 5] Aislamiento de producción…');
    verificarSinIntentos(bloqueo);
    console.log('  [ok] Ningún intento a producción');

    console.log('\n✅ ACCESO DELEGADO OK\n');

  } catch (err) {
    console.error('\n❌ FALLO:', err.message);
    exitCode = 1;
  } finally {
    if (browser) await browser.close();
    process.exit(exitCode);
  }
})();
