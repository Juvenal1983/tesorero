// js/features/cursos.js — extraído de la copia de demostración.
function modalAddCurso(){
  return `<div class="modal">
    <div class="modal-hdr">
      <div class="modal-title">🏢 Agregar nuevo ${V('grupo').toLowerCase()}</div>
      <button class="close-btn" onclick="closeModal()">×</button>
    </div>
    <div class="alert ab" style="margin-bottom:14px">
      Crea un nuevo ${V('grupo').toLowerCase()} vinculado a tu cuenta. Podrás cambiar entre ${V('grupos').toLowerCase()} desde Configuración o el menú lateral.
    </div>
    <div class="fg"><label class="fl">Nombre de la ${V('institucion')}</label>
      <input class="fi" id="nc-colegio" placeholder="Ej: Colegio San Agustín" list="nc-colegios-list">
      <datalist id="nc-colegios-list">
        ${(DB.colegios||[]).map(c=>`<option value="${escHtml(c.nombre)}">`).join('')}
      </datalist>
    </div>
    <div class="fg-row">
      <div class="fg"><label class="fl">Nombre o nivel del curso</label>
        <input class="fi" id="nc-nombre" placeholder="Ej: 6° Básico A">
      </div>
      <div class="fg"><label class="fl">Año académico</label>
        <input class="fi" id="nc-anio" type="number" value="${new Date().getFullYear()}" min="2020" max="2099">
      </div>
    </div>
    <div class="fg-row">
      <div class="fg"><label class="fl">Cuota mensual (CLP)</label>
        <input class="fi" id="nc-cuota-men" type="number" placeholder="Ej: 5000">
      </div>
      <div class="fg"><label class="fl">Cuota anual (CLP)</label>
        <input class="fi" id="nc-cuota-anu" type="number" placeholder="Ej: 40000">
      </div>
    </div>
    <div id="nc-err" class="alert ar" style="display:none;margin-bottom:8px"></div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:4px">
      <button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn bp" onclick="saveNuevoCurso()">Crear curso →</button>
    </div>
  </div>`;
}

function saveNuevoCurso(){
  const colegioNombre = document.getElementById('nc-colegio').value.trim();
  const nombre        = document.getElementById('nc-nombre').value.trim();
  const anio          = parseInt(document.getElementById('nc-anio').value)||new Date().getFullYear();
  const cuotaMen      = parseInt(document.getElementById('nc-cuota-men').value)||0;
  const cuotaAnu      = parseInt(document.getElementById('nc-cuota-anu').value)||0;
  const errEl         = document.getElementById('nc-err');
  const show = msg=>{ errEl.textContent=msg; errEl.style.display=''; };

  if(!colegioNombre) return show('Ingresa el nombre de la '+V('institucion')+'.');
  if(!nombre)        return show('Ingresa el nombre o nivel del curso.');

  errEl.style.display='none';

  // Reusar colegio existente o crear uno nuevo
  let colegioId = (DB.colegios||[]).find(c=>c.nombre.toLowerCase()===colegioNombre.toLowerCase())?.id;
  if(!colegioId){
    colegioId = uid();
    if(!DB.colegios) DB.colegios=[];
    DB.colegios.push({id:colegioId, nombre:colegioNombre, activo:true});
  }

  const curId  = uid();
  const rnd    = Math.random().toString(36).slice(2,6).toUpperCase();
  const prefix = nombre.replace(/[^a-zA-Z0-9]/g,'').slice(0,4).toUpperCase();
  const codigo = prefix+'-'+anio+'-'+rnd;

  if(!DB.cursos) DB.cursos=[];
  DB.cursos.push({
    id:curId, colegioId, nombre, anio,
    tesoreraId:S.session.id, tesorero:S.session.nombre,
    codigo, activo:true,
    cuotaMensual:cuotaMen, cuotaAnual:cuotaAnu, meta:0
  });

  // Agregar cuota mensual automática si se indicó
  if(cuotaMen>0){
    if(!DB.cuotas) DB.cuotas=[];
    DB.cuotas.push({id:uid(), cursoId:curId, tipo:'mensual',
      nombre:'Cuota Mensual '+anio, monto:cuotaMen,
      activa:true, anio, obs:'Vence el día 10 de cada mes'});
  }
  if(cuotaAnu>0){
    if(!DB.cuotas) DB.cuotas=[];
    DB.cuotas.push({id:uid(), cursoId:curId, tipo:'anual',
      nombre:'Cuota Anual '+anio, monto:cuotaAnu,
      activa:true, anio, obs:''});
  }

  // Vincular a la sesión activa
  const ui = (DB.usuarios||[]).findIndex(u=>u.id===S.session.id);
  if(ui>=0){
    if(!DB.usuarios[ui].cursoIds) DB.usuarios[ui].cursoIds=[];
    DB.usuarios[ui].cursoIds.push(curId);
    S.session.cursoIds = [...DB.usuarios[ui].cursoIds];
  }

  saveDB();
  S.cursoId = curId; // cambiar al nuevo curso
  closeModal();
  go('dashboard');
}

function confirmarQuitarCurso(cursoId){
  const c = (DB.cursos||[]).find(x=>x.id===cursoId);
  if(!c) return;
  const alumnos = (DB.alumnos||[]).filter(a=>a.cursoId===cursoId).length;
  const msg = alumnos>0
    ? `¿Desvincular "${c.nombre}"?\n\nEste curso tiene ${alumnos} alumno(s). Los datos se conservarán pero ya no aparecerá en tu cuenta.\n\n¿Continuar?`
    : `¿Desvincular el curso "${c.nombre}" de tu cuenta?`;
  if(!confirm(msg)) return;

  const ui = (DB.usuarios||[]).findIndex(u=>u.id===S.session.id);
  if(ui>=0){
    DB.usuarios[ui].cursoIds = (DB.usuarios[ui].cursoIds||[]).filter(id=>id!==cursoId);
    S.session.cursoIds = [...DB.usuarios[ui].cursoIds];
  }
  // Si era el curso activo, cambiar al primero disponible
  if(S.cursoId===cursoId){
    S.cursoId = S.session.cursoIds[0] || null;
  }
  saveDB();
  go('config');
}

function cambiarTipoOrg(tipo){
  if(!puedeConfigurar()){ showToast('⛔ Sin permisos para modificar la configuración','#E24B4A'); return; }
  if(!DB.config) DB.config={};
  DB.config.tipoOrg = tipo;
  // Aplicar meses por defecto del vocabulario al curso activo
  const cur = getCurso();
  const v = VOCABULARIOS[tipo] || VOCABULARIOS.curso;
  if(cur){
    if(cur.mesInicioCuota === undefined || cur.mesInicioCuota === null)
      cur.mesInicioCuota = v.mesInicioDefault;
    if(cur.mesTerminoCuota === undefined || cur.mesTerminoCuota === null)
      cur.mesTerminoCuota = v.mesFinDefault;
  }
  saveDB();
  showToast(v.icono+' Organización cambiada a: '+v.nombre);
  go('config');
}

function saveAppUrl(){
  if(!puedeConfigurar()){ showToast('⛔ Sin permisos para modificar la configuración','#E24B4A'); return; }
  const url = document.getElementById('cfg-app-url').value.trim().replace(/\/$/, '');
  if(!url){ alert('Ingresa la URL de tu app en Netlify.'); return; }
  if(!url.startsWith('http')){ alert('La URL debe comenzar con https://'); return; }
  if(!DB.config) DB.config={};
  DB.config.appUrl = url;
  saveDB();
  alert('✅ URL guardada. Ahora los mensajes de WhatsApp incluirán el link correcto.');
  go('config');
}

function saveCfg(){
  if(!puedeConfigurar()){ showToast('⛔ Sin permisos para modificar la configuración','#E24B4A'); return; }
  const cur=getCurso();
  const col=(DB.colegios||[]).find(c=>c.id===cur.colegioId);
  if(col) col.nombre=document.getElementById('cfg-colegio').value||col.nombre;
  const ci=(DB.cursos||[]).findIndex(c=>c.id===S.cursoId);
  if(ci>=0){
    DB.cursos[ci].nombre=document.getElementById('cfg-nombre').value||DB.cursos[ci].nombre;
    DB.cursos[ci].anio=parseInt(document.getElementById('cfg-anio').value)||DB.cursos[ci].anio;
    DB.cursos[ci].tesorero=document.getElementById('cfg-tesorero').value||DB.cursos[ci].tesorero;
    DB.cursos[ci].cuotaMensual=parseInt(document.getElementById('cfg-men').value)||DB.cursos[ci].cuotaMensual;
  const mesInicioEl  = document.getElementById('cfg-mes-inicio');
  const mesTerminoEl = document.getElementById('cfg-mes-termino');
  if(mesInicioEl && mesTerminoEl){
    const mesInicio  = parseInt(mesInicioEl.value);
    const mesTermino = parseInt(mesTerminoEl.value);
    DB.cursos[ci].mesInicioCuota  = mesInicio;
    DB.cursos[ci].mesTerminoCuota = mesTermino;
    const qMen = (DB.cuotas||[]).find(q=>q.cursoId===curId&&q.tipo==='mensual');
    if(qMen){ qMen.mesInicio = mesInicio; qMen.mesTermino = mesTermino; }
  }
    DB.cursos[ci].cuotaAnual=parseInt(document.getElementById('cfg-anu').value)||DB.cursos[ci].cuotaAnual;
  }
  saveDB(); alert('✅ Configuración guardada.'); go('config');
}
