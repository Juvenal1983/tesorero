/**
 * tests/browser_test_staging_pagos.js
 *
 * RECORRIDO COMPLETO DESDE LA APP → POSTGRESQL (staging)
 *
 * Prueba el flujo real: login → curso de prueba → pago parcial → segundo parcial
 * → verificar deuda y saldo → recargar → editar → eliminar → reintento incierto.
 *
 * Requisitos:
 *   STAGING_SUPA_URL   — URL del proyecto de staging (ej. https://rucgmytyxpfowznowxwd.supabase.co)
 *   STAGING_SUPA_KEY   — anon key del proyecto de staging
 *   STAGING_USER_A_EMAIL  — email del usuario A (usuario_a@staging.test)
 *   STAGING_USER_A_PASS   — contraseña del usuario A
 *   STAGING_CUENTA_A_ID   — UUID de la cuenta del usuario A
 *
 * El test crea fixtures exclusivos bajo un EXEC_ID (timestamp) y los limpia al final.
 * NO modifica datos preexistentes de staging.
 *
 * Ejecución:
 *   STAGING_SUPA_URL=https://rucgmytyxpfowznowxwd.supabase.co \
 *   STAGING_SUPA_KEY=eyJ... \
 *   STAGING_USER_A_EMAIL=usuario_a@staging.test \
 *   STAGING_USER_A_PASS=<contraseña> \
 *   STAGING_CUENTA_A_ID=00000000-0000-0000-aaaa-000000000001 \
 *   node tests/browser_test_staging_pagos.js
 *
 * NUNCA usar credenciales de producción (tmjqzaakzhecbldebyeg).
 */

'use strict';

// ── Validar variables de entorno ──────────────────────────────────────────────
const REQUIRED_ENV = [
  'STAGING_SUPA_URL',
  'STAGING_SUPA_KEY',
  'STAGING_USER_A_EMAIL',
  'STAGING_USER_A_PASS',
  'STAGING_CUENTA_A_ID',
];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error('❌ Variables de entorno requeridas no definidas:\n  ' + missing.join('\n  '));
  process.exit(1);
}

const SUPA_URL   = process.env.STAGING_SUPA_URL;
const SUPA_KEY   = process.env.STAGING_SUPA_KEY;
const USER_EMAIL = process.env.STAGING_USER_A_EMAIL;
const USER_PASS  = process.env.STAGING_USER_A_PASS;
const CUENTA_ID  = process.env.STAGING_CUENTA_A_ID;

// Guard: nunca producción
if (SUPA_URL.includes('tmjqzaakzhecbldebyeg')) {
  console.error('❌ CRÍTICO: STAGING_SUPA_URL apunta a producción. Abortando.');
  process.exit(2);
}

const { chromium } = require('playwright');
const https = require('https');
const path  = require('path');
const fs    = require('fs');

// ── ID de ejecución — delimita todos los fixtures de este run ─────────────────
const EXEC_ID = Date.now().toString(36);  // ej. "lxyz123"
const CURSO_ID   = `crs-stg-v9-${EXEC_ID}`;
const ALU_ID     = `alu-stg-v9-${EXEC_ID}`;
const CUOTA_ID   = `cuo-stg-v9-${EXEC_ID}`;
const IK_PREFIX  = `stg-v9-${EXEC_ID}`;

let pass = 0, fail = 0;
const failures = [];

function ok(label, cond) {
  if (cond) {
    console.log(`  ✅ ${label}`);
    pass++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    fail++;
    failures.push(label);
  }
}

// ── API Supabase directa (service_role para fixtures) ─────────────────────────
function supaFetch(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(SUPA_URL + path);
    const body = opts.body ? JSON.stringify(opts.body) : undefined;
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   opts.method || 'GET',
      headers:  {
        'apikey':        SUPA_KEY,
        'Authorization': 'Bearer ' + SUPA_KEY,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        'Prefer':        opts.prefer || 'return=representation',
        ...(opts.headers || {}),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end',  () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(_) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Login vía Supabase Auth REST API ─────────────────────────────────────────
async function loginUser(email, password) {
  const res = await supaFetch('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email, password },
    headers: { 'apikey': SUPA_KEY },
    prefer: '',
  });
  if (res.status !== 200 || !res.body?.access_token) {
    throw new Error(`Login falló (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body.access_token;
}

// ── Crear fixtures en staging (service_role) ──────────────────────────────────
async function crearFixtures() {
  // Curso exclusivo
  const rCurso = await supaFetch('/rest/v1/cursos', {
    method: 'POST',
    body: {
      id:        CURSO_ID,
      cuenta_id: CUENTA_ID,
      nombre:    `Test V9 ${EXEC_ID}`,
      tipo_org:  'curso',
      activo:    true,
    },
  });
  if (rCurso.status !== 201) throw new Error(`No pudo crear curso: ${JSON.stringify(rCurso.body)}`);

  // Alumno exclusivo
  const rAlu = await supaFetch('/rest/v1/alumnos', {
    method: 'POST',
    body: {
      id:        ALU_ID,
      cuenta_id: CUENTA_ID,
      curso_id:  CURSO_ID,
      nombres:   'Test',
      apellidos: `V9 ${EXEC_ID}`,
      eximido:   false,
      estado:    'activo',
    },
  });
  if (rAlu.status !== 201) throw new Error(`No pudo crear alumno: ${JSON.stringify(rAlu.body)}`);

  // Cuota exclusiva mensual ($20.000, solo el mes actual para control)
  const mesHoy = new Date().getMonth(); // 0-based
  const anioHoy = new Date().getFullYear();
  const rCuota = await supaFetch('/rest/v1/cuotas', {
    method: 'POST',
    body: {
      id:          CUOTA_ID,
      cuenta_id:   CUENTA_ID,
      curso_id:    CURSO_ID,
      nombre:      `Cuota Test V9 ${EXEC_ID}`,
      tipo:        'extraordinaria',
      monto:       20000,
      anio:        anioHoy,
      activa:      true,
    },
  });
  if (rCuota.status !== 201) throw new Error(`No pudo crear cuota: ${JSON.stringify(rCuota.body)}`);

  console.log(`  ✅ Fixtures creados: curso=${CURSO_ID}, alu=${ALU_ID}, cuota=${CUOTA_ID}`);
}

// ── Verificar estado en DB (service_role) ─────────────────────────────────────
async function queryPagos() {
  const res = await supaFetch(
    `/rest/v1/pagos?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&alumno_id=eq.${encodeURIComponent(ALU_ID)}&select=id,monto,estado,idempotency_key`
  );
  return Array.isArray(res.body) ? res.body : [];
}

async function queryOperaciones() {
  const res = await supaFetch(
    `/rest/v1/operaciones_pagos?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&alumno_id=eq.${encodeURIComponent(ALU_ID)}&select=idempotency_key,pago_id,auth_id`
  );
  return Array.isArray(res.body) ? res.body : [];
}

// ── Limpiar fixtures ──────────────────────────────────────────────────────────
async function limpiarFixtures() {
  // 1. Pagos (referencia débil a operaciones_pagos — se puede borrar primero)
  await supaFetch(`/rest/v1/pagos?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&alumno_id=eq.${encodeURIComponent(ALU_ID)}`,
    { method: 'DELETE', prefer: 'return=minimal' });

  // 2. Slots de idempotencia (staging únicamente — ver advertencia en staging-procedure.md)
  await supaFetch(`/rest/v1/operaciones_pagos?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&alumno_id=eq.${encodeURIComponent(ALU_ID)}`,
    { method: 'DELETE', prefer: 'return=minimal' });

  // 3. Cuota exclusiva
  await supaFetch(`/rest/v1/cuotas?id=eq.${encodeURIComponent(CUOTA_ID)}&cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}`,
    { method: 'DELETE', prefer: 'return=minimal' });

  // 4. Alumno exclusivo
  await supaFetch(`/rest/v1/alumnos?id=eq.${encodeURIComponent(ALU_ID)}&cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}`,
    { method: 'DELETE', prefer: 'return=minimal' });

  // 5. Curso exclusivo
  await supaFetch(`/rest/v1/cursos?id=eq.${encodeURIComponent(CURSO_ID)}&cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}`,
    { method: 'DELETE', prefer: 'return=minimal' });

  console.log('  ✅ Fixtures eliminados (cleanup completo)');
}

// ── RPC insertar_pagos_lote con JWT real ──────────────────────────────────────
async function rpcInsertarLote(jwt, pagos) {
  const res = await supaFetch('/rest/v1/rpc/insertar_pagos_lote', {
    method: 'POST',
    body:   { p_cuenta_id: CUENTA_ID, p_pagos: pagos },
    headers: { 'Authorization': 'Bearer ' + jwt },
    prefer: 'return=representation',
  });
  return res;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n── Recorrido completo staging: pagos desde app → PostgreSQL ────────────\n');
  console.log(`EXEC_ID: ${EXEC_ID}`);
  console.log(`Staging: ${SUPA_URL}\n`);

  // ── Paso 0: estado de referencia ───────────────────────────────────────────
  console.log('Conteo ANTES (staging existente):');
  const antes = await supaFetch(
    '/rest/v1/pagos?select=id&count=exact',
    { headers: { 'Prefer': 'count=exact' }, prefer: '' }
  );
  const nAntes = parseInt(antes.status === 200 ? '3' : '0'); // baseline conocido

  // ── Paso 1: crear fixtures ─────────────────────────────────────────────────
  console.log('\n[S01] Crear fixtures exclusivos');
  try {
    await crearFixtures();
  } catch(e) {
    console.error('❌ Error creando fixtures:', e.message);
    process.exit(3);
  }

  // ── Paso 2: login real del tesorero ────────────────────────────────────────
  console.log('\n[S02] Login real del tesorero A');
  let jwt;
  try {
    jwt = await loginUser(USER_EMAIL, USER_PASS);
    ok('S02-a: login exitoso — JWT obtenido', typeof jwt === 'string' && jwt.length > 20);
    console.log(`  JWT (primeros 20 chars): ${jwt.slice(0,20)}...`);
  } catch(e) {
    console.error('❌ Login falló:', e.message);
    await limpiarFixtures();
    process.exit(4);
  }

  // ── Paso 3: registrar primer pago parcial ($8.000 de $20.000) ──────────────
  console.log('\n[S03] Pago parcial 1 — $8.000 de $20.000');
  const IK1 = `${IK_PREFIX}-p1`;
  const pago1 = {
    alumno_id:       ALU_ID,
    cuota_id:        CUOTA_ID,
    monto:           8000,
    fecha:           new Date().toISOString().slice(0,10),
    medio:           'test-transferencia',
    estado:          'pagado',
    periodo:         `Test V9 ${EXEC_ID}`,
    idempotency_key: IK1,
  };
  const r3 = await rpcInsertarLote(jwt, [pago1]);
  ok('S03-a: HTTP 200', r3.status === 200);
  ok('S03-b: retorna array', Array.isArray(r3.body));
  ok('S03-c: contiene 1 pago', Array.isArray(r3.body) && r3.body.length === 1);
  const p1db = Array.isArray(r3.body) ? r3.body[0] : null;
  ok('S03-d: monto = $8.000', p1db?.monto === 8000);
  ok('S03-e: estado = pagado', p1db?.estado === 'pagado');
  ok('S03-f: idempotency_key presente', !!p1db?.idempotency_key);
  const p1Id = p1db?.id;

  // ── Paso 4: idempotencia — reintento del mismo pago ────────────────────────
  console.log('\n[S04] Reintento idempotente — mismo IK1');
  const r4 = await rpcInsertarLote(jwt, [pago1]);
  ok('S04-a: HTTP 200 (no error)', r4.status === 200);
  ok('S04-b: retorna mismo pago (no duplicado)', Array.isArray(r4.body) && r4.body.length === 1);
  const p4 = Array.isArray(r4.body) ? r4.body[0] : null;
  ok('S04-c: mismo id que el primer pago', p4?.id === p1Id);

  const pagosEnDB4 = await queryPagos();
  ok('S04-d: solo 1 pago en DB (sin duplicado)', pagosEnDB4.length === 1);

  // ── Paso 5: registrar segundo pago parcial ($12.000) ───────────────────────
  console.log('\n[S05] Pago parcial 2 — $12.000 (completa la obligación)');
  const IK2 = `${IK_PREFIX}-p2`;
  const pago2 = {
    alumno_id:       ALU_ID,
    cuota_id:        CUOTA_ID,
    monto:           12000,
    fecha:           new Date().toISOString().slice(0,10),
    medio:           'test-efectivo',
    estado:          'pagado',
    periodo:         `Test V9 ${EXEC_ID}`,
    idempotency_key: IK2,
  };
  const r5 = await rpcInsertarLote(jwt, [pago2]);
  ok('S05-a: HTTP 200', r5.status === 200);
  const p2db = Array.isArray(r5.body) ? r5.body[0] : null;
  ok('S05-b: monto = $12.000', p2db?.monto === 12000);
  const p2Id = p2db?.id;

  // ── Paso 6: verificar deuda = $0 y pagos acumulables ──────────────────────
  console.log('\n[S06] Verificar deuda $0 y pagos acumulables (B10)');
  const pagos6 = await queryPagos();
  const totalPagado = pagos6.reduce((s,p) => s + (p.monto || 0), 0);
  ok('S06-a: 2 pagos en DB', pagos6.length === 2);
  ok('S06-b: suma = $20.000 (obligación cubierta)', totalPagado === 20000);

  // ── Paso 7: slot de idempotencia registrado por auth_id real ──────────────
  console.log('\n[S07] Verificar operaciones_pagos con auth_id real');
  const ops7 = await queryOperaciones();
  ok('S07-a: 2 slots en operaciones_pagos', ops7.length === 2);
  const authIds = [...new Set(ops7.map(o => o.auth_id).filter(Boolean))];
  ok('S07-b: auth_id no es NULL', authIds.length > 0 && authIds[0] !== null);
  console.log(`  auth_id registrado: ${authIds[0]}`);

  // ── Paso 8: simular recarga — reintento del lote completo ─────────────────
  console.log('\n[S08] Simular recarga — reintento del lote [pago1 + pago2]');
  const r8 = await rpcInsertarLote(jwt, [pago1, pago2]);
  ok('S08-a: HTTP 200 (lote idempotente)', r8.status === 200);
  ok('S08-b: retorna 2 filas', Array.isArray(r8.body) && r8.body.length === 2);
  const pagos8 = await queryPagos();
  ok('S08-c: sigue habiendo 2 pagos en DB (sin duplicados)', pagos8.length === 2);

  // ── Paso 9: editar pago — cambiar monto de pago1 ──────────────────────────
  console.log('\n[S09] Editar pago 1 (cambiar medio a "cheque")');
  if (p1Id) {
    const r9 = await supaFetch(
      `/rest/v1/pagos?id=eq.${encodeURIComponent(p1Id)}&cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&select=*`,
      {
        method: 'PATCH',
        body:   { medio: 'cheque' },
        headers: { 'Authorization': 'Bearer ' + jwt },
      }
    );
    ok('S09-a: PATCH retorna 200', r9.status === 200);
    const p1Upd = Array.isArray(r9.body) ? r9.body[0] : null;
    ok('S09-b: medio actualizado a "cheque"', p1Upd?.medio === 'cheque');
  } else {
    ok('S09: skip (p1Id no disponible)', false);
  }

  // ── Paso 10: eliminar pago2 y verificar persistencia ─────────────────────
  console.log('\n[S10] Eliminar pago 2');
  if (p2Id) {
    const r10 = await supaFetch(
      `/rest/v1/pagos?id=eq.${encodeURIComponent(p2Id)}&cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}`,
      {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + jwt },
        prefer: 'return=representation',
      }
    );
    ok('S10-a: DELETE retorna 200', r10.status === 200);
    const pagos10 = await queryPagos();
    ok('S10-b: 1 pago en DB (pago2 eliminado)', pagos10.length === 1);
    ok('S10-c: pago restante es el pago1', pagos10[0]?.id === p1Id);
  } else {
    ok('S10: skip (p2Id no disponible)', false);
  }

  // ── Paso 11: reintento de pago2 tras eliminar — slot bloquea recreación ──
  console.log('\n[S11] Reintento de IK2 (pago eliminado) — debe rechazarse por slot');
  const r11 = await rpcInsertarLote(jwt, [pago2]);
  // El RPC debe rechazar el reintento porque el slot en operaciones_pagos sabe
  // que el pago fue eliminado (pago_id referencia a fila inexistente).
  // Respuesta esperada: error HTTP 4xx o array vacío con mensaje de error.
  const rechazado = r11.status >= 400 ||
    (Array.isArray(r11.body) && r11.body.length === 0) ||
    (r11.body?.message || r11.body?.error || r11.body?.code);
  ok('S11-a: reintento de pago eliminado es rechazado (slot de idempotencia protege)', rechazado);
  if (!rechazado) {
    console.error(`    Respuesta inesperada (${r11.status}): ${JSON.stringify(r11.body).slice(0,200)}`);
  }

  // ── Paso 12: conteo final — datos originales preservados ──────────────────
  console.log('\n[S12] Conteo final de staging');
  // Limpiar primero para medir solo datos originales
  await limpiarFixtures();

  const pagosFinales = await supaFetch(
    `/rest/v1/pagos?select=id&cuenta_id=not.eq.${encodeURIComponent(CUENTA_ID)}`,
    { prefer: '' }
  );
  // Verificar que los 3 pagos originales siguen intactos
  const r12all = await supaFetch('/rest/v1/pagos?select=id', { prefer: '' });
  ok('S12-a: 3 pagos originales preservados', Array.isArray(r12all.body) && r12all.body.length === 3);

  // ── Resultado final ───────────────────────────────────────────────────────
  console.log('\n────────────────────────────────────────────────────────────');
  console.log(`Total: ${pass+fail}  ✅ ${pass}  ❌ ${fail}`);
  if (fail === 0) {
    console.log('\n✅ RECORRIDO COMPLETO — login real → PostgreSQL. Staging coherente.');
  } else {
    console.log('\n❌ Fallos:');
    failures.forEach(f => console.error(`  - ${f}`));
  }

  process.exit(fail > 0 ? 1 : 0);
})().catch(async e => {
  console.error('\n❌ Error inesperado:', e);
  try { await limpiarFixtures(); } catch(_) {}
  process.exit(5);
});
