// js/core/integraciones-legacy.js — extraído de la copia de demostración.
async function getPerfilAuth(userId){
  if(!authClient || !userId) return null;
  try{
    const { data, error } = await authClient
      .from('usuarios_app')
      .select('*')
      .eq('id', userId)
      .single();
    if(error) return null;
    return data || null;
  }catch(e){
    return null;
  }
}

// Busca los datos del usuario usando su authId (UUID de Supabase Auth) como clave primaria.
// Si no se encuentra por authId, intenta por el userId legacy ('u1' para el primer tesorero).
// Esto evita descargar los datos de TODOS los usuarios para buscar por email.
async function buscarUsuarioLegacyPorEmail(email, authUserId){
  const target = String(email||'').trim().toLowerCase();
  if(!target) return null;

  // 1) Buscar por auth UUID — siempre consultar Supabase para tener datos frescos
  if(authUserId){
    try{
      const rows = await sbGet('tesorero_datos','usuario_id=eq.'+encodeURIComponent(authUserId));
      if(rows && rows.length > 0 && rows[0].datos){
        const user = (rows[0].datos.usuarios||[]).find(u => String(u.email||'').toLowerCase() === target);
        if(user) return { user, datos: rows[0].datos };
      }
    }catch(e){}
  }

  // 2) Fallback legacy: buscar bajo el userId fijo 'u1' (instalaciones antiguas)
  try{
    const rows = await sbGet('tesorero_datos','usuario_id=eq.u1');
    if(rows && rows.length > 0 && rows[0].datos){
      const user = (rows[0].datos.usuarios||[]).find(u => String(u.email||'').toLowerCase() === target);
      if(user) return { user, datos: rows[0].datos };
    }
  }catch(e){}

  // 3) Fallback completo: escanear todos los registros buscando el email
  //    (cubre usuarios invitados cuyos datos viven en el registro del tesorero principal)
  //    Usa limit=1000 y ordena por actualizado_en para priorizar registros recientes
  try{
    const todos = await sbGet('tesorero_datos','select=usuario_id,datos&limit=1000&order=actualizado_en.desc');
    if(Array.isArray(todos)){
      for(const row of todos){
        if(!row.datos) continue;
        const user = (row.datos.usuarios||[]).find(u => String(u.email||'').toLowerCase() === target);
        if(user) return { user, datos: row.datos };
      }
    }
  }catch(e){}

  return null;
}

let _lastAuthError = null; // guarda el último error real de Supabase Auth para diagnóstico

async function loginConAuth(email, errEl){
  if(!authClient) return false;
  try{
    const { data: authData, error } = await authClient.auth.signInWithPassword({
      email: email,
      password: document.getElementById('l-pass').value
    });
    if(error || !authData?.user){
      _lastAuthError = error ? { message: error.message, status: error.status } : { message: 'unknown', status: null };
      return false;
    }
    _lastAuthError = null;

    // Guardar token JWT para usarlo en todas las peticiones a Supabase
    _authToken = authData.session?.access_token || null;

    // ── FLUJO RELACIONAL v9 ──────────────────────────────────────────────
    // Si V9_RELACIONAL está activo, cargar datos desde las tablas relacionales
    // y omitir completamente el blob tesorero_datos.
    if (typeof V9_RELACIONAL !== 'undefined' && V9_RELACIONAL) {
      try {
        const { cuenta, cuentaId, cursoIds } = await cargarSesionV9(
          authData.user.id,
          _authToken
        );
        const usuarioV9 = {
          id:       cuentaId,          // PK de tesorero_cuentas (UUID)
          authId:   authData.user.id,
          email:    cuenta.email || email,
          nombre:   cuenta.nombre || email,
          rol:      'tesorero',
          cursoIds: cursoIds,
          _v9:      true,
        };
        _finalizarLoginV9(usuarioV9, errEl, cursoIds);
        return true;
      } catch (errV9) {
        if (errEl) {
          errEl.textContent = 'Error cargando datos relacionales: ' + errV9.message;
          errEl.style.display = '';
        }
        console.error('[v9] cargarSesionV9 falló:', errV9);
        return false;
      }
    }
    // ── FIN FLUJO RELACIONAL v9 ──────────────────────────────────────────

    // Buscar datos legacy del usuario por email + authId (evita descarga masiva)
    const legacy = await buscarUsuarioLegacyPorEmail(authData.user.email || email, authData.user.id);
    if(legacy && legacy.datos){
      DB = legacy.datos;
      previewStorage.setItem(KEY, JSON.stringify(DB));
      const u = { ...legacy.user, authId: authData.user.id };
      if(document.getElementById('l-pass').value === 'Cambiar2026!'){
        _finalizarLogin(u, errEl);
        setTimeout(()=>mostrarCambioPasswordObligatorio(), 500);
        return true;
      }
      _finalizarLogin(u, errEl);
      return true;
    }

    // Auth OK pero sin datos legacy bajo el authId — buscar por email en DB local
    // (usuarios invitados cuyos datos viven en tesorero_datos del tesorero principal)
    const emailNorm = (authData.user.email||email).toLowerCase().trim();
    const uLocal = (DB.usuarios||[]).find(u => String(u.email||'').toLowerCase()===emailNorm);
    if(uLocal){
      const u = { ...uLocal, authId: authData.user.id };
      if(document.getElementById('l-pass').value === 'Cambiar2026!'){
        _finalizarLogin(u, errEl);
        setTimeout(()=>mostrarCambioPasswordObligatorio(), 500);
        return true;
      }
      _finalizarLogin(u, errEl);
      return true;
    }

    // Auth OK pero no se encontraron datos en ninguna búsqueda
    // Mostrar error específico para diferenciar de contraseña incorrecta
    if(errEl){
      errEl.textContent = 'Autenticación correcta pero no se encontraron tus datos. Contacta al administrador. (auth-ok-no-data)';
      errEl.style.display = '';
    }
    return false;

    return false;
  }catch(e){
    _lastAuthError = { message: e?.message || 'exception', status: null };
    return false;
  }
}

function mostrarCambioPasswordObligatorio(){
  const overlay = document.createElement('div');
  overlay.id = 'overlay-cambio-pass';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;padding:16px';
  overlay.innerHTML = `
    <div style="background:var(--wh);border-radius:16px;padding:28px;max-width:380px;width:100%">
      <div style="font-size:28px;text-align:center;margin-bottom:8px">🔐</div>
      <h3 style="text-align:center;margin:0 0 8px;color:var(--g)">Cambia tu contraseña</h3>
      <p style="font-size:13px;color:var(--t2);text-align:center;margin-bottom:20px">
        Estás usando la contraseña temporal. Por seguridad debes cambiarla ahora.
      </p>
      <div style="margin-bottom:12px">
        <label style="font-size:12px;color:var(--t3)">Nueva contraseña</label>
        <input type="password" id="nueva-pass" class="fi" placeholder="Mínimo 8 caracteres" style="margin-top:4px">
      </div>
      <div style="margin-bottom:20px">
        <label style="font-size:12px;color:var(--t3)">Confirmar contraseña</label>
        <input type="password" id="confirmar-pass" class="fi" placeholder="Repite la contraseña" style="margin-top:4px">
      </div>
      <div id="err-cambio-pass" style="display:none;color:var(--r);font-size:12px;margin-bottom:12px;text-align:center"></div>
      <button class="btn bp" onclick="guardarNuevaPassword()" style="width:100%">💾 Guardar contraseña</button>
    </div>
  `;
  document.body.appendChild(overlay);
}

async function guardarNuevaPassword(){
  const nueva = document.getElementById('nueva-pass').value;
  const confirmar = document.getElementById('confirmar-pass').value;
  const errEl = document.getElementById('err-cambio-pass');
  if(nueva.length < 8){ errEl.textContent='Mínimo 8 caracteres.'; errEl.style.display=''; return; }
  if(nueva !== confirmar){ errEl.textContent='Las contraseñas no coinciden.'; errEl.style.display=''; return; }
  try{
    const { error } = await authClient.auth.updateUser({ password: nueva });
    if(error){ errEl.textContent='Error: '+error.message; errEl.style.display=''; return; }
    document.getElementById('overlay-cambio-pass')?.remove();
    showToast('✅ Contraseña actualizada correctamente');
  }catch(e){
    errEl.textContent='No se pudo actualizar la contraseña.';
    errEl.style.display='';
  }
}


async function supaGuardar(userId, datos){
  try{
    await sbFetch('/rest/v1/tesorero_datos',{
      method:'POST',
      headers:{'Prefer':'resolution=merge-duplicates'},
      body:JSON.stringify({usuario_id:userId,datos:datos,actualizado_en:new Date().toISOString()})
    });
    return true;
  }catch(e){return false;}
}

async function supaCargar(userId){
  try{
    const rows = await sbGet('tesorero_datos','usuario_id=eq.'+encodeURIComponent(userId)+'&select=datos');
    return (rows && rows.length > 0) ? rows[0].datos : null;
  }catch(e){return null;}
}

function checkVersion(){
  const v = previewStorage.getItem(VERSION_KEY);
  if(!v){ previewStorage.setItem(VERSION_KEY,APP_VERSION); return; }
  if(v !== APP_VERSION){
    mostrarBannerVersion(APP_VERSION);
    previewStorage.setItem(VERSION_KEY,APP_VERSION);
  }
}

// Detectar cuando el Service Worker instala una nueva versión
// y mostrar banner de recarga disponible
function setupSWUpdateDetection(){
  if(!navigator.serviceWorker) return;
  navigator.serviceWorker.getRegistration().then(reg=>{
    if(!reg) return;
    reg.addEventListener('updatefound', ()=>{
      const newWorker = reg.installing;
      if(!newWorker) return;
      newWorker.addEventListener('statechange', ()=>{
        if(newWorker.state==='installed' && navigator.serviceWorker.controller){
          // Hay una versión nueva lista — mostrar banner de recarga
          mostrarBannerRecarga();
        }
      });
    });
  }).catch(()=>{});
}

function mostrarBannerRecarga(){
  if(document.getElementById('banner-recarga')) return;
  const banner = document.createElement('div');
  banner.id = 'banner-recarga';
  banner.style.cssText = 'position:fixed;bottom:70px;left:50%;transform:translateX(-50%);z-index:9999;background:#0F6E56;color:#fff;border-radius:14px;padding:12px 20px;display:flex;align-items:center;gap:12px;box-shadow:0 8px 24px rgba(0,0,0,0.25);font-family:inherit;max-width:calc(100vw - 32px);animation:slideUp .3s ease';
  banner.innerHTML = `
    <span style="font-size:18px">🚀</span>
    <div style="flex:1">
      <div style="font-size:13px;font-weight:700">Nueva versión disponible</div>
      <div style="font-size:12px;opacity:.8">Recarga para ver las últimas mejoras</div>
    </div>
    <button onclick="window.location.reload()" style="background:#fff;color:#0F6E56;border:none;border-radius:8px;padding:7px 14px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap">
      Actualizar →
    </button>
    <button onclick="document.getElementById('banner-recarga').remove()" style="background:none;border:none;color:rgba(255,255,255,0.6);font-size:20px;cursor:pointer;padding:0 4px;line-height:1">×</button>
  `;
  document.body.appendChild(banner);
}

function mostrarBannerVersion(vNueva){
  if(document.getElementById('banner-update')) return;
  const novedades = {
    '3.0': [
      '💬 Módulo de Cobranza con WhatsApp automático y plantillas editables',
      '📅 Plan de pagos en cuotas programadas por alumno',
      '✅ Registro de varios meses de una vez al pagar',
      '🎓 Fondo Especial con aportes, rendimientos y actividades individuales',
      '📊 Dashboard financiero mejorado con barras de progreso',
      '✏️ Edición de pagos y abonos ya registrados',
      '👥 Gestión de usuarios con días restantes y activación de planes',
      '📋 Tabla resumen de fondos por alumno en sección Alumnos',
    ],
    '3.1': [
      '🔄 Apoderados ven datos frescos al entrar — ya no se quedan con info antigua',
      '↻ Botón Actualizar en la vista del apoderado (Dashboard y Movimientos)',
      '🗑 Eliminaciones del tesorero se reflejan inmediatamente al apoderador actualizar',
    ],
    '3.2': [
      '✏️ Editar ingresos y gastos ya registrados (no solo eliminar)',
      '🏦 Saldo disponible con fondo verde/rojo llamativo en el Dashboard',
      '📅 Alumnos con plan de pago se identifican con badge azul en Pagos',
      '↓ Ordenar deudores por mayor deuda, menor deuda o apellido en Cobranza',
      '↻ Botón Actualizar datos en Cobranza',
      '🔧 Herramienta de mantenimiento para limpiar planes de pago huérfanos',
      '💬 Mensaje WhatsApp de cobranza muestra total correcto con múltiples cuotas',
    ],
    '3.3': [
      '💬 Notificación WhatsApp al registrar abonos del plan de pago',
      '📋 Apoderado ve el desglose completo de sus abonos: pagados, pendientes y fechas',
      '📲 Un solo botón "Notificar pagos" resume todos los abonos en un mensaje',
    ],
    '3.5': [
      '📊 Importación desde Excel — sube miembros, cuotas, pagos y movimientos de una sola vez',
      '🔍 Buscador y filtros en Ingresos y Gastos — filtra por descripción, categoría o monto',
      '🚀 Banner automático cuando hay una nueva versión disponible',
      '🔒 Seguridad mejorada — protección de datos activada en la base de datos',
    ],
    '3.4': [
      '🏢 App transversal: ahora sirve para Juntas de vecinos, Clubes deportivos, Adultos mayores y más',
      '🔤 Sistema de vocabulario adaptable — los textos cambian según el tipo de organización',
      '⚙️ Tipo personalizado para organizaciones con nombre propio',
      '🏘️ Categorías de gastos adaptadas a cada tipo de organización',
    ]
  };
  const lista = novedades[vNueva] || ['Nuevas mejoras y correcciones'];
  const overlay = document.createElement('div');
  overlay.id = 'banner-update';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;padding:16px';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:20px;padding:28px 24px;max-width:440px;width:100%;max-height:90vh;overflow-y:auto">
      <div style="text-align:center;margin-bottom:20px">
        <div style="font-size:40px;margin-bottom:8px">🚀</div>
        <div style="font-size:20px;font-weight:800;color:#1a1a1a">¡Tesorero v${vNueva}!</div>
        <div style="font-size:13px;color:#666;margin-top:4px">Hay novedades importantes en esta versión</div>
      </div>
      <div style="background:#F0FDF4;border-radius:12px;padding:14px 16px;margin-bottom:20px">
        <div style="font-size:12px;font-weight:700;color:#0F6E56;text-transform:uppercase;margin-bottom:10px">Novedades v${vNueva}</div>
        ${lista.map(n=>`<div style="font-size:13px;color:#1a1a1a;padding:5px 0;border-bottom:1px solid #E1F5EE;display:flex;gap:8px"><span>${n}</span></div>`).join('')}
      </div>
      <button onclick="document.getElementById('banner-update').remove()" style="width:100%;background:linear-gradient(135deg,#0F6E56,#1D9E75);border:none;color:#fff;padding:12px;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer">¡Entendido, explorar novedades! 🎉</button>
    </div>`;
  document.body.appendChild(overlay);
}

// ─── DEEP LINK ───────────────────────────────────────────────
// Permite abrir la app con ?curso=CODIGO&alu=ID_ALUMNO
// El apoderado llega directo al paso del PIN sin escribir nada
function procesarDeepLink(){
  try {
    const params = new URLSearchParams(window.location.search);
    const codigoCurso = params.get('curso');
    const aluId       = params.get('alu');
    if(!codigoCurso) return; // no es un deep link

    // Guardar en sessionStorage para usarlo después de render()
    sessionStorage.setItem('dl_curso', codigoCurso);
    if(aluId) sessionStorage.setItem('dl_alu', aluId);

    // Limpiar URL sin recargar
    const urlLimpia = window.location.href.split('?')[0];
    window.history.replaceState({}, '', urlLimpia);
  } catch(e){}
}

function aplicarDeepLinkSiExiste(){
  const codigoCurso = sessionStorage.getItem('dl_curso');
  const aluId       = sessionStorage.getItem('dl_alu');
  if(!codigoCurso) return;

  sessionStorage.removeItem('dl_curso');
  sessionStorage.removeItem('dl_alu');

  // Cambiar a pestaña "Soy apoderado"
  switchLoginTab('codigo');

  // Buscar el curso por código en DB local o Supabase
  const buscarYAvanzar = (d) => {
    const db = d || DB;
    const curso = (db.cursos||[]).find(c=>c.codigo===codigoCurso && c.activo);
    if(!curso) return false;

    // Si también tenemos el aluId, ir directo al paso del PIN
    if(aluId){
      const alu = (db.alumnos||[]).find(a=>a.id===aluId && a.cursoId===curso.id);
      if(alu){
        _cursoTempId = curso.id;
        window._aluSelId = alu.id;
        // Mostrar paso del PIN directamente
        document.getElementById('paso-codigo').style.display='none';
        document.getElementById('paso-alumno').style.display='none';
        document.getElementById('paso-pin').style.display='';
        document.getElementById('paso3-alu-nombre').textContent = alu.nombres+' '+alu.apellidos;
        document.getElementById('paso3-cur-nombre').textContent = curso.nombre+' · '+curso.anio;
        document.getElementById('l-pin').focus();
        return true;
      }
    }

    // Si solo tenemos el código, ir al paso de selección de alumno
    _cursoTempId = curso.id;
    document.getElementById('paso-codigo').style.display='none';
    document.getElementById('paso-alumno').style.display='';
    document.getElementById('paso2-curso-nombre').textContent = curso.nombre+' · '+curso.anio;
    renderAlumnosSelector('');
    return true;
  };

  // Intentar con DB local primero
  if(buscarYAvanzar(null)) return;

  // Si no está local, buscar solo el campo cursos (no datos completos) para minimizar exposición
  // Nota: una solución definitiva requiere una tabla de índice `codigos_cursos` en Supabase.
  fetch(SUPA_URL+'/rest/v1/tesorero_datos?select=usuario_id,datos->cursos',{
    headers:{'apikey':SUPA_KEY,'Authorization':'Bearer '+(_authToken||SUPA_KEY)}
  }).then(r=>r.json()).then(async rows=>{
    for(const row of (rows||[])){
      const cursos = row.cursos || row['?column?'];
      if(!Array.isArray(cursos)) continue;
      const c = cursos.find(x=>x.codigo===codigoCurso&&x.activo);
      if(!c) continue;
      // Encontrado: ahora cargar solo los datos de ESE usuario
      const userId = row.usuario_id;
      const full = await sbGet('tesorero_datos','usuario_id=eq.'+encodeURIComponent(userId));
      if(full && full.length > 0 && full[0].datos){
        mergeDB(full[0].datos);
        buscarYAvanzar(DB);
      }
      return;
    }
  }).catch(()=>{});
}

function verificarRespaldoAutomatico(){
  // Solo para tesoreros, no apoderados
  if(S && S.session && S.session.rol === 'apoderado_lector') return;

  const CLAVE_RESPALDO = 'tesorero_ultimo_respaldo';
  const DIAS_AVISO = 30; // avisar cada 30 días

  const ultimoRespaldo = previewStorage.getItem(CLAVE_RESPALDO);
  const hoy = new Date();

  if(!ultimoRespaldo){
    // Primera vez — guardar fecha de hoy sin avisar
    previewStorage.setItem(CLAVE_RESPALDO, hoy.toISOString());
    return;
  }

  const diasDesdeRespaldo = Math.floor((hoy - new Date(ultimoRespaldo)) / (1000 * 60 * 60 * 24));

  if(diasDesdeRespaldo >= DIAS_AVISO){
    // Mostrar banner de respaldo
    setTimeout(function(){
      mostrarBannerRespaldo(diasDesdeRespaldo);
    }, 3000); // esperar 3 segundos para no molestar al cargar
  }
}

function mostrarBannerRespaldo(dias){
  // No mostrar si ya hay otro banner activo
  if(document.getElementById('banner-respaldo')) return;

  const b = document.createElement('div');
  b.id = 'banner-respaldo';
  b.style.cssText = 'position:fixed;bottom:70px;left:12px;right:12px;z-index:9998;background:#fff;border:2px solid #378ADD;border-radius:14px;padding:14px 16px;box-shadow:0 4px 20px rgba(0,0,0,0.15);display:flex;align-items:center;gap:12px;max-width:480px;margin:0 auto';
  b.innerHTML = '<div style="font-size:24px">💾</div>' +
    '<div style="flex:1">' +
      '<div style="font-weight:700;font-size:13px;color:#1a1a1a">Han pasado ' + dias + ' días sin respaldo</div>' +
      '<div style="font-size:12px;color:#666;margin-top:2px">Exporta tus datos para no perderlos si algo falla</div>' +
    '</div>' +
    '<div style="display:flex;gap:6px">' +
      '<button onclick="exportarRespaldoDesdeBanner()" style="background:#378ADD;border:none;color:#fff;padding:7px 12px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer">💾 Exportar</button>' +
      '<button onclick="cerrarBannerRespaldo()" style="background:none;border:1px solid #ddd;color:#999;padding:7px 10px;border-radius:8px;font-size:12px;cursor:pointer">✕</button>' +
    '</div>';
  document.body.appendChild(b);
}

function exportarRespaldoDesdeBanner(){
  exportarDatos();
  previewStorage.setItem('tesorero_ultimo_respaldo', new Date().toISOString());
  cerrarBannerRespaldo();
  // Mostrar confirmación
  var toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#0F6E56;color:#fff;padding:10px 20px;border-radius:20px;font-size:13px;font-weight:600;z-index:99999;box-shadow:0 2px 12px rgba(0,0,0,0.2)';
  toast.textContent = '✅ Respaldo guardado correctamente';
  document.body.appendChild(toast);
  setTimeout(function(){ toast.remove(); }, 3000);
}

function cerrarBannerRespaldo(){
  const b = document.getElementById('banner-respaldo');
  if(b) b.remove();
  // Posponer recordatorio 7 días más
  const nueva = new Date();
  nueva.setDate(nueva.getDate() - 23); // 30-7=23 días atrás para que avise en 7 días
  previewStorage.setItem('tesorero_ultimo_respaldo', nueva.toISOString());
}

// KEY de previewStorage — arranca con el valor legacy para cargar datos existentes.
// Se actualiza a 'tesorero_u_{userId}' al hacer login para aislar datos por usuario.
