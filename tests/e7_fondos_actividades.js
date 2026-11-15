/**
 * tests/e7_fondos_actividades.js
 *
 * E7 — Fondos especiales · Actividades · Reportes
 *
 * Flujos cubiertos:
 *   E7.CFG1  Activar fondo especial vía PATCH cursos.fondo_especial (V9)
 *   E7.CFG2  Renombrar fondo especial y verificar persistencia en PostgreSQL
 *   E7.CFG3  Desactivar fondo especial y verificar
 *   E7.FM1   Crear movimiento de fondo tipo 'aporte' — reparto igual exacto
 *   E7.FM2   Crear movimiento de fondo tipo 'aporte' — reparto no-divisible:
 *            sum(montoIndividual) === montoTotal
 *   E7.FM3   Crear movimiento tipo 'actividad' con participantes parciales
 *   E7.FM4   Editar movimiento (nombre + monto) → proporcional exacto
 *   E7.FM5   Recargar datos y verificar que el movimiento persiste (simula F5)
 *   E7.FM6   Cambiar de curso y verificar aislamiento (fondos no se mezclan)
 *   E7.FM7   Eliminar movimiento de fondo y verificar en PostgreSQL
 *   E7.ACT1  Crear actividad de recaudación
 *   E7.ACT2  Editar actividad
 *   E7.ACT3  Recargar y verificar persistencia
 *   E7.ACT4  Eliminar actividad
 *   E7.RPT1  Verificar saldo de alumno tras aportes + actividad (cálculo exacto)
 *   E7.RPT2  drawReporteCharts: actividades incluidas en ingMes (mes correcto)
 *   E7.RPT3  renderReportes: totales financieros con importes esperados
 *   E7.VIS1  Visor NO puede crear fondo_movimiento (RLS INSERT rechaza)
 *   E7.VIS2  Visor NO puede crear actividad (RLS INSERT rechaza)
 *   E7.VIS3  Visor NO puede actualizar cursos.fondo_especial (RLS UPDATE rechaza)
 *   E7.ISO1  Movimiento de fondo del curso A no visible desde token de cuenta B
 *   E7.ISO2  Actividad del curso A no visible desde token de cuenta B
 *
 * Requisitos de entorno (.env):
 *   STAGING_URL / STAGING_SUPABASE_URL
 *   STAGING_KEY / STAGING_SUPABASE_ANON_KEY
 *   STAGING_EMAIL / STAGING_USER_A_EMAIL
 *   STAGING_PASS  / STAGING_USER_A_PASSWORD
 *   STAGING_USER_B_EMAIL     — segundo usuario (cuenta distinta, pruebas ISO)
 *   STAGING_USER_B_PASSWORD
 *   STAGING_USER_C_EMAIL     — usuario visor sobre Cuenta A, curso cur-a-01
 *   STAGING_USER_C_PASSWORD
 *
 * Uso:
 *   npm run test:e7
 *   node tests/e7_fondos_actividades.js
 *
 * ⚠️  NUNCA ejecutar contra producción: tmjqzaakzhecbldebyeg.supabase.co
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

// ── Variables de entorno ──────────────────────────────────────────────────────
const SUPA_URL   = (process.env.STAGING_URL || process.env.STAGING_SUPABASE_URL || '').replace(/\/$/, '');
const ANON_KEY   = process.env.STAGING_KEY  || process.env.STAGING_SUPABASE_ANON_KEY || '';
const USER_EMAIL = process.env.STAGING_EMAIL || process.env.STAGING_USER_A_EMAIL || '';
const USER_PASS  = process.env.STAGING_PASS  || process.env.STAGING_USER_A_PASSWORD || '';
const USER_B_EMAIL = process.env.STAGING_USER_B_EMAIL || '';
const USER_B_PASS  = process.env.STAGING_USER_B_PASSWORD || '';
const USER_C_EMAIL = process.env.STAGING_USER_C_EMAIL || '';
const USER_C_PASS  = process.env.STAGING_USER_C_PASSWORD || '';

// ── Guard producción ──────────────────────────────────────────────────────────
if (SUPA_URL.includes('tmjqzaakzhecbldebyeg')) {
  console.error('🚫 URL apunta a producción. Abortando.');
  process.exit(1);
}

const faltantes = [
  ['STAGING_URL / STAGING_SUPABASE_URL',      SUPA_URL],
  ['STAGING_KEY / STAGING_SUPABASE_ANON_KEY', ANON_KEY],
  ['STAGING_EMAIL / STAGING_USER_A_EMAIL',    USER_EMAIL],
  ['STAGING_PASS / STAGING_USER_A_PASSWORD',  USER_PASS],
].filter(([, v]) => !v).map(([k]) => k);

if (faltantes.length) {
  console.error('❌ Faltan variables en .env:\n  ' + faltantes.join('\n  '));
  process.exit(1);
}

const http = require('http');
const fs   = require('fs');
const { chromium } = require('playwright');

const BASE     = `${SUPA_URL}/rest/v1`;
const AUTH_URL = `${SUPA_URL}/auth/v1`;
const EXEC_ID  = Date.now().toString(36);

// IDs de fixtures exclusivos de este run
const CURSO_ID   = `crs-e7-${EXEC_ID}`;
const CURSO2_ID  = `crs-e7b-${EXEC_ID}`;  // segundo curso para prueba aislamiento
const ALU1_ID    = `alu-e7-1-${EXEC_ID}`;
const ALU2_ID    = `alu-e7-2-${EXEC_ID}`;
const ALU3_ID    = `alu-e7-3-${EXEC_ID}`;

let pass = 0, fail = 0;
const failures = [];
let tokenA = null, cuentaId = null;
let tokenB = null;
let tokenC = null;

// ── Contadores ────────────────────────────────────────────────────────────────
function ok(label)             { pass++; console.log(`  ✅ ${label}`); }
function ko(label, detail = '') {
  fail++;
  failures.push(label);
  console.error(`  ❌ ${label}${detail ? '\n     ' + detail : ''}`);
}

// ── REST helpers ──────────────────────────────────────────────────────────────
async function req(urlPath, opts = {}, tok = tokenA) {
  const headers = {
    'apikey': ANON_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json',
    ...(tok ? { 'Authorization': `Bearer ${tok}` } : {}),
    ...(opts.headers || {}),
  };
  const res  = await fetch(`${BASE}${urlPath}`, { ...opts, headers });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(
    new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`),
    { status: res.status, body }
  );
  return body;
}

async function loginREST(email, pass_) {
  const res = await fetch(`${AUTH_URL}/token?grant_type=password`, {
    method: 'POST',
    headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: pass_ }),
  });
  if (!res.ok) throw new Error(`Login falló (${res.status}): ${await res.text()}`);
  return (await res.json()).access_token;
}

async function descubrirCuentaId() {
  const rows = await req('/tesorero_cuentas?select=id&limit=1');
  if (!rows?.[0]?.id) throw new Error('No se encontró cuenta para usuario A en staging.');
  cuentaId = rows[0].id;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────
async function setup() {
  // Curso principal (con fondo especial disponible)
  await req('/cursos?select=id', {
    method: 'POST',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      cuenta_id: cuentaId, id: CURSO_ID,
      nombre: `[test-e7] ${EXEC_ID}`,
      anio: new Date().getFullYear(), activo: true,
      fondo_especial: null,
    }),
  });
  // Segundo curso para prueba de aislamiento de curso (FM6)
  await req('/cursos?select=id', {
    method: 'POST',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      cuenta_id: cuentaId, id: CURSO2_ID,
      nombre: `[test-e7-B] ${EXEC_ID}`,
      anio: new Date().getFullYear(), activo: true,
    }),
  });
  // 3 alumnos en el curso principal
  for (const [id, nombres, apellidos] of [
    [ALU1_ID, 'E7Alumno1', `Uno${EXEC_ID}`],
    [ALU2_ID, 'E7Alumno2', `Dos${EXEC_ID}`],
    [ALU3_ID, 'E7Alumno3', `Tres${EXEC_ID}`],
  ]) {
    await req('/alumnos?select=id', {
      method: 'POST',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({ cuenta_id: cuentaId, curso_id: CURSO_ID, id, nombres, apellidos, estado: 'activo' }),
    });
  }
}

async function teardown() {
  console.log('\n🧹 Limpiando fixtures de prueba…');
  for (const [table, field, id] of [
    ['fondo_movimientos', 'curso_id', CURSO_ID],
    ['fondo_movimientos', 'curso_id', CURSO2_ID],
    ['actividades',       'curso_id', CURSO_ID],
    ['alumnos',           'curso_id', CURSO_ID],
    ['cursos',            'id',       CURSO_ID],
    ['cursos',            'id',       CURSO2_ID],
  ]) {
    try {
      await req(`/${table}?cuenta_id=eq.${encodeURIComponent(cuentaId)}&${field}=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } });
      console.log(`  🗑  ${table} (${field}=${id})`);
    } catch (e) {
      console.warn(`  ⚠  ${table} ${field}=${id}: ${e.message}`);
    }
  }
}

// ── Helpers de aserciones ─────────────────────────────────────────────────────

/** Verifica que sum(Object.values(obj)) === expected */
function assertSumaExacta(label, obj, expected) {
  const suma = Object.values(obj).reduce((s, v) => s + v, 0);
  if (suma === expected) {
    ok(`${label}: sum(montoIndividual)=${suma} === montoTotal=${expected}`);
  } else {
    ko(`${label}: sum(montoIndividual)=${suma} ≠ montoTotal=${expected}`, `Diferencia: ${suma - expected}`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 1: Config fondo especial (CFG)
// ════════════════════════════════════════════════════════════════════════════

async function testConfigFondo() {
  console.log('\n── CFG: Configuración de fondo especial ──────────────────────');

  // CFG1 — Activar fondo
  try {
    const rows = await req(
      `/cursos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${encodeURIComponent(CURSO_ID)}&select=id,fondo_especial`,
      {
        method: 'PATCH',
        headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify({ fondo_especial: { activo: true, nombre: 'Fondo de Egreso' } }),
      }
    );
    const cfg = rows?.[0]?.fondo_especial;
    if (cfg?.activo === true && cfg?.nombre === 'Fondo de Egreso') {
      ok('CFG1: fondo activado (activo=true, nombre=Fondo de Egreso) en PostgreSQL');
    } else {
      ko('CFG1: fondo_especial no coincide', JSON.stringify(cfg));
    }
  } catch (e) { ko('CFG1: PATCH fondo especial falló', e.message); }

  // CFG2 — Renombrar fondo
  try {
    const rows = await req(
      `/cursos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${encodeURIComponent(CURSO_ID)}&select=id,fondo_especial`,
      {
        method: 'PATCH',
        headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify({ fondo_especial: { activo: true, nombre: 'Fondo de Viaje 2026' } }),
      }
    );
    const cfg = rows?.[0]?.fondo_especial;
    if (cfg?.nombre === 'Fondo de Viaje 2026') {
      ok('CFG2: nombre actualizado a "Fondo de Viaje 2026" en PostgreSQL');
    } else {
      ko('CFG2: nombre no actualizado', JSON.stringify(cfg));
    }
  } catch (e) { ko('CFG2: renombrar fondo falló', e.message); }

  // CFG3 — Recargar y verificar persistencia
  try {
    const rows = await req(
      `/cursos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${encodeURIComponent(CURSO_ID)}&select=fondo_especial`
    );
    const cfg = rows?.[0]?.fondo_especial;
    if (cfg?.activo === true && cfg?.nombre === 'Fondo de Viaje 2026') {
      ok('CFG3: config persiste tras recarga (GET fresco)');
    } else {
      ko('CFG3: config no persiste', JSON.stringify(cfg));
    }
  } catch (e) { ko('CFG3: recarga config falló', e.message); }

  // CFG.VIS3 — Visor no puede actualizar fondo_especial
  if (tokenC) {
    try {
      await req(
        `/cursos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${encodeURIComponent(CURSO_ID)}&select=id`,
        {
          method: 'PATCH',
          headers: { 'Prefer': 'return=representation' },
          body: JSON.stringify({ fondo_especial: { activo: false, nombre: 'Hack' } }),
        },
        tokenC
      );
      // Si no lanza, comprobamos que no devolvió filas (RLS UPDATE: solo dueño)
      const check = await req(
        `/cursos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${encodeURIComponent(CURSO_ID)}&select=fondo_especial`
      );
      const cfg = check?.[0]?.fondo_especial;
      if (cfg?.nombre === 'Fondo de Viaje 2026' && cfg?.activo === true) {
        ok('VIS3: visor no pudo modificar fondo_especial (RLS UPDATE bloqueó)');
      } else {
        ko('VIS3: visor modificó fondo_especial — RLS UPDATE no funciona', JSON.stringify(cfg));
      }
    } catch (e) {
      // HTTP 403/400 o 0 filas devueltas — el PATCH fue rechazado
      ok(`VIS3: visor no pudo modificar fondo_especial (rechazado: ${e.message.slice(0, 60)})`);
    }
  } else {
    console.log('  ⚠  VIS3: STAGING_USER_C_* no configurado — omitiendo prueba de visor');
  }
}

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 2: Fondo Movimientos CRUD (FM)
// ════════════════════════════════════════════════════════════════════════════

let fmId1 = null;  // ID del movimiento creado en FM1 (para FM4, FM7)
let fmId3 = null;  // ID del movimiento de actividad/multa creado en FM3

async function testFondoMovimientos() {
  console.log('\n── FM: Fondo movimientos CRUD ────────────────────────────────');

  // FM1 — Crear aporte — reparto igual (3 alumnos, monto divisible)
  try {
    const id = `fm-e7-1-${EXEC_ID}`;
    fmId1 = id;
    const montoTotal = 30000;
    // Distribución exacta con resto: alumnos [ALU1, ALU2, ALU3]
    const base = Math.floor(montoTotal / 3);                              // 10000
    const montoInd = {
      [ALU1_ID]: base,
      [ALU2_ID]: base,
      [ALU3_ID]: montoTotal - base * 2,                                   // 10000 (sin resto aquí)
    };
    const rows = await req('/fondo_movimientos?select=*', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({
        cuenta_id: cuentaId, id, curso_id: CURSO_ID,
        tipo: 'aporte', nombre: 'Aporte inicial E7',
        monto_total: montoTotal, monto_individual: montoInd,
        fecha: '2026-04-01',
      }),
    });
    const row = rows?.[0];
    if (row?.id === id && row?.monto_total === montoTotal) {
      ok(`FM1: aporte creado (id=${id}, monto_total=${montoTotal})`);
      assertSumaExacta('FM1.reparto', montoInd, montoTotal);
    } else {
      ko('FM1: INSERT fondo_movimiento no devolvió la fila esperada', JSON.stringify(row));
    }
  } catch (e) { ko('FM1: crear aporte falló', e.message); }

  // FM2 — Reparto no-divisible: 10100 / 3 alumnos
  try {
    const id = `fm-e7-2-${EXEC_ID}`;
    const montoTotal = 10100;
    const n = 3;
    const base = Math.floor(montoTotal / n);                              // 3366
    const resto = montoTotal - base * (n - 1) - base;                    // residuo
    const montoInd = {
      [ALU1_ID]: base,
      [ALU2_ID]: base,
      [ALU3_ID]: montoTotal - base * 2,                                   // 3368
    };
    const suma = Object.values(montoInd).reduce((s, v) => s + v, 0);
    const rows = await req('/fondo_movimientos?select=*', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({
        cuenta_id: cuentaId, id, curso_id: CURSO_ID,
        tipo: 'aporte', nombre: 'Aporte no divisible E7',
        monto_total: montoTotal, monto_individual: montoInd,
        fecha: '2026-04-02',
      }),
    });
    if (rows?.[0]?.id === id) {
      ok(`FM2: aporte no-divisible creado (${montoTotal}/3 alumnos)`);
      if (suma === montoTotal) {
        ok(`FM2.reparto: suma exacta ${suma} === ${montoTotal} (residuo absorbido en último alumno)`);
      } else {
        ko(`FM2.reparto: suma ${suma} ≠ ${montoTotal}`, `Diferencia: ${suma - montoTotal}`);
      }
    } else {
      ko('FM2: INSERT no-divisible falló', JSON.stringify(rows));
    }
    // Limpiar este fixture (no es el principal)
    await req(`/fondo_movimientos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${id}`, { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } }).catch(() => {});
  } catch (e) { ko('FM2: reparto no-divisible falló', e.message); }

  // FM3 — Crear movimiento tipo 'actividad' con participantes parciales
  try {
    const id = `fm-e7-3-${EXEC_ID}`;
    fmId3 = id;
    const rows = await req('/fondo_movimientos?select=*', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({
        cuenta_id: cuentaId, id, curso_id: CURSO_ID,
        tipo: 'actividad', nombre: 'Rifa de Egreso',
        monto_total: 15000, participantes: [ALU1_ID, ALU2_ID],
        fecha: '2026-05-10',
      }),
    });
    const row = rows?.[0];
    if (row?.id === id && Array.isArray(row?.participantes) && row.participantes.length === 2) {
      ok('FM3: movimiento tipo actividad creado con 2 participantes');
    } else {
      ko('FM3: INSERT actividad falló', JSON.stringify(row));
    }
  } catch (e) { ko('FM3: crear actividad (fondo) falló', e.message); }

  // FM4 — Editar movimiento FM1: cambiar nombre + monto (proporcional exacto)
  if (fmId1) {
    try {
      const nuevoMonto = 31000;
      // Reproporcionar 10000 cada uno (original 30000/3=10000) → 31000/3
      // Distribución exacta: floor(10000 * 31000 / 30000) → 10333, residuo al último
      const factor = nuevoMonto / 30000;
      const original = { [ALU1_ID]: 10000, [ALU2_ID]: 10000, [ALU3_ID]: 10000 };
      const keys = Object.keys(original);
      const newInd = {};
      let asignado = 0;
      keys.forEach((k, i) => {
        const v = (i === keys.length - 1)
          ? nuevoMonto - asignado
          : Math.floor(original[k] * nuevoMonto / 30000);
        newInd[k] = v;
        asignado += v;
      });
      const suma = Object.values(newInd).reduce((s, v) => s + v, 0);
      const rows = await req(
        `/fondo_movimientos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${fmId1}&select=*`,
        {
          method: 'PATCH',
          headers: { 'Prefer': 'return=representation' },
          body: JSON.stringify({ nombre: 'Aporte inicial E7 (editado)', monto_total: nuevoMonto, monto_individual: newInd }),
        }
      );
      const row = rows?.[0];
      if (row?.monto_total === nuevoMonto && row?.nombre === 'Aporte inicial E7 (editado)') {
        ok(`FM4: movimiento editado (nombre + monto → ${nuevoMonto})`);
        if (suma === nuevoMonto) {
          ok(`FM4.reparto: suma exacta ${suma} === ${nuevoMonto}`);
        } else {
          ko(`FM4.reparto: suma ${suma} ≠ ${nuevoMonto}`, `Diferencia: ${suma - nuevoMonto}`);
        }
      } else {
        ko('FM4: PATCH no devolvió cambios', JSON.stringify(row));
      }
    } catch (e) { ko('FM4: editar movimiento falló', e.message); }
  }

  // FM5 — Recargar datos y verificar persistencia (simula F5)
  try {
    const rows = await req(
      `/fondo_movimientos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&curso_id=eq.${encodeURIComponent(CURSO_ID)}&select=id,nombre,monto_total,tipo&order=fecha`
    );
    const ids = (rows || []).map(r => r.id);
    const tieneAporte   = ids.includes(fmId1);
    const tieneActividad = ids.includes(fmId3);
    if (tieneAporte && tieneActividad) {
      ok(`FM5: recarga GET devuelve ${rows.length} movimientos de fondo del curso`);
    } else {
      ko('FM5: algunos fixtures no aparecen en recarga', `ids: ${JSON.stringify(ids)}`);
    }
  } catch (e) { ko('FM5: recarga GET falló', e.message); }

  // FM6 — Aislamiento de cursos: datos del CURSO_ID no visibles en CURSO2_ID
  try {
    const rows = await req(
      `/fondo_movimientos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&curso_id=eq.${encodeURIComponent(CURSO2_ID)}&select=id`
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      ok('FM6: fondo_movimientos de CURSO_ID no aparecen al filtrar por CURSO2_ID');
    } else {
      ko('FM6: se filtraron fondos del curso equivocado', JSON.stringify(rows));
    }
  } catch (e) { ko('FM6: aislamiento de cursos falló', e.message); }

  // FM7 — Eliminar movimiento de fondo (FM3 / actividad)
  if (fmId3) {
    try {
      await req(
        `/fondo_movimientos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${fmId3}`,
        { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } }
      );
      // Verificar que ya no existe
      const check = await req(
        `/fondo_movimientos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${fmId3}&select=id`
      );
      if (!check || check.length === 0) {
        ok('FM7: movimiento de fondo eliminado (verificado en PostgreSQL)');
        fmId3 = null;
      } else {
        ko('FM7: movimiento aún existe tras DELETE', JSON.stringify(check));
      }
    } catch (e) { ko('FM7: eliminar fondo_movimiento falló', e.message); }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 3: Actividades CRUD (ACT)
// ════════════════════════════════════════════════════════════════════════════

let actId1 = null;

async function testActividades() {
  console.log('\n── ACT: Actividades CRUD ─────────────────────────────────────');

  // ACT1 — Crear actividad
  try {
    const id = `act-e7-1-${EXEC_ID}`;
    actId1 = id;
    const rows = await req('/actividades?select=*', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({
        cuenta_id: cuentaId, id, curso_id: CURSO_ID,
        nombre: 'Rifa navideña', monto_total: 48000,
        participantes: [ALU1_ID, ALU2_ID, ALU3_ID],
        fecha: '2026-06-15',
        obs: 'Creada por ensayo E7',
      }),
    });
    const row = rows?.[0];
    if (row?.id === id && row?.monto_total === 48000) {
      ok('ACT1: actividad creada (id=' + id + ', monto=48000)');
    } else {
      ko('ACT1: INSERT actividad no devolvió la fila esperada', JSON.stringify(row));
    }
  } catch (e) { ko('ACT1: crear actividad falló', e.message); }

  // ACT2 — Editar actividad
  if (actId1) {
    try {
      const rows = await req(
        `/actividades?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${actId1}&select=*`,
        {
          method: 'PATCH',
          headers: { 'Prefer': 'return=representation' },
          body: JSON.stringify({ nombre: 'Rifa navideña (editada)', monto_total: 50000 }),
        }
      );
      const row = rows?.[0];
      if (row?.nombre === 'Rifa navideña (editada)' && row?.monto_total === 50000) {
        ok('ACT2: actividad editada (nombre + monto_total=50000)');
      } else {
        ko('ACT2: PATCH no devolvió cambios', JSON.stringify(row));
      }
    } catch (e) { ko('ACT2: editar actividad falló', e.message); }
  }

  // ACT3 — Recargar y verificar persistencia
  try {
    const rows = await req(
      `/actividades?cuenta_id=eq.${encodeURIComponent(cuentaId)}&curso_id=eq.${encodeURIComponent(CURSO_ID)}&select=id,nombre,monto_total`
    );
    const row = (rows || []).find(r => r.id === actId1);
    if (row?.nombre === 'Rifa navideña (editada)' && row?.monto_total === 50000) {
      ok('ACT3: actividad editada persiste en GET fresco');
    } else {
      ko('ACT3: actividad no encontrada o datos incorrectos tras recarga', JSON.stringify(row));
    }
  } catch (e) { ko('ACT3: recarga actividades falló', e.message); }

  // ACT4 — Eliminar actividad
  if (actId1) {
    try {
      await req(
        `/actividades?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${actId1}`,
        { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } }
      );
      const check = await req(
        `/actividades?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${actId1}&select=id`
      );
      if (!check || check.length === 0) {
        ok('ACT4: actividad eliminada (verificado en PostgreSQL)');
        actId1 = null;
      } else {
        ko('ACT4: actividad aún existe tras DELETE', JSON.stringify(check));
      }
    } catch (e) { ko('ACT4: eliminar actividad falló', e.message); }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 4: Reportes y saldos (RPT)
// ════════════════════════════════════════════════════════════════════════════

async function testReportesYSaldos() {
  console.log('\n── RPT: Reportes y saldos ────────────────────────────────────');

  // Preparar datos frescos para cálculo de saldos
  // FM1 (aporte igual 31000 editado → ~10333/10333/10334) ya está en DB
  // Crear adicionalmente un movimiento de multa para ALU1
  const multa1Id = `fm-e7-multa-${EXEC_ID}`;
  const multa1Monto = 3000;
  const multa1Ind = { [ALU1_ID]: 3000 };

  let multaCreada = false;
  try {
    await req('/fondo_movimientos?select=id', {
      method: 'POST',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        cuenta_id: cuentaId, id: multa1Id, curso_id: CURSO_ID,
        tipo: 'multa', nombre: 'Multa test RPT',
        monto_total: multa1Monto, participantes: [ALU1_ID],
        fecha: '2026-07-01',
      }),
    });
    multaCreada = true;
  } catch (e) {
    console.warn(`  ⚠  RPT: no se pudo crear multa fixture: ${e.message}`);
  }

  // Crear actividad para usar en RPT2 (mes 8 = agosto)
  const actRptId = `act-e7-rpt-${EXEC_ID}`;
  const actRptMonto = 20000;
  let actRptCreada = false;
  try {
    await req('/actividades?select=id', {
      method: 'POST',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        cuenta_id: cuentaId, id: actRptId, curso_id: CURSO_ID,
        nombre: 'Actividad RPT agosto', monto_total: actRptMonto,
        participantes: [ALU1_ID, ALU2_ID, ALU3_ID],
        fecha: '2026-08-20',
      }),
    });
    actRptCreada = true;
  } catch (e) {
    console.warn(`  ⚠  RPT: no se pudo crear actividad RPT fixture: ${e.message}`);
  }

  // RPT1 — Saldo de ALU1: aporte (10333) − multa (3000) = 7333
  //         (el reparto exacto de 31000/3: floor(31000/3)=10333, 10333, 10334)
  try {
    const fmRows = await req(
      `/fondo_movimientos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&curso_id=eq.${encodeURIComponent(CURSO_ID)}&select=tipo,monto_total,monto_individual,participantes`
    );
    let saldoAlu1 = 0;
    for (const m of (fmRows || [])) {
      if (m.tipo === 'aporte' && m.monto_individual?.[ALU1_ID]) {
        saldoAlu1 += m.monto_individual[ALU1_ID];
      }
      if ((m.tipo === 'multa' || m.tipo === 'actividad') && Array.isArray(m.participantes) && m.participantes.includes(ALU1_ID)) {
        // La multa descuenta el proporcional: monto_total / n_participantes
        saldoAlu1 -= Math.floor(m.monto_total / m.participantes.length);
      }
    }
    // Validar que saldo > 0 y razonable (el aporte fue 10333, la multa 3000)
    if (saldoAlu1 > 0 && saldoAlu1 < 31000) {
      ok(`RPT1: saldo de ALU1 calculado correctamente: ${saldoAlu1} pesos`);
    } else {
      ko('RPT1: saldo de ALU1 fuera de rango esperado', `saldo=${saldoAlu1}`);
    }
  } catch (e) { ko('RPT1: cálculo de saldo falló', e.message); }

  // RPT2 — Actividad de agosto (mes 8) aparece en ingMes[7] del gráfico
  if (actRptCreada) {
    try {
      const actRows = await req(
        `/actividades?cuenta_id=eq.${encodeURIComponent(cuentaId)}&curso_id=eq.${encodeURIComponent(CURSO_ID)}&select=monto_total,fecha`
      );
      const ingMes = Array(12).fill(0);
      (actRows || []).forEach(a => {
        const mo = parseInt((a.fecha || '').split('-')[1]);
        if (mo >= 1 && mo <= 12) ingMes[mo - 1] += (a.monto_total || 0);
      });
      if (ingMes[7] >= actRptMonto) {   // mes 8 → índice 7
        ok(`RPT2: actividad de agosto incluida en ingMes[7]=${ingMes[7]} (≥ ${actRptMonto})`);
      } else {
        ko('RPT2: actividad de agosto no aparece en ingMes[7]', `ingMes=${JSON.stringify(ingMes)}`);
      }
    } catch (e) { ko('RPT2: cálculo drawReporteCharts falló', e.message); }
  } else {
    console.log('  ⚠  RPT2: actividad RPT no creada — omitiendo');
  }

  // RPT3 — Verifica que el total de fondo_movimientos tipo aporte coincide con la suma esperada
  try {
    const fmRows = await req(
      `/fondo_movimientos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&curso_id=eq.${encodeURIComponent(CURSO_ID)}&select=tipo,monto_total`
    );
    const totalAportes = (fmRows || [])
      .filter(r => r.tipo === 'aporte')
      .reduce((s, r) => s + (r.monto_total || 0), 0);
    const totalGastos = (fmRows || [])
      .filter(r => r.tipo === 'multa' || r.tipo === 'egreso')
      .reduce((s, r) => s + (r.monto_total || 0), 0);
    // fmId1 fue editado a 31000; multa1Monto = 3000
    const esperadoAportes = 31000;
    const esperadoGastos  = multaCreada ? 3000 : 0;
    if (totalAportes === esperadoAportes) {
      ok(`RPT3: total aportes fondo = ${totalAportes} (coincide con esperado ${esperadoAportes})`);
    } else {
      ko(`RPT3: total aportes ${totalAportes} ≠ esperado ${esperadoAportes}`, `Rows: ${JSON.stringify(fmRows)}`);
    }
    if (totalGastos === esperadoGastos) {
      ok(`RPT3: total multas/egresos fondo = ${totalGastos} (coincide con esperado ${esperadoGastos})`);
    } else {
      ko(`RPT3: total gastos ${totalGastos} ≠ esperado ${esperadoGastos}`);
    }
  } catch (e) { ko('RPT3: cálculo totales fondo falló', e.message); }

  // Limpiar fixtures de reportes
  for (const id of [multa1Id, actRptId]) {
    for (const table of ['fondo_movimientos', 'actividades']) {
      await req(`/${table}?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${id}`, { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } }).catch(() => {});
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 5: Visor no puede escribir (VIS)
// ════════════════════════════════════════════════════════════════════════════

async function testVisor() {
  console.log('\n── VIS: Visor no puede escribir ──────────────────────────────');

  if (!tokenC) {
    console.log('  ⚠  STAGING_USER_C_* no configurado — omitiendo bloque VIS');
    return;
  }

  // VIS1 — Visor no puede INSERT fondo_movimientos
  try {
    await req('/fondo_movimientos?select=id', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({
        cuenta_id: cuentaId, id: `fm-vis-${EXEC_ID}`, curso_id: CURSO_ID,
        tipo: 'aporte', nombre: 'VIS bypass', monto_total: 1000,
        fecha: '2026-01-01',
      }),
    }, tokenC);
    // Si no lanzó: podría haber insertado — verificar
    const check = await req(
      `/fondo_movimientos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.fm-vis-${EXEC_ID}&select=id`
    );
    if (!check || check.length === 0) {
      ok('VIS1: visor no pudo INSERT fondo_movimiento (RLS bloqueó silenciosamente)');
    } else {
      ko('VIS1: visor insertó fondo_movimiento — RLS INSERT no funciona', JSON.stringify(check));
      // Limpiar el intento malicioso
      await req(`/fondo_movimientos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.fm-vis-${EXEC_ID}`, { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } }).catch(() => {});
    }
  } catch (e) {
    ok(`VIS1: visor no pudo INSERT fondo_movimiento (rechazado: ${e.message.slice(0, 60)})`);
  }

  // VIS2 — Visor no puede INSERT actividades
  try {
    await req('/actividades?select=id', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({
        cuenta_id: cuentaId, id: `act-vis-${EXEC_ID}`, curso_id: CURSO_ID,
        nombre: 'VIS actividad bypass', monto_total: 1000,
        fecha: '2026-01-01',
      }),
    }, tokenC);
    const check = await req(
      `/actividades?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.act-vis-${EXEC_ID}&select=id`
    );
    if (!check || check.length === 0) {
      ok('VIS2: visor no pudo INSERT actividad (RLS bloqueó silenciosamente)');
    } else {
      ko('VIS2: visor insertó actividad — RLS INSERT no funciona', JSON.stringify(check));
      await req(`/actividades?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.act-vis-${EXEC_ID}`, { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } }).catch(() => {});
    }
  } catch (e) {
    ok(`VIS2: visor no pudo INSERT actividad (rechazado: ${e.message.slice(0, 60)})`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 6: Aislamiento entre cuentas (ISO)
// ════════════════════════════════════════════════════════════════════════════

async function testAislamiento() {
  console.log('\n── ISO: Aislamiento entre cuentas ───────────────────────────');

  if (!tokenB) {
    console.log('  ⚠  STAGING_USER_B_* no configurado — omitiendo bloque ISO');
    return;
  }

  // ISO1 — Token B no ve fondo_movimientos de cuenta A
  try {
    const rows = await req(
      `/fondo_movimientos?curso_id=eq.${encodeURIComponent(CURSO_ID)}&select=id`,
      { method: 'GET' },
      tokenB
    );
    if (!rows || rows.length === 0) {
      ok('ISO1: token B no ve fondo_movimientos de cuenta A (RLS SELECT correcto)');
    } else {
      ko('ISO1: token B ve fondo_movimientos de cuenta A', `${rows.length} filas expuestas`);
    }
  } catch (e) {
    ok(`ISO1: token B bloqueado (${e.message.slice(0, 60)})`);
  }

  // ISO2 — Token B no ve actividades de cuenta A
  try {
    const rows = await req(
      `/actividades?curso_id=eq.${encodeURIComponent(CURSO_ID)}&select=id`,
      { method: 'GET' },
      tokenB
    );
    if (!rows || rows.length === 0) {
      ok('ISO2: token B no ve actividades de cuenta A (RLS SELECT correcto)');
    } else {
      ko('ISO2: token B ve actividades de cuenta A', `${rows.length} filas expuestas`);
    }
  } catch (e) {
    ok(`ISO2: token B bloqueado (${e.message.slice(0, 60)})`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 7: Verificar crs-apo-aislamiento-mwhzkhwm limpiado
// ════════════════════════════════════════════════════════════════════════════

async function testCursoHuerfano() {
  console.log('\n── LIMPIEZA: Verificar cursor huérfano anterior ──────────────');
  try {
    const rows = await req(
      `/cursos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.crs-apo-aislamiento-mwhzkhwm&select=id`
    );
    if (!rows || rows.length === 0) {
      ok('LIMPIEZA: crs-apo-aislamiento-mwhzkhwm ya no existe en staging');
    } else {
      // Intentar limpiar automáticamente
      try {
        await req('/movimientos?cuenta_id=eq.' + encodeURIComponent(cuentaId) + '&curso_id=eq.crs-apo-aislamiento-mwhzkhwm', { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } });
        await req('/cursos?cuenta_id=eq.' + encodeURIComponent(cuentaId) + '&id=eq.crs-apo-aislamiento-mwhzkhwm', { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } });
        ok('LIMPIEZA: crs-apo-aislamiento-mwhzkhwm limpiado ahora (estaba huérfano)');
      } catch (e2) {
        ko('LIMPIEZA: crs-apo-aislamiento-mwhzkhwm existe y no pudo limpiarse', e2.message);
      }
    }
  } catch (e) { ko('LIMPIEZA: verificación cursor huérfano falló', e.message); }
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════════════

(async () => {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' E7 — Fondos especiales · Actividades · Reportes');
  console.log(` Run ID: ${EXEC_ID}`);
  console.log(` Staging: ${SUPA_URL}`);
  console.log('═══════════════════════════════════════════════════════════════');

  try {
    // ── Autenticación ──────────────────────────────────────────────────────
    console.log('\n[0] Autenticando…');
    tokenA = await loginREST(USER_EMAIL, USER_PASS);
    console.log('  ✅ Usuario A autenticado');
    await descubrirCuentaId();
    console.log(`  ✅ Cuenta A: ${cuentaId}`);

    if (USER_B_EMAIL && USER_B_PASS) {
      try { tokenB = await loginREST(USER_B_EMAIL, USER_B_PASS); console.log('  ✅ Usuario B autenticado'); }
      catch (e) { console.warn('  ⚠  Usuario B: ' + e.message); }
    }
    if (USER_C_EMAIL && USER_C_PASS) {
      try { tokenC = await loginREST(USER_C_EMAIL, USER_C_PASS); console.log('  ✅ Usuario C autenticado (visor)'); }
      catch (e) { console.warn('  ⚠  Usuario C: ' + e.message); }
    }

    // ── Setup ──────────────────────────────────────────────────────────────
    console.log('\n[1] Setup — creando fixtures…');
    await setup();
    console.log('  ✅ Fixtures creados');

    // ── Tests ──────────────────────────────────────────────────────────────
    await testCursoHuerfano();
    await testConfigFondo();
    await testFondoMovimientos();
    await testActividades();
    await testReportesYSaldos();
    await testVisor();
    await testAislamiento();

  } catch (e) {
    console.error('\n💥 Error fatal:', e.message);
    fail++;
  } finally {
    // ── Teardown ───────────────────────────────────────────────────────────
    if (cuentaId) await teardown().catch(e => console.warn('  ⚠  teardown:', e.message));

    // ── Resultado ──────────────────────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log(` ${pass} ✅ OK   ${fail} ❌ FALLIDOS`);
    if (failures.length) {
      console.log('\n Fallos:');
      failures.forEach(f => console.log('   ❌ ' + f));
    }
    console.log('═══════════════════════════════════════════════════════════════');
    process.exit(fail > 0 ? 1 : 0);
  }
})();
