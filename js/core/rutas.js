// js/core/rutas.js — extraído de la copia de demostración.
function renderSelector(){
  const usr=S.session;
  const cursos=(DB.cursos||[]).filter(c=>usr.rol==='superadmin'||(usr.cursoIds||[]).includes(c.id));
  const colegiosMap={};
  (DB.colegios||[]).forEach(c=>colegiosMap[c.id]=c);
  return `
  <div class="login-wrap">
    <div class="login-card" style="max-width:520px">
      <div class="login-logo">🏫 Seleccionar curso</div>
      <div class="login-sub">Hola, <strong>${escHtml(usr.nombre)}</strong>. ¿Qué curso deseas administrar?</div>
      ${cursos.map(c=>{
        const col=colegiosMap[c.colegioId]||{};
        return `<div onclick="selectCurso('${c.id}')" style="border:1px solid var(--brd);border-radius:var(--rad);padding:16px 18px;cursor:pointer;margin-bottom:10px;transition:.15s" onmouseover="this.style.borderColor='var(--gm)'" onmouseout="this.style.borderColor='var(--brd)'">
          <div style="font-size:16px;font-weight:700">${escHtml(c.nombre)}</div>
          <div style="font-size:13px;color:var(--t3);margin-top:3px">${escHtml(col.nombre||'')} · ${c.anio} · Tesorero: ${escHtml(c.tesorero||'')}</div>
          <div style="display:flex;gap:8px;margin-top:8px"><span class="badge ${c.activo?'bgg':'bgt'}">${c.activo?'Activo':'Inactivo'}</span></div>
        </div>`;
      }).join('')}
      <button class="btn" style="margin-top:8px;width:100%;justify-content:center" onclick="logout()">← Cerrar sesión</button>
    </div>
  </div>`;
}
function bindSelector(){}
// Contador de epoch para proteger contra race conditions al cambiar de curso.
// Cada llamada a selectCurso incrementa el epoch; una respuesta tardía con
// epoch menor que el actual se descarta silenciosamente.
let _selectCursoEpoch = 0;

function selectCurso(id){
  // ── FLUJO RELACIONAL v9 ────────────────────────────────────────────────
  if (typeof V9_RELACIONAL !== 'undefined' && V9_RELACIONAL &&
      typeof recargarCursoV9 === 'function' && typeof _authToken !== 'undefined' && _authToken) {

    const miEpoch = ++_selectCursoEpoch;

    // No cambiar S.cursoId ni navegar hasta que el servidor confirme la carga.
    // Mostrar indicador de carga mientras espera.
    const appEl = document.getElementById('app');
    if (appEl) appEl.innerHTML = '<div style="padding:32px;color:var(--t3)">Cargando curso…</div>';

    recargarCursoV9(id, _authToken)
      .then(() => {
        // Descartar si el usuario seleccionó otro curso mientras esperábamos
        if (miEpoch !== _selectCursoEpoch) {
          console.warn('[v9] selectCurso: respuesta tardía descartada (epoch obsoleto)');
          return;
        }
        S.cursoId = id;
        go('dashboard');
      })
      .catch(err => {
        if (miEpoch !== _selectCursoEpoch) return;
        console.error('[v9] recargarCursoV9 falló:', err);
        // No navegar al dashboard con datos del curso anterior.
        // Volver al selector para que el usuario pueda reintentar.
        if (appEl) {
          appEl.innerHTML = '<div style="padding:32px"><div style="color:var(--r);margin-bottom:12px">⚠️ No se pudieron cargar los datos del curso. Inténtalo de nuevo.</div>'
            + '<button class="btn" onclick="go(\'selector\')">← Volver al selector</button></div>';
        }
      });
    return;
  }
  // ── FIN FLUJO RELACIONAL v9 ───────────────────────────────────────────
  S.cursoId = id;
  go('dashboard');
}

// ─────────────────────────────────────────────
// RUTAS
// ─────────────────────────────────────────────
function renderRoute(){
  switch(S.route){
    case 'dashboard': return renderDashboard();
    case 'alumnos': return renderAlumnos();
    case 'cuotas': return renderCuotas();
    case 'pagos': return renderPagos();
    case 'fondo-especial': return renderFondoEspecial();
    case 'movimientos': return renderMovimientos();
    case 'cobranza': return renderCobranza();
    case 'reportes': return renderReportes();
    case 'config': setTimeout(()=>{ const editando=document.activeElement&&['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName); if(!editando) sincronizarCodigosDesdeSupabase().then(()=>{ const l=document.getElementById('lista-invitaciones'); if(l) l.innerHTML=renderListaInvitaciones(); }); },300); return renderConfig();
    case 'mis-datos': return renderMisDatos();
    case 'notas': return renderNotas();
    default: return renderDashboard();
  }
}
function afterRender(){
  const r=S.route;
  if(r==='dashboard') setTimeout(drawDashboardCharts,50);
  if(r==='reportes') setTimeout(drawReporteCharts,50);
}

// ─────────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────────
