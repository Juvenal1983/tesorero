// js/features/invitaciones.js — extraído de la copia de demostración.
function copyCodigo(){
  const cur=getCurso();
  navigator.clipboard?.writeText(cur.codigo||'').then(()=>alert('Código copiado: '+cur.codigo)).catch(()=>alert('Código: '+cur.codigo));
}
function regenCodigo(){
  if(!confirm('¿Regenerar el código? El anterior dejará de funcionar.')) return;
  const ci=(DB.cursos||[]).findIndex(c=>c.id===S.cursoId);
  if(ci>=0){ const rnd=Math.random().toString(36).slice(2,6).toUpperCase(); DB.cursos[ci].codigo=`${DB.cursos[ci].nombre.slice(0,2).toUpperCase().replace(/\s/,'')}${DB.cursos[ci].anio}-${rnd}`; }
  saveDB(); go('config');
}
// ─── CÓDIGOS DE INVITACIÓN ────────────────────────────────────────────
function generarCodigoNuevo(){
  const letras='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c='';
  for(let i=0;i<3;i++){
    for(let j=0;j<4;j++) c+=letras[Math.floor(Math.random()*letras.length)];
    if(i<2) c+='-';
  }
  return c; // formato: XXXX-XXXX-XXXX
}

function generarCodigoInvitacion(){
  if(!esOwner()){ alert('Sin permisos para generar códigos de invitación.'); return; }
  showModal('nuevoCodigoModal', {tipo:'prueba'});
}

async function generarLoteInvitaciones(n){
  if(!esOwner()){ alert('Sin permisos para generar códigos de invitación.'); return; }
  if(!DB.config) DB.config={};
  if(!DB.config.codigosInvitacion) DB.config.codigosInvitacion=[];

  for(let i=0;i<n;i++){
    const nuevo={
      codigo: generarCodigoNuevo(),
      tipo: 'prueba',
      activo: true,
      usado: false,
      creadoEn: isoToday(),
      usadoPor: null,
      usadoEn: null
    };

    DB.config.codigosInvitacion.unshift(nuevo);

    if(typeof sbSaveCode==='function'){
      await sbSaveCode(nuevo);
    }
  }

  saveDB();
  const lista=document.getElementById('lista-invitaciones');
  if(lista) lista.innerHTML=renderListaInvitaciones();
}

async function sbGetCodes(){
  try{
    const ownerId = S.session?.id || getUser()?.id || 'u1';
    // Traer TODOS los códigos sin filtrar por owner_id
    // ya que algunos códigos antiguos pueden tener owner_id diferente
    const res = await fetch(SUPA_URL+'/rest/v1/codigos_invitacion?select=codigo,tipo,activo,usado,usado_por,usado_en,creado_en,owner_id,vencimiento,entregado_a',{
      headers:{'apikey':SUPA_KEY,'Authorization':'Bearer '+(_authToken||SUPA_KEY)}
    });
    if(!res.ok) return [];
    const todos = await res.json();
    // Filtrar los que son del owner actual
    return todos.filter(r => r.owner_id === ownerId || r.owner_id === 'u1');
  }catch(e){ return []; }
}

let _lastSincCodigos = 0;
async function sincronizarCodigosDesdeSupabase(forzar=false){
  // Caché de 5 minutos — evita lecturas repetidas a Supabase
  const ahora = Date.now();
  if(!forzar && (ahora - _lastSincCodigos) < 5*60*1000) return;
  _lastSincCodigos = ahora;
  try{
    const rows = await sbGetCodes();
    if(!rows || !rows.length) return;
    if(!DB.config) DB.config={};
    const localCodigos = DB.config.codigosInvitacion || [];
    // Merge: Supabase + any local codes not yet synced
    const supabaseCodigos = rows.map(r => {
      const local = localCodigos.find(c=>c.codigo===r.codigo) || {};
      return {
        codigo:   r.codigo,
        tipo:     r.tipo || 'prueba',
        activo:   r.activo === true,
        usado:    r.usado === true,
        usadoPor: r.usado_por || null,
        usadoEn:  r.usado_en || null,
        creadoEn: r.creado_en || local.creadoEn || null,
        venceEl:  r.vencimiento ? r.vencimiento.slice(0,10) : local.venceEl || null,
        para:     local.para || r.entregado_a || null,
        notas:    local.notas || null,
      };
    });
    // Add local codes not yet in Supabase (just created)
    const supabaseCodes = new Set(rows.map(r=>r.codigo));
    const soloLocales = localCodigos.filter(c=>!supabaseCodes.has(c.codigo));
    DB.config.codigosInvitacion = [...soloLocales, ...supabaseCodigos];
    previewStorage.setItem(KEY, JSON.stringify(DB));
    // Re-renderizar la lista siempre
    const lista = document.getElementById('lista-invitaciones');
    if(lista) lista.innerHTML = renderListaInvitaciones();
    // No re-renderizar si el usuario está editando algún campo
    const editando = document.activeElement && ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName);
    if(!lista && S.route==='config' && !editando) renderPage();
  }catch(e){ console.log('Sync error:', e); }
}

function modalNuevoCodigo(data){
  const tipo = data?.tipo || 'prueba';
  const tipoLabel = tipo==='vip'?'⭐ VIP':tipo==='anual'?'💳 Plan Pro (1 año)':'🆓 Prueba (30 días)';
  const hoy = new Date();
  const defVence = new Date(hoy);
  defVence.setDate(defVence.getDate()+7); // 7 días para usar el código
  const defVenceStr = defVence.toISOString().slice(0,10);
  return `<div class="modal">
    <div class="modal-hdr">
      <div class="modal-title">Nuevo código ${tipoLabel}</div>
      <button class="close-btn" onclick="closeModal()">×</button>
    </div>
    <div class="fg">
      <label class="fl">¿Para quién es este código? <span style="color:var(--t3)">(opcional)</span></label>
      <input class="fi" id="cod-para" placeholder="Ej: Paula López, Tesorera 3°B">
    </div>
    <div class="fg">
      <label class="fl">¿Hasta cuándo puede usarse? <span style="color:var(--t3)">(opcional)</span></label>
      <input class="fi" id="cod-vence" type="date" value="${defVenceStr}">
      <div style="font-size:11px;color:var(--t3);margin-top:4px">Si no se usa antes de esta fecha, el código expirará automáticamente</div>
    </div>
    <div class="fg">
      <label class="fl">Notas <span style="color:var(--t3)">(opcional)</span></label>
      <input class="fi" id="cod-notas" placeholder="Ej: Colegio San Agustín, curso 4°A">
    </div>
    <div style="background:var(--bg);border-radius:8px;padding:10px 14px;font-size:13px;color:var(--t2);margin-bottom:8px">
      <strong>Tipo:</strong> ${tipoLabel}<br>
      <strong>Uso:</strong> Un solo uso — se desactiva al registrarse
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn bp" onclick="crearCodigoConDatos('${tipo}')">✅ Generar código</button>
    </div>
  </div>`;
}

async function crearCodigoConDatos(tipo){
  if(!esOwner()){ alert('Sin permisos.'); return; }
  if(!DB.config) DB.config={};
  if(!DB.config.codigosInvitacion) DB.config.codigosInvitacion=[];
  const para   = document.getElementById('cod-para')?.value.trim() || '';
  const vence  = document.getElementById('cod-vence')?.value || '';
  const notas  = document.getElementById('cod-notas')?.value.trim() || '';
  const chars  = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const seg    = ()=>{ let s=''; for(let i=0;i<4;i++) s+=chars[Math.floor(Math.random()*chars.length)]; return s; };
  const codigo = tipo==='anual' ? 'ANUAL-'+seg()+'-'+seg()
               : tipo==='vip'   ? 'VIP-'+seg()+'-'+seg()
               : generarCodigoNuevo();
  const nuevo  = { codigo, tipo, activo:true, usado:false, creadoEn:isoToday(), para, venceEl:vence, notas, usadoPor:null, usadoEn:null };
  DB.config.codigosInvitacion.unshift(nuevo);
  saveDB();
  if(typeof sbSaveCode==='function') await sbSaveCode(nuevo);
  closeModal();
  const lista = document.getElementById('lista-invitaciones');
  if(lista) lista.innerHTML = renderListaInvitaciones();
}

function renderListaInvitaciones(){
  const codigos=(DB.config?.codigosInvitacion||[]);
  if(!codigos.length) return `<div style="font-size:13px;color:var(--t3);text-align:center;padding:12px">Sin códigos generados aún. Presiona "+ Generar código" para crear uno.</div>`;
  const hoy = isoToday();
  // Auto-mark expired codes
  codigos.forEach(c=>{ if(c.venceEl && c.venceEl < hoy && !c.usado && c.activo) c.activo=false; });
  const disponibles=codigos.filter(c=>c.activo&&!c.usado).length;
  const usados=codigos.filter(c=>c.usado).length;
  const expirados=codigos.filter(c=>!c.activo&&!c.usado).length;
  return `
    <div style="display:flex;gap:12px;margin-bottom:12px;font-size:12px;color:var(--t3);flex-wrap:wrap">
      <span><strong style="color:var(--g)">${disponibles}</strong> disponibles</span>
      <span><strong style="color:var(--t3)">${usados}</strong> usados</span>
      ${expirados?`<span><strong style="color:var(--r)">${expirados}</strong> expirados</span>`:''}
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;max-height:520px;overflow-y:auto;padding-right:4px">
      ${codigos.map((c,i)=>{
        const vencido = c.venceEl && c.venceEl < hoy && !c.usado;
        const diasParaVencer = c.venceEl && !c.usado && c.activo
          ? Math.ceil((new Date(c.venceEl)-new Date())/(1000*60*60*24)) : null;
        const borde = c.usado?'var(--brd)':vencido?'#FCA5A5':c.activo?'var(--brd)':'#FCA5A5';
        const tipoBadge = c.tipo==='vip'?'⭐ VIP':c.tipo==='anual'?'💳 1 año':'🆓 30 días';
        const tipoBg = c.tipo==='vip'?'#FFF8E7':c.tipo==='anual'?'#EFF6FF':'var(--gl)';
        const tipoColor = c.tipo==='vip'?'#B8860B':c.tipo==='anual'?'#2563EB':'var(--g)';
        return `<div style="padding:12px 14px;border:1px solid ${borde};border-radius:10px;background:${c.usado||vencido?'var(--bg)':'var(--wh)'}">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
            <code style="font-size:13px;font-weight:700;letter-spacing:1.5px;color:${c.usado||vencido?'var(--t3)':c.activo?'var(--g)':'var(--r)'}">${c.codigo}</code>
            ${!c.usado?`<span style="font-size:10px;padding:2px 7px;border-radius:8px;font-weight:700;background:${tipoBg};color:${tipoColor}">${tipoBadge}</span>`:''}
            ${c.usado?'<span style="font-size:10px;padding:2px 8px;border-radius:8px;font-weight:700;background:#F0FDF4;color:#15803D">✅ Usado</span>':vencido?'<span style="font-size:10px;padding:2px 8px;border-radius:8px;font-weight:700;background:#FEF2F2;color:#DC2626">⏰ Expirado</span>':diasParaVencer!==null&&diasParaVencer<=3?`<span style="font-size:10px;padding:2px 8px;border-radius:8px;font-weight:700;background:#FEF3C7;color:#D97706">⚠️ Vence en ${diasParaVencer}d</span>`:'<span style="font-size:10px;padding:2px 8px;border-radius:8px;font-weight:700;background:#F0FDF4;color:#15803D">🟢 Disponible</span>'}
          </div>
          ${c.usado&&c.usadoPor?`<div style="font-size:12px;background:#F0FDF4;border-radius:8px;padding:7px 12px;color:#15803D;margin-bottom:6px">
            👤 Registrado por <strong>${escHtml(c.usadoPor)}</strong>${c.usadoEn?' · '+c.usadoEn:''}
          </div>`:''}
          ${c.para?`<div style="font-size:12px;color:var(--t2);margin-bottom:4px">Para: <strong>${escHtml(c.para)}</strong></div>`:''}
          ${c.notas?`<div style="font-size:11px;color:var(--t3);margin-bottom:4px">📝 ${escHtml(c.notas)}</div>`:''}
          <div style="font-size:11px;color:var(--t3);display:flex;gap:10px;flex-wrap:wrap">
            <span>Creado: ${c.creadoEn||'—'}</span>
            ${c.venceEl&&!c.usado?`<span>Expira: ${c.venceEl}</span>`:''}
          </div>
          <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
            ${!c.usado&&c.activo?`
              <button class="btn bs" onclick="copiarCodigoInv('${c.codigo}')" style="font-size:12px">📋 Copiar</button>
              <button class="btn bs" onclick="compartirCodigoInv('${c.codigo}')" style="font-size:12px">↗ Compartir</button>
              <button class="btn bs bd" onclick="desactivarCodigoPorCodigo('${c.codigo}')" style="font-size:12px">✕ Desactivar</button>
            `:''}
            <button class="btn bs bd" onclick="eliminarCodigoPorCodigo('${c.codigo}')" title="Eliminar definitivamente" style="font-size:12px;background:#FFF0F0">🗑 Eliminar</button>
          </div>
        </div>`;
      }).join('')}
    </div>`;
}

function copiarCodigoInv(codigo){
  navigator.clipboard?.writeText(codigo)
    .then(()=>{ const btn=event.currentTarget; const t=btn.textContent; btn.textContent='✓'; setTimeout(()=>btn.textContent=t,1500); })
    .catch(()=>alert('Código: '+codigo));
}

function compartirCodigoInv(codigo){
  const url = getAppUrl()||window.location.href;
  const msg='Hola 👋 Te invito a usar *Tesorero*, la app para administrar las finanzas del curso.\n\n'+
    '📲 *Pasos para crear tu cuenta:*\n\n'+
    '1️⃣ Abre la app:\n'+url+'\n\n'+
    '2️⃣ Toca *"Crear cuenta"*\n\n'+
    '3️⃣ Ingresa este código de invitación:\n'+
    '*『 '+codigo+' 』*\n\n'+
    '⚠️ Este código es de un solo uso — úsalo tú.';
  if(navigator.share){
    navigator.share({title:'Invitación a Tesorero', text:msg}).catch(()=>{});
  } else if(navigator.clipboard){
    navigator.clipboard.writeText(msg).then(()=>alert('Mensaje copiado al portapapeles. Pégalo en WhatsApp o donde prefieras.'));
  } else {
    alert(msg);
  }
}

function desactivarCodigoInv(idx){
  if(!confirm('¿Desactivar este código? Ya no podrá usarse para registrarse.')) return;
  if(DB.config?.codigosInvitacion?.[idx]) DB.config.codigosInvitacion[idx].activo=false;
  saveDB();
  const lista=document.getElementById('lista-invitaciones');
  if(lista) lista.innerHTML=renderListaInvitaciones();
}

async function eliminarCodigoPorCodigo(codigo){
  if(!confirm('¿Eliminar el código ' + codigo + '? Esta acción no se puede deshacer.')) return;
  if(!confirm('Segunda confirmación: ¿Confirmas eliminar definitivamente este código?')) return;
  // Eliminar de Supabase
  try{
    await sbFetch('/rest/v1/codigos_invitacion?codigo=eq.'+encodeURIComponent(codigo),{
      method:'DELETE'
    });
  }catch(e){}
  // Eliminar de previewStorage
  if(DB.config?.codigosInvitacion){
    DB.config.codigosInvitacion = DB.config.codigosInvitacion.filter(x=>x.codigo!==codigo);
  }
  saveDB();
  showToast('Código eliminado');
  await sincronizarCodigosDesdeSupabase();
}

async function desactivarCodigoPorCodigo(codigo){
  if(!confirm('¿Desactivar el código ' + codigo + '? Ya no podrá usarse.')) return;
  // Actualizar en Supabase
  try{
    await sbFetch('/rest/v1/codigos_invitacion?codigo=eq.'+encodeURIComponent(codigo),{
      method:'PATCH', headers:{'Prefer':'return=minimal'},
      body:JSON.stringify({activo:false})
    });
  }catch(e){}
  // Actualizar localmente
  const c = (DB.config?.codigosInvitacion||[]).find(x=>x.codigo===codigo);
  if(c) c.activo=false;
  saveDB();
  await sincronizarCodigosDesdeSupabase();
}

// ─── CÓDIGO VIP ───────────────────────────────
function configurarTelAdmin(){
  const actual = DB.config?.telAdmin || '';
  const nuevo = prompt('Ingresa tu número de WhatsApp para recibir solicitudes:\n(formato: 56912345678)', actual);
  if(nuevo===null) return;
  if(!DB.config) DB.config={};
  DB.config.telAdmin = nuevo.replace(/\D/g,'');
  saveDB();
  const el=document.getElementById('config-tu-tel');
  if(el) el.textContent=DB.config.telAdmin||'⚙️ Configurar';
  alert('✅ Número guardado correctamente.');
}

function mostrarSolicitudCodigo(){
  const panel=document.getElementById('panel-solicitud-codigo');
  if(panel) panel.style.display = panel.style.display==='none' ? '' : 'none';
}

function enviarSolicitudCodigo(){
  const nombre=document.getElementById('sol-nombre')?.value.trim();
  const email=document.getElementById('sol-email')?.value.trim();
  const colegio=document.getElementById('sol-colegio')?.value.trim();
  const msg=document.getElementById('sol-msg');
  if(!nombre||!email||!colegio){
    if(msg){ msg.innerHTML='<div class="alert ar">Completa todos los campos.</div>'; msg.style.display=''; }
    return;
  }
  // Enviar solicitud por WhatsApp al administrador
  const tuTel=(DB.config?.telAdmin||'56984699924').replace(/\D/g,'');
  const appUrl=DB.config?.appUrl||'https://eltesorero.cl';
  const texto=
    '🔑 *Solicitud de código Tesorero*\n\n'+
    '👤 Nombre: '+nombre+'\n'+
    '📧 Correo: '+email+'\n'+
    '🏫 Colegio: '+colegio+'\n\n'+
    'Solicita acceso a la app: '+appUrl;
  window.open('https://wa.me/'+tuTel+'?text='+encodeURIComponent(texto),'_blank','noopener');
  if(msg){
    msg.innerHTML='<div class="alert ag">✅ Solicitud enviada. El administrador te contactará pronto con tu código.</div>';
    msg.style.display='';
  }
}

function generarCodigoVIP(){
  if(!esOwner()){ alert('Sin permisos.'); return; }
  showModal('nuevoCodigoModal', {tipo:'vip'});
}

function generarCodigoAnual(){
  if(!esOwner()){ alert('Sin permisos.'); return; }
  showModal('nuevoCodigoModal', {tipo:'anual'});
}

// ─── SISTEMA DE PRUEBA 30 DÍAS Y SUSCRIPCIÓN ───
async function verificarSuscripcion(){
  if(!S.session || S.session.rol==='apoderado_lector') return;
  const u=(DB.usuarios||[]).find(x=>x.id===S.session.id);
  if(!u) return;
  if(!u.invitado) return; // owner nunca verifica

  // Consultar estado real desde usuarios_app en Supabase
  // Esto garantiza que los cambios de plan se reflejen inmediatamente
  try{
    const res = await sbFetch('/rest/v1/usuarios_app?id=eq.'+encodeURIComponent(u.id)+'&select=plan,plan_hasta,plan_vip,desactivado');
    if(res.ok){
      const rows = await res.json();
      if(rows && rows.length > 0){
        const uApp = rows[0];
        // Sincronizar estado local con Supabase
        u.planVIP     = uApp.plan_vip;
        u.planAnual   = uApp.plan === 'anual';
        u.planAnualHasta = uApp.plan_hasta;
        u.desactivado = uApp.desactivado;
        // Si está desactivado bloquearlo
        if(uApp.desactivado){
          mostrarBannerVencimiento(0, true, 'desactivado');
          return;
        }
        // Si tiene plan VIP no verificar
        if(uApp.plan_vip) return;
        // Si tiene plan anual verificar fecha
        if(uApp.plan === 'anual' && uApp.plan_hasta){
          const vence = new Date(uApp.plan_hasta);
          const hoy = new Date(); hoy.setHours(0,0,0,0);
          const diasRestantes = Math.ceil((vence-hoy)/(1000*60*60*24));
          if(diasRestantes > 0){
            if(diasRestantes<=3) mostrarBannerVencimiento(diasRestantes, false, 'anual', 'urgente');
            else if(diasRestantes<=7) mostrarBannerVencimiento(diasRestantes, false, 'anual', 'aviso');
            return;
          } else {
            mostrarBannerVencimiento(0, true, 'anual');
            return;
          }
        }
        // Plan prueba — calcular desde fecha_registro
        if(uApp.plan === 'prueba'){
          const reg = new Date(u.fechaRegistro || uApp.fecha_registro);
          const hoy = new Date(); hoy.setHours(0,0,0,0);
          const diasRestantes = 30 - Math.ceil((hoy-reg)/(1000*60*60*24));
          if(diasRestantes<=3 && diasRestantes>0) mostrarBannerVencimiento(diasRestantes, false, 'prueba', 'urgente');
          else if(diasRestantes<=7 && diasRestantes>0) mostrarBannerVencimiento(diasRestantes, false, 'prueba', 'aviso');
          else if(diasRestantes<=0) mostrarBannerVencimiento(0, true, 'prueba');
        }
        return;
      }
    }
  }catch(e){}

  // Fallback: usar datos locales si Supabase no responde
  if(u.planVIP) return;
  const fechaVence = u.planAnualHasta || u.planVence;
  if(u.planAnual || u.planActivo){
    if(fechaVence){
      const vence=new Date(fechaVence);
      const hoy=new Date(); hoy.setHours(0,0,0,0);
      const diasRestantes=Math.ceil((vence-hoy)/(1000*60*60*24));
      if(diasRestantes>0){
        if(diasRestantes<=3) mostrarBannerVencimiento(diasRestantes, false, 'anual', 'urgente');
        else if(diasRestantes<=7) mostrarBannerVencimiento(diasRestantes, false, 'anual', 'aviso');
        return;
      } else {
        mostrarBannerVencimiento(0, true, 'anual');
        return;
      }
    }
    return;
  }
  if(!u.fechaRegistro) return;
  const registro=new Date(u.fechaRegistro);
  const hoy=new Date(); hoy.setHours(0,0,0,0);
  const diasRestantes=30-Math.ceil((hoy-registro)/(1000*60*60*24));
  if(diasRestantes<=3 && diasRestantes>0) mostrarBannerVencimiento(diasRestantes, false, 'prueba', 'urgente');
  else if(diasRestantes<=7 && diasRestantes>0) mostrarBannerVencimiento(diasRestantes, false, 'prueba', 'aviso');
  else if(diasRestantes<=0) mostrarBannerVencimiento(0, true, 'prueba');
}

function mostrarBannerVencimiento(dias, vencido, tipoPlan, nivel){
  if(document.getElementById('banner-vencimiento')) return;
  const b=document.createElement('div');
  b.id='banner-vencimiento';
  if(vencido){
    b.style.cssText='position:fixed;top:0;left:0;right:0;bottom:0;z-index:99998;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;padding:16px';
    b.innerHTML=`
      <div style="background:#fff;border-radius:20px;padding:28px 24px;max-width:420px;width:100%;text-align:center">
        <div style="font-size:48px;margin-bottom:12px">⏰</div>
        <div style="font-size:20px;font-weight:800;color:#1a1a1a;margin-bottom:8px">${tipoPlan==="anual"?'Tu plan anual ha vencido':'Tu período de prueba terminó'}</div>
        <div style="font-size:14px;color:#666;margin-bottom:20px;line-height:1.6">
          Para seguir usando Tesorero y mantener todos tus datos, activa tu plan anual.
        </div>
        <div style="background:#E1F5EE;border-radius:12px;padding:16px;margin-bottom:20px">
          <div style="font-size:28px;font-weight:900;color:#0F6E56">$10.990 CLP</div>
          <div style="font-size:13px;color:#1D9E75;font-weight:600">por año · acceso completo</div>
          <div style="font-size:12px;color:#666;margin-top:6px">${V('miembros')} ilimitados · Todos los ${V('grupos').toLowerCase()} · Sin restricciones</div>
        </div>
        <button onclick="solicitarActivacion()" style="width:100%;background:#0F6E56;color:#fff;border:none;border-radius:12px;padding:14px;font-size:16px;font-weight:700;cursor:pointer;margin-bottom:10px">
          💳 Activar plan anual — $10.990
        </button>
        <div style="font-size:11px;color:#999">¿Tienes un código de activación? 
          <span style="color:#0F6E56;cursor:pointer;font-weight:600" onclick="ingresarCodigoActivacion()">Ingrésalo aquí</span>
        </div>
      </div>`;
  } else {
    const borderColor = nivel==='urgente' ? '#E24B4A' : '#EF9F27';
    const emoji = nivel==='urgente' ? '🚨' : '⚠️';
    const titulo = (tipoPlan==='anual'?'Tu plan anual vence en ':'Tu prueba vence en ') + dias + ' día' + (dias!==1?'s':'');
    b.style.cssText='position:fixed;bottom:70px;left:12px;right:12px;z-index:9997;background:#fff;border:2px solid '+borderColor+';border-radius:14px;padding:14px 16px;box-shadow:0 4px 20px rgba(0,0,0,0.15);display:flex;align-items:center;gap:12px;max-width:480px;margin:0 auto';
    b.innerHTML=`
      <div style="font-size:24px">${emoji}</div>
      <div style="flex:1">
        <div style="font-weight:700;font-size:13px;color:#1a1a1a">${titulo}</div>
        <div style="font-size:12px;color:#666;margin-top:2px">${nivel==='urgente'?'⏰ Quedan muy pocos días. Activa tu plan para no perder tus datos.':'Activa tu plan anual por $10.990 para continuar sin interrupciones.'}</div>
      </div>
      <div style="display:flex;gap:6px">
        <button onclick="solicitarActivacion()" style="background:#0F6E56;border:none;color:#fff;padding:7px 12px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer">Activar</button>
        <button onclick="document.getElementById('banner-vencimiento').remove()" style="background:none;border:1px solid #ddd;color:#999;padding:7px 10px;border-radius:8px;font-size:12px;cursor:pointer">✕</button>
      </div>`;
  }
  document.body.appendChild(b);
}

function solicitarActivacion(){
  const tel=(DB.config?.telAdmin||'56984699924').replace(/\D/g,'');
  const msg='Hola! Me gustaría activar el plan anual de Tesorero App ($14.990 CLP).\n\nMi correo es: '+(S.session?.email||'');
  window.open('https://wa.me/'+tel+'?text='+encodeURIComponent(msg),'_blank','noopener');
}

function ingresarCodigoActivacion(){
  const codigo=prompt('Ingresa tu código de activación:');
  if(!codigo) return;
  aplicarCodigoActivacion(codigo.trim().toUpperCase());
}

function aplicarCodigoActivacion(codigo){
  // Buscar el código en la base de datos
  const codigos=DB.config?.codigosInvitacion||[];
  const cObj=codigos.find(c=>c.codigo===codigo&&c.activo&&!c.usado);
  if(!cObj){ alert('Código inválido o ya utilizado.'); return; }
  const u=(DB.usuarios||[]).find(x=>x.id===S.session?.id);
  if(!u){ alert('No se encontró tu cuenta.'); return; }
  const ci=codigos.findIndex(c=>c.codigo===codigo);
  // Marcar código como usado
  DB.config.codigosInvitacion[ci].usado=true;
  DB.config.codigosInvitacion[ci].usadoPor=u.email;
  DB.config.codigosInvitacion[ci].usadoEn=isoToday();
  if(cObj.tipo==='vip'){
    // VIP: acceso ilimitado
    u.planVIP=true;
    u.planActivo=true;
    u.planVence=null;
    alert('🎉 ¡Código VIP activado! Tienes acceso ilimitado a Tesorero.');
  } else {
    // Plan anual: 365 días
    const vence=new Date();
    vence.setFullYear(vence.getFullYear()+1);
    u.planActivo=true;
    u.planVence=vence.toISOString().slice(0,10);
    alert('✅ ¡Plan activado! Tu acceso es válido hasta el '+fmtDate(u.planVence)+'.');
  }
  saveDB();
  const banner=document.getElementById('banner-vencimiento');
  if(banner) banner.remove();
}

