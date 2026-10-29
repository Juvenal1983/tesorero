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

  return res.json();
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
 * Carga todos los datos necesarios para una sesión relacional y los vuelca en DB.
 * Se llama desde acceso.js en lugar de loadFromCloud() cuando V9_RELACIONAL === true.
 *
 * @param {string} authId  — auth.uid() del usuario (S.session.authId)
 * @param {string} accessToken — JWT del usuario
 * @param {string} [cursoId]  — curso activo inicial (opcional, para pre-cargar)
 * @returns {{ cuenta, cursoIds }} para que _finalizarLogin pueda construir S.session
 */
async function cargarSesionV9(authId, accessToken, cursoId) {
  // 1. Cuenta
  const cuenta = await cargarCuenta(authId, accessToken);
  if (!cuenta) throw new Error('[datos_v9] Usuario sin cuenta relacional. Ejecuta el seed de staging.');

  const cuentaId = cuenta.id;

  // 2. Cursos activos
  const cursosRaw = await cargarCursos(cuentaId, accessToken);
  DB.cursos = cursosRaw.map(_mapCurso);

  const primerCursoId = cursoId || (cursosRaw[0] && cursosRaw[0].id) || null;

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
    cursoIds: cursosRaw.map(c => c.id),
  };
}

/**
 * Recarga los alumnos, cuotas y pagos cuando el usuario cambia de curso.
 * Se llama desde selectCurso() cuando V9_RELACIONAL === true.
 */
async function recargarCursoV9(cursoId, accessToken) {
  const cuentaId = (typeof S !== 'undefined' && S._v9CuentaId);
  if (!cuentaId) return;

  const [alumnosRaw, cuotasRaw, pagosRaw] = await Promise.all([
    cargarAlumnos(cuentaId, cursoId, accessToken),
    cargarCuotas(cuentaId, cursoId, accessToken),
    cargarPagos(cuentaId, accessToken),
  ]);

  DB.alumnos = alumnosRaw.map(_mapAlumno);
  DB.cuotas  = cuotasRaw.map(_mapCuota);
  DB.pagos   = pagosRaw.map(_mapPago);
}
