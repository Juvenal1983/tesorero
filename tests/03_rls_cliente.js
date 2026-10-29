/**
 * El Tesorero — "El Gran Cambio" v9
 * Archivo: tests/03_rls_cliente.js  (v4 — 42501 exigido, T01 aserción, T06 sin error+vacío, T07 estricto)
 *
 * Pruebas RLS mediante sesiones de cliente reales con JWT de Supabase.
 * Usa @supabase/supabase-js y credenciales del proyecto de STAGING.
 *
 * PROPÓSITO:
 *   Verificar que las políticas RLS funcionan desde la perspectiva del cliente
 *   (no desde el SQL Editor admin). Una política incorrecta puede devolver
 *   0 filas en lugar de un error HTTP 403 — este test verifica ambos casos.
 *
 * PRE-REQUISITOS:
 *   1. Proyecto Supabase de staging creado y distinto de producción.
 *   2. 01_schema.sql + 02_rls.sql + 07_grants_supabase.sql ejecutados.
 *   3. 08_seed_staging.sql ejecutado con USER_A_UUID y USER_B_UUID sustituidos.
 *   4. Variables de entorno configuradas (ver abajo). NUNCA hardcodear credenciales.
 *   5. node >= 18 y @supabase/supabase-js instalado: npm install @supabase/supabase-js
 *
 * VARIABLES DE ENTORNO REQUERIDAS:
 *   export STAGING_SUPABASE_URL="https://xxxx.supabase.co"
 *   export STAGING_SUPABASE_ANON_KEY="eyJ..."
 *   export STAGING_USER_A_EMAIL="usuario_a@staging.test"
 *   export STAGING_USER_A_PASSWORD="contraseña-staging-A"
 *   export STAGING_USER_B_EMAIL="usuario_b@staging.test"
 *   export STAGING_USER_B_PASSWORD="contraseña-staging-B"
 *
 * USO:
 *   node tests/03_rls_cliente.js
 *
 * NOTA SOBRE COMPORTAMIENTO DE RLS EN SUPABASE:
 *   - SELECT bloqueado devuelve data=[] (array vacío), no error 403.
 *   - INSERT bloqueado por WITH CHECK devuelve error con code "42501" o similar.
 *   - UPDATE bloqueado devuelve data=[] (0 filas afectadas), no error.
 *   - Un INSERT exitoso SIN .select() devuelve data=null; no indica falla.
 *     Por eso T03/T08 siempre verifican la ausencia del registro con el propietario.
 *   - Las tablas SIN grant de tabla devuelven error de permisos, no data=[].
 */

'use strict';

import { createClient } from '@supabase/supabase-js';

// ── Verificación anti-producción ──────────────────────────────
const STAGING_URL = process.env.STAGING_SUPABASE_URL;
const STAGING_KEY = process.env.STAGING_SUPABASE_ANON_KEY;
const PROD_DOMAIN = 'tmjqzaakzhecbldebyeg.supabase.co';

if (!STAGING_URL || !STAGING_KEY) {
  console.error('ERROR: Define STAGING_SUPABASE_URL y STAGING_SUPABASE_ANON_KEY');
  process.exit(1);
}
if (STAGING_URL.includes(PROD_DOMAIN)) {
  console.error('CRÍTICO: STAGING_SUPABASE_URL apunta a producción. Abortando.');
  process.exit(1);
}

const USER_A_EMAIL = process.env.STAGING_USER_A_EMAIL;
const USER_A_PASS  = process.env.STAGING_USER_A_PASSWORD;
const USER_B_EMAIL = process.env.STAGING_USER_B_EMAIL;
const USER_B_PASS  = process.env.STAGING_USER_B_PASSWORD;

if (!USER_A_EMAIL || !USER_A_PASS || !USER_B_EMAIL || !USER_B_PASS) {
  console.error('ERROR: Define las cuatro variables STAGING_USER_*');
  process.exit(1);
}

// ── IDs del seed (08_seed_staging.sql) ───────────────────────
const CUENTA_A = '00000000-0000-0000-aaaa-000000000001';
const CUENTA_B = '00000000-0000-0000-bbbb-000000000002';

const CUR_A_01   = 'cur-a-01';
const ALU_A_01   = 'alu-a-01';
const ALU_A_02   = 'alu-a-02';
const CUOTA_A_01 = 'cuota-a-01';
const CUOTA_A_02 = 'cuota-a-02';
const PLAN_A_01  = 'plan-a-01';

// ── Códigos de error esperados de PostgREST / Supabase ───────
// Sin grant de tabla → PostgreSQL SQLSTATE 42501 (permission denied for table …)
// RLS WITH CHECK violation → PostgreSQL SQLSTATE 42501 (new row violates row-level security …)
// RLS USING (UPDATE/DELETE filtrado) → sin error HTTP, array vacío (0 filas afectadas)
// Otros errores (red, timeout, etc.) deben hacer fallar la prueba.
const PGERR_PERMISSION = '42501';

// Helper: verifica que error tiene exactamente code 42501, no solo que error !== null.
// Un error de red o de configuración diferente a 42501 también falla la prueba.
function esError42501(error) {
  return error !== null && error.code === PGERR_PERMISSION;
}
function detalle42501(error, dataOnNoError) {
  if (error === null) {
    return `ERROR: sin error HTTP — data=${JSON.stringify(dataOnNoError)} — se esperaba 42501`;
  }
  if (error.code !== PGERR_PERMISSION) {
    return `ERROR: código inesperado ${error.code} (esperado 42501): ${error.message}`;
  }
  return `(esperado) 42501: ${error.message}`;
}

// ── Utilidades ────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function ok(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n── ${title} ──`);
}

function clientFor(url, anonKey) {
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

async function signIn(client, email, password) {
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signIn(${email}) falló: ${error.message}`);
  if (!data?.user?.id) throw new Error(`signIn(${email}) no devolvió usuario`);
  return data.user;
}

// ── Pruebas ───────────────────────────────────────────────────

async function t00_conexion_no_produccion() {
  section('T00 — Verificación anti-producción');
  ok('URL de staging no es producción', !STAGING_URL.includes(PROD_DOMAIN));

  const anonClient = clientFor(STAGING_URL, STAGING_KEY);
  const { data, error } = await anonClient
    .from('tesorero_cuentas').select('id').limit(1);

  // Sin grant de tabla a anon, PostgREST devuelve 42501 (permission denied).
  // data=[] (sin error) indicaría un grant no deseado a anon — eso también falla.
  // Otros códigos de error (red, config) también fallan — no es el denegado esperado.
  ok('anon recibe error 42501 al acceder a tesorero_cuentas (sin grant)',
     esError42501(error),
     detalle42501(error, data));
}

async function t01_aislamiento_cuentas(clientA, clientB) {
  section('T01 — Aislamiento de cuentas');

  // Control positivo: A ve sus propios cursos
  const { data: cursosA, error: errA } = await clientA.from('cursos')
    .select('id, cuenta_id').eq('cuenta_id', CUENTA_A);
  ok('A puede leer cursos propios (control positivo)',
     errA === null && Array.isArray(cursosA),
     errA ? `error inesperado: ${errA.message}` : '');
  ok('A ve al menos un curso de Cuenta A',
     errA === null && cursosA.length > 0,
     `filas: ${cursosA?.length ?? 'N/A'}`);
  ok('A solo ve filas de Cuenta A',
     errA === null && cursosA.every(c => c.cuenta_id === CUENTA_A));

  // B no ve cursos de Cuenta A (RLS filtra → array vacío, sin error)
  const { data: cursosA_comoB, error: errAB } = await clientB.from('cursos')
    .select('id').eq('cuenta_id', CUENTA_A);
  ok('B no ve cursos de Cuenta A (RLS filtra)',
     errAB === null && Array.isArray(cursosA_comoB) && cursosA_comoB.length === 0,
     errAB ? `error: ${errAB.message}` : `filas obtenidas: ${cursosA_comoB?.length ?? 'N/A'}`);

  // B no ve alumnos de Cuenta A
  const { data: alumnosA_comoB, error: errAluAB } = await clientB.from('alumnos')
    .select('id').eq('cuenta_id', CUENTA_A);
  ok('B no ve alumnos de Cuenta A',
     errAluAB === null && Array.isArray(alumnosA_comoB) && alumnosA_comoB.length === 0,
     errAluAB ? `error: ${errAluAB.message}` : `filas: ${alumnosA_comoB?.length ?? 'N/A'}`);

  // A con rol tesorero en B: debe poder leer datos de B (acceso cruzado permitido)
  // Esto es una aserción, no informativo. Si falla, revisar la política RLS de cursos
  // para el rol 'tesorero' en usuarios_cuenta.
  const { data: cursosB_comoA, error: errBA } = await clientA.from('cursos')
    .select('id').eq('cuenta_id', CUENTA_B);
  ok('A (tesorero en B) puede leer cursos de Cuenta B sin error',
     errBA === null && Array.isArray(cursosB_comoA),
     errBA ? `error inesperado: ${errBA.code}: ${errBA.message}` : '');
  ok('A (tesorero en B) ve al menos un curso de Cuenta B',
     errBA === null && Array.isArray(cursosB_comoA) && cursosB_comoA.length > 0,
     `filas: ${cursosB_comoA?.length ?? 'N/A'} — verificar que uc-a-en-b tiene rol=tesorero en seed`);
}

async function t02_aislamiento_pagos(clientA, clientB) {
  section('T02 — Aislamiento de pagos');

  // Control positivo: A ve sus pagos
  const { data: pagosA, error: errPA } = await clientA.from('pagos')
    .select('id, cuenta_id').eq('cuenta_id', CUENTA_A);
  ok('A puede leer pagos propios (control positivo)',
     errPA === null && Array.isArray(pagosA),
     errPA ? `error: ${errPA.message}` : '');
  ok('A ve al menos un pago de Cuenta A',
     errPA === null && pagosA.length > 0);

  // B no ve pagos de Cuenta A
  const { data: pagosA_comoB, error: errPAB } = await clientB.from('pagos')
    .select('id').eq('cuenta_id', CUENTA_A);
  ok('B no ve pagos de Cuenta A',
     errPAB === null && Array.isArray(pagosA_comoB) && pagosA_comoB.length === 0,
     errPAB ? `error: ${errPAB.message}` : `filas: ${pagosA_comoB?.length ?? 'N/A'}`);

  // Control positivo: B ve sus propios pagos
  const { data: pagosB, error: errPB } = await clientB.from('pagos')
    .select('id, cuenta_id').eq('cuenta_id', CUENTA_B);
  ok('B puede leer pagos propios (control positivo)',
     errPB === null && Array.isArray(pagosB),
     errPB ? `error: ${errPB.message}` : '');
  ok('B ve al menos un pago de Cuenta B',
     errPB === null && pagosB.length > 0);
}

async function t03_insert_cruzado_bloqueado(clientA, clientB) {
  section('T03 — INSERT cruzado bloqueado por RLS (WITH CHECK)');

  // B intenta insertar un pago en Cuenta A.
  // Se incluye 'periodo' explícito para evitar que el índice único
  // (cuenta_id, alumno_id, cuota_id, COALESCE(periodo,'')) dispare antes que RLS
  // y enmascare el verdadero error de permisos con un 23505.
  const { error: injErr } = await clientB.from('pagos').insert({
    cuenta_id: CUENTA_A,
    id:        'pago-inject-test',
    alumno_id: ALU_A_01,
    cuota_id:  CUOTA_A_01,
    monto:     99999,
    fecha:     '2025-06-01',
    medio:     'inyeccion_prueba',
    estado:    'pagado',
    periodo:   'Inyeccion-Test-RLS'
  });

  // RLS WITH CHECK debe devolver exactamente 42501 al intentar INSERT en cuenta ajena.
  // Otro código de error (red, 23505, etc.) también falla — no es la denegación esperada.
  ok('B recibe error 42501 al insertar pago en Cuenta A (RLS WITH CHECK)',
     esError42501(injErr),
     detalle42501(injErr, null));

  // Confirmar con A que el registro no existe (independientemente del error de B)
  const { data: confData, error: confErr } = await clientA.from('pagos')
    .select('id').eq('cuenta_id', CUENTA_A).eq('id', 'pago-inject-test');
  ok('El pago inyectado no existe en Cuenta A (verificado con propietario)',
     confErr === null && Array.isArray(confData) && confData.length === 0,
     confErr ? `error al verificar: ${confErr.message}` : `filas encontradas: ${confData?.length ?? 'N/A'}`);
}

async function t04_insert_valido_propietario(clientA) {
  section('T04 — Control positivo: propietario puede insertar en su cuenta');

  // A inserta un pago válido en Cuenta A y lo lee después
  const idPrueba = 'pago-valido-test';
  const { error: insErr } = await clientA.from('pagos').insert({
    cuenta_id: CUENTA_A,
    id:        idPrueba,
    alumno_id: ALU_A_01,
    cuota_id:  CUOTA_A_01,
    monto:     500,
    fecha:     '2025-05-01',
    medio:     'efectivo',
    estado:    'pagado',
    periodo:   'Mayo 2025'
  });
  ok('A puede insertar pago en su propia cuenta (sin error)',
     insErr === null,
     insErr ? `${insErr.code}: ${insErr.message}` : '');

  // Verificar que el registro existe
  const { data: verif, error: verifErr } = await clientA.from('pagos')
    .select('id, monto').eq('cuenta_id', CUENTA_A).eq('id', idPrueba);
  ok('El pago insertado por A existe en la BD',
     verifErr === null && Array.isArray(verif) && verif.length === 1,
     verifErr ? `error al verificar: ${verifErr.message}` : `filas: ${verif?.length ?? 'N/A'}`);
  ok('El monto del pago insertado es correcto',
     verif && verif[0]?.monto === 500,
     `monto: ${verif?.[0]?.monto ?? 'N/A'}`);

  // Limpieza: eliminar el registro de prueba
  const { error: delErr } = await clientA.from('pagos')
    .delete().eq('cuenta_id', CUENTA_A).eq('id', idPrueba);
  if (delErr) {
    console.error(`  ⚠ Limpieza: no se pudo eliminar ${idPrueba}: ${delErr.code} ${delErr.message}`);
    console.error('    Eliminar manualmente antes de re-ejecutar el test.');
  }
}

async function t05_tablas_protegidas(clientA) {
  section('T05 — Tablas sin grant: PostgREST devuelve error real (no data=[])');
  // Distinción importante:
  //   error !== null  → sin grant de tabla (acceso denegado al nivel de PostgreSQL)
  //   data=[]         → grant concedido pero RLS filtra todas las filas
  // Estas tablas NO tienen grant a authenticated, por lo que se exige error !== null.
  // Si data=[] sin error, significa que se otorgó un grant no deseado.

  // suscripciones: sin grant a authenticated
  const { data: subs, error: subErr } = await clientA
    .from('suscripciones').select('cuenta_id');
  // Se exige exactamente 42501. data=[] sin error indicaría un grant no deseado.
  // Otro código de error (red, etc.) también falla — no es el 42501 esperado.
  ok('suscripciones: PostgREST devuelve error 42501 (sin grant a authenticated)',
     esError42501(subErr),
     detalle42501(subErr, subs));

  // alumnos_credenciales: sin grant a authenticated
  const { data: creds, error: credErr } = await clientA
    .from('alumnos_credenciales').select('alumno_id');
  ok('alumnos_credenciales: PostgREST devuelve error 42501 (sin grant a authenticated)',
     esError42501(credErr),
     detalle42501(credErr, creds));
}

async function t06_update_cruzado_bloqueado(clientB, clientA) {
  section('T06 — UPDATE cruzado bloqueado por RLS');

  // Leer el valor actual antes del intento (como A, propietario)
  const { data: antes, error: antesErr } = await clientA.from('alumnos')
    .select('apellidos').eq('cuenta_id', CUENTA_A).eq('id', ALU_A_01).single();
  ok('Puede leerse el valor actual de apellidos (pre-UPDATE)',
     antesErr === null && antes?.apellidos !== undefined,
     antesErr ? `error: ${antesErr.message}` : '');
  const apellidosAntes = antes?.apellidos ?? null;

  // B intenta modificar apellidos de un alumno de Cuenta A
  // RLS USING filtra la fila → UPDATE afecta 0 filas (sin error HTTP, pero sin efecto)
  const { data: updData, error: updErr } = await clientB.from('alumnos')
    .update({ apellidos: 'MODIFICADO_POR_B' })
    .eq('cuenta_id', CUENTA_A)
    .eq('id', ALU_A_01)
    .select('id, apellidos');  // .select() para detectar filas afectadas

  // RLS USING filtra la fila antes del UPDATE → 0 filas afectadas, SIN error HTTP.
  // Si hay un error (cualquier código), eso también falla — no es el comportamiento esperado.
  // La distinción es importante: un error 42501 aquí significaría que la política está
  // configurada incorrectamente (WITH CHECK en vez de USING), lo cual también es un fallo.
  ok('B no puede modificar alumno de Cuenta A (UPDATE sin error, 0 filas afectadas)',
     updErr === null && Array.isArray(updData) && updData.length === 0,
     updErr
       ? `ERROR inesperado: ${updErr.code}: ${updErr.message} (esperado: sin error + 0 filas)`
       : `filas afectadas: ${updData?.length ?? 'N/A'}`);

  // Verificar con A que el valor no cambió
  const { data: despues, error: despuesErr } = await clientA.from('alumnos')
    .select('apellidos').eq('cuenta_id', CUENTA_A).eq('id', ALU_A_01).single();
  ok('Apellidos de alu-a-01 conservan el valor original tras intento de B',
     despuesErr === null
       && despues?.apellidos !== 'MODIFICADO_POR_B'
       && (apellidosAntes === null || despues?.apellidos === apellidosAntes),
     despuesErr
       ? `error al verificar: ${despuesErr.message}`
       : `antes="${apellidosAntes}" → ahora="${despues?.apellidos}"`);
}

async function t07_abonos_aislados(clientA, clientB) {
  section('T07 — Abonos: aislamiento y consistencia del plan');

  // Control positivo: A ve sus abonos
  const { data: abonosA, error: errAbA } = await clientA.from('abonos')
    .select('id, cuenta_id, plan_id').eq('cuenta_id', CUENTA_A);
  ok('A puede leer abonos propios (control positivo)',
     errAbA === null && Array.isArray(abonosA),
     errAbA ? `error: ${errAbA.message}` : '');
  ok('A ve al menos un abono de Cuenta A',
     errAbA === null && abonosA.length > 0);
  ok('El abono referencia el plan correcto (plan-a-01)',
     errAbA === null && abonosA.some(a => a.plan_id === PLAN_A_01));

  // B no ve abonos de Cuenta A
  const { data: abonosA_comoB, error: errAbAB } = await clientB.from('abonos')
    .select('id').eq('cuenta_id', CUENTA_A);
  ok('B no ve abonos de Cuenta A',
     errAbAB === null && Array.isArray(abonosA_comoB) && abonosA_comoB.length === 0,
     errAbAB ? `error: ${errAbAB.message}` : `filas: ${abonosA_comoB?.length ?? 'N/A'}`);

  // B intenta insertar un abono en Cuenta A (WITH CHECK debe rechazarlo)
  // alumno_id y cuota_id son verificados por los triggers de consistencia
  const { error: abErr } = await clientB.from('abonos').insert({
    cuenta_id: CUENTA_A,
    id:        'abono-inject-test',
    plan_id:   PLAN_A_01,
    alumno_id: ALU_A_02,
    cuota_id:  CUOTA_A_02,
    monto:     1000,
    fecha:     '2025-06-01',
    estado:    'registrado'
  });

  // Se exige exactamente 42501. Otro código de error también falla.
  ok('B recibe error 42501 al insertar abono en Cuenta A (RLS WITH CHECK)',
     esError42501(abErr),
     detalle42501(abErr, null));

  // Verificar con A propietario que el abono inyectado NO existe
  // (un insert() sin .select() devuelve data=null incluso si fue exitoso;
  //  por eso siempre verificamos con el propietario)
  const { data: abVerif, error: abVerifErr } = await clientA.from('abonos')
    .select('id').eq('cuenta_id', CUENTA_A).eq('id', 'abono-inject-test');
  ok('El abono inyectado no existe en Cuenta A (verificado con propietario)',
     abVerifErr === null && Array.isArray(abVerif) && abVerif.length === 0,
     abVerifErr ? `error al verificar: ${abVerifErr.message}` : `filas encontradas: ${abVerif?.length ?? 'N/A'}`);
}

async function t08_lectura_propia_completa(clientA, userA) {
  section('T08 — A tiene acceso completo a sus propios datos');

  ok('A tiene sesión JWT activa', userA?.id !== undefined,
     userA?.id ? '' : 'sin user.id');

  // Verificar membresía (buscada por auth_id, no user_id)
  const { data: memb, error: membErr } = await clientA.from('usuarios_cuenta')
    .select('cuenta_id, rol, auth_id').eq('auth_id', userA.id);
  ok('A puede leer su membresía por auth_id',
     membErr === null && Array.isArray(memb),
     membErr ? `error: ${membErr.message}` : '');
  ok('A tiene membresía con rol admin en Cuenta A',
     membErr === null && memb.some(m => m.cuenta_id === CUENTA_A && m.rol === 'admin'));

  // Verificar acceso a las 8 tablas de negocio con datos en el seed
  const tablas = [
    { tabla: 'colegios',    label: 'colegios' },
    { tabla: 'cursos',      label: 'cursos' },
    { tabla: 'alumnos',     label: 'alumnos' },
    { tabla: 'apoderados',  label: 'apoderados' },
    { tabla: 'cuotas',      label: 'cuotas' },
    { tabla: 'pagos',       label: 'pagos' },
    { tabla: 'planes_pago', label: 'planes_pago' },
    { tabla: 'abonos',      label: 'abonos' },
  ];

  for (const { tabla, label } of tablas) {
    const { data, error } = await clientA.from(tabla)
      .select('id').eq('cuenta_id', CUENTA_A);
    ok(`A puede leer ${label} propios sin error`,
       error === null && Array.isArray(data),
       error ? `error: ${error.message}` : '');
    ok(`A ve al menos 1 fila en ${label}`,
       error === null && data.length > 0,
       `filas: ${data?.length ?? 'N/A'}`);
  }
}

// ── Runner principal ──────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('El Tesorero — Pruebas RLS con cliente JWT real (v9)');
  console.log('Proyecto staging:', STAGING_URL);
  console.log('═══════════════════════════════════════════════════');

  const t0 = Date.now();
  const clientA = clientFor(STAGING_URL, STAGING_KEY);
  const clientB = clientFor(STAGING_URL, STAGING_KEY);
  let userA, userB;

  try {
    await t00_conexion_no_produccion();

    console.log('\n── Autenticando usuarios ──');
    userA = await signIn(clientA, USER_A_EMAIL, USER_A_PASS);
    console.log(`  ✓ Usuario A autenticado: ${userA.email} (${userA.id})`);
    userB = await signIn(clientB, USER_B_EMAIL, USER_B_PASS);
    console.log(`  ✓ Usuario B autenticado: ${userB.email} (${userB.id})`);

    if (userA.id === userB.id) {
      console.error('ERROR: Usuario A y B tienen el mismo UUID. Verifica el seed.');
      process.exit(1);
    }

    await t01_aislamiento_cuentas(clientA, clientB);
    await t02_aislamiento_pagos(clientA, clientB);
    await t03_insert_cruzado_bloqueado(clientA, clientB);
    await t04_insert_valido_propietario(clientA);
    await t05_tablas_protegidas(clientA);
    await t06_update_cruzado_bloqueado(clientB, clientA);
    await t07_abonos_aislados(clientA, clientB);
    await t08_lectura_propia_completa(clientA, userA);

  } catch (err) {
    console.error('\nERROR inesperado:', err.message);
    console.error(err.stack);
    failed++;
  } finally {
    await clientA.auth.signOut().catch(() => {});
    await clientB.auth.signOut().catch(() => {});
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n═══════════════════════════════════════════════════');
  console.log(`Resultado: ${passed} OK / ${failed} FAIL — ${elapsed}s`);
  if (failed > 0) {
    console.error('PRUEBAS FALLIDAS: revisar antes de activar staging.');
    process.exit(1);
  } else {
    console.log('Todas las pruebas RLS pasaron.');
    process.exit(0);
  }
}

main();
