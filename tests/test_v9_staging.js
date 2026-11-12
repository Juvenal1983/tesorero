#!/usr/bin/env node
/**
 * tests/test_v9_staging.js — Recorrido con datos aislados contra staging
 * =========================================================================
 * Lee credenciales desde el archivo .env en la raíz del proyecto.
 * Compatible con Windows (cmd, PowerShell) y macOS/Linux.
 *
 * Uso (desde la raíz del proyecto, después de "npm install"):
 *   node tests/test_v9_staging.js
 *   -- o bien --
 *   npm run test:v9
 *
 * Variables requeridas en .env (ver .env.example):
 *   STAGING_URL        URL del proyecto de staging
 *   STAGING_KEY        anon key de staging
 *   STAGING_EMAIL      email del tesorero de prueba en staging
 *   STAGING_PASS       contraseña
 *   STAGING_CUENTA_ID  UUID de la cuenta en tesorero_cuentas
 *   STAGING_CURSO_ID   UUID del curso de prueba
 *
 * ⚠️  Staging únicamente. NUNCA ejecutar contra producción:
 *       https://tmjqzaakzhecbldebyeg.supabase.co
 *
 * El script crea y elimina sus propios datos de prueba (prefijo "test-").
 * No modifica ningún dato real de staging.
 *
 * Flujos probados:
 *   T1  Alumno + PIN → hash bcrypt, rechazo de PIN inválido, _pinConfigurado
 *   T2  Apoderado creado → reaparece en carga completa (simula recarga de sesión)
 *   T3  Movimiento → PATCH archivos+comprobante → reaparece al recargar desde PostgreSQL
 *   T4  retryPin → cambia PIN en alumno existente sin recrearlo
 */

'use strict';

// ── Cargar .env desde la raíz del proyecto ────────────────────────────────
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

// ── Configuración ─────────────────────────────────────────────────────────
const STAGING_URL = process.env.STAGING_URL  || '';
const STAGING_KEY = process.env.STAGING_KEY  || '';
const EMAIL       = process.env.STAGING_EMAIL  || '';
const PASS        = process.env.STAGING_PASS   || '';
const CUENTA_ID   = process.env.STAGING_CUENTA_ID || '';
const CURSO_ID    = process.env.STAGING_CURSO_ID  || '';

// Guardia: nunca apuntar a producción
const PROD_URL = 'tmjqzaakzhecbldebyeg.supabase.co';
if (STAGING_URL.includes(PROD_URL)) {
  console.error('🚫 STAGING_URL apunta a producción. Abortando.');
  process.exit(1);
}

const faltantes = ['STAGING_URL','STAGING_KEY','STAGING_EMAIL','STAGING_PASS','STAGING_CUENTA_ID','STAGING_CURSO_ID']
  .filter(k => !process.env[k]);
if (faltantes.length) {
  console.error('❌ Faltan variables en .env:\n  ' + faltantes.join('\n  '));
  console.error('\nCopia .env.example como .env y completa los valores.');
  process.exit(1);
}

const BASE = `${STAGING_URL}/rest/v1`;
const AUTH = `${STAGING_URL}/auth/v1`;

// ── Helpers ───────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function ok(label)         { pass++; console.log(`  ✅ ${label}`); }
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
      'apikey':        STAGING_KEY,
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
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

// ── Limpieza de datos de prueba ───────────────────────────────────────────
const _cleanup = [];
async function cleanup(token) {
  console.log('\n🧹 Limpiando datos de prueba…');
  for (const { table, id, field } of [..._cleanup].reverse()) {
    try {
      await req(
        `/${table}?cuenta_id=eq.${CUENTA_ID}&${field || 'id'}=eq.${id}`,
        { method: 'DELETE' }, token
      );
      console.log(`  🗑  ${table}/${id}`);
    } catch (e) {
      console.warn(`  ⚠  no pudo limpiar ${table}/${id}: ${e.message}`);
    }
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('═════════════════════════════════════════════════════════');
  console.log('  Test V9 staging — datos aislados');
  console.log(`  Staging : ${STAGING_URL}`);
  console.log(`  Cuenta  : ${CUENTA_ID}`);
  console.log(`  Curso   : ${CURSO_ID}`);
  console.log('═════════════════════════════════════════════════════════\n');

  let token;
  try {
    token = await login();
    ok('Login en staging');
  } catch (e) {
    ko('Login en staging', e.message);
    process.exit(1);
  }

  // ── T1: Alumno + PIN ──────────────────────────────────────────────────
  console.log('\n── T1: Crear alumno + configurar PIN ──');
  const alumnoId = uid();

  try {
    await req('/alumnos?select=*', {
      method:  'POST',
      headers: { 'Prefer': 'return=minimal' },
      body:    JSON.stringify({
        cuenta_id: CUENTA_ID, curso_id: CURSO_ID, id: alumnoId,
        nombres: 'Test', apellidos: 'Aislado', estado: 'activo',
      }),
    }, token);
    _cleanup.push({ table: 'alumnos_credenciales', id: alumnoId, field: 'alumno_id' });
    _cleanup.push({ table: 'alumnos', id: alumnoId });
    ok(`Alumno creado (${alumnoId})`);
  } catch (e) {
    ko('Crear alumno', e.message);
    return await cleanup(token);
  }

  // 1a. PIN null → pin_vacio
  try {
    const r = await rpc('tesorero_set_pin',
      { p_cuenta_id: CUENTA_ID, p_alumno_id: alumnoId, p_pin: null }, token);
    r?.ok === false && r?.error === 'pin_vacio'
      ? ok('PIN null rechazado (pin_vacio)')
      : ko('PIN null debería devolver pin_vacio', JSON.stringify(r));
  } catch (e) { ko('PIN null — error inesperado', e.message); }

  // 1b. PIN vacío → pin_vacio
  try {
    const r = await rpc('tesorero_set_pin',
      { p_cuenta_id: CUENTA_ID, p_alumno_id: alumnoId, p_pin: '' }, token);
    r?.ok === false && r?.error === 'pin_vacio'
      ? ok('PIN vacío rechazado (pin_vacio)')
      : ko('PIN vacío debería devolver pin_vacio', JSON.stringify(r));
  } catch (e) { ko('PIN vacío — error inesperado', e.message); }

  // 1c. PIN corto → pin_muy_corto
  try {
    const r = await rpc('tesorero_set_pin',
      { p_cuenta_id: CUENTA_ID, p_alumno_id: alumnoId, p_pin: '12' }, token);
    r?.ok === false && r?.error === 'pin_muy_corto'
      ? ok('PIN corto rechazado (pin_muy_corto)')
      : ko('PIN corto debería devolver pin_muy_corto', JSON.stringify(r));
  } catch (e) { ko('PIN corto — error inesperado', e.message); }

  // 1d. PIN válido → ok:true
  const pinValido = 'PRUEBA9';
  try {
    const r = await rpc('tesorero_set_pin',
      { p_cuenta_id: CUENTA_ID, p_alumno_id: alumnoId, p_pin: pinValido }, token);
    r?.ok === true
      ? ok('PIN válido guardado (ok:true)')
      : ko('PIN válido falló', JSON.stringify(r));
  } catch (e) { ko('PIN válido — error inesperado', e.message); }

  // 1e. Hash en BD tiene formato bcrypt ($2…)
  try {
    const rows = await req(
      `/alumnos_credenciales?cuenta_id=eq.${CUENTA_ID}&alumno_id=eq.${alumnoId}&select=pin_hash`,
      { method: 'GET' }, token
    );
    const hash = rows?.[0]?.pin_hash;
    hash?.startsWith('$2')
      ? ok('pin_hash en BD comienza con $2 (bcrypt)')
      : ko('pin_hash no tiene formato bcrypt', String(hash));
    hash && hash !== pinValido
      ? ok('pin_hash ≠ texto plano (hash real)')
      : ko('pin_hash igual al texto plano — no se hasheó');
  } catch (e) { ko('Leer alumnos_credenciales', e.message); }

  // ── T2: Apoderado → recarga de sesión ────────────────────────────────
  console.log('\n── T2: Apoderado creado → reaparece en carga completa de cuenta ──');
  const apId = uid();
  try {
    await req('/apoderados?select=*', {
      method:  'POST',
      headers: { 'Prefer': 'return=minimal' },
      body:    JSON.stringify({
        cuenta_id: CUENTA_ID, alumno_id: alumnoId, id: apId,
        nombre: 'Apoderado Test', relacion: 'Padre', telefono: '+56912345678',
      }),
    }, token);
    _cleanup.push({ table: 'apoderados', id: apId });
    ok('Apoderado creado');
  } catch (e) { ko('Crear apoderado', e.message); }

  // Simula "recarga de sesión": cargar todos los apoderados de la cuenta
  try {
    const rows = await req(
      `/apoderados?cuenta_id=eq.${CUENTA_ID}&select=*&order=nombre.asc`,
      { method: 'GET' }, token
    );
    Array.isArray(rows) && rows.some(r => r.id === apId)
      ? ok('Apoderado reaparece en carga completa (simula recarga de sesión)')
      : ko('Apoderado NO encontrado en recarga');
  } catch (e) { ko('Cargar apoderados', e.message); }

  // ── T3: Movimiento + archivos persistidos en PostgreSQL ──────────────
  console.log('\n── T3: Movimiento → PATCH archivos+comprobante → recargar ──');
  const movId = uid();
  try {
    await req('/movimientos?select=*', {
      method:  'POST',
      headers: { 'Prefer': 'return=minimal' },
      body:    JSON.stringify({
        cuenta_id: CUENTA_ID, curso_id: CURSO_ID, id: movId,
        tipo: 'gasto', desc: 'Pago prueba T3', monto: 1000,
        fecha: new Date().toISOString().slice(0, 10), visible: true,
      }),
    }, token);
    _cleanup.push({ table: 'movimientos', id: movId });
    ok('Movimiento creado');
  } catch (e) { ko('Crear movimiento', e.message); }

  // URLs ficticias (no se sube archivo real al Storage en este test)
  const fakeUrls       = [{ nombre: 'comprobante.pdf', url: 'https://staging.example/file/comprobante.pdf', tipo: 'application/pdf' }];
  const fakeComprobante = fakeUrls[0].url;

  try {
    const rows = await req(
      `/movimientos?cuenta_id=eq.${CUENTA_ID}&id=eq.${movId}&select=*`,
      {
        method:  'PATCH',
        headers: { 'Prefer': 'return=representation' },
        body:    JSON.stringify({ archivos: fakeUrls, comprobante: fakeComprobante }),
      }, token
    );
    rows?.[0]?.comprobante === fakeComprobante
      ? ok('comprobante persistido en PostgreSQL')
      : ko('comprobante no encontrado tras PATCH', JSON.stringify(rows?.[0]?.comprobante));
    Array.isArray(rows?.[0]?.archivos) && rows[0].archivos.length > 0
      ? ok('archivos (JSONB) persistidos en PostgreSQL')
      : ko('archivos no encontrados tras PATCH', JSON.stringify(rows?.[0]?.archivos));
  } catch (e) { ko('PATCH archivos/comprobante', e.message); }

  // Verificar que persisten al recargar desde cero
  try {
    const rows = await req(
      `/movimientos?cuenta_id=eq.${CUENTA_ID}&id=eq.${movId}&select=archivos,comprobante`,
      { method: 'GET' }, token
    );
    rows?.[0]?.comprobante === fakeComprobante
      ? ok('comprobante reaparece al recargar desde PostgreSQL')
      : ko('comprobante perdido tras recarga', JSON.stringify(rows?.[0]));
  } catch (e) { ko('Recargar movimiento', e.message); }

  // ── T4: retryPin sin recrear el alumno ───────────────────────────────
  console.log('\n── T4: retryPin — cambiar PIN sin recrear el alumno ──');
  const pinNuevo = 'RETRY42';
  try {
    const r = await rpc('tesorero_set_pin',
      { p_cuenta_id: CUENTA_ID, p_alumno_id: alumnoId, p_pin: pinNuevo }, token);
    r?.ok === true
      ? ok('retryPin: PIN cambiado en alumno existente (ok:true)')
      : ko('retryPin falló', JSON.stringify(r));
  } catch (e) { ko('retryPin — error inesperado', e.message); }

  try {
    const rows = await req(
      `/alumnos_credenciales?cuenta_id=eq.${CUENTA_ID}&alumno_id=eq.${alumnoId}&select=pin_hash`,
      { method: 'GET' }, token
    );
    rows?.[0]?.pin_hash?.startsWith('$2')
      ? ok('Hash actualizado tras retryPin (formato bcrypt)')
      : ko('Hash no actualizado tras retryPin', JSON.stringify(rows?.[0]));
  } catch (e) { ko('Verificar hash tras retryPin', e.message); }

  await cleanup(token);

  // ── Resultado ────────────────────────────────────────────────────────
  console.log('\n═════════════════════════════════════════════════════════');
  console.log(`  Resultado: ${pass} ✅ OK   ${fail} ❌ FALLIDOS`);
  console.log('═════════════════════════════════════════════════════════');
  if (fail > 0) {
    console.log('\n  Revisa los errores ❌ arriba antes de ejecutar el RPC en staging.');
    process.exit(1);
  }
  console.log('\n  Todo OK. Puedes ejecutar sql/E5_pin_rpc.sql en staging.');
  process.exit(0);
}

main().catch(e => { console.error('Error fatal:', e); process.exit(1); });
