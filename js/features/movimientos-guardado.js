// js/features/movimientos-guardado.js — extraído de la copia de demostración.
async function saveMov(){
  const desc=document.getElementById('mv-desc').value.trim();
  const monto=parseInt(document.getElementById('mv-monto').value);
  if(!desc||!monto){alert('Completa descripción y monto.');return;}

  const archivosLocales = window._archivos ? [...window._archivos] : [];
  const movData = {
    cursoId:    S.cursoId,
    tipo:       document.getElementById('mv-tipo').value,
    desc,
    monto,
    categoria:  document.getElementById('mv-cat').value,
    fecha:      document.getElementById('mv-fecha').value,
    responsable:document.getElementById('mv-resp').value,
    visible:    document.getElementById('mv-visible').value==='true',
    obs:        document.getElementById('mv-obs').value,
    creadoPor:  S.session?.id||'',
    archivos:   archivosLocales,
    _pendienteStorage: archivosLocales.length > 0,
  };

  // ── V9_RELACIONAL: persistir en Supabase ──────────────────────────────────
  if (typeof V9_RELACIONAL !== 'undefined' && V9_RELACIONAL) {
    if (!S._v9CuentaId) { alert('⚠️ Sesión relacional no inicializada (falta _v9CuentaId).'); return; }
    const btn = document.querySelector('[onclick*="saveMov"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }
    try {
      const dbRow = await crearMovimientoV9(S._v9CuentaId, S.cursoId, movData, _authToken);
      if (!DB.movimientos) DB.movimientos = [];
      DB.movimientos.push(_mapMovimiento({ ...dbRow, archivos: archivosLocales }));
      window._archivos = [];
      closeModal();
      go('movimientos');
      // Subir comprobantes y persistir URLs en PostgreSQL
      if (archivosLocales.length) {
        showToast('⏳ Subiendo comprobante...');
        setTimeout(async () => {
          try {
            const urls = await subirArchivosStorage(archivosLocales, dbRow.id);
            if (!urls?.length) {
              showToast('⚠️ No se pudo subir el comprobante — queda pendiente. Usa "↑ Subir pendientes" para reintentar.');
              return;
            }
            const todosConUrl = urls.every(u => u.url);
            const primerUrl   = (urls.find(u => u.url) || {}).url || null;

            // Persistir URLs en PostgreSQL ANTES de anunciar éxito
            // Nunca guardar base64 como solución permanente
            const patchData = { archivos: urls };
            if (primerUrl) patchData.comprobante = primerUrl;
            await actualizarMovimientoV9(S._v9CuentaId, dbRow.id, patchData, _authToken);

            // Actualizar caché local solo tras confirmación del servidor
            const idx = (DB.movimientos||[]).findIndex(m => m.id === dbRow.id);
            if (idx >= 0) {
              DB.movimientos[idx].archivos   = urls;
              if (primerUrl) DB.movimientos[idx].comprobante = primerUrl;
              if (todosConUrl) delete DB.movimientos[idx]._pendienteStorage;
            }
            showToast(todosConUrl ? '✅ Comprobante guardado correctamente' : '⚠️ Comprobante guardado parcialmente');
            go('movimientos');
          } catch(e) {
            console.warn('[saveMov v9] Error subiendo/persistiendo comprobante:', e);
            showToast('⚠️ Error al guardar comprobante: ' + (e.message || e));
          }
        }, 500);
      }
    } catch (err) {
      console.error('[saveMov v9]', err);
      showToast('❌ Error al guardar movimiento: ' + (err.message || err), '#E24B4A');
      if (btn) { btn.disabled = false; btn.textContent = 'Guardar'; }
    }
    return;
  }
  // ── legado: blob local ────────────────────────────────────────────────────
  if(!DB.movimientos) DB.movimientos=[];
  const movId = uid();
  const mov = { id:movId, ...movData };
  DB.movimientos.push(mov);
  window._archivos = [];
  saveDB();
  closeModal();
  go('movimientos');
  if(archivosLocales.length){
    showToast('⏳ Subiendo comprobante...');
    setTimeout(async ()=>{
      try{
        const urls = await subirArchivosStorage(archivosLocales, movId);
        const idx = (DB.movimientos||[]).findIndex(m=>m.id===movId);
        if(idx>=0 && urls && urls.length){
          const todosConUrl = urls.every(u=>u.url);
          DB.movimientos[idx].archivos = urls;
          if(todosConUrl) delete DB.movimientos[idx]._pendienteStorage;
          saveDB();
          if(todosConUrl){ showToast('✅ Comprobante subido correctamente'); }
          else { showToast('⚠️ Comprobante guardado localmente — pendiente de subir'); }
          go('movimientos');
        } else {
          showToast('⚠️ No se pudo subir el comprobante — queda pendiente. Usa "↑ Subir pendientes" para reintentar.');
        }
      }catch(e){
        console.warn('Error subiendo comprobante:', e);
        showToast('⚠️ Error al subir comprobante — queda pendiente');
      }
    }, 500);
  }
}

function bindModal(){ /* bindings done inline via onclick */ }

// ─── COMPROBANTES ────────────────────────────────────────────────────
// Devuelve siempre un array de {data,nombre,tipo}, compatible con formato antiguo
