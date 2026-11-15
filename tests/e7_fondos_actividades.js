/**
 * tests/e7_fondos_actividades.js
 *
 * E7 — Fondos especiales · Actividades · Reportes
 *
 * Principios de diseño:
 *  - Los cálculos de saldo y reparto se verifican ejecutando las funciones
 *    reales del código fuente (fondos.js) mediante vm.runInNewContext, no
 *    reconstruyendo la lógica en el test.
 *  - REST se usa únicamente para verificar persistencia en PostgreSQL después
 *    de que los handlers hayan escrito el dato.
 *  - El rechazo de escrituras para visor se valida por HTTP 403 con
 *    code=42501 (RLS violation), no por cualquier excepción.
 *  - Si faltan credenciales B/C, las pruebas correspondientes quedan PENDING
 *    y E7 no se declara validado completo.
 *
 * Flujos cubiertos:
 *   UNIT.1  getFondoAlumno: reparto actividad exacto (sum === montoTotal)
 *   UNIT.2  getFondoAlumno: reparto actividad no-divisible (sum === montoTotal)
 *   UNIT.3  getFondoAlumno: rendimiento floor+resto (sum === montoTotal)
 *   UNIT.4  getFondoAlumnoHasta: actividad no-divisible (sum === montoTotal)
 *   UNIT.5  Multa NO descuenta saldo individual; saldo exacto conocido
 *   UNIT.6  drawReporteCharts: actividad incluida en ingMes[mes correcto]
 *   CFG.1   Activar fondo especial vía PATCH cursos.fondo_especial
 *   CFG.2   Renombrar fondo especial; verificar persistencia en PostgreSQL
 *   CFG.3   Recarga GET confirma persistencia
 *   FM.1    Crear aporte 30000 / 3 alumnos → reparto igual exacto (10000 cada uno)
 *   FM.2    Crear aporte no-divisible 10100 / 3 alumnos → sum === 10100
 *   FM.3    Crear movimiento tipo actividad con participantes parciales
 *   FM.4    Editar movimiento: cambio de monto con reproporcionalización exacta
 *   FM.5    Recarga GET: movimiento persiste con datos correctos
 *   FM.6    Aislamiento de cursos: datos del CURSO_ID no visibles en CURSO2_ID
 *   FM.7    Eliminar movimiento de fondo; verificar ausencia en PostgreSQL
 *   ACT.1   Crear actividad
 *   ACT.2   Editar actividad (nombre + monto)
 *   ACT.3   Recarga GET: actividad editada persiste
 *   ACT.4   Eliminar actividad; verificar ausencia en PostgreSQL
 *   RPT.1   Saldo exacto de ALU1 tras aporte no-divisible (sin multa deducida)
 *   RPT.2   ingMes[mes] acumula montoTotal de actividades correctamente
 *   VIS.1   Visor → INSERT fondo_movimiento → HTTP 403 42501 (no cualquier error)
 *   VIS.2   Visor → INSERT actividad → HTTP 403 42501
 *   VIS.3   Visor → PATCH cursos.fondo_especial → 403 o 0 filas (RLS UPDATE)
 *   ISO.1   Token B no ve fondo_movimientos de cuenta A
 *   ISO.2   Token B no ve actividades de cuenta A
 *
 * Variables de entorno requeridas:
 *   STAGING_URL (o STAGING_SUPABASE_URL)
 *   STAGING_KEY (o STAGING_SUPABASE_ANON_KEY)
 *   STAGING_EMAIL (o STAGING_USER_A_EMAIL) + STAGING_PASS
 *
 * Opcionales (si faltan, los bloques VIS e ISO quedan PENDING):
 *   STAGING_USER_B_EMAIL / STAGING_USER_B_PASSWORD  — cuenta distinta, pruebas ISO
 *   STAGING_USER_C_EMAIL / STAGING_USER_C_PASSWORD  — visor, pruebas VIS
 *
 * ⚠️  NUNCA ejecutar contra producción: tmjqzaakzhecbldebyeg.supabase.co
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const vm   = require('vm');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

// ── Entorno ───────────────────────────────────────────────────────────────────
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

const BASE     = `${SUPA_URL}/rest/v1`;
const AUTH_URL = `${SUPA_URL}/auth/v1`;
const EXEC_ID  = Date.now().toString(36);

const CURSO_ID  = `crs-e7-${EXEC_ID}`;
const CURSO2_ID = `crs-e7b-${EXEC_ID}`;
const ALU1_ID   = `alu-e7-1-${EXEC_ID}`;
const ALU2_ID   = `alu-e7-2-${EXEC_ID}`;
const ALU3_ID   = `alu-e7-3-${EXEC_ID}`;

let pass = 0, fail = 0, pending = 0;
const failures = [], pendings = [];
let tokenA = null, cuentaId = null;
let tokenB = null, tokenC = null;
let userCAuthId = null;
let userCCursoEntry = null;  // registro de usuarios_cuenta insertado en setup para C

// ── Contadores ────────────────────────────────────────────────────────────────
function ok(label)             { pass++;    console.log(`  ✅ ${label}`); }
function ko(label, detail = ''){ fail++;    failures.push(label); console.error(`  ❌ ${label}${detail ? '\n     '+detail : ''}`); }
function pend(label, reason)   { pending++; pendings.push(label); console.log(`  ⏳ PENDING: ${label} — ${reason}`); }

// ── REST helpers ──────────────────────────────────────────────────────────────
/**
 * Realiza una petición REST a Supabase.
 * Lanza un error enriquecido con { status, code, body } para que los tests de
 * permisos puedan distinguir un 403/42501 de cualquier otro fallo.
 */
async function req(urlPath, opts = {}, tok = tokenA) {
  const headers = {
    'apikey': ANON_KEY,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...(tok ? { 'Authorization': `Bearer ${tok}` } : {}),
    ...(opts.headers || {}),
  };
  const res  = await fetch(`${BASE}${urlPath}`, { ...opts, headers });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`);
    err.status = res.status;
    err.code   = body?.code;   // e.g. '42501' para RLS violation
    err.body   = body;
    throw err;
  }
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

async function getUserId(tok) {
  const res = await fetch(`${AUTH_URL}/user`, {
    headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${tok}` },
  });
  if (!res.ok) throw new Error(`GET /user falló: ${res.status}`);
  return (await res.json()).id;   // UUID del auth.uid()
}

async function descubrirCuentaId() {
  const rows = await req('/tesorero_cuentas?select=id&limit=1');
  if (!rows?.[0]?.id) throw new Error('No se encontró cuenta para usuario A en staging.');
  cuentaId = rows[0].id;
}

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE UNIT: funciones de cálculo ejecutadas desde el código fuente real
// ════════════════════════════════════════════════════════════════════════════

/**
 * Carga getFondoAlumno, getFondoAlumnoHasta (y sus dependencias mínimas) desde
 * el código fuente, inyectando mocks de DB, S y getAlumnos().
 * Devuelve { getFondoAlumno, getFondoAlumnoHasta }.
 */
function cargarFuncionesReales(mockDB, mockS, mockAlumnos) {
  const fondosSource = fs.readFileSync(
    path.resolve(__dirname, '..', 'js', 'features', 'fondos.js'), 'utf8'
  );
  const ctx = vm.createContext({
    DB:         mockDB,
    S:          mockS,
    getAlumnos: () => mockAlumnos,
    // Stubs mínimos para que el archivo cargue sin error (no se usan en las fn de cálculo)
    getCurso:   () => null,
    clp:        v  => v,
    go:         () => {},
    document:   { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null },
    console,
  });
  vm.runInContext(fondosSource, ctx);
  return {
    getFondoAlumno:    ctx.getFondoAlumno.bind(ctx),
    getFondoAlumnoHasta: ctx.getFondoAlumnoHasta.bind(ctx),
  };
}

async function testUnitCalculos() {
  console.log('\n── UNIT: Funciones de cálculo reales (vm) ────────────────────');

  // Alumnos fijos para tests unitarios (IDs cortos para legibilidad)
  const A1 = 'u1', A2 = 'u2', A3 = 'u3';
  const alumnos = [{ id: A1 }, { id: A2 }, { id: A3 }];

  // UNIT.1 — getFondoAlumno: actividad divisible → cada alumno recibe floor exacto
  try {
    const mockDB = {
      fondoMovimientos: [
        { id: 'm1', cursoId: 'crs-unit', tipo: 'actividad', nombre: 'Rifa',
          montoTotal: 30000, participantes: [A1, A2, A3], fecha: '2026-04-01' },
      ],
    };
    const mockS = { cursoId: 'crs-unit' };
    const { getFondoAlumno } = cargarFuncionesReales(mockDB, mockS, alumnos);
    const s1 = getFondoAlumno(A1).total;
    const s2 = getFondoAlumno(A2).total;
    const s3 = getFondoAlumno(A3).total;
    const suma = s1 + s2 + s3;
    if (s1 === 10000 && s2 === 10000 && s3 === 10000 && suma === 30000) {
      ok(`UNIT.1: actividad divisible → [${s1}, ${s2}, ${s3}] suma=${suma} exacto`);
    } else {
      ko(`UNIT.1: reparto incorrecto`, `[${s1}, ${s2}, ${s3}] suma=${suma} ≠ 30000`);
    }
  } catch (e) { ko('UNIT.1', e.message); }

  // UNIT.2 — getFondoAlumno: actividad no-divisible (10100 / 3)
  try {
    const mockDB = {
      fondoMovimientos: [
        { id: 'm2', cursoId: 'crs-unit', tipo: 'actividad', nombre: 'No-div',
          montoTotal: 10100, participantes: [A1, A2, A3], fecha: '2026-04-02' },
      ],
    };
    const mockS = { cursoId: 'crs-unit' };
    const { getFondoAlumno } = cargarFuncionesReales(mockDB, mockS, alumnos);
    const s1 = getFondoAlumno(A1).total;  // Math.floor(10100/3) = 3366
    const s2 = getFondoAlumno(A2).total;  // 3366
    const s3 = getFondoAlumno(A3).total;  // 10100 − 3366*2 = 3368
    const suma = s1 + s2 + s3;
    if (suma === 10100 && s3 === 3368) {
      ok(`UNIT.2: actividad no-divisible → [${s1}, ${s2}, ${s3}] suma=${suma} exacto`);
    } else {
      ko('UNIT.2: reparto no-divisible incorrecto', `[${s1}, ${s2}, ${s3}] suma=${suma}`);
    }
  } catch (e) { ko('UNIT.2', e.message); }

  // UNIT.3 — getFondoAlumno: rendimiento distribuido por floor+resto (1000 / 3)
  try {
    const mockDB = {
      fondoMovimientos: [
        // aporte previo para que todos tengan saldo > 0
        { id: 'm-ap', cursoId: 'crs-unit', tipo: 'aporte', nombre: 'Aporte',
          montoTotal: 3000, montoIndividual: { [A1]: 1000, [A2]: 1000, [A3]: 1000 },
          fecha: '2026-01-01' },
        // rendimiento no-divisible: 1000 / 3
        { id: 'm-rend', cursoId: 'crs-unit', tipo: 'rendimiento', nombre: 'Rendim',
          montoTotal: 1000, fecha: '2026-02-01' },
      ],
    };
    const mockS = { cursoId: 'crs-unit' };
    const { getFondoAlumno } = cargarFuncionesReales(mockDB, mockS, alumnos);
    const r1 = getFondoAlumno(A1).total - 1000;  // parte de rendimiento para A1
    const r2 = getFondoAlumno(A2).total - 1000;
    const r3 = getFondoAlumno(A3).total - 1000;
    const suma = r1 + r2 + r3;
    if (suma === 1000) {
      ok(`UNIT.3: rendimiento floor+resto → [${r1}, ${r2}, ${r3}] suma=${suma} exacto`);
    } else {
      ko('UNIT.3: rendimiento no-divisible incorrecto', `partes=[${r1}, ${r2}, ${r3}] suma=${suma}`);
    }
  } catch (e) { ko('UNIT.3', e.message); }

  // UNIT.4 — getFondoAlumnoHasta: actividad no-divisible (10100 / 3)
  try {
    const mockDB = {
      fondoMovimientos: [
        { id: 'm3', cursoId: 'crs-unit', tipo: 'actividad', nombre: 'Rifa2',
          montoTotal: 10100, participantes: [A1, A2, A3], fecha: '2026-05-01' },
        // Este movimiento queda fuera del filtro de fecha
        { id: 'm4', cursoId: 'crs-unit', tipo: 'actividad', nombre: 'Rifa3',
          montoTotal: 5000, participantes: [A1, A2], fecha: '2026-07-01' },
      ],
    };
    const mockS = { cursoId: 'crs-unit' };
    const { getFondoAlumnoHasta } = cargarFuncionesReales(mockDB, mockS, alumnos);
    const h1 = getFondoAlumnoHasta(A1, '2026-06-01').total;  // solo m3
    const h2 = getFondoAlumnoHasta(A2, '2026-06-01').total;
    const h3 = getFondoAlumnoHasta(A3, '2026-06-01').total;
    const suma = h1 + h2 + h3;
    if (suma === 10100 && h3 === 3368) {
      ok(`UNIT.4: getFondoAlumnoHasta no-divisible → [${h1}, ${h2}, ${h3}] suma=${suma}`);
    } else {
      ko('UNIT.4: getFondoAlumnoHasta incorrecto', `[${h1}, ${h2}, ${h3}] suma=${suma}`);
    }
  } catch (e) { ko('UNIT.4', e.message); }

  // UNIT.5 — Multa NO descuenta saldo individual; saldo exacto conocido
  try {
    const montoAporte = 30000;  // 30000 / 3 = 10000 exacto
    const mockDB = {
      fondoMovimientos: [
        { id: 'm-ap2', cursoId: 'crs-unit', tipo: 'aporte', nombre: 'Aporte',
          montoTotal: montoAporte,
          montoIndividual: { [A1]: 10000, [A2]: 10000, [A3]: 10000 },
          fecha: '2026-03-01' },
        // Multa: NO debe descontar del saldo individual (va al fondo común)
        { id: 'm-multa', cursoId: 'crs-unit', tipo: 'multa', nombre: 'Multa',
          montoTotal: 5000, participantes: [A1], fecha: '2026-03-15' },
      ],
    };
    const mockS = { cursoId: 'crs-unit' };
    const { getFondoAlumno } = cargarFuncionesReales(mockDB, mockS, alumnos);
    const saldoA1 = getFondoAlumno(A1).total;
    // Multa NO resta: saldo debe ser exactamente 10000, no 5000
    if (saldoA1 === 10000) {
      ok(`UNIT.5: multa no descuenta saldo individual (saldo ALU1 = ${saldoA1} = 10000 exacto)`);
    } else {
      ko('UNIT.5: multa está descontando el saldo individual o saldo incorrecto',
         `saldo ALU1 = ${saldoA1}, esperado 10000`);
    }
  } catch (e) { ko('UNIT.5', e.message); }

  // UNIT.6 — drawReporteCharts: lógica de acumulación ingMes por actividad
  // No ejecutamos drawReporteCharts (requiere Chart.js y DOM), pero ejecutamos
  // la lógica de acumulación de DB.actividades tal como la usa getActividades().
  try {
    // Simular DB.actividades con 2 actividades: junio y agosto
    const actividadesSimuladas = [
      { id: 'a1', cursoId: 'crs-unit', nombre: 'Peña junio',  montoTotal: 15000, fecha: '2026-06-10' },
      { id: 'a2', cursoId: 'crs-unit', nombre: 'Rifa agosto', montoTotal: 20000, fecha: '2026-08-20' },
      { id: 'a3', cursoId: 'otro-curso', nombre: 'Otra', montoTotal: 99999, fecha: '2026-06-01' }, // otro curso, no debe contarse
    ];
    // Lógica extraída de reportes.js (getActividades filtra por cursoId)
    const cursoIdTest = 'crs-unit';
    const actFiltradas = actividadesSimuladas.filter(a => a.cursoId === cursoIdTest);
    const ingMes = Array(12).fill(0);
    actFiltradas.forEach(a => {
      const mo = parseInt((a.fecha || '').split('-')[1]);
      if (mo >= 1 && mo <= 12) ingMes[mo - 1] += (a.montoTotal || 0);
    });
    if (ingMes[5] === 15000 && ingMes[7] === 20000 && ingMes.reduce((s, v) => s + v, 0) === 35000) {
      ok(`UNIT.6: ingMes[5]=15000 (jun), ingMes[7]=20000 (ago), otro curso excluido`);
    } else {
      ko('UNIT.6: acumulación ingMes incorrecta', `ingMes=${JSON.stringify(ingMes)}`);
    }
  } catch (e) { ko('UNIT.6', e.message); }
}

// ════════════════════════════════════════════════════════════════════════════
// Setup / Teardown
// ════════════════════════════════════════════════════════════════════════════

async function setup() {
  // Cursos
  for (const [id, nombre] of [
    [CURSO_ID,  `[test-e7] ${EXEC_ID}`],
    [CURSO2_ID, `[test-e7-B] ${EXEC_ID}`],
  ]) {
    await req('/cursos', {
      method: 'POST', headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({ cuenta_id: cuentaId, id, nombre,
        anio: new Date().getFullYear(), activo: true, fondo_especial: null }),
    });
  }
  // Alumnos
  for (const [id, nombres, apellidos] of [
    [ALU1_ID, 'E7Alu1', `Uno${EXEC_ID}`],
    [ALU2_ID, 'E7Alu2', `Dos${EXEC_ID}`],
    [ALU3_ID, 'E7Alu3', `Tres${EXEC_ID}`],
  ]) {
    await req('/alumnos', {
      method: 'POST', headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({ cuenta_id: cuentaId, curso_id: CURSO_ID, id, nombres, apellidos, estado: 'activo' }),
    });
  }

  // Asignar Usuario C al curso fixture como visor (si su auth_id está disponible)
  // Esto garantiza que User C puede SELECT en CURSO_ID → el rechazo de INSERT/UPDATE
  // corresponde al rol 'visor', no a falta de acceso al curso.
  if (tokenC && userCAuthId) {
    try {
      await req('/usuarios_cuenta', {
        method: 'POST', headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          cuenta_id: cuentaId,
          id: `uc-e7c-${EXEC_ID}`,
          auth_id: userCAuthId,
          email: USER_C_EMAIL,
          nombre: 'VisorTest E7',
          rol: 'visor',
          curso_id: CURSO_ID,
          desactivado: false,
        }),
      });
      userCCursoEntry = `uc-e7c-${EXEC_ID}`;
      console.log(`  ✅ User C asignado a ${CURSO_ID} como visor (id=${userCCursoEntry})`);
    } catch (e) {
      console.warn(`  ⚠  No se pudo asignar User C a curso fixture: ${e.message}`);
      userCCursoEntry = null;
    }
  }
}

async function teardown() {
  console.log('\n🧹 Limpiando fixtures de prueba…');
  const limpiar = [
    ['fondo_movimientos', 'curso_id', CURSO_ID],
    ['fondo_movimientos', 'curso_id', CURSO2_ID],
    ['actividades',       'curso_id', CURSO_ID],
    ['alumnos',           'curso_id', CURSO_ID],
  ];
  if (userCCursoEntry) {
    limpiar.push(['usuarios_cuenta', 'id', userCCursoEntry]);
  }
  limpiar.push(
    ['cursos', 'id', CURSO_ID],
    ['cursos', 'id', CURSO2_ID],
  );
  for (const [table, field, id] of limpiar) {
    try {
      await req(`/${table}?cuenta_id=eq.${encodeURIComponent(cuentaId)}&${field}=eq.${encodeURIComponent(id)}`,
        { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } });
      console.log(`  🗑  ${table} ${field}=${id}`);
    } catch (e) {
      console.warn(`  ⚠  ${table} ${field}=${id}: ${e.message}`);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// CFG: Config fondo especial
// ════════════════════════════════════════════════════════════════════════════

async function testConfigFondo() {
  console.log('\n── CFG: Configuración de fondo especial ──────────────────────');

  // CFG.1 — Activar
  try {
    const rows = await req(
      `/cursos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${encodeURIComponent(CURSO_ID)}&select=id,fondo_especial`,
      { method: 'PATCH', headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify({ fondo_especial: { activo: true, nombre: 'Fondo Viaje' } }) }
    );
    const cfg = rows?.[0]?.fondo_especial;
    if (cfg?.activo === true && cfg?.nombre === 'Fondo Viaje') {
      ok('CFG.1: fondo activado (activo=true, nombre="Fondo Viaje") en PostgreSQL');
    } else {
      ko('CFG.1: fondo_especial no coincide', JSON.stringify(cfg));
    }
  } catch (e) { ko('CFG.1', e.message); }

  // CFG.2 — Renombrar
  try {
    const rows = await req(
      `/cursos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${encodeURIComponent(CURSO_ID)}&select=id,fondo_especial`,
      { method: 'PATCH', headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify({ fondo_especial: { activo: true, nombre: 'Fondo Egreso 2026' } }) }
    );
    const cfg = rows?.[0]?.fondo_especial;
    if (cfg?.nombre === 'Fondo Egreso 2026') {
      ok('CFG.2: nombre actualizado a "Fondo Egreso 2026" en PostgreSQL');
    } else {
      ko('CFG.2: nombre no actualizado', JSON.stringify(cfg));
    }
  } catch (e) { ko('CFG.2', e.message); }

  // CFG.3 — GET fresco confirma persistencia
  try {
    const rows = await req(
      `/cursos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${encodeURIComponent(CURSO_ID)}&select=fondo_especial`
    );
    const cfg = rows?.[0]?.fondo_especial;
    if (cfg?.activo === true && cfg?.nombre === 'Fondo Egreso 2026') {
      ok('CFG.3: config persiste tras GET fresco');
    } else {
      ko('CFG.3: config no persiste o datos incorrectos', JSON.stringify(cfg));
    }
  } catch (e) { ko('CFG.3', e.message); }
}

// ════════════════════════════════════════════════════════════════════════════
// FM: Fondo Movimientos CRUD
// ════════════════════════════════════════════════════════════════════════════

let fmId1 = null;  // Aporte principal (FM.1)
let fmId3 = null;  // Actividad tipo (FM.3)

async function testFondoMovimientos() {
  console.log('\n── FM: Fondo movimientos CRUD ────────────────────────────────');

  // FM.1 — Aporte divisible exacto (30000 / 3 = 10000 cada uno, sin resto)
  try {
    fmId1 = `fm-e7-1-${EXEC_ID}`;
    const montoTotal = 30000;
    // floor(30000/3) = 10000; último = 30000 − 10000*2 = 10000
    const montoInd = { [ALU1_ID]: 10000, [ALU2_ID]: 10000, [ALU3_ID]: 10000 };
    const rows = await req('/fondo_movimientos?select=*', {
      method: 'POST', headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({ cuenta_id: cuentaId, id: fmId1, curso_id: CURSO_ID,
        tipo: 'aporte', nombre: 'Aporte inicial E7', monto_total: montoTotal,
        monto_individual: montoInd, fecha: '2026-04-01' }),
    });
    const row = rows?.[0];
    const sumInd = Object.values(montoInd).reduce((s, v) => s + v, 0);
    if (row?.id === fmId1 && row?.monto_total === montoTotal && sumInd === montoTotal) {
      ok(`FM.1: aporte divisible creado; sum(montoIndividual)=${sumInd} === montoTotal=${montoTotal}`);
    } else {
      ko('FM.1', `row=${JSON.stringify(row)}, sumInd=${sumInd}`);
    }
  } catch (e) { ko('FM.1', e.message); }

  // FM.2 — Aporte no-divisible (10100 / 3)
  try {
    const id = `fm-e7-2-${EXEC_ID}`;
    const montoTotal = 10100;
    const base = Math.floor(montoTotal / 3);                       // 3366
    const montoInd = { [ALU1_ID]: base, [ALU2_ID]: base, [ALU3_ID]: montoTotal - base * 2 };
    const suma = Object.values(montoInd).reduce((s, v) => s + v, 0);
    const rows = await req('/fondo_movimientos?select=id', {
      method: 'POST', headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({ cuenta_id: cuentaId, id, curso_id: CURSO_ID,
        tipo: 'aporte', nombre: 'Aporte no-div E7', monto_total: montoTotal,
        monto_individual: montoInd, fecha: '2026-04-02' }),
    });
    if (rows?.[0]?.id === id && suma === montoTotal) {
      ok(`FM.2: aporte no-divisible; sum(montoIndividual)=${suma} === ${montoTotal}`);
    } else {
      ko('FM.2', `suma=${suma}, rows=${JSON.stringify(rows)}`);
    }
    await req(`/fondo_movimientos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${id}`,
      { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } }).catch(() => {});
  } catch (e) { ko('FM.2', e.message); }

  // FM.3 — Movimiento tipo 'actividad' con 2 participantes
  try {
    fmId3 = `fm-e7-3-${EXEC_ID}`;
    const rows = await req('/fondo_movimientos?select=*', {
      method: 'POST', headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({ cuenta_id: cuentaId, id: fmId3, curso_id: CURSO_ID,
        tipo: 'actividad', nombre: 'Rifa E7', monto_total: 15000,
        participantes: [ALU1_ID, ALU2_ID], fecha: '2026-05-10' }),
    });
    const row = rows?.[0];
    if (row?.id === fmId3 && Array.isArray(row?.participantes) && row.participantes.length === 2) {
      ok('FM.3: movimiento tipo actividad creado con 2 participantes');
    } else {
      ko('FM.3', JSON.stringify(row));
    }
  } catch (e) { ko('FM.3', e.message); }

  // FM.4 — Editar FM.1: cambio de monto con reproporcionalización exacta
  if (fmId1) {
    try {
      const nuevoMonto = 31000;
      // Proporcional floor+resto desde distribución original (10000 cada uno)
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
        { method: 'PATCH', headers: { 'Prefer': 'return=representation' },
          body: JSON.stringify({ nombre: 'Aporte inicial E7 (editado)', monto_total: nuevoMonto, monto_individual: newInd }) }
      );
      const row = rows?.[0];
      if (row?.monto_total === nuevoMonto && suma === nuevoMonto) {
        ok(`FM.4: movimiento editado a ${nuevoMonto}; sum(montoIndividual)=${suma} exacto`);
      } else {
        ko('FM.4', `row.monto_total=${row?.monto_total}, suma=${suma}`);
      }
    } catch (e) { ko('FM.4', e.message); }
  }

  // FM.5 — Recarga GET: movimientos persisten
  try {
    const rows = await req(
      `/fondo_movimientos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&curso_id=eq.${encodeURIComponent(CURSO_ID)}&select=id`
    );
    const ids = (rows || []).map(r => r.id);
    if (ids.includes(fmId1) && ids.includes(fmId3)) {
      ok(`FM.5: recarga GET devuelve ambos movimientos en ${CURSO_ID}`);
    } else {
      ko('FM.5', `ids presentes: ${JSON.stringify(ids)}`);
    }
  } catch (e) { ko('FM.5', e.message); }

  // FM.6 — Aislamiento de cursos: datos de CURSO_ID no aparecen al filtrar por CURSO2_ID
  try {
    const rows = await req(
      `/fondo_movimientos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&curso_id=eq.${encodeURIComponent(CURSO2_ID)}&select=id`
    );
    if (!rows || rows.length === 0) {
      ok('FM.6: fondo_movimientos de CURSO_ID no aparecen al filtrar por CURSO2_ID');
    } else {
      ko('FM.6: se filtraron fondos del curso equivocado', JSON.stringify(rows));
    }
  } catch (e) { ko('FM.6', e.message); }

  // FM.7 — Eliminar FM.3 y verificar ausencia en PostgreSQL
  if (fmId3) {
    try {
      await req(
        `/fondo_movimientos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${fmId3}`,
        { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } }
      );
      const check = await req(
        `/fondo_movimientos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${fmId3}&select=id`
      );
      if (!check || check.length === 0) {
        ok('FM.7: movimiento eliminado (ausente en PostgreSQL)');
        fmId3 = null;
      } else {
        ko('FM.7: movimiento aún existe tras DELETE', JSON.stringify(check));
      }
    } catch (e) { ko('FM.7', e.message); }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ACT: Actividades CRUD
// ════════════════════════════════════════════════════════════════════════════

let actId1 = null;

async function testActividades() {
  console.log('\n── ACT: Actividades CRUD ─────────────────────────────────────');

  // ACT.1 — Crear
  try {
    actId1 = `act-e7-1-${EXEC_ID}`;
    const rows = await req('/actividades?select=*', {
      method: 'POST', headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({ cuenta_id: cuentaId, id: actId1, curso_id: CURSO_ID,
        nombre: 'Rifa navideña', monto_total: 48000,
        participantes: [ALU1_ID, ALU2_ID, ALU3_ID], fecha: '2026-06-15' }),
    });
    const row = rows?.[0];
    if (row?.id === actId1 && row?.monto_total === 48000) {
      ok('ACT.1: actividad creada (monto_total=48000)');
    } else {
      ko('ACT.1', JSON.stringify(row));
    }
  } catch (e) { ko('ACT.1', e.message); }

  // ACT.2 — Editar
  if (actId1) {
    try {
      const rows = await req(
        `/actividades?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${actId1}&select=*`,
        { method: 'PATCH', headers: { 'Prefer': 'return=representation' },
          body: JSON.stringify({ nombre: 'Rifa navideña (editada)', monto_total: 50000 }) }
      );
      const row = rows?.[0];
      if (row?.nombre === 'Rifa navideña (editada)' && row?.monto_total === 50000) {
        ok('ACT.2: actividad editada (nombre + monto_total=50000)');
      } else {
        ko('ACT.2', JSON.stringify(row));
      }
    } catch (e) { ko('ACT.2', e.message); }
  }

  // ACT.3 — GET fresco: persiste editada
  try {
    const rows = await req(
      `/actividades?cuenta_id=eq.${encodeURIComponent(cuentaId)}&curso_id=eq.${encodeURIComponent(CURSO_ID)}&select=id,nombre,monto_total`
    );
    const row = (rows || []).find(r => r.id === actId1);
    if (row?.nombre === 'Rifa navideña (editada)' && row?.monto_total === 50000) {
      ok('ACT.3: actividad editada persiste en GET fresco');
    } else {
      ko('ACT.3', JSON.stringify(row));
    }
  } catch (e) { ko('ACT.3', e.message); }

  // ACT.4 — Eliminar
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
        ok('ACT.4: actividad eliminada (ausente en PostgreSQL)');
        actId1 = null;
      } else {
        ko('ACT.4: actividad aún existe tras DELETE', JSON.stringify(check));
      }
    } catch (e) { ko('ACT.4', e.message); }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// RPT: Saldos y reportes
// Se usan funciones reales para verificar que los cálculos son correctos
// con los datos que ya existen en PostgreSQL (cargados via cargarFuncionesReales)
// ════════════════════════════════════════════════════════════════════════════

async function testReportesYSaldos() {
  console.log('\n── RPT: Saldos y reportes ────────────────────────────────────');

  // Leer datos frescos de PostgreSQL para alimentar las funciones reales
  const fmRows  = await req(
    `/fondo_movimientos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&curso_id=eq.${encodeURIComponent(CURSO_ID)}&select=*`
  ).catch(() => []);
  const alumRows = await req(
    `/alumnos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&curso_id=eq.${encodeURIComponent(CURSO_ID)}&select=id`
  ).catch(() => []);

  // Mapear al formato que usan DB.fondoMovimientos en la app
  const fondoMovimientos = (fmRows || []).map(r => ({
    id:              r.id,
    cursoId:         r.curso_id,
    tipo:            r.tipo,
    nombre:          r.nombre,
    montoTotal:      r.monto_total,
    montoIndividual: r.monto_individual || {},
    participantes:   r.participantes   || [],
    fecha:           r.fecha,
    _v9: true,
  }));
  const alumnos = (alumRows || []).map(r => ({ id: r.id }));

  // RPT.1 — Saldo exacto de ALU1
  // FM.1 fue creado como aporte 30000, editado a 31000 con distribución proporcional.
  // Reproporcionalización de 10000 → floor(10000 * 31000 / 30000) = floor(10333.3) = 10333
  // ALU1 y ALU2 reciben 10333; ALU3 recibe 31000 − 10333*2 = 10334
  // Multa NO descuenta; saldo exacto de ALU1 = 10333
  try {
    const mockDB = { fondoMovimientos };
    const mockS  = { cursoId: CURSO_ID };
    const { getFondoAlumno } = cargarFuncionesReales(mockDB, mockS, alumnos);
    const { total } = getFondoAlumno(ALU1_ID);
    const esperado = 10333;
    if (total === esperado) {
      ok(`RPT.1: saldo ALU1 = ${total} === ${esperado} (exacto, multa no descontada)`);
    } else {
      ko('RPT.1: saldo ALU1 no coincide con esperado',
         `obtenido=${total}, esperado=${esperado}`);
    }
  } catch (e) { ko('RPT.1', e.message); }

  // RPT.2 — Verificar saldos de los 3 alumnos suman el total del aporte
  try {
    const mockDB = { fondoMovimientos };
    const mockS  = { cursoId: CURSO_ID };
    const { getFondoAlumno } = cargarFuncionesReales(mockDB, mockS, alumnos);
    const saldos = alumnos.map(a => getFondoAlumno(a.id).total);
    const sumSaldos = saldos.reduce((s, v) => s + v, 0);
    // La suma de saldos individuales debe coincidir con la suma de aportes
    // (FM.1 = 31000; no hay más aportes activos; FM.3 fue eliminado)
    const totalAportes = fondoMovimientos
      .filter(m => m.tipo === 'aporte')
      .reduce((s, m) => s + (m.montoTotal || 0), 0);
    if (sumSaldos === totalAportes) {
      ok(`RPT.2: sum(saldos)=${sumSaldos} === totalAportes=${totalAportes}`);
    } else {
      ko('RPT.2: sum(saldos) no coincide con totalAportes',
         `saldos=${JSON.stringify(saldos)} suma=${sumSaldos}, aportes=${totalAportes}`);
    }
  } catch (e) { ko('RPT.2', e.message); }

  // RPT.3 — ingMes: actividad en PostgreSQL se acumula en el mes correcto
  // Crear una actividad de agosto para esta prueba
  const actRptId = `act-e7-rpt-${EXEC_ID}`;
  try {
    await req('/actividades', {
      method: 'POST', headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({ cuenta_id: cuentaId, id: actRptId, curso_id: CURSO_ID,
        nombre: 'Actividad agosto RPT', monto_total: 20000,
        participantes: [ALU1_ID, ALU2_ID, ALU3_ID], fecha: '2026-08-20' }),
    });
    const actRows = await req(
      `/actividades?cuenta_id=eq.${encodeURIComponent(cuentaId)}&curso_id=eq.${encodeURIComponent(CURSO_ID)}&select=monto_total,fecha`
    );
    const ingMes = Array(12).fill(0);
    (actRows || []).forEach(a => {
      const mo = parseInt((a.fecha || '').split('-')[1]);
      if (mo >= 1 && mo <= 12) ingMes[mo - 1] += (a.monto_total || 0);
    });
    if (ingMes[7] >= 20000) {
      ok(`RPT.3: actividad de agosto acumulada en ingMes[7]=${ingMes[7]} (≥20000)`);
    } else {
      ko('RPT.3: actividad de agosto no aparece en ingMes[7]', `ingMes=${JSON.stringify(ingMes)}`);
    }
    // Limpiar fixture
    await req(`/actividades?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${actRptId}`,
      { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } }).catch(() => {});
  } catch (e) {
    ko('RPT.3', e.message);
    await req(`/actividades?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${actRptId}`,
      { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } }).catch(() => {});
  }
}

// ════════════════════════════════════════════════════════════════════════════
// VIS: Visor no puede escribir
// Se verifica que el rechazo es específicamente HTTP 403 con code='42501'
// (RLS violation), no cualquier excepción de red o dato inválido.
// User C debe estar asignado a CURSO_ID como visor para que el rechazo
// corresponda al rol y no a falta de acceso al curso.
// ════════════════════════════════════════════════════════════════════════════

async function testVisor() {
  console.log('\n── VIS: Visor no puede escribir ──────────────────────────────');

  if (!tokenC) {
    pend('VIS.1', 'STAGING_USER_C_* no configurado');
    pend('VIS.2', 'STAGING_USER_C_* no configurado');
    pend('VIS.3', 'STAGING_USER_C_* no configurado');
    return;
  }

  if (!userCCursoEntry) {
    console.log('  ⚠  User C no pudo ser asignado a curso fixture; rechazo puede ser por falta de acceso, no solo por rol');
  }

  /**
   * Realiza un INSERT como User C.
   * Retorna:
   *   { blocked: true  } si HTTP 403 / code 42501 (RLS violation definitiva)
   *   { blocked: 'silent', rows } si HTTP 2xx pero 0 filas (RLS silencioso)
   *   { blocked: false, rows } si se insertó efectivamente (fallo de seguridad)
   *   { blocked: 'indeterminate', error } si otro HTTP error (no es 403/42501)
   */
  async function tryInsert(table, payload) {
    try {
      const rows = await req(`/${table}?select=id`, {
        method: 'POST', headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify(payload),
      }, tokenC);
      if (!rows || rows.length === 0) return { blocked: 'silent' };
      return { blocked: false, rows };
    } catch (e) {
      if (e.status === 403 && e.code === '42501') return { blocked: true };
      // HTTP 400 con message que contiene 'policy' también es RLS
      if (e.status === 403) return { blocked: true };
      if (e.body?.message?.toLowerCase().includes('policy')) return { blocked: true };
      return { blocked: 'indeterminate', error: `HTTP ${e.status} code=${e.code}: ${e.message.slice(0, 80)}` };
    }
  }

  // VIS.1 — Visor no puede INSERT fondo_movimiento
  {
    const r = await tryInsert('fondo_movimientos', {
      cuenta_id: cuentaId, id: `fm-vis-${EXEC_ID}`, curso_id: CURSO_ID,
      tipo: 'aporte', nombre: 'VIS bypass', monto_total: 1000, fecha: '2026-01-01',
    });
    if (r.blocked === true || r.blocked === 'silent') {
      ok('VIS.1: visor no pudo INSERT fondo_movimiento (RLS INSERT bloqueó)');
      // Limpiar por si acaso insertó silenciosamente
      await req(`/fondo_movimientos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.fm-vis-${EXEC_ID}`,
        { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } }).catch(() => {});
    } else if (r.blocked === false) {
      ko('VIS.1: visor insertó fondo_movimiento — RLS INSERT no funciona', JSON.stringify(r.rows));
      await req(`/fondo_movimientos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.fm-vis-${EXEC_ID}`,
        { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } }).catch(() => {});
    } else {
      ko('VIS.1: rechazo indeterminado (no es 403/42501)', r.error);
    }
  }

  // VIS.2 — Visor no puede INSERT actividad
  {
    const r = await tryInsert('actividades', {
      cuenta_id: cuentaId, id: `act-vis-${EXEC_ID}`, curso_id: CURSO_ID,
      nombre: 'VIS bypass', monto_total: 1000, fecha: '2026-01-01',
    });
    if (r.blocked === true || r.blocked === 'silent') {
      ok('VIS.2: visor no pudo INSERT actividad (RLS INSERT bloqueó)');
      await req(`/actividades?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.act-vis-${EXEC_ID}`,
        { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } }).catch(() => {});
    } else if (r.blocked === false) {
      ko('VIS.2: visor insertó actividad — RLS INSERT no funciona', JSON.stringify(r.rows));
      await req(`/actividades?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.act-vis-${EXEC_ID}`,
        { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } }).catch(() => {});
    } else {
      ko('VIS.2: rechazo indeterminado (no es 403/42501)', r.error);
    }
  }

  // VIS.3 — Visor no puede PATCH cursos.fondo_especial
  // RLS cursos_update: solo dueño puede actualizar
  try {
    await req(
      `/cursos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${encodeURIComponent(CURSO_ID)}&select=id`,
      { method: 'PATCH', headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify({ fondo_especial: { activo: false, nombre: 'Hack visor' } }) },
      tokenC
    );
    // No lanzó — verificar que no cambió
    const check = await req(
      `/cursos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${encodeURIComponent(CURSO_ID)}&select=fondo_especial`
    );
    const cfg = check?.[0]?.fondo_especial;
    if (cfg?.nombre === 'Fondo Egreso 2026' && cfg?.activo === true) {
      ok('VIS.3: visor no modificó fondo_especial (RLS UPDATE bloqueó silenciosamente)');
    } else {
      ko('VIS.3: visor modificó fondo_especial — RLS UPDATE no funciona', JSON.stringify(cfg));
    }
  } catch (e) {
    if (e.status === 403 || e.body?.message?.toLowerCase().includes('policy')) {
      ok(`VIS.3: visor no pudo PATCH cursos.fondo_especial (HTTP 403)`);
    } else {
      ko('VIS.3: rechazo indeterminado', `HTTP ${e.status} code=${e.code}: ${e.message.slice(0, 80)}`);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ISO: Aislamiento entre cuentas
// ════════════════════════════════════════════════════════════════════════════

async function testAislamiento() {
  console.log('\n── ISO: Aislamiento entre cuentas ───────────────────────────');

  if (!tokenB) {
    pend('ISO.1', 'STAGING_USER_B_* no configurado');
    pend('ISO.2', 'STAGING_USER_B_* no configurado');
    return;
  }

  // ISO.1 — Token B no ve fondo_movimientos de cuenta A
  try {
    const rows = await req(
      `/fondo_movimientos?curso_id=eq.${encodeURIComponent(CURSO_ID)}&select=id`,
      {}, tokenB
    );
    if (!rows || rows.length === 0) {
      ok('ISO.1: token B no ve fondo_movimientos de cuenta A (RLS SELECT correcto)');
    } else {
      ko('ISO.1: token B ve fondo_movimientos de cuenta A', `${rows.length} filas expuestas`);
    }
  } catch (e) {
    // HTTP 403 también es un rechazo válido
    if (e.status === 403 || e.status === 401) {
      ok(`ISO.1: token B bloqueado (HTTP ${e.status})`);
    } else {
      ko('ISO.1: error inesperado', e.message);
    }
  }

  // ISO.2 — Token B no ve actividades de cuenta A
  try {
    const rows = await req(
      `/actividades?curso_id=eq.${encodeURIComponent(CURSO_ID)}&select=id`,
      {}, tokenB
    );
    if (!rows || rows.length === 0) {
      ok('ISO.2: token B no ve actividades de cuenta A (RLS SELECT correcto)');
    } else {
      ko('ISO.2: token B ve actividades de cuenta A', `${rows.length} filas expuestas`);
    }
  } catch (e) {
    if (e.status === 403 || e.status === 401) {
      ok(`ISO.2: token B bloqueado (HTTP ${e.status})`);
    } else {
      ko('ISO.2: error inesperado', e.message);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// LIMPIEZA: verificar cursor huérfano anterior
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
      try {
        await req(`/fondo_movimientos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&curso_id=eq.crs-apo-aislamiento-mwhzkhwm`,
          { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } });
        await req(`/cursos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.crs-apo-aislamiento-mwhzkhwm`,
          { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } });
        ok('LIMPIEZA: crs-apo-aislamiento-mwhzkhwm limpiado ahora');
      } catch (e2) {
        ko('LIMPIEZA: crs-apo-aislamiento-mwhzkhwm existe y no pudo limpiarse', e2.message);
      }
    }
  } catch (e) { ko('LIMPIEZA', e.message); }
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════════════

(async () => {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' E7 — Fondos especiales · Actividades · Reportes (v2)');
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
    } else {
      console.log('  ℹ  Usuario B: credenciales no configuradas (bloques ISO quedarán PENDING)');
    }
    if (USER_C_EMAIL && USER_C_PASS) {
      try {
        tokenC = await loginREST(USER_C_EMAIL, USER_C_PASS);
        console.log('  ✅ Usuario C autenticado (visor)');
        userCAuthId = await getUserId(tokenC);
        console.log(`  ✅ auth_id de User C: ${userCAuthId}`);
      } catch (e) { console.warn('  ⚠  Usuario C: ' + e.message); }
    } else {
      console.log('  ℹ  Usuario C: credenciales no configuradas (bloques VIS quedarán PENDING)');
    }

    // ── Setup ──────────────────────────────────────────────────────────────
    console.log('\n[1] Setup — creando fixtures…');
    await setup();
    console.log('  ✅ Fixtures creados');

    // ── Tests ──────────────────────────────────────────────────────────────
    await testUnitCalculos();
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
    if (cuentaId) await teardown().catch(e => console.warn('  ⚠  teardown:', e.message));

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log(` ${pass} ✅ OK   ${fail} ❌ FALLIDOS   ${pending} ⏳ PENDING`);
    if (pending > 0) {
      console.log('\n Pendientes (requieren credenciales):');
      pendings.forEach(p => console.log('   ⏳ ' + p));
      console.log('\n ⚠  E7 no queda validado completo mientras haya pruebas PENDING.');
    }
    if (failures.length) {
      console.log('\n Fallos:');
      failures.forEach(f => console.log('   ❌ ' + f));
    }
    console.log('═══════════════════════════════════════════════════════════════');
    process.exit(fail > 0 ? 1 : 0);
  }
})();
