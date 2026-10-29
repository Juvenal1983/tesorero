// js/features/pagos-formularios.js — extraído de la copia de demostración.
function modalPago({aluId,cuotaId,periodo}){
  const cuota=(DB.cuotas||[]).find(q=>q.id===cuotaId);
  const alu=(DB.alumnos||[]).find(a=>a.id===aluId);
  const aps=(DB.apoderados||[]).filter(x=>x.alumnoId===aluId&&x.estado!=='inactivo');
  const mesIniP = (cuota?.mesInicio !== undefined && cuota?.mesInicio !== null) ? cuota.mesInicio : 2;
  const mesFinP = (cuota?.mesTermino !== undefined && cuota?.mesTermino !== null) ? cuota.mesTermino + 1 : 12;
  const periodos = cuota?.tipo==='mensual' ? MESES.slice(mesIniP, mesFinP) : [`Anual ${cuota?.anio||2026}`];
  const esMensual = cuota?.tipo==='mensual';
  const apSel = aps.length===1 ? aps[0].id : '';
  const apOpts = aps.length===0
    ? `<option value="">Sin apoderados registrados</option>`
    : aps.map(ap=>`<option value="${ap.id}">${escHtml(ap.nombre)} (${escHtml(ap.relacion||'')}${ap.telefono?' · '+escHtml(ap.telefono):''}${ap.email?' · '+escHtml(ap.email):''})</option>`).join('');

  // For monthly quotas: find which periods are already paid
  const pagados = esMensual
    ? (DB.pagos||[]).filter(p=>p.alumnoId===aluId&&p.cuotaId===cuotaId&&p.estado==='pagado').map(p=>p.periodo)
    : [];
  const pendientes = periodos.filter(p=>!pagados.includes(p));

  const periodosHtml = esMensual
    ? `<div class="fg">
        <label class="fl">Meses a pagar</label>
        <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap">
          <button type="button" class="btn bs" onclick="selTodosMeses(true)" style="font-size:12px">✅ Pagar todo (${pendientes.length} pendientes)</button>
          <button type="button" class="btn bs" onclick="selTodosMeses(false)" style="font-size:12px">☐ Ninguno</button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;border:1px solid var(--brd);border-radius:8px;padding:10px">
          ${periodos.map(p=>{
            const yaPagado = pagados.includes(p);
            return `<label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:${yaPagado?'default':'pointer'};opacity:${yaPagado?'0.4':'1'}">
              <input type="checkbox" class="p-mes-check" value="${p}" ${p===periodo?'checked':''} ${yaPagado?'disabled':''}>
              ${p}${yaPagado?' ✓':''}
            </label>`;
          }).join('')}
        </div>
        <div id="p-meses-resumen" style="font-size:12px;color:var(--gm);font-weight:600;margin-top:6px"></div>
      </div>`
    : `<div class="fg"><label class="fl">Período</label><select class="fs" id="p-periodo">${periodos.map(p=>`<option${p===periodo?' selected':''}>${p}</option>`).join('')}</select></div>`;

  return `<div class="modal" style="max-width:500px">
    <div class="modal-hdr"><div class="modal-title">Registrar pago</div><button class="close-btn" onclick="closeModal()">×</button></div>
    <div class="alert ag">Alumno: <strong>${escHtml((alu?.nombres||'')+' '+(alu?.apellidos||''))}</strong> · ${escHtml(cuota?.nombre||'')}</div>
    ${periodosHtml}
    <div class="fg-row">
      <div class="fg"><label class="fl">Monto por mes (CLP)</label><input class="fi" id="p-monto" type="number" value="${cuota?.monto||0}" oninput="actualizarResumenMeses()"></div>
      <div class="fg"><label class="fl">Fecha de pago</label><input class="fi" id="p-fecha" type="date" value="${isoToday()}"></div>
    </div>
    <div class="fg-row">
      <div class="fg"><label class="fl">Medio de pago</label><select class="fs" id="p-medio"><option>Transferencia</option><option>Efectivo</option><option>Cheque</option><option>Otro</option></select></div>
    </div>
    <div class="fg"><label class="fl">Observaciones</label><input class="fi" id="p-obs" placeholder="Opcional..."></div>
    <div style="border-top:1px solid var(--brd);margin-top:14px;padding-top:14px">
      <div style="font-size:13px;font-weight:700;margin-bottom:8px;color:var(--t2)">📣 Notificar al apoderado</div>
      <div class="fg" style="margin-bottom:0">
        <label class="fl">Apoderado a notificar</label>
        <select class="fs" id="p-apoderado">${apSel?`<option value="">(no notificar)</option>`:''}${apOpts}</select>
      </div>
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
      <button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn bp" onclick="savePago('${aluId}','${cuotaId}','${esMensual?'multi':'single'}')">Registrar y notificar →</button>
    </div>
  </div>`;
}

function selTodosMeses(sel){
  document.querySelectorAll('.p-mes-check:not([disabled])').forEach(c=>c.checked=sel);
  actualizarResumenMeses();
}

function actualizarResumenMeses(){
  const checks = [...document.querySelectorAll('.p-mes-check:checked')];
  const monto = parseInt(document.getElementById('p-monto')?.value)||0;
  const resumen = document.getElementById('p-meses-resumen');
  if(!resumen) return;
  if(checks.length===0){ resumen.textContent=''; return; }
  const total = monto * checks.length;
  resumen.textContent = checks.length+' mes'+(checks.length>1?'es':'')+' seleccionado'+(checks.length>1?'s':'')+' · Total: '+clp(total);
}


// ─── PLAN DE PAGOS ────────────────────────────────────────────────────────────

function getPlanesPago(){
  return (DB.planesPago||[]).filter(p=>{
    const q = (DB.cuotas||[]).find(x=>x.id===p.cuotaId);
    return q && q.cursoId===S.cursoId;
  });
}

function getPlanPago(alumnoId, cuotaId, periodo){
  return (DB.planesPago||[]).find(p=>
    p.alumnoId===alumnoId && p.cuotaId===cuotaId && p.periodo===periodo && p.activo
  );
}

function modalEditAbono(data){
  const plan = (DB.planesPago||[]).find(p=>p.id===data.planId);
  if(!plan) return '<div class="modal"><div class="modal-hdr"><div class="modal-title">Error</div><button class="close-btn" onclick="closeModal()">×</button></div></div>';
  const ab = plan.abonos[data.idx];
  const alu = (DB.alumnos||[]).find(a=>a.id===plan.alumnoId);
  return `<div class="modal">
    <div class="modal-hdr">
      <div class="modal-title">✏️ Editar abono ${data.idx+1}</div>
      <button class="close-btn" onclick="closeModal()">×</button>
    </div>
    <div style="font-size:13px;color:var(--t2);margin-bottom:14px">
      ${escHtml(alu?.nombres+' '+alu?.apellidos||'')} · ${escHtml(plan.periodo||'')}
    </div>
    <div class="fg-row">
      <div class="fg"><label class="fl">Monto (CLP)</label>
        <input class="fi" id="ea-monto" type="number" value="${ab.monto||0}">
      </div>
      <div class="fg"><label class="fl">Fecha vencimiento</label>
        <input class="fi" id="ea-fecha" type="date" value="${ab.fecha||''}">
      </div>
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px">
      <button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn bp" onclick="saveEditAbono('${data.planId}',${data.idx})">💾 Guardar</button>
    </div>
  </div>`;
}

function saveEditAbono(planId, idx){
  const plan = (DB.planesPago||[]).find(p=>p.id===planId);
  if(!plan) return;
  const monto = parseInt(document.getElementById('ea-monto').value)||0;
  const fecha  = document.getElementById('ea-fecha').value;
  if(!monto) return alert('Ingresa el monto.');
  if(!fecha)  return alert('Ingresa la fecha.');
  plan.abonos[idx].monto = monto;
  plan.abonos[idx].fecha = fecha;
  // Recalcular montoTotal del plan
  plan.montoTotal = plan.abonos.reduce((s,a)=>s+a.monto,0);
  saveDB();
  // Re-render modal del plan
  showModal('planPago', {aluId:plan.alumnoId, cuotaId:plan.cuotaId, periodo:plan.periodo});
}

function modalPlanPago(data){
  const {aluId, cuotaId, periodo, ultimoAbono} = data;
  const alu = (DB.alumnos||[]).find(a=>a.id===aluId);
  const cuota = (DB.cuotas||[]).find(q=>q.id===cuotaId);
  const planExistente = getPlanPago(aluId, cuotaId, periodo);
  const montoTotal = cuota?.monto || 0;

  // Datos para mensajes WhatsApp
  const ap = (DB.apoderados||[]).filter(a=>a.alumnoId===aluId&&a.estado!=='inactivo')[0]||null;
  const cur = getCurso();
  const tesorero = S.session?.nombre || cur?.tesorero || 'El Tesorero';

  function msgAbono(plan, idx){
    if(!ap||!ap.telefono) return null;
    const tel = ap.telefono.replace(/\D/g,'').replace(/^56/,'');
    const primerNombre = (ap.nombre||'').split(' ')[0];
    const pagadosN = plan.abonos.filter(a=>a.pagado).length;
    const todosPag = plan.abonos.every(a=>a.pagado);
    const proximoAb = plan.abonos.find(a=>!a.pagado);
    const estadoPlan = todosPag
      ? `✅ *¡Plan completado!* La cuota de *${plan.periodo}* queda totalmente pagada.`
      : `📊 Llevas *${pagadosN} de ${plan.abonos.length} abonos* pagados.${proximoAb?` Próximo: *${clp(proximoAb.monto)}* — vence ${fmtDate(proximoAb.fecha)}`:''}`;
    const msg = `Hola ${primerNombre} 👋\n\nLe confirmamos el registro del *Abono ${idx+1}* de su plan de pago:\n\n👤 Alumno/a: *${alu?.nombres||''} ${alu?.apellidos||''}*\n📋 Cuota: *${cuota?.nombre||''}* — ${plan.periodo}\n💰 Monto: *${clp(plan.abonos[idx].monto)}*\n📅 Fecha: *${fmtDate(plan.abonos[idx].fechaPago||isoToday())}*\n\n${estadoPlan}\n\n— ${tesorero} · ${cur?.nombre||''}`;
    return {tel, msg};
  }

  const abonosHtml = planExistente
    ? planExistente.abonos.map((ab,i)=>{
        const wsData = ab.pagado ? msgAbono(planExistente, i) : null;
        return `
        <div style="display:flex;align-items:center;gap:8px;padding:8px;background:${ab.pagado?'var(--gl)':'var(--bg)'};border-radius:8px;margin-bottom:6px${i===ultimoAbono&&ab.pagado?';border:2px solid var(--g)':''}">
          <div style="flex:1">
            <div style="font-size:13px;font-weight:600">Abono ${i+1}: ${clp(ab.monto)}</div>
            <div style="font-size:11px;color:var(--t3)">Vence: ${fmtDate(ab.fecha)}</div>
          </div>
          ${ab.pagado
            ? `<span class="badge bgg" style="font-size:11px">✅ ${fmtDate(ab.fechaPago)}</span>`
            : `<div style="display:flex;gap:4px">
                <button class="btn bs" onclick="showModal('editAbono',{planId:'${planExistente.id}',idx:${i}})" style="font-size:11px;padding:3px 7px">✏️</button>
                <button class="btn bp bs" onclick="pagarAbono('${planExistente.id}',${i})" style="font-size:11px;padding:4px 10px">💰 Pagar</button>
              </div>`
          }
        </div>`;
      }).join('')
    : '';

  return `<div class="modal" style="max-width:480px">
    <div class="modal-hdr">
      <div class="modal-title">📅 Plan de pago — ${escHtml(alu?.nombres+' '+alu?.apellidos||'')}</div>
      <button class="close-btn" onclick="closeModal()">×</button>
    </div>
    <div style="font-size:13px;color:var(--t2);margin-bottom:14px">
      Cuota: <strong>${escHtml(cuota?.nombre||'')}</strong> · Período: <strong>${escHtml(periodo)}</strong> · Total: <strong style="color:var(--g)">${clp(montoTotal)}</strong>
    </div>

    ${planExistente ? `
      <div class="alert ag" style="margin-bottom:14px">Plan de pago activo — ${planExistente.abonos.filter(a=>a.pagado).length} de ${planExistente.abonos.length} abonos pagados</div>
      ${abonosHtml}
      <div style="display:flex;gap:8px;margin-top:14px;justify-content:space-between;flex-wrap:wrap">
        <button class="btn bd bs" onclick="eliminarPlanPago('${planExistente.id}')">🗑 Eliminar plan</button>
        <div style="display:flex;gap:8px">
          ${(()=>{
            if(!ap||!ap.telefono) return '';
            const tel = ap.telefono.replace(/\D/g,'').replace(/^56/,'');
            const abonosPagados = planExistente.abonos.filter(a=>a.pagado);
            if(!abonosPagados.length) return '';
            const primerNombre = (ap.nombre||'').split(' ')[0];
            const todosPag = planExistente.abonos.every(a=>a.pagado);
            const proximoAb = planExistente.abonos.find(a=>!a.pagado);
            const resumenAbonos = abonosPagados.map((ab,_,arr)=>{
              const idx = planExistente.abonos.indexOf(ab);
              return `  • Abono ${idx+1}: ${clp(ab.monto)} — pagado el ${fmtDate(ab.fechaPago)}`;
            }).join('\n');
            const totalPagado = abonosPagados.reduce((s,a)=>s+a.monto,0);
            const estadoPlan = todosPag
              ? `✅ *¡Plan completado!* La cuota de *${planExistente.periodo}* queda totalmente pagada.`
              : `📊 *${abonosPagados.length} de ${planExistente.abonos.length} abonos pagados* — Total: ${clp(totalPagado)} de ${clp(montoTotal)}.${proximoAb?`\n⏭ Próximo abono: *${clp(proximoAb.monto)}* — vence ${fmtDate(proximoAb.fecha)}`:''}`;
            const msg = `Hola ${primerNombre} 👋\n\nLe informamos el estado de su *plan de pagos*:\n\n👤 Alumno/a: *${alu?.nombres||''} ${alu?.apellidos||''}*\n📋 Cuota: *${cuota?.nombre||''}* — ${planExistente.periodo}\n\n*Abonos registrados:*\n${resumenAbonos}\n\n${estadoPlan}\n\n— ${tesorero} · ${cur?.nombre||''}`;
            return `<a href="https://wa.me/56${tel}?text=${encodeURIComponent(msg)}" target="_blank"
              style="display:inline-flex;align-items:center;gap:6px;background:#25D366;color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:700;text-decoration:none">
              💬 Notificar pagos
            </a>`;
          })()}
          <button class="btn" onclick="closeModal()">Cerrar</button>
        </div>
      </div>` : `
      <div class="fg-row">
        <div class="fg">
          <label class="fl">Número de abonos</label>
          <input class="fi" id="pp-num" type="number" min="2" max="12" value="2" oninput="generarFechasAbonos()">
        </div>
        <div class="fg">
          <label class="fl">Fecha primer abono</label>
          <input class="fi" id="pp-fecha-ini" type="date" value="${isoToday()}" oninput="generarFechasAbonos()">
        </div>
      </div>
      <div id="pp-abonos-lista" style="margin-bottom:14px"></div>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button class="btn" onclick="closeModal()">Cancelar</button>
        <button class="btn bp" onclick="guardarPlanPago('${aluId}','${cuotaId}','${escHtml(periodo)}',${montoTotal})">💾 Crear plan</button>
      </div>
    `}
  </div>`;
}

function generarFechasAbonos(){
  const num = parseInt(document.getElementById('pp-num')?.value)||2;
  const fechaIni = document.getElementById('pp-fecha-ini')?.value;
  const lista = document.getElementById('pp-abonos-lista');
  if(!lista||!fechaIni) return;
  const cuotaId = S.modal?.data?.cuotaId;
  const cuota = (DB.cuotas||[]).find(q=>q.id===cuotaId);
  const montoTotal = cuota?.monto||0;
  const montoCada = Math.round(montoTotal/num);
  let html = '<div style="display:flex;flex-direction:column;gap:6px">';
  for(let i=0;i<num;i++){
    const f = new Date(fechaIni);
    f.setMonth(f.getMonth()+i);
    const fStr = f.toISOString().slice(0,10);
    const esUltimo = i===num-1;
    const montoAbono = esUltimo ? montoTotal - montoCada*(num-1) : montoCada;
    html += `<div style="display:flex;align-items:center;gap:8px;padding:8px;background:var(--bg);border-radius:8px">
      <span style="font-size:12px;font-weight:600;color:var(--t3);min-width:60px">Abono ${i+1}</span>
      <input class="fi pp-monto-input" type="number" value="${montoAbono}" data-idx="${i}" style="width:110px;text-align:right;padding:4px 8px">
      <input class="fi pp-fecha-input" type="date" value="${fStr}" data-idx="${i}" style="flex:1;padding:4px 8px">
    </div>`;
  }
  html += '</div>';
  lista.innerHTML = html;
}

function guardarPlanPago(alumnoId, cuotaId, periodo, montoTotal){
  const montoInputs = document.querySelectorAll('.pp-monto-input');
  const fechaInputs = document.querySelectorAll('.pp-fecha-input');
  if(!montoInputs.length){ alert('Genera los abonos primero.'); return; }
  const abonos = [];
  let totalAbonos = 0;
  montoInputs.forEach((inp,i)=>{
    const monto = parseInt(inp.value)||0;
    const fecha = fechaInputs[i]?.value||isoToday();
    if(!monto){ alert('Todos los abonos deben tener monto.'); return; }
    if(!fecha){ alert('Todos los abonos deben tener fecha.'); return; }
    abonos.push({ monto, fecha, pagado:false, fechaPago:null });
    totalAbonos += monto;
  });
  if(abonos.length===0) return;
  if(!confirm(`¿Crear plan de ${abonos.length} abonos por ${clp(totalAbonos)} para esta cuota?`)) return;
  if(!DB.planesPago) DB.planesPago=[];
  DB.planesPago.push({ id:uid(), alumnoId, cuotaId, periodo, montoTotal:totalAbonos, abonos, activo:true, creadoEn:isoToday() });
  saveDB();
  closeModal();
  go('pagos', S.params);
}

function pagarAbono(planId, abonoIdx){
  const plan = (DB.planesPago||[]).find(p=>p.id===planId);
  if(!plan) return;
  if(!confirm(`¿Marcar abono ${abonoIdx+1} de ${clp(plan.abonos[abonoIdx].monto)} como pagado?`)) return;
  plan.abonos[abonoIdx].pagado = true;
  plan.abonos[abonoIdx].fechaPago = isoToday();

  const todosPagados = plan.abonos.every(a=>a.pagado);
  if(todosPagados){
    if(!DB.pagos) DB.pagos=[];
    const yaExiste = DB.pagos.find(p=>p.alumnoId===plan.alumnoId&&p.cuotaId===plan.cuotaId&&p.periodo===plan.periodo&&p.estado==='pagado');
    if(!yaExiste){
      DB.pagos.push({id:uid(),cuotaId:plan.cuotaId,alumnoId:plan.alumnoId,periodo:plan.periodo,
        monto:plan.montoTotal,fecha:isoToday(),estado:'pagado',medio:'Plan de pago',
        obs:'Completado mediante plan de pago',creadoPor:S.session?.id||''});
    }
    plan.activo = false;
    showToast('✅ Plan completado — cuota marcada como pagada');
  } else {
    showToast('✅ Abono registrado');
  }
  saveDB();
  // Re-render modal — el botón de WhatsApp aparece dentro del modal
  showModal('planPago', {aluId:plan.alumnoId, cuotaId:plan.cuotaId, periodo:plan.periodo, ultimoAbono:abonoIdx});
}

function eliminarPlanPago(planId){
  if(!confirm('¿Eliminar este plan de pago? Los abonos ya pagados no se revertirán.')) return;
  if(!confirm('Segunda confirmación: ¿Seguro que deseas eliminar el plan?')) return;
  DB.planesPago = (DB.planesPago||[]).filter(p=>p.id!==planId);
  saveDB();
  closeModal();
  go('pagos', S.params);
}


// ── Bandera anti-doble-envío para el flujo v9 ───────────────────────────────
let _savePagoEnCurso = false;

function savePago(aluId,cuotaId,modo){
  const monto=parseInt(document.getElementById('p-monto').value);
  if(!monto){alert('Ingresa el monto.');return;}
  const fecha=document.getElementById('p-fecha').value;
  const medio=document.getElementById('p-medio').value;
  const obs=document.getElementById('p-obs').value;
  const apId=document.getElementById('p-apoderado')?.value||'';

  // Determinar períodos a registrar
  let periodos = [];
  if(modo==='multi'){
    const checks = [...document.querySelectorAll('.p-mes-check:checked')];
    periodos = checks.map(c=>c.value);
    if(!periodos.length){ alert('Selecciona al menos un mes.'); return; }
  } else {
    const sel = document.getElementById('p-periodo')?.value;
    if(sel) periodos = [sel];
  }

  if(!DB.pagos) DB.pagos=[];

  // Filtrar duplicados en memoria
  const duplicados = [];
  const nuevos = [];
  periodos.forEach(periodo=>{
    const existe = (DB.pagos||[]).find(p=>
      (p.alumnoId||p.aluId)===aluId && p.cuotaId===cuotaId && p.periodo===periodo && p.estado==='pagado'
    );
    if(existe) duplicados.push(periodo);
    else nuevos.push(periodo);
  });

  if(duplicados.length){
    alert('⚠️ Los siguientes meses ya tenían pago registrado y se omitieron:\n'+duplicados.join(', '));
  }
  if(!nuevos.length) return;

  // ── FLUJO RELACIONAL v9 ──────────────────────────────────────────────────
  if (typeof V9_RELACIONAL !== 'undefined' && V9_RELACIONAL) {
    // Bloquear doble envío mientras la petición al servidor está en curso
    if (_savePagoEnCurso) { return; }
    _savePagoEnCurso = true;
    const btnGuardar = document.querySelector('button[onclick*="savePago"]');
    if (btnGuardar) { btnGuardar.disabled = true; btnGuardar.textContent = 'Guardando…'; }

    const cuentaId = (typeof S !== 'undefined' && S._v9CuentaId) || null;
    if (!cuentaId) {
      _savePagoEnCurso = false;
      if (btnGuardar) { btnGuardar.disabled = false; btnGuardar.textContent = 'Registrar y notificar →'; }
      alert('Error: sesión v9 sin cuentaId — vuelve a iniciar sesión.');
      return;
    }

    // Construir payload por período (sin añadir a DB.pagos aún)
    const payloads = nuevos.map(periodo => ({
      _periodo: periodo,
      id:         'p-' + Date.now() + '-' + Math.random().toString(36).slice(2,7),
      alumno_id:  aluId,
      cuota_id:   cuotaId,
      monto,
      fecha,
      medio,
      estado:     'pagado',
      periodo:    periodo || null,
      obs:        obs || null,
      creado_por: (S && S.session && S.session.id) || null,
    }));

    // Enviar todos al servidor y esperar confirmación antes de tocar DB.pagos
    Promise.allSettled(
      payloads.map(payload =>
        registrarPagoV9(payload, cuentaId, _authToken)
          .then(registrado => ({ ok: true, periodo: payload._periodo, registro: registrado }))
          .catch(err         => ({ ok: false, periodo: payload._periodo, err }))
      )
    ).then(resultados => {
      _savePagoEnCurso = false;
      if (btnGuardar) { btnGuardar.disabled = false; btnGuardar.textContent = 'Registrar y notificar →'; }

      const exitosos = resultados.filter(r => r.value?.ok).map(r => r.value);
      const fallidos  = resultados.filter(r => !r.value?.ok).map(r => r.value);

      // Sólo añadir a DB.pagos los que el servidor confirmó
      exitosos.forEach(({ registro }) => {
        DB.pagos.push({
          id:        registro.id,
          alumnoId:  aluId,
          aluId,
          cuotaId,
          periodo:   registro.periodo,
          monto:     registro.monto,
          fecha:     registro.fecha,
          estado:    'pagado',
          medio:     registro.medio,
          obs:       registro.obs,
          creadoPor: registro.creado_por,
          _v9:       true,
          _cuentaId: cuentaId,
        });
      });

      if (fallidos.length) {
        const msgs = fallidos.map(f => `• ${f.periodo}: ${f.err?.message || 'error del servidor'}`).join('\n');
        const aviso = exitosos.length
          ? `⚠️ ${exitosos.length} período(s) guardado(s), pero ${fallidos.length} falló:\n${msgs}\n\nLos fallidos NO se registraron.`
          : `❌ No se pudo guardar ningún período:\n${msgs}`;
        alert(aviso);
        if (!exitosos.length) return; // No mostrar éxito si todo falló
      }

      if (!exitosos.length) return;

      // ── A partir de aquí sólo para períodos exitosos ──────────────────
      const periodoExitosos = exitosos.map(e => e.registro.periodo);
      const periodo = periodoExitosos.length===1 ? periodoExitosos[0] : periodoExitosos.join(', ');

      const ap=apId?(DB.apoderados||[]).find(x=>x.id===apId):null;
      const alu=(DB.alumnos||[]).find(a=>a.id===aluId);
      const cuota=(DB.cuotas||[]).find(q=>q.id===cuotaId);
      const cur=getCurso();
      const alumNombre=((alu?.nombres||'')+' '+(alu?.apellidos||'')).trim();
      const curNombre=cur?.nombre||'el curso';
      const colegioNombre=(DB.colegios||[]).find(c=>c.id===cur?.colegioId)?.nombre||'';
      const fechaFmt=fmtDate(fecha);
      const montoFmt=clp(monto);

      const plantilla=DB.config?.plantillaPago||PLANTILLA_PAGO_DEFAULT;
      const tieneVariables = plantilla && /\{alumno\}|\{monto\}|\{periodo\}|\{cuota\}/.test(plantilla);
      const msgDefault = tieneVariables
        ? plantilla
            .replace(/\{alumno\}/g,alumNombre)
            .replace(/\{cuota\}/g,cuota?.nombre||'cuota')
            .replace(/\{periodo\}/g,periodo)
            .replace(/\{monto\}/g,montoFmt)
            .replace(/\{fecha\}/g,fechaFmt)
            .replace(/\{medio\}/g,medio)
            .replace(/\{curso\}/g,curNombre)
            .replace(/\{colegio\}/g,colegioNombre)
        : buildMsgDefault({alumNombre,cuota,periodo,montoFmt,fechaFmt,medio,curNombre,colegioNombre});

      S.modal={type:'notificacion',data:{ap,alu,cuota,periodo,monto,fecha,medio,cur,aluId,msgDefault}};
      render();
    });

    return; // la UI se actualiza dentro del .then()
  }
  // ── FIN FLUJO RELACIONAL v9 ──────────────────────────────────────────────

  // ── FLUJO LEGADO ─────────────────────────────────────────────────────────
  nuevos.forEach(periodo=>{
    DB.pagos.push({id:uid(),cuotaId,alumnoId:aluId,aluId,periodo,monto,fecha,estado:'pagado',medio,obs,creadoPor:S.session.id});
  });
  saveDB();

  const periodo = nuevos.length===1 ? nuevos[0] : nuevos.join(', ');
  const ap=apId?(DB.apoderados||[]).find(x=>x.id===apId):null;
  const alu=(DB.alumnos||[]).find(a=>a.id===aluId);
  const cuota=(DB.cuotas||[]).find(q=>q.id===cuotaId);
  const cur=getCurso();
  const alumNombre=((alu?.nombres||'')+' '+(alu?.apellidos||'')).trim();
  const curNombre=cur?.nombre||'el curso';
  const colegioNombre=(DB.colegios||[]).find(c=>c.id===cur?.colegioId)?.nombre||'';
  const fechaFmt=fmtDate(fecha);
  const montoFmt=clp(monto);

  const plantilla=DB.config?.plantillaPago||PLANTILLA_PAGO_DEFAULT;
  const tieneVariables = plantilla && /\{alumno\}|\{monto\}|\{periodo\}|\{cuota\}/.test(plantilla);
  const msgDefault = tieneVariables
    ? plantilla
        .replace(/\{alumno\}/g,alumNombre)
        .replace(/\{cuota\}/g,cuota?.nombre||'cuota')
        .replace(/\{periodo\}/g,periodo)
        .replace(/\{monto\}/g,montoFmt)
        .replace(/\{fecha\}/g,fechaFmt)
        .replace(/\{medio\}/g,medio)
        .replace(/\{curso\}/g,curNombre)
        .replace(/\{colegio\}/g,colegioNombre)
    : buildMsgDefault({alumNombre,cuota,periodo,montoFmt,fechaFmt,medio,curNombre,colegioNombre});

  S.modal={type:'notificacion',data:{ap,alu,cuota,periodo,monto,fecha,medio,cur,aluId,msgDefault}};
  render();
}

function buildMsgDefault({alumNombre,cuota,periodo,montoFmt,fechaFmt,medio,curNombre,colegioNombre}){
  return 'Estimado/a apoderado/a 👋\n\n' +
    'Le informamos que se ha registrado exitosamente el siguiente pago:\n\n' +
    '👤 Alumno/a: *' + alumNombre + '*\n' +
    '📋 Cuota: ' + (cuota?.nombre||'Cuota') + '\n' +
    '📅 Período: *' + periodo + '*\n' +
    '💰 Monto: *' + montoFmt + '*\n' +
    '📆 Fecha de pago: ' + fechaFmt + '\n' +
    '💳 Medio de pago: ' + medio + '\n\n' +
    '🏫 Curso: ' + curNombre + (colegioNombre ? ' · ' + colegioNombre : '') + '\n\n' +
    'Gracias por su puntualidad.\n\n' +
    '— ' + (S.session?.nombre||'Tesorero/a') + ' · Tesorera de curso';
}

function modalNotificacion({ap,alu,cuota,periodo,monto,fecha,medio,cur,aluId,msgDefault}){
  const alumNombre=`${alu?.nombres||''} ${alu?.apellidos||''}`.trim();
  const asunto=`Confirmación de pago — ${alumNombre} · ${periodo}`;
  const montoFmt=clp(monto);
  const hasAp=!!ap;
  const tel=ap?.telefono||'';
  const email=ap?.email||'';

  // msgDefault viene en S.modal.data, generado antes de renderizar
  const msgInicial = msgDefault || '';

  return `<div class="modal" style="max-width:580px">
    <div class="modal-hdr">
      <div class="modal-title">✅ Pago registrado</div>
      <button class="close-btn" onclick="closeModalAndRefresh('${aluId}')">×</button>
    </div>
    <div class="alert ag" style="margin-bottom:14px">
      Pago de <strong>${escHtml(alumNombre)}</strong> · ${escHtml(periodo)} · ${montoFmt} registrado correctamente.
    </div>
    ${hasAp?`
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <div style="font-size:14px;font-weight:700">📣 Mensaje para ${escHtml(ap.nombre)}</div>
      <div style="display:flex;gap:6px">
        <button class="btn bs" onclick="restaurarMsgNotif()" title="Restaurar mensaje original">↩ Restaurar</button>
        <button class="btn bs bp" onclick="guardarPlantillaPago(document.getElementById('msg-notif').value)" title="Guardar como plantilla">💾 Guardar plantilla</button>
      </div>
    </div>
    <textarea id="msg-notif"
      style="width:100%;min-height:170px;resize:vertical;padding:12px 14px;border:1px solid var(--brd);border-radius:8px;font-size:13px;font-family:inherit;color:var(--t2);background:var(--bg);line-height:1.7;transition:.15s"
      onfocus="this.style.borderColor='var(--gm)';this.style.boxShadow='0 0 0 3px rgba(29,158,117,.12)'"
      onblur="this.style.borderColor='var(--brd)';this.style.boxShadow='none'"
    >${msgInicial.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</textarea>
    <div style="font-size:11px;color:var(--t3);margin-top:4px;margin-bottom:14px">
      Edita el mensaje antes de enviarlo. "Guardar plantilla" lo usará en futuros pagos.
      ${DB.config?.plantillaPago?'<span style="color:var(--gm);font-weight:600"> · Plantilla personalizada activa</span>':''}
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px">
      ${tel?`
      <button onclick="enviarWhatsapp('${escHtml(tel)}')"
         style="display:flex;align-items:center;gap:10px;background:#25D366;color:#fff;border-radius:10px;padding:13px 18px;font-weight:700;font-size:14px;border:none;cursor:pointer;width:100%;text-align:left">
        <span style="font-size:22px">💬</span>
        <div><div>Enviar por WhatsApp</div><div style="font-size:11px;font-weight:400;opacity:.85">${escHtml(tel)}</div></div>
        <span style="margin-left:auto;font-size:18px">↗</span>
      </button>`:`
      <div style="border:1px dashed var(--brd);border-radius:10px;padding:13px 18px;font-size:13px;color:var(--t3);display:flex;align-items:center;gap:10px">
        <span style="font-size:20px">💬</span> Sin teléfono registrado — agrégalo en Alumnos → 👤
      </div>`}
      ${email?`
      <button onclick="enviarEmailNotif()"
         style="display:flex;align-items:center;gap:10px;background:var(--b);color:#fff;border-radius:10px;padding:13px 18px;font-weight:700;font-size:14px;border:none;cursor:pointer;width:100%;text-align:left">
        <span style="font-size:22px">✉️</span>
        <div><div>Enviar por correo</div><div style="font-size:11px;font-weight:400;opacity:.85">${escHtml(email)}</div></div>
        <span style="margin-left:auto;font-size:18px">↗</span>
      </button>`:`
      <div style="border:1px dashed var(--brd);border-radius:10px;padding:13px 18px;font-size:13px;color:var(--t3);display:flex;align-items:center;gap:10px">
        <span style="font-size:20px">✉️</span> Sin correo registrado — agrégalo en Alumnos → 👤
      </div>`}
    </div>`:`
    <div style="border:1px dashed var(--brd);border-radius:10px;padding:14px 16px;font-size:13px;color:var(--t3);margin-bottom:16px;text-align:center">
      Sin apoderado seleccionado para notificar.<br>Puedes agregar apoderados en la sección Alumnos.
    </div>`}
    <div style="display:flex;justify-content:flex-end">
      <button class="btn bp" onclick="closeModalAndRefresh('${aluId}')">Listo</button>
    </div>
  </div>`;
}

function restaurarMsgNotif(){
  const ta=document.getElementById('msg-notif');
  if(ta&&S.modal?.data?.msgDefault) ta.value=S.modal.data.msgDefault;
}

function enviarWhatsapp(tel){
  const msg=document.getElementById('msg-notif')?.value||'';
  const num=tel.replace(/\D/g,'');
  window.open('https://wa.me/'+(num.startsWith('56')?num:'56'+num)+'?text='+encodeURIComponent(msg),'_blank','noopener');
}

function enviarEmailNotif(){
  const msg=document.getElementById('msg-notif')?.value||'';
  const d=S.modal?.data||{};
  const nombre=((d.alu?.nombres||'')+' '+(d.alu?.apellidos||'')).trim();
  const asunto='Confirmación de pago — '+nombre+' · '+(d.periodo||'');
  const mail=d.ap?.email||'';
  if(mail) window.location.href='mailto:'+mail+'?subject='+encodeURIComponent(asunto)+'&body='+encodeURIComponent(msg);
}

function guardarPlantillaPago(msgActual){
  if(!DB.config) DB.config={};
  DB.config.plantillaPago=msgActual;
  saveDB();
  if(S.modal?.data) S.modal.data.msgDefault=msgActual;
  const btn=event?.currentTarget||event?.target;
  if(btn){const t=btn.textContent;btn.textContent='✓ Guardada';btn.style.background='var(--g)';btn.style.color='#fff';setTimeout(()=>{btn.textContent=t;btn.style.background='';btn.style.color='';},2000);}
}

function closeModalAndRefresh(aluId){
  S.modal=null;
  go('pagos',{aluId});
}

