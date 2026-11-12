#!/usr/bin/env node
/**
 * tests/test_v9_staging.js — Recorrido con datos aislados contra staging
 * =========================================================================
 * Autosuficiente: descubre cuenta_id y curso_id por sí solo.
 * Crea sus propios fixtures de prueba y los elimina al terminar.
 *
 * Variables MÍNIMAS requeridas en .env (ver .env.example):
 *   STAGING_URL     URL del proyecto de staging
 *   STAGING_KEY     anon key de staging
 *   STAGING_EMAIL   email del tesorero de prueba
 *   STAGING_PASS    contraseña
 *
 * Variables OPCIONALES (si las omites, el test las descubre solo):
 *   STAGING_CUENTA_ID   UUID en tesorero_cuentas  (autodiscovery via RLS)
 *   STAGING_CURSO_ID    UUID del curso de prueba   (crea uno temporal si falta)
 *
 * Uso (desde la raíz del proyecto):
 *   npm run test:v9           (después de npm install)
 *   node tests/test_v9_staging.js
 *
 * Compatible con Windows (cmd / PowerShell) y macOS/Linux.
 *
 * ⚠️  Staging únicamente. Nunca ejecutar contra producción:
 *       https://tmjqzaakzhecbldebyeg.supabase.co
 *
 * Flujos probados:
 *   T1  Alumno + PIN: hash bcrypt, rechazo de PIN inválido, _pinConfigurado
 *   T2  Apoderado creado → reaparece en carga completa (simula recarga de sesión)
 *   T3  Movimiento → PATCH archivos+comprobante → reaparece al recargar
 *   T4  retryPin → cambia PIN en alumno existente sin recrearlo
 */

'use strict';

// ── Cargar .env desde la raíz del proyecto ────────────────────────────────
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

// ── Configuración ─────────────────────────────────────────────────────────
const STAGING_URL = (process.env.STAGING_URL || '').replace(/\/$/, '');
const STAGING_KEY = process.env.STAGING_KEY  || '';
const EMAIL       = process.env.STAGING_EMAIL  || '';
const PASS        = process.env.STAGING_PASS   || '';

// Guardia: nunca apuntar a producción
if (STAGING_URL.includes('tmjqzaakzhecbldebyeg')) {
  console.error('🚫 STAGING_URL apunta a producción. Abortando sin ejecutar nada.');
  process.exit(1);
}

// Variables mínimas
const faltantes = ['STAGING_URL','STAGING_KEY','STAGING_EMAIL','STAGING_PASS']
  .filter(k => !process.env[k]);
if (faltantes.length) {
  console.error('❌ Faltan variables en .env:\n  ' + faltantes.join('\n  '));
  console.error('\nCopia .env.example como .env y completa al menos las 4 variables mínimas.');
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
    const detail = body ? JSON.stringify(body) : res.status;
    throw Object.assign(new Error(`HTTP ${res.status}: ${detail}`), { status: res.status, body });
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

function uid(prefix = 'test') {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}-${Date.now()}`;
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
  const data = await res.json();
  return { token: data.access_token, userId: data.user?.id };
}

// ── Autodiscovery ─────────────────────────────────────────────────────────
/**
 * Devuelve { cuentaId, cursoId, cursoCreado }.
 * - cuentaId: desde .env o primer resultado de /tesorero_cuentas con RLS
 * - cursoId:  desde .env o primer curso activo, o crea uno temporal
 */
async function descubrirContexto(token) {
  // 1. cuenta_id
  let cuentaId = process.env.STAGING_CUENTA_ID || '';
  if (!cuentaId) {
    const cuentas = await req('/tesorero_cuentas?select=id&limit=1', {}, token);
    if (!Array.isArray(cuentas) || !cuentas[0]?.id) {
      throw new Error(
        'No se encontró ninguna cuenta para este usuario en staging.\n' +
        '  Ejecuta sql/08_seed_staging.sql o crea una cuenta manualmente.'
      );
    }
    cuentaId = cuentas[0].id;
    console.log(`  ℹ  cuenta_id descubierto: ${cuentaId}`);
  }

  // 2. curso_id
  let cursoId    = process.env.STAGING_CURSO_ID || '';
  let cursoCreado = false;

  if (!cursoId) {
    const cursos = await req(
      `/cursos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&activo=eq.true&select=id&limit=1`,
      {}, token
    );
    if (Array.isArray(cursos) && cursos[0]?.id) {
      cursoId = cursos[0].id;
      console.log(`  ℹ  curso_id descubierto: ${cursoId}`);
    } else {
      // No hay cursos: crear uno temporal para el test
      cursoId = uid('curso-test');
      await req('/cursos?select=*', {
        method:  'POST',
        headers: { 'Prefer': 'return=minimal' },
        body:    JSON.stringify({
          cuenta_id: cuentaId,
          id:        cursoId,
          nombre:    'Curso fixture test V9 (eliminar si queda)',
          anio:      new Date().getFullYear(),
          activo:    true,
        }),
      }, token);
      cursoCreado = true;
      console.log(`  ℹ  curso_id creado como fixture temporal: ${cursoId}`);
    }
  }

  return { cuentaId, cursoId, cursoCreado };
}

// ── Pila de limpieza ──────────────────────────────────────────────────────
const _cleanup = []; // { table, id, field? }
async function cleanup(token) {
  console.log('\n🧹 Limpiando fixtures de prueba…');
  for (const { table, id, field, cuentaId } of [..._cleanup].reverse()) {
    const cid = cuentaId;
    try {
      const filter = cid
        ? `/${table}?cuenta_id=eq.${encodeURIComponent(cid)}&${field || 'id'}=eq.${encodeURIComponent(id)}`
        : `/${table}?${field || 'id'}=eq.${encodeURIComponent(id)}`;
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
  console.log('  Test V9 staging — datos aislados');
  console.log(`  Staging : ${STAGING_URL}`);
  console.log('═════════════════════════════════════════════════════════\n');

  // Login
  let token, userId;
  try {
    ({ token, userId } = await login());
    ok(`Login (${EMAIL})`);
  } catch (e) {
    ko('Login', e.message);
    process.exit(1);
  }

  // Autodiscovery de contexto
  let cuentaId, cursoId, cursoCreado;
  try {
    ({ cuentaId, cursoId, cursoCreado } = await descubrirContexto(token));
    ok(`Contexto: cuenta=${cuentaId.slice(0,8)}… curso=${cursoId.slice(0,12)}…`);
    if (cursoCreado) _cleanup.push({ table: 'cursos', id: cursoId, field: 'id', cuentaId });
  } catch (e) {
    ko('Autodiscovery de contexto', e.message);
    process.exit(1);
  }

  // ── T1: Alumno + PIN ──────────────────────────────────────────────────
  console.log('\n── T1: Crear alumno + configurar PIN ──');
  const alumnoId = uid('alu');

  try {
    await req('/alumnos?select=id', {
      method:  'POST',
      headers: { 'Prefer': 'return=minimal' },
      body:    JSON.stringify({
        cuenta_id: cuentaId, curso_id: cursoId, id: alumnoId,
        nombres: 'FixtureTest', apellidos: 'AisladoV9', estado: 'activo',
      }),
    }, token);
    _cleanup.push({ table: 'alumnos_credenciales', id: alumnoId, field: 'alumno_id', cuentaId });
    _cleanup.push({ table: 'alumnos', id: alumnoId, cuentaId });
    ok(`Alumno creado (${alumnoId})`);
  } catch (e) {
    ko('Crear alumno', e.message);
    return await cleanup(token);
  }

  // 1a. null → pin_vacio
  try {
    const r = await rpc('tesorero_set_pin',
      { p_cuenta_id: cuentaId, p_alumno_id: alumnoId, p_pin: null }, token);
    r?.ok === false && r?.error === 'pin_vacio'
      ? ok('PIN null rechazado (pin_vacio)')
      : ko('PIN null debería devolver pin_vacio', JSON.stringify(r));
  } catch (e) { ko('PIN null — error inesperado', e.message); }

  // 1b. vacío → pin_vacio
  try {
    const r = await rpc('tesorero_set_pin',
      { p_cuenta_id: cuentaId, p_alumno_id: alumnoId, p_pin: '' }, token);
    r?.ok === false && r?.error === 'pin_vacio'
      ? ok('PIN vacío rechazado (pin_vacio)')
      : ko('PIN vacío debería devolver pin_vacio', JSON.stringify(r));
  } catch (e) { ko('PIN vacío — error inesperado', e.message); }

  // 1c. corto → pin_muy_corto
  try {
    const r = await rpc('tesorero_set_pin',
      { p_cuenta_id: cuentaId, p_alumno_id: alumnoId, p_pin: '12' }, token);
    r?.ok === false && r?.error === 'pin_muy_corto'
      ? ok('PIN corto rechazado (pin_muy_corto)')
      : ko('PIN corto debería devolver pin_muy_corto', JSON.stringify(r));
  } catch (e) { ko('PIN corto — error inesperado', e.message); }

  // 1d. válido → ok:true
  const pinValido = 'PRUEBA9';
  try {
    const r = await rpc('tesorero_set_pin',
      { p_cuenta_id: cuentaId, p_alumno_id: alumnoId, p_pin: pinValido }, token);
    r?.ok === true
      ? ok('PIN válido guardado (ok:true)')
      : ko('PIN válido falló', JSON.stringify(r));
  } catch (e) { ko('PIN válido — error inesperado', e.message); }

  // 1e. hash en BD es bcrypt, no texto plano
  try {
    const rows = await req(
      `/alumnos_credenciales?cuenta_id=eq.${encodeURIComponent(cuentaId)}&alumno_id=eq.${encodeURIComponent(alumnoId)}&select=pin_hash`,
      {}, token
    );
    const hash = rows?.[0]?.pin_hash;
    hash?.startsWith('$2')
      ? ok('pin_hash en BD comienza con $2 (bcrypt)')
      : ko('pin_hash no tiene formato bcrypt', String(hash));
    hash && hash !== pinValido
      ? ok('pin_hash ≠ texto plano (nunca credencial visible)')
      : ko('pin_hash igual al texto plano — no se hasheó');
  } catch (e) { ko('Leer alumnos_credenciales', e.message); }

  // ── T2: Apoderado → simula recarga de sesión ──────────────────────────
  console.log('\n── T2: Apoderado → reaparece en carga completa de cuenta ──');
  const apId = uid('ap');
  try {
    await req('/apoderados?select=id', {
      method:  'POST',
      headers: { 'Prefer': 'return=minimal' },
      body:    JSON.stringify({
        cuenta_id: cuentaId, alumno_id: alumnoId, id: apId,
        nombre: 'Apoderado Fixture', relacion: 'Padre', telefono: '+56912345678',
      }),
    }, token);
    _cleanup.push({ table: 'apoderados', id: apId, cuentaId });
    ok('Apoderado creado');
  } catch (e) { ko('Crear apoderado', e.message); }

  // Simula "recarga de sesión": cargarTodosApoderadosV9 — un GET sin filtro por alumno
  try {
    const rows = await req(
      `/apoderados?cuenta_id=eq.${encodeURIComponent(cuentaId)}&select=id&order=nombre.asc`,
      {}, token
    );
    Array.isArray(rows) && rows.some(r => r.id === apId)
      ? ok('Apoderado reaparece en carga completa (simula cargarTodosApoderadosV9)')
      : ko('Apoderado NO encontrado en recarga de cuenta',
          `ids: [${(rows||[]).map(r=>r.id).join(', ')}]`);
  } catch (e) { ko('Cargar todos los apoderados', e.message); }

  // ── T3: Movimiento + archivos persistidos en PostgreSQL ──────────────
  console.log('\n── T3: Movimiento → PATCH archivos+comprobante → recargar ──');
  const movId = uid('mov');
  try {
    await req('/movimientos?select=id', {
      method:  'POST',
      headers: { 'Prefer': 'return=minimal' },
      body:    JSON.stringify({
        cuenta_id: cuentaId, curso_id: cursoId, id: movId,
        tipo: 'gasto', desc: 'Pago fixture T3', monto: 1000,
        fecha: new Date().toISOString().slice(0, 10), visible: true,
      }),
    }, token);
    _cleanup.push({ table: 'movimientos', id: movId, cuentaId });
    ok('Movimiento creado');
  } catch (e) { ko('Crear movimiento', e.message); }

  // URLs ficticias — no se sube archivo real; prueba que el PATCH acepta los campos
  const fakeUrls       = [{ nombre: 'comprobante.pdf', url: 'https://staging.example/file/comprobante-fixture.pdf', tipo: 'application/pdf' }];
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

  // Recargar desde cero y verificar que persisten
  try {
    const rows = await req(
      `/movimientos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${encodeURIComponent(movId)}&select=archivos,comprobante`,
      {}, token
    );
    rows?.[0]?.comprobante === fakeComprobante
      ? ok('comprobante reaparece al recargar (simula cargarMovimientosV9)')
      : ko('comprobante perdido tras recarga', JSON.stringify(rows?.[0]));
  } catch (e) { ko('Recargar movimiento', e.message); }

  // ── T4: retryPin sin recrear el alumno ───────────────────────────────
  console.log('\n── T4: retryPin — cambiar PIN en alumno existente ──');
  const pinNuevo = 'RETRY42';
  let hashAnterior = null;

  // Leer hash actual para verificar que cambia
  try {
    const rows = await req(
      `/alumnos_credenciales?cuenta_id=eq.${encodeURIComponent(cuentaId)}&alumno_id=eq.${encodeURIComponent(alumnoId)}&select=pin_hash`,
      {}, token
    );
    hashAnterior = rows?.[0]?.pin_hash || null;
  } catch (_) {}

  try {
    const r = await rpc('tesorero_set_pin',
      { p_cuenta_id: cuentaId, p_alumno_id: alumnoId, p_pin: pinNuevo }, token);
    r?.ok === true
      ? ok('retryPin: RPC devuelve ok:true')
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
      ? ok('Hash cambió tras retryPin (upsert efectivo)')
      : ko('Hash no cambió — upsert no funcionó o no había hash previo',
          `anterior=${hashAnterior?.slice(0,10)}… nuevo=${hashNuevo?.slice(0,10)}…`);
  } catch (e) { ko('Verificar hash tras retryPin', e.message); }

  await cleanup(token);

  // ── Resultado final ───────────────────────────────────────────────────
  console.log('\n═════════════════════════════════════════════════════════');
  console.log(`  Resultado: ${pass} ✅ OK   ${fail} ❌ FALLIDOS`);
  console.log('═════════════════════════════════════════════════════════');

  if (fail === 0) {
    console.log('\n  Todo OK.');
    console.log('  Paso siguiente: ejecutar sql/E5_pin_rpc.sql en staging (sin tocar producción).');
  } else {
    console.log('\n  Corrige los errores ❌ antes de ejecutar el RPC en staging.');
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('\nError fatal:', e.message || e); process.exit(1); });
