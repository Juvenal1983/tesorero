// js/features/notas.js — extraído de la copia de demostración.
function renderNotas(){
  DB.notas = DB.notas || [];
  const notas = DB.notas;
  const novedadVisto = previewStorage.getItem('notas_novedad_visto');

  const bannerNovedad = !novedadVisto ? `
    <div id="banner-novedad" style="background:linear-gradient(135deg,#0F6E56,#0a5240);color:#fff;border-radius:12px;padding:14px 18px;margin-bottom:18px;display:flex;align-items:center;gap:12px;box-shadow:0 2px 8px rgba(15,110,86,.25)">
      <span style="font-size:24px">🎉</span>
      <div style="flex:1">
        <div style="font-weight:700;font-size:14px;margin-bottom:2px">¡Nueva función disponible!</div>
        <div style="font-size:13px;opacity:.9">Ahora puedes dejar notas y recordatorios en tu <strong>Libreta</strong>. Accede desde el menú lateral o desde <em>Más</em> en el celular.</div>
      </div>
      <button type="button" onclick="cerrarBannerNovedad()" style="background:rgba(255,255,255,.2);border:none;color:#fff;border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer;white-space:nowrap">Entendido ✓</button>
    </div>` : '';

  const notasFijas = notas.filter(n=>n.fijada);
  const notasNorm  = notas.filter(n=>!n.fijada);
  const ordenadas  = [...notasFijas, ...notasNorm];

  const colorOps = ['#FFF9C4','#C8E6C9','#BBDEFB','#FCE4EC','#E1BEE7','#FFE0B2'];

  const tarjetaHTML = (n) => `
    <div id="tarjeta-${n.id}" style="background:${n.color||'var(--wh)'};border:1.5px solid var(--brd);border-radius:10px;padding:14px 16px;position:relative;box-shadow:0 1px 4px rgba(0,0,0,.07)">
      ${n.fijada ? `<span style="position:absolute;top:10px;right:44px;font-size:15px" title="Fijada">📌</span>` : ''}
      <button type="button" onclick="eliminarNota('${n.id}')" title="Eliminar" style="position:absolute;top:8px;right:10px;background:none;border:none;cursor:pointer;font-size:16px;opacity:.5;line-height:1">✕</button>
      <div id="texto-${n.id}" style="font-size:14px;color:var(--t1);white-space:pre-wrap;margin-bottom:10px;padding-right:24px">${n.texto.replace(/</g,'&lt;')}</div>
      <textarea id="edit-${n.id}" style="display:none;width:100%;box-sizing:border-box;padding:8px;border:1.5px solid var(--brd);border-radius:8px;font-size:14px;resize:vertical;font-family:inherit;background:rgba(255,255,255,.7);color:var(--t1);margin-bottom:8px" rows="3">${n.texto.replace(/</g,'&lt;')}</textarea>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="font-size:11px;color:var(--t3)">${new Date(n.fecha).toLocaleDateString('es-CL',{day:'2-digit',month:'short',year:'numeric'})}</span>
        <button type="button" onclick="fijarNota('${n.id}')" style="font-size:11px;background:none;border:1px solid var(--brd);border-radius:8px;padding:2px 8px;cursor:pointer;color:var(--t2)">${n.fijada?'Desfijar':'Fijar 📌'}</button>
        <button type="button" id="btn-edit-${n.id}" onclick="editarNota('${n.id}')" style="font-size:11px;background:none;border:1px solid var(--brd);border-radius:8px;padding:2px 8px;cursor:pointer;color:var(--t2)">✏️ Editar</button>
        <button type="button" id="btn-save-${n.id}" onclick="guardarEdicionNota('${n.id}')" style="display:none;font-size:11px;background:var(--g);color:#fff;border:none;border-radius:8px;padding:2px 8px;cursor:pointer;font-weight:600">Guardar</button>
        <button type="button" id="btn-cancel-${n.id}" onclick="cancelarEdicionNota('${n.id}')" style="display:none;font-size:11px;background:none;border:1px solid var(--brd);border-radius:8px;padding:2px 8px;cursor:pointer;color:var(--t2)">Cancelar</button>
      </div>
    </div>`;

  const notasHTML = ordenadas.length
    ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px">${ordenadas.map(tarjetaHTML).join('')}</div>`
    : `<div style="text-align:center;padding:48px 0;color:var(--t3)"><div style="font-size:40px;margin-bottom:10px">📓</div><div style="font-size:15px">Aún no tienes notas. ¡Crea la primera!</div></div>`;

  const coloresHTML = colorOps.map(c=>`<span onclick="document.getElementById('nota-color').value='${c}';document.querySelectorAll('.color-dot').forEach(d=>d.style.outline='none');this.style.outline='2.5px solid #333'" class="color-dot" style="display:inline-block;width:22px;height:22px;background:${c};border-radius:50%;cursor:pointer;border:1.5px solid rgba(0,0,0,.1)"></span>`).join('');

  return `
  <div style="max-width:860px;margin:0 auto;padding:0 0 40px">
    ${bannerNovedad}
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;flex-wrap:wrap;gap:10px">
      <h2 style="margin:0;font-size:20px;font-weight:700;color:var(--t1)">📓 Libreta de notas</h2>
      <button type="button" onclick="mostrarFormNota()" id="btn-nueva-nota" style="background:var(--g);color:#fff;border:none;border-radius:8px;padding:9px 18px;font-size:14px;font-weight:600;cursor:pointer">+ Nueva nota</button>
    </div>

    <!-- Formulario nueva nota (oculto por defecto) -->
    <div id="form-nota" style="display:none;background:var(--wh);border:1.5px solid var(--brd);border-radius:12px;padding:18px;margin-bottom:20px;box-shadow:0 2px 8px rgba(0,0,0,.08)">
      <textarea id="nota-texto" placeholder="Escribe tu nota o recordatorio aquí…" rows="4"
        style="width:100%;box-sizing:border-box;padding:10px;border:1.5px solid var(--brd);border-radius:8px;font-size:14px;resize:vertical;font-family:inherit;background:var(--bg);color:var(--t1)"></textarea>
      <input type="hidden" id="nota-color" value="#FFF9C4">
      <div style="display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap">
        <span style="font-size:13px;color:var(--t2)">Color:</span>
        ${coloresHTML}
        <div style="flex:1"></div>
        <button type="button" onclick="guardarNota()" style="background:var(--g);color:#fff;border:none;border-radius:8px;padding:8px 20px;font-size:13px;font-weight:600;cursor:pointer">Guardar</button>
        <button type="button" onclick="document.getElementById('form-nota').style.display='none'" style="background:var(--bg);color:var(--t2);border:1px solid var(--brd);border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer">Cancelar</button>
      </div>
    </div>

    ${notasHTML}
  </div>`;
}

function mostrarFormNota(){
  const f = document.getElementById('form-nota');
  if(f){ f.style.display='block'; document.getElementById('nota-texto').focus(); }
}

function guardarNota(){
  DB.notas = DB.notas || [];
  const texto = (document.getElementById('nota-texto')?.value||'').trim();
  if(!texto){ alert('Escribe algo antes de guardar.'); return; }
  const color = document.getElementById('nota-color')?.value || '#FFF9C4';
  DB.notas.unshift({ id: 'n'+Date.now(), texto, color, fecha: new Date().toISOString(), fijada: false });
  saveDB();
  renderPage();
}

function eliminarNota(id){
  if(!confirm('¿Eliminar esta nota?')) return;
  DB.notas = (DB.notas||[]).filter(n=>n.id!==id);
  saveDB();
  renderPage();
}

function fijarNota(id){
  DB.notas = (DB.notas||[]).map(n=> n.id===id ? {...n, fijada:!n.fijada} : n);
  saveDB();
  renderPage();
}

function cerrarBannerNovedad(){
  previewStorage.setItem('notas_novedad_visto','1');
  const b = document.getElementById('banner-novedad');
  if(b) b.remove();
}

function editarNota(id){
  document.getElementById('texto-'+id).style.display='none';
  document.getElementById('edit-'+id).style.display='block';
  document.getElementById('btn-edit-'+id).style.display='none';
  document.getElementById('btn-save-'+id).style.display='inline-block';
  document.getElementById('btn-cancel-'+id).style.display='inline-block';
  document.getElementById('edit-'+id).focus();
}

function cancelarEdicionNota(id){
  document.getElementById('texto-'+id).style.display='block';
  document.getElementById('edit-'+id).style.display='none';
  document.getElementById('btn-edit-'+id).style.display='inline-block';
  document.getElementById('btn-save-'+id).style.display='none';
  document.getElementById('btn-cancel-'+id).style.display='none';
}

function guardarEdicionNota(id){
  const nuevoTexto = (document.getElementById('edit-'+id)?.value||'').trim();
  if(!nuevoTexto){ alert('La nota no puede estar vacía.'); return; }
  DB.notas = (DB.notas||[]).map(n=> n.id===id ? {...n, texto:nuevoTexto} : n);
  saveDB();
  renderPage();
}

