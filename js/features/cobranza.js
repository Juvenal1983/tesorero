// js/features/cobranza.js — extraído de la copia de demostración.
function renderCobranza(){
  const filtro = S.params.filtroCobranza || 'todos';
  const plantillaActiva = S.params.plantillaCobranza || 'suave';
  const orden = S.params.ordenCobranza || 'deuda-desc';
  const hoy = new Date();
  const mesHoy = hoy.getMonth();
  let deudores = getDeudores();

  // Aplicar filtro
  if(filtro==='mes'){
    deudores = deudores.filter(d=>d.periodosPendientes.some(p=>p.periodo===MESES[mesHoy]));
  } else if(filtro==='acumulada'){
    deudores = deudores.filter(d=>d.periodosPendientes.length > 1);
  } else if(filtro==='sin-contactar'){
    deudores = deudores.filter(d=>d.estado==='pendiente');
  } else if(filtro==='contactados'){
    deudores = deudores.filter(d=>d.estado!=='pendiente');
  }

  // Aplicar orden
  if(orden==='alfa'){
    deudores.sort((a,b)=>(a.alu.apellidos+' '+a.alu.nombres).localeCompare(b.alu.apellidos+' '+b.alu.nombres,'es'));
  } else if(orden==='deuda-asc'){
    deudores.sort((a,b)=>a.deudaTotal-b.deudaTotal);
  } else {
    deudores.sort((a,b)=>b.deudaTotal-a.deudaTotal);
  }

  const todos = getDeudores();
  const totalDeuda = todos.reduce((s,d)=>s+d.deudaTotal,0);
  const contactados = todos.filter(d=>d.estado!=='pendiente').length;
  const sinContactar = todos.filter(d=>d.estado==='pendiente').length;

  const colorEstado = e => e==='pendiente'?'#E24B4A':e==='recordado'?'#D97706':e==='compromiso'?'#2563EB':e==='pospuesto'?'#6B7280':'#1D9E75';
  const labelEstado = e => e==='pendiente'?'🔴 Pendiente':e==='recordado'?'🟡 Recordado':e==='compromiso'?'🔵 Comprometió':e==='pospuesto'?'⏸ Pospuesto':'✅ Pagado';
  const filtroBtn = (id,label) => `<button onclick="go('cobranza',{filtroCobranza:'${id}',plantillaCobranza:'${plantillaActiva}'})" style="padding:6px 12px;border-radius:20px;border:1.5px solid ${filtro===id?'var(--g)':'var(--brd)'};background:${filtro===id?'var(--gl)':'var(--wh)'};color:${filtro===id?'var(--g)':'var(--t2)'};font-size:12px;font-weight:${filtro===id?'700':'400'};cursor:pointer;white-space:nowrap">${label}</button>`;

  const tarjetas = deudores.length===0
    ? `<div class="empty-state"><div style="font-size:48px">🎉</div><div style="font-weight:700;font-size:16px">¡Sin deudores!</div><div style="font-size:13px;color:var(--t3)">Todos los ${V('contactos')} están al día con sus cuotas.</div></div>`
    : deudores.map(d=>{
        const tel = (d.apPrincipal?.telefono||'').replace(/\D/g,'');
        const msg = encodeURIComponent(generarMensajeCobranza(d, plantillaActiva));
        const wsUrl = tel ? `https://wa.me/56${tel.replace(/^56/,'')}?text=${msg}` : `https://wa.me/?text=${msg}`;
        const periodosTxt = d.periodosPendientes.map(p=>`${p.periodo} (${clp(p.monto)})`).join(' · ');
        return `
        <div class="card" style="margin-bottom:10px;border-left:3px solid ${colorEstado(d.estado)}">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;margin-bottom:8px">
            <div>
              <div style="font-weight:700;font-size:15px">${escHtml(d.alu.apellidos+', '+d.alu.nombres)}</div>
              <div style="font-size:12px;color:var(--t3);margin-top:1px">${d.apPrincipal?escHtml(d.apPrincipal.nombre)+' · '+escHtml(d.apPrincipal.telefono||'Sin teléfono'):'Sin '+V('contacto')+' registrado'}</div>
            </div>
            <div style="text-align:right;flex-shrink:0">
              <div style="font-size:20px;font-weight:900;color:#E24B4A">${clp(d.deudaTotal)}</div>
              <div style="font-size:10px;color:var(--t3)">${d.periodosPendientes.length} cuota${d.periodosPendientes.length!==1?'s':''} pendiente${d.periodosPendientes.length!==1?'s':''}</div>
            </div>
          </div>
          <div style="font-size:11px;color:var(--t2);background:var(--bg);border-radius:6px;padding:6px 10px;margin-bottom:10px">${escHtml(periodosTxt)}</div>
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:10px">
            <span style="font-size:11px;font-weight:700;color:${colorEstado(d.estado)}">${labelEstado(d.estado)}</span>
            ${d.ultimoContacto?`<span style="font-size:11px;color:var(--t3)">Último contacto: ${fmtDate(d.ultimoContacto)}</span>`:''}
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <a href="${wsUrl}" target="_blank" class="btn bp" style="font-size:12px;padding:6px 10px;text-decoration:none;border:none">💬 WhatsApp</a>
            ${tel?`<a href="tel:+56${tel.replace(/^56/,'')}" class="btn bs" style="font-size:12px;padding:6px 10px;text-decoration:none">📞 Llamar</a>`:''}
            <button class="btn bs" onclick="copiarMsgCobranza('${d.alu.id}','${plantillaActiva}')" style="font-size:12px;padding:6px 10px">📋 Copiar</button>
            <button class="btn bs" onclick="showModal('accionCobranza',{alumnoId:'${d.alu.id}'})" style="font-size:12px;padding:6px 10px">⚙️ Acción</button>
          </div>
        </div>`;
      }).join('');

  return `
  <div class="page-hdr">
    <div class="page-title">💬 Cobranza</div>
    <div style="display:flex;gap:6px">
      <button class="btn bs" onclick="actualizarCobranza(this)" style="font-size:12px">↻ Actualizar</button>
      <button class="btn bp" onclick="recordatorioMasivo('${plantillaActiva}')" style="background:#D97706;border:none">📢 Masivo</button>
    </div>
  </div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px">
    <div style="background:#FFF0F0;border-radius:12px;padding:12px;text-align:center">
      <div style="font-size:24px;font-weight:900;color:#E24B4A">${todos.length}</div>
      <div style="font-size:11px;color:var(--t3)">Deudores</div>
    </div>
    <div style="background:#FFF0F0;border-radius:12px;padding:12px;text-align:center">
      <div style="font-size:20px;font-weight:900;color:#E24B4A">${clp(totalDeuda)}</div>
      <div style="font-size:11px;color:var(--t3)">Total adeudado</div>
    </div>
    <div style="background:var(--gl);border-radius:12px;padding:12px;text-align:center">
      <div style="font-size:24px;font-weight:900;color:var(--g)">${contactados}</div>
      <div style="font-size:11px;color:var(--t3)">Ya contactados</div>
    </div>
    <div style="background:#FFF8E7;border-radius:12px;padding:12px;text-align:center">
      <div style="font-size:24px;font-weight:900;color:#D97706">${sinContactar}</div>
      <div style="font-size:11px;color:var(--t3)">Sin contactar</div>
    </div>
  </div>

  <div class="card" style="margin-bottom:14px;padding:12px 14px">
    <div style="font-size:12px;font-weight:700;color:var(--t3);margin-bottom:8px">PLANTILLA DE MENSAJE</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      ${['suave','directa','comprobante'].map(p=>`<button onclick="go('cobranza',{filtroCobranza:'${filtro}',plantillaCobranza:'${p}'})" style="padding:5px 12px;border-radius:16px;border:1.5px solid ${plantillaActiva===p?'var(--g)':'var(--brd)'};background:${plantillaActiva===p?'var(--gl)':'var(--wh)'};font-size:12px;font-weight:${plantillaActiva===p?'700':'400'};cursor:pointer;color:${plantillaActiva===p?'var(--g)':'var(--t2)'}">${p==='suave'?'😊 Suave':p==='directa'?'📌 Directa':'📎 Con comprobante'}</button>`).join('')}
    </div>
  </div>

  <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;overflow-x:auto;padding-bottom:4px">
    ${filtroBtn('todos','Todos ('+todos.length+')')}
    ${filtroBtn('mes','Este mes')}
    ${filtroBtn('acumulada','Acumulada')}
    ${filtroBtn('sin-contactar','Sin contactar ('+sinContactar+')')}
    ${filtroBtn('contactados','Contactados ('+contactados+')')}
  </div>

  <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
    <span style="font-size:12px;font-weight:700;color:var(--t3);white-space:nowrap">Ordenar por:</span>
    <select class="fs" style="font-size:12px;padding:6px 10px;width:auto"
      onchange="S.params.ordenCobranza=this.value;renderPage()">
      <option value="deuda-desc" ${orden==='deuda-desc'?'selected':''}>↓ Mayor deuda</option>
      <option value="deuda-asc"  ${orden==='deuda-asc' ?'selected':''}>↑ Menor deuda</option>
      <option value="alfa"       ${orden==='alfa'      ?'selected':''}>A–Z Apellido</option>
    </select>
  </div>

  ${tarjetas}`;
}

async function actualizarCobranza(btnEl){
  if(btnEl){ btnEl.disabled=true; btnEl.textContent='↻ Cargando…'; }
  try{
    await loadFromCloud(S.session?.id);
    go('cobranza', S.params);
    showToast('✓ Datos actualizados');
  }catch(e){
    showToast('⚠️ No se pudo actualizar — revisa tu red');
  }finally{
    if(btnEl){ btnEl.disabled=false; btnEl.textContent='↻ Actualizar'; }
  }
}

function copiarMsgCobranza(alumnoId, tipoPlantilla){
  const deudores = getDeudores();
  const d = deudores.find(x=>x.alu.id===alumnoId);
  if(!d) return;
  const msg = generarMensajeCobranza(d, tipoPlantilla);
  navigator.clipboard?.writeText(msg)
    .then(()=>showToast('¡Mensaje copiado!'))
    .catch(()=>alert(msg));
  setCobranzaEstado(alumnoId, 'recordado', 'Mensaje copiado');
  go('cobranza', S.params);
}

function recordatorioMasivo(tipoPlantilla){
  const deudores = getDeudores().filter(d=>d.estado==='pendiente'||d.estado==='pospuesto');
  if(!deudores.length){ alert('No hay deudores pendientes de contactar.'); return; }
  // Abrir panel paso a paso en vez de bucle automático
  _masivo = { deudores, idx: 0, plantilla: tipoPlantilla };
  mostrarPanelMasivo();
}

// Estado global del panel masivo
let _masivo = null;

function mostrarPanelMasivo(){
  if(!_masivo) return;
  const { deudores, idx, plantilla } = _masivo;

  // Eliminar panel anterior si existe
  document.getElementById('panel-masivo')?.remove();

  if(idx >= deudores.length){
    showToast('✅ Cobranza masiva completada — '+deudores.length+' recordatorios enviados');
    _masivo = null;
    go('cobranza', S.params);
    return;
  }

  const d = deudores[idx];
  const tel = (d.apPrincipal?.telefono||'').replace(/\D/g,'');
  const msg = generarMensajeCobranza(d, plantilla);
  const wsUrl = tel
    ? `https://wa.me/56${tel.replace(/^56/,'')}?text=${encodeURIComponent(msg)}`
    : `https://wa.me/?text=${encodeURIComponent(msg)}`;

  const panel = document.createElement('div');
  panel.id = 'panel-masivo';
  panel.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.7);display:flex;align-items:flex-end;justify-content:center';

  panel.innerHTML = `
    <div style="background:#fff;border-radius:20px 20px 0 0;padding:24px 20px 32px;width:100%;max-width:520px;box-shadow:0 -8px 32px rgba(0,0,0,.2)">
      <!-- Progreso -->
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <div style="font-size:13px;font-weight:700;color:var(--t3)">Cobranza masiva</div>
        <div style="font-size:13px;color:var(--t3)">${idx+1} de ${deudores.length}</div>
      </div>
      <div style="height:5px;background:var(--bg);border-radius:99px;margin-bottom:20px">
        <div style="height:5px;background:var(--g);border-radius:99px;width:${Math.round((idx/deudores.length)*100)}%;transition:.3s"></div>
      </div>

      <!-- Deudor actual -->
      <div style="background:var(--gl);border-radius:14px;padding:16px;margin-bottom:16px">
        <div style="font-size:16px;font-weight:800;color:var(--ng);margin-bottom:4px">
          ${escHtml(d.alu.apellidos)}, ${escHtml(d.alu.nombres)}
        </div>
        <div style="font-size:13px;color:var(--t2);margin-bottom:2px">
          📱 ${tel ? '+56'+tel.replace(/^56/,'') : '<span style="color:#E24B4A">Sin teléfono</span>'}
        </div>
        <div style="font-size:14px;font-weight:700;color:#E24B4A">💸 Deuda: ${clp(d.deudaTotal)}</div>
      </div>

      <!-- Mensaje prellenado -->
      <div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:10px;padding:12px;margin-bottom:20px;font-size:12px;color:var(--t2);line-height:1.6;max-height:80px;overflow-y:auto">
        ${escHtml(msg)}
      </div>

      <!-- Botones -->
      <div style="display:flex;flex-direction:column;gap:10px">
        ${tel
          ? `<a href="${wsUrl}" target="_blank" rel="noopener"
               onclick="setTimeout(()=>{ setCobranzaEstado('${d.alu.id}','recordado','Recordatorio masivo'); _masivo.idx++; mostrarPanelMasivo(); }, 1500)"
               style="display:flex;align-items:center;justify-content:center;gap:10px;background:#25D366;color:#fff;font-size:16px;font-weight:800;padding:14px;border-radius:14px;text-decoration:none;text-align:center">
               💬 Enviar por WhatsApp
             </a>`
          : `<button onclick="setCobranzaEstado('${d.alu.id}','recordado','Sin teléfono'); _masivo.idx++; mostrarPanelMasivo()"
               style="background:#E5E7EB;color:#6B7280;border:none;border-radius:14px;padding:14px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit">
               ⏭ Saltar (sin teléfono)
             </button>`
        }
        <button onclick="_masivo.idx++; mostrarPanelMasivo()"
          style="background:var(--bg);color:var(--t2);border:none;border-radius:14px;padding:12px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit">
          → Siguiente sin enviar
        </button>
        <button onclick="document.getElementById('panel-masivo').remove();_masivo=null;showToast('Cobranza pausada')"
          style="background:none;color:var(--t3);border:none;font-size:13px;cursor:pointer;padding:4px;font-family:inherit">
          Pausar y salir
        </button>
      </div>
    </div>`;

  document.body.appendChild(panel);
}

function modalAccionCobranza(data){
  const deudores = getDeudores();
  const d = deudores.find(x=>x.alu.id===data.alumnoId);
  if(!d) return '<div class="modal"><div class="modal-hdr"><div class="modal-title">Error</div><button class="close-btn" onclick="closeModal()">×</button></div></div>';
  return `<div class="modal">
    <div class="modal-hdr">
      <div class="modal-title">⚙️ ${escHtml(d.alu.nombres+' '+d.alu.apellidos)}</div>
      <button class="close-btn" onclick="closeModal()">×</button>
    </div>
    <div style="font-size:13px;color:var(--t2);margin-bottom:14px">Deuda: <strong style="color:#E24B4A">${clp(d.deudaTotal)}</strong></div>
    <div style="display:flex;flex-direction:column;gap:8px;max-height:520px;overflow-y:auto;padding-right:4px">
      <button class="btn bp" onclick="accionCobranzaSet('${d.alu.id}','recordado');closeModal();go('cobranza',S.params)">🟡 Marcar como recordado</button>
      <button class="btn" style="background:#EFF6FF;color:#2563EB;border:1px solid #BFDBFE" onclick="accionCobranzaSet('${d.alu.id}','compromiso');closeModal();go('cobranza',S.params)">🔵 Comprometió pago</button>
      <button class="btn" style="background:#F3F4F6;color:#6B7280;border:1px solid #E5E7EB" onclick="accionCobranzaSet('${d.alu.id}','pospuesto');closeModal();go('cobranza',S.params)">⏸ Posponer seguimiento</button>
      <button class="btn" style="background:#F0FDF4;color:#1D9E75;border:1px solid #BBF7D0" onclick="accionCobranzaSet('${d.alu.id}','pendiente');closeModal();go('cobranza',S.params)">🔴 Volver a pendiente</button>
    </div>
    ${d.historial.length?`
    <div style="margin-top:14px;border-top:1px solid var(--brd);padding-top:12px">
      <div style="font-size:12px;font-weight:700;color:var(--t3);margin-bottom:8px">HISTORIAL</div>
      ${d.historial.slice(-5).reverse().map(h=>`<div style="font-size:12px;color:var(--t2);padding:4px 0;border-bottom:1px solid var(--bg)">${fmtDate(h.fecha)} — ${h.estado}${h.nota?' · '+escHtml(h.nota):''}</div>`).join('')}
    </div>`:''}
  </div>`;
}

function accionCobranzaSet(alumnoId, estado){
  setCobranzaEstado(alumnoId, estado, '');
}



// ─── SALUDOS FECHAS ESPECIALES ────────────────────────────────────────────────
