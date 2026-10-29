// js/core/config.js
const SUPA_URL = 'https://tmjqzaakzhecbldebyeg.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRtanF6YWFremhlY2JsZGVieWVnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4OTMxMDAsImV4cCI6MjA4OTQ2OTEwMH0.ExaezLKUAkq63MHbdhYiMH6kvK98zl41S2BuHGHziZc';

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

let _authToken = null; // Token JWT de Supabase Auth — se actualiza al login

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

const authClient = (window.supabase && window.supabase.createClient)
  ? window.supabase.createClient(SUPA_URL, SUPA_KEY)
  : null;

