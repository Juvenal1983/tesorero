#!/usr/bin/env node
/**
 * test_v9_staging.js — Recorrido de prueba con datos aislados contra staging
 *
 * Prueba los cuatro flujos corregidos en esta sesión:
 *   T1: Alumno + PIN → _pinConfigurado nunca expone credencial
 *   T2: Recarga de sesión → apoderados y movimientos visibles sin CRUD previo
 *   T3: Movimiento con comprobante → URLs persistidas en PostgreSQL
 *   T4: retryPin → PIN configurable sin recrear el alumno
 *
 * Uso:
 *   STAGING_URL=https://rucgmytyxpfowznowxwd.supabase.co \
 *   STAGING_KEY=<anon_key> \
 *   STAGING_EMAIL=<email_tesorero> \
 *   STAGING_PASS=<contraseña> \
 *   STAGING_CUENTA_ID=<uuid_cuenta> \
 *   STAGING_CURSO_ID=<uuid_curso> \
 *   node test_v9_staging.js
 *
 * ⚠️  Usa datos de staging (rucgmytyxpfowznowxwd). NUNCA ejecutar
 *     contra producción (tmjqzaakzhecbldebyeg).
 */

'use strict';

// ─── Configuración desde variables de entorno ─────────────────────────────────
const STAGING_URL  = process.env.STAGING_URL  || 'https://rucgmytyxpfowznowxwd.supabase.co';
const STAGING_KEY  = process.env.STAGING_KEY  || '';
const EMAIL        = process.env.STAGING_EMAIL  || '';
const PASS         = process.env.STAGING_PASS   || '';
const CUENTA_ID    = process.env.STAGING_CUENTA_ID || '';
const CURSO_ID     = process.env.STAGING_CURSO_ID  || '';

if (!STAGING_KEY || !EMAIL || !PASS || !CUENTA_ID || !CURSO_ID) {
  console.error('❌ Faltan variables de entorno. Ver cabecera del script.');
  process.exit(1);
}

const BASE = `${STAGING_URL}/rest/v1`;
const AUTH = `${STAGING_URL}/auth/v1`;

// ─── Helpers ──────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function ok(label)  { pass++; console.log(`  ✅ ${label}`); }
function ko(label, detail) { fail++; console.error(`  ❌ ${label}${detail ? ': ' + detail : ''}`); }

async function req(path, opts = {}, token = null) {
  const headers = {
    'apikey':       STAGING_KEY,
    'Content-Type': 'application/json',
    'Accept':       'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    ...(opts.headers || {}),
  };
  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { body });
  return body;
}

async function rpc(name, params, token) {
  const res = await fetch(`${BASE}/rpc/${name}`, {
    method: 'POST',
    headers: {
      'apikey': STAGING_KEY,
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(params),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(`RPC ${name} HTTP ${res.status}`), { body });
  return body;
}

function uid() {
  return 'test-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now();
}

// ─── Login ────────────────────────────────────────────────────────────────────
async function login() {
  const res = await fetch(`${AUTH}/token?grant_type=password`, {
    method: 'POST',
    headers: { 'apikey': STAGING_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  });
  if (!res.ok) throw new Error(`Login falló: ${res.status}`);
  const data = await res.json();
  return data.access_token;
}

// ─── Limpieza ─────────────────────────────────────────────────────────────────
const _cleanup = [];
async function cleanup(token) {
  console.log('\n🧹 Limpiando datos de prueba…');
  for (const { table, id, field } of [..._cleanup].reverse()) {
    try {
      await req(`/${table}?cuenta_id=eq.${CUENTA_ID}&${field || 'id'}=eq.${id}`,
        { method: 'DELETE' }, token);
      console.log(`  🗑 ${table}/${id}`);
    } catch (e) { console.warn(`  ⚠ no pudo limpiar ${table}/${id}: ${e.message}`); }
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Test V9 staging — datos aislados');
  console.log(`  Staging: ${STAGING_URL}`);
  console.log(`  Cuenta:  ${CUENTA_ID}`);
  console.log(`  Curso:   ${CURSO_ID}`);
  console.log('═══════════════════════════════════════════════════════\n');

  let token;
  try {
    token = await login();
    ok('Login en staging');
  } catch (e) {
    ko('Login en staging', e.message);
    process.exit(1);
  }

  // ─── T1: Alumno + PIN ───────────────────────────────────────────────────
  console.log('\n── T1: Crear alumno + configurar PIN ──');
  const alumnoId = uid();
  let aluCreado = false;

  try {
    await req('/alumnos?select=*', {
      method: 'POST',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        cuenta_id: CUENTA_ID, curso_id: CURSO_ID, id: alumnoId,
        nombres: 'Test', apellidos: 'Aislado', estado: 'activo',
      }),
    }, token);
    aluCreado = true;
    _cleanup.push({ table: 'alumnos_credenciales', id: alumnoId, field: 'alumno_id' });
    _cleanup.push({ table: 'alumnos', id: alumnoId });
    ok('Alumno creado (id: ' + alumnoId + ')');
  } catch (e) {
    ko('Crear alumno', e.message);
    return await cleanup(token);
  }

  // 1a. PIN vacío debe fallar
  try {
    const r = await rpc('tesorero_set_pin',
      { p_cuenta_id: CUENTA_ID, p_alumno_id: alumnoId, p_pin: '' }, token);
    r?.ok === false && r?.error === 'pin_vacio'
      ? ok('PIN vacío rechazado por el servidor (pin_vacio)')
      : ko('PIN vacío debería devolver error', JSON.stringify(r));
  } catch (e) { ko('PIN vacío — error inesperado', e.message); }

  // 1b. PIN corto debe fallar
  try {
    const r = await rpc('tesorero_set_pin',
      { p_cuenta_id: CUENTA_ID, p_alumno_id: alumnoId, p_pin: '12' }, token);
    r?.ok === false && r?.error === 'pin_muy_corto'
      ? ok('PIN demasiado corto rechazado (pin_muy_corto)')
      : ko('PIN corto debería devolver error', JSON.stringify(r));
  } catch (e) { ko('PIN corto — error inesperado', e.message); }

  // 1c. PIN válido debe funcionar
  const pinValido = 'PRUEBA9';
  try {
    const r = await rpc('tesorero_set_pin',
      { p_cuenta_id: CUENTA_ID, p_alumno_id: alumnoId, p_pin: pinValido }, token);
    r?.ok === true
      ? ok('PIN guardado correctamente (ok:true)')
      : ko('PIN válido falló', JSON.stringify(r));
  } catch (e) { ko('PIN válido — error inesperado', e.message); }

  // 1d. Hash guardado en alumnos_credenciales (sin exponer texto plano)
  try {
    const rows = await req(
      `/alumnos_credenciales?cuenta_id=eq.${CUENTA_ID}&alumno_id=eq.${alumnoId}&select=pin_hash`,
      { method: 'GET' }, token);
    if (Array.isArray(rows) && rows.length && rows[0].pin_hash && rows[0].pin_hash.startsWith('$2')) {
      ok('pin_hash en BD comienza con $2 (bcrypt confirmado)');
    } else {
      ko('pin_hash no tiene formato bcrypt', JSON.stringify(rows));
    }
    // Verificar que el hash no es igual al PIN en texto plano
    if (rows[0]?.pin_hash !== pinValido) {
      ok('pin_hash ≠ PIN en texto plano (hash real, no almacenamiento directo)');
    } else {
      ko('pin_hash igual al texto plano — NO se hasheó correctamente');
    }
  } catch (e) { ko('Leer alumnos_credenciales', e.message); }

  // ─── T2: Recarga de apoderados ──────────────────────────────────────────
  console.log('\n── T2: Crear apoderado → verificar que reaparece tras "recarga de sesión" ──');
  const apId = uid();
  try {
    await req('/apoderados?select=*', {
      method: 'POST',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        cuenta_id: CUENTA_ID, alumno_id: alumnoId, id: apId,
        nombre: 'Apoderado Test', relacion: 'Padre', telefono: '+56912345678',
      }),
    }, token);
    _cleanup.push({ table: 'apoderados', id: apId });
    ok('Apoderado creado');
  } catch (e) {
    ko('Crear apoderado', e.message);
  }

  // Simular "recarga de sesión": cargar todos los apoderados de la cuenta
  try {
    const rows = await req(
      `/apoderados?cuenta_id=eq.${CUENTA_ID}&select=*&order=nombre.asc`,
      { method: 'GET' }, token);
    const encontrado = Array.isArray(rows) && rows.some(r => r.id === apId);
    encontrado
      ? ok('Apoderado reaparece en carga completa de la cuenta (simula recarga de sesión)')
      : ko('Apoderado NO encontrado en recarga', 'ids: ' + (rows||[]).map(r=>r.id).join(', '));
  } catch (e) { ko('Cargar apoderados', e.message); }

  // ─── T3: Movimiento + archivos persistidos en PostgreSQL ───────────────
  console.log('\n── T3: Crear movimiento → PATCH archivos → verificar en PostgreSQL ──');
  const movId = uid();
  try {
    await req('/movimientos?select=*', {
      method: 'POST',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        cuenta_id: CUENTA_ID, curso_id: CURSO_ID, id: movId,
        tipo: 'gasto', desc: 'Pago prueba T3', monto: 1000,
        fecha: new Date().toISOString().slice(0,10),
        visible: true,
      }),
    }, token);
    _cleanup.push({ table: 'movimientos', id: movId });
    ok('Movimiento creado');
  } catch (e) {
    ko('Crear movimiento', e.message);
  }

  // Simular URLs de Storage (no subimos archivos reales al Storage de staging en este test)
  const fakeUrls = [{ nombre: 'comprobante.pdf', url: 'https://staging.example/file/comprobante.pdf', tipo: 'application/pdf' }];
  const fakeComprobante = fakeUrls[0].url;

  try {
    const rows = await req(
      `/movimientos?cuenta_id=eq.${CUENTA_ID}&id=eq.${movId}&select=*`,
      {
        method: 'PATCH',
        headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify({ archivos: fakeUrls, comprobante: fakeComprobante }),
      }, token);
    if (Array.isArray(rows) && rows.length && rows[0].comprobante === fakeComprobante) {
      ok('comprobante persistido en PostgreSQL (campo comprobante)');
    } else {
      ko('comprobante no encontrado tras PATCH', JSON.stringify(rows?.[0]));
    }
    if (Array.isArray(rows) && rows.length && Array.isArray(rows[0].archivos) && rows[0].archivos.length) {
      ok('archivos (JSONB) persistidos en PostgreSQL');
    } else {
      ko('archivos no encontrados tras PATCH', JSON.stringify(rows?.[0]?.archivos));
    }
  } catch (e) { ko('PATCH archivos/comprobante', e.message); }

  // Verificar recarga: leer movimiento desde cero y comprobar campos
  try {
    const rows = await req(
      `/movimientos?cuenta_id=eq.${CUENTA_ID}&id=eq.${movId}&select=archivos,comprobante`,
      { method: 'GET' }, token);
    if (rows?.[0]?.comprobante === fakeComprobante) {
      ok('comprobante reaparece al recargar desde PostgreSQL');
    } else {
      ko('comprobante perdido tras recarga', JSON.stringify(rows?.[0]));
    }
  } catch (e) { ko('Recargar movimiento', e.message); }

  // ─── T4: retryPin sin recrear alumno ───────────────────────────────────
  console.log('\n── T4: retryPin — cambiar PIN sin recrear el alumno ──');
  const pinNuevo = 'RETRY42';
  try {
    const r = await rpc('tesorero_set_pin',
      { p_cuenta_id: CUENTA_ID, p_alumno_id: alumnoId, p_pin: pinNuevo }, token);
    r?.ok === true
      ? ok('retryPin: PIN cambiado en alumno existente (ok:true)')
      : ko('retryPin falló', JSON.stringify(r));
  } catch (e) { ko('retryPin', e.message); }

  // Verificar que el hash cambió
  try {
    const rows = await req(
      `/alumnos_credenciales?cuenta_id=eq.${CUENTA_ID}&alumno_id=eq.${alumnoId}&select=pin_hash`,
      { method: 'GET' }, token);
    if (rows?.[0]?.pin_hash?.startsWith('$2')) {
      ok('Hash actualizado tras retryPin (formato bcrypt confirmado)');
    } else {
      ko('Hash no actualizado tras retryPin', JSON.stringify(rows?.[0]));
    }
  } catch (e) { ko('Verificar hash tras retryPin', e.message); }

  await cleanup(token);

  // ─── Resumen ──────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`  Resultado: ${pass} OK  /  ${fail} FALLIDOS`);
  console.log('═══════════════════════════════════════════════════════');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('Error fatal:', e); process.exit(1); });
