/**
 * tests/browser_test_staging_rest.js
 *
 * Ensayo REST de pagos idempotentes contra staging Supabase.
 * NO es un recorrido de interfaz de usuario ni usa Playwright.
 * Prueba la capa HTTP directa: login real → RPC insertar_pagos_lote →
 * idempotencia → edición → eliminación → rechazo de reintento post-eliminar.
 *
 * Requisitos de entorno (NUNCA pegar en el chat ni el repositorio):
 *   STAGING_SUPABASE_URL        — https://rucgmytyxpfowznowxwd.supabase.co
 *   STAGING_SUPABASE_ANON_KEY   — anon key del proyecto de staging
 *   STAGING_USER_A_EMAIL        — email del tesorero A
 *   STAGING_USER_A_PASSWORD     — contraseña del tesorero A
 *
 * El cuenta_id se descubre automáticamente tras el login (no hace falta en el .env).
 *
 * Ejecución con .env local:
 *   Windows CMD : for /f "usebackq tokens=1,* delims==" %A in (`type .env ^| findstr /v "^#"`) do set %A=%B
 *                 node tests/browser_test_staging_rest.js
 *   bash/zsh    : export $(grep -v '^#' .env | xargs) && node tests/browser_test_staging_rest.js
 *
 * NUNCA apuntar al proyecto de producción (tmjqzaakzhecbldebyeg).
 */

'use strict';

// ── Validar variables de entorno ──────────────────────────────────────────────
const REQUIRED_ENV = [
  'STAGING_SUPABASE_URL', 'STAGING_SUPABASE_ANON_KEY',
  'STAGING_USER_A_EMAIL', 'STAGING_USER_A_PASSWORD',
];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error('❌ Faltan variables de entorno:\n  ' + missing.join('\n  '));
  process.exit(1);
}

const SUPA_URL   = process.env.STAGING_SUPABASE_URL;
const ANON_KEY   = process.env.STAGING_SUPABASE_ANON_KEY;
const USER_EMAIL = process.env.STAGING_USER_A_EMAIL;
const USER_PASS  = process.env.STAGING_USER_A_PASSWORD;
// CUENTA_ID se descubre automáticamente en S01 consultando tesorero_cuentas
let   CUENTA_ID  = null;

// ── Guard: hostname exacto de staging ────────────────────────────────────────
const STAGING_HOSTNAME = 'rucgmytyxpfowznowxwd.supabase.co';
const PROD_HOSTNAME    = 'tmjqzaakzhecbldebyeg.supabase.co';

let parsedHost;
try { parsedHost = new URL(SUPA_URL).hostname; }
catch (_) { console.error('❌ STAGING_SUPABASE_URL no es una URL válida.'); process.exit(2); }

if (parsedHost === PROD_HOSTNAME) {
  console.error('❌ CRÍTICO: STAGING_SUPA_URL apunta a producción. Abortando.');
  process.exit(2);
}
if (parsedHost !== STAGING_HOSTNAME) {
  console.error(`❌ STAGING_SUPA_URL tiene hostname inesperado: ${parsedHost}`);
  console.error(`   Hostname autorizado: ${STAGING_HOSTNAME}`);
  process.exit(2);
}

const https = require('https');

// ── EXEC_ID delimita todos los fixtures de este run ───────────────────────────
const EXEC_ID  = Date.now().toString(36);
const CURSO_ID = `crs-stg-${EXEC_ID}`;
const ALU_ID   = `alu-stg-${EXEC_ID}`;
const CUOTA_ID = `cuo-stg-${EXEC_ID}`;
const IK_PRE   = `stg-${EXEC_ID}`;

// IDs de los 3 pagos originales que deben preservarse intactos
const PAGOS_ORIGINALES = ['p-1793328640658-66rix', 'pago-a-01', 'pago-b-01'];

let pass = 0, fail = 0;
const failures = [];

function ok(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else       { console.error(`  ❌ ${label}`); fail++; failures.push(label); }
}

// ── Helpers HTTP ──────────────────────────────────────────────────────────────

/**
 * Llama a la API de Supabase con la anon key como única credencial.
 * Usar solo para el endpoint de autenticación (no para operaciones con JWT).
 */
function supaFetchAnon(urlPath, opts = {}) {
  return _fetch(urlPath, {
    ...opts,
    authHeader: 'Bearer ' + ANON_KEY,
  });
}

/**
 * Llama a la API de Supabase autenticado como el tesorero (JWT real).
 * El proyecto se identifica con la anon key en apikey; la identidad
 * del usuario viene del JWT en Authorization.
 */
function supaFetchAuth(urlPath, jwt, opts = {}) {
  if (!jwt) throw new Error('supaFetchAuth: jwt requerido');
  return _fetch(urlPath, {
    ...opts,
    authHeader: 'Bearer ' + jwt,
  });
}

function _fetch(urlPath, opts) {
  return new Promise((resolve, reject) => {
    const url  = new URL(SUPA_URL + urlPath);
    const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const req  = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   opts.method || 'GET',
      headers: {
        'apikey':        ANON_KEY,
        'Authorization': opts.authHeader || ('Bearer ' + ANON_KEY),
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        'Prefer':        opts.prefer !== undefined ? opts.prefer : 'return=representation',
        ...(opts.headers || {}),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let body;
        try { body = JSON.parse(data); }
        catch (_) { body = data; }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Helpers de acceso a datos ─────────────────────────────────────────────────

async function loginTesorero() {
  const res = await supaFetchAnon('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body:   { email: USER_EMAIL, password: USER_PASS },
    prefer: '',
  });
  if (res.status !== 200 || !res.body?.access_token) {
    throw new Error(`Login falló (HTTP ${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body.access_token;
}

async function descubrirCuentaId(jwt) {
  // Consulta tesorero_cuentas para obtener el cuenta_id del usuario autenticado.
  // La columna auth_id vincula la cuenta con el usuario de Supabase Auth.
  const res = await supaFetchAuth('/rest/v1/tesorero_cuentas?select=id,auth_id&limit=5', jwt);
  if (res.status !== 200 || !Array.isArray(res.body) || res.body.length === 0) {
    throw new Error(`No se encontró cuenta en tesorero_cuentas (HTTP ${res.status}): ${JSON.stringify(res.body)}`);
  }
  // Si hay más de una cuenta, usar la primera (tesorero A es propietario de una sola)
  return res.body[0].id;
}

async function rpcInsertarLote(jwt, pagos) {
  return supaFetchAuth('/rest/v1/rpc/insertar_pagos_lote', jwt, {
    method: 'POST',
    body:   { p_cuenta_id: CUENTA_ID, p_pagos: pagos },
  });
}

async function queryPagosTest(jwt) {
  const res = await supaFetchAuth(
    `/rest/v1/pagos?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&alumno_id=eq.${encodeURIComponent(ALU_ID)}&select=id,monto,medio,estado,idempotency_key`,
    jwt
  );
  if (res.status !== 200) {
    throw new Error(`queryPagosTest: HTTP ${res.status} — ${JSON.stringify(res.body)}`);
  }
  return Array.isArray(res.body) ? res.body : [];
}

async function queryPagosOriginales(jwt) {
  const ids = PAGOS_ORIGINALES.map(id => `"${id}"`).join(',');
  const res = await supaFetchAuth(
    `/rest/v1/pagos?id=in.(${ids})&cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&select=id`,
    jwt
  );
  if (res.status !== 200) {
    throw new Error(`queryPagosOriginales: HTTP ${res.status} — ${JSON.stringify(res.body)}`);
  }
  return Array.isArray(res.body) ? res.body.map(p => p.id) : [];
}

// ── Crear fixtures con JWT del tesorero ───────────────────────────────────────
async function crearFixtures(jwt) {
  const anio = new Date().getFullYear();

  // Curso exclusivo (cursos_insert policy: es_dueno() — OK con JWT del propietario)
  const rCurso = await supaFetchAuth('/rest/v1/cursos', jwt, {
    method: 'POST',
    body: {
      cuenta_id: CUENTA_ID,
      id:        CURSO_ID,
      nombre:    `Test REST ${EXEC_ID}`,
      anio,
      activo:    true,
    },
  });
  if (rCurso.status !== 201) {
    throw new Error(`No pudo crear curso (HTTP ${rCurso.status}): ${JSON.stringify(rCurso.body)}`);
  }

  // Alumno exclusivo (alumnos_insert policy: es_dueno() o tiene_rol_en_curso)
  const rAlu = await supaFetchAuth('/rest/v1/alumnos', jwt, {
    method: 'POST',
    body: {
      cuenta_id: CUENTA_ID,
      id:        ALU_ID,
      curso_id:  CURSO_ID,
      nombres:   'Test',
      apellidos: `REST ${EXEC_ID}`,
      estado:    'activo',
      eximido:   false,
    },
  });
  if (rAlu.status !== 201) {
    throw new Error(`No pudo crear alumno (HTTP ${rAlu.status}): ${JSON.stringify(rAlu.body)}`);
  }

  // Cuota exclusiva extraordinaria (cuotas_insert policy: es_dueno())
  const rCuota = await supaFetchAuth('/rest/v1/cuotas', jwt, {
    method: 'POST',
    body: {
      cuenta_id: CUENTA_ID,
      id:        CUOTA_ID,
      curso_id:  CURSO_ID,
      nombre:    `Cuota REST ${EXEC_ID}`,
      tipo:      'extraordinaria',
      monto:     20000,
      anio,
      activa:    true,
    },
  });
  if (rCuota.status !== 201) {
    throw new Error(`No pudo crear cuota (HTTP ${rCuota.status}): ${JSON.stringify(rCuota.body)}`);
  }

  console.log(`  ✅ Fixtures creados: ${CURSO_ID} / ${ALU_ID} / ${CUOTA_ID}`);
}

// ── Limpiar fixtures en finally ───────────────────────────────────────────────
// Orden: pagos → cuotas → alumnos → cursos (FK restricciones)
// operaciones_pagos: RLS no permite REST con JWT → ver SQL admin al final.
async function limpiarFixtures(jwt) {
  const pasosCleaup = [
    {
      nombre: 'pagos de test',
      url:    `/rest/v1/pagos?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&alumno_id=eq.${encodeURIComponent(ALU_ID)}`,
      verUrl: `/rest/v1/pagos?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&alumno_id=eq.${encodeURIComponent(ALU_ID)}&select=id`,
    },
    {
      nombre: 'cuota de test',
      url:    `/rest/v1/cuotas?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&id=eq.${encodeURIComponent(CUOTA_ID)}`,
      verUrl: `/rest/v1/cuotas?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&id=eq.${encodeURIComponent(CUOTA_ID)}&select=id`,
    },
    {
      nombre: 'alumno de test',
      url:    `/rest/v1/alumnos?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&id=eq.${encodeURIComponent(ALU_ID)}`,
      verUrl: `/rest/v1/alumnos?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&id=eq.${encodeURIComponent(ALU_ID)}&select=id`,
    },
    {
      nombre: 'curso de test',
      url:    `/rest/v1/cursos?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&id=eq.${encodeURIComponent(CURSO_ID)}`,
      verUrl: `/rest/v1/cursos?cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}&id=eq.${encodeURIComponent(CURSO_ID)}&select=id`,
    },
  ];

  let cleanupOk = true;
  for (const paso of pasosCleaup) {
    const rDel = await supaFetchAuth(paso.url, jwt, {
      method: 'DELETE',
      prefer: 'return=minimal',
    });
    if (rDel.status !== 200 && rDel.status !== 204) {
      console.error(`  ⚠️  DELETE ${paso.nombre}: HTTP ${rDel.status} — ${JSON.stringify(rDel.body)}`);
      cleanupOk = false;
      continue;
    }
    // Verificar que el DELETE realmente eliminó las filas
    const rVer = await supaFetchAuth(paso.verUrl, jwt);
    if (rVer.status !== 200) {
      console.error(`  ⚠️  Verificación ${paso.nombre}: HTTP ${rVer.status}`);
      cleanupOk = false;
    } else if (Array.isArray(rVer.body) && rVer.body.length > 0) {
      console.error(`  ⚠️  ${paso.nombre}: ${rVer.body.length} fila(s) no eliminada(s)`);
      cleanupOk = false;
    } else {
      console.log(`  ✅ ${paso.nombre} eliminado`);
    }
  }

  if (!cleanupOk) {
    console.error('  ❌ Cleanup incompleto — revisar filas residuales en staging');
  }

  // operaciones_pagos: protegida por RLS (no hay política → solo service_role puede leerla/escribirla).
  // Entregar consulta SQL para ejecución manual con el SQL Editor de staging.
  console.log('\n  📋 SQL admin para limpiar operaciones_pagos (staging SQL Editor):');
  console.log(`  DELETE FROM operaciones_pagos`);
  console.log(`    WHERE cuenta_id = '${CUENTA_ID}'`);
  console.log(`      AND idempotency_key LIKE '${IK_PRE}%';`);
  console.log('\n  📋 SQL admin para verificar idempotency slots (staging SQL Editor):');
  console.log(`  SELECT idempotency_key, pago_id, auth_id, created_at`);
  console.log(`    FROM operaciones_pagos`);
  console.log(`   WHERE cuenta_id = '${CUENTA_ID}'`);
  console.log(`     AND idempotency_key LIKE '${IK_PRE}%'`);
  console.log(`   ORDER BY created_at;`);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n── Ensayo REST: pagos idempotentes en staging ──────────────────────────\n');
  console.log(`EXEC_ID  : ${EXEC_ID}`);
  console.log(`Staging  : ${SUPA_URL}`);
  console.log(`Cuenta A : ${CUENTA_ID}\n`);

  // ── S01: Login real del tesorero — PRIMERO que cualquier otra operación ──────
  console.log('[S01] Login del tesorero A');
  let jwt;
  try {
    jwt = await loginTesorero();
    ok('S01-a: login exitoso — JWT obtenido', typeof jwt === 'string' && jwt.length > 20);
    CUENTA_ID = await descubrirCuentaId(jwt);
    ok(`S01-b: cuenta_id descubierto (${CUENTA_ID})`, typeof CUENTA_ID === 'string' && CUENTA_ID.length > 10);
  } catch (e) {
    console.error('❌ Login o descubrimiento de cuenta falló:', e.message);
    process.exit(3);
  }

  try {
    // ── S02: Crear fixtures exclusivos con JWT del tesorero ───────────────────
    console.log('\n[S02] Crear fixtures exclusivos (JWT del tesorero)');
    try {
      await crearFixtures(jwt);
      ok('S02: fixtures creados en staging', true);
    } catch (e) {
      console.error('❌ Error creando fixtures:', e.message);
      ok('S02: fixtures creados en staging', false);
      return; // cleanup se ejecuta en finally
    }

    // ── S03: Primer pago parcial ($8.000 de $20.000) ──────────────────────────
    console.log('\n[S03] Pago parcial 1 — $8.000 de $20.000');
    const IK1   = `${IK_PRE}-p1`;
    const pago1 = {
      alumno_id:       ALU_ID,
      cuota_id:        CUOTA_ID,
      monto:           8000,
      fecha:           new Date().toISOString().slice(0, 10),
      medio:           'Transferencia',
      estado:          'pagado',
      periodo:         `Anual ${new Date().getFullYear()}`,
      idempotency_key: IK1,
    };
    const r3 = await rpcInsertarLote(jwt, [pago1]);
    ok('S03-a: HTTP 200',           r3.status === 200);
    ok('S03-b: retorna array',      Array.isArray(r3.body));
    ok('S03-c: 1 pago en respuesta', Array.isArray(r3.body) && r3.body.length === 1);
    const p1db = Array.isArray(r3.body) ? r3.body[0] : null;
    ok('S03-d: monto = 8000',       p1db?.monto === 8000);
    ok('S03-e: estado = pagado',    p1db?.estado === 'pagado');
    ok('S03-f: idempotency_key OK', !!p1db?.idempotency_key);
    const p1Id = p1db?.id ?? null;

    // ── S04: Reintento idempotente — mismo IK1, mismo payload ─────────────────
    console.log('\n[S04] Reintento idempotente del pago 1 (misma IK)');
    const r4 = await rpcInsertarLote(jwt, [pago1]);
    ok('S04-a: HTTP 200',              r4.status === 200);
    ok('S04-b: retorna mismo pago',    Array.isArray(r4.body) && r4.body.length === 1);
    ok('S04-c: mismo id que pago1',    Array.isArray(r4.body) && r4.body[0]?.id === p1Id);
    const pagos4 = await queryPagosTest(jwt);
    ok('S04-d: solo 1 pago en DB',     pagos4.length === 1);

    // ── S05: Segundo pago parcial ($12.000, completa la obligación) ───────────
    console.log('\n[S05] Pago parcial 2 — $12.000 (completa $20.000)');
    const IK2   = `${IK_PRE}-p2`;
    const pago2 = {
      alumno_id:       ALU_ID,
      cuota_id:        CUOTA_ID,
      monto:           12000,
      fecha:           new Date().toISOString().slice(0, 10),
      medio:           'Efectivo',
      estado:          'pagado',
      periodo:         `Anual ${new Date().getFullYear()}`,
      idempotency_key: IK2,
    };
    const r5 = await rpcInsertarLote(jwt, [pago2]);
    ok('S05-a: HTTP 200',           r5.status === 200);
    const p2db = Array.isArray(r5.body) ? r5.body[0] : null;
    ok('S05-b: monto = 12000',      p2db?.monto === 12000);
    const p2Id = p2db?.id ?? null;

    // ── S06: Verificar deuda $0 — pagos acumulables (B10) ─────────────────────
    console.log('\n[S06] Verificar 2 pagos acumulables y suma = $20.000');
    const pagos6  = await queryPagosTest(jwt);
    const sumado6 = pagos6.reduce((s, p) => s + (p.monto ?? 0), 0);
    ok('S06-a: 2 pagos en DB',          pagos6.length === 2);
    ok('S06-b: suma = 20000',           sumado6 === 20000);

    // ── S07: Slots de idempotencia — no consultable vía REST (RLS protege) ────
    console.log('\n[S07] operaciones_pagos protegida por RLS — verificación por comportamiento RPC');
    // La protección se demuestra indirectamente: el RPC respeta idempotencia (S04)
    // y rechaza reintentos post-eliminar (S11). Consulta directa requiere SQL admin.
    ok('S07: idempotencia demostrada por S04 (RPC no duplicó)', pagos4.length === 1);

    // ── S08: Recarga — reintento del lote completo ────────────────────────────
    console.log('\n[S08] Simular recarga: reintento de [pago1, pago2] completo');
    const r8 = await rpcInsertarLote(jwt, [pago1, pago2]);
    ok('S08-a: HTTP 200 (lote idempotente)', r8.status === 200);
    ok('S08-b: retorna 2 filas',             Array.isArray(r8.body) && r8.body.length === 2);
    const pagos8 = await queryPagosTest(jwt);
    ok('S08-c: sigue habiendo 2 pagos',      pagos8.length === 2);

    // ── S09: Editar pago 1 — cambiar medio de pago ────────────────────────────
    console.log('\n[S09] Editar pago 1: cambiar medio a "cheque"');
    if (p1Id) {
      const r9 = await supaFetchAuth(
        `/rest/v1/pagos?id=eq.${encodeURIComponent(p1Id)}&cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}`,
        jwt,
        { method: 'PATCH', body: { medio: 'cheque' } }
      );
      ok('S09-a: PATCH retorna 200',           r9.status === 200);
      const p1Upd = Array.isArray(r9.body) ? r9.body[0] : null;
      ok('S09-b: medio actualizado a "cheque"', p1Upd?.medio === 'cheque');
    } else {
      ok('S09: skip (p1Id nulo)', false);
    }

    // ── S10: Eliminar pago 2 ───────────────────────────────────────────────────
    console.log('\n[S10] Eliminar pago 2');
    if (p2Id) {
      const r10 = await supaFetchAuth(
        `/rest/v1/pagos?id=eq.${encodeURIComponent(p2Id)}&cuenta_id=eq.${encodeURIComponent(CUENTA_ID)}`,
        jwt,
        { method: 'DELETE' }
      );
      ok('S10-a: DELETE retorna 200/204',   r10.status === 200 || r10.status === 204);
      const pagos10 = await queryPagosTest(jwt);
      ok('S10-b: 1 pago en DB (pago2 eliminado)', pagos10.length === 1);
      ok('S10-c: pago restante = pago1',          pagos10[0]?.id === p1Id);
    } else {
      ok('S10: skip (p2Id nulo)', false);
    }

    // ── S11: Reintento de IK2 tras eliminar — el slot bloquea la recreación ───
    console.log('\n[S11] Reintento de IK2 tras eliminar: slot de idempotencia debe rechazar');
    const r11 = await rpcInsertarLote(jwt, [pago2]);
    // El RPC levanta RAISE EXCEPTION cuando el pago referenciado ya no existe.
    // PostgREST traduce eso a HTTP 400+.
    ok('S11-a: RPC rechaza reintento post-eliminar (HTTP 4xx)', r11.status >= 400);
    if (r11.status < 400) {
      console.error(`    Respuesta inesperada (${r11.status}): ${JSON.stringify(r11.body).slice(0, 200)}`);
    }

    // ── S12: Pagos originales intactos ────────────────────────────────────────
    console.log('\n[S12] Verificar pagos originales preservados');
    const originalesEncontrados = await queryPagosOriginales(jwt);
    for (const id of PAGOS_ORIGINALES) {
      ok(`S12: pago original ${id} intacto`, originalesEncontrados.includes(id));
    }

  } finally {
    console.log('\n[Cleanup] Eliminar fixtures de este run');
    if (jwt) {
      await limpiarFixtures(jwt);
    } else {
      console.error('  ⚠️  JWT no disponible; cleanup manual necesario');
      console.error(`  Buscar filas con alumno_id = '${ALU_ID}' en staging`);
    }
  }

  // ── Resultado final ───────────────────────────────────────────────────────
  console.log('\n────────────────────────────────────────────────────────────');
  console.log(`Total: ${pass + fail}  ✅ ${pass}  ❌ ${fail}`);
  if (fail === 0) {
    console.log('\n✅ Ensayo REST completo — idempotencia y flujo de pagos OK.');
  } else {
    console.log('\n❌ Fallos:');
    failures.forEach(f => console.error(`  - ${f}`));
  }
  process.exit(fail > 0 ? 1 : 0);
})().catch(async e => {
  console.error('\n❌ Error no capturado:', e.message);
  process.exit(5);
});
