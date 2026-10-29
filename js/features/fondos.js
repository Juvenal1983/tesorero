// js/features/fondos.js — extraído de la copia de demostración.
function getActividades(){
  return (DB.actividades||[]).filter(a=>a.cursoId===S.cursoId);
}


function getFondoEspecialConfig(){
  const cur = getCurso();
  return cur?.fondoEspecial || { activo: false, nombre: 'Fondo Especial' };
}
function isFondoEspecialActivo(){
  return getCurso()?.fondoEspecial?.activo === true;
}

function getFondoMovimientos(){
  return (DB.fondoMovimientos||[]).filter(m=>m.cursoId===S.cursoId);
}

function getFondoAlumno(alumnoId){
  const movs = getFondoMovimientos();
  let total = 0;
  const historial = [];
  movs.forEach(m=>{
    let monto = 0;
    if(m.tipo==='aporte'){
      // Aporte individual o igualitario
      if(m.montoIndividual && m.montoIndividual[alumnoId]){
        monto = m.montoIndividual[alumnoId];
      }
    } else if(m.tipo==='rendimiento'){
      // Solo alumnos con saldo > 0 al momento del rendimiento
      const alumnos = getAlumnos();
      const alumnosConSaldo = alumnos.filter(a=>{
        const {total:s} = getFondoAlumnoHasta(a.id, m.fecha);
        return s > 0;
      });
      if(alumnosConSaldo.find(a=>a.id===alumnoId)){
        monto = Math.round((m.montoTotal||0) / (alumnosConSaldo.length||1));
      }
    } else if(m.tipo==='actividad'){
      if((m.participantes||[]).includes(alumnoId)){
        monto = Math.round((m.montoTotal||0) / (m.participantes.length||1));
      }
    }
    // multa no suma al fondo individual, va al común
    if(monto > 0){
      total += monto;
      historial.push({ tipo:m.tipo, nombre:m.nombre, fecha:m.fecha, monto });
    }
  });
  return { total, historial };
}

function getFondoAlumnoHasta(alumnoId, fechaLimite){
  // Para calcular saldo en una fecha específica (para rendimientos)
  const movs = getFondoMovimientos().filter(m=>m.fecha <= fechaLimite);
  let total = 0;
  movs.forEach(m=>{
    if(m.tipo==='aporte' && m.montoIndividual && m.montoIndividual[alumnoId]){
      total += m.montoIndividual[alumnoId];
    } else if(m.tipo==='actividad' && (m.participantes||[]).includes(alumnoId)){
      total += Math.round((m.montoTotal||0)/(m.participantes.length||1));
    }
    // rendimientos pasados ya están incluidos
  });
  return { total };
}

function renderFondoEspecial(){
  const cfg = getFondoEspecialConfig();
  const ordenFondo = S.params.ordenFondos || 'apellido';
  const alumnos = getAlumnos().slice().sort((a,b)=>
    ordenFondo==='total'?0:
    ordenFondo==='nombre'
      ? (a.nombres+' '+a.apellidos).localeCompare(b.nombres+' '+b.apellidos,'es')
      : (a.apellidos+' '+a.nombres).localeCompare(b.apellidos+' '+b.nombres,'es')
  );
  const movs = getFondoMovimientos().sort((a,b)=>b.fecha.localeCompare(a.fecha));
  const totalFondo = alumnos.reduce((s,al)=>s+getFondoAlumno(al.id).total, 0);
  const multas = movs.filter(m=>m.tipo==='multa');
  const totalMultas = multas.reduce((s,m)=>s+(m.montoTotal||0),0);

  // Para orden por total, re-sort después de calcular
  const alumnosConTotal = alumnos.map(al=>{
    const {total,historial}=getFondoAlumno(al.id);
    return {...al,_total:total,_historial:historial};
  });
  if(ordenFondo==='total') alumnosConTotal.sort((a,b)=>b._total-a._total);

  const filas = alumnosConTotal.length===0
    ? '<tr><td colspan="4" style="text-align:center;color:var(--t3)">Sin '+V('miembros').toLowerCase()+' registrados</td></tr>'
    : alumnosConTotal.map(al=>{
        const total=al._total, historial=al._historial;
        return '<tr onclick="verDetalleFondoAlumno(\'' + al.id + '\')" style="cursor:pointer">'
          +'<td style="font-weight:600">'+escHtml(al.nombres+' '+al.apellidos)+'</td>'
          +'<td style="font-weight:700;color:'+(total>0?'var(--g)':'var(--t3)')+'">'+( total>0?clp(total):'$0')+'</td>'
          +'<td style="color:var(--t3)">'+historial.length+' mov.</td>'
          +'<td style="font-size:11px;color:var(--t3)">'+(historial.length?fmtDate(historial[historial.length-1].fecha):'—')+'</td>'
          +'</tr>';
      }).join('');

  const filasMovs = movs.length===0
    ? '<tr><td colspan="5" style="text-align:center;color:var(--t3)">Sin movimientos registrados</td></tr>'
    : movs.map(m=>{
        const tipo = m.tipo==='aporte'?'💰 Aporte':m.tipo==='rendimiento'?'📈 Rendimiento':m.tipo==='actividad'?'🎪 Actividad':'💸 Multa';
        const color = m.tipo==='multa'?'var(--r)':'var(--g)';
        return '<tr>'
          +'<td style="font-size:12px;color:var(--t3)">'+fmtDate(m.fecha)+'</td>'
          +'<td style="font-size:12px">'+tipo+'</td>'
          +'<td style="font-size:13px;font-weight:600">'+escHtml(m.nombre||'')+'</td>'
          +'<td style="font-weight:700;color:'+color+'">'+clp(m.montoTotal||0)+'</td>'
          +'<td style="white-space:nowrap">'+'<button class="btn bs" onclick="editarMovFondo(&quot;'+m.id+'&quot;)" style="font-size:11px;padding:3px 6px;margin-right:3px">✏️</button>'+'<button class="btn bs bd" onclick="eliminarMovFondo(&quot;'+m.id+'&quot;)" style="font-size:11px;padding:3px 6px">🗑</button>'+'</td>'
          +'</tr>';
      }).join('');

  return '<div class="page-hdr">'
    +'<div class="page-title">🎓 '+escHtml(cfg.nombre)+'</div>'
    +'<button class="btn bp" onclick="showModal(&quot;nuevoMovFondo&quot;)">+ Nuevo movimiento</button>'
    +'</div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px">'
    +'<div style="background:var(--gl);border-radius:12px;padding:14px;text-align:center">'
    +'<div style="font-size:11px;color:var(--t3);font-weight:600;text-transform:uppercase">Fondo total acumulado</div>'
    +'<div style="font-size:24px;font-weight:900;color:var(--g);margin-top:4px">'+clp(totalFondo)+'</div>'
    +'</div>'
    +'<div style="background:#FFF8E7;border-radius:12px;padding:14px;text-align:center">'
    +'<div style="font-size:11px;color:#B8860B;font-weight:600;text-transform:uppercase">Multas pendientes</div>'
    +'<div style="font-size:24px;font-weight:900;color:#B8860B;margin-top:4px">'+clp(totalMultas)+'</div>'
    +'<div style="font-size:11px;color:var(--t3);margin-top:2px">Fondo común a repartir</div>'
    +'</div>'
    +'</div>'
    +'<div class="card" style="margin-bottom:14px">'
    +'<div class="card-title">👥 Saldo por alumno <span style="font-size:11px;color:var(--t3);font-weight:400">(toca para ver historial)</span></div>'
    +'<div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">'
    +'<button class="btn bs" onclick="ordenarTablaFondos(\'apellido\')" style="font-size:12px;'+(ordenFondo==="apellido"?"background:var(--gl);color:var(--g);font-weight:700;border-color:var(--g)":"")+'">A-Z Apellido</button>'
    +'<button class="btn bs" onclick="ordenarTablaFondos(\'nombre\')" style="font-size:12px;'+(ordenFondo==="nombre"?"background:var(--gl);color:var(--g);font-weight:700;border-color:var(--g)":"")+'">A-Z Nombre</button>'
    +'<button class="btn bs" onclick="ordenarTablaFondos(\'total\')" style="font-size:12px;'+(ordenFondo==="total"?"background:var(--gl);color:var(--g);font-weight:700;border-color:var(--g)":"")+'">Mayor saldo ↓</button>'
    +'</div>'
    +'<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Alumno</th><th>Saldo</th><th>Movs.</th><th>Último</th></tr></thead>'
    +'<tbody>'+filas+'</tbody></table></div>'
    +'</div>'
    +'<div class="card">'
    +'<div class="card-title">📋 Últimos movimientos</div>'
    +'<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Fecha</th><th>Tipo</th><th>Descripción</th><th>Monto</th><th></th></tr></thead>'
    +'<tbody>'+filasMovs+'</tbody></table></div>'
    +'</div>';
}

function editarMovFondo(id){
  showModal('editMovFondo', {id});
}

function modalEditMovFondo(data){
  const m = (DB.fondoMovimientos||[]).find(x=>x.id===data.id);
  if(!m) return '<div class="modal"><div class="modal-hdr"><div class="modal-title">Error</div><button class="close-btn" onclick="closeModal()">×</button></div></div>';
  return '<div class="modal">'
    +'<div class="modal-hdr"><div class="modal-title">✏️ Editar movimiento</div><button class="close-btn" onclick="closeModal()">×</button></div>'
    +'<div class="fg"><label class="fl">Descripción</label><input class="fi" id="emov-nombre" value="'+escHtml(m.nombre||'')+'"></div>'
    +'<div class="fg"><label class="fl">Fecha</label><input class="fi" id="emov-fecha" type="date" value="'+(m.fecha||'')+'"></div>'
    +'<div class="fg"><label class="fl">Monto total (CLP)</label><input class="fi" id="emov-monto" type="number" value="'+(m.montoTotal||0)+'"></div>'
    +'<div style="background:var(--bg);border-radius:8px;padding:10px 14px;font-size:12px;color:var(--t3);margin-bottom:12px">'
    +'⚠️ Al editar el monto, los saldos de los alumnos se recalcularán automáticamente según el nuevo monto.'
    +'</div>'
    +'<div style="display:flex;gap:10px;justify-content:flex-end">'
    +'<button class="btn" onclick="closeModal()">Cancelar</button>'
    +'<button class="btn bp" onclick="guardarEditMovFondo(&quot;'+data.id+'&quot;)">💾 Guardar</button>'
    +'</div></div>';
}

function guardarEditMovFondo(id){
  const m = (DB.fondoMovimientos||[]).find(x=>x.id===id);
  if(!m) return;
  const nombre = document.getElementById('emov-nombre').value.trim();
  const fecha  = document.getElementById('emov-fecha').value;
  const monto  = parseInt(document.getElementById('emov-monto').value)||0;
  if(!nombre) return alert('Ingresa una descripción.');
  if(!monto)  return alert('Ingresa el monto.');
  // Recalcular montoIndividual si cambia el monto
  if(monto !== m.montoTotal && m.montoIndividual){
    const factor = monto / m.montoTotal;
    const newInd = {};
    Object.keys(m.montoIndividual).forEach(k=>{ newInd[k] = Math.round(m.montoIndividual[k]*factor); });
    m.montoIndividual = newInd;
  }
  m.nombre = nombre;
  m.fecha  = fecha;
  m.montoTotal = monto;
  saveDB();
  closeModal();
  go('fondo-especial');
}

function eliminarMovFondo(id){
  if(!confirm('¿Eliminar este movimiento? Los saldos de los alumnos se recalcularán automáticamente.')) return;
  if(!confirm('Segunda confirmación: ¿Seguro que deseas eliminar este movimiento?')) return;
  DB.fondoMovimientos = (DB.fondoMovimientos||[]).filter(m=>m.id!==id);
  saveDB();
  go('fondo-especial');
}

function modalNuevoMovFondo(){
  const alumnos = getAlumnos();
  const cfg = getFondoEspecialConfig();
  return '<div class="modal" style="max-width:520px">'
    +'<div class="modal-hdr"><div class="modal-title">+ Nuevo movimiento — '+escHtml(cfg.nombre)+'</div><button class="close-btn" onclick="closeModal()">×</button></div>'
    +'<div class="fg"><label class="fl">Tipo de movimiento</label>'
    +'<select class="fs" id="fmov-tipo" onchange="toggleCamposFondo(this.value)">'
    +'<option value="aporte">💰 Aporte inicial</option>'
    +'<option value="rendimiento">📈 Rendimiento de inversión</option>'
    +'<option value="actividad">🎪 Actividad</option>'
    +'<option value="multa">💸 Multa</option>'
    +'</select></div>'
    +'<div class="fg-row">'
    +'<div class="fg"><label class="fl">Descripción</label><input class="fi" id="fmov-nombre" placeholder="Ej: Depósito a plazo BCI"></div>'
    +'<div class="fg"><label class="fl">Fecha</label><input class="fi" id="fmov-fecha" type="date" value="'+new Date().toISOString().slice(0,10)+'"></div>'
    +'</div>'
    // Aporte - opciones
    +'<div id="fmov-aporte-tipo" style="margin-bottom:12px">'
    +'<label class="fl">Modalidad de aporte</label>'
    +'<div style="display:flex;gap:10px;margin-top:6px">'
    +'<label style="display:flex;align-items:center;gap:6px;font-size:14px;cursor:pointer"><input type="radio" name="aporte-modo" value="igual" checked onchange="toggleAporteModo(&quot;igual&quot;)"> Igual para todos</label>'
    +'<label style="display:flex;align-items:center;gap:6px;font-size:14px;cursor:pointer"><input type="radio" name="aporte-modo" value="individual" onchange="toggleAporteModo(&quot;individual&quot;)"> Individual por alumno</label>'
    +'</div></div>'
    // Monto total (rendimiento, actividad, multa, aporte igual)
    +'<div id="fmov-monto-total" class="fg"><label class="fl">Monto total (CLP)</label><input class="fi" id="fmov-monto" type="number" placeholder="0" oninput="calcPreviewFondo()"></div>'
    // Preview reparto
    +'<div id="fmov-preview" style="background:var(--gl);border-radius:8px;padding:10px 14px;font-size:13px;color:var(--gm);font-weight:600;margin-bottom:12px;display:none"></div>'
    // Participantes (actividad y multa)
    +'<div id="fmov-participantes" style="display:none">'
    +'<div class="fg"><label class="fl">Participantes</label>'
    +'<div style="display:flex;gap:8px;margin-bottom:8px">'
    +'<button type="button" class="btn bs" onclick="selTodosFondo(true)" style="font-size:12px">✅ Todos</button>'
    +'<button type="button" class="btn bs" onclick="selTodosFondo(false)" style="font-size:12px">☐ Ninguno</button>'
    +'</div>'
    +'<div style="max-height:180px;overflow-y:auto;border:1px solid var(--brd);border-radius:8px;padding:8px">'
    +alumnos.map(al=>'<label style="display:flex;align-items:center;gap:8px;padding:5px 4px;cursor:pointer;font-size:14px">'
      +'<input type="checkbox" class="fmov-check" value="'+al.id+'" onchange="calcPreviewFondo()"> '
      +escHtml(al.nombres+' '+al.apellidos)
      +'</label>').join('')
    +'</div></div></div>'
    // Montos individuales (aporte individual)
    +'<div id="fmov-individuales" style="display:none">'
    +'<label class="fl" style="margin-bottom:8px">Monto por alumno (CLP)</label>'
    +'<div style="max-height:220px;overflow-y:auto;border:1px solid var(--brd);border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:6px">'
    +alumnos.map(al=>'<div style="display:flex;align-items:center;gap:10px">'
      +'<div style="flex:1;font-size:13px">'+escHtml(al.nombres+' '+al.apellidos)+'</div>'
      +'<input class="fi fmov-ind-input" data-id="'+al.id+'" type="number" placeholder="0" style="width:110px;text-align:right">'
      +'</div>').join('')
    +'</div></div>'
    +'<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px">'
    +'<button class="btn" onclick="closeModal()">Cancelar</button>'
    +'<button class="btn bp" onclick="saveMovFondo()">💾 Guardar</button>'
    +'</div></div>';
}

function verDetalleFondoAlumno(alumnoId){
  showModal("detalleFondoAlumno",{alumnoId:alumnoId});
}

function toggleCamposFondo(tipo){
  document.getElementById('fmov-aporte-tipo').style.display   = tipo==='aporte'?'':'none';
  document.getElementById('fmov-monto-total').style.display   = tipo==='aporte'&&document.querySelector('[name="aporte-modo"]:checked')?.value==='individual'?'none':'';
  document.getElementById('fmov-participantes').style.display = (tipo==='actividad'||tipo==='multa')?'':'none';
  document.getElementById('fmov-individuales').style.display  = 'none';
  document.getElementById('fmov-preview').style.display = 'none';
  calcPreviewFondo();
}

function toggleAporteModo(modo){
  document.getElementById('fmov-monto-total').style.display  = modo==='individual'?'none':'';
  document.getElementById('fmov-individuales').style.display = modo==='individual'?'':'none';
  document.getElementById('fmov-preview').style.display = 'none';
}

function selTodosFondo(sel){
  document.querySelectorAll('.fmov-check').forEach(c=>c.checked=sel);
  calcPreviewFondo();
}

function calcPreviewFondo(){
  const tipo = document.getElementById('fmov-tipo')?.value;
  const monto = parseInt(document.getElementById('fmov-monto')?.value)||0;
  const prev = document.getElementById('fmov-preview');
  if(!prev) return;
  if(tipo==='rendimiento'){
    const alumnos = getAlumnos();
    const conSaldo = alumnos.filter(a=>getFondoAlumno(a.id).total>0).length;
    if(monto>0 && conSaldo>0){
      prev.style.display='';
      prev.textContent = clp(Math.round(monto/conSaldo))+' por alumno ('+conSaldo+' con saldo)';
    } else { prev.style.display='none'; }
  } else if(tipo==='actividad'||tipo==='multa'){
    const checks = document.querySelectorAll('.fmov-check:checked').length;
    if(monto>0 && checks>0){
      prev.style.display='';
      prev.textContent = clp(Math.round(monto/checks))+' por participante ('+checks+' seleccionados)';
    } else { prev.style.display='none'; }
  } else { prev.style.display='none'; }
}

function saveMovFondo(){
  const tipo   = document.getElementById('fmov-tipo').value;
  const nombre = document.getElementById('fmov-nombre').value.trim();
  const fecha  = document.getElementById('fmov-fecha').value;
  if(!nombre) return alert('Ingresa una descripción.');
  if(!fecha)  return alert('Selecciona una fecha.');

  if(!DB.fondoMovimientos) DB.fondoMovimientos=[];
  const base = { id:uid(), cursoId:S.cursoId, tipo, nombre, fecha };

  if(tipo==='aporte'){
    const modo = document.querySelector('[name="aporte-modo"]:checked')?.value||'igual';
    if(modo==='igual'){
      const monto = parseInt(document.getElementById('fmov-monto').value)||0;
      if(!monto) return alert('Ingresa el monto total a dividir.');
      const alumnos = getAlumnos();
      const montoCada = Math.round(monto / alumnos.length);
      const montoInd = {};
      alumnos.forEach(a=>montoInd[a.id]=montoCada);
      DB.fondoMovimientos.push({...base, montoTotal:monto, montoIndividual:montoInd});
    } else {
      const inputs = document.querySelectorAll('.fmov-ind-input');
      const montoInd = {};
      let total = 0;
      inputs.forEach(inp=>{ const v=parseInt(inp.value)||0; if(v>0){ montoInd[inp.dataset.id]=v; total+=v; } });
      if(!total) return alert('Ingresa al menos un monto.');
      DB.fondoMovimientos.push({...base, montoTotal:total, montoIndividual:montoInd});
    }
  } else if(tipo==='rendimiento'){
    const monto = parseInt(document.getElementById('fmov-monto').value)||0;
    if(!monto) return alert('Ingresa el monto total del rendimiento.');
    DB.fondoMovimientos.push({...base, montoTotal:monto});
  } else if(tipo==='actividad'||tipo==='multa'){
    const monto = parseInt(document.getElementById('fmov-monto').value)||0;
    if(!monto) return alert('Ingresa el monto total.');
    const participantes = [...document.querySelectorAll('.fmov-check:checked')].map(c=>c.value);
    if(!participantes.length) return alert('Selecciona al menos un participante.');
    DB.fondoMovimientos.push({...base, montoTotal:monto, participantes});
  }

  saveDB(); closeModal(); go('fondo-especial');
}

function modalDetalleFondoAlumno(data){
  const al = getAlumnos().find(a=>a.id===data.alumnoId);
  if(!al) return '<div class="modal"><div class="modal-hdr"><div class="modal-title">Error</div><button class="close-btn" onclick="closeModal()">×</button></div></div>';
  const {total, historial} = getFondoAlumno(al.id);
  const cfg = getFondoEspecialConfig();
  const filas = historial.length===0
    ? '<tr><td colspan="3" style="text-align:center;color:var(--t3)">Sin movimientos</td></tr>'
    : historial.sort((a,b)=>b.fecha.localeCompare(a.fecha)).map(h=>{
        const tipo = h.tipo==='aporte'?'💰':h.tipo==='rendimiento'?'📈':h.tipo==='actividad'?'🎪':'💸';
        return '<tr><td style="font-size:12px;color:var(--t3)">'+fmtDate(h.fecha)+'</td>'
          +'<td>'+tipo+' '+escHtml(h.nombre)+'</td>'
          +'<td style="font-weight:700;color:var(--g)">+'+clp(h.monto)+'</td></tr>';
      }).join('');
  return '<div class="modal">'
    +'<div class="modal-hdr"><div class="modal-title">🎓 '+escHtml(al.nombres+' '+al.apellidos)+'</div><button class="close-btn" onclick="closeModal()">×</button></div>'
    +'<div style="text-align:center;background:var(--gl);border-radius:12px;padding:16px;margin-bottom:16px">'
    +'<div style="font-size:11px;color:var(--t3);font-weight:600;text-transform:uppercase">Saldo en '+escHtml(cfg.nombre)+'</div>'
    +'<div style="font-size:32px;font-weight:900;color:var(--g);margin-top:4px">'+clp(total)+'</div>'
    +'</div>'
    +'<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Fecha</th><th>Movimiento</th><th>Monto</th></tr></thead>'
    +'<tbody>'+filas+'</tbody></table></div>'
    +'<div style="display:flex;justify-content:flex-end;margin-top:14px">'
    +'<button class="btn" onclick="closeModal()">Cerrar</button>'
    +'</div></div>';
}
function renderActividades(){
  const acts = getActividades();
  const alumnos = (DB.alumnos||[]).filter(a=>a.cursoId===S.cursoId);
  return `
  <div class="page-hdr">
    <div class="page-title">🎪 Actividades</div>
    <button class="btn bp" onclick="showModal('addActividad')">+ Nueva actividad</button>
  </div>
  <p style="font-size:13px;color:var(--t2);margin-bottom:16px">
    Registra actividades de recaudación (peñas, rifas, ventas, etc.) y asigna los fondos a los alumnos participantes. Cada alumno acumula su fondo individual.
  </p>
  ${acts.length===0
    ? '<div class="empty-state"><div style="font-size:48px">🎪</div><div>Sin actividades registradas</div><div style="font-size:13px;color:var(--t3)">Crea una actividad para empezar a registrar fondos individuales</div></div>'
    : '<div style="display:flex;flex-direction:column;gap:12px">'
      + acts.map(a=>{
          const nPartic = (a.participantes||[]).length;
          const montoXAlumno = nPartic>0 ? Math.round(a.montoTotal/nPartic) : 0;
          return `<div class="card" style="margin-bottom:0">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
              <div>
                <div style="font-weight:700;font-size:15px">${escHtml(a.nombre)}</div>
                <div style="font-size:12px;color:var(--t3);margin-top:2px">${fmtDate(a.fecha)} · ${nPartic} participantes · ${clp(montoXAlumno)} c/u</div>
              </div>
              <div style="text-align:right;flex-shrink:0">
                <div style="font-size:20px;font-weight:900;color:var(--g)">${clp(a.montoTotal)}</div>
                <div style="font-size:11px;color:var(--t3)">Total recaudado</div>
              </div>
            </div>
            <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
              ${(a.participantes||[]).map(id=>{
                const al=(DB.alumnos||[]).find(x=>x.id===id);
                return al?`<span class="badge bgg" style="font-size:11px">${escHtml(al.nombres+' '+al.apellidos)}</span>`:'';
              }).join('')}
            </div>
            <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end">
              <button class="btn bs" onclick="showModal('editActividad',{id:'${a.id}'})">✏️ Editar</button>
              <button class="btn bs bd" onclick="eliminarActividad('${a.id}')">🗑</button>
            </div>
          </div>`;
        }).join('')
      + '</div>'
  }
  <div class="card" style="margin-top:20px">
    <div class="card-title">💰 Fondo acumulado por alumno</div>
    <p style="font-size:13px;color:var(--t2);margin-bottom:14px">Resumen de fondos individuales generados por actividades durante el año.</p>
    <div class="tbl-wrap">
      <table class="tbl">
        <thead><tr><th>Alumno</th><th>Actividades</th><th>Fondo acumulado</th></tr></thead>
        <tbody>
          ${alumnos.length===0
            ? '<tr><td colspan="3" style="text-align:center;color:var(--t3)">'+('Sin '+V('miembros')+' registrados')+'</td></tr>'
            : alumnos.map(al=>{
                const {total,historial}=getFondoAlumno(al.id);
                return `<tr>
                  <td style="font-weight:600">${escHtml(al.nombres+' '+al.apellidos)}</td>
                  <td style="color:var(--t3)">${historial.length} actividad${historial.length!==1?'es':''}</td>
                  <td style="font-weight:700;color:${total>0?'var(--g)':'var(--t3)'}">
                    ${total>0?clp(total):'$0'}
                  </td>
                </tr>`;
              }).join('')
          }
        </tbody>
      </table>
    </div>
  </div>`;
}

function modalActividad(id){
  const a = id ? (DB.actividades||[]).find(x=>x.id===id) : null;
  const alumnos = (DB.alumnos||[]).filter(x=>x.cursoId===S.cursoId);
  const participantes = a?.participantes || [];
  return `<div class="modal" style="max-width:520px">
    <div class="modal-hdr">
      <div class="modal-title">${a?'Editar actividad':'Nueva actividad'}</div>
      <button class="close-btn" onclick="closeModal()">×</button>
    </div>
    <div class="fg"><label class="fl">Nombre de la actividad</label>
      <input class="fi" id="act-nombre" value="${escHtml(a?.nombre||'')}" placeholder="Ej: Peña bailable, Rifa, Venta de empanadas">
    </div>
    <div class="fg-row">
      <div class="fg"><label class="fl">Fecha</label>
        <input class="fi" id="act-fecha" type="date" value="${a?.fecha||new Date().toISOString().slice(0,10)}">
      </div>
      <div class="fg"><label class="fl">Total recaudado (CLP)</label>
        <input class="fi" id="act-monto" type="number" value="${a?.montoTotal||''}" placeholder="0" oninput="calcMontoXAlumno()">
      </div>
    </div>
    <div id="act-preview" style="background:var(--gl);border-radius:8px;padding:10px 14px;font-size:13px;color:var(--gm);font-weight:600;margin-bottom:12px;display:${a&&a.participantes?.length?'':'none'}">
      ${a&&a.participantes?.length ? clp(Math.round((a.montoTotal||0)/a.participantes.length))+' por alumno participante' : ''}
    </div>
    <div class="fg"><label class="fl">Observaciones</label>
      <input class="fi" id="act-obs" value="${escHtml(a?.obs||'')}" placeholder="Opcional">
    </div>
    <div class="fg">
      <label class="fl">Alumnos participantes</label>
      <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap">
        <button type="button" class="btn bs" onclick="seleccionarTodosAct(true)" style="font-size:12px">✅ Todos</button>
        <button type="button" class="btn bs" onclick="seleccionarTodosAct(false)" style="font-size:12px">☐ Ninguno</button>
      </div>
      <div style="max-height:200px;overflow-y:auto;border:1px solid var(--brd);border-radius:8px;padding:8px">
        ${alumnos.map(al=>`
          <label style="display:flex;align-items:center;gap:8px;padding:6px 4px;cursor:pointer;font-size:14px">
            <input type="checkbox" class="act-check" value="${al.id}" ${participantes.includes(al.id)?'checked':''} onchange="calcMontoXAlumno()">
            ${escHtml(al.nombres+' '+al.apellidos)}
          </label>`).join('')}
      </div>
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px">
      <button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn bp" onclick="saveActividad('${id||''}')">💾 Guardar</button>
    </div>
  </div>`;
}

function calcMontoXAlumno(){
  const monto = parseInt(document.getElementById('act-monto')?.value)||0;
  const checks = document.querySelectorAll('.act-check:checked');
  const prev = document.getElementById('act-preview');
  if(!prev) return;
  if(monto>0 && checks.length>0){
    prev.style.display='';
    prev.textContent = clp(Math.round(monto/checks.length))+' por alumno participante ('+checks.length+' seleccionados)';
  } else {
    prev.style.display='none';
  }
}

function seleccionarTodosAct(sel){
  document.querySelectorAll('.act-check').forEach(c=>c.checked=sel);
  calcMontoXAlumno();
}

function saveActividad(id){
  const nombre = document.getElementById('act-nombre').value.trim();
  const monto  = parseInt(document.getElementById('act-monto').value)||0;
  const fecha  = document.getElementById('act-fecha').value;
  const obs    = document.getElementById('act-obs').value.trim();
  if(!nombre) return alert('Ingresa el nombre de la actividad.');
  if(!monto)  return alert('Ingresa el monto total recaudado.');
  const participantes = [...document.querySelectorAll('.act-check:checked')].map(c=>c.value);
  if(!participantes.length) return alert('Selecciona al menos un alumno participante.');
  if(!DB.actividades) DB.actividades=[];
  if(id){
    const i=DB.actividades.findIndex(x=>x.id===id);
    if(i>=0) DB.actividades[i]={...DB.actividades[i],nombre,montoTotal:monto,fecha,obs,participantes};
  } else {
    DB.actividades.push({id:uid(),cursoId:S.cursoId,nombre,montoTotal:monto,fecha,obs,participantes});
  }
  saveDB(); closeModal(); go('actividades');
}

function eliminarActividad(id){
  if(!confirm('¿Eliminar esta actividad? Se perderán los fondos asignados.')) return;
  DB.actividades=(DB.actividades||[]).filter(x=>x.id!==id);
  saveDB(); go('actividades');
}

function renderDeudaPersonal(){
  // Seguridad: solo usar el alumnoId grabado en la sesión al momento del login
  // Nunca aceptar parámetros externos ni URL params
  const alumnoId = S.session?.alumnoId;
  if(!alumnoId || S.session?.rol !== 'apoderado_lector') return '';

  // Verificar que el alumno pertenezca al curso activo (doble validación)
  const alu = (DB.alumnos||[]).find(a=>a.id===alumnoId && a.cursoId===S.cursoId);
  if(!alu) return `<div class="alert ar" style="margin-bottom:14px">No se encontró el alumno asociado a tu cuenta. Por favor cierra sesión e ingresa nuevamente.</div>`;
  const cuotas  = getCuotas();
  const pagos   = getPagos().filter(p=>p.alumnoId===alumnoId && p.estado==='pagado');
  const totalPagado = pagos.reduce((s,p)=>s+p.monto,0);

  // Calcular deuda por cada cuota
  let filas = '';
  let totalDeuda = 0;
  let totalAlDia = 0;

  cuotas.forEach(q=>{
    const pagosQ = pagos.filter(p=>p.cuotaId===q.id);
    if(q.tipo==='mensual'){
      const mesIni = (q.mesInicio!==undefined&&q.mesInicio!==null)?q.mesInicio:2;
      const mesFin = (q.mesTermino!==undefined&&q.mesTermino!==null)?q.mesTermino+1:12;
      const mesesCuota = MESES.slice(mesIni, mesFin);
      mesesCuota.forEach(mes=>{
        const pago = pagosQ.find(p=>p.periodo===mes);
        if(pago){
          totalAlDia += pago.monto;
          filas += `<tr>
            <td style="font-size:13px">${escHtml(q.nombre)}</td>
            <td style="font-size:13px">${mes}</td>
            <td><span class="badge bgg">✅ Pagado</span></td>
            <td style="font-size:13px;color:var(--g);font-weight:600">${clp(pago.monto)}</td>
            <td style="font-size:12px;color:var(--t3)">${fmtDate(pago.fecha)}</td>
          </tr>`;
        } else {
          if(alu?.eximido){
            filas += `<tr>
              <td style="font-size:13px">${escHtml(q.nombre)}</td>
              <td style="font-size:13px">${mes}</td>
              <td><span class="badge" style="background:#FFF8E7;color:#B8860B;font-weight:700">🟡 Eximido</span></td>
              <td style="font-size:13px;color:#B8860B">—</td>
              <td style="font-size:12px;color:var(--t3)">—</td>
            </tr>`;
          } else {
          const plan = getPlanPago(alumnoId, q.id, mes);
          if(plan){
            const pagados = plan.abonos.filter(a=>a.pagado).length;
            const montoPagado = plan.abonos.filter(a=>a.pagado).reduce((s,a)=>s+a.monto,0);
            const pendientes = plan.abonos.filter(a=>!a.pagado);
            const proximoAbono = pendientes.length ? pendientes[0] : null;
            totalAlDia += montoPagado;
            totalDeuda += q.monto - montoPagado;
            // Desglose de abonos visible para el apoderado
            const desglose = plan.abonos.map((ab,i)=>`
              <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;background:${ab.pagado?'#E1F5EE':'#F5F5F5'};margin-bottom:4px">
                <span style="font-size:12px;font-weight:700;color:${ab.pagado?'var(--g)':'var(--t3)'}">Abono ${i+1}</span>
                <span style="font-size:12px;flex:1;color:var(--t2)">${clp(ab.monto)}</span>
                <span style="font-size:11px;color:var(--t3)">Vence ${fmtDate(ab.fecha)}</span>
                <span style="font-size:11px;font-weight:700;color:${ab.pagado?'var(--g)':'var(--r)'}">${ab.pagado?'✅ Pagado el '+fmtDate(ab.fechaPago):'⏳ Pendiente'}</span>
              </div>`).join('');
            filas += `<tr>
              <td colspan="5" style="padding:8px 0">
                <div style="background:#EFF6FF;border-radius:10px;padding:12px 14px">
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:6px">
                    <div>
                      <span style="font-size:13px;font-weight:700;color:#1e40af">${escHtml(q.nombre)} — ${mes}</span>
                      <span class="badge" style="background:#DBEAFE;color:#2563EB;font-weight:700;margin-left:8px">🔄 Plan ${pagados}/${plan.abonos.length}</span>
                    </div>
                    <div style="text-align:right">
                      <div style="font-size:13px;font-weight:700;color:#2563EB">${clp(montoPagado)} <span style="color:var(--t3);font-weight:400">de</span> ${clp(q.monto)}</div>
                      ${proximoAbono?`<div style="font-size:11px;color:#D97706;font-weight:600">Próximo: ${clp(proximoAbono.monto)} — vence ${fmtDate(proximoAbono.fecha)}</div>`:''}
                    </div>
                  </div>
                  ${desglose}
                </div>
              </td>
            </tr>`;
          } else {
            totalDeuda += q.monto;
            filas += `<tr>
              <td style="font-size:13px">${escHtml(q.nombre)}</td>
              <td style="font-size:13px">${mes}</td>
              <td><span class="badge bgr">⏳ Pendiente</span></td>
              <td style="font-size:13px;color:var(--r);font-weight:600">${clp(q.monto)}</td>
              <td style="font-size:12px;color:var(--t3)">—</td>
            </tr>`;
          }
          }
        }
      });
    } else {
      const periodoLabel = q.tipo==='anual' ? `Anual ${q.anio}` : (q.periodo||q.nombre);
      const pago = pagosQ.find(p=>p.periodo===periodoLabel||p.periodo===`Anual ${q.anio}`);
      if(pago){
        totalAlDia += pago.monto;
        filas += `<tr>
          <td style="font-size:13px">${escHtml(q.nombre)}</td>
          <td style="font-size:13px">${periodoLabel}</td>
          <td><span class="badge bgg">Pagado</span></td>
          <td style="font-size:13px;color:var(--g);font-weight:600">${clp(pago.monto)}</td>
          <td style="font-size:12px;color:var(--t3)">${fmtDate(pago.fecha)}</td>
        </tr>`;
      } else {
        totalDeuda += q.monto;
        filas += `<tr>
          <td style="font-size:13px">${escHtml(q.nombre)}</td>
          <td style="font-size:13px">${periodoLabel}</td>
          <td><span class="badge bgr">Pendiente</span></td>
          <td style="font-size:13px;color:var(--r);font-weight:600">${clp(q.monto)}</td>
          <td style="font-size:12px;color:var(--t3)">—</td>
        </tr>`;
      }
    }
  });

  const sinCuotas = !cuotas.length;

  const {total:fondoTotal} = getFondoAlumno(alumnoId);
  return `
  <!-- RESUMEN VISUAL -->
  <div style="display:grid;grid-template-columns:1fr 1fr ${fondoTotal>0?'1fr':''};gap:10px;margin-bottom:16px">
    <div style="background:${totalDeuda>0?'#FFF0F0':'#F0FDF4'};border:2px solid ${totalDeuda>0?'var(--r)':'var(--g)'};border-radius:14px;padding:16px;text-align:center">
      <div style="font-size:28px;margin-bottom:4px">${totalDeuda>0?'⚠️':'✅'}</div>
      <div style="font-size:11px;color:var(--t3);font-weight:600;text-transform:uppercase">Estado</div>
      <div style="font-size:16px;font-weight:800;color:${totalDeuda>0?'var(--r)':'var(--g)'};margin-top:2px">${totalDeuda>0?'Con deuda':'Al día'}</div>
    </div>
    <div style="background:#F0FDF4;border:2px solid var(--g);border-radius:14px;padding:16px;text-align:center">
      <div style="font-size:28px;margin-bottom:4px">💰</div>
      <div style="font-size:11px;color:var(--t3);font-weight:600;text-transform:uppercase">Pagado</div>
      <div style="font-size:16px;font-weight:800;color:var(--g);margin-top:2px">${clp(totalAlDia)}</div>
    </div>
    ${fondoTotal>0?`<div style="background:#FFF8E7;border:2px solid #EF9F27;border-radius:14px;padding:16px;text-align:center">
      <div style="font-size:28px;margin-bottom:4px">🎪</div>
      <div style="font-size:11px;color:#B8860B;font-weight:600;text-transform:uppercase">Fondo actividades</div>
      <div style="font-size:16px;font-weight:800;color:#B8860B;margin-top:2px">${clp(fondoTotal)}</div>
    </div>`:''}
  </div>

  ${totalDeuda>0?`<div style="background:#FFF0F0;border:1px solid #FECACA;border-radius:12px;padding:14px 16px;margin-bottom:16px;display:flex;align-items:center;gap:12px">
    <div style="font-size:28px">⚠️</div>
    <div>
      <div style="font-weight:700;color:var(--r);font-size:15px">Tienes cuotas pendientes</div>
      <div style="font-size:13px;color:var(--t2);margin-top:2px">Monto total pendiente: <strong>${clp(totalDeuda)}</strong>. Contacta al tesorero para regularizar.</div>
    </div>
  </div>`:''}

  <div class="card" style="margin-bottom:14px">
    <div style="font-size:15px;font-weight:800;margin-bottom:12px">📋 Detalle de cuotas — ${escHtml(alu?.nombres||'')} ${escHtml(alu?.apellidos||'')}</div>
    ${sinCuotas
      ? `<div style="text-align:center;padding:16px;font-size:13px;color:var(--t3)">El tesorero aún no ha configurado cuotas para este curso.</div>`
      : `<div style="overflow-x:auto">
          <table>
            <thead><tr><th>Cuota</th><th>Período</th><th>Estado</th><th>Monto</th><th>Fecha</th></tr></thead>
            <tbody>${filas}</tbody>
          </table>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0 0;border-top:1px solid var(--brd);margin-top:10px;flex-wrap:wrap;gap:8px">
          <div style="font-size:13px;color:var(--t3)">✅ Total pagado: <strong style="color:var(--g)">${clp(totalAlDia)}</strong></div>
          ${totalDeuda>0?`<div style="font-size:13px;color:var(--t3)">⏳ Total pendiente: <strong style="color:var(--r)">${clp(totalDeuda)}</strong></div>`:''}
        </div>`
    }
  </div>${renderFondoLector(alumnoId)}`;
}

function getAluNombre(id){
  const a=(DB.alumnos||[]).find(x=>x.id===id);
  return a?`${a.nombres} ${a.apellidos}`:'Alumno';
}

function drawDashboardCharts(){
  const pagos=getPagos().filter(p=>p.estado==='pagado');
  const movs=getMovs();
  const ingMes=Array(12).fill(0), gasMes=Array(12).fill(0);
  pagos.forEach(p=>{ const m=parseInt((p.fecha||'').split('-')[1]); if(m>=1&&m<=12) ingMes[m-1]+=p.monto; });
  movs.filter(m=>m.tipo==='ingreso').forEach(m=>{ const mo=parseInt((m.fecha||'').split('-')[1]); if(mo>=1&&mo<=12) ingMes[mo-1]+=m.monto; });
  movs.filter(m=>m.tipo==='gasto').forEach(m=>{ const mo=parseInt((m.fecha||'').split('-')[1]); if(mo>=1&&mo<=12) gasMes[mo-1]+=m.monto; });

  // Gráfico barras mensuales
  const cBar=document.getElementById('chartBar');
  if(cBar){_charts.bar=new Chart(cBar,{type:'bar',data:{labels:MESES.map(m=>m.slice(0,3)),datasets:[
    {label:'💰 Ingresos',data:ingMes,backgroundColor:'#1D9E75',borderRadius:6},
    {label:'💸 Gastos',data:gasMes,backgroundColor:'#E24B4A',borderRadius:6}
  ]},options:{responsive:true,maintainAspectRatio:false,
    plugins:{
      legend:{display:true,position:'top',labels:{font:{size:12},boxWidth:12,padding:12}},
      tooltip:{callbacks:{label:ctx=>' '+ctx.dataset.label+': $'+Math.round(ctx.raw).toLocaleString('es-CL')}}
    },
    scales:{
      x:{grid:{display:false},ticks:{font:{size:11}}},
      y:{grid:{color:'rgba(0,0,0,.05)'},ticks:{callback:v=>v===0?'$0':'$'+Math.round(v/1000)+'k',font:{size:11}}}
    }
  }});}

  // Gráfico resumen financiero horizontal
  const F=calcFinanzas();
  const totalIng = F.totPagos + F.totIngExtra;
  const resumen = document.getElementById('chartResumen');
  if(resumen && totalIng>0){
    const items = [
      {label:'💳 Cuotas',  monto:F.totPagos,     pct:Math.round(F.totPagos/totalIng*100),     color:'#1D9E75'},
      {label:'💰 Extras',  monto:F.totIngExtra,   pct:Math.round(F.totIngExtra/totalIng*100),   color:'#2563EB'},
      {label:'💸 Gastos',  monto:F.totGastos,     pct:Math.round(F.totGastos/totalIng*100),     color:'#E24B4A'},
      {label:'🏦 Saldo',   monto:F.saldoTotal,    pct:Math.round(Math.max(0,F.saldoTotal)/totalIng*100), color:'#9B59B6'},
    ];
    resumen.innerHTML = items.map(it=>`
      <div style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">
          <span style="font-weight:600;color:var(--t1)">${it.label}</span>
          <span style="color:${it.color};font-weight:700">${clp(it.monto)} <span style="color:var(--t3);font-weight:400">(${it.pct}%)</span></span>
        </div>
        <div style="height:10px;background:var(--brd);border-radius:5px">
          <div style="width:${Math.min(100,it.pct)}%;height:100%;background:${it.color};border-radius:5px;transition:width .5s ease"></div>
        </div>
      </div>`).join('');
  } else if(resumen){
    resumen.innerHTML = '<p style="font-size:13px;color:var(--t3);text-align:center;padding:16px">Sin datos financieros aún</p>';
  }
}

// ─────────────────────────────────────────────
// ALUMNOS
// ─────────────────────────────────────────────
