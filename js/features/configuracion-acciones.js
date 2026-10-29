// js/features/configuracion-acciones.js — extraído de la copia de demostración.
function saveDatosBancarios(){
  const ci = (DB.cursos||[]).findIndex(c=>c.id===S.cursoId);
  if(ci<0) return;
  DB.cursos[ci].banco = {
    nombre: document.getElementById('banco-nombre').value.trim(),
    rut:    document.getElementById('banco-rut').value.trim(),
    banco:  document.getElementById('banco-banco').value.trim(),
    tipo:   document.getElementById('banco-tipo').value,
    cuenta: document.getElementById('banco-cuenta').value.trim(),
    email:  document.getElementById('banco-email').value.trim()
  };
  saveDB();
  const msg = document.getElementById('banco-msg');
  msg.innerHTML = '<div class="alert ag">✅ Datos bancarios guardados correctamente.</div>';
  msg.style.display='';
  setTimeout(()=>{ msg.style.display='none'; }, 3000);
}

function recordatorioMasivo(){
  const cur = getCurso();
  if(!cur){ alert('No hay curso activo.'); return; }
  const appUrl = getAppUrl();
  if(!appUrl){ alert('Configura la URL de la app primero en Configuración.'); return; }
  const alumnos = (DB.alumnos||[]).filter(a=>a.cursoId===S.cursoId && a.estado!=='retirado');
  const cuotas  = (DB.cuotas||[]).filter(c=>c.cursoId===S.cursoId && c.activa);
  const pagos   = DB.pagos||[];
  
  let enviados = 0;
  let sinTelefono = [];
  
  for(const alu of alumnos){
    // Calcular deuda
    const pagosAlu = pagos.filter(p=>{
      const cuota = cuotas.find(c=>c.id===p.cuotaId);
      return cuota && p.alumnoId===alu.id && p.estado!=='anulado';
    });
    const montosPagados = pagosAlu.reduce((s,p)=>s+(p.montoPagado||0),0);
    const totalCuotas = cuotas.reduce((s,c)=>s+(c.monto||0),0);
    const deuda = totalCuotas - montosPagados;
    if(deuda <= 0) continue; // Al día, no enviar
    
    // Buscar apoderado con teléfono
    const aps = (DB.apoderados||[]).filter(a=>a.alumnoId===alu.id && a.telefono);
    if(!aps.length){ sinTelefono.push(alu.nombres+' '+alu.apellidos); continue; }
    
    const ap = aps[0];
    const tel = ap.telefono.replace(/\D/g,'');
    const num = tel.startsWith('56') ? tel : '56'+tel;
    const nombre = alu.nombres+' '+alu.apellidos;
    const col = (DB.colegios||[]).find(c=>c.id===cur.colegioId);
    
    const bancoDatos = cur.banco && cur.banco.nombre ?
      '💳 *Datos para transferencia:*\n• Nombre: ' + cur.banco.nombre +
      '\n• RUT: ' + cur.banco.rut +
      '\n• Banco: ' + cur.banco.banco +
      '\n• Tipo: ' + cur.banco.tipo +
      '\n• Cuenta: ' + cur.banco.cuenta +
      (cur.banco.email ? '\n• Enviar comprobante a: ' + cur.banco.email : '') + '\n\n' : '';
    const msg = 'Hola ' + (ap.nombre||'apoderado/a') + ' \uD83D\uDC4B\n\n' +
      'Le recordamos que existe una cuota pendiente de pago de *' + nombre + '* en el curso *' + (cur.nombre||'') + '*.\n\n' +
      '\uD83D\uDCB0 *Monto pendiente: $' + Math.round(deuda).toLocaleString('es-CL') + ' CLP*\n\n' +
      '\uD83D\uDCF1 Para ver el detalle, ingresa a la app:\n' + appUrl + '\n\n' +
      '🔑 Código del curso: *『 ' + (cur.codigo||'') + ' 』*\n\n' +
      bancoDatos +
      '— ' + (cur.tesorero||'Tesorero/a') + ' · *Tesorera de curso*\n' +
      '📚 ' + (cur.nombre||'') + '\n' +
      (col?'🏫 '+col.nombre:'');
    
    window.open('https://wa.me/'+num+'?text='+encodeURIComponent(msg), '_blank', 'noopener');
    enviados++;
  }
  
  let resumen = enviados > 0 ? `✅ Se abrió WhatsApp para ${enviados} apoderado(s) con cuotas pendientes.` : '✅ No hay alumnos con deuda pendiente.';
  if(sinTelefono.length) resumen += '\n\n⚠️ Sin teléfono registrado:\n• ' + sinTelefono.join('\n• ');
  alert(resumen);
}

function generarResumenAnualPDF(){
  const cur = getCurso();
  if(!cur){ alert('No hay curso activo.'); return; }
  const col = (DB.colegios||[]).find(c=>c.id===cur.colegioId);
  const alumnos = getAlumnos();
  const cuotas  = getCuotas();
  const pagos   = getPagos().filter(p=>p.estado==='pagado');
  const movs    = getMovs();
  const F       = calcFinanzas();
  const hoy     = new Date().toLocaleDateString('es-CL');

  // Tabla de alumnos — misma lógica que calcFinanzas
  const filasAlumnos = alumnos.map(a=>{
    let pagado = 0;
    let esperado = 0;
    let deudaDetalle = [];
    cuotas.forEach(q=>{
      if(!q.activa) return;
      const mesIni = (q.mesInicio!==undefined&&q.mesInicio!==null)?q.mesInicio:2;
      const mesFin = (q.mesTermino!==undefined&&q.mesTermino!==null)?q.mesTermino+1:12;
      const periodos = q.tipo==='mensual' ? MESES.slice(mesIni, mesFin) : [`Anual ${q.anio||cur.anio||2026}`];
      periodos.forEach(periodo=>{
        esperado += q.monto;
        const pago = pagos.find(p=>p.alumnoId===a.id && p.cuotaId===q.id && p.periodo===periodo);
        if(pago){ pagado += pago.monto; }
        else { deudaDetalle.push(periodo); }
      });
    });
    const deuda = Math.max(0, esperado - pagado);
    const pct   = esperado>0 ? Math.round(pagado/esperado*100) : 100;
    const estado = deuda<=0
      ? '<td style="color:#0F6E56;font-weight:700">✓ Al día</td>'
      : '<td style="color:#E24B4A;font-weight:700">Debe $'+Math.round(deuda).toLocaleString('es-CL')+'</td>';
    return '<tr><td>'+escHtml(a.apellidos+', '+a.nombres)+'</td>'
      +'<td>$'+Math.round(pagado).toLocaleString('es-CL')+'</td>'
      +'<td>$'+Math.round(esperado).toLocaleString('es-CL')+'</td>'
      +'<td>'+pct+'%</td>'
      +estado+'</tr>';
  }).join('');

  // Tabla de movimientos
  const filasMovs = movs.map(m=>'<tr><td>'+escHtml(fmtDate(m.fecha))+'</td><td>'+escHtml(m.desc||m.descripcion||'')+'</td><td style="color:'+(m.tipo==='ingreso'?'#0F6E56':'#E24B4A')+'">'+(m.tipo==='ingreso'?'+':'-')+'$'+Math.round(m.monto||0).toLocaleString('es-CL')+'</td></tr>').join('');

  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
  <title>Resumen Anual ${cur.anio||''} — ${cur.nombre||''}</title>
  <style>
    body{font-family:Arial,sans-serif;color:#222;margin:0;padding:24px;font-size:13px}
    h1{color:#0F6E56;font-size:20px;margin-bottom:4px}
    h2{color:#0F6E56;font-size:15px;margin:20px 0 8px;border-bottom:2px solid #E1F5EE;padding-bottom:4px}
    .sub{color:#666;font-size:12px;margin-bottom:20px}
    .metricas{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
    .metrica{background:#E1F5EE;border-radius:8px;padding:12px;text-align:center}
    .metrica .val{font-size:18px;font-weight:900;color:#0F6E56}
    .metrica .lbl{font-size:11px;color:#555;margin-top:2px}
    table{width:100%;border-collapse:collapse;margin-bottom:16px;font-size:12px}
    th{background:#0F6E56;color:#fff;padding:7px 10px;text-align:left}
    td{padding:6px 10px;border-bottom:1px solid #eee}
    tr:nth-child(even) td{background:#f9f9f9}
    .footer{margin-top:30px;font-size:11px;color:#999;text-align:center;border-top:1px solid #eee;padding-top:12px}
    @media print{body{padding:0}}
  </style></head><body>
  <h1>💰 Tesorero — Resumen Anual ${cur.anio||''}</h1>
  <div class="sub">${escHtml(col?.nombre||'')} · ${escHtml(cur.nombre||'')} · Generado el ${hoy}</div>
  <div class="metricas">
    <div class="metrica"><div class="val">$${Math.round(F.totPagos+F.totIngExtra).toLocaleString('es-CL')}</div><div class="lbl">💳 Cuotas + extras</div></div>
    <div class="metrica"><div class="val">$${Math.round(F.totActividades||0).toLocaleString('es-CL')}</div><div class="lbl">🎪 Actividades</div></div>
    <div class="metrica"><div class="val">$${Math.round(F.totGastos).toLocaleString('es-CL')}</div><div class="lbl">💸 Total gastos</div></div>
    <div class="metrica" style="background:${F.saldoTotal>=0?'#E1F5EE':'#FCEBEB'}"><div class="val" style="color:${F.saldoTotal>=0?'#0F6E56':'#E24B4A'}">$${Math.round(Math.abs(F.saldoTotal)).toLocaleString('es-CL')}</div><div class="lbl">🏦 Saldo ${F.saldoTotal>=0?'disponible':'negativo'}</div></div>
  </div>
  <div style="background:#E1F5EE;border-radius:8px;padding:12px;margin-bottom:20px;display:flex;align-items:center;justify-content:space-between">
    <div style="font-size:13px;font-weight:700;color:#0F6E56">📊 Cumplimiento de cuotas</div>
    <div style="font-size:20px;font-weight:900;color:${F.pctCumpl>=80?'#0F6E56':F.pctCumpl>=50?'#D97706':'#E24B4A'}">${F.pctCumpl}%</div>
    <div style="font-size:12px;color:#555">$${Math.round(F.totalPagado).toLocaleString('es-CL')} de $${Math.round(F.totalEsperado).toLocaleString('es-CL')}</div>
  </div>
  <h2>Estado de pagos por alumno</h2>
  <table><thead><tr><th>Alumno</th><th>Pagado</th><th>Esperado</th><th>%</th><th>Estado</th></tr></thead><tbody>${filasAlumnos}</tbody></table>
  <h2>Movimientos del año</h2>
  <table><thead><tr><th>Fecha</th><th>Descripción</th><th>Monto</th></tr></thead><tbody>${filasMovs||'<tr><td colspan=3>Sin movimientos registrados</td></tr>'}</tbody></table>
  <div class="footer">Tesorero v${APP_VERSION} · Desarrollado por Juvenal · ${hoy}</div>
  <script>window.onload=()=>window.print()<\/script>
  </body></html>`;
  
  const blob = new Blob([html], {type:'text/html'});
  const url  = URL.createObjectURL(blob);
  const win  = window.open(url, '_blank');
  if(!win) alert('Permite ventanas emergentes para generar el PDF.');
  setTimeout(()=>URL.revokeObjectURL(url), 10000);
}

async function forzarMigracionComprobantes(btnEl){
  if(btnEl){ btnEl.disabled=true; btnEl.textContent='☁️ Sincronizando...'; }
  try{
    await migrarComprobantesAStorage();
    const pendientes = (DB.movimientos||[]).filter(m=>m.archivos&&m.archivos.some(a=>a.data&&!a.url));
    if(pendientes.length===0){
      showToast('✅ Todos los comprobantes están sincronizados');
    }
  }catch(e){
    showToast('⚠️ Error al sincronizar: '+e.message);
  }finally{
    if(btnEl){ btnEl.disabled=false; btnEl.textContent='☁️ Sincronizar comprobantes con la nube'; }
  }
}

function limpiarPlanesHuerfanos(){
  const huerfanos=(DB.planesPago||[]).filter(p=>{
    if(!p.activo) return false;
    return !(DB.cuotas||[]).find(q=>q.id===p.cuotaId);
  });
  if(!huerfanos.length){ showToast('No hay planes huérfanos.'); return; }
  const ids=new Set(huerfanos.map(p=>p.id));
  if(!confirm(`¿Eliminar ${huerfanos.length} plan${huerfanos.length!==1?'es':''} de pago sin cuota asociada?\n\nEsto corregirá la deuda fantasma en Cobranza y el badge 📅 incorrecto.`)) return;
  DB.planesPago=(DB.planesPago||[]).filter(p=>!ids.has(p.id));
  saveDB();
  showToast('✅ Planes huérfanos eliminados');
  go('config');
}

function cambiarTipoOrg(tipo){
  if(!DB.config) DB.config={};
  DB.config.tipoOrg = tipo;
  // Actualizar categorías según el vocabulario seleccionado
  const v = VOCABULARIOS[tipo] || VOCABULARIOS.curso;
  DB.categorias = v.categorias;
  // Actualizar mesInicio default en cuotas si no tienen uno fijado
  (DB.cuotas||[]).forEach(q=>{
    if(q.tipo==='mensual' && q.mesInicio===undefined){
      q.mesInicio  = v.mesInicioDefault;
      q.mesTermino = v.mesFinDefault;
    }
  });
  saveDB();
  showToast(v.icono+' Tipo de organización: '+v.nombre);
  go('config');
}

function setVocabCustom(key, value){
  if(!DB.config) DB.config={};
  if(!DB.config.vocabCustom) DB.config.vocabCustom={};
  DB.config.vocabCustom[key] = value.trim();
  saveDB();
}

async function forzarSincronizacion(){
  const u = S && S.session;
  if(!u || !u.id){ showToast('⚠️ No hay sesión activa'); return; }
  showToast('☁️ Sincronizando con la nube...');
  try{
    clearTimeout(_saveCloudTimer);
    _saveCloudTimer = null;
    // Subir datos completos a Supabase
    const datosParaNube = dbSinBase64();
    const res = await sbFetch('/rest/v1/tesorero_datos',{
      method:'POST',
      headers:{'Prefer':'resolution=merge-duplicates'},
      body:JSON.stringify({
        usuario_id: u.id,
        datos: datosParaNube,
        actualizado_en: new Date().toISOString()
      })
    });
    if(res && res.ok){
      showToast('✅ Datos sincronizados correctamente');
    } else {
      showToast('⚠️ Error al sincronizar — intenta de nuevo');
    }
  }catch(e){
    showToast('⚠️ Error: '+(e.message||'desconocido'));
  }
}

