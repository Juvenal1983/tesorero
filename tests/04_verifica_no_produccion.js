/**
 * El Tesorero — "El Gran Cambio" v9
 * Archivo: tests/04_verifica_no_produccion.js  (v6 — selectores reales, botón doLogin(), cleanup en finally, errores inesperados como fallo)
 *
 * Prueba de navegador: verifica que la app de staging NO realiza peticiones
 * al dominio de producción, y que la sesión autenticada y la persistencia
 * de datos funcionan contra el proyecto de staging, no de producción.
 * Usa Playwright (Chromium headless, >= 1.48).
 *
 * DIFERENCIAS CON versiones anteriores:
 *   v1: solo OBSERVABA peticiones (page.on('request')), sin bloquearlas.
 *   v2: BLOQUEA activamente con context.route(); allowlist por origen.
 *   v3: serviceWorkers:'block', hostname exacto, waitUntil:'load'.
 *   v4: eltesorero.cl rechazado, credenciales obligatorias, login por desaparición del formulario.
 *   v5: WS API correcta; routeWebSocket obligatorio; JWT + dashboard; ciclo write->reload->verify->cleanup.
 *   v6 (esta versión):
 *     - Botón de login corregido: El Tesorero usa onclick="doLogin()", sin type="submit".
 *     - Selector de dashboard real: #main-content (elemento SPA de El Tesorero,
 *       reemplaza los selectores genéricos nav/main/h1 que no existen en la app).
 *     - Cleanup de notaPrueba movido a finally: se ejecuta aunque haya una
 *       excepción en el try, antes de cerrar el contexto del navegador.
 *     - Errores inesperados (catch) registrados como fallo funcional: ya no se
 *       pierde el error de navegación en el resumen final.
 *
 * VARIABLES DE ENTORNO REQUERIDAS:
 *   export STAGING_APP_URL="https://tu-sitio-staging.netlify.app"
 *   export STAGING_SUPABASE_URL="https://tu-proyecto-staging.supabase.co"
 *   export STAGING_SUPABASE_ANON_KEY="eyJ..."
 *   export STAGING_USER_A_EMAIL="usuario_a@staging.test"
 *   export STAGING_USER_A_PASSWORD="contraseña-staging-A"
 *
 * USO:
 *   node tests/04_verifica_no_produccion.js
 *
 * RESULTADO ESPERADO (exit 0):
 *   OK: ninguna petición a producción. Sesión verificada. Persistencia OK.
 *
 * RESULTADO DE FALLO (exit 1):
 *   Detalle del fallo en stderr. Revisar antes de avanzar a producción.
 */

'use strict';

import { chromium } from 'playwright';

// ── Dominios de producción conocidos ─────────────────────────
const PROD_HOSTNAMES = [
  'tmjqzaakzhecbldebyeg.supabase.co',
  'eltesorero.cl',
  'www.eltesorero.cl',
];

const APP_URL    = process.env.STAGING_APP_URL;
const SUPABASE_URL = process.env.STAGING_SUPABASE_URL;
const ANON_KEY   = process.env.STAGING_SUPABASE_ANON_KEY;
const USER_EMAIL = process.env.STAGING_USER_A_EMAIL;
const USER_PASS  = process.env.STAGING_USER_A_PASSWORD;

// UUIDs fijos del seed (08_seed_staging.sql)
const CUENTA_A = '00000000-0000-0000-aaaa-000000000001';

// ── Validaciones de entorno ────────────────────────────────────
for (const [name, val] of [
  ['STAGING_APP_URL',          APP_URL],
  ['STAGING_SUPABASE_URL',     SUPABASE_URL],
  ['STAGING_SUPABASE_ANON_KEY',ANON_KEY],
  ['STAGING_USER_A_EMAIL',     USER_EMAIL],
  ['STAGING_USER_A_PASSWORD',  USER_PASS],
]) {
  if (!val) {
    console.error(`ERROR: Define ${name}`);
    process.exit(1);
  }
}

// Validar que APP_URL es https://
try {
  const parsed = new URL(APP_URL);
  if (parsed.protocol !== 'https:') {
    console.error(`ERROR: STAGING_APP_URL debe usar https://. Recibido: ${APP_URL}`);
    process.exit(1);
  }
} catch {
  console.error(`ERROR: STAGING_APP_URL no es una URL válida: ${APP_URL}`);
  process.exit(1);
}

// Rechazar cualquier dominio de producción en las URLs de staging
const appHostname = new URL(APP_URL).hostname;
if (PROD_HOSTNAMES.includes(appHostname)) {
  console.error(`CRÍTICO: STAGING_APP_URL usa hostname de producción "${appHostname}". Abortando.`);
  process.exit(1);
}
try {
  const subHostname = new URL(SUPABASE_URL).hostname;
  if (PROD_HOSTNAMES.includes(subHostname)) {
    console.error(`CRÍTICO: STAGING_SUPABASE_URL usa hostname de producción "${subHostname}". Abortando.`);
    process.exit(1);
  }
} catch {
  console.error(`ERROR: STAGING_SUPABASE_URL no es una URL válida: ${SUPABASE_URL}`);
  process.exit(1);
}

// ── Orígenes permitidos ────────────────────────────────────────
const appOrigin        = new URL(APP_URL).origin;
const supabaseHostname = new URL(SUPABASE_URL).hostname;
// La anon key de Supabase es un JWT.  El primer componente del hostname
// (antes del primer punto) es el project-ref usado en localStorage.
const supabaseProjectRef = supabaseHostname.split('.')[0];
// Clave estándar de sesión Supabase en localStorage
const supabaseAuthKey  = `sb-${supabaseProjectRef}-auth-token`;

function esOrigenPermitido(url) {
  try {
    const parsed = new URL(url);
    if (['data:', 'blob:', 'about:'].some(p => url.startsWith(p))) return true;
    if (parsed.origin === appOrigin) return true;
    if (parsed.hostname === supabaseHostname) return true;
    if (parsed.hostname === 'fonts.googleapis.com') return true;
    if (parsed.hostname === 'fonts.gstatic.com') return true;
    return false;
  } catch { return false; }
}

function esProduccionHostname(url) {
  try { return PROD_HOSTNAMES.includes(new URL(url).hostname); }
  catch { return false; }
}

const peticionesNoPermitidas = [];
let peticionesTotales = 0;

// ── Helpers de fetch autenticado desde page.evaluate() ────────
// Estos se serializan y ejecutan dentro del contexto del navegador.
// Reciben como argumento un objeto con url, anonKey, accessToken.

async function fetchRestGet(page, path, { accessToken }) {
  return page.evaluate(async ({ supabaseUrl, anonKey, token, path }) => {
    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        }
      });
      const data = await res.json();
      return { ok: res.ok, status: res.status, data };
    } catch (e) { return { ok: false, error: e.message }; }
  }, { supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY, token: accessToken, path });
}

async function fetchRestPost(page, path, body, { accessToken }) {
  return page.evaluate(async ({ supabaseUrl, anonKey, token, path, body }) => {
    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
        method: 'POST',
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      return { ok: res.ok, status: res.status, body: text };
    } catch (e) { return { ok: false, error: e.message }; }
  }, { supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY, token: accessToken, path, body });
}

async function fetchRestDelete(page, path, { accessToken }) {
  return page.evaluate(async ({ supabaseUrl, anonKey, token, path }) => {
    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
        method: 'DELETE',
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${token}`,
        }
      });
      return { ok: res.ok, status: res.status };
    } catch (e) { return { ok: false, error: e.message }; }
  }, { supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY, token: accessToken, path });
}

async function main() {
  console.log('════════════════════════════════════════════════════════');
  console.log('El Tesorero — Verificación anti-producción (v9, v5)');
  console.log('App staging:     ', APP_URL);
  console.log('Supabase staging:', SUPABASE_URL);
  console.log('Auth key local:  ', supabaseAuthKey);
  console.log('Dominios bloqueados:', PROD_HOSTNAMES.join(', '));
  console.log('════════════════════════════════════════════════════════');

  // ── Verificar routeWebSocket ANTES de lanzar el navegador ────
  // Si no está disponible, el test aborta: una advertencia dejaría
  // los WebSockets de producción sin cobertura, invalidando el resultado.
  const browser = await chromium.launch({ headless: true });
  const contextProbe = await browser.newContext();
  const wsDisponible = typeof contextProbe.routeWebSocket === 'function';
  await contextProbe.close();

  if (!wsDisponible) {
    await browser.close();
    console.error('FALLO: routeWebSocket no está disponible en esta versión de Playwright.');
    console.error('Actualiza Playwright a >= 1.48:  npm install playwright@latest');
    console.error('Sin routeWebSocket los WebSockets a producción quedan sin interceptar.');
    process.exit(1);
  }
  console.log('routeWebSocket:  disponible ✓');

  const context = await browser.newContext({
    ignoreHTTPSErrors: false,
    serviceWorkers: 'block',
  });
  const page = await context.newPage();

  // ── Intercepción HTTP activa ──────────────────────────────────
  await context.route('**/*', (route) => {
    const url = route.request().url();
    peticionesTotales++;
    if (!esOrigenPermitido(url)) {
      peticionesNoPermitidas.push({
        url, method: route.request().method(), esProduccion: esProduccionHostname(url)
      });
      const tipo = esProduccionHostname(url) ? 'PRODUCCIÓN' : 'origen-no-permitido';
      console.error(`\n  BLOQUEADA HTTP [${tipo}] ${route.request().method()} ${url}`);
      route.abort('blockedbyclient');
    } else {
      route.continue();
    }
  });

  // ── Bloqueo de WebSockets ─────────────────────────────────────
  // context.route() no intercepta frames WebSocket.
  // ws.connectToServer() reenvía al servidor de staging; ws.close() cierra.
  await context.routeWebSocket('**', (ws) => {
    const url = ws.url();
    if (!esOrigenPermitido(url)) {
      const prod = esProduccionHostname(url);
      peticionesNoPermitidas.push({ url, method: 'WEBSOCKET', esProduccion: prod });
      const tipo = prod ? 'PRODUCCIÓN' : 'origen-no-permitido';
      console.error(`\n  BLOQUEADA WS [${tipo}] ${url}`);
      ws.close();
    } else {
      ws.connectToServer();
    }
  });

  // Detectar respuestas desde producción que pudieran eludir el route handler
  page.on('response', res => {
    const url = res.url();
    if (esProduccionHostname(url) && !peticionesNoPermitidas.some(p => p.url === url)) {
      peticionesNoPermitidas.push({ url, method: 'RESPONSE', esProduccion: true });
      console.error(`\n  ALERTA respuesta desde producción: ${url}`);
    }
  });

  let cargaExitosa    = false;
  let loginExitoso    = false;
  let lecturaOk       = false;
  let persistenciaOk  = false;
  let notaPrueba      = null;   // id de la nota ficticia, para limpieza en finally
  let cleanupToken    = null;   // JWT activo para la limpieza en finally
  let errorNavegacion = null;   // error inesperado en catch, incluido en fallos

  try {
    // ── 1. Cargar la app ────────────────────────────────────────
    console.log('\n  → Cargando app de staging...');
    const response = await page.goto(APP_URL, { waitUntil: 'load', timeout: 30000 });
    if (!response || !response.ok()) {
      const status = response?.status() ?? 'sin respuesta';
      console.error(`\n  FALLO: página no cargó (HTTP ${status}).`);
      console.error('  Verifica que STAGING_APP_URL apunta a la rama de staging desplegada.');
    } else {
      cargaExitosa = true;
      console.log(`  ✓ Página cargada (HTTP ${response.status()})`);
    }
    await page.waitForTimeout(2000);

    if (!cargaExitosa) {
      throw new Error('Página no cargó — abortando fases siguientes.');
    }

    // ── 2. Login y verificación de sesión ──────────────────────
    console.log(`  → Login como ${USER_EMAIL}...`);

    // El Tesorero usa id="l-email" y onclick="doLogin()" — no type="submit"
    const emailInput = page.locator('#l-email');
    const passInput  = page.locator('#l-pass');
    const emailVisible = await emailInput.isVisible({ timeout: 8000 });

    if (!emailVisible) {
      console.error('\n  FALLO: formulario de login no encontrado (#l-email).');
      console.error('  Verificar que STAGING_APP_URL apunta al proyecto de staging desplegado.');
    } else {
      await emailInput.fill(USER_EMAIL);
      await passInput.fill(USER_PASS);
      // El botón de login en El Tesorero usa onclick="doLogin()", no type="submit"
      const submitBtn = page.locator('button[onclick="doLogin()"]');
      const btnVisible = await submitBtn.isVisible({ timeout: 3000 });
      if (!btnVisible) {
        console.error('\n  FALLO: botón de login (onclick="doLogin()") no encontrado.');
      } else {
        await submitBtn.click();
        // Esperar respuesta de Auth (hasta 6 s en staging con latencia)
        await page.waitForTimeout(6000);

        // ── Señal (a): formulario desapareció ─────────────────
        const formularioAun = await emailInput.isVisible({ timeout: 1000 }).catch(() => false);
        if (formularioAun) {
          console.error('\n  FALLO: formulario de login sigue visible tras submit.');
          console.error('  Credenciales incorrectas, usuario no existe, o Auth de staging no configurado.');
        } else {
          console.log('  ✓ Formulario cerrado tras submit.');

          // ── Señal (b): JWT de Supabase en localStorage ───────
          // Esto confirma que Auth devolvió una sesión real, no solo que
          // el formulario desapareció por otra razón (redirección, error JS, etc.)
          const session = await page.evaluate((key) => {
            try {
              const raw = localStorage.getItem(key);
              if (!raw) return null;
              const parsed = JSON.parse(raw);
              const token = parsed?.access_token ?? parsed?.currentSession?.access_token;
              const email = parsed?.user?.email ?? parsed?.currentSession?.user?.email;
              return token ? { token, email } : null;
            } catch { return null; }
          }, supabaseAuthKey);

          if (!session) {
            console.error(`\n  FALLO: JWT no encontrado en localStorage["${supabaseAuthKey}"].`);
            console.error('  Auth puede haber respondido con error, o la app usa otra clave de sesión.');
            console.error('  Revisar el nombre real de la clave de sesión en el navegador (DevTools → Application → localStorage).');
          } else {
            console.log(`  ✓ JWT de sesión encontrado (usuario: ${session.email})`);

            // ── Señal (c): elemento de la shell SPA visible ──────
            // El Tesorero es una SPA que inyecta todo en #app.  Tras el login,
            // renderShell() crea #main-content dentro de #app.  Ese elemento
            // no existe en la pantalla de login, por lo que confirma que la
            // app entró al modo autenticado.
            const dashboardSel = '#main-content';

            let dashboardOk = false;
            try {
              await page.waitForSelector(dashboardSel, { timeout: 8000 });
              dashboardOk = true;
              console.log('  ✓ #main-content visible — shell autenticada renderizada.');
            } catch {
              console.error('\n  FALLO: #main-content no apareció tras login.');
              console.error('  Posibles causas: credenciales incorrectas, Auth de staging no configurado,');
              console.error('  o la rama desplegada no corresponde a la versión esperada.');
            }

            if (dashboardOk) {
              loginExitoso = true;
              console.log('  ✓ Login verificado: formulario cerrado + JWT activo + dashboard visible.');
            }
          }
        }
      }
    }

    // ── 3. Lectura autenticada ──────────────────────────────────
    if (loginExitoso) {
      console.log('\n  → Lectura autenticada desde staging Supabase...');
      const session = await page.evaluate((key) => {
        try {
          const raw = localStorage.getItem(key);
          const parsed = JSON.parse(raw ?? 'null');
          return parsed?.access_token ?? parsed?.currentSession?.access_token ?? null;
        } catch { return null; }
      }, supabaseAuthKey);

      if (!session) {
        console.error('  FALLO: no se pudo recuperar el token para la lectura autenticada.');
      } else {
        const resultado = await fetchRestGet(page,
          `tesorero_cuentas?id=eq.${CUENTA_A}&select=id,email`,
          { accessToken: session });

        if (!resultado.ok) {
          console.error(`  FALLO: lectura de tesorero_cuentas falló (HTTP ${resultado.status}).`);
          console.error('  Respuesta:', JSON.stringify(resultado.data ?? resultado.error));
        } else if (!Array.isArray(resultado.data) || resultado.data.length === 0) {
          console.error('  FALLO: tesorero_cuentas devolvió 0 filas para CUENTA_A — verificar seed.');
          console.error('  Respuesta:', JSON.stringify(resultado.data));
        } else {
          console.log(`  ✓ Lectura OK: cuenta encontrada (id=${resultado.data[0].id}, email=${resultado.data[0].email})`);
          lecturaOk = true;
        }
      }
    }

    // ── 4. Ciclo write → reload → verify → cleanup ─────────────
    if (lecturaOk) {
      console.log('\n  → Ciclo de persistencia: insertar nota ficticia...');
      const session = await page.evaluate((key) => {
        try {
          const raw = localStorage.getItem(key);
          const parsed = JSON.parse(raw ?? 'null');
          return parsed?.access_token ?? parsed?.currentSession?.access_token ?? null;
        } catch { return null; }
      }, supabaseAuthKey);

      cleanupToken = session;  // guardar token para finally
      notaPrueba = `nota-pw-${Date.now()}`;
      const textoEsperado = `[test-playwright-v6] ${notaPrueba}`;

      // Insertar nota de prueba
      const insert = await fetchRestPost(page,
        'notas',
        { cuenta_id: CUENTA_A, id: notaPrueba, texto: textoEsperado, privada: true },
        { accessToken: session });

      if (!insert.ok) {
        console.error(`  FALLO: INSERT de nota de prueba falló (HTTP ${insert.status}).`);
        console.error('  Respuesta:', insert.body ?? insert.error);
        notaPrueba = null; // no intentar limpieza si no se insertó
      } else {
        console.log(`  ✓ Nota ficticia insertada (id=${notaPrueba})`);

        // Recargar la página (simula apertura del dashboard en nuevo tab)
        console.log('  → Recargando la página...');
        await page.reload({ waitUntil: 'load', timeout: 30000 });
        await page.waitForTimeout(3000);

        // Recuperar token de nuevo (recarga puede renovar la sesión)
        const sessionPost = await page.evaluate((key) => {
          try {
            const raw = localStorage.getItem(key);
            const parsed = JSON.parse(raw ?? 'null');
            return parsed?.access_token ?? parsed?.currentSession?.access_token ?? null;
          } catch { return null; }
        }, supabaseAuthKey);

        if (!sessionPost) {
          console.error('  FALLO: sesión perdida tras recarga — la app no persiste la sesión.');
        } else {
          cleanupToken = sessionPost; // refrescar token para finally
          // Verificar que la nota persiste
          const verif = await fetchRestGet(page,
            `notas?cuenta_id=eq.${CUENTA_A}&id=eq.${notaPrueba}&select=id,texto`,
            { accessToken: sessionPost });

          if (!verif.ok) {
            console.error(`  FALLO: lectura post-recarga de la nota falló (HTTP ${verif.status}).`);
          } else if (!Array.isArray(verif.data) || verif.data.length === 0) {
            console.error('  FALLO: la nota ficticia NO persistió tras la recarga.');
            console.error('  Esto indica que la escritura fue a un Supabase diferente al que lee la app,');
            console.error('  o que el INSERT fue anulado silenciosamente por RLS.');
          } else if (verif.data[0].texto !== textoEsperado) {
            console.error(`  FALLO: texto de la nota no coincide. Esperado: "${textoEsperado}", obtenido: "${verif.data[0].texto}"`);
          } else {
            console.log(`  ✓ Persistencia verificada: nota recuperada post-recarga con texto correcto.`);
            persistenciaOk = true;
          }
          // Limpieza se hace en finally para garantizar ejecución.
        }
      }
    }

    // Esperar peticiones pendientes post-interacción
    await page.waitForTimeout(2000);
    console.log(`\n  → Peticiones totales interceptadas: ${peticionesTotales}`);

  } catch (err) {
    errorNavegacion = err.message;
    console.error('\n  Error inesperado de navegación:', err.message);
  } finally {
    // ── Limpieza de nota de prueba (siempre, antes de cerrar) ────
    // Si la nota fue insertada pero no eliminada (por excepción o fallo
    // de sesión post-recarga), la eliminamos aquí con el último token válido.
    if (notaPrueba && cleanupToken) {
      try {
        console.log(`\n  → Limpieza (finally): eliminando nota ${notaPrueba}...`);
        const del = await fetchRestDelete(page,
          `notas?cuenta_id=eq.${CUENTA_A}&id=eq.${notaPrueba}`,
          { accessToken: cleanupToken });
        if (!del.ok) {
          console.error(`  ⚠ Limpieza: DELETE falló (HTTP ${del.status}).`);
          console.error(`    Eliminar manualmente: DELETE FROM notas WHERE cuenta_id='${CUENTA_A}' AND id='${notaPrueba}'`);
        } else {
          // Verificar que la nota realmente desapareció (count = 0)
          const check = await fetchRestGet(page,
            `notas?cuenta_id=eq.${CUENTA_A}&id=eq.${notaPrueba}&select=id`,
            { accessToken: cleanupToken });
          const quedan = Array.isArray(check.data) ? check.data.length : '?';
          if (quedan !== 0) {
            console.error(`  ⚠ Limpieza: nota aún presente después del DELETE (filas: ${quedan}).`);
          } else {
            console.log('  ✓ Nota de prueba eliminada y verificada (0 filas).');
            notaPrueba = null;
          }
        }
      } catch (cleanupErr) {
        console.error('  ⚠ Error en limpieza de nota:', cleanupErr.message);
        console.error(`    Eliminar manualmente: DELETE FROM notas WHERE cuenta_id='${CUENTA_A}' AND id='${notaPrueba}'`);
      }
    } else if (notaPrueba) {
      // notaPrueba fue asignada pero cleanupToken es null (sesión nunca se obtuvo)
      console.error(`  ⚠ No hay token disponible para limpiar nota ${notaPrueba}.`);
      console.error(`    Eliminar manualmente: DELETE FROM notas WHERE cuenta_id='${CUENTA_A}' AND id='${notaPrueba}'`);
    }
    await context.close();
    await browser.close();
  }

  // ── Resultado ──────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════');
  console.log(`Peticiones totales interceptadas: ${peticionesTotales}`);
  console.log(`Carga: ${cargaExitosa ? 'OK' : 'FALLO'} | Login: ${loginExitoso ? 'OK' : 'FALLO'} | Lectura: ${lecturaOk ? 'OK' : 'FALLO'} | Persistencia: ${persistenciaOk ? 'OK' : 'FALLO'}`);

  const fallosFuncionales = [
    !cargaExitosa    && 'app no cargó',
    !loginExitoso    && 'sesión no verificada',
    !lecturaOk       && 'lectura autenticada falló',
    !persistenciaOk  && 'persistencia de datos falló',
    errorNavegacion  && `error inesperado: ${errorNavegacion}`,
  ].filter(Boolean);

  if (peticionesNoPermitidas.length === 0 && fallosFuncionales.length === 0) {
    console.log('OK: ninguna petición a producción detectada.');
    console.log('La app de staging opera exclusivamente sobre el proyecto de staging.');
    process.exit(0);
  }

  if (fallosFuncionales.length > 0) {
    console.error(`\nFALLO FUNCIONAL: ${fallosFuncionales.join(' / ')}`);
  }

  if (peticionesNoPermitidas.length > 0) {
    const nProd = peticionesNoPermitidas.filter(p => p.esProduccion).length;
    const nOtro = peticionesNoPermitidas.length - nProd;

    if (nProd > 0) {
      console.error(`\nFALLO CRÍTICO: ${nProd} petición(es) a dominios de PRODUCCIÓN detectadas:`);
      for (const p of peticionesNoPermitidas.filter(p => p.esProduccion)) {
        console.error(`  [${p.method}] ${p.url}`);
      }
      console.error('\nRevisión necesaria:');
      console.error('  1. Verificar SUPA_URL en js/core/config.js de la rama de staging.');
      console.error('  2. Verificar connect-src en la CSP de index.html.');
      console.error('  3. Buscar referencias hardcodeadas a dominios de producción en el código.');
    }

    if (nOtro > 0) {
      console.error(`\nADVERTENCIA: ${nOtro} petición(es) a orígenes no listados:`);
      for (const p of peticionesNoPermitidas.filter(p => !p.esProduccion)) {
        console.error(`  [${p.method}] ${p.url}`);
      }
      console.error('  Si son legítimos (CDN, analytics), agrégalos a esOrigenPermitido().');
    }
  }

  process.exit(1);
}

main();
