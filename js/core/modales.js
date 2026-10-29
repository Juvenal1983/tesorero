// js/core/modales.js — extraído de la copia de demostración.
function renderModalOverlay(){
  const ov=document.createElement('div');
  ov.className='modal-ov'; ov.id='modal-ov';
  ov.innerHTML=buildModal();
  ov.addEventListener('click',e=>{ if(e.target===ov) closeModal(); });
  document.body.appendChild(ov);
  bindModal();
}

function buildModal(){
  const {type,data}=S.modal;
  switch(type){
    case 'addAlumno': return modalAlumno();
    case 'editAlumno': return modalAlumno(data.id);
    case 'apoderadosAlumno': return modalApoderados(data.id);
    case 'enviarPinModal': return modalEnviarPin(data.aluId);
    case 'addCursoModal':  return modalAddCurso();
    case 'addCuota': return modalCuota();
    case 'editCuota': return modalCuota(data.id);
    case 'addPago': return modalPago(data);
    case 'notificacion': return modalNotificacion(data);
    case 'addMov': return modalMov();
    case 'editMov': return modalEditMov(data);
    case 'addComprobante': return modalAddComprobante(data.id);
    case 'editPago': return modalEditPago(data);
    case 'editAbono': return modalEditAbono(data);
    case 'planPago': return modalPlanPago(data);
    case 'accionCobranza': return modalAccionCobranza(data);
    case 'nuevoMovFondo': return modalNuevoMovFondo();
    case 'editMovFondo': return modalEditMovFondo(data);
    case 'detalleFondoAlumno': return modalDetalleFondoAlumno(data);
    case 'nuevoCodigoModal': return modalNuevoCodigo(data);
    case 'editApoderado': return modalEditApoderadoLector(data);
    case 'editApoderadoTesorero': return modalEditApoderadoTesorero(data);
    case 'addApoderadoLector': return modalAddApoderadoLector(data);
    default: return '';
  }
}

function modalEditApoderadoLector({apId}){
  const ap=(DB.apoderados||[]).find(a=>a.id===apId);
  if(!ap) return '';
  return `<div class="modal">
    <div class="modal-hdr"><div class="modal-title">✏️ Editar mis datos</div><button class="close-btn" onclick="closeModal()">×</button></div>
    <div class="alert ab" style="margin-bottom:14px;font-size:13px">Solo puedes editar tu nombre, teléfono y correo. Para cambios mayores contacta al tesorero.</div>
    <div class="fg"><label class="fl">Nombre completo</label><input class="fi" id="eap-nombre" value="${escHtml(ap.nombre||'')}"></div>
    <div class="fg"><label class="fl">Relación con el alumno</label><input class="fi" id="eap-relacion" value="${escHtml(ap.relacion||'')}" placeholder="Ej: Madre, Padre, Tutor/a"></div>
    <div class="fg"><label class="fl">Teléfono</label><input class="fi" id="eap-tel" type="tel" value="${escHtml(ap.telefono||'')}" placeholder="+56 9 XXXX XXXX"></div>
    <div class="fg"><label class="fl">Correo electrónico</label><input class="fi" id="eap-email" type="email" value="${escHtml(ap.email||'')}" placeholder="correo@mail.cl"></div>
    <div id="eap-msg" style="display:none;margin-bottom:10px"></div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px">
      <button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn bp" onclick="guardarApoderadoLector('${apId}')">💾 Guardar cambios</button>
    </div>
  </div>`;
}

function modalAddApoderadoLector({aluId}){
  return `<div class="modal">
    <div class="modal-hdr"><div class="modal-title">➕ Agregar ${V('contacto')}</div><button class="close-btn" onclick="closeModal()">×</button></div>
    <div class="fg"><label class="fl">Nombre completo</label><input class="fi" id="nap-nombre" placeholder="Nombre del apoderado"></div>
    <div class="fg"><label class="fl">Relación con el alumno</label><input class="fi" id="nap-relacion" placeholder="Ej: Madre, Padre, Tutor/a"></div>
    <div class="fg"><label class="fl">Teléfono</label><input class="fi" id="nap-tel" type="tel" placeholder="+56 9 XXXX XXXX"></div>
    <div class="fg"><label class="fl">Correo electrónico</label><input class="fi" id="nap-email" type="email" placeholder="correo@mail.cl"></div>
    <div id="nap-msg" style="display:none;margin-bottom:10px"></div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px">
      <button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn bp" onclick="agregarApoderadoLector('${aluId}')">➕ Agregar</button>
    </div>
  </div>`;
}

function guardarApoderadoLector(apId){
  const nombre=document.getElementById('eap-nombre')?.value.trim();
  const relacion=document.getElementById('eap-relacion')?.value.trim();
  const telefono=document.getElementById('eap-tel')?.value.trim();
  const email=document.getElementById('eap-email')?.value.trim();
  const msg=document.getElementById('eap-msg');
  if(!nombre){ if(msg){msg.innerHTML='<div class="alert ar">El nombre es obligatorio.</div>';msg.style.display='';} return; }
  const i=(DB.apoderados||[]).findIndex(a=>a.id===apId);
  if(i<0) return;
  DB.apoderados[i]={...DB.apoderados[i],nombre,relacion,telefono,email};
  saveDB();
  closeModal();
  go('mis-datos');
}

function agregarApoderadoLector(aluId){
  const nombre=document.getElementById('nap-nombre')?.value.trim();
  const relacion=document.getElementById('nap-relacion')?.value.trim();
  const telefono=document.getElementById('nap-tel')?.value.trim();
  const email=document.getElementById('nap-email')?.value.trim();
  const msg=document.getElementById('nap-msg');
  if(!nombre){ if(msg){msg.innerHTML='<div class="alert ar">El nombre es obligatorio.</div>';msg.style.display='';} return; }
  if(!DB.apoderados) DB.apoderados=[];
  DB.apoderados.push({id:uid(),alumnoId:aluId,nombre,relacion,telefono,email,estado:'activo'});
  saveDB();
  closeModal();
  go('mis-datos');
}

