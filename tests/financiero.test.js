/**
 * tests/financiero.test.js
 *
 * Tests de calcFinanzas() ejecutando la función REAL de finanzas.js mediante
 * vm.runInContext, igual que E7 con fondos.js. No réplicas de la lógica.
 *
 * Ejecutar: node tests/financiero.test.js
 *
 * Casos cubiertos:
 *   FIN.1  Sin pagos: totPagos=0, totalEsperado=0, pctCumpl=0
 *   FIN.2  Pago exacto: 100% cumplimiento
 *   FIN.3  Dos alumnos, uno paga: 50%
 *   FIN.4  Alumno eximido excluido de totalEsperado
 *   FIN.5  Eximido con pago: suma a recaudado, no a cumplimiento
 *   FIN.6  Pago parcial: recaudado < obligado → pct < 100
 *   FIN.7  Sobrepago: recaudado > obligado, cumplimiento capped al 100%
 *   FIN.8  Plan activo con abonos parciales: suman a recaudado Y cumplimiento
 *   FIN.9  Plan cerrado (V9): abonos suman a recaudado (no duplican; no hay pago)
 *   FIN.10 Plan cerrado (blob): pago creado, abonos no duplican recaudado
 *   FIN.11 Período incompatible: pago en recaudado, 0% cumplimiento
 *   FIN.12 Cuota sin tipo: genera Anual, pago mensual es huérfano en cumplimiento
 *   FIN.13 Rango modificado → pago del rango anterior en recaudado, 0% cumplimiento
 *   FIN.14 Escenario conocido: 2 alumnos × (mar $15k + abr $15k + anual $5k)
 *            → esperado $70k, pagado $30k, pct=43%
 *   FIN.15 Al revertir un abono, recaudado disminuye exactamente por su monto
 *
 * ⚠️  NUNCA ejecutar contra producción: tmjqzaakzhecbldebyeg.supabase.co
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const vm   = require('vm');

// ─── Harness ──────────────────────────────────────────────────────────────────

let pass = 0, fail = 0;
const failures = [];

function ok(label, detail = '') {
  pass++;
  console.log(`  ✅ ${label}`);
}
function ko(label, detail = '') {
  fail++;
  failures.push(label);
  console.error(`  ❌ ${label}${detail ? '\n     ' + detail : ''}`);
}
function eq(a, b, label, ctx = '') {
  if (a === b) ok(label); else ko(label, `${ctx}esperado=${b} real=${a}`);
}

// ─── Cargador vm (patrón E7) ──────────────────────────────────────────────────

/**
 * Carga calcFinanzas() y vocab() desde finanzas.js en un contexto vm aislado,
 * inyectando DB, S y los stubs mínimos necesarios para que el archivo cargue.
 *
 * @param {object} mockDB     — replica exacta de DB (cuotas, pagos, planesPago, movimientos, alumnos)
 * @param {object} mockS      — { cursoId }
 * @param {boolean} esV9      — simula V9_RELACIONAL (true por defecto = staging real)
 * @returns {{ calcFinanzas: Function }}
 */
function cargarCalculos(mockDB, mockS, esV9 = true) {
  const src = fs.readFileSync(
    path.resolve(__dirname, '..', 'js', 'core', 'finanzas.js'), 'utf8'
  );

  const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                 'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

  const ctx = vm.createContext({
    DB:              mockDB,
    S:               mockS,
    V9_RELACIONAL:   esV9,
    MESES,
    // vocab: mesInicioDefault=2 (Marzo), mesFinDefault=11 (Diciembre) — igual que app 'curso'
    vocab: () => ({ mesInicioDefault: 2, mesFinDefault: 11 }),
    // helpers de UI — no se usan en calcFinanzas, solo necesarios para que el archivo cargue
    clp:         v  => '$' + Math.round(v||0).toLocaleString('es-CL'),
    uid:         () => Date.now().toString(36) + Math.random().toString(36).slice(2,5),
    isoToday:    () => new Date().toISOString().slice(0,10),
    fmtDate:     () => '',
    escHtml:     s  => String(s||''),
    initials:    () => '?',
    getCurso:    () => ({}),
    getAlumnos:  () => (mockDB.alumnos||[]).filter(a => a.cursoId === mockS.cursoId && a.estado !== 'retirado'),
    getAlumnosAll: () => (mockDB.alumnos||[]).filter(a => a.cursoId === mockS.cursoId),
    getCuotas:   () => (mockDB.cuotas||[]).filter(q => q.cursoId === mockS.cursoId && q.activa),
    getPagos:    () => {
      const cuotasIds = new Set((mockDB.cuotas||[]).filter(q=>q.cursoId===mockS.cursoId).map(q=>q.id));
      return (mockDB.pagos||[]).filter(p => cuotasIds.has(p.cuotaId));
    },
    getMovs:     () => (mockDB.movimientos||[]).filter(m => m.cursoId === mockS.cursoId),
    // Stubs de UI
    go:              () => {},
    showToast:       () => {},
    document:        { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null },
    console,
  });

  vm.runInContext(src, ctx);
  return { calcFinanzas: ctx.calcFinanzas.bind(ctx) };
}

// ─── Fixtures base ────────────────────────────────────────────────────────────

const CRS = 'crs-fin-test';
const S   = { cursoId: CRS };

function alu(id, extra = {}) {
  return { id, cursoId: CRS, estado: 'activo', eximido: false, ...extra };
}
function cuota(id, tipo, monto, anio, extra = {}) {
  return { id, cursoId: CRS, activa: true, tipo, monto, anio, ...extra };
}
function pago(id, alumnoId, cuotaId, periodo, monto) {
  return { id, alumnoId, cuotaId, periodo, monto, estado: 'pagado' };
}
function plan(id, alumnoId, cuotaId, periodo, abonos, activo = true) {
  const montoTotal = abonos.reduce((s,a) => s + a.monto, 0);
  return { id, alumnoId, cuotaId, periodo, montoTotal, activo, creadoEn: '2025-01-01',
    abonos: abonos.map((a, i) => ({ id: `ab-${id}-${i}`, ...a })) };
}
function abono(monto, pagado) { return { monto, pagado, fecha: '2025-01-10', fechaPago: pagado ? '2025-01-15' : null }; }

// ─── Suite ────────────────────────────────────────────────────────────────────

console.log('\ncalcFinanzas() — función real via vm\n');

// FIN.1 — sin pagos
try {
  const DB = { alumnos: [alu('a1')], cuotas: [cuota('q1','mensual',15000,2025,{mesInicio:2,mesTermino:2})], pagos: [], planesPago: [], movimientos: [] };
  const { calcFinanzas } = cargarCalculos(DB, S);
  const r = calcFinanzas();
  eq(r.totPagos,      0,     'FIN.1 totPagos=0');
  eq(r.totalEsperado, 15000, 'FIN.1 totalEsperado=15000');
  eq(r.pctCumpl,      0,     'FIN.1 pctCumpl=0');
} catch(e) { ko('FIN.1', e.message); }

// FIN.2 — pago exacto: 100%
try {
  const DB = {
    alumnos: [alu('a1')],
    cuotas:  [cuota('q1','mensual',15000,2025,{mesInicio:2,mesTermino:2})],
    pagos:   [pago('p1','a1','q1','Marzo 2025',15000)],
    planesPago: [], movimientos: [],
  };
  const { calcFinanzas } = cargarCalculos(DB, S);
  const r = calcFinanzas();
  eq(r.totPagos,     15000, 'FIN.2 totPagos=15000');
  eq(r.totalPagado,  15000, 'FIN.2 totalPagado=15000');
  eq(r.pctCumpl,       100, 'FIN.2 pctCumpl=100');
} catch(e) { ko('FIN.2', e.message); }

// FIN.3 — dos alumnos, uno paga: 50%
try {
  const DB = {
    alumnos: [alu('a1'), alu('a2')],
    cuotas:  [cuota('q1','mensual',15000,2025,{mesInicio:2,mesTermino:2})],
    pagos:   [pago('p1','a1','q1','Marzo 2025',15000)],
    planesPago: [], movimientos: [],
  };
  const { calcFinanzas } = cargarCalculos(DB, S);
  const r = calcFinanzas();
  eq(r.totalEsperado, 30000, 'FIN.3 totalEsperado=30000');
  eq(r.totalPagado,   15000, 'FIN.3 totalPagado=15000');
  eq(r.pctCumpl,         50, 'FIN.3 pctCumpl=50');
} catch(e) { ko('FIN.3', e.message); }

// FIN.4 — eximido excluido de totalEsperado
try {
  const DB = {
    alumnos: [alu('a1', {eximido:true})],
    cuotas:  [cuota('q1','mensual',15000,2025,{mesInicio:2,mesTermino:2})],
    pagos:   [], planesPago: [], movimientos: [],
  };
  const { calcFinanzas } = cargarCalculos(DB, S);
  const r = calcFinanzas();
  eq(r.totalEsperado, 0, 'FIN.4 eximido: totalEsperado=0');
  eq(r.pctCumpl,      0, 'FIN.4 pctCumpl=0');
} catch(e) { ko('FIN.4', e.message); }

// FIN.5 — eximido con pago: recaudado sí, cumplimiento no
try {
  const DB = {
    alumnos: [alu('a-ex', {eximido:true}), alu('a2')],
    cuotas:  [cuota('q1','mensual',15000,2025,{mesInicio:2,mesTermino:2})],
    pagos:   [pago('p-ex','a-ex','q1','Marzo 2025',15000)],
    planesPago: [], movimientos: [],
  };
  const { calcFinanzas } = cargarCalculos(DB, S);
  const r = calcFinanzas();
  eq(r.totPagos,      15000, 'FIN.5 recaudado incluye pago del eximido');
  eq(r.totalEsperado, 15000, 'FIN.5 solo a2 no eximido');
  eq(r.totalPagado,       0, 'FIN.5 pago de eximido no cuenta en cumplimiento');
  eq(r.pctCumpl,          0, 'FIN.5 pctCumpl=0');
} catch(e) { ko('FIN.5', e.message); }

// FIN.6 — pago parcial: 80%
try {
  const DB = {
    alumnos: [alu('a1')],
    cuotas:  [cuota('q1','mensual',15000,2025,{mesInicio:2,mesTermino:2})],
    pagos:   [
      pago('p1','a1','q1','Marzo 2025',7000),
      pago('p2','a1','q1','Marzo 2025',5000),
    ],
    planesPago: [], movimientos: [],
  };
  const { calcFinanzas } = cargarCalculos(DB, S);
  const r = calcFinanzas();
  eq(r.totPagos,    12000, 'FIN.6 recaudado=$12000');
  eq(r.totalPagado, 12000, 'FIN.6 totalPagado=min(12000,15000)');
  eq(r.pctCumpl,       80, 'FIN.6 pctCumpl=80');
} catch(e) { ko('FIN.6', e.message); }

// FIN.7 — sobrepago: recaudado > obligado, cumplimiento capped
try {
  const DB = {
    alumnos: [alu('a1')],
    cuotas:  [cuota('q1','mensual',15000,2025,{mesInicio:2,mesTermino:2})],
    pagos:   [pago('p1','a1','q1','Marzo 2025',20000)],
    planesPago: [], movimientos: [],
  };
  const { calcFinanzas } = cargarCalculos(DB, S);
  const r = calcFinanzas();
  eq(r.totPagos,    20000, 'FIN.7 recaudado=$20000 (bruto)');
  eq(r.totalPagado, 15000, 'FIN.7 totalPagado capped al obligado');
  eq(r.pctCumpl,      100, 'FIN.7 pctCumpl=100 (no supera)');
} catch(e) { ko('FIN.7', e.message); }

// FIN.8 — plan activo con abonos: suman a recaudado Y a cumplimiento
try {
  const pl = plan('plan1','a1','q1','Marzo 2025',[abono(8000,true), abono(7000,false)]);
  const DB = {
    alumnos: [alu('a1')],
    cuotas:  [cuota('q1','mensual',15000,2025,{mesInicio:2,mesTermino:2})],
    pagos:   [],
    planesPago: [pl],
    movimientos: [],
  };
  const { calcFinanzas } = cargarCalculos(DB, S, true); // V9
  const r = calcFinanzas();
  eq(r.totPagos,     8000, 'FIN.8 recaudado=abono pagado ($8000)');
  eq(r.totalPagado,  8000, 'FIN.8 cumplimiento=min(8000,15000)');
  eq(r.pctCumpl,       53, 'FIN.8 pctCumpl=round(8000/15000*100)=53');
} catch(e) { ko('FIN.8', e.message); }

// FIN.9 — plan cerrado (V9): abonos suman a recaudado (plan cerrado NO creó pago)
try {
  const pl = plan('plan1','a1','q1','Marzo 2025',
    [abono(7500,true), abono(7500,true)], false /* activo=false */);
  const DB = {
    alumnos: [alu('a1')],
    cuotas:  [cuota('q1','mensual',15000,2025,{mesInicio:2,mesTermino:2})],
    pagos:   [], // en V9 no se crea pago al completar
    planesPago: [pl],
    movimientos: [],
  };
  const { calcFinanzas } = cargarCalculos(DB, S, true); // V9=true
  const r = calcFinanzas();
  eq(r.totPagos,    15000, 'FIN.9 V9 plan cerrado: recaudado=$15000');
  eq(r.totalPagado, 15000, 'FIN.9 V9 plan cerrado: cuenta en cumplimiento');
  eq(r.pctCumpl,      100, 'FIN.9 V9 plan cerrado: 100%');
} catch(e) { ko('FIN.9', e.message); }

// FIN.10 — plan cerrado (blob): pago ya creado → abonos NO duplican
try {
  const pl = plan('plan1','a1','q1','Marzo 2025',
    [abono(7500,true), abono(7500,true)], false /* activo=false */);
  const DB = {
    alumnos: [alu('a1')],
    cuotas:  [cuota('q1','mensual',15000,2025,{mesInicio:2,mesTermino:2})],
    pagos:   [pago('p-auto','a1','q1','Marzo 2025',15000)], // pago creado por blob al completar
    planesPago: [pl],
    movimientos: [],
  };
  const { calcFinanzas } = cargarCalculos(DB, S, false); // blob (V9=false)
  const r = calcFinanzas();
  // blob: plan cerrado → no suma abonos (plan.activo=false excluido)
  // recaudado = solo el pago directo
  eq(r.totPagos,    15000, 'FIN.10 blob plan cerrado: recaudado=$15000 (solo pago, sin duplicar)');
  eq(r.totalPagado, 15000, 'FIN.10 blob plan cerrado: cumplimiento OK');
  eq(r.pctCumpl,      100, 'FIN.10 blob plan cerrado: 100%');
} catch(e) { ko('FIN.10', e.message); }

// FIN.11 — período incompatible: pago en recaudado, 0% cumplimiento
try {
  const DB = {
    alumnos: [alu('a1')],
    cuotas:  [cuota('q1','mensual',15000,2025,{mesInicio:2,mesTermino:2})], // genera Marzo 2025
    pagos:   [pago('p-mal','a1','q1','Abril 2025',15000)], // período incorrecto
    planesPago: [], movimientos: [],
  };
  const { calcFinanzas } = cargarCalculos(DB, S);
  const r = calcFinanzas();
  eq(r.totPagos,    15000, 'FIN.11 pago mal período: sí en recaudado');
  eq(r.totalPagado,     0, 'FIN.11 pago mal período: no en cumplimiento');
  eq(r.pctCumpl,        0, 'FIN.11 pctCumpl=0');
} catch(e) { ko('FIN.11', e.message); }

// FIN.12 — cuota sin tipo: genera "Anual AAAA", pago mensual no matchea
try {
  const DB = {
    alumnos: [alu('a1')],
    cuotas:  [cuota('q1',null,15000,2025)], // tipo=null → genera "Anual 2025"
    pagos:   [pago('p1','a1','q1','Marzo 2025',15000)], // pago mensual no matchea
    planesPago: [], movimientos: [],
  };
  const { calcFinanzas } = cargarCalculos(DB, S);
  const r = calcFinanzas();
  eq(r.totPagos,    15000, 'FIN.12 tipo=null: recaudado OK');
  eq(r.totalPagado,     0, 'FIN.12 tipo=null: pago mensual no matchea Anual 2025');
  eq(r.pctCumpl,        0, 'FIN.12 pctCumpl=0');
} catch(e) { ko('FIN.12', e.message); }

// FIN.13 — rango modificado: pago del rango anterior no matchea período generado actual
try {
  const DB = {
    alumnos: [alu('a1')],
    cuotas:  [cuota('q1','mensual',15000,2025,{mesInicio:2,mesTermino:2})], // ahora solo Marzo
    pagos:   [
      pago('p1','a1','q1','Marzo 2025',15000),  // matchea
      pago('p2','a1','q1','Abril 2025',15000),   // era válido cuando el rango llegaba a Abril
    ],
    planesPago: [], movimientos: [],
  };
  const { calcFinanzas } = cargarCalculos(DB, S);
  const r = calcFinanzas();
  eq(r.totPagos,    30000, 'FIN.13 recaudado=$30000 (ambos pagos)');
  eq(r.totalPagado, 15000, 'FIN.13 solo Marzo matchea rango actual');
  eq(r.pctCumpl,      100, 'FIN.13 pctCumpl=100 (solo Marzo esperado)');
} catch(e) { ko('FIN.13', e.message); }

// FIN.14 — ESCENARIO CONOCIDO: 2 alumnos × (Marzo $15k + Abril $15k + anual $5k)
//          Sofía pagó Marzo y Abril. Valentina no pagó nada.
//          → esperado $70k, pagado $30k, cumplimiento 43%
try {
  const DB = {
    alumnos: [alu('sofia'), alu('valentina')],
    cuotas:  [
      cuota('q-mar', 'mensual', 15000, 2025, {mesInicio:2, mesTermino:2}), // Marzo 2025
      cuota('q-abr', 'mensual', 15000, 2025, {mesInicio:3, mesTermino:3}), // Abril 2025
      cuota('q-anu', 'anual',    5000, 2025),                              // Anual 2025
    ],
    pagos: [
      pago('p-s1', 'sofia', 'q-mar', 'Marzo 2025', 15000),
      pago('p-s2', 'sofia', 'q-abr', 'Abril 2025', 15000),
      // Sofia no pagó la anual. Valentina no pagó nada.
    ],
    planesPago: [], movimientos: [],
  };
  const { calcFinanzas } = cargarCalculos(DB, S);
  const r = calcFinanzas();
  const esperado70k = 2 * (15000 + 15000 + 5000); // 70000
  const pct43       = Math.round(30000 / 70000 * 100); // 43
  eq(r.totalEsperado, 70000, 'FIN.14 totalEsperado=$70000');
  eq(r.totPagos,      30000, 'FIN.14 totPagos=$30000');
  eq(r.totalPagado,   30000, 'FIN.14 totalPagado=$30000');
  eq(r.pctCumpl,         43, 'FIN.14 pctCumpl=43%');
} catch(e) { ko('FIN.14', e.message); }

// FIN.15 — Revertir abono: recaudado disminuye exactamente por su monto
try {
  // Plan con 3 abonos: 2 pagados, 1 no pagado → recaudado = $10000
  const pl = plan('plan1','a1','q1','Marzo 2025',[
    abono(5000, true),
    abono(5000, true),
    abono(5000, false),
  ]);

  const DB1 = {
    alumnos: [alu('a1')],
    cuotas:  [cuota('q1','mensual',15000,2025,{mesInicio:2,mesTermino:2})],
    pagos:   [], planesPago: [pl], movimientos: [],
  };
  const { calcFinanzas: cf1 } = cargarCalculos(DB1, S, true);
  const r1 = cf1();
  eq(r1.totPagos, 10000, 'FIN.15 antes de revertir: recaudado=$10000');

  // Simula reversión del segundo abono (pagado → false)
  pl.abonos[1].pagado = false;

  // Mismo plan — recargamos la función con el mismo DB (ya mutado)
  const { calcFinanzas: cf2 } = cargarCalculos(DB1, S, true);
  const r2 = cf2();
  eq(r2.totPagos,    5000, 'FIN.15 tras revertir abono: recaudado disminuyó exactamente $5000');
  eq(r2.totalPagado, 5000, 'FIN.15 cumplimiento también disminuye');
} catch(e) { ko('FIN.15', e.message); }

// ─── Resultado ────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
if (failures.length) {
  console.error('\nFallidos:');
  failures.forEach(f => console.error(`  • ${f}`));
}
console.log(`Resultado: ${pass} pasados, ${fail} fallidos\n`);
if (fail > 0) process.exit(1);
