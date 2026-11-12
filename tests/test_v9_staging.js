#!/usr/bin/env node
/**
 * tests/test_v9_staging.js — Recorrido con datos aislados contra staging
 * =========================================================================
 * · Crea fixtures exclusivos por ejecución (nunca reutiliza cursos existentes).
 * · Limpieza garantizada en bloque finally, incluso ante fallos.
 * · Compatible con los nombres de variables del .env anterior Y los nuevos.
 *
 * Variables en .env — se aceptan AMBOS nombres; el nuevo tiene prioridad:
 *
 *   Nuevo nombre          Nombre anterior compatible
 *   ──────────────────    ──────────────────────────────
 *   STAGING_URL           STAGING_SUPABASE_URL
 *   STAGING_KEY           STAGING_SUPABASE_ANON_KEY
 *   STAGING_EMAIL         STAGING_USER_A_EMAIL
 *   STAGING_PASS          STAGING_USER_A_PASSWORD
 *
 * STAGING_CUENTA_ID y STAGING_CURSO_ID NO se usan; el test crea su propio
 * curso fixture en cada ejecución y lo borra al terminar.
 *
 * Uso (desde la raíz del proyecto):
 *   npm run test:v9           (después de npm install)
 *   node tests/test_v9_staging.js
 *
 * ⚠️  Staging únicamente. NUNCA ejecutar contra producción:
 *       https://tmjqzaakzhecbldebyeg.supabase.co
 *
 * Flujos probados:
 *   T1  Alumno + PIN: hash bcrypt, rechazo de PIN null/vacío/corto, _pinConfigurado
 *   T2  Apoderado creado → reaparece en carga completa de cuenta (simula recarga de sesión)
 *   T3  Movimiento → PATCH archivos+comprobante → reaparece al recargar
 *   T4  retryPin → cambia PIN en alumno existente sin recrearlo
 */

'use strict';

// ── Cargar .env desde la raíz del proyecto ────────────────────────────────
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

// ── Resolución de variables: nuevo nombre tiene prioridad sobre el anterior ──
const STAGING_URL = (
  process.env.STAGING_URL ||
  process.env.STAGING_SUPABASE_URL ||
  ''
).replace(/\/$/, '');

const STAGING_KEY = (
  process.env.STAGING_KEY ||
  process.env.STAGING_SUPABASE_ANON_KEY ||
  ''
);

const EMAIL = (
  process.env.STAGING_EMAIL ||
  process.env.STAGING_USER_A_EMAIL ||
  ''
);

const PASS = (
  process.env.STAGING_PASS ||
  process.env.STAGING_USER_A_PASSWORD ||
  ''
);

// ── Guardia anti-producción ───────────────────────────────────────────────
if (STAGING_URL.includes('tmjqzaakzhecbldebyeg')) {
  console.error('🚫 La URL apunta a producción. Abortando sin ejecutar nada.');
  process.exit(1);
}

// ── Variables mínimas ─────────────────────────────────────────────────────
const faltantes = [
  ['STAGING_URL / STAGING_SUPABASE_URL',           STAGING_URL],
  ['STAGING_KEY / STAGING_SUPABASE_ANON_KEY',      STAGING_KEY],
  ['STAGING_EMAIL / STAGING_USER_A_EMAIL',          EMAIL],
  ['STAGING_PASS / STAGING_USER_A_PASSWORD',        PASS],
].filter(([, v]) => !v).map(([k]) => k);

if (faltantes.length) {
  console.error('❌ Faltan variables en .env:\n  ' + faltantes.join('\n  '));
  console.error('\nCopia .env.example como .env y completa las 4 variables mínimas.');
  process.exit(1);
}

const BASE = `${STAGING_URL}/rest/v1`;
const AUTH = `${STAGING_URL}/auth/v1`;

// ── Helpers de red ────────────────────────────────────────────────────────
async function req(urlPath, opts = {}, token = null) {
  const headers = {
    'apikey':       STAGING_KEY,
    'Content-Type': 'application/json',
    'Accept':       'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    ...(opts.headers || {}),
  };
  const res = await fetch(`${BASE}${urlPath}`, { ...opts, headers });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw Object.assign(
      new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`),
      { status: res.status, body }
    );
  }
  return body;
}

async function rpc(name, params, token) {
  const res = await fetch(`${BASE}/rpc/${name}`, {
    method: 'POST',
    headers: {
      'apikey':        STAGING_KEY,
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    body: JSON.stringify(params),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw Object.assign(
      new Error(`RPC ${name} HTTP ${res.status}: ${JSON.stringify(body)}`),
      { status: res.status, body }
    );
  }
  return body;
}

/** Genera un ID corto, legible y único para fixtures de prueba */
function uid(prefix = 'test') {
  const stamp = Date.now().toString(36);
  const rand  = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${stamp}-${rand}`;
}

// ── Contadores de resultado ───────────────────────────────────────────────
let pass = 0, fail = 0;
function ok(label)         { pass++; console.log(`  ✅ ${label}`); }
function ko(label, detail) { fail++; console.error(`  ❌ ${label}${detail ? '\n     ' + detail : ''}`); }

// ── Login ─────────────────────────────────────────────────────────────────
async function login() {
  const res = await fetch(`${AUTH}/token?grant_type=password`, {
    method:  'POST',
    headers: { 'apikey': STAGING_KEY, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email: EMAIL, password: PASS }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Login falló (${res.status}): ${txt}`);
  }
  return (await res.json()).access_token;
}

// ── Autodiscovery de cuenta ───────────────────────────────────────────────
/** Devuelve el UUID de la primera cuenta que RLS expone para este usuario */
async function descubrirCuentaId(token) {
  const rows = await req('/tesorero_cuentas?select=id&limit=1', {}, token);
  if (!Array.isArray(rows) || !rows[0]?.id) {
    throw new Error(
      'No se encontró ninguna cuenta para este usuario en staging.\n' +
      '  Ejecuta sql/08_seed_staging.sql o crea una cuenta manualmente.'
    );
  }
  return rows[0].id;
}

// ── Pila de limpieza garantizada ──────────────────────────────────────────
/**
 * _cleanup acumula operaciones DELETE que se ejecutan en bloque finally.
 * Cada entrada: { table, field, id, cuentaId? }
 *   - field:    columna a filtrar (por defecto 'id')
 *   - cuentaId: si se pasa, agrega filtro cuenta_id=eq.<cuentaId>
 */
const _cleanup = [];

async function runCleanup(token) {
  if (_cleanup.length === 0) return;
  console.log('\n🧹 Limpiando fixtures de prueba…');
  // Limpiar en orden inverso (hijos antes que padres)
  for (const { table, field = 'id', id, cuentaId } of [..._cleanup].reverse()) {
    try {
      const filter = cuentaId
        ? `/${table}?cuenta_id=eq.${encodeURIComponent(cuentaId)}&${field}=eq.${encodeURIComponent(id)}`
        : `/${table}?${field}=eq.${encodeURIComponent(id)}`;
      await req(filter, { method: 'DELETE' }, token);
      console.log(`  🗑  ${table} / ${id}`);
    } catch (e) {
      console.warn(`  ⚠  no pudo limpiar ${table}/${id}: ${e.message}`);
    }
  }
}

// ── MAIN ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('═════════════════════════════════════════════════════════');
  console.log('  Test V9 staging — fixtures exclusivos por ejecución');
  console.log(`  Staging : ${STAGING_URL}`);
  console.log('═════════════════════════════════════════════════════════\n');

  // ── Login ─────────────────────────────────────────────────────────────
  let token;
  try {
    token = await login();
    ok(`Login (${EMAIL})`);
  } catch (e) {
    ko('Login', e.message);
    process.exit(1);
  }

  // ── Autodiscovery de cuenta ───────────────────────────────────────────
  let cuentaId;
  try {
    cuentaId = await descubrirCuentaId(token);
    ok(`Cuenta encontrada (${cuentaId.slice(0, 8)}…)`);
  } catch (e) {
    ko('Autodiscovery de cuenta', e.message);
    process.exit(1);
  }

  // ── Fixture: curso exclusivo de esta ejecución ────────────────────────
  // Siempre se crea uno nuevo; nunca se reutiliza un curso existente.
  const cursoId = uid('curso');
  try {
    await req('/cursos?select=id', {
      method:  'POST',
      headers: { 'Prefer': 'return=minimal' },
      body:    JSON.stringify({
        cuenta_id: cuentaId,
        id:        cursoId,
        nombre:    `[test-v9] Fixture ${new Date().toISOString()} (auto-eliminar)`,
        anio:      new Date().getFullYear(),
        activo:    false,   // inactivo para no aparecer en vistas normales
      }),
    }, token);
    // Registrar PRIMERO para que cleanup lo borre AL FINAL (hijos primero)
    _cleanup.push({ table: 'cursos', field: 'id', id: cursoId, cuentaId });
    ok(`Curso fixture creado (${cursoId})`);
  } catch (e) {
    ko('Crear curso fixture', e.message);
    process.exit(1);
  }

  // ── Bloque de tests con cleanup garantizado en finally ────────────────
  try {
    await runTests(token, cuentaId, cursoId);
  } finally {
    await runCleanup(token);
  }

  // ── Resultado final ───────────────────────────────────────────────────
  console.log('\n═════════════════════════════════════════════════════════');
  console.log(`  Resultado: ${pass} ✅ OK   ${fail} ❌ FALLIDOS`);
  console.log('═════════════════════════════════════════════════════════');

  if (fail === 0) {
    console.log('\n  Todo OK.');
    console.log('  Paso siguiente: ejecutar sql/E5_pin_rpc.sql en staging (no tocar producción).');
  } else {
    console.log('\n  Corrige los errores ❌ antes de ejecutar el RPC en staging.');
  }
  process.exit(fail > 0 ? 1 : 0);
}

// ── Cuerpo de los cuatro recorridos ──────────────────────────────────────
async function runTests(token, cuentaId, cursoId) {

  // ── T1: Alumno + PIN ────────────────────────────────────────────────
  console.log('\n── T1: Crear alumno + configurar PIN ──');
  const alumnoId = uid('alu');

  // El alumno y sus credenciales se limpian antes que el curso (orden inverso)
  // → se registran DESPUÉS del curso en la pila, así se borran ANTES en cleanup.
  try {
    await req('/alumnos?select=id', {
      method:  'POST',
      headers: { 'Prefer': 'return=minimal' },
      body:    JSON.stringify({
        cuenta_id: cuentaId,
        curso_id:  cursoId,
        id:        alumnoId,
        nombres:   'Fixture',
        apellidos: 'AisladoV9',
        estado:    'activo',
      }),
    }, token);
    _cleanup.push({ table: 'alumnos_credenciales', field: 'alumno_id', id: alumnoId, cuentaId });
    _cleanup.push({ table: 'alumnos', id: alumnoId, cuentaId });
    ok(`Alumno creado (${alumnoId})`);
  } catch (e) {
    ko('Crear alumno', e.message);
    return; // sin alumno no tiene sentido continuar T1
  }

  // 1a. null → pin_vacio
  try {
    const r = await rpc('tesorero_set_pin',
      { p_cuenta_id: cuentaId, p_alumno_id: alumnoId, p_pin: null }, token);
    r?.ok === false && r?.error === 'pin_vacio'
      ? ok('PIN null → pin_vacio')
      : ko('PIN null debería devolver pin_vacio', JSON.stringify(r));
  } catch (e) { ko('PIN null — error inesperado', e.message); }

  // 1b. cadena vacía → pin_vacio
  try {
    const r = await rpc('tesorero_set_pin',
      { p_cuenta_id: cuentaId, p_alumno_id: alumnoId, p_pin: '' }, token);
    r?.ok === false && r?.error === 'pin_vacio'
      ? ok('PIN vacío → pin_vacio')
      : ko('PIN vacío debería devolver pin_vacio', JSON.stringify(r));
  } catch (e) { ko('PIN vacío — error inesperado', e.message); }

  // 1c. solo espacios → pin_vacio  (trim en el servidor)
  try {
    const r = await rpc('tesorero_set_pin',
      { p_cuenta_id: cuentaId, p_alumno_id: alumnoId, p_pin: '   ' }, token);
    r?.ok === false && r?.error === 'pin_vacio'
      ? ok('PIN solo espacios → pin_vacio (trim en servidor)')
      : ko('PIN con espacios debería devolver pin_vacio', JSON.stringify(r));
  } catch (e) { ko('PIN espacios — error inesperado', e.message); }

  // 1d. 3 caracteres → pin_muy_corto
  try {
    const r = await rpc('tesorero_set_pin',
      { p_cuenta_id: cuentaId, p_alumno_id: alumnoId, p_pin: '123' }, token);
    r?.ok === false && r?.error === 'pin_muy_corto'
      ? ok('PIN 3 chars → pin_muy_corto')
      : ko('PIN corto debería devolver pin_muy_corto', JSON.stringify(r));
  } catch (e) { ko('PIN corto — error inesperado', e.message); }

  // 1e. PIN válido → ok:true
  const pinValido = 'PRUEBA9';
  try {
    const r = await rpc('tesorero_set_pin',
      { p_cuenta_id: cuentaId, p_alumno_id: alumnoId, p_pin: pinValido }, token);
    r?.ok === true
      ? ok('PIN válido guardado (ok:true)')
      : ko('PIN válido falló', JSON.stringify(r));
  } catch (e) { ko('PIN válido — error inesperado', e.message); }

  // 1f. hash en BD es bcrypt, nunca texto plano
  try {
    const rows = await req(
      `/alumnos_credenciales?cuenta_id=eq.${encodeURIComponent(cuentaId)}&alumno_id=eq.${encodeURIComponent(alumnoId)}&select=pin_hash`,
      {}, token
    );
    const hash = rows?.[0]?.pin_hash;
    hash?.startsWith('$2')
      ? ok('pin_hash comienza con $2 (bcrypt confirmado)')
      : ko('pin_hash no tiene formato bcrypt', String(hash));
    hash && hash !== pinValido
      ? ok('pin_hash ≠ texto plano (nunca credencial visible)')
      : ko('pin_hash igual al texto plano — no se hasheó');
  } catch (e) { ko('Leer alumnos_credenciales', e.message); }

  // ── T2: Apoderado → simula recarga de sesión ────────────────────────
  console.log('\n── T2: Apoderado → reaparece en carga completa de cuenta ──');
  const apId = uid('ap');
  try {
    await req('/apoderados?select=id', {
      method:  'POST',
      headers: { 'Prefer': 'return=minimal' },
      body:    JSON.stringify({
        cuenta_id: cuentaId,
        alumno_id: alumnoId,
        id:        apId,
        nombre:    'Apoderado Fixture',
        relacion:  'Padre',
        telefono:  '+56912345678',
      }),
    }, token);
    _cleanup.push({ table: 'apoderados', id: apId, cuentaId });
    ok('Apoderado creado');
  } catch (e) { ko('Crear apoderado', e.message); }

  // Simula cargarTodosApoderadosV9: GET sin filtrar por alumno_id
  try {
    const rows = await req(
      `/apoderados?cuenta_id=eq.${encodeURIComponent(cuentaId)}&select=id&order=nombre.asc`,
      {}, token
    );
    Array.isArray(rows) && rows.some(r => r.id === apId)
      ? ok('Apoderado reaparece en carga completa (simula cargarTodosApoderadosV9)')
      : ko('Apoderado NO encontrado en carga de cuenta',
          `ids presentes: [${(rows || []).map(r => r.id).join(', ')}]`);
  } catch (e) { ko('Cargar todos los apoderados', e.message); }

  // ── T3: Movimiento → PATCH archivos+comprobante → recargar ──────────
  console.log('\n── T3: Movimiento → PATCH archivos+comprobante → recargar ──');
  const movId = uid('mov');
  try {
    await req('/movimientos?select=id', {
      method:  'POST',
      headers: { 'Prefer': 'return=minimal' },
      body:    JSON.stringify({
        cuenta_id: cuentaId,
        curso_id:  cursoId,
        id:        movId,
        tipo:      'gasto',
        desc:      'Pago fixture T3 (auto-eliminar)',
        monto:     1000,
        fecha:     new Date().toISOString().slice(0, 10),
        visible:   true,
      }),
    }, token);
    _cleanup.push({ table: 'movimientos', id: movId, cuentaId });
    ok('Movimiento creado');
  } catch (e) { ko('Crear movimiento', e.message); }

  // URLs ficticias — prueba que el PATCH acepta los campos nuevos
  const fakeUrls       = [{
    nombre: 'comprobante-fixture.pdf',
    url:    'https://staging.example/file/comprobante-fixture.pdf',
    tipo:   'application/pdf',
  }];
  const fakeComprobante = fakeUrls[0].url;

  try {
    const rows = await req(
      `/movimientos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${encodeURIComponent(movId)}&select=archivos,comprobante`,
      {
        method:  'PATCH',
        headers: { 'Prefer': 'return=representation' },
        body:    JSON.stringify({ archivos: fakeUrls, comprobante: fakeComprobante }),
      }, token
    );
    rows?.[0]?.comprobante === fakeComprobante
      ? ok('comprobante persistido en PostgreSQL (campo TEXT)')
      : ko('comprobante no encontrado tras PATCH', JSON.stringify(rows?.[0]?.comprobante));
    Array.isArray(rows?.[0]?.archivos) && rows[0].archivos.length > 0
      ? ok('archivos (JSONB) persistidos en PostgreSQL')
      : ko('archivos no encontrados tras PATCH', JSON.stringify(rows?.[0]?.archivos));
  } catch (e) { ko('PATCH archivos+comprobante', e.message); }

  // Recargar desde cero (simula cargarMovimientosV9)
  try {
    const rows = await req(
      `/movimientos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${encodeURIComponent(movId)}&select=archivos,comprobante`,
      {}, token
    );
    rows?.[0]?.comprobante === fakeComprobante
      ? ok('comprobante reaparece al recargar (simula cargarMovimientosV9)')
      : ko('comprobante perdido tras recarga', JSON.stringify(rows?.[0]));
  } catch (e) { ko('Recargar movimiento', e.message); }

  // ── T4: retryPin sin recrear el alumno ──────────────────────────────
  console.log('\n── T4: retryPin — cambiar PIN en alumno existente ──');

  // Leer hash actual para verificar que cambia
  let hashAnterior = null;
  try {
    const rows = await req(
      `/alumnos_credenciales?cuenta_id=eq.${encodeURIComponent(cuentaId)}&alumno_id=eq.${encodeURIComponent(alumnoId)}&select=pin_hash`,
      {}, token
    );
    hashAnterior = rows?.[0]?.pin_hash || null;
  } catch (_) {}

  const pinNuevo = 'RETRY42';
  try {
    const r = await rpc('tesorero_set_pin',
      { p_cuenta_id: cuentaId, p_alumno_id: alumnoId, p_pin: pinNuevo }, token);
    r?.ok === true
      ? ok('retryPin: RPC devuelve ok:true (alumno existente)')
      : ko('retryPin: RPC falló', JSON.stringify(r));
  } catch (e) { ko('retryPin — error inesperado', e.message); }

  try {
    const rows = await req(
      `/alumnos_credenciales?cuenta_id=eq.${encodeURIComponent(cuentaId)}&alumno_id=eq.${encodeURIComponent(alumnoId)}&select=pin_hash`,
      {}, token
    );
    const hashNuevo = rows?.[0]?.pin_hash;
    hashNuevo?.startsWith('$2')
      ? ok('Hash nuevo tiene formato bcrypt')
      : ko('Hash nuevo no tiene formato bcrypt', String(hashNuevo));
    hashNuevo && hashAnterior && hashNuevo !== hashAnterior
      ? ok('Hash cambió tras retryPin (ON CONFLICT DO UPDATE efectivo)')
      : ko('Hash no cambió — upsert no funcionó',
          `anterior=${hashAnterior?.slice(0, 10)}…  nuevo=${hashNuevo?.slice(0, 10)}…`);
  } catch (e) { ko('Verificar hash tras retryPin', e.message); }
}

main().catch(e => { console.error('\nError fatal:', e.message || e); process.exit(1); });
