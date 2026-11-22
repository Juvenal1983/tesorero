// js/core/finanzas.js — extraído de la copia de demostración.
const clp = n => '$' + Math.round(n||0).toLocaleString('es-CL');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,5);
const isoToday = () => new Date().toISOString().slice(0,10);
const fmtDate = d => { if(!d) return '—'; const p=d.split('-'); return `${p[2]}/${p[1]}/${p[0]}`; };
const escHtml = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const initials = n => (n||'?').split(' ').slice(0,2).map(w=>w[0]).join('').toUpperCase();
const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

function getCurso(){ return DB.cursos.find(c=>c.id===S.cursoId)||{}; }
function getAlumnos(){ return (DB.alumnos||[]).filter(a=>a.cursoId===S.cursoId && a.estado!=='retirado'); }
function getAlumnosAll(){ return (DB.alumnos||[]).filter(a=>a.cursoId===S.cursoId); }
function getCuotas(){ return (DB.cuotas||[]).filter(q=>q.cursoId===S.cursoId&&q.activa); }
function getPagos(){ return (DB.pagos||[]).filter(p=>{ const q=(DB.cuotas||[]).find(x=>x.id===p.cuotaId); return q&&q.cursoId===S.cursoId; }); }
function getMovs(public_only=false){ const ms=(DB.movimientos||[]).filter(m=>m.cursoId===S.cursoId); return public_only?ms.filter(m=>m.visible):ms; }

/** Devuelve true solo si el usuario actual es el dueño original de la app
 *  (no fue creado mediante un código de invitación). */
// Correos que siempre tienen acceso de owner (administradores)
const OWNER_EMAILS = ['demo@example.invalid'];

function esOwner(){
  // Solo el usuario original puede generar códigos
  // Los usuarios invitados (prueba o VIP) NO pueden, aunque tengan plan activo
  if(!S.session) return false;

  // ── Rama V9 ──────────────────────────────────────────────────────────────
  // En V9_RELACIONAL, DB.usuarios no se puebla; usar S.session._v9 y esDelegado.
  // esDelegado se establece en arranque.js como !!esDelegado (siempre booleano):
  //   - cargarSesionV9: inicializa esDelegado=false; lo pone true solo si hay membresía.
  //   - arranque.js línea 51: esDelegado: !!esDelegado — nunca undefined.
  // RLS no se amplía: la tabla codigos_invitacion solo acepta INSERT/UPDATE/DELETE
  // del propietario; un delegado con esDelegado=true seguirá bloqueado en Supabase
  // aunque llegara aquí.
  if(S.session._v9) return S.session.esDelegado === false;

  // ── Rama legado ───────────────────────────────────────────────────────────
  const u = (DB.usuarios||[]).find(u=>u.id===S.session.id);
  if(!u) return false;
  // Correos de administrador siempre son owner
  if(OWNER_EMAILS.includes((u.email||'').toLowerCase())) return true;
  // El usuario u1 (cuenta original de la app) siempre es owner
  if(u.id==='u1') return true;
  // Cualquier usuario sin bandera invitado también es owner
  return !u.invitado;
}

function calcFinanzas(){
  const pagos = getPagos();
  const movs = getMovs();
  const cuotas = getCuotas();
  const alumnos = getAlumnos();

  const pagosPagados = pagos.filter(p=>p.estado==='pagado');

  // Planes del curso — activos Y cerrados.
  // Anti-duplicación: en modo blob (V9_RELACIONAL=false) un plan cerrado crea
  // automáticamente un pago en DB.pagos al completarse, por lo que sus abonos
  // ya están contabilizados en pagosPagados. Para evitar doble conteo, en ese
  // modo solo se suman los abonos de planes ACTIVOS (parcialmente pagados).
  // En modo V9 (V9_RELACIONAL=true) completar un plan NO crea un pago;
  // los abonos de planes cerrados son la única fuente de ese ingreso.
  const esV9 = typeof V9_RELACIONAL !== 'undefined' && V9_RELACIONAL;
  const planesDelCurso = (DB.planesPago||[]).filter(p=>{
    const q=(DB.cuotas||[]).find(x=>x.id===p.cuotaId);
    if(!q || q.cursoId!==S.cursoId) return false;
    return esV9 ? true : p.activo; // blob: solo activos; V9: todos
  });
  const totAbonosPagados = planesDelCurso.reduce((s,plan)=>
    s+plan.abonos.filter(a=>a.pagado).reduce((ss,ab)=>ss+ab.monto,0),0);
  const totPagos = pagosPagados.reduce((s,p)=>s+p.monto,0) + totAbonosPagados;
  const totIngExtra = movs.filter(m=>m.tipo==='ingreso').reduce((s,m)=>s+m.monto,0);
  const totGastos = movs.filter(m=>m.tipo==='gasto').reduce((s,m)=>s+m.monto,0);
  const totalIngresos = totPagos + totIngExtra;
  const saldo = totalIngresos - totGastos;

  // Calcular cumplimiento REAL considerando TODAS las cuotas (mensual, anual, extraordinaria)
  // Para cada alumno, sumar el monto total esperado y el monto efectivamente pagado
  let totalEsperado = 0;
  let totalPagado = 0;

  alumnos.forEach(alu => {
    if(alu.eximido) return; // Eximidos no cuentan en el total esperado
    cuotas.forEach(q => {
      if(!q.activa) return;
      // Períodos esperados según tipo de cuota
      const mesIni1 = (q.mesInicio !== undefined && q.mesInicio !== null) ? q.mesInicio : vocab().mesInicioDefault;
      const mesFin1 = (q.mesTermino !== undefined && q.mesTermino !== null) ? q.mesTermino + 1 : vocab().mesFinDefault + 1;
      // B1-fix: formato "Mes AAAA" usando cuota.anio como fuente autoritativa
      const periodos = q.tipo==='mensual'
        ? MESES.slice(mesIni1, mesFin1).map(m => `${m} ${q.anio||new Date().getFullYear()}`)
        : [`Anual ${q.anio||2026}`];
      periodos.forEach(periodo => {
        const obligado = (q.monto||0);
        totalEsperado += obligado;
        // B10-fix: usar filter+reduce para sumar TODOS los pagos del período
        // (antes: find() solo tomaba el primero; con pagos acumulables puede haber varios)
        // Pagos directos para este período
        const directos = pagosPagados
          .filter(p => p.alumnoId===alu.id && p.cuotaId===q.id && p.periodo===periodo)
          .reduce((s, p) => s + (p.monto||0), 0);
        // Abonos de plan de pago para este período.
        // Anti-duplicación: en blob, los planes cerrados ya generaron un pago directo;
        // solo se suman abonos de planes activos (pagos parciales sin pago final aún).
        // En V9, todos los planes (activo o cerrado) aportan sus abonos pagados.
        const plan = (DB.planesPago||[]).find(p=>
          p.alumnoId===alu.id && p.cuotaId===q.id && p.periodo===periodo
          && (esV9 ? true : p.activo)
        );
        const abonosPlan = plan
          ? plan.abonos.filter(a=>a.pagado).reduce((s,a)=>s+(a.monto||0),0)
          : 0;
        const totalPeriodo = directos + abonosPlan;
        // F-EXC-fix: limitar al obligado para que excedentes no inflen pctCumpl.
        // totPagos (ingresos brutos) ya recoge el excedente real;
        // totalPagado solo mide cumplimiento de la obligación.
        totalPagado += Math.min(totalPeriodo, obligado);
      });
    });
  });

  const pctCumpl = totalEsperado>0 ? Math.min(100, Math.round(totalPagado/totalEsperado*100)) : 0;

  // Desglose por tipo de cuota para gráfico
  const pagadoMensual = pagosPagados.filter(p=>{ const q=cuotas.find(x=>x.id===p.cuotaId); return q&&q.tipo==='mensual'; }).reduce((s,p)=>s+p.monto,0);
  const pagadoAnual   = pagosPagados.filter(p=>{ const q=cuotas.find(x=>x.id===p.cuotaId); return q&&q.tipo==='anual'; }).reduce((s,p)=>s+p.monto,0);
  const pagadoExtra   = pagosPagados.filter(p=>{ const q=cuotas.find(x=>x.id===p.cuotaId); return q&&q.tipo==='extraordinaria'; }).reduce((s,p)=>s+p.monto,0);

  const saldoTotal = totPagos + totIngExtra - totGastos;

  return {
    totPagos, totIngExtra, totGastos, totalIngresos, saldo,
    totActividades:0, saldoTotal,
    pctCumpl, alumnos:alumnos.length,
    totalEsperado, totalPagado,
    pagadoMensual, pagadoAnual, pagadoExtra
  };
}

// ─────────────────────────────────────────────
// ROUTER
// ─────────────────────────────────────────────
