// js/features/alumnos.js — extraído de la copia de demostración.
function renderAlumnos(){
  const busq = (S.params.busqAlu||'').toLowerCase();
  const orden = S.params.ordenAlu||'apellidos';
  const lista = getAlumnosAll()
    .filter(a=> !busq ||
      `${a.apellidos} ${a.nombres}`.toLowerCase().includes(busq))
    .sort((a,b)=>{
      if(orden==='apellidos') return `${a.apellidos} ${a.nombres}`.localeCompare(`${b.apellidos} ${b.nombres}`,'es');
      return `${a.nombres} ${a.apellidos}`.localeCompare(`${b.nombres} ${b.apellidos}`,'es');
    });
  const all = getAlumnosAll();
  return `
  <div class="page-hdr">
    <div class="page-title">${V('miembros')} del ${V('grupo').toLowerCase()}</div>
    <button class="btn bp" onclick="showModal('addAlumno')">+ Agregar ${V('miembro')}</button>
  </div>
  <div class="card" style="margin-bottom:14px;padding:12px 18px;display:flex;flex-wrap:wrap;gap:12px;align-items:center">
    <div><span style="font-size:22px;font-weight:800;color:var(--g)">${all.filter(a=>a.estado==='activo').length}</span><span style="font-size:13px;color:var(--t3);margin-left:6px">activos</span></div>
    <div style="width:1px;height:28px;background:var(--brd)"></div>
    <div><span style="font-size:22px;font-weight:800;color:var(--t3)">${all.filter(a=>a.estado==='retirado').length}</span><span style="font-size:13px;color:var(--t3);margin-left:6px">retirados</span></div>
    <div style="flex:1;min-width:160px;position:relative">
      <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--t3);font-size:14px;pointer-events:none">🔍</span>
      <input class="fi" id="busq-alu" placeholder="Buscar por nombre o apellido…" value="${escHtml(S.params.busqAlu||'')}"
        oninput="S.params.busqAlu=this.value;S.params.ordenAlu=document.getElementById('orden-alu').value;renderPage()"
        style="padding-left:32px;font-size:13px">
    </div>
    <div style="display:flex;align-items:center;gap:6px">
      <span style="font-size:12px;color:var(--t3);white-space:nowrap">Ordenar por:</span>
      <select id="orden-alu" class="fs" style="font-size:13px;padding:7px 10px;width:auto"
        onchange="S.params.ordenAlu=this.value;S.params.busqAlu=document.getElementById('busq-alu').value;renderPage()">
        <option value="apellidos"${orden==='apellidos'?' selected':''}>Apellido A→Z</option>
        <option value="nombres"${orden==='nombres'?' selected':''}>Nombre A→Z</option>
      </select>
    </div>
  </div>
  <div class="card">
    ${(()=>{ const _vm = V('miembro'); const _vms = V('miembros'); return lista.length===0?`<div class="empty-state"><div class="empty-icon">👥</div><div>${busq?'Sin resultados para "'+escHtml(busq)+'"':('Sin '+_vms+' registrados')}</div>${!busq?`<div style="margin-top:8px"><button class="btn bp" onclick="showModal('addAlumno')">+ Agregar primer ${_vm}</button></div>`:''}</div>`:`
    <div class="tbl-wrap"><table>
      <thead><tr><th onclick="S.params.ordenAlu='apellidos';S.params.busqAlu=document.getElementById('busq-alu')?.value||'';renderPage()" style="cursor:pointer;user-select:none">Alumno ${orden==='apellidos'?'▲':''}</th><th>Estado</th><th>PIN apoderado</th><th>Apoderados</th><th></th></tr></thead>
      <tbody>
        ${lista.map(a=>{
          const aps=(DB.apoderados||[]).filter(x=>x.alumnoId===a.id);
          const apConTel = aps.find(ap=>ap.telefono);
          const cur = getCurso();
          return `<tr>
            <td>
              <div style="font-weight:600">${escHtml(a.apellidos)}, ${escHtml(a.nombres)}</div>
            </td>
            <td><span class="badge ${a.estado==='activo'?'bgg':'bgt'}">${a.estado==='activo'?'Activo':'Retirado'}</span></td>
            <td>
              ${a.pin
                ? `<div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap">
                    <code style="font-size:14px;font-weight:700;letter-spacing:2px;color:var(--g);background:var(--gl);padding:3px 8px;border-radius:5px">${escHtml(a.pin)}</code>
                    <button class="btn bs" title="Copiar PIN" onclick="copiarPin('${escHtml(a.pin)}',this)" style="padding:3px 7px;font-size:11px">📋</button>
                    <button class="btn bs" title="${apConTel?'Enviar por WhatsApp a '+escHtml(apConTel.nombre):'Sin teléfono registrado'}"
                      onclick="enviarPinWsp('${a.id}')"
                      style="padding:3px 7px;font-size:11px;background:${apConTel?'#25D366':'var(--bg)'};color:${apConTel?'#fff':'var(--t3)'};border-color:${apConTel?'#25D366':'var(--brd)'}">
                      💬${apConTel?'':' —'}
                    </button>
                  </div>`
                : `<span class="badge bga" style="cursor:pointer" onclick="showModal('editAlumno',{id:'${a.id}'})">⚠ Sin PIN</span>`
              }
            </td>
            <td><span style="color:var(--t3);font-size:13px">${aps.length} apoderado${aps.length!==1?'s':''}</span></td>
            <td style="white-space:nowrap">
              <button class="btn bs" onclick="showModal('editAlumno',{id:'${a.id}'})">✏️</button>
              <button class="btn bs" onclick="showModal('apoderadosAlumno',{id:'${a.id}'})">👤</button>
              <button class="btn bs bd" onclick="delAlumno('${a.id}')">🗑</button>
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table></div>
    <div style="font-size:12px;color:var(--t3);padding:8px 2px 0">${lista.length} de ${all.length} ${V('miembro')}${all.length!==1?'s':''}</div>`})()}
  </div>

  ${isFondoEspecialActivo() ? `
  <div class="card" style="margin-top:16px">
    <div class="card-title">📊 Resumen de fondos por alumno</div>
    <div class="tbl-wrap">
      <table class="tbl" id="tabla-resumen-fondos">
        <thead>
          <tr>
            <th onclick="ordenarTablaFondos('nombre')" style="cursor:pointer">Alumno ${S.params.ordenFondos==='nombre'?'▲':''}</th>
            <th>Cuotas pagadas</th>
            <th>Fondo actividades</th>
            <th onclick="ordenarTablaFondos('total')" style="cursor:pointer">Total acumulado ${S.params.ordenFondos==='total'?'▲':''}</th>
          </tr>
        </thead>
        <tbody>
          ${(()=>{
            const orden = S.params.ordenFondos||'apellido';
            const tots = all.map(al=>{
              const pagosAlu = getPagos().filter(p=>p.alumnoId===al.id&&p.estado==='pagado');
              const cuotasPagadas = pagosAlu.reduce((s,p)=>s+p.monto,0);
              const {total:fondoAct} = getFondoAlumno(al.id);
              return {...al, cuotasPagadas, fondoAct, total:cuotasPagadas+fondoAct};
            }).sort((a,b)=>
              orden==='total'?(b.total-a.total):
              orden==='nombre'
                ?`${a.nombres} ${a.apellidos}`.localeCompare(`${b.nombres} ${b.apellidos}`,'es')
                :`${a.apellidos} ${a.nombres}`.localeCompare(`${b.apellidos} ${b.nombres}`,'es'));
            const grandTotal = tots.reduce((s,a)=>s+a.total,0);
            return tots.map(al=>`
              <tr>
                <td style="font-weight:600">${escHtml(al.nombres+' '+al.apellidos)}</td>
                <td style="color:var(--g);font-weight:600">${clp(al.cuotasPagadas)}</td>
                <td style="color:#B8860B;font-weight:600">${clp(al.fondoAct)}</td>
                <td style="font-weight:800;color:var(--b)">${clp(al.total)}</td>
              </tr>`).join('')
            + `<tr style="background:var(--gl);font-weight:800">
                <td>TOTAL CURSO</td>
                <td style="color:var(--g)">${clp(tots.reduce((s,a)=>s+a.cuotasPagadas,0))}</td>
                <td style="color:#B8860B">${clp(tots.reduce((s,a)=>s+a.fondoAct,0))}</td>
                <td style="color:var(--b)">${clp(grandTotal)}</td>
              </tr>`;
          })()}
        </tbody>
      </table>
    </div>
  </div>` : `
  <div class="card" style="margin-top:16px">
    <div class="card-title">📊 Resumen de cuotas por alumno</div>
    <div class="tbl-wrap">
      <table class="tbl">
        <thead><tr>
          <th onclick="ordenarTablaFondos('nombre')" style="cursor:pointer">Alumno</th>
          <th>Cuotas pagadas</th>
          <th>% Cumplimiento</th>
        </tr></thead>
        <tbody>
          ${(()=>{
            const cuotas = getCuotas();
            return all.map(al=>{
              const pagosAlu = getPagos().filter(p=>p.alumnoId===al.id&&p.estado==='pagado');
              const pagado = pagosAlu.reduce((s,p)=>s+p.monto,0);
              let esperado = 0;
              cuotas.forEach(q=>{
                if(!q.activa) return;
                const mesIni=(q.mesInicio!==undefined&&q.mesInicio!==null)?q.mesInicio:2;
                const mesFin=(q.mesTermino!==undefined&&q.mesTermino!==null)?q.mesTermino+1:12;
                const periodos=q.tipo==='mensual'?MESES.slice(mesIni,mesFin):[1];
                esperado+=q.monto*periodos.length;
              });
              const pct=esperado>0?Math.min(100,Math.round(pagado/esperado*100)):0;
              const color=pct>=80?'var(--g)':pct>=50?'#D97706':'var(--r)';
              return `<tr>
                <td style="font-weight:600">${escHtml(al.nombres+' '+al.apellidos)}</td>
                <td style="color:var(--g);font-weight:600">${clp(pagado)}</td>
                <td><span style="font-weight:700;color:${color}">${pct}%</span>
                  <div style="height:4px;background:var(--brd);border-radius:2px;margin-top:4px;width:80px">
                    <div style="width:${pct}%;height:100%;background:${color};border-radius:2px"></div>
                  </div>
                </td>
              </tr>`;
            }).join('');
          })()}
        </tbody>
      </table>
    </div>
  </div>`}`;
}

function copiarPin(pin, btn){
  navigator.clipboard?.writeText(pin)
    .then(()=>{ const t=btn.textContent; btn.textContent='✓'; setTimeout(()=>btn.textContent=t,1500); })
    .catch(()=>alert('PIN: '+pin));
}

function enviarPinWsp(aluId){
  const alu = (DB.alumnos||[]).find(a=>a.id===aluId);
  if(!alu || !alu.pin){ alert('Este alumno no tiene PIN asignado. Edítalo primero.'); return; }

  const aps = (DB.apoderados||[]).filter(a=>a.alumnoId===aluId && a.telefono);
  if(!aps.length){
    alert('Este '+V('miembro').toLowerCase()+' no tiene '+V('contactos').toLowerCase()+' con número de teléfono registrado.\n\nVe a '+V('miembros')+' → 👤 y agrega el teléfono del '+V('contacto').toLowerCase()+'.');
    return;
  }

  // Si hay más de uno con teléfono, mostrar modal para elegir a quién enviar
  if(aps.length > 1){
    showModal('enviarPinModal', { aluId });
    return;
  }

  // Solo uno con teléfono — enviar directo
  _doEnviarPinWsp(alu, aps[0]);
}

function enviarPinWspIdx(aluId, idx){
  const alu = (DB.alumnos||[]).find(a=>a.id===aluId);
  const aps = (DB.apoderados||[]).filter(a=>a.alumnoId===aluId && a.telefono);
  const ap  = aps[idx];
  if(!alu || !ap) return;
  _doEnviarPinWsp(alu, ap);
}

function getAppUrl(){
  // Usar URL guardada en configuración, o la URL actual si es válida
  const guardada = DB.config?.appUrl;
  if(guardada && guardada.startsWith('http')) return guardada.replace(/\/$/, '');
  const actual = window.location.href.split('?')[0].split('#')[0];
  if(actual.startsWith('http')) return actual.replace(/\/$/, '');
  return ''; // URL inválida (about:srcdoc, file://, etc.)
}

function _doEnviarPinWsp(alu, ap){
  const cur = getCurso();
  const col = (DB.colegios||[]).find(c=>c.id===cur.colegioId);
  const appUrl = getAppUrl();
  const codigo = cur.codigo || '';

  if(!appUrl){
    alert('⚠️ La URL de la app no está configurada.\n\nVe a Configuración → "URL de la app" e ingresa la dirección de Netlify antes de enviar PINs.');
    return;
  }

  // Generar link directo (deep link) con código y alumno pre-cargados
  const deepLink = appUrl + '?curso=' + encodeURIComponent(codigo) + '&alu=' + encodeURIComponent(alu.id);

  const msg =
    'Hola ' + (ap.nombre||'apoderado/a') + ' 👋\n\n' +
    'Te enviamos el acceso personal para ver el estado de pagos de *' + alu.nombres + ' ' + alu.apellidos + '* en la app *Tesorero*.\n\n' +
    '🔗 *Acceso directo (más fácil):*\n' +
    deepLink + '\n' +
    '_→ Abre este link, escribe tu PIN y listo. Sin pasos extra._\n\n' +
    '━━━━━━━━━━━━━━━\n' +
    '📱 *O sigue estos pasos manualmente:*\n' +
    '1️⃣ Abre: ' + appUrl + '\n' +
    '2️⃣ Toca *"Soy apoderado"*\n' +
    '3️⃣ Código del curso:\n' +
    '*『 ' + codigo + ' 』*\n' +
    '4️⃣ Selecciona a *' + alu.nombres + '*\n' +
    '5️⃣ Tu PIN personal:\n' +
    '*🔑 ' + alu.pin + ' 🔑*\n\n' +
    '⚠️ Este PIN es personal e intransferible.\n' +
    '— ' + (cur.tesorero||'Tesorero/a') + ' · *Tesorera de curso*\n' +
    '📚 ' + (cur.nombre||'') + '\n' +
    (col?'🏫 '+col.nombre:'');

  const tel = ap.telefono.replace(/\D/g,'');
  const num = tel.startsWith('56') ? tel : '56'+tel;
  window.open('https://wa.me/'+num+'?text='+encodeURIComponent(msg), '_blank', 'noopener');
}

function modalEnviarPin(aluId){
  const alu = (DB.alumnos||[]).find(a=>a.id===aluId);
  const aps = (DB.apoderados||[]).filter(a=>a.alumnoId===aluId && a.telefono);
  return `<div class="modal">
    <div class="modal-hdr">
      <div class="modal-title">💬 Enviar PIN por WhatsApp</div>
      <button class="close-btn" onclick="closeModal()">×</button>
    </div>
    <div class="alert ag" style="margin-bottom:14px">
      Alumno: <strong>${escHtml(alu?.nombres||'')} ${escHtml(alu?.apellidos||'')}</strong>
      · PIN: <code style="font-weight:700;color:var(--g)">${escHtml(alu?.pin||'')}</code>
    </div>
    <p style="font-size:13px;color:var(--t2);margin-bottom:14px">
      ¿A qué apoderado deseas enviarle el PIN?
    </p>
    <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:4px">
      ${aps.map((ap,idx)=>`
        <button onclick="closeModal();enviarPinWspIdx('${aluId}',${idx})"
          style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:#25D366;color:#fff;border:none;border-radius:10px;cursor:pointer;text-align:left;font-family:inherit">
          <span style="font-size:22px">💬</span>
          <div>
            <div style="font-weight:700;font-size:14px">${escHtml(ap.nombre)}</div>
            <div style="font-size:12px;opacity:.85">${escHtml(ap.relacion||'')} · ${escHtml(ap.telefono)}</div>
          </div>
          <span style="margin-left:auto;font-size:18px">↗</span>
        </button>`).join('')}
    </div>
  </div>`;
}

function delAlumno(id){
  if(!confirm('¿Eliminar este alumno? Se eliminarán también sus pagos asociados.')) return;
  DB.alumnos=(DB.alumnos||[]).filter(a=>a.id!==id);
  DB.pagos=(DB.pagos||[]).filter(p=>p.alumnoId!==id);
  saveDB(); go('alumnos');
}

// ─────────────────────────────────────────────
// CUOTAS
// ─────────────────────────────────────────────
