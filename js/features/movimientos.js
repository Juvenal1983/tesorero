// js/features/movimientos.js — extraído de la copia de demostración.
function renderMovimientos(){
  const isLector = S.session.rol==='apoderado_lector';
  const busq = (S.params.busqMov||'').toLowerCase().trim();
  const filtroTipo = S.params.filtroMov || 'todos';
  let movs = getMovs(isLector);

  // Filtrar por tipo
  if(filtroTipo==='ingreso') movs = movs.filter(m=>m.tipo==='ingreso');
  else if(filtroTipo==='gasto') movs = movs.filter(m=>m.tipo==='gasto');

  // Filtrar por búsqueda
  if(busq) movs = movs.filter(m=>
    (m.desc||m.descripcion||'').toLowerCase().includes(busq) ||
    (m.categoria||'').toLowerCase().includes(busq) ||
    (m.responsable||'').toLowerCase().includes(busq) ||
    String(m.monto||'').includes(busq)
  );

  const todosMovs = getMovs(isLector);
  const totIng = todosMovs.filter(m=>m.tipo==='ingreso').reduce((s,m)=>s+m.monto,0);
  const totGas = todosMovs.filter(m=>m.tipo==='gasto').reduce((s,m)=>s+m.monto,0);

  const filtroBtn = (id, label) => {
    const act = filtroTipo===id;
    return `<button type="button" data-f="${id}"
      onclick="S.params.filtroMov=this.dataset.f;S.params.busqMov=document.getElementById('busq-mov')?.value||'';renderPage()"
      style="padding:5px 12px;border-radius:16px;border:1.5px solid ${act?'var(--g)':'var(--brd)'};background:${act?'var(--gl)':'var(--wh)'};color:${act?'var(--g)':'var(--t2)'};font-size:12px;font-weight:${act?'700':'400'};cursor:pointer;white-space:nowrap">${label}</button>`;
  };

  return `
  <div class="page-hdr">
    <div class="page-title">Ingresos y gastos</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
      ${(()=>{
        const pendientes=(DB.movimientos||[]).filter(m=>m.cursoId===S.cursoId&&m._pendienteStorage&&m.archivos&&m.archivos.some(a=>a.data));
        return pendientes.length?`<button type="button" onclick="subirPendientes(this)" style="background:#D97706;color:#fff;border:none;border-radius:10px;padding:8px 14px;font-size:13px;font-weight:700;cursor:pointer">↑ Subir (${pendientes.length})</button>`:'';
      })()}
      ${isLector
        ? `<button type="button" onclick="refrescarDatosApoderado(this)" aria-label="Actualizar datos"
             style="background:linear-gradient(135deg,#1a7fe8,#0f5bbf);color:#fff;border:none;border-radius:10px;padding:8px 16px;font-size:13px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:6px;box-shadow:0 3px 10px rgba(26,127,232,0.4)">
             ↻ Actualizar datos
           </button>`
        : `<button type="button" class="btn bp" onclick="showModal('addMov')">+ Nuevo movimiento</button>`
      }
    </div>
  </div>
  <div class="g3" style="margin-bottom:16px">
    <div class="metric"><div class="m-label">Ingresos extra</div><div class="m-value mv-g">${clp(totIng)}</div></div>
    <div class="metric"><div class="m-label">Gastos registrados</div><div class="m-value mv-r">${clp(totGas)}</div></div>
    <div class="metric"><div class="m-label">Balance extra</div><div class="m-value ${totIng-totGas>=0?'mv-b':'mv-r'}">${clp(totIng-totGas)}</div></div>
  </div>

  <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;align-items:center">
    <input id="busq-mov" class="fi" type="search" placeholder="🔍 Buscar por descripción, categoría o monto..."
      value="${escHtml(busq)}"
      style="flex:1;min-width:180px;font-size:13px;padding:8px 12px"
      oninput="S.params.busqMov=this.value;S.params.filtroMov='${filtroTipo}';renderPage()">
  </div>
  <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">
    ${filtroBtn('todos','Todos ('+todosMovs.length+')')}
    ${filtroBtn('ingreso','↑ Ingresos ('+todosMovs.filter(m=>m.tipo==='ingreso').length+')')}
    ${filtroBtn('gasto','↓ Gastos ('+todosMovs.filter(m=>m.tipo==='gasto').length+')')}
  </div>

  <div class="card">
    ${movs.length===0
      ? `<div class="empty-state"><div class="empty-icon">💸</div><div>${busq?'Sin resultados para "'+escHtml(busq)+'"':'Sin movimientos registrados'}</div></div>`
      : `<div class="tbl-wrap"><table>
      <thead><tr><th>Descripción</th><th>Tipo</th><th>Categoría</th><th>Monto</th><th>Fecha</th><th>Comprobante</th>${!isLector?'<th></th>':''}</tr></thead>
      <tbody>
        ${movs.sort((a,b)=>new Date(b.fecha)-new Date(a.fecha)).map(m=>`<tr>
          <td>
            <div style="font-weight:500">${escHtml(m.desc||m.descripcion||'')}</div>
            ${m.responsable?`<div style="font-size:12px;color:var(--t3)">${escHtml(m.responsable)}</div>`:''}
          </td>
          <td><span class="badge ${m.tipo==='ingreso'?'bgg':'bgr'}">${m.tipo==='ingreso'?'↑ Ingreso':'↓ Gasto'}</span></td>
          <td><span class="badge bgt">${escHtml(m.categoria||'')}</span></td>
          <td style="font-weight:700;color:${m.tipo==='ingreso'?'var(--g)':'var(--r)'};">${m.tipo==='gasto'?'-':''}${clp(m.monto)}</td>
          <td style="color:var(--t3);font-size:13px">${fmtDate(m.fecha)}</td>
          <td>${(()=>{ const archs=getArchivos(m);
            if(!archs.length) return '<span style="color:var(--brd);font-size:12px">—</span>';
            const thumb = archs[0].tipo==='application/pdf'
              ? `<span style="font-size:18px;cursor:pointer" onclick="verComprobante('${m.id}',0)" title="${escHtml(archs[0].nombre)}">📄</span>`
              : `<img src="${getArchivoSrc(archs[0])}" onclick="verComprobante('${m.id}',0)" style="width:36px;height:36px;object-fit:cover;border-radius:5px;cursor:pointer;vertical-align:middle">`;
            const extra = archs.length>1 ? `<span style="font-size:11px;color:var(--t3);margin-left:4px">+${archs.length-1}</span>` : '';
            return thumb+extra;
          })()}</td>
          ${!isLector?`<td style="white-space:nowrap">
            <button class="btn bs bp" onclick="showModal('addComprobante',{id:'${m.id}'})" title="Adjuntar comprobante">${getArchivos(m).length?'📎 '+getArchivos(m).length:'📎'}</button>
            <button class="btn bs" onclick="showModal('editMov',{id:'${m.id}'})" title="Editar" style="font-size:12px;padding:5px 8px">✏️</button>
            <button class="btn bs bd" onclick="delMov('${m.id}')">🗑</button>
          </td>`:''}
        </tr>`).join('')}
      </tbody>
    </table></div>`}
  </div>`;
}
function delMov(id){
  if(!confirm('¿Eliminar este movimiento?')) return;
  DB.movimientos=(DB.movimientos||[]).filter(m=>m.id!==id);
  saveDB(); go('movimientos');
}

async function subirPendientes(btnEl){
  const pendientes=(DB.movimientos||[]).filter(m=>m._pendienteStorage&&m.archivos&&m.archivos.some(a=>a.data));
  if(!pendientes.length){ showToast('No hay comprobantes pendientes'); return; }
  if(btnEl){ btnEl.disabled=true; btnEl.textContent='↑ Subiendo…'; }
  let ok=0, fail=0;
  for(const m of pendientes){
    try{
      const urls = await subirArchivosStorage(m.archivos, m.id);
      if(urls && urls.length && urls.every(u=>u.url)){
        m.archivos = urls;
        delete m._pendienteStorage; // solo si TODOS los archivos subieron con éxito
        ok++;
      } else { fail++; }
    }catch(e){ fail++; }
  }
  if(ok>0) saveDB(); // marca timestamp local optimista + sube a la nube de forma robusta
  showToast(ok>0?`✅ ${ok} comprobante${ok!==1?'s':''} subido${ok!==1?'s':''}${fail>0?' · '+fail+' fallaron':''}`: '⚠️ No se pudieron subir los comprobantes');
  go('movimientos');
}

function modalEditMov(data){
  const m=(DB.movimientos||[]).find(x=>x.id===data.id);
  if(!m) return `<div class="modal"><div class="modal-hdr"><div class="modal-title">Error</div><button class="close-btn" onclick="closeModal()">×</button></div><p style="padding:16px">Movimiento no encontrado.</p></div>`;
  const cats=DB.categorias||DEMO.categorias;
  const archs=getArchivos(m);
  return `<div class="modal" style="max-width:540px">
    <div class="modal-hdr"><div class="modal-title">✏️ Editar movimiento</div><button class="close-btn" onclick="closeModal()">×</button></div>
    <div class="fg"><label class="fl">Tipo</label>
      <select class="fs" id="em-tipo">
        <option value="ingreso" ${m.tipo==='ingreso'?'selected':''}>↑ Ingreso extra</option>
        <option value="gasto"   ${m.tipo==='gasto'  ?'selected':''}>↓ Gasto</option>
      </select>
    </div>
    <div class="fg"><label class="fl">Descripción</label>
      <input class="fi" id="em-desc" value="${escHtml(m.desc||m.descripcion||'')}">
    </div>
    <div class="fg-row">
      <div class="fg"><label class="fl">Monto (CLP)</label>
        <input class="fi" id="em-monto" type="number" value="${m.monto||0}">
      </div>
      <div class="fg"><label class="fl">Categoría</label>
        <select class="fs" id="em-cat">
          ${cats.map(c=>`<option${c===(m.categoria||'')?' selected':''}>${escHtml(c)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="fg-row">
      <div class="fg"><label class="fl">Fecha</label>
        <input class="fi" id="em-fecha" type="date" value="${m.fecha||isoToday()}">
      </div>
      <div class="fg"><label class="fl">Responsable</label>
        <input class="fi" id="em-resp" value="${escHtml(m.responsable||'')}">
      </div>
    </div>
    <div class="fg"><label class="fl">¿Visible para apoderados?</label>
      <select class="fs" id="em-visible">
        <option value="true"  ${m.visible!==false?'selected':''}>Sí</option>
        <option value="false" ${m.visible===false  ?'selected':''}>No (privado)</option>
      </select>
    </div>
    <div class="fg"><label class="fl">Observaciones</label>
      <input class="fi" id="em-obs" value="${escHtml(m.obs||'')}">
    </div>
    ${archs.length?`<div style="margin-bottom:8px">
      <div style="font-size:12px;font-weight:700;color:var(--t2);margin-bottom:6px">📎 Comprobantes actuales (${archs.length})</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        ${archs.map((a,i)=>a.tipo==='application/pdf'
          ?`<div style="display:flex;align-items:center;gap:6px;background:var(--bg);border-radius:8px;padding:6px 10px;font-size:12px">📄 ${escHtml(a.nombre||'PDF')}</div>`
          :`<img src="${getArchivoSrc(a)}" style="width:60px;height:60px;object-fit:cover;border-radius:8px;cursor:pointer" onclick="verComprobante('${m.id}',${i})">`
        ).join('')}
      </div>
      <div style="font-size:11px;color:var(--t3);margin-top:6px">Para cambiar comprobantes usa el botón 📎 en la lista.</div>
    </div>`:''}
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
      <button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn bp" onclick="saveEditMov('${m.id}')">💾 Guardar cambios</button>
    </div>
  </div>`;
}

function saveEditMov(id){
  const m=(DB.movimientos||[]).find(x=>x.id===id);
  if(!m) return;
  const desc=document.getElementById('em-desc').value.trim();
  const monto=parseInt(document.getElementById('em-monto').value)||0;
  if(!desc||!monto){ alert('Completa descripción y monto.'); return; }
  m.tipo        = document.getElementById('em-tipo').value;
  m.desc        = desc;
  m.descripcion = desc;
  m.monto       = monto;
  m.categoria   = document.getElementById('em-cat').value;
  m.fecha       = document.getElementById('em-fecha').value;
  m.responsable = document.getElementById('em-resp').value;
  m.visible     = document.getElementById('em-visible').value==='true';
  m.obs         = document.getElementById('em-obs').value;
  saveDB(); closeModal(); showToast('✓ Movimiento actualizado'); go('movimientos');
}

// ─────────────────────────────────────────────
// REPORTES
// ─────────────────────────────────────────────
