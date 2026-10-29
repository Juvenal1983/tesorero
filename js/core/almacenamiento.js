// js/core/almacenamiento.js — extraído de la copia de demostración.
let KEY = 'tesorero_5bsscc_2026';

function setUserKey(userId){
  if(!userId) return;
  const newKey = 'tesorero_u_' + userId;
  if(newKey === KEY) return;
  KEY = newKey;
  // Cargar datos del nuevo usuario desde su propio previewStorage
  try {
    const raw = previewStorage.getItem(KEY);
    if(raw) DB = JSON.parse(raw);
    else DB = { usuarios:[], alumnos:[], pagos:[], cuotas:[], movimientos:[] };
  } catch(e) {
    DB = { usuarios:[], alumnos:[], pagos:[], cuotas:[], movimientos:[] };
  }
  // Eliminar la clave legacy para que no compita
  previewStorage.removeItem('tesorero_5bsscc_2026');
}

function showToast(msg, color){
  const existing = document.getElementById('app-toast');
  if(existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'app-toast';
  toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:'+(color||'#0F6E56')+';color:#fff;padding:10px 22px;border-radius:20px;font-size:13px;font-weight:600;z-index:99999;box-shadow:0 2px 12px rgba(0,0,0,0.25);max-width:90vw;text-align:center';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(function(){ toast.remove(); }, 3500);
}
let S = {
  session: null,
  route: 'login',
  cursoId: null,
  modal: null,
  params: {}
};
let DB = {};

function getUser(){ return S.session; }

// ── Supabase helpers ─────────────────────────────────
async function sbFetch(path, opts={}){
  const token = _authToken || SUPA_KEY;
  return fetch(SUPA_URL+path,{...opts,
    headers:{'apikey':SUPA_KEY,'Authorization':'Bearer '+token,
      'Content-Type':'application/json',...(opts.headers||{})}});
}
async function sbGet(table, filters=''){
  try{ const r=await sbFetch('/rest/v1/'+table+'?'+filters+'&limit=500');
    return r.ok?await r.json():[];
  }catch(e){return [];}
}
function dbSinBase64(){
  // Clonar DB excluyendo el campo 'archivos' de movimientos
  // Los archivos base64 solo se guardan en previewStorage, no en Supabase
  // Esto evita subir MBs de base64 en cada guardado
  const clone = JSON.parse(JSON.stringify(DB));
  if(clone.movimientos && Array.isArray(clone.movimientos)){
    clone.movimientos = clone.movimientos.map(m=>{
      if(!m.archivos || !m.archivos.length) return m;
      // Guardar solo metadata, no el base64
      return {
        ...m,
        archivos: m.archivos.map(a=>({
          nombre: a.nombre,
          tipo: a.tipo,
          size: a.size || 0,
          url: a.url || null,  // Preservar URL de Storage
          // NO incluir a.data (el base64)
        }))
      };
    });
  }
  return clone;
}

let _lastCloudTimestamp = null;

async function saveToCloud(userId){
  if(!userId) return;
  try{
    const datosParaNube = dbSinBase64();
    const ahora = new Date().toISOString();
    const res = await sbFetch('/rest/v1/tesorero_datos',{method:'POST',
      headers:{'Prefer':'resolution=merge-duplicates'},
      body:JSON.stringify({
        usuario_id: userId,
        datos: datosParaNube,
        actualizado_en: ahora
      })});
    _lastCloudTimestamp = ahora;
    // Guardar timestamp de última subida exitosa para comparar en loadFromCloud
    previewStorage.setItem('tesorero_ts_'+userId, ahora);
  }catch(e){
    console.warn('saveToCloud error:', e?.message||e);
  }
}

async function loadFromCloud(userId){
  const rows=await sbGet('tesorero_datos','usuario_id=eq.'+encodeURIComponent(userId));
  if(rows&&rows.length>0&&rows[0].datos){
    const datosNube = rows[0].datos;
    const tsNube = new Date(rows[0].actualizado_en||0).getTime();

    // Comparar timestamp local vs nube
    const tsLocalStr = DB._lastSaved || previewStorage.getItem('tesorero_ts_'+userId) || '0';
    const tsLocal = new Date(tsLocalStr).getTime();

    if(tsLocal > tsNube){
      // Local es más reciente — conservar y subir a la nube
      console.log('Local más reciente que nube — conservando local y subiendo');
      _lastCloudTimestamp = rows[0].actualizado_en;
      setTimeout(()=>saveToCloud(userId).catch(()=>{}), 1000);
      return true;
    }

    // Nube es más reciente — usar datos de la nube
    const archivosLocales = {};
    (DB.movimientos||[]).forEach(m=>{
      if(m.archivos && m.archivos.some(a=>a.data)) archivosLocales[m.id] = m.archivos;
    });
    DB = datosNube;
    if(DB.movimientos) DB.movimientos.forEach(m=>{
      if(archivosLocales[m.id]) m.archivos = archivosLocales[m.id];
    });
    previewStorage.setItem(KEY, JSON.stringify(DB));
    _lastCloudTimestamp = rows[0].actualizado_en || new Date().toISOString();
    return true;
  }
  return false;
}
async function sbUpdateCode(codigo,data){
  try{ await sbFetch('/rest/v1/codigos_invitacion?codigo=eq.'+encodeURIComponent(codigo),
    {method:'PATCH',body:JSON.stringify(data)});
  }catch(e){}
}
async function sbSaveCode(obj){
  try{
    const venc = obj.venceEl
      ? new Date(obj.venceEl).toISOString()
      : obj.tipo==='anual'
        ? new Date(new Date().setFullYear(new Date().getFullYear()+1)).toISOString()
        : obj.tipo==='vip'
          ? null
          : new Date(new Date().setDate(new Date().getDate()+30)).toISOString();
    await sbFetch('/rest/v1/codigos_invitacion',{method:'POST',
      headers:{'Prefer':'resolution=merge-duplicates'},
      body:JSON.stringify({
        codigo: obj.codigo,
        tipo: obj.tipo||'prueba',
        activo: true,
        usado: false,
        creado_en: new Date().toISOString().slice(0,10),
        owner_id: getUser()?.id||'u1',
        vencimiento: venc,
        entregado_a: obj.para||null
      })});
  }catch(e){ console.log('sbSaveCode error:',e); }
}

function getUsuarioId(){ return S&&S.session&&S.session.id?S.session.id:null; }

function datosDelUsuario(userId){
  if(!userId) return DB;
  const cursosIds=((DB.usuarios||[]).find(function(u){return u.id===userId;})||{}).cursoIds||[];
  return {
    usuarios:(DB.usuarios||[]).filter(function(u){return u.id===userId;}),
    colegios:DB.colegios||[],
    cursos:(DB.cursos||[]).filter(function(c){return cursosIds.indexOf(c.id)>=0;}),
    alumnos:(DB.alumnos||[]).filter(function(a){return cursosIds.indexOf(a.cursoId)>=0;}),
    apoderados:(DB.apoderados||[]).filter(function(ap){
      const al=(DB.alumnos||[]).find(function(x){return x.id===ap.alumnoId;});
      return al&&cursosIds.indexOf(al.cursoId)>=0;
    }),
    cuotas:(DB.cuotas||[]).filter(function(c){return cursosIds.indexOf(c.cursoId)>=0;}),
    pagos:(DB.pagos||[]).filter(function(p){
      const cu=(DB.cuotas||[]).find(function(c){return c.id===p.cuotaId;});
      return cu&&cursosIds.indexOf(cu.cursoId)>=0;
    }),
    movimientos:(DB.movimientos||[]).filter(function(m){return cursosIds.indexOf(m.cursoId)>=0;}),
    config:DB.config||{}
  };
}

let _saveCloudTimer = null;

function _setSyncStatus(status){
  let el = document.getElementById('sync-status');
  if(!el){
    el = document.createElement('div');
    el.id = 'sync-status';
    el.style.cssText = [
      'position:fixed',
      'bottom:80px',
      'left:50%',
      'transform:translateX(-50%)',
      'z-index:9999',
      'font-size:13px',
      'font-weight:700',
      'padding:10px 20px',
      'border-radius:50px',
      'box-shadow:0 4px 16px rgba(0,0,0,.12)',
      'pointer-events:none',
      'transition:opacity .4s, transform .4s',
      'white-space:nowrap',
      'font-family:inherit',
    ].join(';');
    document.body.appendChild(el);
  }
  if(status === 'saving'){
    el.style.opacity = '1';
    el.style.transform = 'translateX(-50%) translateY(0)';
    el.style.background = '#EFF6FF';
    el.style.color = '#1D4ED8';
    el.style.border = '1.5px solid #BFDBFE';
    el.textContent = '⏳ Guardando en la nube…';
  } else if(status === 'saved'){
    el.style.opacity = '1';
    el.style.transform = 'translateX(-50%) translateY(0)';
    el.style.background = '#F0FDF4';
    el.style.color = '#15803D';
    el.style.border = '1.5px solid #BBF7D0';
    el.textContent = '✓ Datos guardados';
    setTimeout(()=>{
      el.style.opacity = '0';
      el.style.transform = 'translateX(-50%) translateY(10px)';
    }, 2500);
  } else {
    el.style.opacity = '0';
    el.style.transform = 'translateX(-50%) translateY(10px)';
  }
}

function saveDB(){
  const ahora = new Date().toISOString();
  DB._lastSaved = ahora;
  previewStorage.setItem(KEY, JSON.stringify(DB));
  const u = S && S.session;
  if(!u || typeof saveToCloud !== 'function') return;
  const cloudId = u.authId || u.id;
  // Guardar timestamp local inmediatamente para que loadFromCloud sepa que local es más reciente
  previewStorage.setItem('tesorero_ts_'+cloudId, ahora);
  _setSyncStatus('saving');
  clearTimeout(_saveCloudTimer);
  _saveCloudTimer = setTimeout(()=>{
    saveToCloud(cloudId)
      .then(()=>_setSyncStatus('saved'))
      .catch(()=>_setSyncStatus(null));
  }, 1000); // reducido de 4s a 1s para sincronizar más rápido
}
// Guardar inmediatamente antes de cerrar la pestaña
// fetch con keepalive=true garantiza el envío aunque se cierre la ventana,
// a diferencia de sendBeacon que no permite cabeceras personalizadas (Supabase las requiere).
window.addEventListener('beforeunload', ()=>{
  const u = S && S.session;
  if(u && _saveCloudTimer){
    clearTimeout(_saveCloudTimer);
    const cloudId = u.authId || u.id; // usar UUID de auth para RLS
    const payload = JSON.stringify({
      usuario_id: cloudId,
      datos: dbSinBase64(),
      actualizado_en: new Date().toISOString()
    });
    fetch(SUPA_URL + '/rest/v1/tesorero_datos', {
      method: 'POST',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPA_KEY,
        'Authorization': 'Bearer ' + (_authToken || SUPA_KEY),
        'Prefer': 'resolution=merge-duplicates'
      },
      body: payload
    });
  }
});
function initDB(){
  // Si ya existe una clave tesorero_u_* (usuario logueado antes),
  // eliminar la clave legacy tesorero_5bsscc_2026 para evitar conflictos
  const tieneClaveUsuario = Object.keys(previewStorage).some(k => k.startsWith('tesorero_u_'));
  if(tieneClaveUsuario) previewStorage.removeItem('tesorero_5bsscc_2026');

  try { const raw = previewStorage.getItem(KEY); if(raw) DB = JSON.parse(raw); } catch(e){}

  // Migración automática: si no hay datos nuevos, buscar datos de versiones anteriores
  if(!DB.usuarios){
    const CLAVES_ANTERIORES = ['tesorero_db_v1','tesorero_db_v2','tesorero_db'];
    for(const clave of CLAVES_ANTERIORES){
      try{
        const raw = previewStorage.getItem(clave);
        if(raw){
          const viejo = JSON.parse(raw);
          if(viejo.usuarios && viejo.usuarios.length > 0){
            DB = viejo;
            // Actualizar colegio y curso con los datos reales del usuario
            if(DB.colegios && DB.colegios[0]){
              DB.colegios[0].nombre = 'Colegio de demostración';
            }
            if(DB.cursos && DB.cursos[0]){
              DB.cursos[0].nombre  = '5\u00b0 B\u00e1sico B';
              DB.cursos[0].anio    = 2026;
              DB.cursos[0].codigo  = DB.cursos[0].codigo || '5BB-2026-SSCC';
            }
            // Actualizar credenciales al nuevo email
            if(DB.usuarios[0]){
              DB.usuarios[0].email = DB.usuarios[0].email || 'demo@example.invalid';
            }
            saveDB();
            previewStorage.removeItem(clave); // limpiar clave antigua
            console.log('Datos migrados desde: ' + clave);
            return;
          }
        }
      } catch(e){}
    }
    // No se encontró nada: partir con datos iniciales
    DB = JSON.parse(JSON.stringify(DEMO)); saveDB();
  }

  // Migración: asignar código de recuperación a usuarios que no tienen uno
  let guardado = false;
  (DB.usuarios||[]).forEach(u=>{
    if(!u.codigoRecuperacion){
      const chars='23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
      const seg=()=>{ let s=''; for(let i=0;i<4;i++) s+=chars[Math.floor(Math.random()*chars.length)]; return s; };
      u.codigoRecuperacion = 'REC-'+seg()+'-'+seg()+'-'+seg();
      guardado = true;
    }
  });

  // Asegurarse de que el usuario principal (u1) tenga las credenciales correctas
  // Solo lo actualiza si su email o pass siguen siendo los valores originales de demo
  const u1 = (DB.usuarios||[]).find(u=>u.id==='u1');
  if(u1){
    let changed = false;
    if(!u1.email){ u1.email='demo@example.invalid'; changed=true; }
    // Las contraseñas se gestionan exclusivamente en Supabase Auth — nunca en DB local
    if(u1.pass){ delete u1.pass; changed=true; }
    // El usuario original nunca debe tener invitado:true
    if(u1.invitado){ u1.invitado=false; changed=true; }
    if(changed) guardado=true;
  }

  if(guardado) saveDB();
}

// ─────────────────────────────────────────────
// UTILIDADES
// ─────────────────────────────────────────────
