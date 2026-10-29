// js/features/respaldos.js — extraído de la copia de demostración.
function exportarDatosConFecha(){
  exportarDatos();
  previewStorage.setItem('tesorero_ultimo_respaldo', new Date().toISOString());
  const msg = document.getElementById('export-msg');
  if(msg){
    msg.innerHTML = '<div class="alert ag">✅ Respaldo exportado correctamente. Guárdalo en un lugar seguro.</div>';
    msg.style.display = '';
    setTimeout(()=>{ msg.style.display='none'; }, 4000);
  }
}

function exportarDatos(){
  const userId = getUsuarioId();
  const datos = datosDelUsuario(userId);
  const json = JSON.stringify(datos, null, 2);
  const blob = new Blob([json], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tesorero-respaldo-' + new Date().toISOString().slice(0,10) + '.json';
  a.click();
  URL.revokeObjectURL(url);
}

function importarDatos(e){
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try{
      let parsed = JSON.parse(ev.target.result);
      // El respaldo automático tiene estructura {fecha, userId, datos}
      const datos = parsed.datos || parsed;
      if(!datos.usuarios) throw new Error('Archivo inválido');
      if(!confirm('¿Importar estos datos? Se combinarán con los existentes.')) return;
      const merge = (arr1, arr2, key='id') => {
        const map = {};
        (arr1||[]).forEach(x=>map[x[key]]=x);
        (arr2||[]).forEach(x=>map[x[key]]=x);
        return Object.values(map);
      };
      DB.usuarios   = merge(DB.usuarios,   datos.usuarios);
      DB.colegios   = merge(DB.colegios,   datos.colegios);
      DB.cursos     = merge(DB.cursos,     datos.cursos);
      DB.alumnos    = merge(DB.alumnos,    datos.alumnos);
      DB.apoderados = merge(DB.apoderados, datos.apoderados);
      DB.cuotas     = merge(DB.cuotas,     datos.cuotas);
      DB.pagos      = merge(DB.pagos,      datos.pagos);
      DB.movimientos= merge(DB.movimientos,datos.movimientos);
      if(datos.config) DB.config = {...(DB.config||{}), ...datos.config};
      saveDB();
      const msg = document.getElementById('import-msg');
      if(msg){ msg.innerHTML='<div class="alert ag">✅ Datos importados correctamente.</div>'; msg.style.display=''; }
      setTimeout(()=>render(), 1500);
    } catch(err){
      const msg = document.getElementById('import-msg');
      if(msg){ msg.innerHTML='<div class="alert ar">❌ Error al importar: '+err.message+'</div>'; msg.style.display=''; }
    }
  };
  reader.readAsText(file);
}

function saveCuenta(){
  const nombre = document.getElementById('cfg-usr-nombre').value.trim();
  const email  = document.getElementById('cfg-usr-email').value.trim().toLowerCase();
  const pass   = document.getElementById('cfg-usr-pass').value;
  const pass2  = document.getElementById('cfg-usr-pass2').value;
  const msgEl  = document.getElementById('cuenta-msg');

  const showMsg = (txt, ok) => {
    msgEl.innerHTML = `<div class="${ok?'alert ag':'alert ar'}">${txt}</div>`;
    msgEl.style.display = '';
    setTimeout(()=>{ msgEl.style.display='none'; }, 4000);
  };

  if(!nombre){ showMsg('El nombre no puede estar vacío.', false); return; }
  if(!email || !email.includes('@')){ showMsg('Ingresa un correo válido.', false); return; }
  if(pass && pass.length < 6){ showMsg('La contraseña debe tener al menos 6 caracteres.', false); return; }
  if(pass && pass !== pass2){ showMsg('Las contraseñas no coinciden.', false); return; }

  const ui = (DB.usuarios||[]).findIndex(u=>u.id===S.session.id);
  if(ui < 0){ showMsg('No se encontró el usuario.', false); return; }

  DB.usuarios[ui].nombre = nombre;
  DB.usuarios[ui].email  = email;
  if(pass){
    // Contraseña solo se actualiza en Supabase Auth — nunca en DB local
    delete DB.usuarios[ui].pass;
    authClient?.auth.updateUser({ password: pass }).catch(()=>{});
    // Regenerar código de recuperación al cambiar contraseña
    const nuevoCodigo = generarCodigoRecuperacion();
    DB.usuarios[ui].codigoRecuperacion = nuevoCodigo;
    saveDB();
    document.getElementById('cfg-usr-pass').value  = '';
    document.getElementById('cfg-usr-pass2').value = '';
    showMsg('✅ Datos actualizados. Se generó un nuevo código de recuperación.', true);
    // Mostrar nuevo código de recuperación
    setTimeout(()=> mostrarCodigoRecuperacion(nuevoCodigo, 'cambio'), 300);
    return;
  }

  // Actualizar sesión activa
  S.session.nombre = nombre;
  S.session.email  = email;

  // Actualizar nombre del tesorero en el curso
  const ci = (DB.cursos||[]).findIndex(c=>c.id===S.cursoId);
  if(ci>=0) DB.cursos[ci].tesorero = nombre;

  saveDB();
  document.getElementById('cfg-usr-pass').value  = '';
  document.getElementById('cfg-usr-pass2').value = '';
  showMsg('✅ Datos de cuenta actualizados correctamente.', true);
}

