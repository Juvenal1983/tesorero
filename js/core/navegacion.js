// js/core/navegacion.js — extraído de la copia de demostración.
function go(route, params={}){
  const mismaRuta = S.route === route;
  S.route = route; S.params = params; S.modal = null;
  render();
  // Solo sube al inicio si cambia de sección — no si se queda en la misma
  if(!mismaRuta) window.scrollTo && window.scrollTo(0,0);
}
function showModal(type, data={}){ S.modal = {type, data}; render(); }
function closeModal(){ S.modal = null; render(); }

/** Recarga solo el contenido principal sin reconstruir el shell.
    Preserva el foco en el input activo. */
function renderPage(){
  killCharts();
  const mc = document.getElementById('main-content');
  if(!mc){ render(); return; }
  // Guardar id del elemento con foco y su posición de cursor
  const focusId = document.activeElement?.id;
  const focusSel = document.activeElement?.selectionStart;
  mc.innerHTML = renderRoute();
  afterRender();
  // Restaurar foco
  if(focusId){
    const el = document.getElementById(focusId);
    if(el){ el.focus(); try{ el.setSelectionRange(focusSel, focusSel); }catch(e){} }
  }
}

// ─────────────────────────────────────────────
// RENDER PRINCIPAL
// ─────────────────────────────────────────────
let _charts = {};
function killCharts(){ Object.values(_charts).forEach(c=>{try{c.destroy();}catch(e){}}); _charts={}; }

function render(){
  killCharts();
  // Siempre eliminar overlay de modal previo (puede quedar huérfano en el body)
  const existingOv = document.getElementById('modal-ov');
  if(existingOv) existingOv.remove();
  const app = document.getElementById('app');
  // Mostrar badge solo en login, ocultarlo cuando el usuario está dentro

  if(!S.session){ app.innerHTML = renderLogin(); bindLogin(); return; }
  if(S.route==='selector'){ app.innerHTML = renderSelector(); bindSelector(); return; }
  app.innerHTML = renderShell();
  bindNav();
  const mc = document.getElementById('main-content');
  if(mc) mc.innerHTML = renderRoute();
  if(S.modal) renderModalOverlay();
  afterRender();
  // Verificar suscripción después de renderizar
  if(S.session && S.session.rol!=='apoderado_lector'){
    setTimeout(verificarSuscripcion, 1000);
    setTimeout(verificarFechaEspecial, 1500);
  }
}

function renderShell(){
  const cur = getCurso();
  const usr = S.session;
  const isLector = usr.rol === 'apoderado_lector';
  const navItems = isLector ? [
    {r:'dashboard',icon:'📊',label:'Resumen'},
    {r:'movimientos',icon:'💸',label:'Movimientos'},
    {r:'reportes',icon:'📄',label:'Reportes'},
    {r:'mis-datos',icon:'👤',label:'Mis datos'}
  ] : [
    {r:'dashboard',icon:'📊',label:'Resumen'},
    {r:'alumnos',icon:'👥',label:V('miembros')},
    {r:'cuotas',icon:'💳',label:'Cuotas'},
    {r:'pagos',icon:'✅',label:'Pagos'},
    {r:'movimientos',icon:'💸',label:'Movimientos'},
    ...(isFondoEspecialActivo()?[
        {r:'fondo-especial',icon:'🎓',label:getFondoEspecialConfig().nombre}
    ]:[]),
    {r:'cobranza',icon:'💬',label:'Cobranza'},
    {r:'reportes',icon:'📄',label:'Reportes'},
    {r:'notas',icon:'📓',label:'Libreta'},
    {r:'config',icon:'⚙️',label:'Configuración'}
  ];
  const navHtml = navItems.map(n=>`<div class="nav-item${S.route===n.r?' active':''}" onclick="go('${n.r}')"><span class="nav-icon">${n.icon}</span>${n.label}</div>`).join('');
  // Bottom nav: primeros 4 + botón "Más" que despliega el resto
  const bnPrimary = navItems.slice(0, 4);
  const bnExtra   = navItems.slice(4);
  const masActivo = bnExtra.some(n=>n.r===S.route);
  const bnHtml = [
    ...bnPrimary.map(n=>`<div class="bn-item${S.route===n.r?' active':''}" onclick="go('${n.r}')"><div class="bn-icon">${n.icon}</div>${n.label}</div>`),
    bnExtra.length ? `
      <div class="bn-item${masActivo?' active':''}" onclick="toggleMasMenu()" id="bn-mas">
        <div class="bn-icon">☰</div>Más
      </div>` : ''
  ].join('');
  const masMenuHtml = bnExtra.length ? `
    <div id="mas-menu" style="display:none;position:fixed;bottom:calc(60px + env(safe-area-inset-bottom));right:0;left:0;background:var(--wh);border-top:1px solid var(--brd);z-index:99;box-shadow:0 -4px 20px rgba(0,0,0,.08);max-height:70vh;overflow-y:auto">
      ${bnExtra.map(n=>`
        <div onclick="go('${n.r}');closeMasMenu()" style="display:flex;align-items:center;gap:14px;padding:14px 22px;cursor:pointer;font-size:15px;border-bottom:1px solid #f0efea;color:${S.route===n.r?'var(--g)':'var(--t1)'};font-weight:${S.route===n.r?'700':'400'}">
          <span style="font-size:20px">${n.icon}</span>${n.label}
          ${S.route===n.r?'<span style="margin-left:auto;color:var(--g)">●</span>':''}
        </div>`).join('')}
      ${!isLector ? `
        <div style="padding:10px 22px 4px;font-size:10px;font-weight:700;color:var(--t3);text-transform:uppercase;letter-spacing:.8px">Mis cursos</div>
        ${(DB.cursos||[]).filter(c=>(usr.cursoIds||[]).includes(c.id)).map(c=>{
          const col=(DB.colegios||[]).find(x=>x.id===c.colegioId);
          const esActivo=c.id===S.cursoId;
          return `<div onclick="selectCurso('${c.id}');closeMasMenu()"
            style="display:flex;align-items:center;gap:14px;padding:12px 22px;cursor:pointer;border-bottom:1px solid #f0efea;background:${esActivo?'var(--gl)':'var(--wh)'}">
            <span style="font-size:18px">🏫</span>
            <div>
              <div style="font-size:14px;font-weight:${esActivo?'700':'400'};color:${esActivo?'var(--g)':'var(--t1)'}">${escHtml(c.nombre)}</div>
              <div style="font-size:11px;color:var(--t3)">${escHtml(col?.nombre||'')} · ${c.anio}</div>
            </div>
            ${esActivo?'<span style="margin-left:auto;color:var(--gm)">●</span>':''}
          </div>`;
        }).join('')}
        <div onclick="showModal('addCursoModal');closeMasMenu()"
          style="display:flex;align-items:center;gap:14px;padding:12px 22px;cursor:pointer;border-bottom:1px solid #f0efea;color:var(--gm)">
          <span style="font-size:18px">➕</span>
          <div style="font-size:14px;font-weight:600">Agregar ${V('grupo').toLowerCase()}</div>
        </div>` : ''}
      <div onclick="${isLector?'logoutLector':'logout'}();closeMasMenu()"
        style="display:flex;align-items:center;gap:14px;padding:14px 22px;cursor:pointer;color:var(--r);font-weight:600;border-top:2px solid var(--brd);margin-top:4px">
        <span style="font-size:20px">↩</span>
        <div style="font-size:15px">Cerrar sesión</div>
      </div>
    </div>
    <div id="mas-overlay" onclick="closeMasMenu()" style="display:none;position:fixed;inset:0;z-index:98"></div>` : '';
  const routeLabels = {dashboard:'Dashboard',alumnos:V('miembros'),cuotas:'Cuotas',pagos:'Pagos',movimientos:'Ingresos y Gastos',reportes:'Reportes',config:'Configuración'};
  return `
  <div class="app">
    <div class="sidebar">
      <div class="sidebar-header">
        <div class="s-logo" style="position:relative">
  ${(()=>{
    const m=new Date().getMonth()+1;
    if(m===9) return '<span style="font-size:18px">🇨🇱</span>';
    if(m===12) return '<span style="position:relative;display:inline-block"><span style="position:absolute;top:-10px;left:-2px;font-size:12px">🎅</span><div class="s-logo-icon">💰</div></span>';
    return '<div class="s-logo-icon">💰</div>';
  })()}
  ${(()=>{ const m=new Date().getMonth()+1; return m===9?'<span style="color:#fff">T</span><span style="color:#D60000">esorero</span>':(m===12?'<span style="color:#ff6b6b">T</span>esorero':'Tesorero'); })()}
</div>
        <div class="s-curso">${escHtml(cur.nombre||'')} · ${cur.anio||''}</div>
      </div>
      <div class="nav" id="sidebar-nav">
        <div class="nav-section">Menú</div>
        ${navHtml}
        ${!isLector ? `
        <div class="nav-section" style="margin-top:10px">Mis cursos</div>
        ${(DB.cursos||[]).filter(c=>(usr.cursoIds||[]).includes(c.id)).map(c=>{
          const col=(DB.colegios||[]).find(x=>x.id===c.colegioId);
          const esActivo=c.id===S.cursoId;
          return `<div class="nav-item${esActivo?' active':''}" onclick="selectCurso('${c.id}')" title="${escHtml(col?.nombre||'')} · ${c.anio}">
            <span class="nav-icon">🏫</span>
            <div style="min-width:0">
              <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12.5px">${escHtml(c.nombre)}</div>
              <div style="font-size:10px;color:var(--t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(col?.nombre||'')} · ${c.anio}</div>
            </div>
            ${esActivo?'<span style="margin-left:auto;font-size:10px;color:var(--gm)">●</span>':''}
          </div>`;
        }).join('')}
        <div class="nav-item" onclick="showModal('addCursoModal')" style="color:var(--gm);border:1px dashed var(--gm);margin-top:4px;border-radius:8px;font-size:12.5px">
          <span class="nav-icon" style="font-size:13px">＋</span>Agregar ${V('grupo').toLowerCase()}
        </div>` : ''}
      </div>
      <div class="sidebar-footer">
        <div class="user-row">
          <div class="avatar">${initials(usr.nombre)}</div>
          <div><div class="user-name">${escHtml(usr.nombre)}</div><div class="user-role">${isLector?'Apoderado lector':usr.rol==='superadmin'?'Superadmin':'Tesorero'}</div></div>
          <button class="btn bs" onclick="logout()" style="margin-left:auto;padding:4px 8px;font-size:11px" title="Salir">↩</button>
        </div>
      </div>
    </div>
    <div class="main">
      <div class="topbar">
        <div class="topbar-title">${routeLabels[S.route]||''}</div>
        <div class="topbar-right">
          ${isLector?'<span class="badge bgt">Solo lectura</span>':''}
          ${isLector?'<button onclick="logoutLector()" style="background:var(--r);border:none;border-radius:8px;padding:7px 14px;font-size:13px;font-weight:700;color:#fff;cursor:pointer;display:flex;align-items:center;gap:6px;box-shadow:0 2px 8px rgba(226,75,74,0.3)">↩ Salir</button>':''}
          <span class="badge bgg" style="display:none" id="install-badge" onclick="doInstall()" style="cursor:pointer">📲 Instalar app</span>
        </div>
      </div>
      <div class="content" id="main-content"></div>
    </div>
  </div>
  <div class="bottom-nav" id="bottom-nav-wrap"><div class="bn-inner" id="bottom-nav-inner">${bnHtml}</div></div>
  ${masMenuHtml}`;
}

// ─────────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────────
