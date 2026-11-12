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

  // Validación de monto: debe ser un número finito y positivo (CLP entero)
  const montoNum = Number(pago.monto);
  if (!Number.isFinite(montoNum) || montoNum <= 0) {
    throw new Error(
      `[datos_v9] registrarPagoV9: monto inválido (${JSON.stringify(pago.monto)}). ` +
      'Debe ser un número entero positivo en CLP.'
    );
  }
  const monto = Math.round(montoNum); // CLP no tiene decimales

  const payload = {
    cuenta_id:       cuentaId,
    id,
    alumno_id:       pago.alumno_id,
    cuota_id:        pago.cuota_id,
    monto,
    fecha:           pago.fecha || new Date().toISOString().slice(0, 10),
    medio:           pago.medio || 'efectivo',
    estado:          pago.estado || 'pagado',
    periodo:         pago.periodo || null,
    obs:             pago.obs || null,
    creado_por:      pago.creado_por || null,
    // B2-fix: idempotency_key permite que reintentos de red no dupliquen filas.
    // La clave viene del caller (UUID único por operación de submit).
    idempotency_key: pago.idempotency_key || null,
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

  // C07: exigir confirmación real de la DB; retorno vacío = error, no éxito silencioso
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(
      `[datos_v9] registrarPagoV9: el INSERT no devolvió ninguna fila. ` +
      'El pago puede no haberse guardado. Verifica permisos RLS y constraints.'
    );
  }
  return rows[0];
}

/**
 * B3: Inserta múltiples pagos en una sola transacción PostgreSQL (todo-o-nada).
 * Llama al RPC insertar_pagos_lote definido en sql/11_insertar_pagos_lote.sql.
 *
 * Garantías:
 *  - Atomicidad real en PostgreSQL: si falla cualquier inserción, ninguna queda.
 *  - Idempotencia: si llega el mismo idempotency_key de un reintento, el RPC
 *    devuelve la fila existente sin duplicar ni lanzar error.
 *
 * @param {string} cuentaId
 * @param {Array<Object>} pagos — array de objetos pago con idempotency_key por elemento
 * @param {string} accessToken
 * @returns {Array<Object>} filas insertadas o ya existentes
 */
async function insertarPagosLote(cuentaId, pagos, accessToken) {
  if (!Array.isArray(pagos) || pagos.length === 0) return [];

  const result = await _v9Fetch(
    '/rpc/insertar_pagos_lote',
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ p_cuenta_id: cuentaId, p_pagos: pagos }),
    },
    accessToken
  );

  if (!Array.isArray(result)) {
    throw new Error(
      '[datos_v9] insertarPagosLote: el RPC no devolvió un array. ' +
      'Verifica que insertar_pagos_lote esté desplegado en el proyecto de staging.'
    );
  }
  return result;
}

/**
 * Elimina un pago por su id (PK compuesta: cuenta_id + id).
 * No lanza error si ya no existe (idempotente).
 */
async function eliminarPagoV9(cuentaId, pagoId, accessToken) {
  // B6-fix: Prefer: return=representation para detectar filas afectadas.
  // PostgREST no distingue "no existe" de "RLS lo bloqueó"; si devuelve array
  // vacío emitimos advertencia de consola. No lanzamos error para mantener
  // la UX actual (el caller mostrará su propio mensaje si lo necesita).
  const rows = await _v9Fetch(
    `/pagos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${encodeURIComponent(pagoId)}&select=*`,
    {
      method:  'DELETE',
      headers: { 'Prefer': 'return=representation' },
    },
    accessToken
  );
  if (!Array.isArray(rows) || rows.length === 0) {
    console.warn(
      `[datos_v9] eliminarPagoV9: DELETE de pago ${pagoId} no afectó ninguna fila. ` +
      'El pago puede no existir o RLS pudo haberlo bloqueado.'
    );
  }
  return rows;
}

/**
 * Actualiza monto, fecha, medio y obs de un pago existente.
 * Usa PATCH con Prefer: return=representation.
 * @param {string} cuentaId
 * @param {string} pagoId
 * @param {{ monto: number, fecha: string, medio: string, obs: string }} cambios
 * @param {string} accessToken
 * @returns {Object} registro actualizado
 */
async function actualizarPagoV9(cuentaId, pagoId, cambios, accessToken) {
  const patch = {};
  if (cambios.monto !== undefined) {
    // C05: validación explícita — no silenciar importes inválidos
    const montoNum = Number(cambios.monto);
    if (!Number.isFinite(montoNum) || montoNum <= 0) {
      throw new Error(
        `[datos_v9] actualizarPagoV9: monto inválido (${JSON.stringify(cambios.monto)}). ` +
        'Debe ser un número entero positivo en CLP.'
      );
    }
    patch.monto = Math.round(montoNum);
  }
  if (cambios.fecha  !== undefined) patch.fecha  = cambios.fecha;
  if (cambios.medio  !== undefined) patch.medio  = cambios.medio;
  if (cambios.obs    !== undefined) patch.obs    = cambios.obs || null;

  const rows = await _v9Fetch(
    `/pagos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${encodeURIComponent(pagoId)}&select=*`,
    {
      method:  'PATCH',
      headers: { 'Prefer': 'return=representation' },
      body:    JSON.stringify(patch),
    },
    accessToken
  );
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`Pago ${pagoId} no encontrado en la base de datos (ninguna fila modificada)`);
  }
  return rows[0];
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

// ─── CRUD cuotas ─────────────────────────────────────────────────────────────

/**
 * Crea una cuota en Supabase y devuelve la fila insertada.
 */
async function crearCuotaV9(cuentaId, cursoId, data, accessToken) {
  const id = data.id || uid();
  const payload = {
    cuenta_id:   cuentaId,
    id,
    curso_id:    cursoId,
    nombre:      data.nombre,
    monto:       Math.round(Number(data.monto)),
    tipo:        data.tipo   || 'unica',
    anio:        data.anio   || new Date().getFullYear(),
    activa:      data.activa !== false,
    mes_inicio:  data.mesInicio  != null ? data.mesInicio  : null,
    mes_termino: data.mesTermino != null ? data.mesTermino : null,
    obs:         data.obs || null,
  };
  const rows = await _v9Fetch(
    '/cuotas?select=*',
    { method: 'POST', headers: { 'Prefer': 'return=representation' }, body: JSON.stringify(payload) },
    accessToken
  );
  if (!Array.isArray(rows) || rows.length === 0)
    throw new Error('[datos_v9] crearCuotaV9: INSERT sin respuesta — verifica RLS y permisos.');
  return rows[0];
}

/**
 * Actualiza campos de una cuota existente. Devuelve la fila actualizada.
 */
async function actualizarCuotaV9(cuentaId, cuotaId, data, accessToken) {
  const patch = {};
  if (data.nombre     !== undefined) patch.nombre      = data.nombre;
  if (data.monto      !== undefined) patch.monto       = Math.round(Number(data.monto));
  if (data.tipo       !== undefined) patch.tipo        = data.tipo;
  if (data.anio       !== undefined) patch.anio        = data.anio;
  if (data.activa     !== undefined) patch.activa      = data.activa;
  if (data.mesInicio  !== undefined) patch.mes_inicio  = data.mesInicio  != null ? data.mesInicio  : null;
  if (data.mesTermino !== undefined) patch.mes_termino = data.mesTermino != null ? data.mesTermino : null;
  if (data.obs        !== undefined) patch.obs         = data.obs || null;
  const rows = await _v9Fetch(
    `/cuotas?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${encodeURIComponent(cuotaId)}&select=*`,
    { method: 'PATCH', headers: { 'Prefer': 'return=representation' }, body: JSON.stringify(patch) },
    accessToken
  );
  if (!Array.isArray(rows) || rows.length === 0)
    throw new Error(`[datos_v9] actualizarCuotaV9: cuota ${cuotaId} no encontrada (ninguna fila modificada).`);
  return rows[0];
}

/**
 * Elimina una cuota. Lanza error si no se encontró (0 filas afectadas).
 * El caller debe haber verificado que no hay pagos asociados antes de llamar.
 */
async function eliminarCuotaV9(cuentaId, cuotaId, accessToken) {
  const rows = await _v9Fetch(
    `/cuotas?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${encodeURIComponent(cuotaId)}&select=*`,
    { method: 'DELETE', headers: { 'Prefer': 'return=representation' } },
    accessToken
  );
  if (!Array.isArray(rows) || rows.length === 0)
    throw new Error(`[datos_v9] eliminarCuotaV9: cuota ${cuotaId} no encontrada o sin permiso.`);
  return rows;
}

// ─── CRUD alumnos ─────────────────────────────────────────────────────────────

/**
 * Crea un alumno en Supabase y devuelve la fila insertada.
 * Nota: el PIN se guarda solo en el blob local (alumnos_credenciales requiere service_role).
 */
async function crearAlumnoV9(cuentaId, cursoId, data, accessToken) {
  const id = data.id || uid();
  const nombre = `${data.nombres || ''} ${data.apellidos || ''}`.trim();
  const payload = {
    cuenta_id: cuentaId,
    id,
    curso_id:  cursoId,
    nombre,
    nombres:   data.nombres   || null,
    apellidos: data.apellidos || null,
    estado:    data.estado    || 'activo',
    obs:       data.obs       || null,
    eximido:   data.eximido   || false,
  };
  const rows = await _v9Fetch(
    '/alumnos?select=*',
    { method: 'POST', headers: { 'Prefer': 'return=representation' }, body: JSON.stringify(payload) },
    accessToken
  );
  if (!Array.isArray(rows) || rows.length === 0)
    throw new Error('[datos_v9] crearAlumnoV9: INSERT sin respuesta — verifica RLS y permisos.');
  return { ...rows[0], id };
}

/**
 * Actualiza campos de un alumno existente. Devuelve la fila actualizada.
 */
async function actualizarAlumnoV9(cuentaId, alumnoId, data, accessToken) {
  const patch = {};
  if (data.nombres   !== undefined || data.apellidos !== undefined) {
    patch.nombres   = data.nombres   || null;
    patch.apellidos = data.apellidos || null;
    patch.nombre    = `${data.nombres || ''} ${data.apellidos || ''}`.trim();
  }
  if (data.estado  !== undefined) patch.estado  = data.estado;
  if (data.obs     !== undefined) patch.obs     = data.obs || null;
  if (data.eximido !== undefined) patch.eximido = data.eximido;
  const rows = await _v9Fetch(
    `/alumnos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${encodeURIComponent(alumnoId)}&select=*`,
    { method: 'PATCH', headers: { 'Prefer': 'return=representation' }, body: JSON.stringify(patch) },
    accessToken
  );
  if (!Array.isArray(rows) || rows.length === 0)
    throw new Error(`[datos_v9] actualizarAlumnoV9: alumno ${alumnoId} no encontrado.`);
  return rows[0];
}

/**
 * Elimina un alumno. Lanza error si no se encontró (0 filas afectadas).
 * El caller debe haber verificado que no hay pagos asociados antes de llamar.
 */
async function eliminarAlumnoV9(cuentaId, alumnoId, accessToken) {
  const rows = await _v9Fetch(
    `/alumnos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${encodeURIComponent(alumnoId)}&select=*`,
    { method: 'DELETE', headers: { 'Prefer': 'return=representation' } },
    accessToken
  );
  if (!Array.isArray(rows) || rows.length === 0)
    throw new Error(`[datos_v9] eliminarAlumnoV9: alumno ${alumnoId} no encontrado o sin permiso.`);
  return rows;
}

// ─── CRUD apoderados ──────────────────────────────────────────────────────────

/**
 * Crea un apoderado vinculado a un alumno. Devuelve la fila insertada.
 */
async function crearApoderadoV9(cuentaId, alumnoId, data, accessToken) {
  const id = data.id || uid();
  const payload = {
    cuenta_id: cuentaId,
    id,
    alumno_id: alumnoId,
    nombre:    data.nombre,
    relacion:  data.relacion || null,
    telefono:  data.telefono || null,
    email:     data.email    || null,
    estado:    'activo',
  };
  const rows = await _v9Fetch(
    '/apoderados?select=*',
    { method: 'POST', headers: { 'Prefer': 'return=representation' }, body: JSON.stringify(payload) },
    accessToken
  );
  if (!Array.isArray(rows) || rows.length === 0)
    throw new Error('[datos_v9] crearApoderadoV9: INSERT sin respuesta — verifica RLS y permisos.');
  return { ...rows[0], id };
}

/**
 * Actualiza campos de un apoderado existente.
 */
async function actualizarApoderadoV9(cuentaId, apId, data, accessToken) {
  const patch = {};
  if (data.nombre   !== undefined) patch.nombre   = data.nombre;
  if (data.relacion !== undefined) patch.relacion = data.relacion || null;
  if (data.telefono !== undefined) patch.telefono = data.telefono || null;
  if (data.email    !== undefined) patch.email    = data.email    || null;
  const rows = await _v9Fetch(
    `/apoderados?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${encodeURIComponent(apId)}&select=*`,
    { method: 'PATCH', headers: { 'Prefer': 'return=representation' }, body: JSON.stringify(patch) },
    accessToken
  );
  if (!Array.isArray(rows) || rows.length === 0)
    throw new Error(`[datos_v9] actualizarApoderadoV9: apoderado ${apId} no encontrado.`);
  return rows[0];
}

/**
 * Elimina un apoderado. Lanza error si no se encontró (0 filas afectadas).
 */
async function eliminarApoderadoV9(cuentaId, apId, accessToken) {
  const rows = await _v9Fetch(
    `/apoderados?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${encodeURIComponent(apId)}&select=*`,
    { method: 'DELETE', headers: { 'Prefer': 'return=representation' } },
    accessToken
  );
  if (!Array.isArray(rows) || rows.length === 0)
    throw new Error(`[datos_v9] eliminarApoderadoV9: apoderado ${apId} no encontrado o sin permiso.`);
  return rows;
}

// ─── Recarga selectiva de alumnos/apoderados ─────────────────────────────────

/**
 * Carga todos los apoderados de un alumno específico.
 * Usar tras crear/editar/eliminar un apoderado para mantener DB.apoderados
 * sincronizado con Supabase.
 */
async function cargarApoderadosV9(cuentaId, alumnoId, accessToken) {
  const rows = await _v9Fetch(
    `/apoderados?cuenta_id=eq.${encodeURIComponent(cuentaId)}&alumno_id=eq.${encodeURIComponent(alumnoId)}&select=*&order=nombre.asc`,
    { method: 'GET' },
    accessToken
  );
  return Array.isArray(rows) ? rows : [];
}

/**
 * Carga TODOS los apoderados de una cuenta (todos los alumnos).
 * Usar en cargarSesionV9 y recargarCursoV9 para poblar DB.apoderados en un
 * solo request. Los apoderados son de cuenta, no de curso.
 */
async function cargarTodosApoderadosV9(cuentaId, accessToken) {
  const rows = await _v9Fetch(
    `/apoderados?cuenta_id=eq.${encodeURIComponent(cuentaId)}&select=*&order=nombre.asc`,
    { method: 'GET' },
    accessToken
  );
  return Array.isArray(rows) ? rows : [];
}

/**
 * Carga los movimientos de un curso.
 * Usar en cargarSesionV9 y recargarCursoV9 para poblar DB.movimientos.
 */
async function cargarMovimientosV9(cuentaId, cursoId, accessToken) {
  const rows = await _v9Fetch(
    `/movimientos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&curso_id=eq.${encodeURIComponent(cursoId)}&select=*&order=fecha.desc`,
    { method: 'GET' },
    accessToken
  );
  return Array.isArray(rows) ? rows : [];
}

/**
 * Llama al RPC tesorero_set_pin para guardar el PIN hasheado en el servidor.
 * Valida en cliente antes de enviar; el servidor revalida de forma independiente.
 *
 * @param {string} cuentaId    — UUID de la cuenta
 * @param {string} alumnoId    — ID del alumno
 * @param {string} pin         — PIN en texto plano (mínimo 4 caracteres, no vacío)
 * @param {string} accessToken — JWT del tesorero autenticado
 * @returns {Promise<{ok: boolean}>}
 * @throws {Error} si el PIN es inválido o el servidor rechaza
 */
async function guardarPinV9(cuentaId, alumnoId, pin, accessToken) {
  // Validación cliente (el servidor revalida independientemente)
  if (pin == null || typeof pin !== 'string') throw new Error('PIN inválido: debe ser texto.');
  const pinTrimmed = pin.trim();
  if (pinTrimmed.length === 0) throw new Error('PIN vacío: ingresa un PIN antes de guardar.');
  if (pinTrimmed.length < 4)   throw new Error(`PIN demasiado corto: mínimo 4 caracteres (recibido: ${pinTrimmed.length}).`);

  const base = _v9BaseUrl();
  const url  = base + '/rpc/tesorero_set_pin';
  const res  = await fetch(url, {
    method:  'POST',
    headers: {
      'apikey':        SUPA_KEY,
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    body: JSON.stringify({
      p_cuenta_id: cuentaId,
      p_alumno_id: alumnoId,
      p_pin:       pinTrimmed,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => String(res.status));
    throw new Error(`[datos_v9] guardarPinV9: HTTP ${res.status} — ${txt}`);
  }
  const result = await res.json();
  if (!result || result.ok === false) {
    const msg = result?.detalle || result?.error || 'error desconocido';
    throw new Error(`[datos_v9] guardarPinV9: ${msg}`);
  }
  return result;
}

// ─── CRUD movimientos (E6) ────────────────────────────────────────────────────

/**
 * Crea un movimiento (ingreso o gasto) en Supabase.
 * @param {string} cuentaId
 * @param {string} cursoId
 * @param {Object} data — { tipo, desc, monto, categoria, fecha, responsable, visible, obs }
 * @param {string} accessToken
 */
async function crearMovimientoV9(cuentaId, cursoId, data, accessToken) {
  const id = data.id || uid();
  const payload = {
    cuenta_id:   cuentaId,
    id,
    curso_id:    cursoId,
    tipo:        data.tipo        || 'gasto',
    desc:        data.desc        || data.descripcion || null,
    monto:       Math.round(Number(data.monto)) || 0,
    categoria:   data.categoria   || null,
    fecha:       data.fecha       || new Date().toISOString().slice(0, 10),
    responsable: data.responsable || null,
    visible:     data.visible     !== false,
    obs:         data.obs         || null,
    creado_por:  data.creadoPor   || null,
    archivos:    data.archivos    || null,
    comprobante: data.comprobante || null,
  };
  const rows = await _v9Fetch(
    '/movimientos?select=*',
    { method: 'POST', headers: { 'Prefer': 'return=representation' }, body: JSON.stringify(payload) },
    accessToken
  );
  if (!Array.isArray(rows) || rows.length === 0)
    throw new Error('[datos_v9] crearMovimientoV9: INSERT sin respuesta — verifica RLS y permisos.');
  return { ...rows[0], id };
}

/**
 * Actualiza campos de un movimiento existente.
 */
async function actualizarMovimientoV9(cuentaId, movId, data, accessToken) {
  const patch = {};
  if (data.tipo        !== undefined) patch.tipo        = data.tipo;
  if (data.desc        !== undefined) patch.desc        = data.desc        || null;
  if (data.descripcion !== undefined) patch.desc        = data.descripcion || null;
  if (data.monto       !== undefined) patch.monto       = Math.round(Number(data.monto));
  if (data.categoria   !== undefined) patch.categoria   = data.categoria   || null;
  if (data.fecha       !== undefined) patch.fecha       = data.fecha;
  if (data.responsable !== undefined) patch.responsable = data.responsable || null;
  if (data.visible     !== undefined) patch.visible     = data.visible;
  if (data.obs         !== undefined) patch.obs         = data.obs         || null;
  // Campos de comprobante — aceptados explícitamente; nunca guardar base64 como valor permanente
  if (data.archivos    !== undefined) patch.archivos    = data.archivos    || null;
  if (data.comprobante !== undefined) patch.comprobante = data.comprobante || null;
  const rows = await _v9Fetch(
    `/movimientos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${encodeURIComponent(movId)}&select=*`,
    { method: 'PATCH', headers: { 'Prefer': 'return=representation' }, body: JSON.stringify(patch) },
    accessToken
  );
  if (!Array.isArray(rows) || rows.length === 0)
    throw new Error(`[datos_v9] actualizarMovimientoV9: movimiento ${movId} no encontrado.`);
  return rows[0];
}

/**
 * Elimina un movimiento. Lanza error si no se encontró (0 filas afectadas).
 */
async function eliminarMovimientoV9(cuentaId, movId, accessToken) {
  const rows = await _v9Fetch(
    `/movimientos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&id=eq.${encodeURIComponent(movId)}&select=*`,
    { method: 'DELETE', headers: { 'Prefer': 'return=representation' } },
    accessToken
  );
  if (!Array.isArray(rows) || rows.length === 0)
    throw new Error(`[datos_v9] eliminarMovimientoV9: movimiento ${movId} no encontrado o sin permiso.`);
  return rows;
}

/**
 * Convierte una fila de `movimientos` al shape esperado por DB.movimientos.
 */
function _mapMovimiento(row) {
  return {
    id:          row.id,
    cursoId:     row.curso_id,
    tipo:        row.tipo,
    desc:        row.desc,
    descripcion: row.desc,
    monto:       row.monto,
    categoria:   row.categoria,
    fecha:       row.fecha,
    responsable: row.responsable,
    visible:     row.visible,
    obs:         row.obs,
    creadoPor:   row.creado_por,
    archivos:    row.archivos    || [],
    comprobante: row.comprobante || null,
    _v9: true,
  };
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
    codigoCompartido: row.codigo_compartido || null,
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
 * Convierte una fila de `apoderados` al shape que espera DB.apoderados.
 */
function _mapApoderado(row) {
  return {
    id:       row.id,
    alumnoId: row.alumno_id,
    aluId:    row.alumno_id,
    nombre:   row.nombre,
    relacion: row.relacion,
    telefono: row.telefono,
    email:    row.email,
    estado:   row.estado,
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

  // C15: validar cursoId pedido contra el conjunto autorizado ANTES de cargar.
  // Si el caller pasa un cursoId ajeno a esta cuenta/membresía, se rechaza aquí
  // sin esperar a que RLS lo filtre silenciosamente.
  const idsAutorizados = new Set(cursosFiltrados.map(c => c.id));
  if (cursoId && !idsAutorizados.has(cursoId)) {
    throw new Error(
      `[datos_v9] cargarSesionV9: cursoId "${cursoId}" no está autorizado para esta cuenta/membresía. ` +
      `Cursos autorizados: [${[...idsAutorizados].join(', ')}]`
    );
  }

  const primerCursoId = cursoId || (cursosFiltrados[0] && cursosFiltrados[0].id) || null;

  // 3. Alumnos del primer curso (se recargan al cambiar de curso en selectCurso)
  if (primerCursoId) {
    const [alumnosRaw, cuotasRaw, apoderadosRaw, movimientosRaw] = await Promise.all([
      cargarAlumnos(cuentaId, primerCursoId, accessToken),
      cargarCuotas(cuentaId, primerCursoId, accessToken),
      cargarTodosApoderadosV9(cuentaId, accessToken),
      cargarMovimientosV9(cuentaId, primerCursoId, accessToken),
    ]);
    DB.alumnos      = alumnosRaw.map(_mapAlumno);
    DB.cuotas       = cuotasRaw.map(_mapCuota);
    DB.apoderados   = apoderadosRaw.map(_mapApoderado);
    DB.movimientos  = movimientosRaw.map(_mapMovimiento);
  } else {
    DB.alumnos      = [];
    DB.cuotas       = [];
    DB.apoderados   = [];
    DB.movimientos  = [];
  }

  // 4. Pagos de la cuenta (todos los cursos)
  const pagosRaw = await cargarPagos(cuentaId, accessToken);
  DB.pagos = pagosRaw.map(_mapPago);

  // 5. C16: limpiar colecciones no relacionales (nunca preservar de sesión anterior).
  DB.notas    = [];
  DB.colegios = [];

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
 * @returns {Promise<{ alumnos: object[], cuotas: object[], pagos: object[], apoderados: object[], movimientos: object[] }>}
 */
async function recargarCursoV9(cursoId, accessToken) {
  const cuentaId = (typeof S !== 'undefined' && S._v9CuentaId);
  if (!cuentaId) throw new Error('[v9] recargarCursoV9: S._v9CuentaId no disponible');

  const [alumnosRaw, cuotasRaw, pagosRaw, apoderadosRaw, movimientosRaw] = await Promise.all([
    cargarAlumnos(cuentaId, cursoId, accessToken),
    cargarCuotas(cuentaId, cursoId, accessToken),
    cargarPagos(cuentaId, accessToken),
    cargarTodosApoderadosV9(cuentaId, accessToken),
    cargarMovimientosV9(cuentaId, cursoId, accessToken),
  ]);

  // Devolver los datos mapeados sin escribir en DB.
  // El llamador es responsable de verificar el epoch y aplicar los datos.
  return {
    alumnos:     alumnosRaw.map(_mapAlumno),
    cuotas:      cuotasRaw.map(_mapCuota),
    pagos:       pagosRaw.map(_mapPago),
    apoderados:  apoderadosRaw.map(_mapApoderado),
    movimientos: movimientosRaw.map(_mapMovimiento),
  };
}

// ─── Flujo apoderado v9 ──────────────────────────────────────────────────────
// Estas funciones llaman a los RPC de SECURITY DEFINER vía la API REST de
// Supabase (/rest/v1/rpc/<nombre>). No acceden a tablas directamente.
// El PIN viaja solo en el cuerpo del POST, nunca en la URL ni en localStorage.
//
// ⚠️  Todas usan el anon key (SUPA_KEY) como apikey porque el flujo apoderado
//     es público (el apoderado no tiene cuenta Supabase). El SECURITY DEFINER
//     se encarga de validar identidad con el PIN.

/**
 * Llama a un RPC de apoderado via POST /rest/v1/rpc/<nombre>.
 * Siempre usa el anon key; el RPC valida internamente.
 *
 * @param {string} nombre — nombre del RPC (ej. 'apoderado_acceso')
 * @param {Object} params — parámetros a enviar en el cuerpo JSON
 * @returns {Promise<any>} resultado del RPC (JSONB devuelto por Supabase)
 */
async function _v9RpcApoderado(nombre, params) {
  const base = _v9BaseUrl().replace('/rest/v1', '') + '/rest/v1';
  const url  = base + '/rpc/' + nombre;

  // C08: las RPCs de apoderado son públicas (SECURITY DEFINER).
  // Solo se necesita apikey (anon role). NO enviar Authorization: Bearer <anon_key>
  // porque la anon key no es un JWT de usuario y el encabezado podría ser
  // rechazado si el formato de la clave cambia (ej. sb_publishable_*).
  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'apikey':       SUPA_KEY,
      'Content-Type': 'application/json',
      'Accept':       'application/json',
    },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch (_) {}
    throw Object.assign(
      new Error(`[datos_v9] RPC ${nombre} → HTTP ${res.status}: ${body}`),
      { status: res.status, body }
    );
  }

  return res.json();
}

/**
 * Selector inicial: dado un código de curso devuelve la lista de alumnos del curso.
 * No requiere PIN; devuelve solo id y nombre (sin datos sensibles).
 *
 * RPC: apoderado_alumnos_curso(p_codigo TEXT)
 * Retorna: TABLE(cuenta_id, alumno_id, nombre, curso_nombre, codigo, activo)
 *
 * @param {string} codigo — código alfanumérico del curso (ej. 'CUR-A01')
 * @returns {Promise<Array<{cuenta_id, alumno_id, nombre, curso_nombre, codigo, activo}>>}
 */
async function v9AluSelector(codigo) {
  // apoderado_alumnos_curso es una SRF (set-returning function); Supabase la
  // expone como GET o POST y devuelve un array de filas.
  const base = _v9BaseUrl().replace('/rest/v1', '') + '/rest/v1';
  const url  = base + '/rpc/apoderado_alumnos_curso';

  // C08: acceso anónimo — solo apikey, sin Authorization Bearer
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey':       SUPA_KEY,
      'Content-Type': 'application/json',
      'Accept':       'application/json',
    },
    body: JSON.stringify({ p_codigo: codigo }),
  });

  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch (_) {}
    throw Object.assign(
      new Error(`[datos_v9] v9AluSelector → HTTP ${res.status}: ${body}`),
      { status: res.status, body }
    );
  }

  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

/**
 * Verifica PIN y devuelve los datos del alumno con sus apoderados y cuotas.
 * El PIN viaja en el cuerpo del POST y NO se almacena en ninguna variable
 * persistente; debe vivir solo en el closure del llamador.
 *
 * RPC: apoderado_acceso(p_cuenta_id UUID, p_alumno_id TEXT, p_pin TEXT)
 * Retorna JSONB con:
 *   { alumno, apoderados, cuotas_estado }
 *   o { error: 'pin_incorrecto' | 'bloqueado' | 'alumno_inactivo' | ... }
 *
 * @param {string} cuentaId
 * @param {string} alumnoId
 * @param {string} pin        — debe vivir solo en memoria (closure/variable local)
 * @returns {Promise<Object>}
 */
async function v9AluAcceso(cuentaId, alumnoId, pin) {
  return _v9RpcApoderado('apoderado_acceso', {
    p_cuenta_id: cuentaId,
    p_alumno_id: alumnoId,
    p_pin:       pin,
  });
}

/**
 * Devuelve la situación financiera del alumno (requiere PIN válido).
 * El RPC verifica el PIN internamente; no asume sesión previa.
 *
 * RPC: apoderado_situacion_financiera(p_cuenta_id UUID, p_alumno_id TEXT, p_pin TEXT)
 * Retorna JSONB con:
 *   { pagos, planes, comprobantes, balance_curso }
 *   o { error: '...' }
 *
 * @param {string} cuentaId
 * @param {string} alumnoId
 * @param {string} pin — debe vivir solo en memoria
 * @returns {Promise<Object>}
 */
async function v9AluSituacion(cuentaId, alumnoId, pin) {
  return _v9RpcApoderado('apoderado_situacion_financiera', {
    p_cuenta_id: cuentaId,
    p_alumno_id: alumnoId,
    p_pin:       pin,
  });
}

/**
 * Edita los datos de un contacto/apoderado existente.
 * Pasa solo los campos a cambiar (null = no cambiar).
 *
 * RPC: apoderado_editar_contacto(
 *        p_cuenta_id UUID, p_alumno_id TEXT, p_pin TEXT,
 *        p_apoderado_id TEXT,
 *        p_nombre TEXT, p_relacion TEXT, p_telefono TEXT, p_email TEXT)
 * Retorna JSONB: { ok: true } o { error: '...' }
 *
 * @param {string}      cuentaId
 * @param {string}      alumnoId
 * @param {string}      pin
 * @param {string}      apoderadoId
 * @param {string|null} nombre
 * @param {string|null} relacion
 * @param {string|null} telefono
 * @param {string|null} email
 * @returns {Promise<Object>}
 */
async function v9AluEditarContacto(cuentaId, alumnoId, pin, apoderadoId, nombre, relacion, telefono, email) {
  return _v9RpcApoderado('apoderado_editar_contacto', {
    p_cuenta_id:    cuentaId,
    p_alumno_id:    alumnoId,
    p_pin:          pin,
    p_apoderado_id: apoderadoId,
    p_nombre:       nombre   ?? null,
    p_relacion:     relacion ?? null,
    p_telefono:     telefono ?? null,
    p_email:        email    ?? null,
  });
}

/**
 * Agrega un nuevo contacto/apoderado al alumno.
 *
 * RPC: apoderado_agregar_contacto(
 *        p_cuenta_id UUID, p_alumno_id TEXT, p_pin TEXT,
 *        p_nombre TEXT, p_relacion TEXT, p_telefono TEXT, p_email TEXT)
 * Retorna JSONB: { ok: true, apoderado_id: '...' } o { error: '...' }
 *
 * @param {string}      cuentaId
 * @param {string}      alumnoId
 * @param {string}      pin
 * @param {string}      nombre
 * @param {string|null} relacion
 * @param {string|null} telefono
 * @param {string|null} email
 * @returns {Promise<Object>}
 */
async function v9AluAgregarContacto(cuentaId, alumnoId, pin, nombre, relacion, telefono, email) {
  return _v9RpcApoderado('apoderado_agregar_contacto', {
    p_cuenta_id: cuentaId,
    p_alumno_id: alumnoId,
    p_pin:       pin,
    p_nombre:    nombre,
    p_relacion:  relacion  ?? null,
    p_telefono:  telefono  ?? null,
    p_email:     email     ?? null,
  });
}

// ── Acceso compartido CC-XXXX ─────────────────────────────────

/**
 * Verifica un código CC-XXXX y devuelve los datos del curso.
 * No requiere PIN: el código CC es la credencial de transparencia.
 *
 * RPC: apoderado_cc_verificar(p_codigo_cc TEXT)
 * Retorna: TABLE(cuenta_id, curso_id, nombre_curso, anio)
 *          → una fila si válido, cero filas si inválido/inactivo.
 *
 * @param {string} codigoCc — código con formato CC-XXXX-XXXX
 * @returns {Promise<{cuenta_id, curso_id, nombre_curso, anio}|null>}
 */
async function v9CcVerificar(codigoCc) {
  const filas = await (async () => {
    const base = _v9BaseUrl().replace('/rest/v1', '') + '/rest/v1';
    const res  = await fetch(base + '/rpc/apoderado_cc_verificar', {
      method:  'POST',
      headers: {
        'apikey':        SUPA_KEY,
        'Authorization': 'Bearer ' + SUPA_KEY,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
      },
      body: JSON.stringify({ p_codigo_cc: codigoCc }),
    });
    if (!res.ok) {
      let body = ''; try { body = await res.text(); } catch (_) {}
      throw new Error(`[datos_v9] v9CcVerificar → HTTP ${res.status}: ${body}`);
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  })();
  return filas.length > 0 ? filas[0] : null;
}

/**
 * Devuelve el resumen de pagos de todos los alumnos del curso.
 * El servidor verifica en cada llamada que el código compartido siga vigente.
 * Si fue revocado, la función retorna vacío.
 * No requiere JWT: el código CC es la única credencial.
 *
 * RPC: apoderado_cc_resumen_pagos(p_codigo_cc TEXT)
 * Acceso: anon
 * Retorna: TABLE(alumno_id, nombre, monto_pagado, monto_abonado,
 *                monto_pendiente, num_cuotas_pagadas, num_cuotas_pendientes)
 *
 * @param {string} codigoCc  — código CC-XXXX-XXXX verificado
 * @returns {Promise<Array>}
 */
async function v9CcResumenPagos(codigoCc) {
  const base = _v9BaseUrl().replace('/rest/v1', '') + '/rest/v1';
  const res  = await fetch(base + '/rpc/apoderado_cc_resumen_pagos', {
    method:  'POST',
    headers: {
      'apikey':        SUPA_KEY,
      'Authorization': 'Bearer ' + SUPA_KEY,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    body: JSON.stringify({ p_codigo_cc: codigoCc }),
  });
  if (!res.ok) {
    let body = ''; try { body = await res.text(); } catch (_) {}
    throw new Error(`[datos_v9] v9CcResumenPagos → HTTP ${res.status}: ${body}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/**
 * Genera un código compartido CC-XXXX-XXXX para el curso.
 * Requiere JWT de Supabase (tesorero o admin de la cuenta).
 *
 * RPC: apoderado_cc_generar(p_cuenta_id UUID, p_curso_id TEXT)
 * Acceso: authenticated  (anon recibe 42501)
 * Retorna: JSONB { codigo_cc: "CC-XXXX-XXXX" }
 *
 * @param {string} cuentaId
 * @param {string} cursoId
 * @returns {Promise<{codigo_cc: string}>}
 */
async function v9CcGenerar(cuentaId, cursoId) {
  const base  = _v9BaseUrl().replace('/rest/v1', '') + '/rest/v1';
  // _authToken es una variable let, no una función.
  const token = (typeof _authToken !== 'undefined' && _authToken) || null;
  if (!token) throw new Error('[v9] v9CcGenerar: sin sesión activa (JWT no disponible)');
  const res   = await fetch(base + '/rpc/apoderado_cc_generar', {
    method:  'POST',
    headers: {
      'apikey':        SUPA_KEY,
      'Authorization': 'Bearer ' + token,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    body: JSON.stringify({ p_cuenta_id: cuentaId, p_curso_id: cursoId }),
  });
  if (!res.ok) {
    let body = ''; try { body = await res.text(); } catch (_) {}
    throw new Error(`[datos_v9] v9CcGenerar → HTTP ${res.status}: ${body}`);
  }
  return await res.json();
}

/**
 * Revoca el código compartido del curso.
 * Requiere JWT de Supabase (tesorero o admin de la cuenta).
 * Tras revocar, v9CcResumenPagos con el código anterior retorna vacío.
 *
 * RPC: apoderado_cc_revocar(p_cuenta_id UUID, p_curso_id TEXT)
 * Acceso: authenticated  (anon recibe 42501)
 * Retorna: JSONB { revocado: true }
 *
 * @param {string} cuentaId
 * @param {string} cursoId
 * @returns {Promise<{revocado: boolean}>}
 */
async function v9CcRevocar(cuentaId, cursoId) {
  const base  = _v9BaseUrl().replace('/rest/v1', '') + '/rest/v1';
  const token = (typeof _authToken !== 'undefined' && _authToken) || null;
  if (!token) throw new Error('[v9] v9CcRevocar: sin sesión activa (JWT no disponible)');
  const res   = await fetch(base + '/rpc/apoderado_cc_revocar', {
    method:  'POST',
    headers: {
      'apikey':        SUPA_KEY,
      'Authorization': 'Bearer ' + token,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    body: JSON.stringify({ p_cuenta_id: cuentaId, p_curso_id: cursoId }),
  });
  if (!res.ok) {
    let body = ''; try { body = await res.text(); } catch (_) {}
    throw new Error(`[datos_v9] v9CcRevocar → HTTP ${res.status}: ${body}`);
  }
  return await res.json();
}
