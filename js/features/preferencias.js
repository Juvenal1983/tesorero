// js/features/preferencias.js — extraído de la copia de demostración.
function verificarFechaEspecial(){
  const hoy = new Date();
  const dia = hoy.getDate();
  const mes = hoy.getMonth() + 1; // 1-12
  const claveHoy = 'tesorero_saludo_' + dia + '_' + mes;
  if(previewStorage.getItem(claveHoy)) return; // Ya se mostró hoy

  const fechas = [
    { mes:1,  dia:1,  emoji:'🎆', titulo:'¡Feliz Año Nuevo!',
      msg:'Que este nuevo año traiga muchas alegrías, salud y éxito para toda la comunidad del curso. ¡Bienvenidos al nuevo año!' },
    { mes:5,  dia:1,  emoji:'🛠️', titulo:'¡Feliz Día del Trabajador!',
      msg:'Un merecido reconocimiento a todos quienes con esfuerzo y dedicación construyen cada día una mejor comunidad. ¡Feliz 1° de Mayo!' },
    { mes:9,  dia:18, emoji:'🎉', titulo:'¡Felices Fiestas Patrias!',
      msg:'¡Viva Chile! Que este 18 de septiembre esté lleno de alegría, chilenidad y buenos momentos en familia. ¡Felices Fiestas Patrias!' },

    { mes:12, dia:24, emoji:'🎄', titulo:'¡Feliz Nochebuena!',
      msg:'En esta noche especial, les deseamos a todos una Nochebuena llena de amor, paz y buenos momentos junto a quienes más quieren. ¡Feliz Navidad!' },
    { mes:12, dia:25, emoji:'🎄', titulo:'¡Feliz Navidad!',
      msg:'Que la magia de esta Navidad llene sus hogares de alegría, unión y esperanza. ¡Feliz Navidad de parte de todo el equipo de Tesorero!' },
    { mes:12, dia:31, emoji:'🎆', titulo:'¡Feliz despedida de año!',
      msg:'Cerramos este año con gratitud por todo lo compartido. ¡Que el año que viene traiga aún más logros para el curso! ¡Feliz Año Nuevo!' },
  ];

  const fecha = fechas.find(f => f.mes === mes && f.dia === dia);
  if(!fecha) return;

  previewStorage.setItem(claveHoy, '1');

  const overlay = document.createElement('div');
  overlay.id = 'modal-fecha-especial';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:99997;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:20px';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:24px;padding:32px 24px;max-width:380px;width:100%;text-align:center;animation:fadeIn .3s ease">
      <div style="font-size:64px;margin-bottom:12px;line-height:1">${fecha.emoji}</div>
      <div style="font-size:22px;font-weight:800;color:#1a1a1a;margin-bottom:12px;line-height:1.3">${fecha.titulo}</div>
      <div style="font-size:14px;color:#555;line-height:1.7;margin-bottom:24px">${fecha.msg}</div>
      <div style="font-size:12px;color:#1D9E75;font-weight:600;margin-bottom:20px">${V('icono')} ${V('nombre')} · El Tesorero 💰</div>
      <button onclick="document.getElementById('modal-fecha-especial').remove()"
        style="background:#1D9E75;border:none;color:#fff;padding:13px 32px;border-radius:14px;font-size:15px;font-weight:700;cursor:pointer;width:100%">
        ¡Gracias! 🎉
      </button>
    </div>`;
  document.body.appendChild(overlay);
}


// ─── DECORACIONES ESTACIONALES ────────────────────────────────────────────────
function getLogoEstacional(){
  const mes = new Date().getMonth() + 1;
  if(mes === 9){
    // Septiembre: banderita chilena antes del logo
    return '<span style="font-size:22px;margin-right:4px" title="¡Viva Chile!">🇨🇱</span>💰 Tesorero<span style="font-size:16px;margin-left:4px">🇨🇱</span>';
  }
  if(mes === 12){
    // Diciembre: gorrito de navidad sobre la T
    return '<span style="position:relative;display:inline-block;margin-right:1px"><span style="position:absolute;top:-14px;left:-4px;font-size:16px;line-height:1">🎅</span>T</span>esorero';
  }
  return '💰 Tesorero';
}

function getBannerEstacional(){
  const mes = new Date().getMonth() + 1;
  if(mes === 9){
    return '<div style="text-align:center;font-size:13px;color:#D60000;font-weight:700;letter-spacing:1px;margin-bottom:8px;margin-top:-8px">🇨🇱 ¡Viva Chile! · Septiembre Patrio 🇨🇱</div>';
  }
  if(mes === 12){
    return '<div style="text-align:center;font-size:13px;color:#1D9E75;font-weight:700;letter-spacing:0.5px;margin-bottom:8px;margin-top:-8px">🎄 ¡Felices Fiestas! 🎅</div>';
  }
  return '';
}


function copiarCodigoCompartido(){
  const cc = getCurso()?.codigoCompartido;
  if(cc) navigator.clipboard?.writeText(cc).then(()=>showToast('¡Copiado!'));
}

function generarCodigoCompartido(){
  if(!puedeConfigurar()){ showToast('⛔ Sin permisos para gestionar códigos de acceso','#E24B4A'); return; }
  if(!confirm('¿Generar código de acceso compartido? Quien lo tenga verá TODA la información del curso.')) return;
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const seg = ()=>{ let s=''; for(let i=0;i<4;i++) s+=chars[Math.floor(Math.random()*chars.length)]; return s; };
  const codigo = 'CC-'+seg()+'-'+seg();
  const ci = (DB.cursos||[]).findIndex(c=>c.id===S.cursoId);
  if(ci>=0){
    DB.cursos[ci].codigoCompartido = codigo;
    saveDB();
    showToast('✅ Código compartido generado: '+codigo);
    go('config', S.params);
  }
}

function desactivarCodigoCompartido(){
  if(!puedeConfigurar()){ showToast('⛔ Sin permisos para gestionar códigos de acceso','#E24B4A'); return; }
  if(!confirm('¿Desactivar el código compartido? Nadie más podrá entrar con él.')) return;
  const ci = (DB.cursos||[]).findIndex(c=>c.id===S.cursoId);
  if(ci>=0){
    delete DB.cursos[ci].codigoCompartido;
    saveDB();
    showToast('Código compartido desactivado');
    go('config', S.params);
  }
}

function renderNavOnly(){
  const isLector = S.session?.rol==='apoderado_lector';
  const usr = S.session;
  const cur = getCurso();
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
  const bnPrimary = navItems.slice(0,4);
  const bnExtra   = navItems.slice(4);
  const masActivo = bnExtra.some(n=>n.r===S.route);
  const bnHtml = [
    ...bnPrimary.map(n=>`<div class="bn-item${S.route===n.r?' active':''}" onclick="go('${n.r}')"><div class="bn-icon">${n.icon}</div>${n.label}</div>`),
    bnExtra.length ? `<div class="bn-item${masActivo?' active':''}" onclick="toggleMasMenu()" id="bn-mas"><div class="bn-icon">☰</div>Más</div>` : ''
  ].join('');

  // Update sidebar nav
  const sideNav = document.getElementById('sidebar-nav');
  if(sideNav){
    let html = '<div class="nav-section">Menú</div>' + navHtml;
    if(!isLector){
      html += '<div class="nav-section" style="margin-top:10px">Mis cursos</div>';
      (DB.cursos||[]).filter(c=>(usr.cursoIds||[]).includes(c.id)).forEach(c=>{
        const col=(DB.colegios||[]).find(x=>x.id===c.colegioId);
        const esActivo=c.id===S.cursoId;
        html+=`<div class="nav-item${esActivo?' active':''}" onclick="selectCurso('${c.id}')" title="${escHtml(col?.nombre||'')} · ${c.anio}">
          <span class="nav-icon">🏫</span>
          <div style="min-width:0">
            <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12.5px">${escHtml(c.nombre)}</div>
            <div style="font-size:10px;color:var(--t3)">${escHtml(col?.nombre||'')} · ${c.anio}</div>
          </div>
          ${esActivo?'<span style="margin-left:auto;font-size:10px;color:var(--gm)">●</span>':''}
        </div>`;
      });
      html+=`<div class="nav-item" onclick="showModal('addCursoModal')" style="color:var(--gm);border:1px dashed var(--gm);margin-top:4px;border-radius:8px;font-size:12.5px"><span class="nav-icon" style="font-size:13px">＋</span>Agregar curso</div>`;
    }
    sideNav.innerHTML = html;
  }

  // Update bottom nav
  const bnInner = document.getElementById('bottom-nav-inner');
  if(bnInner) bnInner.innerHTML = bnHtml;
}

function toggleFondoEspecial(activo){
  const ci=(DB.cursos||[]).findIndex(c=>c.id===S.cursoId);
  if(ci<0) return;
  if(!DB.cursos[ci].fondoEspecial) DB.cursos[ci].fondoEspecial={nombre:'Fondo Especial'};
  DB.cursos[ci].fondoEspecial.activo = activo;
  saveDB();
  // Redirect if on actividades/fondo-especial and now disabled
  if(!activo && (S.route==='actividades'||S.route==='fondo-especial')){
    go('dashboard');
    return;
  }
  // Actualizar menú + contenido sin mover el scroll
  renderNavOnly();
  renderPage();
}

function renderPlantillasCobranzaHtml(){
  const labels = {suave:'😊 Plantilla Suave', directa:'📌 Plantilla Directa', comprobante:'📎 Plantilla Con Comprobante'};
  const defaults = {
    suave:'Hola {apoderado} 👋, te escribimos para recordar que está pendiente la cuota del curso de {periodo} por {monto}. Si ya realizaste el pago, por favor ignorar este mensaje. Muchas gracias, {tesorero} 🙏',
    directa:'Hola {apoderado}, aún figura pendiente la cuota del curso de {periodo} por {monto}. Te agradeceríamos regularizarla a la brevedad. Gracias, {tesorero} ✅',
    comprobante:'Hola {apoderado} 😊, te recordamos la cuota pendiente de {periodo} por {monto}. Si ya pagaste, por favor envíanos el comprobante o ignora este mensaje. Gracias {tesorero} 📎'
  };
  return ['suave','directa','comprobante'].map(tipo=>{
    const val = DB.config?.plantillasCobranza?.[tipo] || defaults[tipo];
    return '<div style="margin-bottom:14px">'
      +'<div style="font-size:13px;font-weight:700;color:var(--t1);margin-bottom:6px">'+labels[tipo]+'</div>'
      +'<textarea class="ft" id="pcob-'+tipo+'" rows="4" style="font-size:13px;line-height:1.5">'+escHtml(val)+'</textarea>'
      +'<button class="btn bs" onclick="restaurarPlantillaCobranza(&quot;'+tipo+'&quot;)" style="font-size:11px;margin-top:4px;color:var(--t3)">↺ Restaurar original</button>'
      +'</div>';
  }).join('');
}

function guardarPlantillasCobranza(){
  if(!DB.config) DB.config={};
  if(!DB.config.plantillasCobranza) DB.config.plantillasCobranza={};
  ['suave','directa','comprobante'].forEach(tipo=>{
    const el = document.getElementById('pcob-'+tipo);
    if(el) DB.config.plantillasCobranza[tipo] = el.value.trim();
  });
  saveDB();
  showToast('✅ Plantillas guardadas');
}

function restaurarPlantillaCobranza(tipo){
  const defaults = {
    suave:'Hola {apoderado} 👋, te escribimos para recordar que está pendiente la cuota del curso de {periodo} por {monto}. Si ya realizaste el pago, por favor ignorar este mensaje. Muchas gracias, {tesorero} 🙏',
    directa:'Hola {apoderado}, aún figura pendiente la cuota del curso de {periodo} por {monto}. Te agradeceríamos regularizarla a la brevedad. Gracias, {tesorero} ✅',
    comprobante:'Hola {apoderado} 😊, te recordamos la cuota pendiente de {periodo} por {monto}. Si ya pagaste, por favor envíanos el comprobante o ignora este mensaje. Gracias {tesorero} 📎'
  };
  const el = document.getElementById('pcob-'+tipo);
  if(el) el.value = defaults[tipo];
}

function guardarNombreFondo(){
  const nombre = document.getElementById('cfg-fondo-nombre')?.value.trim();
  if(!nombre){ alert('Ingresa un nombre para el fondo.'); return; }
  const ci=(DB.cursos||[]).findIndex(c=>c.id===S.cursoId);
  if(ci<0) return;
  if(!DB.cursos[ci].fondoEspecial) DB.cursos[ci].fondoEspecial={activo:true};
  DB.cursos[ci].fondoEspecial.nombre = nombre;
  saveDB();
  go('config');
}

function toggleMesesCuota(tipo){
  const row = document.getElementById('q-meses-row');
  if(row) row.style.display = tipo==='mensual' ? '' : 'none';
}

function saveCuota(id){
  const nombre=document.getElementById('q-nombre').value.trim();
  const monto=parseInt(document.getElementById('q-monto').value);
  if(!nombre||!monto){alert('Completa nombre y monto.');return;}
  const tipo = document.getElementById('q-tipo').value;
  const mesInicio  = tipo==='mensual' ? parseInt(document.getElementById('q-mes-inicio')?.value||'2')  : undefined;
  const mesTermino = tipo==='mensual' ? parseInt(document.getElementById('q-mes-termino')?.value||'11') : undefined;
  const data={nombre,tipo,monto,anio:parseInt(document.getElementById('q-anio').value)||2026,obs:document.getElementById('q-obs').value,activa:true,cursoId:S.cursoId,mesInicio,mesTermino};
  if(id){const i=(DB.cuotas||[]).findIndex(q=>q.id===id);if(i>=0) DB.cuotas[i]={...DB.cuotas[i],...data};}
  else{if(!DB.cuotas) DB.cuotas=[];DB.cuotas.push({id:uid(),...data});}
  saveDB(); closeModal(); go('cuotas');
}

