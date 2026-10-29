// js/core/datos_v9.js — Capa de datos relacional para El Gran Cambio v9
// ⚠️  SOLO SE ACTIVA cuando V9_RELACIONAL === true en config.js
// ⚠️  NO toca tesorero_datos ni el blob legado.
// ⚠️  Nunca importar SUPA_URL/SUPA_KEY de producción directamente;
//     se leen de window para que la rama staging pueda sobreescribirlos.
// Producción protegida: https://www.eltesorero.cl / https://tmjqzaakzhecbldebyeg.supabase.co

'use strict';

// ─── helpers internos ────────────────────────────────────────────────────────

/**
 * Devuelve la URL base de Supabase REST tal como está configurada en config.js.
 * Si no existe lanza un error claro para no silenciar configuraciones rotas.
 */
function _v9BaseUrl() {
  if (typeof SUPA_URL === 'undefined' || !SUPA_URL) {
    throw new Error('[datos_v9] SUPA_URL no está definida. Revisa config.js.');
  }
  return SUPA_URL.replace(/\/$/, '') + '/rest/v1';
}

/**
 * Fetch autenticado contra la API REST de Supabase.
 * Usa el accessToken del usuario autenticado (Bearer).
 * El anon key sólo se usa como fallback (lectura pública con RLS restringida).
 */
async function _v9Fetch(path, opts = {}, accessToken) {
  // Capturar epoch de sesión antes del await; si cambia durante el fetch,
  // la sesión fue cerrada y la respuesta debe descartarse.
  const _snapSession = (typeof _v9SessionId !== 'undefined') ? _v9SessionId : 0;

  const base = _v9BaseUrl();
  const token = accessToken || (typeof _authToken !== 'undefined' && _authToken) || SUPA_KEY;
  const url = base + path;

  const headers = {
    'apikey': SUPA_KEY,
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...(opts.headers || {}),
  };

  const res = await fetch(url, { ...opts, headers });

  // Guard 1 — sesión cambiada mientras esperábamos la respuesta HTTP.
  if (typeof _v9SessionId !== 'undefined' && _snapSession !== _v9SessionId) {
    const stale = new Error('[datos_v9] Sesión cambiada durante el fetch — respuesta descartada (post-HTTP).');
    stale._staleSession = true;
    throw stale;
  }

  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch (_) {}
    throw Object.assign(
      new Error(`[datos_v9] ${opts.method || 'GET'} ${path} → HTTP ${res.status}: ${body}`),
      { status: res.status, body }
    );
  }

  // DELETE y respuestas vacías
  if (res.status === 204 || res.headers.get('content-length') === '0') return null;

  const json = await res.json();

  // Guard 2 — sesión cambiada mientras el motor deserializaba el JSON.
  // Este segundo chequeo cubre el caso en que logout() se llama entre
  // la llegada de los headers HTTP y el fin del parseo del cuerpo.
  if (typeof _v9SessionId !== 'undefined' && _snapSession !== _v9SessionId) {
    const stale = new Error('[datos_v9] Sesión cambiada durante la lectura del cuerpo — datos descartados (post-JSON).');
    stale._staleSession = true;
    throw stale;
  }

  return json;
}

// ─── API pública ─────────────────────────────────────────────────────────────

/**
 * Carga la cuenta del usuario autenticado desde tesorero_cuentas.
 * Devuelve el primer registro o null.
 */
async function cargarCuenta(authId, accessToken) {
  const rows = await _v9Fetch(
    `/tesorero_cuentas?auth_id=eq.${encodeURIComponent(authId)}&select=*&limit=1`,
    {}, accessToken
  );
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/**
 * Carga los cursos activos de una cuenta.
 */
async function cargarCursos(cuentaId, accessToken) {
  const rows = await _v9Fetch(
    `/cursos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&activo=eq.true&select=*&order=nombre.asc`,
    {}, accessToken
  );
  return Array.isArray(rows) ? rows : [];
}

/**
 * Carga todos los alumnos de una cuenta, opcionalmente filtrado por curso.
 */
async function cargarAlumnos(cuentaId, cursoId, accessToken) {
  let path = `/alumnos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&select=*&order=apellidos.asc,nombres.asc`;
  if (cursoId) path += `&curso_id=eq.${encodeURIComponent(cursoId)}`;
  const rows = await _v9Fetch(path, {}, accessToken);
  return Array.isArray(rows) ? rows : [];
}

/**
 * Carga las cuotas de un curso específico.
 */
async function cargarCuotas(cuentaId, cursoId, accessToken) {
  const rows = await _v9Fetch(
    `/cuotas?cuenta_id=eq.${encodeURIComponent(cuentaId)}&curso_id=eq.${encodeURIComponent(cursoId)}&select=*&order=nombre.asc`,
    {}, accessToken
  );
  return Array.isArray(rows) ? rows : [];
}

/**
 * Carga todos los pagos de una cuenta.
 */
async function cargarPagos(cuentaId, accessToken) {
  const rows = await _v9Fetch(
    `/pagos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&select=*&order=fecha.desc`,
    {}, accessToken
  );
  return Array.isArray(rows) ? rows : [];
}

/**
 * Registra un pago en public.pagos y devuelve el registro insertado.
 * El campo `id` se genera aquí como UUID si no viene incluido.
 *
 * @param {Object} pago — { alumno_id, cuota_id, monto, fecha, medio, estado, periodo, obs, creado_por }
 * @param {string} cuentaId
 * @param {string} accessToken
 * @returns {Object} registro insertado (con id definitivo)
 */
async function registrarPagoV9(pago, cuentaId, accessToken) {
  // Generar id determinista si no viene: p-{timestamp}-{random}
  const id = pago.id || `p-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const payload = {
    cuenta_id:  cuentaId,
    id,
    alumno_id:  pago.alumno_id,
    cuota_id:   pago.cuota_id,
    monto:      Number(pago.monto) || 0,
    fecha:      pago.fecha || new Date().toISOString().slice(0, 10),
    medio:      pago.medio || 'efectivo',
    estado:     pago.estado || 'pagado',
    periodo:    pago.periodo || null,
    obs:        pago.obs || null,
    creado_por: pago.creado_por || null,
  };

  const rows = await _v9Fetch(
    '/pagos?select=*',
    {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify(payload),
    },
    accessToken
  );

  return Array.isArray(rows) && rows.length > 0 ? rows[0] : { ...payload };
}

/**
 * Elimina un pago por su id (PK compuesta: cuenta_id + id).
 * No lanza error si ya no existe (idempotente).
 */
async function eliminarPagoV9(cuentaId, pagoId, accessToken) {
  await _v9Fetch(
    `/pagos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${encodeURIComponent(pagoId)}`,
    { method: 'DELETE' },
    accessToken
  );
}

/**
 * Verifica que un pago existe en la tabla.
 * Devuelve el registro o null.
 */
async function buscarPagoV9(cuentaId, pagoId, accessToken) {
  const rows = await _v9Fetch(
    `/pagos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${encodeURIComponent(pagoId)}&select=*&limit=1`,
    {}, accessToken
  );
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

// ─── Adaptadores: mapear filas relacionales al formato esperado por DB ────────
// El estado en memoria (DB) sigue siendo el mismo objeto legado para que el
// resto de la UI (render, navegación, reportes) no necesite cambios todavía.

/**
 * Convierte una fila de `cursos` al shape que espera DB.cursos.
 */
function _mapCurso(row) {
  return {
    id:               row.id,
    nombre:           row.nombre,
    anio:             row.anio,
    colegioId:        row.colegio_id,
    activo:           row.activo,
    cuotaMensual:     row.cuota_mensual,
    cuotaAnual:       row.cuota_anual,
    mesInicioCuota:   row.mes_inicio_cuota,
    mesTerminoCuota:  row.mes_termino_cuota,
    // cursor relacional — no presente en blob legado, ignorado por render actual
    _v9: true,
  };
}

/**
 * Convierte una fila de `alumnos` al shape que espera DB.alumnos.
 */
function _mapAlumno(row) {
  return {
    id:         row.id,
    cursoId:    row.curso_id,
    nombre:     row.nombre || `${row.nombres || ''} ${row.apellidos || ''}`.trim(),
    nombres:    row.nombres,
    apellidos:  row.apellidos,
    estado:     row.estado,
    eximido:    row.eximido,
    _v9: true,
  };
}

/**
 * Convierte una fila de `cuotas` al shape que espera DB.cuotas.
 */
function _mapCuota(row) {
  return {
    id:          row.id,
    cursoId:     row.curso_id,
    nombre:      row.nombre,
    monto:       row.monto,
    tipo:        row.tipo,
    anio:        row.anio,
    activa:      row.activa,
    mesInicio:   row.mes_inicio,
    mesTermino:  row.mes_termino,
    _v9: true,
  };
}

/**
 * Convierte una fila de `pagos` al shape que espera DB.pagos.
 */
function _mapPago(row) {
  return {
    id:          row.id,
    // Ambos campos: la UI legacy usa alumnoId, datos_v9 usa aluId.
    alumnoId:    row.alumno_id,
    aluId:       row.alumno_id,
    cuotaId:     row.cuota_id,
    monto:       row.monto,
    fecha:       row.fecha,
    medio:       row.medio,
    estado:      row.estado,
    periodo:     row.periodo,
    obs:         row.obs,
    creadoPor:   row.creado_por,
    _v9: true,
    _cuentaId:   row.cuenta_id,
  };
}

/**
 * Carga las membresías de un usuario en usuarios_cuenta.
 * Un usuario invitado tiene filas aquí pero NO es propietario en tesorero_cuentas.
 * Devuelve array de membresías no desactivadas, o lanza error con detalle del esquema.
 *
 * Columnas reales en usuarios_cuenta (esquema de producción):
 *   id, cuenta_id, auth_id, rol, curso_id (nullable), desactivado
 *
 * ⚠️  Esta función NO silencia errores de esquema (columna incorrecta, RLS bloqueante,
 *     tabla inexistente). Los errores de configuración deben ser visibles en los logs
 *     y deben propagarse al llamador para que el login muestre un mensaje claro.
 */
async function cargarMembresiasUsuario(authId, accessToken) {
  // Columna real: auth_id (no user_auth_id); filtro: desactivado=false (no activo=true)
  const rows = await _v9Fetch(
    `/usuarios_cuenta?auth_id=eq.${encodeURIComponent(authId)}&desactivado=eq.false&select=*`,
    {}, accessToken
  );
  if (!Array.isArray(rows)) {
    throw new Error('[datos_v9] cargarMembresiasUsuario: respuesta inesperada (no es array). Verifica el esquema de usuarios_cuenta.');
  }
  return rows;
}

/**
 * Carga todos los datos necesarios para una sesión relacional y los vuelca en DB.
 * Soporta dos roles:
 *   - Propietario: aparece en tesorero_cuentas con auth_id = authId.
 *   - Delegado:    aparece en usuarios_cuenta con user_auth_id = authId;
 *                  puede tener restricción por curso (campo curso_id).
 *
 * @param {string} authId        — auth.uid() del usuario
 * @param {string} accessToken   — JWT del usuario
 * @param {string} [cursoId]     — curso activo inicial (opcional)
 * @returns {{ cuenta, cuentaId, cursoIds, esDelegado, rolEfectivo }}
 */
async function cargarSesionV9(authId, accessToken, cursoId) {
  // 1. ¿Propietario de una cuenta?
  let cuenta = await cargarCuenta(authId, accessToken);
  let cuentaId;
  let esDelegado = false;
  let rolEfectivo = 'tesorero';
  let cursosFiltro = null; // null = sin restricción; array = lista blanca de cursos permitidos

  if (cuenta) {
    cuentaId = cuenta.id;
  } else {
    // 1b. No es propietario — buscar membresías en usuarios_cuenta
    const membresias = await cargarMembresiasUsuario(authId, accessToken);
    if (!membresias || membresias.length === 0) {
      throw new Error(
        '[datos_v9] Usuario sin cuenta relacional ni membresías activas. ' +
        'Ejecuta el seed de staging e inserta al usuario en usuarios_cuenta.'
      );
    }

    // Elegir la primera membresía activa (si hubiera varias, el selector de cuenta
    // se implementaría aquí; lo dejamos como pendiente explícito).
    const membresia = membresias[0];
    cuentaId = membresia.cuenta_id;
    esDelegado = true;
    // Rol real del esquema: 'visor' | 'editor' | 'tesorero' (no 'lector')
    rolEfectivo = membresia.rol || 'visor';

    // La RLS de tesorero_cuentas debe permitir SELECT al delegado para leer el nombre/email.
    // Si no lo permite, usamos un placeholder y continuamos.
    try {
      const cuentasRows = await _v9Fetch(
        `/tesorero_cuentas?id=eq.${encodeURIComponent(cuentaId)}&select=id,nombre,email&limit=1`,
        {}, accessToken
      );
      cuenta = Array.isArray(cuentasRows) && cuentasRows.length > 0 ? cuentasRows[0] : null;
    } catch (e) {
      if (e._staleSession) throw e;
      console.warn('[datos_v9] No se pudo leer tesorero_cuentas del propietario (RLS?):', e.message);
    }
    if (!cuenta) cuenta = { id: cuentaId, nombre: 'Cuenta delegada', email: '' };

    // Restricción de cursos: si la membresía tiene curso_id, sólo ese curso.
    if (membresia.curso_id) {
      cursosFiltro = membresias
        .filter(m => m.cuenta_id === cuentaId && m.curso_id)
        .map(m => m.curso_id);
      if (cursosFiltro.length === 0) cursosFiltro = null;
    }
  }

  // 2. Cursos activos (RLS ya filtra por cuenta_id vía JWT)
  const cursosRaw = await cargarCursos(cuentaId, accessToken);
  const cursosFiltrados = cursosFiltro
    ? cursosRaw.filter(c => cursosFiltro.includes(c.id))
    : cursosRaw;
  DB.cursos = cursosFiltrados.map(_mapCurso);

  const primerCursoId = cursoId || (cursosFiltrados[0] && cursosFiltrados[0].id) || null;

  // 3. Alumnos del primer curso (se recargan al cambiar de curso en selectCurso)
  if (primerCursoId) {
    const alumnosRaw = await cargarAlumnos(cuentaId, primerCursoId, accessToken);
    DB.alumnos = alumnosRaw.map(_mapAlumno);

    const cuotasRaw = await cargarCuotas(cuentaId, primerCursoId, accessToken);
    DB.cuotas = cuotasRaw.map(_mapCuota);
  } else {
    DB.alumnos = [];
    DB.cuotas  = [];
  }

  // 4. Pagos de la cuenta (todos los cursos)
  const pagosRaw = await cargarPagos(cuentaId, accessToken);
  DB.pagos = pagosRaw.map(_mapPago);

  // 5. Limpiar colecciones no relacionales para evitar datos fantasma
  DB.movimientos = DB.movimientos || [];
  DB.notas       = DB.notas       || [];
  DB.colegios    = DB.colegios    || [];

  // Guardar cuentaId en S para que lo usen las funciones de guardado
  if (typeof S !== 'undefined') {
    S._v9CuentaId = cuentaId;
  }

  return {
    cuenta,
    cuentaId,
    cursoIds:    cursosFiltrados.map(c => c.id),
    esDelegado,
    rolEfectivo,
  };
}

/**
 * Recarga los alumnos, cuotas y pagos para un curso dado.
 * IMPORTANTE: esta función NO modifica DB directamente.
 * Devuelve los datos mapeados para que el llamador (selectCurso en rutas.js)
 * pueda comprobar el epoch vigente antes de aplicarlos atómicamente.
 *
 * @param {string} cursoId
 * @param {string} accessToken
 * @returns {Promise<{ alumnos: object[], cuotas: object[], pagos: object[] }>}
 */
async function recargarCursoV9(cursoId, accessToken) {
  const cuentaId = (typeof S !== 'undefined' && S._v9CuentaId);
  if (!cuentaId) throw new Error('[v9] recargarCursoV9: S._v9CuentaId no disponible');

  const [alumnosRaw, cuotasRaw, pagosRaw] = await Promise.all([
    cargarAlumnos(cuentaId, cursoId, accessToken),
    cargarCuotas(cuentaId, cursoId, accessToken),
    cargarPagos(cuentaId, accessToken),
  ]);

  // Devolver los datos mapeados sin escribir en DB.
  // El llamador es responsable de verificar el epoch y aplicar los datos.
  return {
    alumnos: alumnosRaw.map(_mapAlumno),
    cuotas:  cuotasRaw.map(_mapCuota),
    pagos:   pagosRaw.map(_mapPago),
  };
}
