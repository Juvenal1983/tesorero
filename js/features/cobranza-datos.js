// js/features/cobranza-datos.js — extraído de la copia de demostración.
function ordenarTablaFondos(campo){
  S.params.ordenFondos = campo;
  go(S.route, S.params);
}



// ─── COBRANZA ────────────────────────────────────────────────────────────────

function getPlantillasCobranza(){
  return DB.config?.plantillasCobranza || {
    suave: 'Hola {apoderado}, te escribimos para recordar que está pendiente la cuota del curso de {periodo} por un monto de {monto}. Si ya realizaste el pago, por favor ignorar este mensaje. Muchas gracias, {tesorero}.',
    directa: 'Hola {apoderado}, aún figura pendiente la cuota del curso de {periodo} por {monto}. Te agradeceríamos regularizarla a la brevedad. Gracias, {tesorero}.',
    comprobante: 'Hola {apoderado}, te recordamos la cuota pendiente de {periodo} por {monto}. Si ya pagaste, por favor envíanos el comprobante o ignora este mensaje. Gracias, {tesorero}.'
  };
}

function getCobranzaEstados(){
  return DB.config?.cobranzaEstados || {};
}

function setCobranzaEstado(alumnoId, estado, nota){
  if(!puedeEnviarCobranza()){ showToast('⛔ Sin permisos para actualizar estado de cobranza','#E24B4A'); return; }
  if(!DB.config) DB.config = {};
  if(!DB.config.cobranzaEstados) DB.config.cobranzaEstados = {};
  DB.config.cobranzaEstados[alumnoId] = {
    estado,
    ultimoContacto: isoToday(),
    nota: nota || '',
    historial: [
      ...(DB.config.cobranzaEstados[alumnoId]?.historial || []),
      { fecha: isoToday(), estado, nota: nota || '' }
    ]
  };
  saveDB();
}

function getDeudores(){
  const alumnos = getAlumnos();
  const cuotas  = getCuotas().filter(c=>c.activa);
  const pagos   = getPagos().filter(p=>p.estado==='pagado');
  const hoy     = new Date();
  const mesHoy  = hoy.getMonth(); // 0-based
  const anioHoy = hoy.getFullYear();
  const estados = getCobranzaEstados();

  const deudores = [];

  alumnos.forEach(alu=>{
    if(alu.eximido) return; // Eximidos no aparecen en cobranza
    let deudaTotal = 0;
    const periodosPendientes = [];

    cuotas.forEach(q=>{
      const mesIni = (q.mesInicio!==undefined&&q.mesInicio!==null) ? q.mesInicio : 2;
      const mesFin = (q.mesTermino!==undefined&&q.mesTermino!==null) ? q.mesTermino : 11;

      if(q.tipo==='mensual'){
        for(let m=mesIni; m<=Math.min(mesFin, mesHoy); m++){
          const periodo = MESES[m];
          const pagado = pagos.find(p=>p.alumnoId===alu.id && p.cuotaId===q.id && p.periodo===periodo);
          if(!pagado){
            deudaTotal += q.monto;
            periodosPendientes.push({ cuota:q.nombre, periodo, monto:q.monto });
          }
        }
      } else if(q.tipo==='anual'){
        const periodo = `Anual ${q.anio||anioHoy}`;
        if((q.anio||anioHoy) <= anioHoy){
          const pagado = pagos.find(p=>p.alumnoId===alu.id && p.cuotaId===q.id);
          if(!pagado){
            deudaTotal += q.monto;
            periodosPendientes.push({ cuota:q.nombre, periodo, monto:q.monto });
          }
        }
      } else if(q.tipo==='extraordinaria'){
        const periodo = q.nombre;
        const pagado = pagos.find(p=>p.alumnoId===alu.id && p.cuotaId===q.id);
        if(!pagado){
          deudaTotal += q.monto;
          periodosPendientes.push({ cuota:q.nombre, periodo, monto:q.monto });
        }
      }
    });

    // Agregar abonos vencidos de planes de pago activos
    const planesAlu = (DB.planesPago||[]).filter(p=>p.alumnoId===alu.id&&p.activo);
    planesAlu.forEach(plan=>{
      plan.abonos.forEach((ab,i)=>{
        if(!ab.pagado && ab.fecha < isoToday()){
          deudaTotal += ab.monto;
          periodosPendientes.push({ cuota:'Plan de pago', periodo:`Abono ${i+1} (${plan.periodo})`, monto:ab.monto });
        }
      });
    });

    if(deudaTotal > 0){
      const aps = (DB.apoderados||[]).filter(a=>a.alumnoId===alu.id && a.estado!=='inactivo');
      const apPrincipal = aps[0] || null;
      const estadoObj = estados[alu.id] || { estado:'pendiente', ultimoContacto:null };
      deudores.push({
        alu, aps, apPrincipal,
        deudaTotal, periodosPendientes,
        estado: estadoObj.estado || 'pendiente',
        ultimoContacto: estadoObj.ultimoContacto || null,
        historial: estadoObj.historial || []
      });
    }
  });

  return deudores.sort((a,b)=>b.deudaTotal-a.deudaTotal);
}

function generarMensajeCobranza(deudor, tipoPlantilla){
  const plantillas = getPlantillasCobranza();
  const plantilla = plantillas[tipoPlantilla] || plantillas.suave;
  const cur = getCurso();
  const tesorero = S.session?.nombre || cur?.tesorero || 'El Tesorero';
  const apNombre = deudor.apPrincipal?.nombre || deudor.alu.nombres + ' ' + deudor.alu.apellidos;
  const primerNombre = apNombre.split(' ')[0];
  const periodos = deudor.periodosPendientes.map(p=>p.periodo).join(', ');
  const monto = clp(deudor.deudaTotal);
  return plantilla
    .replace(/{apoderado}/g, primerNombre)
    .replace(/{periodo}/g, periodos)
    .replace(/{monto}/g, monto)
    .replace(/{tesorero}/g, tesorero)
    .replace(/{alumno}/g, deudor.alu.nombres + ' ' + deudor.alu.apellidos)
    .replace(/{curso}/g, cur?.nombre || '');
}

// ─────────────────────────────────────────────
// LIBRETA DE NOTAS
// ─────────────────────────────────────────────
