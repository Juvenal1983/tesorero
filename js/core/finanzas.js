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
  // Sumar abonos pagados de planes activos
  const planesActivos = (DB.planesPago||[]).filter(p=>{
    const q=(DB.cuotas||[]).find(x=>x.id===p.cuotaId);
    return q&&q.cursoId===S.cursoId&&p.activo;
  });
  const totAbonosPagados = planesActivos.reduce((s,plan)=>
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
      const periodos = q.tipo==='mensual' ? MESES.slice(mesIni1, mesFin1) : [`Anual ${q.anio||2026}`];
      periodos.forEach(periodo => {
        totalEsperado += (q.monto||0);
        // Buscar si existe pago para este alumno, cuota y período
        const pago = pagosPagados.find(p=>p.alumnoId===alu.id && p.cuotaId===q.id && p.periodo===periodo);
        if(pago) totalPagado += (pago.monto||0);
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
