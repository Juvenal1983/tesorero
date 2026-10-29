// js/features/movimientos-formularios.js — extraído de la copia de demostración.
function modalMov(){
  const cur=getCurso();
  return `<div class="modal" style="max-width:540px">
    <div class="modal-hdr"><div class="modal-title">Nuevo movimiento</div><button class="close-btn" onclick="closeModal()">×</button></div>
    <div class="fg"><label class="fl">Tipo</label><select class="fs" id="mv-tipo"><option value="ingreso">↑ Ingreso extra</option><option value="gasto">↓ Gasto</option></select></div>
    <div class="fg"><label class="fl">Descripción</label><input class="fi" id="mv-desc" placeholder="Descripción del movimiento..."></div>
    <div class="fg-row">
      <div class="fg"><label class="fl">Monto (CLP)</label><input class="fi" id="mv-monto" type="number" placeholder="0"></div>
      <div class="fg"><label class="fl">Categoría</label><select class="fs" id="mv-cat">${(DB.categorias||[]).map(c=>`<option>${c}</option>`).join('')}</select></div>
    </div>
    <div class="fg-row">
      <div class="fg"><label class="fl">Fecha</label><input class="fi" id="mv-fecha" type="date" value="${isoToday()}"></div>
      <div class="fg"><label class="fl">Responsable</label><input class="fi" id="mv-resp" value="${escHtml(cur.tesorero||'')}"></div>
    </div>
    <div class="fg"><label class="fl">¿Visible para apoderados lectores?</label><select class="fs" id="mv-visible"><option value="true">Sí</option><option value="false">No (privado)</option></select></div>
    <div class="fg"><label class="fl">Observaciones</label><input class="fi" id="mv-obs" placeholder="Opcional..."></div>

    <!-- COMPROBANTES MÚLTIPLES -->
    <div style="border-top:1px solid var(--brd);margin-top:14px;padding-top:14px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="font-size:13px;font-weight:700;color:var(--t2)">📎 Comprobantes</div>
        <div id="mv-arch-count" style="font-size:12px;color:var(--t3)">0 archivos</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        <label style="flex:1;min-width:120px;display:flex;align-items:center;justify-content:center;gap:8px;padding:11px 10px;background:var(--gl);border:1.5px dashed var(--gm);border-radius:10px;cursor:pointer;font-size:13px;font-weight:600;color:var(--g);text-align:center">
          📷 Cámara
          <input type="file" accept="image/*" capture="environment" id="mv-file-cam" style="display:none" onchange="agregarArchivo(this)">
        </label>
        <label style="flex:1;min-width:120px;display:flex;align-items:center;justify-content:center;gap:8px;padding:11px 10px;background:var(--bl);border:1.5px dashed var(--b);border-radius:10px;cursor:pointer;font-size:13px;font-weight:600;color:var(--b);text-align:center">
          🗂 Archivos / PDF
          <input type="file" accept="image/*,application/pdf" id="mv-file-arch" multiple style="display:none" onchange="agregarArchivo(this)">
        </label>
      </div>
      <div id="mv-previews" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:4px"></div>
      <div style="font-size:11px;color:var(--t3);margin-top:8px">Máx. 4 MB por archivo · JPG, PNG, HEIC o PDF · Sin límite de cantidad</div>
    </div>

    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
      <button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn bp" onclick="try{saveMov();}catch(e){alert('Error: '+e.message);}">Guardar</button>
    </div>
  </div>`;
}

// ─── ARCHIVOS MÚLTIPLES (nuevo movimiento) ───────────────────────────
window._archivos = []; // [{data, nombre, tipo}]

function agregarArchivo(input){
  const files = Array.from(input.files||[]);
  let errores = [];
  const promises = files.map(file => new Promise(resolve=>{
    if(file.size > 4*1024*1024){ errores.push(file.name+' supera 4 MB'); resolve(); return; }
    const reader = new FileReader();
    reader.onload = e=>{
      window._archivos.push({data:e.target.result, nombre:file.name, tipo:file.type});
      resolve();
    };
    reader.readAsDataURL(file);
  }));
  Promise.all(promises).then(()=>{
    input.value='';
    if(errores.length) alert('Archivos omitidos (superan 4 MB):\n'+errores.join('\n'));
    renderPreviewsNuevo();
  });
}

function renderPreviewsNuevo(){
  const cont = document.getElementById('mv-previews');
  const count = document.getElementById('mv-arch-count');
  if(!cont) return;
  count.textContent = window._archivos.length + ' archivo' + (window._archivos.length!==1?'s':'');
  cont.innerHTML = window._archivos.map((a,i)=>`
    <div style="position:relative;width:72px">
      ${a.tipo==='application/pdf'
        ? `<div style="width:72px;height:72px;background:var(--rl);border-radius:8px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font-size:22px;cursor:default">📄<span style="font-size:9px;color:var(--r);font-weight:700">PDF</span></div>`
        : `<img src="${a.data}" style="width:72px;height:72px;object-fit:cover;border-radius:8px;display:block">`
      }
      <div style="font-size:9px;color:var(--t3);text-align:center;margin-top:3px;word-break:break-all;max-width:72px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${escHtml(a.nombre)}</div>
      <button onclick="quitarArchivoNuevo(${i})" style="position:absolute;top:-5px;right:-5px;background:#E24B4A;color:#fff;border:none;border-radius:50%;width:20px;height:20px;font-size:12px;cursor:pointer;line-height:1;padding:0;display:flex;align-items:center;justify-content:center">×</button>
    </div>`).join('');
}

function quitarArchivoNuevo(i){
  window._archivos.splice(i,1);
  renderPreviewsNuevo();
}

function previewComprobante(input){ agregarArchivo(input); } // compatibilidad
function clearComprobante(){
  window._archivos=[];
  renderPreviewsNuevo();
}


// ─────────────────────────────────────────────
// IMPORTACIÓN / EXPORTACIÓN EXCEL
// ─────────────────────────────────────────────

