// js/features/administracion.js — extraído de la copia de demostración.
let _lastCargarUsuarios = 0;
async function cargarUsuariosDesdeSupabase(forzar=false){
  // Caché de 5 minutos — evita lecturas repetidas a Supabase
  const ahora = Date.now();
  if(!forzar && (ahora - _lastCargarUsuarios) < 5*60*1000) return;
  _lastCargarUsuarios = ahora;
  try{
    // Leer usuarios_app + ultima actividad desde tesorero_datos en una sola query
    const res = await sbFetch('/rest/v1/usuarios_app?select=*&order=creado_en.desc');
    if(!res.ok) return;
    const rows = await res.json();
    // Traer ultima_actividad desde tesorero_datos (solo fecha, no datos)
    const actRes = await sbFetch('/rest/v1/tesorero_datos?select=usuario_id,actualizado_en&usuario_id=neq.landing_visitas&usuario_id=neq.colegios_chile&usuario_id=neq.global&usuario_id=neq.ap_lector');
    const actRows = actRes.ok ? await actRes.json() : [];
    const actMap = {};
    actRows.forEach(r=>{ actMap[r.usuario_id] = r.actualizado_en; });
    const yo = S.session;
    if(!DB.usuariosExternos) DB.usuariosExternos=[];
    rows.forEach(u=>{
      if(u.id === yo?.id) return;
      const uMapped = {
        id: u.id,
        email: u.email,
        nombre: u.nombre,
        invitado: true,
        desactivado: u.desactivado,
        fechaRegistro: u.fecha_registro,
        planAnual: u.plan === 'anual',
        planVIP: u.plan_vip,
        planAnualHasta: u.plan_hasta,
        codigoUsado: u.codigo_usado,
        ultimaActividad: actMap[u.id] || null,
        _fromUsuariosApp: true
      };
      const idx = DB.usuariosExternos.findIndex(x=>x.id===u.id);
      if(idx>=0) DB.usuariosExternos[idx]={...DB.usuariosExternos[idx],...uMapped};
      else DB.usuariosExternos.push(uMapped);
    });
    // Ordenar por última actividad
    DB.usuariosExternos.sort((a,b)=>{
      if(!a.ultimaActividad) return 1;
      if(!b.ultimaActividad) return -1;
      return new Date(b.ultimaActividad) - new Date(a.ultimaActividad);
    });
    const el=document.getElementById('lista-usuarios-admin');
    if(el) el.innerHTML=renderUsuariosAdmin();
  }catch(e){ console.log('cargarUsuarios error:',e); }
}

function filtrarUsuarios(query){
  const el = document.getElementById('lista-usuarios-admin');
  if(el) el.innerHTML = renderUsuariosAdmin(query);
}

function renderUsuariosAdmin(filtro){
  // Trigger async load from Supabase
  cargarUsuariosDesdeSupabase();
  const yo = S.session;
  // Collect all invitado users from all DB records
  const todosUsuarios = [];
  (DB.usuariosExternos||[]).forEach(u=>{ if(!todosUsuarios.find(x=>x.id===u.id)) todosUsuarios.push(u); });
  (DB.usuarios||[]).filter(u=>u.invitado && u.id!==yo?.id).forEach(u=>{ if(!todosUsuarios.find(x=>x.id===u.id)) todosUsuarios.push(u); });
  // Apply filter
  const q = (filtro||'').toLowerCase().trim();
  const usuarios = q
    ? todosUsuarios.filter(u=>(u.nombre||'').toLowerCase().includes(q)||(u.email||'').toLowerCase().includes(q))
    : todosUsuarios;
  if(!todosUsuarios.length) return '<p style="font-size:13px;color:var(--t3);text-align:center;padding:12px">Cargando usuarios... <span style="color:var(--t3)">(puede tardar unos segundos)</span></p>';
  if(!usuarios.length) return '<p style="font-size:13px;color:var(--t3);text-align:center;padding:12px">No se encontraron usuarios con ese criterio.</p>';
  const hoy = new Date(); hoy.setHours(0,0,0,0);
  return '<div style="display:flex;flex-direction:column;gap:8px">' + usuarios.map(u=>{
    const activo = !u.desactivado;
    // Calcular días restantes
    let diasInfo = '';
    let diasColor = 'var(--g)';
    if(u.planVIP){
      diasInfo = '⭐ VIP — sin vencimiento';
      diasColor = '#B8860B';
    } else if(u.planAnual && u.planAnualHasta){
      const vence = new Date(u.planAnualHasta); vence.setHours(0,0,0,0);
      const dias = Math.ceil((vence-hoy)/(1000*60*60*24));
      if(dias<0){ diasInfo='💳 Plan anual — VENCIDO'; diasColor='var(--r)'; }
      else if(dias<=7){ diasInfo=`💳 Plan anual — ⚠️ ${dias} día${dias!==1?'s':''} restantes`; diasColor='#D97706'; }
      else{ diasInfo=`💳 Plan anual — ${dias} días restantes (hasta ${u.planAnualHasta})`; diasColor='var(--b)'; }
    } else if(u.fechaRegistro){
      const reg = new Date(u.fechaRegistro); reg.setHours(0,0,0,0);
      const diasUsados = Math.ceil((hoy-reg)/(1000*60*60*24));
      const dias = 30-diasUsados;
      if(dias<0){ diasInfo=`🆓 Prueba — VENCIDA (venció hace ${Math.abs(dias)} días)`; diasColor='var(--r)'; }
      else if(dias<=7){ diasInfo=`🆓 Prueba — ⚠️ ${dias} día${dias!==1?'s':''} restantes`; diasColor='#D97706'; }
      else{ diasInfo=`🆓 Prueba — ${dias} días restantes`; diasColor='var(--g)'; }
    } else {
      diasInfo='🆓 Prueba — fecha desconocida';
      diasColor='var(--t3)';
    }
    return `<div style="padding:12px 14px;border:1px solid var(--brd);border-radius:10px;background:${activo?'var(--wh)':'var(--bg)'}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap">
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:14px">${escHtml(u.nombre||u.email)}</div>
          <div style="font-size:12px;color:var(--t3);margin-top:2px">${escHtml(u.email)}</div>
          <div style="font-size:12px;font-weight:600;color:${diasColor};margin-top:4px">${diasInfo}</div>
          ${u.ultimaActividad?`<div style="font-size:11px;color:var(--t3);margin-top:2px">🕐 Última actividad: ${fmtDate(u.ultimaActividad.slice(0,10))}</div>`:''}
          ${u.codigoUsado?`<div style="font-size:11px;color:var(--t3);margin-top:2px">🔑 Código: <code style="background:var(--bg);padding:1px 5px;border-radius:4px;font-size:11px">${escHtml(u.codigoUsado)}</code></div>`:(()=>{ const cod=(DB.config?.codigosInvitacion||[]).find(c=>c.usadoPor===u.email||c.usado_por===u.email); return cod?`<div style="font-size:11px;color:var(--t3);margin-top:2px">🔑 Código: <code style="background:var(--bg);padding:1px 5px;border-radius:4px;font-size:11px">${escHtml(cod.codigo)}</code></div>`:'';})()}
          ${!activo?'<div style="font-size:11px;color:var(--r);font-weight:700;margin-top:2px">● DESACTIVADO</div>':''}
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap">
          <button class="btn bs ${activo?'bd':'bp'}" onclick="toggleUsuarioAdmin('${u.id}')">${activo?'🚫':'✅'}</button>
          <button class="btn bs bd" onclick="eliminarUsuarioAdmin('${u.id}')">🗑</button>
        </div>
      </div>
      ${!u.planVIP?`<div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
        <button class="btn bs bp" onclick="activarPlanAdmin('${u.id}',12)" style="font-size:12px">💳 Activar 1 año</button>
        <button class="btn bs" onclick="activarVIPAdmin('${u.id}')" style="font-size:12px;background:#EF9F27;color:#fff;border:none">⭐ Activar VIP</button>
      </div>`:''}
      ${(u.historialPagos&&u.historialPagos.length)?`
      <div style="margin-top:10px;border-top:1px solid var(--brd);padding-top:8px">
        <div style="font-size:11px;font-weight:700;color:var(--t3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Historial de pagos</div>
        ${u.historialPagos.map(p=>`
          <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--t2);padding:3px 0;border-bottom:1px solid var(--bg)">
            <span>💳 Plan ${escHtml(p.tipo||'Anual')}</span>
            <span style="color:var(--t3)">${escHtml(p.fecha||'')} → hasta ${escHtml(p.hasta||'')}</span>
          </div>`).join('')}
      </div>`:''}
    </div>`;
  }).join('') + '</div>';
}

async function toggleUsuarioAdmin(uid){
  let u=(DB.usuarios||[]).find(x=>x.id===uid)||(DB.usuariosExternos||[]).find(x=>x.id===uid);
  if(!u) return;
  if(!confirm(`¿${u.desactivado?'Reactivar':'Desactivar'} el acceso de ${u.nombre||u.email}?`)) return;
  u.desactivado=!u.desactivado;
  const ext=(DB.usuariosExternos||[]).find(x=>x.id===uid);
  if(ext) ext.desactivado=u.desactivado;
  // Actualizar en usuarios_app (tabla liviana)
  await sbFetch('/rest/v1/usuarios_app?id=eq.'+encodeURIComponent(uid),{
    method:'PATCH',
    headers:{'Prefer':'return=minimal'},
    body:JSON.stringify({desactivado:u.desactivado, actualizado_en:new Date().toISOString()})
  }).catch(()=>{});
  // También actualizar en tesorero_datos del usuario si existe
  if(u._rowId){
    sbGet('tesorero_datos','usuario_id=eq.'+encodeURIComponent(u._rowId)).then(rows=>{
      if(!rows||!rows.length) return;
      const datos=rows[0].datos;
      const ui=(datos.usuarios||[]).findIndex(x=>x.id===uid);
      if(ui>=0){ datos.usuarios[ui].desactivado=u.desactivado; }
      sbFetch('/rest/v1/tesorero_datos?usuario_id=eq.'+encodeURIComponent(u._rowId),{
        method:'PATCH',
        headers:{'Prefer':'return=minimal'},
        body:JSON.stringify({datos, actualizado_en:new Date().toISOString()})
      });
    });
  }
  saveDB();
  const el=document.getElementById('lista-usuarios-admin');
  if(el) el.innerHTML=renderUsuariosAdmin();
}

function eliminarUsuarioAdmin(uid){
  const u=(DB.usuarios||[]).find(x=>x.id===uid)||(DB.usuariosExternos||[]).find(x=>x.id===uid);
  if(!u){ alert('Usuario no encontrado.'); return; }
  if(!confirm('¿Eliminar permanentemente la cuenta de '+(u.nombre||u.email)+'?\nEsta acción no se puede deshacer.')) return;
  if(!confirm('Segunda confirmación: ¿Seguro que deseas eliminar esta cuenta definitivamente?')) return;
  // Remove from local
  DB.usuarios=(DB.usuarios||[]).filter(x=>x.id!==uid);
  DB.usuariosExternos=(DB.usuariosExternos||[]).filter(x=>x.id!==uid);
  // Remove from Supabase row if external
  if(u._rowId){
    sbGet('tesorero_datos','usuario_id=eq.'+encodeURIComponent(u._rowId)).then(rows=>{
      if(!rows||!rows.length) return;
      const datos=rows[0].datos;
      datos.usuarios=(datos.usuarios||[]).filter(x=>x.id!==uid);
      sbFetch('/rest/v1/tesorero_datos?usuario_id=eq.'+encodeURIComponent(u._rowId),{
        method:'PATCH',
        headers:{'Prefer':'return=minimal'},
        body:JSON.stringify({datos, actualizado_en:new Date().toISOString()})
      });
    });
  }
  saveDB();
  const el=document.getElementById('lista-usuarios-admin');
  if(el) el.innerHTML=renderUsuariosAdmin();
  alert('✅ Cuenta eliminada correctamente.');
}

function activarVIPAdmin(uid){
  const u=(DB.usuarios||[]).find(x=>x.id===uid)||(DB.usuariosExternos||[]).find(x=>x.id===uid);
  if(!u){ alert('Usuario no encontrado.'); return; }
  if(!confirm('¿Activar plan VIP a '+(u.nombre||u.email)+'?\nEsto le dará acceso ilimitado sin vencimiento.')) return;
  if(!confirm('Segunda confirmación: ¿Confirmas activar VIP permanente para este usuario?')) return;
  u.planVIP=true; u.planAnual=false; u.planAnualHasta=null;
  const ext=(DB.usuariosExternos||[]).find(x=>x.id===uid);
  if(ext){ ext.planVIP=true; ext.planAnual=false; ext.planAnualHasta=null; }
  if(u._rowId){
    sbGet('tesorero_datos','usuario_id=eq.'+encodeURIComponent(u._rowId)).then(rows=>{
      if(!rows||!rows.length) return;
      const datos=rows[0].datos;
      const ui=(datos.usuarios||[]).findIndex(x=>x.id===uid);
      if(ui>=0){ datos.usuarios[ui].planVIP=true; datos.usuarios[ui].planAnual=false; datos.usuarios[ui].planAnualHasta=null; }
      sbFetch('/rest/v1/tesorero_datos?usuario_id=eq.'+encodeURIComponent(u._rowId),{
        method:'PATCH', headers:{'Prefer':'return=minimal'},
        body:JSON.stringify({datos, actualizado_en:new Date().toISOString()})
      });
    });
  }
  saveDB();
  syncUsuarioApp(u).catch(()=>{});
  alert('✅ Plan VIP activado para '+(u.nombre||u.email));
  const el=document.getElementById('lista-usuarios-admin');
  if(el) el.innerHTML=renderUsuariosAdmin();
}

async function syncUsuarioApp(u){
  // Mantener usuarios_app sincronizado cuando el owner cambia el plan
  try{
    await sbFetch('/rest/v1/usuarios_app?id=eq.'+encodeURIComponent(u.id),{
      method: 'PATCH',
      body: JSON.stringify({
        plan: u.planVIP?'vip':u.planAnual?'anual':'prueba',
        plan_hasta: u.planAnualHasta||null,
        plan_vip: u.planVIP||false,
        desactivado: u.desactivado||false,
        actualizado_en: new Date().toISOString()
      })
    });
  }catch(e){}
}

function activarPlanAdmin(uid, meses){
  const u=(DB.usuarios||[]).find(x=>x.id===uid)||(DB.usuariosExternos||[]).find(x=>x.id===uid);
  if(!u){ alert('Usuario no encontrado.'); return; }
  if(!confirm('¿Activar plan anual a '+(u.nombre||u.email)+'?\nSe extenderá 1 año desde hoy.')) return;
  if(!confirm('Segunda confirmación: ¿Confirmas activar el plan anual?')) return;
  const desde = u.planAnualHasta && new Date(u.planAnualHasta) > new Date()
    ? new Date(u.planAnualHasta) : new Date();
  desde.setMonth(desde.getMonth()+meses);
  u.planAnual=true;
  u.planAnualHasta=desde.toISOString().slice(0,10);
  // Agregar al historial de pagos
  if(!u.historialPagos) u.historialPagos=[];
  u.historialPagos.push({
    fecha: isoToday(),
    tipo: meses===12?'Anual':meses===6?'Semestral':'Mensual',
    meses,
    hasta: u.planAnualHasta,
    activadoPor: S.session?.email||'admin'
  });
  // Sync to Supabase if external user
  if(u._rowId){
    sbGet('tesorero_datos','usuario_id=eq.'+encodeURIComponent(u._rowId)).then(rows=>{
      if(!rows||!rows.length) return;
      const datos=rows[0].datos;
      const ui=(datos.usuarios||[]).findIndex(x=>x.id===uid);
      if(ui>=0){
        datos.usuarios[ui].planAnual=true;
        datos.usuarios[ui].planAnualHasta=u.planAnualHasta;
        datos.usuarios[ui].historialPagos=u.historialPagos;
      }
      sbFetch('/rest/v1/tesorero_datos?usuario_id=eq.'+encodeURIComponent(u._rowId),{
        method:'PATCH',
        headers:{'Prefer':'return=minimal'},
        body:JSON.stringify({datos, actualizado_en:new Date().toISOString()})
      });
    });
  }
  // Update in external list
  const ext=(DB.usuariosExternos||[]).find(x=>x.id===uid);
  if(ext){ ext.planAnual=true; ext.planAnualHasta=u.planAnualHasta; ext.historialPagos=u.historialPagos; }
  saveDB();
  // Sincronizar con usuarios_app
  syncUsuarioApp(u).catch(()=>{});
  alert('✅ Plan activado hasta el '+u.planAnualHasta);
  const el=document.getElementById('lista-usuarios-admin');
  if(el) el.innerHTML=renderUsuariosAdmin();
}

