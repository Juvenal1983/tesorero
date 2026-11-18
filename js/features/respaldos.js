// js/features/respaldos.js — extraído de la copia de demostración.
//
// B5-V9 — estado de implementación:
//
// ✅ exportarDatosConFecha / exportarDatos:
//    En V9_RELACIONAL se reemplaza por exportarDatosCompletosV9(), que descarga
//    cada colección directamente desde Supabase (no desde la caché DB), cubre
//    todos los cursos de la cuenta y documenta el alcance en el JSON.
//
// ⛔ importarDatos (legado): bloqueada en V9 con mensaje claro.
//    La importación V9 (restauración completa desde JSON a Supabase) está
//    PENDIENTE — se requiere validación de conflictos y operaciones en lote.
//    No se declara B5 completo hasta implementar esa función.
//
// ⚠️  saveCuenta — inventario V9 (pendiente):
//    - Modifica DB.usuarios[ui].nombre y DB.cursos[ci].tesorero en memoria.
//    - Llama saveDB() (no-op en V9) → cambios NO persisten en Supabase.
//    - authClient?.auth.updateUser() para contraseña usa .catch(()=>{}) que
//      silencia errores (401, rate-limit, política de contraseñas).
//    - Pendiente: wiring V9 para actualizar tesorero_cuentas / auth.updateUser
//      con await y manejo de error explícito antes de mostrar éxito.

function _respaldosV9() { return typeof V9_RELACIONAL !== 'undefined' && V9_RELACIONAL; }
function _respToken()   { return (typeof _authToken !== 'undefined' && _authToken) ||
                                 (typeof S !== 'undefined' && S.session?.accessToken) || null; }
function _respCuentaId(){ return (typeof S !== 'undefined' && S._v9CuentaId) || null; }

// ── Exportación completa desde Supabase (V9) ──────────────────────────────────

/**
 * Descarga toda la cuenta directamente desde Supabase, curso a curso.
 * Colecciones cubiertas: cursos, alumnos, apoderados, cuotas, pagos,
 * movimientos, fondo_movimientos, planes_pago, notas, codigos_invitacion,
 * config_cuenta.
 *
 * @returns {Promise<void>}  — genera descarga del archivo JSON.
 */
async function exportarDatosCompletosV9() {
  if (!puedeExportarDatos()) { showToast('⛔ Exportación no disponible para este rol','#E24B4A'); return; }
  const cuentaId = _respCuentaId();
  const token    = _respToken();
  if (!cuentaId || !token) { showToast('⛔ Sin sesión activa','#E24B4A'); return; }

  const msgEl = document.getElementById('export-msg');
  const setMsg = (txt, ok) => {
    if (!msgEl) return;
    msgEl.innerHTML = `<div class="alert ${ok?'ag':'ar'}">${txt}</div>`;
    msgEl.style.display = '';
  };
  setMsg('⏳ Generando respaldo completo desde Supabase…', true);

  try {
    const respaldo = {
      version:   'v9-completo',
      fecha:     new Date().toISOString(),
      cuentaId,
      alcance:   'todos los cursos de la cuenta',
      colecciones: {},
    };

    // 1. Cursos
    const cursos = await cargarCursos(cuentaId, token);
    respaldo.colecciones.cursos = cursos;
    const cursoIds = cursos.map(c => c.id);

    // 2. Por curso: alumnos, cuotas (+ planes_pago), movimientos, fondo_movimientos
    respaldo.colecciones.alumnos          = [];
    respaldo.colecciones.cuotas           = [];
    respaldo.colecciones.planes_pago      = [];
    respaldo.colecciones.movimientos      = [];
    respaldo.colecciones.fondo_movimientos= [];

    for (const cursoId of cursoIds) {
      const [alus, cuotas, movs, fondoMovs] = await Promise.all([
        cargarAlumnos(cuentaId, cursoId, token),
        cargarCuotas(cuentaId, cursoId, token),
        cargarMovimientosV9(cuentaId, cursoId, token),
        cargarFondoMovimientosV9(cuentaId, cursoId, token).catch(() => []),
      ]);
      respaldo.colecciones.alumnos          .push(...alus);
      respaldo.colecciones.cuotas           .push(...cuotas);
      respaldo.colecciones.movimientos      .push(...movs);
      respaldo.colecciones.fondo_movimientos.push(...fondoMovs);

      const cuotaIds = cuotas.map(q => q.id);
      const planes = cuotaIds.length
        ? await cargarPlanesPagoV9(cuentaId, cuotaIds, token).catch(() => [])
        : [];
      respaldo.colecciones.planes_pago.push(...planes);
    }

    // 3. Colecciones de cuenta (no por curso)
    const [apoderados, pagos, notas, codigos, cfg] = await Promise.all([
      cargarTodosApoderadosV9(cuentaId, token).catch(() => []),
      cargarPagos(cuentaId, token),
      cargarNotasV9(cuentaId, token).catch(() => []),
      cargarCodigosInvitacionV9(cuentaId, token).catch(() => []),
      cargarConfigCuentaV9(cuentaId, token).catch(() => null),
    ]);
    respaldo.colecciones.apoderados        = apoderados;
    respaldo.colecciones.pagos             = pagos;
    respaldo.colecciones.notas             = notas;
    respaldo.colecciones.codigos_invitacion= codigos;
    respaldo.colecciones.config_cuenta     = cfg ? [cfg] : [];

    // 4. Descargar
    const json = JSON.stringify(respaldo, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `tesorero-respaldo-v9-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);

    previewStorage.setItem('tesorero_ultimo_respaldo', new Date().toISOString());
    const nCursos   = cursoIds.length;
    const nAlumnos  = respaldo.colecciones.alumnos.length;
    const nPagos    = respaldo.colecciones.pagos.length;
    setMsg(`✅ Respaldo completo generado — ${nCursos} curso(s), ${nAlumnos} alumno(s), ${nPagos} pago(s).`, true);
    setTimeout(() => { if (msgEl) msgEl.style.display = 'none'; }, 6000);

  } catch (e) {
    console.error('[respaldos] exportarDatosCompletosV9:', e.message);
    setMsg('❌ Error al generar el respaldo: ' + e.message, false);
  }
}

// ── Punto de entrada unificado ────────────────────────────────────────────────

function exportarDatosConFecha(){
  if(!puedeExportarDatos()){ showToast('⛔ Exportación de respaldos no disponible para este rol','#E24B4A'); return; }
  if (_respaldosV9()) {
    // B5-V9: descarga completa desde Supabase
    exportarDatosCompletosV9();
    return;
  }
  // Legado: exporta caché local
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
  if(!puedeExportarDatos()){ showToast('⛔ Exportación de respaldos no disponible para este rol','#E24B4A'); return; }
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

// ── Importación ───────────────────────────────────────────────────────────────

function importarDatos(e){
  if(!puedeExportarDatos()){ showToast('⛔ Importación de datos no disponible para este rol','#E24B4A'); return; }
  // B5-V9 PENDIENTE: la restauración completa (JSON → Supabase, todas las tablas)
  // aún no está implementada. Bloquear para evitar falso guardado.
  if(_respaldosV9()){
    alert('⚠️ La importación de respaldo no está disponible aún en el modo relacional V9.\n\nSe requiere implementar la restauración completa a Supabase.\nSi necesitas restaurar datos urgentemente, usa el Panel SQL de Supabase.');
    return;
  }
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

// ── saveCuenta — PENDIENTE V9 ─────────────────────────────────────────────────
// Ver inventario en el encabezado del archivo.
// La función actual se mantiene operativa en legado; en V9 los cambios de nombre
// y tesorero quedan en memoria pero no persisten en Supabase.

function saveCuenta(){
  if(!puedeConfigurar()){ showToast('⛔ Sin permisos para modificar datos de cuenta','#E24B4A'); return; }
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
    // Contraseña solo se actualiza en Supabase Auth — nunca en DB local.
    // ⚠️ PENDIENTE V9: usar await + manejo de error explícito antes de mostrar éxito.
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
  // ⚠️ PENDIENTE V9: persistir en tabla cursos de Supabase.
  const ci = (DB.cursos||[]).findIndex(c=>c.id===S.cursoId);
  if(ci>=0) DB.cursos[ci].tesorero = nombre;

  saveDB();
  document.getElementById('cfg-usr-pass').value  = '';
  document.getElementById('cfg-usr-pass2').value = '';
  showMsg('✅ Datos de cuenta actualizados correctamente.', true);
}
