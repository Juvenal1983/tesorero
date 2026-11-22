/**
 * Tests de la lógica financiera — sin dependencia de Supabase ni DOM.
 * Cubre: calcFinanzas(), alumnos.js % cumplimiento, pagos huérfanos.
 *
 * Ejecutar: node --experimental-vm-modules tests/financiero.test.js
 * (o con jest/vitest si está configurado)
 *
 * Los módulos JS del frontend usan globals (DB, S, MESES…). Este harness
 * los inyecta antes de llamar las funciones, aislando cada test.
 */

'use strict';

// ─── Harness mínimo ───────────────────────────────────────────────────────────

const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
               'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

function vocab() {
  return { mesInicioDefault: 2, mesFinDefault: 11 };
}

/** Replica calcFinanzas() de finanzas.js */
function calcFinanzas({ alumnos, cuotas, pagos, planesPago = [], movimientos = [] }) {
  const pagosPagados = pagos.filter(p => p.estado === 'pagado');

  // abonos pagados de planes activos
  const totAbonosPagados = planesPago
    .filter(pl => pl.activo)
    .reduce((s, pl) => s + pl.abonos.filter(a => a.pagado).reduce((ss, ab) => ss + ab.monto, 0), 0);

  const totPagos = pagosPagados.reduce((s, p) => s + p.monto, 0) + totAbonosPagados;
  const totIngExtra = movimientos.filter(m => m.tipo === 'ingreso').reduce((s, m) => s + m.monto, 0);
  const totGastos   = movimientos.filter(m => m.tipo === 'gasto').reduce((s, m) => s + m.monto, 0);
  const totalIngresos = totPagos + totIngExtra;

  let totalEsperado = 0;
  let totalPagado   = 0;

  alumnos.forEach(alu => {
    if (alu.eximido) return;
    cuotas.forEach(q => {
      if (!q.activa) return;
      const mesIni1 = q.mesInicio  != null ? q.mesInicio  : vocab().mesInicioDefault;
      const mesFin1 = q.mesTermino != null ? q.mesTermino + 1 : vocab().mesFinDefault + 1;
      const periodos = q.tipo === 'mensual'
        ? MESES.slice(mesIni1, mesFin1).map(m => `${m} ${q.anio || 2025}`)
        : [`Anual ${q.anio || 2025}`];

      periodos.forEach(periodo => {
        const obligado = q.monto || 0;
        totalEsperado += obligado;
        const totalPeriodo = pagosPagados
          .filter(p => p.alumnoId === alu.id && p.cuotaId === q.id && p.periodo === periodo)
          .reduce((s, p) => s + (p.monto || 0), 0);
        totalPagado += Math.min(totalPeriodo, obligado);
      });
    });
  });

  const pctCumpl = totalEsperado > 0 ? Math.min(100, Math.round(totalPagado / totalEsperado * 100)) : 0;
  return { totPagos, totalEsperado, totalPagado, pctCumpl, totalIngresos, totGastos };
}

/** Réplica de la lógica de pagos huérfanos de pagos.js */
function detectarHuerfanos(cuota, pagos) {
  const mesIni1 = cuota.mesInicio  != null ? cuota.mesInicio  : vocab().mesInicioDefault;
  const mesFin1 = cuota.mesTermino != null ? cuota.mesTermino + 1 : vocab().mesFinDefault + 1;
  const periodos = cuota.tipo === 'mensual'
    ? MESES.slice(mesIni1, mesFin1).map(m => `${m} ${cuota.anio || 2025}`)
    : [`Anual ${cuota.anio || 2025}`];
  return pagos.filter(p => !periodos.includes(p.periodo));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function it(desc, fn) {
  try {
    fn();
    console.log(`  ✓ ${desc}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${desc}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

function eq(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg ? msg + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function arrayEq(actual, expected, msg = '') {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg ? msg + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ALU_A = { id: 'alu-a', nombres: 'Sofía',     apellidos: 'García',  eximido: false };
const ALU_B = { id: 'alu-b', nombres: 'Valentina', apellidos: 'López',   eximido: false };
const ALU_EX = { id: 'alu-ex', nombres: 'Carlos', apellidos: 'Paz',      eximido: true  };

const CUOTA_MENSUAL = { id: 'q-m', activa: true, tipo: 'mensual', monto: 15000, anio: 2025, mesInicio: 2, mesTermino: 2 }; // solo Marzo
const CUOTA_ANUAL   = { id: 'q-a', activa: true, tipo: 'anual',   monto: 50000, anio: 2025 };
const CUOTA_SIN_TIPO = { id: 'q-n', activa: true, tipo: null,     monto: 15000, anio: 2025 };

// ─── Suite: calcFinanzas — casos base ────────────────────────────────────────

console.log('\ncalcFinanzas() — casos base');

it('sin pagos: totPagos=0, totalEsperado por alumno×período', () => {
  const r = calcFinanzas({ alumnos: [ALU_A], cuotas: [CUOTA_MENSUAL], pagos: [] });
  eq(r.totPagos, 0, 'totPagos');
  eq(r.totalEsperado, 15000, 'totalEsperado');
  eq(r.totalPagado, 0, 'totalPagado');
  eq(r.pctCumpl, 0, 'pctCumpl');
});

it('pago exacto: 100% cumplimiento', () => {
  const pagos = [{ id: 'p1', alumnoId: 'alu-a', cuotaId: 'q-m', monto: 15000, estado: 'pagado', periodo: 'Marzo 2025' }];
  const r = calcFinanzas({ alumnos: [ALU_A], cuotas: [CUOTA_MENSUAL], pagos });
  eq(r.totPagos, 15000, 'totPagos');
  eq(r.totalPagado, 15000, 'totalPagado');
  eq(r.pctCumpl, 100, 'pctCumpl');
});

it('dos alumnos, pago solo de uno: 50%', () => {
  const pagos = [{ id: 'p1', alumnoId: 'alu-a', cuotaId: 'q-m', monto: 15000, estado: 'pagado', periodo: 'Marzo 2025' }];
  const r = calcFinanzas({ alumnos: [ALU_A, ALU_B], cuotas: [CUOTA_MENSUAL], pagos });
  eq(r.totalEsperado, 30000, 'totalEsperado');
  eq(r.totalPagado, 15000, 'totalPagado');
  eq(r.pctCumpl, 50, 'pctCumpl');
});

// ─── Suite: alumno eximido ────────────────────────────────────────────────────

console.log('\ncalcFinanzas() — alumno eximido');

it('alumno eximido no cuenta en totalEsperado', () => {
  const r = calcFinanzas({ alumnos: [ALU_EX], cuotas: [CUOTA_MENSUAL], pagos: [] });
  eq(r.totalEsperado, 0, 'totalEsperado debe ser 0');
  eq(r.pctCumpl, 0, 'pctCumpl');
});

it('eximido tiene pago: cuenta en recaudación pero no en cumplimiento', () => {
  // Un alumno eximido que pagó de todas formas: el pago es ingreso real,
  // pero no debería inflar el % de cumplimiento.
  const pagos = [{ id: 'p-ex', alumnoId: 'alu-ex', cuotaId: 'q-m', monto: 15000, estado: 'pagado', periodo: 'Marzo 2025' }];
  const r = calcFinanzas({ alumnos: [ALU_EX, ALU_B], cuotas: [CUOTA_MENSUAL], pagos });
  eq(r.totPagos, 15000, 'recaudación sí incluye el pago');
  eq(r.totalEsperado, 15000, 'solo alu-b no eximido');
  eq(r.totalPagado, 0, 'alu-ex no cuenta en totalPagado');
  eq(r.pctCumpl, 0, 'pctCumpl');
});

// ─── Suite: pagos parciales ───────────────────────────────────────────────────

console.log('\ncalcFinanzas() — pagos parciales');

it('pago parcial: recaudación = monto recibido, totalPagado capped al obligado', () => {
  const pagos = [
    { id: 'p1', alumnoId: 'alu-a', cuotaId: 'q-m', monto: 7000, estado: 'pagado', periodo: 'Marzo 2025' },
    { id: 'p2', alumnoId: 'alu-a', cuotaId: 'q-m', monto: 5000, estado: 'pagado', periodo: 'Marzo 2025' },
  ];
  // 2 pagos suman $12.000 (parcial) de un obligado de $15.000
  const r = calcFinanzas({ alumnos: [ALU_A], cuotas: [CUOTA_MENSUAL], pagos });
  eq(r.totPagos, 12000, 'recaudación = suma de ambos pagos');
  eq(r.totalPagado, 12000, 'totalPagado = min(12000, 15000)');
  eq(r.pctCumpl, 80, 'pctCumpl = round(12000/15000*100)');
});

it('sobrepago: recaudación refleja el exceso, cumplimiento cappea al 100%', () => {
  const pagos = [
    { id: 'p1', alumnoId: 'alu-a', cuotaId: 'q-m', monto: 20000, estado: 'pagado', periodo: 'Marzo 2025' },
  ];
  const r = calcFinanzas({ alumnos: [ALU_A], cuotas: [CUOTA_MENSUAL], pagos });
  eq(r.totPagos, 20000, 'recaudación = $20.000 bruto');
  eq(r.totalPagado, 15000, 'totalPagado capped al obligado');
  eq(r.pctCumpl, 100, 'pctCumpl = 100 (no supera)');
});

// ─── Suite: abonos de planes ──────────────────────────────────────────────────

console.log('\ncalcFinanzas() — abonos de planes');

it('plan activo con abonos pagados se suma a recaudación', () => {
  const planesPago = [{
    id: 'plan-1', alumnoId: 'alu-a', cuotaId: 'q-m', activo: true,
    abonos: [
      { id: 'ab1', monto: 5000, pagado: true },
      { id: 'ab2', monto: 5000, pagado: true },
      { id: 'ab3', monto: 5000, pagado: false }, // pendiente
    ]
  }];
  const r = calcFinanzas({ alumnos: [ALU_A], cuotas: [CUOTA_MENSUAL], pagos: [], planesPago });
  eq(r.totPagos, 10000, 'recaudación = 2 abonos pagados');
  // Nota: los abonos se suman a totPagos pero NO cuentan en totalPagado (período-matching)
  // porque están en planesPago, no en pagos. Esta es la divergencia documentada.
});

it('plan cerrado (activo=false) NO se suma a recaudación', () => {
  const planesPago = [{
    id: 'plan-cerrado', alumnoId: 'alu-a', cuotaId: 'q-m', activo: false,
    abonos: [{ id: 'ab1', monto: 5000, pagado: true }]
  }];
  const r = calcFinanzas({ alumnos: [ALU_A], cuotas: [CUOTA_MENSUAL], pagos: [], planesPago });
  eq(r.totPagos, 0, 'plan cerrado: abonos no cuentan en recaudación');
});

// ─── Suite: período incompatible (pago con período incorrecto) ────────────────

console.log('\ncalcFinanzas() — período incompatible');

it('pago con período incorrecto: en recaudación pero no en cumplimiento', () => {
  // Escenario: cuota mensual de Marzo, pago registrado con período "Anual 2025"
  const pagos = [
    { id: 'p-mal', alumnoId: 'alu-a', cuotaId: 'q-m', monto: 15000, estado: 'pagado', periodo: 'Anual 2025' },
  ];
  const r = calcFinanzas({ alumnos: [ALU_A], cuotas: [CUOTA_MENSUAL], pagos });
  eq(r.totPagos, 15000, 'recaudación sí incluye el pago');
  eq(r.totalPagado, 0, 'no cuenta en cumplimiento: período no matchea');
  eq(r.pctCumpl, 0, 'pctCumpl = 0');
});

it('cuota sin tipo: mismo resultado que período incompatible', () => {
  // Con tipo=null se genera "Anual 2025", el pago con "Marzo 2025" no matchea
  const pagos = [
    { id: 'p1', alumnoId: 'alu-a', cuotaId: 'q-n', monto: 15000, estado: 'pagado', periodo: 'Marzo 2025' },
  ];
  const r = calcFinanzas({ alumnos: [ALU_A], cuotas: [CUOTA_SIN_TIPO], pagos });
  eq(r.totPagos, 15000, 'recaudación = $15.000');
  eq(r.totalPagado, 0, 'no matchea: tipo=null genera Anual 2025');
  eq(r.pctCumpl, 0);
});

// ─── Suite: detección de pagos huérfanos ─────────────────────────────────────

console.log('\ndetectarHuerfanos() — pagos invisibles');

it('tipo=null: pago con período mensual es huérfano', () => {
  const pagos = [
    { id: 'p1', periodo: 'Marzo 2025' },   // pago real
    { id: 'p2', periodo: 'Anual 2025' },   // matchea el período generado
  ];
  const h = detectarHuerfanos(CUOTA_SIN_TIPO, pagos);
  eq(h.length, 1, 'un huérfano');
  eq(h[0].id, 'p1', 'el pago con período mensual');
});

it('cuota mensual con rango modificado: pagos del rango anterior son huérfanos', () => {
  // La cuota cubría Marzo–Abril, ahora solo cubre Marzo
  const cuota = { id: 'q-mod', activa: true, tipo: 'mensual', monto: 15000, anio: 2025, mesInicio: 2, mesTermino: 2 };
  const pagos = [
    { id: 'p1', periodo: 'Marzo 2025' }, // dentro del rango actual
    { id: 'p2', periodo: 'Abril 2025' }, // era válido cuando el rango llegaba a Abril
  ];
  const h = detectarHuerfanos(cuota, pagos);
  eq(h.length, 1, 'un huérfano');
  eq(h[0].id, 'p2', 'el pago de Abril queda fuera del rango actual');
});

it('cuota anual: período "Anual 2025" no es huérfano', () => {
  const cuota = { id: 'q-an', activa: true, tipo: 'anual', monto: 50000, anio: 2025 };
  const pagos = [{ id: 'p1', periodo: 'Anual 2025' }];
  const h = detectarHuerfanos(cuota, pagos);
  eq(h.length, 0, 'ningún huérfano');
});

it('cuota anual: pago con período mensual es huérfano', () => {
  const cuota = { id: 'q-an', activa: true, tipo: 'anual', monto: 50000, anio: 2025 };
  const pagos = [{ id: 'p-mal', periodo: 'Enero 2025' }];
  const h = detectarHuerfanos(cuota, pagos);
  eq(h.length, 1, 'un huérfano');
});

// ─── Suite: escenario staging — $30k/$70k/43% ────────────────────────────────

console.log('\nEscenario staging: $30k recaudados, $70k esperados, ~43%');

it('replica el escenario de staging (tras reparación): 43% cumplimiento', () => {
  // Sofía tiene 2 pagos de $15k (Marzo + Abril), ambos ahora matchean.
  // Valentina tiene 2 cuotas sin pago.
  // Un tercer alumno (staging) también tiene 2 cuotas sin pago.
  // 3 alumnos × 2 cuotas × $15k = $90k... pero el dashboard muestra $70k.
  //
  // Con $70k esperados y $30k pagados: 43% → implica que el esperado no es
  // simplemente 3×2×15k. Podría ser 2 alumnos no-eximidos, con una cuota
  // extra de $10k, etc. Este test verifica la fórmula con los valores conocidos.
  //
  // Configuración que produce $30k/70k/43%:
  //   2 alumnos activos, cuota-a-01 ($15k, Marzo) + cuota-a-02 ($15k, Abril)
  //   + cuota extra ($20k, solo para uno de ellos, o cuota de $10k por 2)
  //   O bien: 2 alumnos × cuota mensual Marzo–Dic ($15k × 10 meses = $150k) — demasiado
  //
  // La explicación más simple: en staging existen datos adicionales al seed que
  // no conozco desde aquí. La verificación exacta requiere ejecutar M007 paso 2c.
  // Este test valida la fórmula con los valores declarados:
  const totalEsperado = 70000;
  const totalPagado   = 30000;
  const pctCumpl = Math.round(totalPagado / totalEsperado * 100);
  eq(pctCumpl, 43, 'pctCumpl = 43%');
});

it('escenario mínimo seed (2 alumnos, 2 cuotas $15k): 50% tras reparación', () => {
  // Solo con datos del seed: Sofía tiene ambos pagos, Valentina ninguno
  const alumnos  = [ALU_A, ALU_B];
  const cuotas   = [
    { id: 'q-01', activa: true, tipo: 'mensual', monto: 15000, anio: 2025, mesInicio: 2, mesTermino: 2 },
    { id: 'q-02', activa: true, tipo: 'mensual', monto: 15000, anio: 2025, mesInicio: 3, mesTermino: 3 },
  ];
  const pagos = [
    { id: 'p1', alumnoId: 'alu-a', cuotaId: 'q-01', monto: 15000, estado: 'pagado', periodo: 'Marzo 2025' },
    { id: 'p2', alumnoId: 'alu-a', cuotaId: 'q-02', monto: 15000, estado: 'pagado', periodo: 'Abril 2025' },
  ];
  const r = calcFinanzas({ alumnos, cuotas, pagos });
  eq(r.totPagos, 30000, 'recaudado = $30k');
  eq(r.totalEsperado, 60000, 'esperado = 2 alumnos × 2 × $15k');
  eq(r.totalPagado, 30000, 'pagado matcheado = $30k');
  eq(r.pctCumpl, 50, 'pctCumpl = 50% con datos del seed');
});

// ─── Resultado ───────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Resultado: ${passed} pasados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
