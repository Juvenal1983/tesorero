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
async function delCuota(id){
  if(!puedeEscribir()){ showToast('⛔ Sin permisos para eliminar cuotas','#E24B4A'); return; }

  // ── V9_RELACIONAL: eliminar en Supabase ───────────────────────────────────
  if (typeof V9_RELACIONAL !== 'undefined' && V9_RELACIONAL) {
    if (!S._v9CuentaId) { alert('⚠️ Sesión relacional no inicializada (falta _v9CuentaId).'); return; }

    // Bloquear si la cuota tiene pagos registrados (historial financiero protegido)
    const pagosCuota = (DB.pagos||[]).filter(p => p.cuotaId === id);
    if (pagosCuota.length > 0) {
      const cuota = (DB.cuotas||[]).find(q => q.id === id);
      alert(
        `⛔ No se puede eliminar: la cuota "${cuota?.nombre || id}" tiene ${pagosCuota.length} pago${pagosCuota.length !== 1 ? 's' : ''} registrado${pagosCuota.length !== 1 ? 's' : ''}.\n\n` +
        'El historial financiero no puede borrarse. Puedes desactivar la cuota cambiando su estado a "Inactiva" en lugar de eliminarla.'
      );
      return;
    }

    const cuota = (DB.cuotas||[]).find(q => q.id === id);
    if (!confirm(`¿Eliminar la cuota "${cuota?.nombre || id}"? Esta acción no se puede deshacer.`)) return;

    try {
      await eliminarCuotaV9(S._v9CuentaId, id, _authToken);
      // Actualizar caché local solo tras confirmación del servidor
      DB.cuotas = (DB.cuotas||[]).filter(q => q.id !== id);
      // DB.pagos no se toca — no había pagos (verificado arriba)
      go('cuotas');
    } catch (err) {
      console.error('[delCuota v9]', err);
      showToast('❌ Error al eliminar cuota: ' + (err.message || err), '#E24B4A');
    }
    return;
  }
  // ── legado ────────────────────────────────────────────────────────────────
  if(!confirm('¿Eliminar esta cuota? Los pagos asociados también serán eliminados.')) return;
  DB.cuotas=(DB.cuotas||[]).filter(q=>q.id!==id);
  DB.pagos=(DB.pagos||[]).filter(p=>p.cuotaId!==id);
  saveDB(); go('cuotas');
}

// ─────────────────────────────────────────────
// PAGOS
// ─────────────────────────────────────────────
