// js/features/alumnos-formularios.js — extraído de la copia de demostración.
function modalAlumno(id){
  const a=id?(DB.alumnos||[]).find(x=>x.id===id):null;
  return `<div class="modal">
    <div class="modal-hdr"><div class="modal-title">${a?'Editar '+V('miembro'):'Agregar '+V('miembro')}</div><button class="close-btn" onclick="closeModal()">×</button></div>
    <div class="fg-row">
      <div class="fg"><label class="fl">Nombres</label><input class="fi" id="m-nombres" value="${escHtml(a?.nombres||'')}"></div>
      <div class="fg"><label class="fl">Apellidos</label><input class="fi" id="m-apellidos" value="${escHtml(a?.apellidos||'')}"></div>
    </div>
    <div class="fg"><label class="fl">Estado</label><select class="fs" id="m-estado"><option value="activo"${!a||a.estado==='activo'?' selected':''}>Activo</option><option value="retirado"${a?.estado==='retirado'?' selected':''}>Retirado</option></select></div>
    <div class="fg"><label class="fl">Observaciones</label><input class="fi" id="m-obs" value="${escHtml(a?.obs||'')}"></div>
    <div style="background:#FFF8E7;border-radius:10px;padding:12px 14px;margin-top:4px">
      <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer">
        <input type="checkbox" id="m-eximido" ${a?.eximido?'checked':''} style="margin-top:2px;width:18px;height:18px;accent-color:var(--g);flex-shrink:0">
        <div>
          <div style="font-size:13px;font-weight:700;color:#B8860B">🟡 Eximido de cuotas del curso</div>
          <div style="font-size:12px;color:#666;margin-top:2px;line-height:1.5">El alumno quedará marcado como al día en todas las cuotas sin necesidad de registrar pagos. Puede participar normalmente en actividades del Fondo Especial.</div>
        </div>
      </label>
    </div>
    <div style="border-top:1px solid var(--brd);margin-top:14px;padding-top:14px">
      <div style="font-size:13px;font-weight:700;color:var(--t2);margin-bottom:6px">🔐 PIN de acceso para apoderado</div>
      <div style="font-size:12px;color:var(--t3);margin-bottom:10px">
        El apoderado necesitará este PIN para ver el estado de pagos de su hijo/a. Entrégaselo personalmente.
      </div>
      <div class="fg-row">
        <div class="fg">
          <label class="fl">PIN (mínimo 4 caracteres)</label>
          <input class="fi" id="m-pin" type="text" value="${escHtml(a?.pin||'')}"
            placeholder="Ej: 1234 o marte25"
            style="font-size:16px;letter-spacing:2px"
            autocomplete="off">
        </div>
        <div class="fg" style="display:flex;align-items:flex-end">
          <button type="button" class="btn bs" onclick="generarPinAleatorio()" style="width:100%;justify-content:center">
            🎲 Generar PIN
          </button>
        </div>
      </div>
      ${a?.pin ? `<div style="font-size:12px;color:var(--gm);font-weight:600;margin-top:4px">✓ PIN configurado</div>` : `<div style="font-size:12px;color:var(--a);margin-top:4px">⚠ Sin PIN — el/la ${V('contacto')} no podrá acceder</div>`}
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
      <button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn bp" onclick="saveAlumno('${id||''}')">${a?'Guardar cambios':'Agregar'}</button>
    </div>
  </div>`;
}

function generarPinAleatorio(){
  const chars='23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let pin='';
  for(let i=0;i<5;i++) pin+=chars[Math.floor(Math.random()*chars.length)];
  const el=document.getElementById('m-pin');
  if(el) el.value=pin;
}

async function saveAlumno(id){
  const nombres=document.getElementById('m-nombres').value.trim();
  const apellidos=document.getElementById('m-apellidos').value.trim();
  const pin=document.getElementById('m-pin').value.trim();
  if(!nombres||!apellidos){alert('Ingresa nombre y apellidos.');return;}
  if(pin && pin.length < 4){alert('El PIN debe tener al menos 4 caracteres.');return;}
  const eximido = document.getElementById('m-eximido')?.checked || false;
  const estado  = document.getElementById('m-estado').value;
  const obs     = document.getElementById('m-obs').value;

  // ── V9_RELACIONAL: persistir en Supabase ──────────────────────────────────
  if (typeof V9_RELACIONAL !== 'undefined' && V9_RELACIONAL) {
    if (!S._v9CuentaId) { alert('⚠️ Sesión relacional no inicializada (falta _v9CuentaId).'); return; }
    const btn = document.querySelector('[onclick*="saveAlumno"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }
    try {
      let dbRow;
      if (id) {
        dbRow = await actualizarAlumnoV9(S._v9CuentaId, id, { nombres, apellidos, estado, obs, eximido }, _authToken);
      } else {
        dbRow = await crearAlumnoV9(S._v9CuentaId, S.cursoId, { nombres, apellidos, estado, obs, eximido }, _authToken);
      }
      const aluId = id || dbRow.id;

      // ── Recarga relacional de alumnos (garantiza consistencia al volver) ──
      try {
        const alumnosRaw = await cargarAlumnos(S._v9CuentaId, S.cursoId, _authToken);
        DB.alumnos = alumnosRaw.map(_mapAlumno);
      } catch (reloadErr) {
        // Fallback: actualizar caché local si la recarga falla
        console.warn('[saveAlumno v9] recarga falló, usando caché local:', reloadErr.message);
        if (id) {
          const i = (DB.alumnos||[]).findIndex(a => a.id === id);
          if (i >= 0) DB.alumnos[i] = { ...DB.alumnos[i], nombres, apellidos, estado, obs, eximido,
            nombre: `${nombres} ${apellidos}`.trim(), _v9: true };
        } else {
          if (!DB.alumnos) DB.alumnos = [];
          DB.alumnos.push({ id: aluId, cursoId: S.cursoId, nombres, apellidos, estado, obs, eximido,
            nombre: `${nombres} ${apellidos}`.trim(), _v9: true });
        }
      }

      // ── PIN: guardar en servidor via RPC (hash bcrypt) ────────────────────
      if (pin) {
        try {
          await guardarPinV9(S._v9CuentaId, aluId, pin, _authToken);
          // Actualizar caché local solo para mostrar "PIN configurado" en el modal
          const ix = (DB.alumnos||[]).findIndex(a => a.id === aluId);
          if (ix >= 0) DB.alumnos[ix].pin = '****'; // nunca guardar el PIN real en memoria
        } catch (pinErr) {
          // PIN fallido no bloquea el guardado del alumno
          showToast('⚠️ Alumno guardado, pero PIN no pudo guardarse: ' + (pinErr.message || pinErr), '#E8A000');
          console.warn('[saveAlumno v9] PIN error:', pinErr);
        }
      }
      closeModal(); go('alumnos');
    } catch (err) {
      console.error('[saveAlumno v9]', err);
      showToast('❌ Error al guardar alumno: ' + (err.message || err), '#E24B4A');
      if (btn) { btn.disabled = false; btn.textContent = id ? 'Guardar cambios' : 'Agregar'; }
    }
    return;
  }
  // ── legado: blob local ────────────────────────────────────────────────────
  if(id){
    const i=(DB.alumnos||[]).findIndex(a=>a.id===id);
    if(i>=0){DB.alumnos[i]={...DB.alumnos[i],nombres,apellidos,estado,obs,
      pin:pin||DB.alumnos[i].pin||'',eximido};}
  } else {
    if(!DB.alumnos) DB.alumnos=[];
    DB.alumnos.push({id:uid(),cursoId:S.cursoId,nombres,apellidos,estado,obs,pin:pin||'',eximido});
  }
  saveDB(); closeModal(); go('alumnos');
}

function modalEditApoderadoTesorero({apId, alumnoId}){
  const ap=(DB.apoderados||[]).find(a=>a.id===apId);
  if(!ap) return '';
  return `<div class="modal">
    <div class="modal-hdr">
      <div class="modal-title">✏️ Editar apoderado</div>
      <button class="close-btn" onclick="showModal('apoderadosAlumno',{id:'${alumnoId}'})">×</button>
    </div>
    <div class="fg">
      <label class="fl">Nombre completo</label>
      <input class="fi" id="eapt-nombre" value="${escHtml(ap.nombre||'')}">
    </div>
    <div class="fg-row">
      <div class="fg">
        <label class="fl">Relación</label>
        <select class="fs" id="eapt-rel">
          <option${ap.relacion==='Madre'?' selected':''}>Madre</option>
          <option${ap.relacion==='Padre'?' selected':''}>Padre</option>
          <option${ap.relacion==='Tutor/a'?' selected':''}>Tutor/a</option>
          <option${!['Madre','Padre','Tutor/a'].includes(ap.relacion)?' selected':''}>Otro</option>
        </select>
      </div>
      <div class="fg">
        <label class="fl">Teléfono</label>
        <input class="fi" id="eapt-tel" type="tel" value="${escHtml(ap.telefono||'')}" placeholder="+56 9 XXXX XXXX">
      </div>
    </div>
    <div class="fg">
      <label class="fl">Correo electrónico</label>
      <input class="fi" id="eapt-email" type="email" value="${escHtml(ap.email||'')}" placeholder="correo@mail.cl">
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px">
      <button class="btn" onclick="showModal('apoderadosAlumno',{id:'${alumnoId}'})">Cancelar</button>
      <button class="btn bp" onclick="saveEditApTesorero('${apId}','${alumnoId}')">💾 Guardar cambios</button>
    </div>
  </div>`;
}

async function saveEditApTesorero(apId, alumnoId){
  const nombre=document.getElementById('eapt-nombre')?.value.trim();
  if(!nombre){ alert('El nombre es obligatorio.'); return; }
  const relacion=document.getElementById('eapt-rel')?.value;
  const telefono=document.getElementById('eapt-tel')?.value.trim();
  const email=document.getElementById('eapt-email')?.value.trim();

  // ── V9_RELACIONAL ─────────────────────────────────────────────────────────
  if (typeof V9_RELACIONAL !== 'undefined' && V9_RELACIONAL) {
    if (!S._v9CuentaId) { alert('⚠️ Sesión relacional no inicializada.'); return; }
    try {
      await actualizarApoderadoV9(S._v9CuentaId, apId, { nombre, relacion, telefono, email }, _authToken);
      // Recarga relacional de apoderados del alumno
      try {
        const ap = (DB.apoderados||[]).find(a => a.id === apId);
        const aluId = ap?.alumnoId || alumnoId;
        const rows = await cargarApoderadosV9(S._v9CuentaId, aluId, _authToken);
        DB.apoderados = (DB.apoderados||[]).filter(a => a.alumnoId !== aluId)
          .concat(rows.map(_mapApoderado));
      } catch (reloadErr) {
        // Fallback caché local
        const i=(DB.apoderados||[]).findIndex(a=>a.id===apId);
        if(i>=0) DB.apoderados[i]={...DB.apoderados[i], nombre, relacion, telefono, email, _v9:true};
      }
      showModal('apoderadosAlumno',{id:alumnoId});
    } catch (err) {
      console.error('[saveEditApTesorero v9]', err);
      showToast('❌ Error al guardar apoderado: ' + (err.message || err), '#E24B4A');
    }
    return;
  }
  // ── legado ────────────────────────────────────────────────────────────────
  const i=(DB.apoderados||[]).findIndex(a=>a.id===apId);
  if(i<0) return;
  DB.apoderados[i]={...DB.apoderados[i], nombre, relacion, telefono, email};
  saveDB();
  showModal('apoderadosAlumno',{id:alumnoId});
}

function modalApoderados(alumnoId){
  const alu=(DB.alumnos||[]).find(a=>a.id===alumnoId);
  const aps=(DB.apoderados||[]).filter(x=>x.alumnoId===alumnoId);
  const aList=aps.length?aps.map(ap=>`
    <div style="border:1px solid var(--brd);border-radius:10px;padding:14px;margin-bottom:10px;background:var(--wh)">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
        <div style="flex:1">
          <div style="font-weight:700;font-size:15px;color:var(--t1);margin-bottom:4px">${escHtml(ap.nombre)}</div>
          <div style="font-size:12px;color:var(--t3);margin-bottom:2px">👥 ${escHtml(ap.relacion||'Apoderado/a')}</div>
          <div style="font-size:12px;color:var(--t2)">📞 ${ap.telefono?escHtml(ap.telefono):'<em style="color:var(--t3)">Sin teléfono</em>'}</div>
          <div style="font-size:12px;color:var(--t2)">✉️ ${ap.email?escHtml(ap.email):'<em style="color:var(--t3)">Sin correo</em>'}</div>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0">
          <button class="btn bs bp" onclick="showModal('editApoderadoTesorero',{apId:'${ap.id}',alumnoId:'${ap.alumnoId}'})" title="Editar">✏️</button>
          <button class="btn bs bd" onclick="delAp('${ap.id}')" title="Eliminar">🗑</button>
        </div>
      </div>
    </div>`).join(''):'<p style="color:var(--t3);font-size:14px;margin-bottom:12px">Sin apoderados registrados.</p>';
  return `<div class="modal">
    <div class="modal-hdr"><div class="modal-title">${V('contactos')} — ${escHtml(alu?.nombres||'')} ${escHtml(alu?.apellidos||'')}</div><button class="close-btn" onclick="closeModal()">×</button></div>
    <div id="ap-list">${aList}</div>
    <div style="border-top:1px solid var(--brd);padding-top:14px;margin-top:4px">
      <div style="font-size:14px;font-weight:700;margin-bottom:10px">${"Agregar "+V('contacto')}</div>
      <div class="fg-row">
        <div class="fg"><label class="fl">Nombre completo</label><input class="fi" id="ap-nombre" placeholder="Nombre apoderado"></div>
        <div class="fg"><label class="fl">Relación</label><select class="fs" id="ap-rel"><option>Madre</option><option>Padre</option><option>Tutor/a</option><option>Otro</option></select></div>
        <div class="fg"><label class="fl">Teléfono</label><input class="fi" id="ap-tel" placeholder="+56 9 XXXX XXXX"></div>
        <div class="fg"><label class="fl">Email</label><input class="fi" id="ap-email" type="email" placeholder="email@mail.cl"></div>
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button class="btn" onclick="closeModal()">Cerrar</button>
        <button class="btn bp" onclick="saveAp('${alumnoId}')">${"Agregar "+V('contacto')}</button>
      </div>
    </div>
  </div>`;
}
async function saveAp(alumnoId){
  const nombre=document.getElementById('ap-nombre').value.trim();
  if(!nombre){alert('Ingresa el nombre del apoderado.');return;}
  const relacion  = document.getElementById('ap-rel').value;
  const telefono  = document.getElementById('ap-tel').value;
  const email     = document.getElementById('ap-email').value;

  // ── V9_RELACIONAL ─────────────────────────────────────────────────────────
  if (typeof V9_RELACIONAL !== 'undefined' && V9_RELACIONAL) {
    if (!S._v9CuentaId) { alert('⚠️ Sesión relacional no inicializada.'); return; }
    const btn = document.querySelector('[onclick*="saveAp"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }
    try {
      await crearApoderadoV9(S._v9CuentaId, alumnoId, { nombre, relacion, telefono, email }, _authToken);
      // Recarga relacional de apoderados del alumno
      try {
        const rows = await cargarApoderadosV9(S._v9CuentaId, alumnoId, _authToken);
        DB.apoderados = (DB.apoderados||[]).filter(a => a.alumnoId !== alumnoId)
          .concat(rows.map(_mapApoderado));
      } catch (reloadErr) {
        // Fallback caché local si la recarga falla
        if (!DB.apoderados) DB.apoderados = [];
        DB.apoderados.push({ id: uid(), alumnoId, nombre, relacion, telefono, email, estado:'activo', _v9:true });
      }
      showModal('apoderadosAlumno',{id:alumnoId});
    } catch (err) {
      console.error('[saveAp v9]', err);
      showToast('❌ Error al agregar apoderado: ' + (err.message || err), '#E24B4A');
      if (btn) { btn.disabled = false; btn.textContent = `Agregar ${V('contacto')}`; }
    }
    return;
  }
  // ── legado ────────────────────────────────────────────────────────────────
  if(!DB.apoderados) DB.apoderados=[];
  DB.apoderados.push({id:uid(),alumnoId,nombre,relacion,telefono,email,estado:'activo'});
  saveDB(); showModal('apoderadosAlumno',{id:alumnoId});
}
async function delAp(id){
  if(!confirm('¿Eliminar este apoderado?')) return;
  const ap=(DB.apoderados||[]).find(x=>x.id===id);

  // ── V9_RELACIONAL ─────────────────────────────────────────────────────────
  if (typeof V9_RELACIONAL !== 'undefined' && V9_RELACIONAL) {
    if (!S._v9CuentaId) { alert('⚠️ Sesión relacional no inicializada.'); return; }
    try {
      await eliminarApoderadoV9(S._v9CuentaId, id, _authToken);
      // Recarga relacional de apoderados del alumno
      if (ap?.alumnoId) {
        try {
          const rows = await cargarApoderadosV9(S._v9CuentaId, ap.alumnoId, _authToken);
          DB.apoderados = (DB.apoderados||[]).filter(a => a.alumnoId !== ap.alumnoId)
            .concat(rows.map(_mapApoderado));
        } catch (reloadErr) {
          DB.apoderados = (DB.apoderados||[]).filter(x => x.id !== id);
        }
        showModal('apoderadosAlumno',{id:ap.alumnoId});
      } else {
        DB.apoderados = (DB.apoderados||[]).filter(x => x.id !== id);
        closeModal();
      }
    } catch (err) {
      console.error('[delAp v9]', err);
      showToast('❌ Error al eliminar apoderado: ' + (err.message || err), '#E24B4A');
    }
    return;
  }
  // ── legado ────────────────────────────────────────────────────────────────
  DB.apoderados=(DB.apoderados||[]).filter(x=>x.id!==id);
  saveDB(); if(ap) showModal('apoderadosAlumno',{id:ap.alumnoId});
}

