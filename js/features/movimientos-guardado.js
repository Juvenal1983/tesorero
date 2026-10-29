// js/features/movimientos-guardado.js — extraído de la copia de demostración.
function saveMov(){
  const desc=document.getElementById('mv-desc').value.trim();
  const monto=parseInt(document.getElementById('mv-monto').value);
  if(!desc||!monto){alert('Completa descripción y monto.');return;}
  if(!DB.movimientos) DB.movimientos=[];
  const movId = uid();
  const archivosLocales = window._archivos ? [...window._archivos] : [];
  const mov = {
    id:movId,
    cursoId:S.cursoId,
    tipo:document.getElementById('mv-tipo').value,
    desc,
    monto,
    categoria:document.getElementById('mv-cat').value,
    fecha:document.getElementById('mv-fecha').value,
    responsable:document.getElementById('mv-resp').value,
    visible:document.getElementById('mv-visible').value==='true',
    obs:document.getElementById('mv-obs').value,
    creadoPor:S.session?.id||'',
    archivos: archivosLocales,
    _pendienteStorage: archivosLocales.length > 0 // flag: comprobante pendiente de subir
  };
  DB.movimientos.push(mov);
  window._archivos = [];
  saveDB();
  closeModal();
  go('movimientos');
  // Subir imágenes a Storage en segundo plano
  if(archivosLocales.length){
    showToast('⏳ Subiendo comprobante...');
    setTimeout(async ()=>{
      try{
        const urls = await subirArchivosStorage(archivosLocales, movId);
        const idx = (DB.movimientos||[]).findIndex(m=>m.id===movId);
        if(idx>=0 && urls && urls.length){
          const todosConUrl = urls.every(u=>u.url);
          DB.movimientos[idx].archivos = urls;
          if(todosConUrl) delete DB.movimientos[idx]._pendienteStorage; // solo si TODOS subieron con éxito
          saveDB(); // marca timestamp local optimista + sube a la nube de forma robusta
          if(todosConUrl){
            showToast('✅ Comprobante subido correctamente');
          } else {
            showToast('⚠️ Comprobante guardado localmente — pendiente de subir (revisa tu conexión)');
          }
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
