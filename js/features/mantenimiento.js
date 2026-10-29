// js/features/mantenimiento.js — extraído de la copia de demostración.
function savePlantillaCfg(){
  if(!DB.config) DB.config={};
  DB.config.plantillaPago = document.getElementById('cfg-plantilla').value.trim();
  saveDB();
  alert('✅ Plantilla guardada. Se usará en los próximos pagos.');
  go('config');
}
function resetPlantillaCfg(){
  if(!confirm('¿Eliminar la plantilla personalizada y volver al mensaje original?')) return;
  if(DB.config) delete DB.config.plantillaPago;
  saveDB();
  go('config');
}
function intentarMigracion(){
  const el = document.getElementById('migracion-resultado');
  const CLAVES = ['tesorero_db_v1','tesorero_db_v2','tesorero_db'];
  for(const clave of CLAVES){
    try{
      const raw = previewStorage.getItem(clave);
      if(!raw) continue;
      const viejo = JSON.parse(raw);
      if(!viejo.usuarios || viejo.usuarios.length === 0) continue;

      const nAlumnos   = (viejo.alumnos||[]).length;
      const nPagos     = (viejo.pagos||[]).length;
      const nMovs      = (viejo.movimientos||[]).length;
      const nApoderados= (viejo.apoderados||[]).length;

      if(!confirm(
        'Se encontraron datos anteriores en "'+clave+'":\n\n'+
        '• '+nAlumnos+' alumnos\n'+
        '• '+nApoderados+' apoderados\n'+
        '• '+nPagos+' pagos\n'+
        '• '+nMovs+' movimientos\n\n'+
        '¿Importar estos datos? Los datos actuales serán reemplazados.'
      )) continue;

      DB = viejo;
      // Actualizar nombre de la ${V('institucion')} y curso
      if(DB.colegios && DB.colegios[0]) DB.colegios[0].nombre = 'Colegio de demostración';
      if(DB.cursos   && DB.cursos[0])   { DB.cursos[0].nombre = '5\u00b0 B\u00e1sico B'; DB.cursos[0].anio = 2026; }
      saveDB();
      previewStorage.removeItem(clave);

      if(el) el.innerHTML = '<div class="alert ag" style="margin-bottom:12px">✅ Datos importados correctamente: '+nAlumnos+' alumnos, '+nPagos+' pagos, '+nMovs+' movimientos.</div>';
      setTimeout(()=>go('dashboard'), 1500);
      return;
    } catch(e){}
  }
  if(el) el.innerHTML = '<div class="alert ar" style="margin-bottom:12px">No se encontraron datos anteriores en este navegador.</div>';
}

function migrarNuevoAnio(){
  const cur = getCurso();
  if(!cur){ alert('No hay curso activo.'); return; }
  const anioActual = cur.anio || new Date().getFullYear();
  const anioNuevo  = anioActual + 1;

  if(!confirm(
    '📅 ¿Iniciar el año académico ' + anioNuevo + '?\n\n' +
    'Se conservarán: alumnos, apoderados, PINs y datos bancarios.\n' +
    'Se eliminarán: pagos, cuotas, ingresos y gastos de ' + anioActual + '.\n\n' +
    'Esta acción no se puede deshacer.'
  )) return;

  if(!confirm(
    '🔴 Segunda confirmación\n\n' +
    '¿Estás seguro/a de migrar al año ' + anioNuevo + '?\n' +
    'Los datos financieros de ' + anioActual + ' se perderán.'
  )) return;

  const ci = (DB.cursos||[]).findIndex(c=>c.id===S.cursoId);
  if(ci<0) return;

  // Actualizar año del curso y generar nuevo código
  const rnd    = Math.random().toString(36).slice(2,6).toUpperCase();
  const prefix = cur.nombre.replace(/[^a-zA-Z0-9]/g,'').slice(0,4).toUpperCase();
  const nuevoCodigo = prefix + '-' + anioNuevo + '-' + rnd;

  DB.cursos[ci].anio   = anioNuevo;
  DB.cursos[ci].codigo = nuevoCodigo;

  // Limpiar pagos del curso
  DB.pagos = (DB.pagos||[]).filter(p=>{
    const cuo = (DB.cuotas||[]).find(c=>c.id===p.cuotaId);
    return !(cuo && cuo.cursoId===S.cursoId);
  });

  // Limpiar cuotas del curso
  DB.cuotas = (DB.cuotas||[]).filter(c=>c.cursoId!==S.cursoId);

  // Limpiar movimientos del curso
  DB.movimientos = (DB.movimientos||[]).filter(m=>m.cursoId!==S.cursoId);

  // Actualizar año en alumnos activos (reactivar retirados si se desea)
  // Los alumnos se mantienen tal cual, solo actualizamos el cursoId que ya está correcto

  // Crear cuota mensual por defecto para el nuevo año si había una antes
  const cuotaMensual = cur.cuotaMensual || 0;
  if(cuotaMensual > 0){
    if(!DB.cuotas) DB.cuotas=[];
    DB.cuotas.push({
      id: uid(), cursoId: S.cursoId,
      tipo: 'mensual', nombre: 'Cuota Mensual ' + anioNuevo,
      monto: cuotaMensual, activa: true, anio: anioNuevo,
      obs: 'Creada automáticamente para el año ' + anioNuevo
    });
  }

  saveDB();

  const msg = document.getElementById('migracion-anio-msg');
  if(msg){
    msg.innerHTML = '<div class="alert ag">✅ ¡Migración completada! Año ' + anioNuevo + ' iniciado correctamente.<br>' +
      '🔑 Nuevo código del curso: <strong>' + nuevoCodigo + '</strong><br>' +
      'Recuerda compartir el nuevo código con los '+V('contactos').toLowerCase()+'.</div>';
    msg.style.display = '';
  }

  // Actualizar la vista
  setTimeout(()=>render(), 1500);
}

function limpiarPagosDuplicados(){
  if(!DB.pagos) return 0;
  const vistos = new Set();
  const sinDuplicados = [];
  let eliminados = 0;
  // Ordenar por fecha para conservar el más reciente
  const ordenados = [...DB.pagos].sort((a,b)=>new Date(b.fecha||0)-new Date(a.fecha||0));
  for(const p of ordenados){
    if(p.estado!=='pagado'){ sinDuplicados.push(p); continue; }
    const key = p.alumnoId+'|'+p.cuotaId+'|'+p.periodo;
    if(vistos.has(key)){
      eliminados++;
    } else {
      vistos.add(key);
      sinDuplicados.push(p);
    }
  }
  if(eliminados>0){
    DB.pagos = sinDuplicados;
    saveDB();
  }
  return eliminados;
}

function resetDemo(){
  if(!confirm('⚠️ ¿Limpiar todos los datos?\n\nSe borrarán todos los alumnos, pagos y movimientos registrados. Esta acción no se puede deshacer.')) return;
  if(!confirm('🔴 Segunda confirmación requerida.\n\n¿Estás completamente seguro/a de que deseas eliminar todos los datos? No hay forma de recuperarlos después.')) return;
  previewStorage.removeItem(KEY);
  DB={};
  S.session=null;
  S.cursoId=null;
  S.modal=null;
  initDB();
  S.route='login';
  render();
}

// ─────────────────────────────────────────────
// MODALES
// ─────────────────────────────────────────────
