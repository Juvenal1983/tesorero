// js/features/comprobantes.js

// ── getArchivos ───────────────────────────────────────────────────────────────
// Normaliza los datos del movimiento a un array de archivos.
// Soporta tres formatos:
//   1. m.archivos (JSONB): array { storagePath, nombre, tipo } (nuevo)
//                         o array { url, nombre, tipo } (legado Storage)
//                         o array { data, nombre, tipo } (legado base64)
//   2. m.comprobante (TEXT): puede ser:
//      a) storagePath (nuevo): "{uuid}/{cursoId}/{movId}/{file}"
//      b) URL firmada (legado): "https://…supabase.co/storage/v1/sign/…"
//      c) base64 (antiguo): "data:image/…;base64,…"
function getArchivos(m){
  if(!m) return [];
  if(Array.isArray(m.archivos) && m.archivos.length) return m.archivos;
  // Compatibilidad con formato antiguo (un solo comprobante en campo comprobante)
  if(m.comprobante){
    const c = m.comprobante;
    const nombre = m.comprobanteNombre || 'comprobante';
    const tipo   = m.comprobanteTipo   || 'application/octet-stream';
    if(c.startsWith('https://') || c.startsWith('http://')){
      // URL firmada legada (puede estar expirada)
      return [{ url: c, nombre, tipo }];
    } else if(c.startsWith('data:')){
      // base64 antiguo
      return [{ data: c, nombre, tipo: m.comprobanteTipo || 'image/jpeg' }];
    } else {
      // storagePath (nuevo formato): p.ej. "uuid/cursoId/movId/file.pdf"
      return [{ storagePath: c, nombre, tipo }];
    }
  }
  return [];
}

// ── getArchivoSrc ─────────────────────────────────────────────────────────────
// Devuelve la fuente para un <img src="…"> o mostrar una miniatura.
// Para archivos con solo storagePath, devuelve '' (sin URL disponible);
// el template debe mostrar un icono genérico en ese caso.
function getArchivoSrc(a){
  if(a.url)         return a.url;
  if(a.data)        return a.data;
  if(a.storagePath) return '';  // URL se genera on-demand al abrir, no al previsualizar
  return '';
}

// ── verComprobante ────────────────────────────────────────────────────────────
// Abre el comprobante en una nueva pestaña.
//
// Para archivos con storagePath (nuevo formato):
//   - Abre window.open('about:blank') ANTES del await (evita bloqueo del popup).
//   - Genera URL firmada de 1 hora on-demand (generarUrlFirmadaStorage).
//   - Redirige la ventana al resultado.
//
// Para archivos con url (legado Storage):
//   - Abre directamente (URL firmada anterior; puede estar expirada).
//
// Para archivos con data (base64 antiguo):
//   - Genera Blob URL o embeds HTML con img.
//
async function verComprobante(movId, idx){
  const m=(DB.movimientos||[]).find(x=>x.id===movId);
  const archs=getArchivos(m);
  const a=archs[idx||0];
  if(!a) return;

  // ── Nuevo formato: storagePath ─────────────────────────────────────────────
  if(a.storagePath){
    // Abrir ventana en blanco SINCRÓNICAMENTE (antes de cualquier await)
    // para que el navegador no bloquee el popup (el gesto del usuario sigue activo).
    const w = window.open('about:blank', '_blank');
    try {
      const signedUrl = await generarUrlFirmadaStorage(a.storagePath, 3600);
      if(w && signedUrl){
        w.location.href = signedUrl;
      } else if(w){
        // No se pudo generar URL firmada — mostrar mensaje en la ventana
        w.document.write(
          '<html><body style="font-family:sans-serif;padding:40px;text-align:center">' +
          '<h3>⚠️ No se pudo obtener el comprobante</h3>' +
          '<p>Recarga la página e inténtalo de nuevo.</p>' +
          '</body></html>'
        );
        w.document.close();
      }
    } catch(e) {
      console.warn('[verComprobante] Error generando URL firmada:', e);
      if(w) w.close();
    }
    return;
  }

  // ── Legado: url (URL firmada o pública anterior) ───────────────────────────
  if(a.url && a.tipo !== 'application/pdf'){
    // Imagen en Storage (URL puede estar expirada si tiene más de 1 hora)
    const w=window.open('','_blank');
    if(w) w.document.write(
      '<html><body style="margin:0;background:#000;display:flex;align-items:center;' +
      'justify-content:center;min-height:100vh">' +
      '<img src="'+a.url+'" style="max-width:100%;max-height:100vh"></body></html>'
    );
    return;
  }
  if(a.url && a.tipo==='application/pdf'){
    window.open(a.url,'_blank');
    return;
  }

  // ── Legado: base64 ─────────────────────────────────────────────────────────
  if(a.tipo==='application/pdf' && a.data){
    const byteStr=atob(a.data.split(',')[1]);
    const ab=new ArrayBuffer(byteStr.length);
    const ia=new Uint8Array(ab);
    for(let i=0;i<byteStr.length;i++) ia[i]=byteStr.charCodeAt(i);
    const blob=new Blob([ab],{type:'application/pdf'});
    window.open(URL.createObjectURL(blob),'_blank');
  } else if(a.data) {
    const win=window.open('','_blank');
    const imgHtml=
      '<html><body style="margin:0;background:#000;display:flex;align-items:center;' +
      'justify-content:center;min-height:100vh">' +
      '<img src="'+a.data+'" style="max-width:100%;max-height:100vh;object-fit:contain">' +
      '</body></html>';
    if(win){ win.document.write(imgHtml); win.document.close(); }
  }
}

function modalAddComprobante(movId){
  const m=(DB.movimientos||[]).find(x=>x.id===movId);
  if(!m) return '';
  const archs=getArchivos(m);
  window._acArchivos=[...archs]; // copia editable
  const galeria=archs.length ? `
    <div style="margin-bottom:14px">
      <div style="font-size:12px;font-weight:700;color:var(--t3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Archivos actuales (${archs.length})</div>
      <div id="ac-galeria" style="display:flex;flex-wrap:wrap;gap:8px">${archs.map((a,i)=>`
        <div style="position:relative;width:72px">
          ${a.tipo==='application/pdf' || (a.storagePath && a.storagePath.endsWith('.pdf'))
            ? `<div onclick="verComprobante('${movId}',${i})" style="width:72px;height:72px;background:var(--rl);border-radius:8px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;cursor:pointer;font-size:22px">📄<span style="font-size:9px;color:var(--r);font-weight:700">PDF</span></div>`
            : a.storagePath
              ? `<div onclick="verComprobante('${movId}',${i})" style="width:72px;height:72px;background:var(--bl);border-radius:8px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;cursor:pointer;font-size:22px">📎<span style="font-size:9px;color:var(--b);font-weight:700">VER</span></div>`
              : `<img src="${getArchivoSrc(a)}" onclick="verComprobante('${movId}',${i})" style="width:72px;height:72px;object-fit:cover;border-radius:8px;cursor:pointer">`}
          <div style="font-size:9px;color:var(--t3);text-align:center;margin-top:2px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:72px">${escHtml(a.nombre)}</div>
          <button onclick="quitarArchivoModal(${i})" style="position:absolute;top:-5px;right:-5px;background:#E24B4A;color:#fff;border:none;border-radius:50%;width:20px;height:20px;font-size:12px;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center">×</button>
        </div>`).join('')}
      </div>
    </div>` : '';

  return `<div class="modal" style="max-width:500px">
    <div class="modal-hdr">
      <div class="modal-title">📎 Comprobantes del gasto</div>
      <button class="close-btn" onclick="closeModal()">×</button>
    </div>
    <div class="alert ag" style="margin-bottom:14px">
      <strong>${escHtml(m.desc||'')}</strong> · ${clp(m.monto)} · ${fmtDate(m.fecha)}
    </div>
    <div id="ac-galeria-wrap">${galeria}</div>
    <div style="font-size:13px;font-weight:700;color:var(--t2);margin-bottom:10px">Agregar más archivos:</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
      <label style="flex:1;min-width:130px;display:flex;align-items:center;justify-content:center;gap:8px;padding:13px 10px;background:var(--gl);border:1.5px dashed var(--gm);border-radius:10px;cursor:pointer;font-size:13px;font-weight:600;color:var(--g)">
        📷 Cámara
        <input type="file" accept="image/*" capture="environment" id="ac-file-cam" style="display:none" onchange="agregarArchivoModal(this)">
      </label>
      <label style="flex:1;min-width:130px;display:flex;align-items:center;justify-content:center;gap:8px;padding:13px 10px;background:var(--bl);border:1.5px dashed var(--b);border-radius:10px;cursor:pointer;font-size:13px;font-weight:600;color:var(--b)">
        🗂 Archivos / PDF
        <input type="file" accept="image/*,application/pdf" multiple id="ac-file-arch" style="display:none" onchange="agregarArchivoModal(this)">
      </label>
    </div>
    <div id="ac-preview-nuevos" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px"></div>
    <div style="font-size:11px;color:var(--t3);margin-bottom:14px">Máx. 4 MB por archivo · Sin límite de cantidad</div>
    <div id="ac-err" class="alert ar" style="display:none;margin-bottom:10px"></div>
    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn bp" onclick="saveComprobante('${movId}')">Guardar cambios</button>
    </div>
  </div>`;
}

function agregarArchivoModal(input){
  const files=Array.from(input.files||[]);
  const errores=[];
  const promises=files.map(file=>new Promise(resolve=>{
    if(file.size>4*1024*1024){errores.push(file.name);resolve();return;}
    const reader=new FileReader();
    reader.onload=e=>{window._acArchivos.push({data:e.target.result,nombre:file.name,tipo:file.type});resolve();};
    reader.readAsDataURL(file);
  }));
  Promise.all(promises).then(()=>{
    input.value='';
    if(errores.length) alert('Omitidos (>4 MB):\n'+errores.join('\n'));
    renderGaleriaModal();
  });
}

function quitarArchivoModal(i){
  window._acArchivos.splice(i,1);
  renderGaleriaModal();
}

function renderGaleriaModal(){
  const wrap=document.getElementById('ac-galeria-wrap');
  if(!wrap) return;
  const all=window._acArchivos||[];
  if(!all.length){wrap.innerHTML='';return;}
  wrap.innerHTML=`<div style="margin-bottom:14px">
    <div style="font-size:12px;font-weight:700;color:var(--t3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Archivos (${all.length})</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px">${all.map((a,i)=>`
      <div style="position:relative;width:72px">
        ${a.tipo==='application/pdf'
          ?`<div style="width:72px;height:72px;background:var(--rl);border-radius:8px;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:22px;gap:2px">📄<span style="font-size:9px;color:var(--r);font-weight:700">PDF</span></div>`
          : a.storagePath
            ?`<div style="width:72px;height:72px;background:var(--bl);border-radius:8px;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:22px;gap:2px">📎<span style="font-size:9px;color:var(--b);font-weight:700">ARK</span></div>`
            :`<img src="${getArchivoSrc(a)}" style="width:72px;height:72px;object-fit:cover;border-radius:8px">`}
        <div style="font-size:9px;color:var(--t3);text-align:center;margin-top:2px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:72px">${escHtml(a.nombre)}</div>
        <button onclick="quitarArchivoModal(${i})" style="position:absolute;top:-5px;right:-5px;background:#E24B4A;color:#fff;border:none;border-radius:50%;width:20px;height:20px;font-size:12px;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center">×</button>
      </div>`).join('')}
    </div>
  </div>`;
}

function previewComprobanteModal(input){ agregarArchivoModal(input); } // compat
function clearComprobanteModal(){ window._acArchivos=[]; renderGaleriaModal(); }

function saveComprobante(movId){
  const i=(DB.movimientos||[]).findIndex(m=>m.id===movId); if(i<0) return;
  DB.movimientos[i].archivos=[...window._acArchivos];
  // Limpiar campos de formato antiguo si existen
  delete DB.movimientos[i].comprobante;
  delete DB.movimientos[i].comprobanteNombre;
  delete DB.movimientos[i].comprobanteTipo;
  window._acArchivos=[];
  saveDB(); closeModal(); go('movimientos');
}

function quitarComprobante(movId){
  if(!confirm('¿Eliminar todos los comprobantes de este gasto?')) return;
  const i=(DB.movimientos||[]).findIndex(m=>m.id===movId); if(i<0) return;
  DB.movimientos[i].archivos=[];
  delete DB.movimientos[i].comprobante;
  delete DB.movimientos[i].comprobanteNombre;
  delete DB.movimientos[i].comprobanteTipo;
  saveDB(); closeModal(); go('movimientos');
}
