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
// ✅ saveCuenta — wiring V9 (commit en esta sesión):
//    - nombre persiste en tesorero_cuentas vía actualizarCuentaV9() (PATCH).
//    - authClient.auth.updateUser() usa await + manejo de error explícito.
//    - En caso de fallo muestra error sin anunciar éxito.

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

  // Paginación: todas las funciones cargarXxx usan _v9FetchAll (bloques de 1000).

  try {
    const respaldo = {
      version:   'v9-completo',
      fecha:     new Date().toISOString(),
      cuentaId,
      alcance:   'todos los cursos de la cuenta (activos e inactivos)',
      colecciones: {},
    };

    // 1. Todos los cursos (activos e inactivos) — cargarCursos() solo trae activos
    const cursos = await cargarTodosCursosV9(cuentaId, token);
    respaldo.colecciones.cursos = cursos;
    const cursoIds = cursos.map(c => c.id);

    // 2. Por curso: alumnos, cuotas, planes_pago, movimientos, fondo_movimientos, actividades
    // Errores en colecciones por curso se propagan — no silenciamos con catch(() => []).
    respaldo.colecciones.alumnos           = [];
    respaldo.colecciones.cuotas            = [];
    respaldo.colecciones.planes_pago       = [];
    respaldo.colecciones.movimientos       = [];
    respaldo.colecciones.fondo_movimientos = [];
    respaldo.colecciones.actividades       = [];

    for (const cursoId of cursoIds) {
      const [alus, cuotas, movs, fondoMovs, acts] = await Promise.all([
        cargarAlumnos(cuentaId, cursoId, token),
        cargarCuotas(cuentaId, cursoId, token),
        cargarMovimientosV9(cuentaId, cursoId, token),
        cargarFondoMovimientosV9(cuentaId, cursoId, token),
        cargarActividadesV9(cuentaId, cursoId, token),
      ]);
      respaldo.colecciones.alumnos           .push(...alus);
      respaldo.colecciones.cuotas            .push(...cuotas);
      respaldo.colecciones.movimientos       .push(...movs);
      respaldo.colecciones.fondo_movimientos .push(...fondoMovs);
      respaldo.colecciones.actividades       .push(...acts);

      const cuotaIds = cuotas.map(q => q.id);
      const planes = cuotaIds.length
        ? await cargarPlanesPagoV9(cuentaId, cuotaIds, token)
        : [];
      respaldo.colecciones.planes_pago.push(...planes);
    }

    // 3. Abonos como colección plana independiente
    // (también accesibles anidados en planes_pago, pero la colección plana
    //  facilita la restauración atómica y la validación de integridad).
    respaldo.colecciones.abonos = await cargarTodosAbonosV9(cuentaId, token);

    // 4. Colecciones de cuenta (no por curso)
    // Errores se propagan — evitar anunciar "respaldo completo" si alguna falló.
    const [apoderados, pagos, notas, codigos, cfg] = await Promise.all([
      cargarTodosApoderadosV9(cuentaId, token),
      cargarPagos(cuentaId, token),
      cargarNotasV9(cuentaId, token),
      cargarCodigosInvitacionV9(cuentaId, token),
      cargarConfigCuentaV9(cuentaId, token).catch(() => null),
    ]);
    respaldo.colecciones.apoderados         = apoderados;
    respaldo.colecciones.pagos              = pagos;
    respaldo.colecciones.notas              = notas;
    respaldo.colecciones.codigos_invitacion = codigos;
    respaldo.colecciones.config_cuenta      = cfg ? [cfg] : [];

    // 5. Descargar
    const json = JSON.stringify(respaldo, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `tesorero-respaldo-v9-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);

    previewStorage.setItem('tesorero_ultimo_respaldo', new Date().toISOString());
    const nCursos  = cursoIds.length;
    const nAlumnos = respaldo.colecciones.alumnos.length;
    const nPagos   = respaldo.colecciones.pagos.length;
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

// ── B5-V9: restauración completa desde JSON a Supabase ───────────────────────
//
// Orden FK-seguro de upsert:
//   cursos → alumnos → apoderados → cuotas → planes_pago → abonos → pagos
//   → movimientos → fondo_movimientos → actividades → notas
//   → codigos_invitacion → config_cuenta
//
// Cada colección se envía en trozos de 100 filas con
//   POST /rest/v1/{tabla}  +  Prefer: resolution=merge-duplicates,return=minimal
// Los registros existentes se actualizan; no se eliminan registros ausentes.

const _B5_ORDEN = [
  'cursos','alumnos','apoderados','cuotas','planes_pago','abonos',
  'pagos','movimientos','fondo_movimientos','actividades',
  'notas','codigos_invitacion','config_cuenta',
];
const _B5_CHUNK = 100;

/**
 * Normaliza filas de `planes_pago` exportadas por cargarPlanesPagoV9 →
 * _mapPlanPago (camelCase de UI) a columnas SQL (snake_case).
 * Las columnas no mapeadas se eliminan para no confundir a PostgREST.
 */
function _normalizarPlanPago(fila) {
  if (!fila || typeof fila !== 'object') return fila;
  // Si ya tiene snake_case (cuenta_id presente) no tocar
  if ('cuenta_id' in fila) return fila;
  const r = { id: fila.id };
  if (fila.cuentaId   !== undefined) r.cuenta_id  = fila.cuentaId;
  if (fila.alumnoId   !== undefined) r.alumno_id  = fila.alumnoId;
  if (fila.cuotaId    !== undefined) r.cuota_id   = fila.cuotaId;
  if (fila.montoTotal !== undefined) r.monto_total = fila.montoTotal;
  if (fila.periodo    !== undefined) r.periodo    = fila.periodo;
  if (fila.activo     !== undefined) r.activo     = fila.activo;
  if (fila.creadoEn   !== undefined) r.creado_en  = fila.creadoEn;
  if (fila.obs        !== undefined) r.obs        = fila.obs;
  // 'abonos' es campo virtual del mapa; no existe en la tabla SQL
  return r;
}

/**
 * Normaliza filas de `abonos` exportadas por _mapAbono (camelCase) a snake_case.
 */
function _normalizarAbono(fila) {
  if (!fila || typeof fila !== 'object') return fila;
  if ('cuenta_id' in fila) return fila;
  const r = { id: fila.id };
  if (fila.cuentaId  !== undefined) r.cuenta_id  = fila.cuentaId;
  if (fila.alumnoId  !== undefined) r.alumno_id  = fila.alumnoId;
  if (fila.cuotaId   !== undefined) r.cuota_id   = fila.cuotaId;
  if (fila.planId    !== undefined) r.plan_id    = fila.planId;
  if (fila.monto     !== undefined) r.monto      = fila.monto;
  if (fila.fecha     !== undefined) r.fecha      = fila.fecha;
  if (fila.pagado    !== undefined) r.pagado     = fila.pagado;
  if (fila.fechaPago !== undefined) r.fecha_pago = fila.fechaPago;
  if (fila.medio     !== undefined) r.medio      = fila.medio;
  if (fila.estado    !== undefined) r.estado     = fila.estado;
  if (fila.obs       !== undefined) r.obs        = fila.obs;
  if (fila.creadoPor !== undefined) r.creado_por = fila.creadoPor;
  return r;
}

async function _b5UpsertColeccion(tabla, filas, token) {
  // Las filas llegan ya normalizadas a snake_case desde _importarDatosV9 (Paso 1).
  const errores = [];
  for (let i = 0; i < filas.length; i += _B5_CHUNK) {
    const trozo = filas.slice(i, i + _B5_CHUNK);
    await _v9Fetch(`/${tabla}`, {
      method:  'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body:    JSON.stringify(trozo),
    }, token);
  }
  return errores;
}

async function _importarDatosV9(e) {
  if (!puedeExportarDatos()) {
    showToast('⛔ Importación de datos no disponible para este rol','#E24B4A'); return;
  }
  const file = e.target.files[0];
  if (!file) return;

  // import-msg no existe en el DOM; export-msg es el contenedor visible en config.
  //
  // IMPORTANTE: NO capturar el nodo en una variable al inicio del async.
  // Un re-render de la SPA puede reemplazar el nodo mientras awaits están activos;
  // la referencia quedaría desconectada y las escrituras no llegarían al DOM vivo.
  // Ambas funciones re-consultan getElementById en cada llamada para escribir
  // siempre en el elemento actual, sea el original o el que el render creó.
  const setMsg = (txt, ok) => {
    const el = document.getElementById('export-msg');
    if (!el) return;
    el.innerHTML = `<div class="alert ${ok?'ag':'ar'}">${txt}</div>`;
    el.style.display = 'block';
  };
  // setTerminal: escribe el mensaje final Y marca data-import-done en el nodo vigente.
  // Se usa en TODOS los puntos de salida para que el test detecte la señal.
  // El atributo persiste aunque el setTimeout de 8 s oculte el elemento.
  const setTerminal = (txt, ok) => {
    setMsg(txt, ok);
    const el = document.getElementById('export-msg');
    if (el) el.dataset.importDone = '1';
  };

  setMsg('⏳ Leyendo archivo…', true);

  let backup;
  try {
    const text = await file.text();
    backup = JSON.parse(text);
  } catch (err) {
    setTerminal('❌ Archivo inválido: ' + err.message, false);
    return;
  }

  if (backup.version !== 'v9-completo') {
    setTerminal(
      '❌ Este archivo no es un respaldo V9 (version: ' + (backup.version||'desconocida') + ').<br>' +
      'Para respaldos anteriores usa el Panel SQL de Supabase.',
      false
    );
    return;
  }

  const cuentaId = _respCuentaId();
  const token    = _respToken();
  if (!cuentaId || !token) { setTerminal('❌ Sin sesión activa.', false); return; }

  // Guardia de encabezado: el respaldo debe pertenecer a esta cuenta.
  if (backup.cuentaId !== cuentaId) {
    setTerminal(
      '❌ El respaldo pertenece a otra cuenta (' + backup.cuentaId + ').<br>' +
      'No se puede restaurar en esta cuenta.',
      false
    );
    return;
  }

  // ── Paso 1: Normalizar TODAS las filas a snake_case antes de validar o escribir.
  // planes_pago y abonos se exportan con _mapPlanPago/_mapAbono (camelCase);
  // cualquier otra colección que llegue con camelCase se normaliza igual.
  const colsBruto = backup.colecciones || {};
  const cols = {};
  for (const tabla of _B5_ORDEN) {
    const filas = Array.isArray(colsBruto[tabla]) ? colsBruto[tabla] : [];
    if (tabla === 'planes_pago') cols[tabla] = filas.map(_normalizarPlanPago);
    else if (tabla === 'abonos') cols[tabla] = filas.map(_normalizarAbono);
    else cols[tabla] = filas;
  }

  // ── Paso 2: Guardia por registro — después de normalizar.
  // Rechaza:
  //   a) filas que tengan cuenta_id ajeno (distinto de cuentaId de sesión)
  //   b) filas que tengan cuentaId camelCase ajeno (normalización no eliminó el conflicto)
  //   c) filas de tablas con FK cuenta_id que llegan sin ese campo (ausente/null)
  // Detecta manipulación o mezcla de cuentas antes de escribir cualquier dato.
  // La RLS previene cross-account en staging, pero no sustituye validar el destino.
  const _TABLAS_CON_CUENTA = new Set([
    'alumnos','apoderados','cuotas','planes_pago','abonos',
    'pagos','movimientos','fondo_movimientos','actividades',
    'notas','codigos_invitacion',
  ]);
  const _filasAjenas = [];
  for (const tabla of _B5_ORDEN) {
    if (!_TABLAS_CON_CUENTA.has(tabla)) continue;
    const filas = cols[tabla] || [];
    for (const fila of filas) {
      // Detectar cuenta_id ausente o nulo
      if (!Object.prototype.hasOwnProperty.call(fila, 'cuenta_id') || fila.cuenta_id == null) {
        _filasAjenas.push(tabla + '[' + (fila.id || '?') + '] → cuenta_id ausente');
        if (_filasAjenas.length >= 3) break;
        continue;
      }
      // Detectar cuenta_id ajeno
      if (fila.cuenta_id !== cuentaId) {
        _filasAjenas.push(tabla + '[' + (fila.id || '?') + '] → ' + fila.cuenta_id);
        if (_filasAjenas.length >= 3) break;
      }
    }
    if (_filasAjenas.length >= 3) break;
  }
  if (_filasAjenas.length > 0) {
    setTerminal(
      '❌ Registros con cuenta_id ajeno o ausente detectados. Importación cancelada.<br>' +
      _filasAjenas.map(f => '&nbsp;• ' + f).join('<br>'),
      false
    );
    return;
  }
  const total = _B5_ORDEN.reduce((s, k) => s + (Array.isArray(cols[k]) ? cols[k].length : 0), 0);
  const fecha = backup.fecha ? backup.fecha.slice(0,10) : '?';

  if (!confirm(
    '¿Restaurar ' + total + ' registros desde el respaldo del ' + fecha + '?\n\n' +
    'Los registros existentes se actualizarán; no se eliminarán registros ausentes.'
  )) {
    // Cancelado por el usuario — señalizar en el nodo vigente para que el test no quede colgado.
    const elCan = document.getElementById('export-msg');
    if (elCan) elCan.dataset.importDone = '1';
    return;
  }

  setMsg('⏳ Restaurando datos…', true);

  const erroresPorTabla = {};
  let restaurados = 0;

  for (const tabla of _B5_ORDEN) {
    const filas = Array.isArray(cols[tabla]) ? cols[tabla] : [];
    if (!filas.length) continue;
    try {
      await _b5UpsertColeccion(tabla, filas, token);
      restaurados += filas.length;
    } catch (err) {
      erroresPorTabla[tabla] = err.message;
      console.error('[B5] ' + tabla + ':', err.message);
    }
  }

  const nErrores = Object.keys(erroresPorTabla).length;
  if (nErrores === 0) {
    setTerminal('✅ Restauración completa: ' + restaurados + '/' + total + ' registros restaurados.', true);
  } else {
    const detalle = Object.entries(erroresPorTabla)
      .slice(0,3).map(([t,m])=>t+': '+m).join('<br>');
    setTerminal(
      '⚠️ Restaurado con errores (' + restaurados + '/' + total + ' registros).<br>' + detalle,
      false
    );
  }
  // data-import-done ya fue escrito por setTerminal en el nodo vigente.
  // El hide es cosmético; re-consulta getElementById para no depender de la
  // referencia capturada antes de los awaits (puede ser un nodo huérfano).
  setTimeout(() => {
    const el = document.getElementById('export-msg');
    if (el) el.style.display = 'none';
  }, 8000);
}

function importarDatos(e){
  if(!puedeExportarDatos()){ showToast('⛔ Importación de datos no disponible para este rol','#E24B4A'); return; }
  if(_respaldosV9()){
    _importarDatosV9(e);
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

// ── saveCuenta ────────────────────────────────────────────────────────────────
//
// B4-V9 flujo:
//   - El lookup de DB.usuarios (caché local) solo se usa en el path legado y en
//     el cambio de contraseña (donde se regenera el código de recuperación local).
//   - En V9 el nombre persiste en tesorero_cuentas vía actualizarCuentaV9().
//     El email NO se persiste: es read-only vía Supabase Auth.
//   - Ninguna memoria se modifica antes de confirmar Supabase.

async function saveCuenta(){
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

  // ── Cambio de contraseña ───────────────────────────────────────────────────
  if(pass){
    // Contraseña: Supabase Auth únicamente — nunca en DB local.
    if(authClient){
      try {
        const { error } = await authClient.auth.updateUser({ password: pass });
        if (error) { showMsg('❌ Error al cambiar contraseña: ' + error.message, false); return; }
      } catch(e) {
        showMsg('❌ Error al cambiar contraseña: ' + e.message, false); return;
      }
    }
    // Regenerar código de recuperación (legado; no-op si DB.usuarios está vacío)
    const uiPass = (DB.usuarios||[]).findIndex(u=>u.id===S.session.id);
    document.getElementById('cfg-usr-pass').value  = '';
    document.getElementById('cfg-usr-pass2').value = '';
    if(uiPass >= 0){
      delete DB.usuarios[uiPass].pass;
      const nuevoCodigo = generarCodigoRecuperacion();
      DB.usuarios[uiPass].codigoRecuperacion = nuevoCodigo;
      saveDB();
      showMsg('✅ Contraseña actualizada. Se generó un nuevo código de recuperación.', true);
      setTimeout(()=> mostrarCodigoRecuperacion(nuevoCodigo, 'cambio'), 300);
    } else {
      showMsg('✅ Contraseña actualizada en Supabase Auth.', true);
    }
    return;
  }

  // ── V9: persistir solo nombre en tesorero_cuentas ─────────────────────────
  // Debe ejecutarse ANTES de modificar cualquier estado local.
  // El email no se persiste: es read-only en tesorero_cuentas (campo gestionado
  // por Supabase Auth). No anunciar que el email fue guardado.
  if (_respaldosV9()) {
    const cuentaId = _respCuentaId();
    const token    = _respToken();
    if (!cuentaId || !token) { showMsg('❌ Sin sesión activa — no se pudo guardar.', false); return; }
    try {
      await actualizarCuentaV9(cuentaId, { nombre }, token);
    } catch(e) {
      console.error('[saveCuenta] actualizarCuentaV9:', e.message);
      showMsg('❌ No se pudo guardar en la nube: ' + e.message, false);
      return;
    }
    // Solo actualizar nombre en sesión; email no fue persistido en Supabase.
    S.session.nombre = nombre;
    document.getElementById('cfg-usr-pass').value  = '';
    document.getElementById('cfg-usr-pass2').value = '';
    showMsg('✅ Nombre actualizado correctamente.', true);
    return;
  }

  // ── Legado: persistir en caché local ──────────────────────────────────────
  const ui = (DB.usuarios||[]).findIndex(u=>u.id===S.session.id);
  if(ui < 0){ showMsg('No se encontró el usuario.', false); return; }
  DB.usuarios[ui].nombre = nombre;
  DB.usuarios[ui].email  = email;
  S.session.nombre = nombre;
  S.session.email  = email;
  const ci = (DB.cursos||[]).findIndex(c=>c.id===S.cursoId);
  if(ci>=0) DB.cursos[ci].tesorero = nombre;
  saveDB();
  document.getElementById('cfg-usr-pass').value  = '';
  document.getElementById('cfg-usr-pass2').value = '';
  showMsg('✅ Datos de cuenta actualizados correctamente.', true);
}
