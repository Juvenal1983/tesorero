// js/features/cuotas.js — extraído de la copia de demostración.
function renderCuotas(){
  const lista = getCuotas();
  return `
  <div class="page-hdr">
    <div class="page-title">Configuración de ${V('grupo').toLowerCase()}s</div>
    ${puedeEscribir()?`<button class="btn bp" onclick="showModal('addCuota')">+ Nueva cuota</button>`:''}
  </div>
  <div class="card">
    ${lista.length===0?`<div class="empty-state"><div class="empty-icon">💳</div><div>Sin cuotas configuradas</div></div>`:`
    <div class="tbl-wrap"><table>
      <thead><tr><th>Nombre</th><th>Tipo</th><th>Monto</th><th>Año</th><th>Observaciones</th>${puedeEscribir()?'<th></th>':''}</tr></thead>
      <tbody>
        ${lista.map(q=>`<tr>
          <td style="font-weight:600">${escHtml(q.nombre)}</td>
          <td><span class="badge ${q.tipo==='mensual'?'bgb':q.tipo==='anual'?'bga':'bgg'}">${q.tipo||'—'}</span></td>
          <td style="font-weight:700;color:var(--g)">${clp(q.monto)}</td>
          <td>${q.anio||'—'}</td>
          <td style="color:var(--t3);font-size:13px">${escHtml(q.obs||'—')}</td>
          ${puedeEscribir()?`<td style="white-space:nowrap">
            <button class="btn bs" onclick="showModal('editCuota',{id:'${q.id}'})">✏️</button>
            <button class="btn bs bd" onclick="delCuota('${q.id}')">🗑</button>
          </td>`:''}
        </tr>`).join('')}
      </tbody>
    </table></div>`}
  </div>`;
}
function delCuota(id){
  if(!puedeEscribir()){ showToast('⛔ Sin permisos para eliminar cuotas','#E24B4A'); return; }
  // B4-fix: en modo relacional v9, la eliminación de cuotas debe ir a Supabase.
  // Bloquear hasta implementar el CRUD relacional para cuotas.
  if(typeof V9_RELACIONAL!=='undefined' && V9_RELACIONAL){
    alert('⚠️ La eliminación de cuotas no está disponible en el modo relacional v9 todavía.\n\nEsta función requiere integración con la tabla cuotas de Supabase (pendiente de implementar).');
    return;
  }
  if(!confirm('¿Eliminar esta cuota? Los pagos asociados también serán eliminados.')) return;
  DB.cuotas=(DB.cuotas||[]).filter(q=>q.id!==id);
  DB.pagos=(DB.pagos||[]).filter(p=>p.cuotaId!==id);
  saveDB(); go('cuotas');
}

// ─────────────────────────────────────────────
// PAGOS
// ─────────────────────────────────────────────
