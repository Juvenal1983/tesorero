// js/features/cuotas-formularios.js — extraído de la copia de demostración.
function modalCuota(id){
  const q=id?(DB.cuotas||[]).find(x=>x.id===id):null;
  return `<div class="modal">
    <div class="modal-hdr"><div class="modal-title">${q?'Editar cuota':'Nueva cuota'}</div><button class="close-btn" onclick="closeModal()">×</button></div>
    <div class="fg"><label class="fl">Nombre de la cuota</label><input class="fi" id="q-nombre" value="${escHtml(q?.nombre||'')}"></div>
    <div class="fg-row">
      <div class="fg"><label class="fl">Tipo</label><select class="fs" id="q-tipo" onchange="toggleMesesCuota(this.value)"><option value="mensual"${!q||q.tipo==='mensual'?' selected':''}>Mensual</option><option value="anual"${q?.tipo==='anual'?' selected':''}>Anual</option><option value="extraordinaria"${q?.tipo==='extraordinaria'?' selected':''}>Extraordinaria</option></select></div>
      <div class="fg"><label class="fl">Monto (CLP)</label><input class="fi" id="q-monto" type="number" value="${q?.monto||5000}"></div>
    </div>
    <div class="fg-row">
      <div class="fg"><label class="fl">Año</label><input class="fi" id="q-anio" type="number" value="${q?.anio||2026}"></div>
    </div>
    <div id="q-meses-row" style="display:${!q||q.tipo==='mensual'?'':'none'}">
      <div class="fg-row">
        <div class="fg"><label class="fl">Mes de inicio</label>
          <select class="fs" id="q-mes-inicio">
            ${MESES.map((m,i)=>`<option value="${i}" ${(q?.mesInicio!==undefined?q.mesInicio:2)===i?'selected':''}>${m}</option>`).join('')}
          </select>
        </div>
        <div class="fg"><label class="fl">Mes de término</label>
          <select class="fs" id="q-mes-termino">
            ${MESES.map((m,i)=>`<option value="${i}" ${(q?.mesTermino!==undefined?q.mesTermino:11)===i?'selected':''}>${m}</option>`).join('')}
          </select>
        </div>
      </div>
    </div>
    <div class="fg"><label class="fl">Observaciones</label><textarea class="ft" id="q-obs">${escHtml(q?.obs||'')}</textarea></div>
    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn bp" onclick="saveCuota('${id||''}')">${q?'Guardar':'Crear cuota'}</button>
    </div>
  </div>`;
}

