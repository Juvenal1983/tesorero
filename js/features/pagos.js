// js/features/pagos.js — extraído de la copia de demostración.
function renderPagos(){
  const ordenPago = S.params.ordenPago || 'apellido';
  const todosAlumnos = getAlumnos()
    .sort((a,b)=> ordenPago==='nombre'
      ? `${a.nombres} ${a.apellidos}`.localeCompare(`${b.nombres} ${b.apellidos}`,'es')
      : `${a.apellidos} ${a.nombres}`.localeCompare(`${b.apellidos} ${b.nombres}`,'es'));
  const busqP = (S.params.busqPago||'').toLowerCase();
  const alumnos = busqP
    ? todosAlumnos.filter(a=>`${a.apellidos} ${a.nombres}`.toLowerCase().includes(busqP))
    : todosAlumnos;
  const cuotas = getCuotas();
  const pagos = getPagos();
  const sel = S.params.aluId || (alumnos[0]&&alumnos[0].id) || (todosAlumnos[0]&&todosAlumnos[0].id) || '';

  const aluTabs = alumnos.map(a=>{
    const tienePlan = (DB.planesPago||[]).some(p=>p.alumnoId===a.id && p.activo);
    return `
    <div class="chip${sel===a.id?' active':''}" onclick="go('pagos',{aluId:'${a.id}',busqPago:'${escHtml(S.params.busqPago||'')}'})"
      style="${tienePlan && sel!==a.id ? 'border-color:#2563EB;color:#2563EB;background:#EFF6FF;' : ''}">
      ${escHtml(a.apellidos.split(' ')[0])}, ${escHtml(a.nombres.split(' ')[0])}${tienePlan?` <span style="font-size:11px" title="Plan de pago activo">📅</span>`:''}
    </div>`;
  }).join('');

  let detalleHtml = '';
  if(sel){
    const alu = alumnos.find(a=>a.id===sel);
    cuotas.forEach(q=>{
      const pagosQ = pagos.filter(p=>p.cuotaId===q.id&&p.alumnoId===sel);
      const mesIni1 = (q.mesInicio !== undefined && q.mesInicio !== null) ? q.mesInicio : vocab().mesInicioDefault;
      const mesFin1 = (q.mesTermino !== undefined && q.mesTermino !== null) ? q.mesTermino + 1 : vocab().mesFinDefault + 1;
      const periodos = q.tipo==='mensual' ? MESES.slice(mesIni1, mesFin1) : [`Anual ${q.anio||2026}`];
      detalleHtml += `
        <div class="card" style="margin-bottom:14px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px">
            <div class="card-title" style="margin:0">${escHtml(q.nombre)} <span class="badge ${q.tipo==='mensual'?'bgb':'bga'}" style="margin-left:6px">${q.tipo}</span></div>
            ${puedeEscribir()?`<button class="btn bp bs" style="font-size:13px" onclick="showModal('addPago',{aluId:'${sel}',cuotaId:'${q.id}'})">+ Registrar pago</button>`:''}
          </div>
          <div class="tbl-wrap">
          <table>
            <thead><tr><th>Período</th><th>Estado</th><th>Monto</th><th style="display:none" class="hide-mobile">Fecha</th><th style="display:none" class="hide-mobile">Medio</th><th></th></tr></thead>
            <tbody>
              ${periodos.map(periodo=>{
                // G06-fix: sumar TODOS los pagos del período (puede haber más de uno en v9).
                // Usar reduce para obtener monto total y find solo para el último registro
                // (fecha/medio del pago más reciente para mostrar en tabla).
                const pagosDelPeriodo = pagosQ.filter(p=>p.periodo===periodo);
                const montoSumado = pagosDelPeriodo.reduce((s,p)=>s+(Number(p.monto)||0), 0);
                const pagoRef = pagosDelPeriodo[pagosDelPeriodo.length-1] || null; // más reciente
                const obligado = Number(q.monto) || 0;
                const esParcial = pagosDelPeriodo.length > 0 && montoSumado < obligado;
                const esPagado  = pagosDelPeriodo.length > 0 && montoSumado >= obligado;
                // Para compatibilidad con código que usa variable "pago" (botones editar/eliminar),
                // exponer el último registro como referencia, pero mostrar monto sumado.
                const pago = pagoRef;
                return `<tr>
                  <td style="font-weight:500;white-space:nowrap">${periodo}</td>
                  <td><span class="badge ${esPagado?'bgg':esParcial?'':''}${!esPagado&&!esParcial&&!alu?.eximido?'bgr':''}" style="white-space:nowrap;background:${esParcial?'#FFF8E7':!esPagado&&alu?.eximido?'#FFF8E7':''};color:${esParcial?'#B8860B':!esPagado&&alu?.eximido?'#B8860B':''}">${esPagado?'✓ Pagado':esParcial?'⚠ Parcial':alu?.eximido?'🟡 Eximido':'Pendiente'}</span></td>
                  <td style="color:${esPagado?'var(--g)':esParcial?'#B8860B':alu?.eximido?'#B8860B':'var(--t3)'};white-space:nowrap;font-weight:${esPagado||esParcial||alu?.eximido?'600':'400'}">${pagosDelPeriodo.length>0?clp(montoSumado)+(esParcial?` / ${clp(obligado)}`:''):alu?.eximido?'—':'—'}</td>
                  <td style="color:var(--t3);font-size:12px;white-space:nowrap">${pago?fmtDate(pago.fecha):'—'}</td>
                  <td style="color:var(--t3);font-size:12px;white-space:nowrap">${pago?escHtml(pago.medio):'—'}</td>
                  <td style="white-space:nowrap">${(()=>{
                    if(pagosDelPeriodo.length>0) {
                      if(puedeEscribir()) {
                        // Mostrar controles para cada pago del período
                        return pagosDelPeriodo.map(p=>`<div style="display:flex;gap:4px;margin-bottom:2px"><button class="btn bs" onclick="showModal('editPago',{pagoId:'${p.id}'})" title="Editar pago" style="font-size:11px;padding:3px 7px">✏️</button><button class="btn bs bd" onclick="delPago('${p.id}')" title="Eliminar pago" style="font-size:11px;padding:3px 7px">✕</button></div>`).join('');
                      }
                      return ''; // visor: pago registrado pero sin controles de edición
                    }
                    if(!puedeEscribir()) return ''; // visor: sin pago y sin botón de registrar
                    const plan = getPlanPago('${sel}','${q.id}','${periodo}');
                    if(plan){
                      const pagados = plan.abonos.filter(a=>a.pagado).length;
                      return `<button class="btn bs" onclick="showModal('planPago',{aluId:'${sel}',cuotaId:'${q.id}',periodo:'${periodo}'})" style="font-size:11px;background:#EFF6FF;color:#2563EB;border-color:#BFDBFE">📅 ${pagados}/${plan.abonos.length}</button>`;
                    }
                    return `<button class="btn bs" onclick="showModal('planPago',{aluId:'${sel}',cuotaId:'${q.id}',periodo:'${periodo}'})" style="font-size:11px;color:var(--t3)" title="Crear plan de pago">📅</button>`;
                  })()}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
          </div>
        </div>`;
    });
  }

  const totPagado = pagos.filter(p=>p.alumnoId===sel&&p.estado==='pagado').reduce((s,p)=>s+p.monto,0);

  return `
  <div class="page-hdr"><div class="page-title">Registro de pagos</div></div>
  <div style="display:flex;gap:8px;margin-bottom:10px;align-items:center">
    <div style="position:relative;flex:1">
      <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--t3);font-size:14px;pointer-events:none">🔍</span>
      <input class="fi" id="busq-pago" placeholder="Buscar alumno…" value="${escHtml(S.params.busqPago||'')}"
        oninput="S.params.busqPago=this.value;S.params.aluId='';renderPage()"
        style="padding-left:32px;font-size:13px">
    </div>
    <select class="fs" style="width:auto;font-size:12px;padding:8px 10px"
      onchange="S.params.ordenPago=this.value;S.params.aluId='';renderPage()">
      <option value="apellido" ${(S.params.ordenPago||'apellido')==='apellido'?'selected':''}>A-Z Apellido</option>
      <option value="nombre" ${S.params.ordenPago==='nombre'?'selected':''}>A-Z Nombre</option>
    </select>
  </div>
  <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px">
    ${alumnos.length===0?`<span style="font-size:13px;color:var(--t3);padding:4px 2px">Sin resultados para "${escHtml(busqP)}"</span>`:aluTabs}
  </div>
  ${(DB.planesPago||[]).some(p=>p.activo && alumnos.some(a=>a.id===p.alumnoId))
    ? `<div style="font-size:11px;color:#2563EB;margin-bottom:14px;display:flex;align-items:center;gap:5px"><span>📅</span> Alumno con plan de pago activo</div>`
    : '<div style="margin-bottom:14px"></div>'
  }
  ${sel?`<div class="card" style="margin-bottom:14px;padding:12px 18px;display:flex;gap:16px;align-items:center">
    <div><span style="font-size:18px;font-weight:800;color:var(--g)">${clp(totPagado)}</span><span style="font-size:13px;color:var(--t3);margin-left:6px">pagado por este alumno</span></div>
  </div>`:''}
  ${detalleHtml||'<div class="empty-state"><div>Selecciona un alumno para ver sus pagos.</div></div>'}`;
}
async function delPago(id){
  if(!confirm('¿Eliminar este pago? Esta acción no se puede deshacer.')) return;

  // ── FLUJO RELACIONAL v9: primero eliminar en DB, luego actualizar local ──
  if(typeof V9_RELACIONAL!=='undefined' && V9_RELACIONAL){
    const cuentaId = (typeof S!=='undefined' && S._v9CuentaId) || null;
    if(cuentaId){
      try {
        await eliminarPagoV9(cuentaId, id, _authToken);
      } catch(err) {
        console.error('[v9] Error eliminando pago:', err);
        alert('Error al eliminar el pago en la base de datos: ' + (err.message || err));
        return; // No actualizar estado local si falla la DB
      }
    }
  }
  // ── Solo actualizar estado local si v9 tuvo éxito (o no aplica) ──

  DB.pagos=(DB.pagos||[]).filter(p=>p.id!==id);
  saveDB(); go('pagos',S.params);
}

function modalEditPago(data){
  const p = (DB.pagos||[]).find(x=>x.id===data.pagoId);
  if(!p) return '<div class="modal"><div class="modal-hdr"><div class="modal-title">Error</div><button class="close-btn" onclick="closeModal()">×</button></div></div>';
  const alu = (DB.alumnos||[]).find(a=>a.id===p.alumnoId);
  const cuota = (DB.cuotas||[]).find(q=>q.id===p.cuotaId);
  return `<div class="modal">
    <div class="modal-hdr">
      <div class="modal-title">✏️ Editar pago</div>
      <button class="close-btn" onclick="closeModal()">×</button>
    </div>
    <div style="font-size:13px;color:var(--t2);margin-bottom:14px">
      ${escHtml(alu?.nombres+' '+alu?.apellidos||'')} · ${escHtml(cuota?.nombre||'')} · ${escHtml(p.periodo||'')}
    </div>
    <div class="fg-row">
      <div class="fg"><label class="fl">Monto (CLP)</label>
        <input class="fi" id="ep-monto" type="number" value="${p.monto||0}">
      </div>
      <div class="fg"><label class="fl">Fecha</label>
        <input class="fi" id="ep-fecha" type="date" value="${p.fecha||''}">
      </div>
    </div>
    <div class="fg"><label class="fl">Medio de pago</label>
      <select class="fs" id="ep-medio">
        ${['Transferencia','Efectivo','Cheque','Otro'].map(m=>`<option${p.medio===m?' selected':''}>${m}</option>`).join('')}
      </select>
    </div>
    <div class="fg"><label class="fl">Observaciones</label>
      <input class="fi" id="ep-obs" value="${escHtml(p.obs||'')}">
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px">
      <button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn bp" onclick="saveEditPago('${p.id}')">💾 Guardar</button>
    </div>
  </div>`;
}

async function saveEditPago(pagoId){
  const p = (DB.pagos||[]).find(x=>x.id===pagoId);
  if(!p) return;
  const monto = parseInt(document.getElementById('ep-monto').value)||0;
  const fecha  = document.getElementById('ep-fecha').value;
  const medio  = document.getElementById('ep-medio').value;
  const obs    = document.getElementById('ep-obs').value.trim();
  if(!monto) return alert('Ingresa el monto.');
  if(!fecha)  return alert('Ingresa la fecha.');

  // ── FLUJO RELACIONAL v9: primero actualizar en DB, luego estado local ──
  if(typeof V9_RELACIONAL!=='undefined' && V9_RELACIONAL){
    const cuentaId = (typeof S!=='undefined' && S._v9CuentaId) || null;
    if(cuentaId){
      // Deshabilitar botón para evitar doble envío
      const btn = document.querySelector('.modal .btn.bp');
      if(btn){ btn.disabled = true; btn.textContent = 'Guardando…'; }
      try {
        await actualizarPagoV9(cuentaId, pagoId, { monto, fecha, medio, obs }, _authToken);
      } catch(err) {
        console.error('[v9] Error actualizando pago:', err);
        if(btn){ btn.disabled = false; btn.textContent = '💾 Guardar'; }
        alert('Error al guardar el pago en la base de datos: ' + (err.message || err));
        return; // No actualizar estado local si falla la DB
      }
    }
  }
  // ── Solo actualizar estado local si v9 tuvo éxito (o no aplica) ──

  p.monto = monto;
  p.fecha = fecha;
  p.medio = medio;
  p.obs   = obs;
  saveDB();
  closeModal();
  go('pagos', S.params);
}

// ─────────────────────────────────────────────
// MOVIMIENTOS
// ─────────────────────────────────────────────
