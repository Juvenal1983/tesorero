/**
 * bloqueo_produccion.js — bloqueo preventivo HTTP + WebSocket hacia producción.
 *
 * Compartido por 04_verifica_no_produccion.js y 05_prueba_funcional_ui.js.
 *
 * PRODUCCIÓN (NUNCA TOCAR):
 *   https://www.eltesorero.cl
 *   https://tmjqzaakzhecbldebyeg.supabase.co
 *
 * Uso:
 *   const { instalarBloqueoProduccion, verificarSinIntentos } = require('./helpers/bloqueo_produccion');
 *   const bloqueo = await instalarBloqueoProduccion(context, page);
 *   // ...test...
 *   verificarSinIntentos(bloqueo); // lanza si hubo intentos bloqueados
 */

'use strict';

const HOSTS_PRODUCCION = [
  'eltesorero.cl',
  'www.eltesorero.cl',
  'tmjqzaakzhecbldebyeg.supabase.co',
];

/**
 * Devuelve true si la URL pertenece a un host de producción.
 */
function esUrlProduccion(url) {
  try {
    const { hostname } = new URL(url);
    return HOSTS_PRODUCCION.some(h => hostname === h || hostname.endsWith('.' + h));
  } catch (_) {
    return false;
  }
}

/**
 * Instala el bloqueo HTTP en el contexto de Playwright.
 * Registra todos los intentos bloqueados en bloqueo.intentosHTTP.
 * Lanza si se intenta acceder a producción.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {{ intentosHTTP: string[], intentosWS: string[] }} bloqueo
 */
async function instalarBloqueoHTTP(context, bloqueo) {
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (esUrlProduccion(url)) {
      const msg = `[BLOQUEO PRODUCCIÓN] Petición HTTP interceptada hacia producción: ${url}`;
      console.error(msg);
      bloqueo.intentosHTTP.push(url);
      // Abortar la petición para que el navegador reciba un error
      route.abort('blockedbyclient');
    } else {
      route.continue();
    }
  });
}

/**
 * Instala el bloqueo WebSocket en la página.
 * Registra intentos en bloqueo.intentosWS.
 *
 * @param {import('playwright').Page} page
 * @param {{ intentosHTTP: string[], intentosWS: string[] }} bloqueo
 * @returns {boolean} true si routeWebSocket está disponible
 */
async function instalarBloqueoWebSocket(page, bloqueo) {
  if (typeof page.routeWebSocket !== 'function') {
    console.warn('[bloqueo_produccion] page.routeWebSocket no disponible (requiere Playwright >= 1.48). Bloqueo WS omitido.');
    return false;
  }

  await page.routeWebSocket(/.*/, (ws) => {
    const url = ws.url();
    if (esUrlProduccion(url)) {
      const msg = `[BLOQUEO PRODUCCIÓN] Conexión WebSocket interceptada hacia producción: ${url}`;
      console.error(msg);
      bloqueo.intentosWS.push(url);
      ws.close();
    } else {
      ws.connectToServer();
    }
  });

  return true;
}

/**
 * Instala ambos bloqueos. Devuelve un objeto de estado que incluye
 * las listas de intentos registrados para que el test pueda verificarlas.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {import('playwright').Page} page
 * @returns {Promise<{ httpInstalado: boolean, wsInstalado: boolean, intentosHTTP: string[], intentosWS: string[] }>}
 */
async function instalarBloqueoProduccion(context, page) {
  const bloqueo = { httpInstalado: false, wsInstalado: false, intentosHTTP: [], intentosWS: [] };
  await instalarBloqueoHTTP(context, bloqueo);
  bloqueo.httpInstalado = true;
  bloqueo.wsInstalado = await instalarBloqueoWebSocket(page, bloqueo);
  return bloqueo;
}

/**
 * Verifica que no hubo ningún intento de acceso a producción.
 * Si los hubo, lanza un Error detallado — el test debe propagarlo como FALLO.
 *
 * @param {{ intentosHTTP: string[], intentosWS: string[] }} bloqueo
 * @throws {Error} si se detectó al menos un intento bloqueado
 */
function verificarSinIntentos(bloqueo) {
  const todos = [...bloqueo.intentosHTTP, ...bloqueo.intentosWS];
  if (todos.length === 0) return;
  throw new Error(
    `[FALLO] El test intentó conectar con producción ${todos.length} vez/veces:\n` +
    todos.map(u => `  • ${u}`).join('\n') + '\n' +
    'Producción NUNCA debe ser tocada desde los tests de staging.'
  );
}

module.exports = {
  instalarBloqueoProduccion,
  verificarSinIntentos,
  instalarBloqueoHTTP,
  instalarBloqueoWebSocket,
  esUrlProduccion,
  HOSTS_PRODUCCION,
};
