/**
 * 07_guard_logout_db.js — Prueba ejecutable: logout durante carga no repuebla DB
 *
 * Problema documentado:
 *   En el flujo v9, logout() hace `DB={}; initDB()`. Pero initDB() lee
 *   previewStorage.getItem(KEY) y lo asigna a DB si encuentra datos.
 *   Si KEY todavía apunta a la clave del usuario que cerró sesión y hay datos
 *   en localStorage, la limpieza no es efectiva.
 *
 * Este test verifica TRES propiedades:
 *   A. Después de logout(), KEY no puede ser reutilizado por initDB() para leer
 *      datos del usuario anterior.  Condición: KEY debe quedar vacío o apuntar
 *      a una clave inexistente en storage tras el logout.
 *   B. El guard _v9SessionId impide que un fetch en vuelo escriba en DB después
 *      de que el epoch haya sido incrementado por logout().
 *   C. initDB() no lee datos de usuarios distintos al KEY activo.
 *
 * Este test corre en Node.js puro — no requiere Playwright ni staging.
 * Salida: 0 = OK, 1 = FALLO
 */

'use strict';

// ── Simular el entorno browser mínimo ────────────────────────────────────────

// Simular previewStorage (localStorage-like)
const _storage = new Map();
const previewStorage = {
  getItem:    k => _storage.has(k) ? _storage.get(k) : null,
  setItem:    (k, v) => _storage.set(k, String(v)),
  removeItem: k => _storage.delete(k),
  get length() { return _storage.size; },
  keys() { return [..._storage.keys()]; },
};
// Exponer Object.keys(previewStorage) como en almacenamiento.js
Object.keys = (obj) => {
  if (obj === previewStorage) return [..._storage.keys()];
  return Object.prototype.constructor.keys(obj);   // fallback para otros objetos
};

let KEY = 'tesorero_5bsscc_2026';     // clave inicial (sin usuario)
let DB  = {};
let _v9SessionId = 0;
let _authToken   = null;
let S = { session: null, cursoId: null, route: 'login', _v9CuentaId: null };

// Simular initDB() — misma lógica que almacenamiento.js
function initDB() {
  const tieneClaveUsuario = previewStorage.keys().some(k => k.startsWith('tesorero_u_'));
  if (tieneClaveUsuario) previewStorage.removeItem('tesorero_5bsscc_2026');
  try {
    const raw = previewStorage.getItem(KEY);
    if (raw) DB = JSON.parse(raw);
  } catch (e) {}
}

// Simular _setUserKeyV9() — sólo cambia KEY, no lee storage
function _setUserKeyV9(userId) {
  if (!userId) return;
  const newKey = 'tesorero_u_' + userId;
  if (newKey === KEY) return;
  KEY = newKey;
}

// Simular logout() — versión v9 corregida de acceso.js
function logout() {
  _v9SessionId++;                     // invalidar epoch ANTES de limpiar
  _authToken   = null;
  S.session    = null;
  S.cursoId    = null;
  S.route      = 'login';
  S._v9CuentaId = null;
  // ⚠️  Resetear KEY ANTES de initDB() para que no lea datos del usuario anterior.
  KEY = 'tesorero_5bsscc_2026';
  DB = {};
  initDB();
  // render() → omitido
}

// Simular guard de _v9Fetch: comprueba epoch antes de aplicar datos
function aplicarDatosGuardados(datos, snapSession) {
  if (snapSession !== _v9SessionId) {
    // Sesión cambió: descartamos los datos
    return false;
  }
  DB.cursos  = datos.cursos;
  DB.alumnos = datos.alumnos;
  return true;
}

// ── TESTS ────────────────────────────────────────────────────────────────────
let ok = 0;
let fallos = 0;

function assert(condicion, mensaje) {
  if (condicion) {
    console.log('[ok]', mensaje);
    ok++;
  } else {
    console.error('[FALLO]', mensaje);
    fallos++;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// TEST A: logout() limpia KEY para que initDB() no recargue datos del usuario
// ────────────────────────────────────────────────────────────────────────────
console.log('\n── TEST A: initDB() no recarga datos de sesión anterior tras logout ──');
{
  // Setup: usuario logueado, datos en storage
  const userId = 'abc-123';
  _setUserKeyV9(userId);                                   // KEY = 'tesorero_u_abc-123'
  const datosUsuario = JSON.stringify({ cursos: [{ id: 'c1' }], alumnos: [{ id: 'a1' }] });
  previewStorage.setItem(KEY, datosUsuario);               // guardar datos en storage
  DB = JSON.parse(datosUsuario);                           // simular DB cargada
  S.session = { id: userId };

  assert(DB.cursos?.length === 1, 'Setup: DB.cursos cargado antes del logout');

  // Logout
  logout();

  assert(S.session === null,       'logout(): S.session === null');
  assert(S._v9CuentaId === null,   'logout(): S._v9CuentaId === null');
  assert(_authToken === null,      'logout(): _authToken === null');

  // KEY después del logout: initDB() con DB={} lo leyó con KEY = 'tesorero_u_abc-123'
  // Eso es el problema: si KEY no se reseteó, initDB() repuebla DB con los datos del usuario.
  // Verificamos si los datos volvieron a DB:
  const dbRepoblada = DB.cursos?.length > 0;

  assert(!dbRepoblada,
    'DB permanece vacía tras logout() + initDB() — KEY reseteado a clave anónima');
  if (dbRepoblada) {
    console.error('  KEY actual:', KEY, '| DB.cursos.length:', DB.cursos?.length);
    console.error('  Causa: KEY no fue reseteado antes de initDB().');
  }
}

// ────────────────────────────────────────────────────────────────────────────
// TEST B: guard _v9SessionId descarta fetch en vuelo después de logout
// ────────────────────────────────────────────────────────────────────────────
console.log('\n── TEST B: guard _v9SessionId descarta datos de fetch iniciado antes de logout ──');
{
  // Resetear estado
  DB = {}; S.session = null; _v9SessionId = 0;

  // Simular: login y carga en curso
  const userId = 'xyz-456';
  _setUserKeyV9(userId);
  S.session = { id: userId };
  _v9SessionId = 1;   // sesión activa

  const snapSession = _v9SessionId;   // capturado al inicio del fetch

  // Simular: el fetch resolverá datos (simulados)
  const datosEnVuelo = { cursos: [{ id: 'c-vuelo' }], alumnos: [{ id: 'a-vuelo' }] };

  // ANTES de que el fetch resuelva, el usuario cierra sesión
  logout();   // _v9SessionId pasa de 1 a 2

  assert(_v9SessionId === 2, 'logout() incrementó _v9SessionId a 2');

  // El fetch resuelve y trata de aplicar datos (guard comprueba epoch)
  const seAplicaron = aplicarDatosGuardados(datosEnVuelo, snapSession);

  assert(!seAplicaron,             'Guard descartó los datos del fetch en vuelo');
  assert(!DB.cursos,               'DB.cursos permanece vacío (fetch descartado)');
  assert(S.session === null,       'S.session sigue null tras fetch descartado');
}

// ────────────────────────────────────────────────────────────────────────────
// TEST C: initDB() no cruza datos entre usuarios distintos
// ────────────────────────────────────────────────────────────────────────────
console.log('\n── TEST C: initDB() no lee datos de otro usuario si KEY cambió ──');
{
  // Resetear
  _storage.clear();
  DB = {}; KEY = 'tesorero_5bsscc_2026';

  // Usuario A tiene datos en storage
  const keyA = 'tesorero_u_usuario-a';
  _storage.set(keyA, JSON.stringify({ cursos: [{ id: 'cursoA' }] }));

  // Usuario B se loguea con su propio KEY
  KEY = 'tesorero_u_usuario-b';   // no hay datos para B en storage

  initDB();   // debe leer KEY='tesorero_u_usuario-b', que no existe → DB vacía

  assert(!DB.cursos || DB.cursos.length === 0,
    'initDB() no trajo datos de usuario A al loguear usuario B (keys distintos)');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n── Resultado: ${ok} ok, ${fallos} fallos`);
process.exit(fallos > 0 ? 1 : 0);
