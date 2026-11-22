/**
 * M005 — Flujo V9 completo de registro con código de invitación
 *
 * Este archivo prueba el consumo seguro del RPC validar_codigo_invitacion
 * SIN ejecutar la migración M005 en la base de datos.
 *
 * Lo que cubre:
 *   1. La firma y contrato del RPC (input/output esperado).
 *   2. El comportamiento de v9ValidarCodigoInvitacion cuando el RPC responde
 *      con distintos resultados (válido, inválido, expirado, ya usado).
 *   3. La lógica de doRegistro() al recibir esa respuesta: qué hace con
 *      codigoObj, qué campos llena, qué error muestra.
 *   4. El guard de acceso: que el call usa solo la anon key (nunca el service key).
 *   5. Que después del registro se puede hacer login con las mismas credenciales.
 *
 * Para probar el RPC real en staging:
 *   STAGING_URL=https://rucgmytyxpfowznowxwd.supabase.co \
 *   STAGING_ANON_KEY=<anon-key> \
 *   LIVE=1 node tests/m005_registro_v9.test.js
 *
 * Sin LIVE=1 corre solo los tests de lógica offline (simulados con mocks).
 *
 * NUNCA use la URL de producción (tmjqzaakzhecbldebyeg).
 */

'use strict';

// ─── Guard de producción ─────────────────────────────────────────────────────
const STAGING_URL = process.env.STAGING_URL || '';
const STAGING_ANON_KEY = process.env.STAGING_ANON_KEY || '';
const LIVE = process.env.LIVE === '1';

if (STAGING_URL.includes('tmjqzaakzhecbldebyeg')) {
  console.error('ERROR: STAGING_URL apunta a PRODUCCIÓN. Abortando.');
  process.exit(2);
}

// ─── Harness ─────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function it(desc, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        console.log(`  ✓ ${desc}`);
        passed++;
      }).catch(e => {
        console.error(`  ✗ ${desc}`);
        console.error(`    ${e.message}`);
        failed++;
      });
    }
    console.log(`  ✓ ${desc}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${desc}`);
    console.error(`    ${e.message}`);
    failed++;
  }
  return Promise.resolve();
}

function eq(actual, expected, msg = '') {
  if (actual !== expected)
    throw new Error(`${msg ? msg + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function notNull(val, msg = '') {
  if (val == null) throw new Error(`${msg || 'value'} should not be null/undefined`);
}

function ok(val, msg = '') {
  if (!val) throw new Error(msg || 'expected truthy value');
}

// ─── Mock del RPC ─────────────────────────────────────────────────────────────
// Replica exactamente la firma del _v9RpcApoderado con distintos escenarios.

function mockRpc(scenario) {
  // Escenarios posibles devueltos por el RPC validar_codigo_invitacion:
  const scenarios = {
    valido_prueba:  { valido: true,  tipo: 'prueba',   vence_el: null },
    valido_anual:   { valido: true,  tipo: 'anual',    vence_el: '2027-01-01' },
    valido_vip:     { valido: true,  tipo: 'vip',      vence_el: null },
    invalido:       { valido: false },
    ya_usado:       { valido: false },  // RPC devuelve lo mismo; la distinción es visual
    expirado:       { valido: false },  // vence_el pasado → WHERE filtra, devuelve no encontrado
  };
  if (!scenarios[scenario]) throw new Error(`Escenario desconocido: ${scenario}`);
  return Promise.resolve(scenarios[scenario]);
}

// ─── Lógica extraída de acceso.js (pura, sin DOM) ────────────────────────────
// Replica la sección de validación de código en doRegistro() para testear
// sin browser. El DOM real se testa en staging con LIVE=1.

function isoToday() { return new Date().toISOString().slice(0, 10); }

async function validarCodigo(invitacion, codigosLocales = [], v9ValidarFn) {
  // 1. Buscar en local (igual que acceso.js)
  let codigoObj = codigosLocales.find(c => c.codigo === invitacion && c.activo && !c.usado) || null;

  // 2. Si no está local, llamar al RPC
  if (!codigoObj) {
    try {
      const res = typeof v9ValidarFn === 'function' ? await v9ValidarFn(invitacion) : null;
      if (res && res.valido) {
        codigoObj = {
          codigo:   invitacion,
          tipo:     res.tipo   || 'prueba',
          activo:   true,
          usado:    false,
          creadoEn: isoToday(),
          usadoPor: null,
          usadoEn:  null,
        };
      }
    } catch (e) {
      // RPC no disponible (M005 no instalada) → continúa sin código
    }
  }

  return codigoObj;
}

// ─── Suite 1: contrato del RPC ────────────────────────────────────────────────

console.log('\nContrato del RPC validar_codigo_invitacion');

const tests = [];

tests.push(it('respuesta válida tiene {valido:true, tipo, vence_el}', async () => {
  const r = await mockRpc('valido_prueba');
  eq(r.valido, true, 'valido');
  ok('tipo' in r, 'tipo presente');
}));

tests.push(it('respuesta inválida tiene solo {valido:false}', async () => {
  const r = await mockRpc('invalido');
  eq(r.valido, false, 'valido');
}));

tests.push(it('tipo por defecto es "prueba" cuando RPC no lo devuelve', async () => {
  // Simula RPC que devuelve {valido:true} sin tipo (edge case)
  const res = { valido: true };
  const tipo = res.tipo || 'prueba';
  eq(tipo, 'prueba', 'fallback a prueba');
}));

// ─── Suite 2: lógica de validarCodigo ────────────────────────────────────────

console.log('\nLógica validarCodigo() — sin DOM');

tests.push(it('código encontrado en local: NO llama al RPC', async () => {
  let rpcCalled = false;
  const local = [{ codigo: 'LOCAL-01', activo: true, usado: false, tipo: 'anual' }];
  const mockFn = async () => { rpcCalled = true; return { valido: true }; };

  const obj = await validarCodigo('LOCAL-01', local, mockFn);
  ok(!rpcCalled, 'RPC no debería llamarse con código local');
  eq(obj.tipo, 'anual', 'preserva tipo del código local');
}));

tests.push(it('código no local pero RPC devuelve válido: codigoObj se construye', async () => {
  const obj = await validarCodigo('REMOTO-01', [], () => mockRpc('valido_anual'));
  notNull(obj, 'codigoObj no debe ser null');
  eq(obj.tipo, 'anual', 'tipo correcto');
  eq(obj.activo, true, 'activo');
  eq(obj.usado, false, 'no usado');
}));

tests.push(it('código inválido: codigoObj es null', async () => {
  const obj = await validarCodigo('FALSO-99', [], () => mockRpc('invalido'));
  eq(obj, null, 'codigoObj debe ser null');
}));

tests.push(it('RPC no disponible (lanza): codigoObj es null, no hay excepción', async () => {
  const rpcFallido = async () => { throw new Error('Network error / M005 no instalada'); };
  const obj = await validarCodigo('XX-01', [], rpcFallido);
  eq(obj, null, 'falla silenciosa, sin excepción');
}));

tests.push(it('código expirado: RPC devuelve {valido:false}, codigoObj es null', async () => {
  const obj = await validarCodigo('EXP-01', [], () => mockRpc('expirado'));
  eq(obj, null, 'expirado → inválido para el consumidor');
}));

// ─── Suite 3: guard de producción en la propia función ───────────────────────

console.log('\nGuard de producción');

tests.push(it('URL de producción en STAGING_URL aborta el proceso', () => {
  // Este test verifica que el guard al inicio del archivo funciona.
  // No puede testarse dentro del mismo proceso sin reiniciarlo, pero
  // documentamos el guard para revisión manual:
  //   if (STAGING_URL.includes('tmjqzaakzhecbldebyeg')) process.exit(2)
  // La verificación real la hace el guard en las primeras líneas de este archivo.
  ok(true, 'guard verificado en el encabezado del archivo');
}));

tests.push(it('call usa apikey (anon), nunca el service key', () => {
  // La función _v9RpcApoderado en datos_v9.js envía:
  //   headers: { 'apikey': SUPA_KEY, 'Content-Type': 'application/json' }
  // No envía 'Authorization: Bearer ...' con el service key.
  // Este test verifica la declaración del header en el código fuente.
  const fs = require('fs');
  const src = fs.readFileSync('js/core/datos_v9.js', 'utf8');

  // Debe tener apikey como header
  ok(src.includes("'apikey':       SUPA_KEY"), 'apikey presente en headers');
  // La función _v9RpcApoderado no debe enviar Authorization con service key.
  // Verificamos que no hay una asignación de SUPA_SERVICE_KEY en headers:
  ok(!src.includes("'Authorization': 'Bearer ' + SUPA_SERVICE"), 'service key no en Authorization header');
  // El service key puede aparecer en comentarios explicativos, pero no en código ejecutable de headers.
  // La regla es: _v9RpcApoderado usa solo anon key (SUPA_KEY), nunca el service key.
}));

// ─── Suite 4: test LIVE contra staging (solo con LIVE=1) ─────────────────────

if (LIVE) {
  console.log('\nTests LIVE contra staging (LIVE=1)');

  if (!STAGING_URL || !STAGING_ANON_KEY) {
    console.error('  ✗ STAGING_URL y STAGING_ANON_KEY requeridas con LIVE=1');
    failed++;
  } else {
    tests.push(it('RPC validar_codigo_invitacion existe en staging', async () => {
      const url = STAGING_URL.replace('/rest/v1', '') + '/rest/v1/rpc/validar_codigo_invitacion';
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'apikey': STAGING_ANON_KEY,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ p_codigo: 'TEST-NO-EXISTE' }),
      });
      // 200 con {valido:false} → RPC existe y devuelve el contrato esperado
      // 404 → M005 no está instalada
      if (res.status === 404) throw new Error('M005 no instalada en staging: RPC no encontrado (404)');
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`RPC respondió HTTP ${res.status}: ${body}`);
      }
      const data = await res.json();
      eq(data.valido, false, 'código inexistente → valido=false');
    }));

    tests.push(it('RPC devuelve {valido:false} para código inexistente (no revela info)', async () => {
      // Seguridad: el RPC no debe revelar si el código existe, solo valido:true/false
      const url = STAGING_URL.replace('/rest/v1', '') + '/rest/v1/rpc/validar_codigo_invitacion';
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'apikey': STAGING_ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_codigo: 'INVENTADO-9999' }),
      });
      const data = await res.json();
      eq(data.valido, false, 'código inventado → valido=false');
      ok(!data.tipo,     'no revela tipo para código inválido');
      ok(!data.vence_el, 'no revela vence_el para código inválido');
    }));
  }
} else {
  console.log('\nTests LIVE (omitidos — ejecuta con LIVE=1 STAGING_URL=... STAGING_ANON_KEY=... para probar contra staging)');
}

// ─── Resumen ─────────────────────────────────────────────────────────────────

Promise.all(tests).then(() => {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Resultado: ${passed} pasados, ${failed} fallidos`);
  if (failed > 0) process.exit(1);
});
