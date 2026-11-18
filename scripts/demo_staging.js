/**
 * scripts/demo_staging.js
 *
 * Servidor demo para explorar la app contra Supabase Staging.
 *
 * ── Lo que hace ───────────────────────────────────────────────────────────────
 *  • Lee staging config de tu .env (sin modificarlo).
 *  • Sirve todos los archivos de la app desde disco (sin tocar index.html ni __env.js).
 *  • Intercepta GET /__env.js y devuelve la config de staging en memoria, como si
 *    fuera el __env.js real, pero sin escribir nada en disco.
 *  • Reemplaza el marcador STAGING_SUPA_HOST en index.html (Content-Security-Policy)
 *    para que las peticiones a Supabase no sean bloqueadas por el browser.
 *  • Mantiene el servidor abierto hasta Ctrl+C.
 *  • Compatible con Windows (usa path.join; no depende de separadores Unix).
 *
 * ── Uso ───────────────────────────────────────────────────────────────────────
 *  node scripts/demo_staging.js
 *
 * ── Variables .env esperadas ─────────────────────────────────────────────────
 *  STAGING_SUPABASE_URL          https://rucgmytyxpfowznowxwd.supabase.co
 *  STAGING_SUPABASE_ANON_KEY     eyJ...
 *  (opcional) DEMO_PORT          puerto local, por defecto 8899
 *
 * ── "Recordar alumno" vs. "Restaurar sesión autenticada" ────────────────────
 *  ESTOS SON COMPORTAMIENTOS DISTINTOS — no confundir:
 *
 *  1. "Recordar alumno y volver a pedir PIN" (implementado, localStorage V9):
 *     Persiste cuentaId + alumnoId + nombre en localStorage.
 *     Al reabrir la app el formulario se pre-rellena con ese alumno.
 *     El usuario SIEMPRE debe ingresar su PIN para abrir la sesión.
 *     El PIN NUNCA se persiste.
 *     Implementado en js/core/session.js (tesorero_ap_v9_* keys).
 *
 *  2. "Restaurar sesión autenticada del tesorero" (NO implementado):
 *     Requeriría guardar el JWT / refresh_token del tesorero.
 *     Permitiría abrir la sesión sin ingresar credenciales al recargar.
 *     Es un alcance completamente diferente y está fuera de scope.
 *
 * Producción excluida. Este script se niega a arrancar con la URL de producción.
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

// ── Cargar .env desde la raíz del proyecto ───────────────────────────────────
const ROOT = path.resolve(__dirname, '..');
try {
  require('dotenv').config({ path: path.join(ROOT, '.env') });
} catch (_) {
  // dotenv no instalado → continúa; las variables deben estar en el entorno
}

// ── Leer config ───────────────────────────────────────────────────────────────
const SUPA_URL_RAW = (
  process.env.STAGING_SUPABASE_URL ||
  process.env.STAGING_URL ||
  ''
).replace(/\/$/, '');

const ANON_KEY = (
  process.env.STAGING_SUPABASE_ANON_KEY ||
  process.env.STAGING_KEY ||
  ''
);

const PORT = parseInt(process.env.DEMO_PORT || '8899', 10);

// ── Validar variables obligatorias ───────────────────────────────────────────
if (!SUPA_URL_RAW || !ANON_KEY) {
  console.error('');
  console.error('❌  Faltan variables de entorno.');
  console.error('    Agrega en tu .env:');
  console.error('      STAGING_SUPABASE_URL=https://rucgmytyxpfowznowxwd.supabase.co');
  console.error('      STAGING_SUPABASE_ANON_KEY=eyJ...');
  console.error('');
  process.exit(1);
}

// ── Guardia de producción ────────────────────────────────────────────────────
const PROD_HOST    = 'tmjqzaakzhecbldebyeg.supabase.co';
const STAGING_HOST = 'rucgmytyxpfowznowxwd.supabase.co';

let parsedHost;
try {
  parsedHost = new URL(SUPA_URL_RAW).hostname;
} catch (_) {
  console.error('❌  STAGING_SUPABASE_URL no es una URL válida:', SUPA_URL_RAW);
  process.exit(2);
}

if (parsedHost === PROD_HOST) {
  console.error('');
  console.error('🚫  PRODUCCIÓN BLOQUEADA. Este script no puede usarse con la URL de producción.');
  console.error('    URL detectada:', SUPA_URL_RAW);
  console.error('');
  process.exit(2);
}

if (parsedHost !== STAGING_HOST) {
  console.error('');
  console.error('⚠️   Host no reconocido:', parsedHost);
  console.error('    Se esperaba:', STAGING_HOST);
  console.error('    Corrige STAGING_SUPABASE_URL en .env o usa el host de staging correcto.');
  console.error('');
  process.exit(2);
}

// ── Contenido de __env.js servido en memoria (sin tocar el archivo en disco) ──
// La app lee window.STAGING_SUPA_URL y window.STAGING_SUPA_KEY desde config.js.
// Este contenido reemplaza lo que cargaría el __env.js real (si existiera).
const ENV_JS_CONTENT = [
  '// Inyectado en memoria por scripts/demo_staging.js — staging únicamente',
  `window.STAGING_SUPA_URL = ${JSON.stringify(SUPA_URL_RAW)};`,
  `window.STAGING_SUPA_KEY = ${JSON.stringify(ANON_KEY)};`,
  '',
].join('\n');

// ── Tipos MIME ────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// ── Servidor ──────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // Normalizar path: quitar query string, decodificar, eliminar ../ (Windows safe)
  const rawPath = (req.url || '/').split('?')[0];
  let decoded;
  try { decoded = decodeURIComponent(rawPath); } catch (_) { decoded = rawPath; }

  // Interceptar /__env.js → config de staging en memoria
  if (decoded === '/__env.js') {
    res.writeHead(200, { 'Content-Type': MIME['.js'] });
    res.end(ENV_JS_CONTENT);
    return;
  }

  // Resolver ruta en disco (Windows: path.join maneja separadores)
  const relParts = decoded.split('/').filter(p => p && p !== '..' && p !== '.');
  const diskPath = relParts.length === 0
    ? path.join(ROOT, 'index.html')
    : path.join(ROOT, ...relParts);

  if (!fs.existsSync(diskPath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found: ' + decoded);
    return;
  }

  const ext  = path.extname(diskPath).toLowerCase();
  const mime = MIME[ext] || 'text/plain; charset=utf-8';

  // Para archivos de texto: reemplazar marcador CSP en index.html
  const isText = mime.includes('text') || mime.includes('javascript') || mime.includes('json');
  if (isText) {
    let content;
    try { content = fs.readFileSync(diskPath, 'utf8'); } catch (e) {
      res.writeHead(500); res.end('Read error'); return;
    }
    // index.html tiene Content-Security-Policy con placeholder STAGING_SUPA_HOST
    content = content.replace(/https:\/\/STAGING_SUPA_HOST/g, `https://${STAGING_HOST}`);
    content = content.replace(/wss:\/\/STAGING_SUPA_HOST/g,   `wss://${STAGING_HOST}`);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
  } else {
    // Binarios: stream directo
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(diskPath).pipe(res);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('══════════════════════════════════════════════════════════');
  console.log(' 🚀  Demo Tesorero — Staging');
  console.log('══════════════════════════════════════════════════════════');
  console.log('');
  console.log(' App:      http://localhost:' + PORT);
  console.log(' Staging:  ' + SUPA_URL_RAW);
  console.log('');
  console.log(' • index.html y archivos se sirven desde disco (sin modificar).');
  console.log(' • /__env.js se sirve en memoria con la config de staging.');
  console.log(' • "Recordar alumno": guarda identidad, no PIN. PIN siempre se pide.');
  console.log('');
  console.log(' Presiona Ctrl+C para detener el servidor.');
  console.log('══════════════════════════════════════════════════════════');
  console.log('');
});

// Mantener el proceso vivo hasta Ctrl+C
// En Windows y Unix: SIGINT (Ctrl+C), SIGTERM (kill/taskkill)
function shutdown(sig) {
  console.log('\n  Señal ' + sig + ' recibida. Cerrando servidor...');
  server.close(() => {
    console.log('  Servidor detenido. ¡Hasta pronto!');
    process.exit(0);
  });
  // Forzar cierre si tarda más de 3 s
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
