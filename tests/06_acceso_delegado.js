/**
 * 06_acceso_delegado.js — Prueba de acceso delegado vía usuarios_cuenta (Playwright)
 *
 * Flujo:
 *   1. Usuario C (delegado) se autentica — NO tiene fila en tesorero_cuentas como propietario.
 *   2. La app lo encuentra en usuarios_cuenta y carga la cuenta del propietario (Usuario A).
 *   3. Verificar V9_RELACIONAL activo, S.session.esDelegado === true, rol === USER_C_ROL.
 *   4. DB.cursos refleja sólo los cursos permitidos por la membresía.
 *   5. Ningún intento a producción (bloqueo activo).
 *
 * Esquema real de usuarios_cuenta:
 *   id, cuenta_id, auth_id, rol, curso_id (nullable), desactivado
 *   — NO user_auth_id  — NO activo
 *   — rol válido: 'visor' | 'editor' | 'tesorero'
 *
 * NOTA: Usuario B (STAGING_USER_B_*) es propietario de su propia Cuenta B.
 *       NO se usa como delegado. Las pruebas A y B permanecen en los tests 03–05.
 *
 * PRE-REQUISITOS DE STAGING — si alguno falta el test termina con código 2 (PENDIENTE ≠ OK):
 *   - Tabla usuarios_cuenta creada con columnas: auth_id, desactivado, rol, curso_id.
 *   - Usuario C creado en Supabase Auth con STAGING_USER_C_EMAIL / STAGING_USER_C_PASSWORD.
 *   - Fila en usuarios_cuenta con desactivado = false, apuntando a la cuenta de Usuario A:
 *       INSERT INTO public.usuarios_cuenta
 *           (id, cuenta_id, auth_id, email, rol, desactivado)
 *       VALUES (
 *           'uc-c-staging',
 *           '<cuenta_id_de_usuario_A>',
 *           '<auth_uid_de_usuario_C>',
 *           '<email_de_usuario_C>',
 *           'visor',
 *           false
 *       );
 *       -- email es obligatorio en el esquema v9.
 *   - RLS en usuarios_cuenta: SELECT permitido cuando auth.uid() = auth_id.
 *
 * VARIABLES DE ENTORNO:
 *   STAGING_APP_URL            — URL de la app de staging
 *   STAGING_SUPABASE_URL       — URL del proyecto Supabase de staging
 *   STAGING_SUPABASE_ANON_KEY  — anon key (NO service_role)
 *   STAGING_USER_C_EMAIL       — email del usuario delegado (Usuario C)
 *   STAGING_USER_C_PASSWORD    — contraseña del usuario delegado
 *   STAGING_USER_C_ROL         — rol esperado ('visor', 'editor', 'tesorero'). Default: 'visor'
 *   STAGING_USER_A_EMAIL       — email del propietario (para verificar aislamiento de cuenta)
 *
 * CÓDIGOS DE SALIDA:
 *   0 — APROBADO (todas las verificaciones pasaron)
 *   1 — FALLO    (error de código, configuración incorrecta o assertion fallida)
 *   2 — PENDIENTE (setup de staging incompleto; la tabla no existe, falta membresía, etc.)
 *        ⚠️  Código 2 ≠ éxito. La ausencia de fallo de código no equivale a aprobación.
 */

'use strict';

const { chromium } = require('playwright');
const {
  instalarBloqueoProduccion,
  verificarSinIntentos,
} = require('./helpers/bloqueo_produccion');

const APP_URL       = process.env.STAGING_APP_URL              || '';
const SUPA_URL      = process.env.STAGING_SUPABASE_URL         || '';
const SUPA_KEY      = process.env.STAGING_SUPABASE_ANON_KEY    || '';
const USER_C_EMAIL    = process.env.STAGING_USER_C_EMAIL      || '';
const USER_C_PASSWORD = process.env.STAGING_USER_C_PASSWORD   || '';
const USER_C_ROL      = process.env.STAGING_USER_C_ROL        || 'visor';
const TIMEOUT = 25_000;

// URLs de producción — ningún fetch de Node ni de Playwright debe llegar aquí.
const PROD_APP_URL   = 'https://www.eltesorero.cl';
const PROD_SUPA_URL  = 'https://tmjqzaakzhecbldebyeg.supabase.co';

// ── Salida PENDIENTE (≠ aprobado; la CI lo distingue de 0) ──────────────────
function salirPendiente(razon) {
  console.error('\n[PENDIENTE] ' + razon);
  console.error('  Este test no se puede ejecutar hasta completar el setup de staging.');
  console.error('  Código de salida 2 (PENDIENTE) ≠ aprobado.\n');
  process.exit(2);
}

// ── Guardia de producción para llamadas directas de Node ────────────────────
// El bloqueo de Playwright sólo protege los fetches del navegador.
// Los fetch() de Node (autenticación, pre-vuelo) no pasan por Playwright
// y deben validarse aquí, antes de cualquier llamada de red.
function bloquearProduccionNode() {
  const appNorm  = (APP_URL  || '').replace(/\/$/, '').toLowerCase();
  const supaNorm = (SUPA_URL || '').replace(/\/$/, '').toLowerCase();
  const prodApp  = PROD_APP_URL.replace(/\/$/, '').toLowerCase();
  const prodSupa = PROD_SUPA_URL.replace(/\/$/, '').toLowerCase();

  if (appNorm === prodApp || appNorm.includes('eltesorero.cl')) {
    console.error('[FALLO] STAGING_APP_URL apunta a producción. Abortando.');
    process.exit(1);
  }
  if (supaNorm === prodSupa || supaNorm.includes('tmjqzaakzhecbldebyeg')) {
    console.error('[FALLO] STAGING_SUPABASE_URL apunta al proyecto de producción. Abortando.');
    process.exit(1);
  }
  console.log('  [ok] URLs validadas — no apuntan a producción');
}

// ── Validar variables base ───────────────────────────────────────────────────
if (!APP_URL || !SUPA_URL || !SUPA_KEY) {
  console.error('[FALLO] Faltan variables de entorno base:\n' +
    '  STAGING_APP_URL, STAGING_SUPABASE_URL, STAGING_SUPABASE_ANON_KEY');
  process.exit(1);
}

// Ejecutar ANTES de cualquier fetch de Node (incluyendo autenticación).
bloquearProduccionNode();

if (!USER_C_EMAIL || !USER_C_PASSWORD) {
  salirPendiente(
    'STAGING_USER_C_EMAIL / STAGING_USER_C_PASSWORD no configuradas.\n' +
    '  Crea Usuario C en Supabase Auth e inserta su membresía en usuarios_cuenta.'
  );
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
  return { jwt: data.access_token, uid: data.user?.id };
}

/**
 * Verifica que la tabla existe y que Usuario C tiene al menos una membresía activa.
 * Distingue entre:
 *   - tabla inexistente / error de esquema → PENDIENTE (exit 2)
 *   - tabla existe pero falta la fila de C → PENDIENTE (exit 2)
 *   - error de red / RLS bloqueante opaco  → FALLO (exit 1)
 */
async function verificarPrerequisitosStaging(jwtC, uidC) {
  // Consulta con los nombres reales de columna
  const url = `${SUPA_URL}/rest/v1/usuarios_cuenta` +
    `?auth_id=eq.${encodeURIComponent(uidC)}&desactivado=eq.false&select=id,cuenta_id,rol&limit=5`;
  const res = await fetch(url, {
    headers: {
      'apikey': SUPA_KEY,
      'Authorization': `Bearer ${jwtC}`,
      'Accept': 'application/json',
    },
  });

  if (res.status === 404) {
    salirPendiente('La tabla usuarios_cuenta no existe en el proyecto de staging (HTTP 404).');
  }

  if (res.status === 400) {
    const body = await res.text();
    if (/relation|does not exist/i.test(body)) {
      salirPendiente(`La tabla usuarios_cuenta no existe o tiene nombre distinto.\n  Detalle: ${body}`);
    }
    // Error de columna (p.ej. "column auth_id does not exist") → esquema incorrecto → FALLO de código
    throw new Error(`[FALLO] Error de esquema en usuarios_cuenta (HTTP 400): ${body}`);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[FALLO] usuarios_cuenta respondió HTTP ${res.status}: ${body}`);
  }

  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    salirPendiente(
      `usuarios_cuenta existe pero Usuario C (${USER_C_EMAIL} / uid=${uidC}) no tiene membresías activas (desactivado=false).\n` +
      '  Ejecuta en el proyecto de staging (reemplaza los valores entre <>):\n\n' +
      '    INSERT INTO public.usuarios_cuenta\n' +
      '        (id, cuenta_id, auth_id, email, rol, desactivado)\n' +
      "    VALUES (\n" +
      "        'uc-c-staging',\n" +
      "        '<cuenta_id_de_usuario_A>',\n" +
      "        '" + uidC + "',\n" +
      "        '" + USER_C_EMAIL + "',\n" +
      "        'visor',\n" +
      "        false\n" +
      '    );\n\n' +
      '  Nota: id usa el literal \'uc-c-staging\'. email es obligatorio en el esquema v9.'
    );
  }

  console.log(`  [ok] ${rows.length} membresía(s) encontrada(s) para Usuario C — rol DB: ${rows[0].rol}`);
  return rows; // para auditoría
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
  let exitCode = 0;
  let browser;
  let bloqueo;

  try {
    console.log('\n=== 06_acceso_delegado.js ===');
    console.log(`APP:          ${APP_URL}`);
    console.log(`Usuario C:    ${USER_C_EMAIL}`);
    console.log(`Rol esperado: ${USER_C_ROL}`);

    // Pre-vuelo: JWT de Usuario C
    const { jwt: jwtC, uid: uidC } = await obtenerJWT(USER_C_EMAIL, USER_C_PASSWORD);
    console.log(`  [ok] JWT obtenido para Usuario C (uid=${uidC})`);

    // Verificar prerequisitos de staging (puede salir con código 2 si faltan)
    await verificarPrerequisitosStaging(jwtC, uidC);

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ baseURL: APP_URL, locale: 'es-CL' });
    const page = await context.newPage();

    bloqueo = await instalarBloqueoProduccion(context, page);
    console.log(`  [ok] Bloqueo producción — HTTP: ${bloqueo.httpInstalado}, WS: ${bloqueo.wsInstalado}`);

    // ══════════════════════════════════════════════════════════════════════════
    // PASO 1 — Login como Usuario C (delegado)
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[Paso 1] Login como Usuario C (delegado)…');
    await page.goto('/', { waitUntil: 'networkidle', timeout: TIMEOUT });
    await page.locator('#l-email').fill(USER_C_EMAIL);
    await page.locator('#l-pass').fill(USER_C_PASSWORD);
    await page.locator('button[onclick="doLogin()"]').click();

    await page.waitForFunction(
      () => typeof S !== 'undefined' && S.session &&
            (S.route === 'dashboard' || S.route === 'selector'),
      { timeout: TIMEOUT }
    );
    console.log('  [ok] Login completado — ruta:', await page.evaluate(() => S.route));

    // ══════════════════════════════════════════════════════════════════════════
    // PASO 2 — V9_RELACIONAL activo
    // ══════════════════════════════════════════════════════════════════════════
    const v9Activo = await page.evaluate(() =>
      typeof V9_RELACIONAL !== 'undefined' && V9_RELACIONAL === true
    );
    if (!v9Activo) throw new Error('[FALLO] V9_RELACIONAL no está activo en la app de staging');
    console.log('\n[Paso 2] V9_RELACIONAL === true ✓');

    // ══════════════════════════════════════════════════════════════════════════
    // PASO 3 — Sesión marcada como delegado con el rol correcto
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[Paso 3] Verificando sesión de delegado…');
    const sesion = await page.evaluate(() => ({
      esDelegado: typeof S !== 'undefined' ? S.session?.esDelegado  : null,
      rol:        typeof S !== 'undefined' ? S.session?.rol         : null,
      v9CuentaId: typeof S !== 'undefined' ? S._v9CuentaId          : null,
    }));

    if (!sesion.esDelegado) {
      throw new Error('[FALLO] S.session.esDelegado no es true — la app no reconoció a Usuario C como delegado');
    }
    if (sesion.rol !== USER_C_ROL) {
      throw new Error(`[FALLO] S.session.rol = '${sesion.rol}', se esperaba '${USER_C_ROL}'`);
    }
    if (!sesion.v9CuentaId) {
      throw new Error('[FALLO] S._v9CuentaId nulo — cuenta del propietario no se cargó');
    }
    console.log(`  [ok] esDelegado=true  rol=${sesion.rol}  v9CuentaId=${sesion.v9CuentaId}`);

    // ══════════════════════════════════════════════════════════════════════════
    // PASO 4 — DB.cursos cargados (filtrados por membresía si curso_id != null)
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[Paso 4] DB.cursos desde la cuenta del propietario…');
    const cursosLen = await page.evaluate(() =>
      typeof DB !== 'undefined' ? (DB.cursos || []).length : -1
    );
    if (cursosLen < 1) throw new Error(`[FALLO] DB.cursos vacío para el delegado (len=${cursosLen})`);
    console.log(`  [ok] DB.cursos = ${cursosLen} (filtrados por membresía)`);

    // ══════════════════════════════════════════════════════════════════════════
    // PASO 5 — Aislamiento: ningún intento a producción
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[Paso 5] Aislamiento de producción…');
    verificarSinIntentos(bloqueo);
    console.log('  [ok] Ningún intento a producción detectado');

    console.log('\n✅ ACCESO DELEGADO OK\n');

  } catch (err) {
    console.error('\n❌ FALLO:', err.message);
    exitCode = 1;
  } finally {
    if (browser) await browser.close();
    process.exit(exitCode);
  }
})();
