// js/core/config.js
// ────────────────────────────────────────────────────────────────────────────
// ⚠️  RAMA gran-cambio-v9-relacional — configuración de STAGING
// ────────────────────────────────────────────────────────────────────────────
// Reemplaza SUPA_URL y SUPA_KEY con los valores del proyecto de STAGING
// antes de ejecutar las pruebas.  NUNCA use las credenciales de producción:
//   Producción (NO TOCAR): https://tmjqzaakzhecbldebyeg.supabase.co
//
// V9_RELACIONAL activa la capa de datos relacional (datos_v9.js).
// Poner en false para volver al flujo blob legado.

const V9_RELACIONAL = true;

// TODO(staging): reemplazar con URL y anon key del proyecto de staging.
//   Ejemplo: const SUPA_URL = 'https://XXXXXXXXXXXXXXXXXXXX.supabase.co';
const SUPA_URL = (typeof STAGING_SUPA_URL !== 'undefined' && STAGING_SUPA_URL)
  || 'https://STAGING_URL_PENDIENTE.supabase.co';

// TODO(staging): reemplazar con la anon key del proyecto de staging.
const SUPA_KEY = (typeof STAGING_SUPA_KEY !== 'undefined' && STAGING_SUPA_KEY)
  || 'STAGING_ANON_KEY_PENDIENTE';

// previewStorage → en producción usa localStorage directamente
const previewStorage = {
  getItem:    name  => { try { return localStorage.getItem(name); } catch(e) { return null; } },
  setItem:    (name, value) => { try { localStorage.setItem(name, value); } catch(e) {} },
  removeItem: name  => { try { localStorage.removeItem(name); } catch(e) {} },
  clear:      ()    => { try { localStorage.clear(); } catch(e) {} },
  get length()      { try { return localStorage.length; } catch(e) { return 0; } },
  key:        i     => { try { return localStorage.key(i); } catch(e) { return null; } }
};
// Hacer iterable con Object.keys()
Object.defineProperty(previewStorage, Symbol.iterator, {
  value: function*() {
    try { for(let i=0;i<localStorage.length;i++) yield localStorage.key(i); } catch(e){}
  }
});

let _authToken = null;    // Token JWT de Supabase Auth — se actualiza al login
let _v9SessionId = 0;     // Epoch de sesión v9 — se incrementa al logout/nuevo-login
                          // para descartar fetches en vuelo de sesiones anteriores

// DEMO vacío: en producción no existe data/demo.json
// Se usa solo como fallback seguro cuando la DB local está vacía
const DEMO = {
  usuarios:[], colegios:[], cursos:[], alumnos:[], apoderados:[],
  cuotas:[], pagos:[], movimientos:[], categorias:[], planesPago:[],
  config:{}
};
const APP_VERSION = '3.5';

// ─────────────────────────────────────────────
// SISTEMA DE VOCABULARIO TRANSVERSAL
// Permite adaptar la app a cualquier tipo de organización
// ─────────────────────────────────────────────
const VOCABULARIOS = {
  curso: {
    nombre:       'Curso escolar',
    icono:        '🏫',
    organizacion: 'Curso',
    miembro:      'Alumno',
    miembros:     'Alumnos',
    contacto:     'Apoderado',
    contactos:    'Apoderados',
    grupo:        'Curso',
    grupos:       'Cursos',
    institucion:  'Colegio',
    gestor:       'Tesorero/a',
    mesInicioDefault: 2,  // Marzo
    mesFinDefault:    11, // Diciembre
    categorias:   ['Cuota de curso','Convivencia','Paseo','Materiales','Regalo profesor','Rifa','Donación','Imprevistos','Evento','Transporte','Alimentación','Otro']
  },
  vecinos: {
    nombre:       'Junta de vecinos',
    icono:        '🏘️',
    organizacion: 'Junta de vecinos',
    miembro:      'Vecino',
    miembros:     'Vecinos',
    contacto:     'Contacto',
    contactos:    'Contactos',
    grupo:        'Sector',
    grupos:       'Sectores',
    institucion:  'Junta de vecinos',
    gestor:       'Tesorero/a',
    mesInicioDefault: 0,  // Enero
    mesFinDefault:    11, // Diciembre
    categorias:   ['Cuota mensual','Mantención','Eventos','Seguridad','Iluminación','Áreas verdes','Administración','Imprevistos','Donación','Otro']
  },
  deportivo: {
    nombre:       'Club deportivo',
    icono:        '⚽',
    organizacion: 'Club',
    miembro:      'Socio',
    miembros:     'Socios',
    contacto:     'Contacto',
    contactos:    'Contactos',
    grupo:        'Categoría',
    grupos:       'Categorías',
    institucion:  'Club',
    gestor:       'Tesorero/a',
    mesInicioDefault: 0,
    mesFinDefault:    11,
    categorias:   ['Cuota mensual','Equipamiento','Arbitraje','Traslados','Inscripciones','Torneo','Cancha','Implementos','Premiación','Imprevistos','Otro']
  },
  mayores: {
    nombre:       'Adultos mayores',
    icono:        '👴',
    organizacion: 'Agrupación',
    miembro:      'Integrante',
    miembros:     'Integrantes',
    contacto:     'Familiar',
    contactos:    'Familiares',
    grupo:        'Grupo',
    grupos:       'Grupos',
    institucion:  'Agrupación',
    gestor:       'Tesorero/a',
    mesInicioDefault: 0,
    mesFinDefault:    11,
    categorias:   ['Cuota mensual','Paseo','Almuerzo','Taller','Salud','Transporte','Recreación','Celebración','Imprevistos','Donación','Otro']
  },
  personalizado: {
    nombre:       'Personalizado',
    icono:        '⚙️',
    organizacion: 'Organización',
    miembro:      'Miembro',
    miembros:     'Miembros',
    contacto:     'Contacto',
    contactos:    'Contactos',
    grupo:        'Grupo',
    grupos:       'Grupos',
    institucion:  'Institución',
    gestor:       'Tesorero/a',
    mesInicioDefault: 0,
    mesFinDefault:    11,
    categorias:   ['Cuota mensual','Evento','Actividad','Materiales','Administración','Imprevistos','Donación','Otro']
  }
};

// Devuelve el vocabulario activo según DB.config.tipoOrg
function vocab(){
  const tipo = DB.config?.tipoOrg || 'curso';
  const custom = DB.config?.vocabCustom || {};
  const base = VOCABULARIOS[tipo] || VOCABULARIOS.curso;
  return {...base, ...custom};
}

// Shorthand para acceder a un término del vocabulario
function V(key){ return vocab()[key] || key; }
const PLANTILLA_PAGO_DEFAULT = 'Estimado/a {apoderado} 👋\n\nLe informamos que se ha registrado exitosamente el siguiente pago:\n\n👤 {miembro}: {alumno}\n📋 Cuota: {cuota}\n📅 Período: {periodo}\n💰 Monto: {monto}\n📆 Fecha de pago: {fecha}\n💳 Medio de pago: {medio}\n\n🏢 {grupo}: {curso} · {colegio}\n\nGracias por su puntualidad.\n\n— {tesorero}';
const VERSION_KEY = 'tesorero_version';

// G07-fix: guard de startup — abortar si la URL apunta a producción o no es el staging esperado.
// Esto previene que un despliegue accidental con credenciales equivocadas afecte producción.
(function _guardarUrlStagingCheck(){
  const PROD_HOST = 'tmjqzaakzhecbldebyeg.supabase.co';
  const STAGING_REF = 'rucgmytyxpfowznowxwd';
  if (!SUPA_URL || SUPA_URL.includes('STAGING_URL_PENDIENTE') || SUPA_URL.includes('placeholder')) {
    // URL de staging no configurada — es un despliegue de desarrollo sin credenciales.
    // Se permite arrancar pero sin autenticación real (authClient quedará null o no-op).
    console.warn('[config] SUPA_URL de staging no configurada — modo sin servidor.');
    return;
  }
  if (SUPA_URL.includes(PROD_HOST)) {
    const msg = '[TesorerApp] ¡ERROR CRÍTICO! La URL de Supabase apunta a PRODUCCIÓN en esta rama de staging. La aplicación no puede iniciar. Revisa config.js y las variables de entorno.';
    console.error(msg);
    // Bloquear todo renderizado mostrando pantalla de error.
    document.addEventListener('DOMContentLoaded', function(){
      document.body.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;background:#fef2f2;font-family:sans-serif"><div style="max-width:480px;padding:32px;background:#fff;border:2px solid #ef4444;border-radius:12px;text-align:center"><div style="font-size:32px;margin-bottom:12px">🚫</div><h2 style="color:#dc2626;margin:0 0 12px">URL de producción detectada</h2><p style="color:#374151">Esta rama de staging está configurada con una URL de producción. La aplicación no puede iniciar para proteger los datos reales.</p><p style="color:#6b7280;font-size:12px;font-family:monospace">${SUPA_URL}</p><p style="color:#374151;font-size:13px">Corrige <code>SUPA_URL</code> en config.js o las variables de entorno y vuelve a cargar.</p></div></div>`;
    });
    throw new Error(msg);
  }
  if (V9_RELACIONAL && !SUPA_URL.includes(STAGING_REF)) {
    console.warn('[config] ADVERTENCIA: en modo V9_RELACIONAL la URL no contiene el project ref de staging esperado (' + STAGING_REF + '). URL actual: ' + SUPA_URL + '. Verifica que sea el staging correcto.');
  }
})();

const authClient = (window.supabase && window.supabase.createClient)
  ? window.supabase.createClient(SUPA_URL, SUPA_KEY)
  : null;

