// js/features/dashboard.js — extraído de la copia de demostración.
function renderDashboard(){
  const isLector = S.session.rol==='apoderado_lector';
  const F = calcFinanzas();
  const cur = getCurso();
  const pagos = getPagos();
  const movs = getMovs(isLector);

  // Últimos movimientos: tesorero ve pagos+movs; apoderado solo ve movs públicos SIN nombres
  const recientes = isLector
    ? getMovs(true) // solo movimientos públicos, sin pagos individuales
        .sort((a,b)=>new Date(b.fecha||0)-new Date(a.fecha||0)).slice(0,6)
        .map(m=>({...m,_tipo:'mov'}))
    : [...pagos.filter(p=>p.estado==='pagado').map(p=>({...p,_tipo:'pago'})),
       ...movs.map(m=>({...m,_tipo:'mov'}))]
        .sort((a,b)=>new Date(b.fecha||0)-new Date(a.fecha||0)).slice(0,6);

  const totalIngresado = F.totPagos + F.totIngExtra;
  const pctIngExtras = totalIngresado>0 ? Math.round(F.totIngExtra/totalIngresado*100) : 0;
  const pctGastos = totalIngresado>0 ? Math.min(100,Math.round(F.totGastos/totalIngresado*100)) : 0;
  const pctSaldo = totalIngresado>0 ? Math.min(100,Math.round(F.saldoTotal/totalIngresado*100)) : 0;
  const cCumpl = F.pctCumpl>=80?'#1D9E75':F.pctCumpl>=50?'#D97706':'#E24B4A';
  const cGasto = pctGastos>=75?'#E24B4A':pctGastos>=50?'#D97706':'#1D9E75';
  const cSaldo = pctSaldo>=50?'#1D9E75':pctSaldo>=25?'#D97706':'#E24B4A';

  const metricasTesorero = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">

      <!-- CUOTAS -->
      <div class="card" style="margin:0;padding:14px 16px">
        <div style="font-size:11px;color:var(--t3);font-weight:700;text-transform:uppercase;margin-bottom:8px">💳 Cuotas del curso</div>
        <div style="font-size:24px;font-weight:900;color:${cCumpl}">${clp(F.totPagos)}</div>
        <div style="font-size:11px;color:var(--t3);margin-top:2px">de ${clp(F.totalEsperado)} esperado</div>
        <div style="margin-top:10px">
          <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;color:${cCumpl};margin-bottom:4px">
            <span>Cumplimiento</span><span>${F.pctCumpl}%</span>
          </div>
          <div style="height:8px;background:var(--brd);border-radius:4px">
            <div style="width:${F.pctCumpl}%;height:100%;background:${cCumpl};border-radius:4px;transition:width .5s"></div>
          </div>
        </div>
      </div>

      <!-- INGRESOS EXTRAS -->
      <div class="card" style="margin:0;padding:14px 16px">
        <div style="font-size:11px;color:var(--t3);font-weight:700;text-transform:uppercase;margin-bottom:8px">💰 Ingresos extras</div>
        <div style="font-size:24px;font-weight:900;color:#2563EB">${clp(F.totIngExtra)}</div>
        <div style="font-size:11px;color:var(--t3);margin-top:2px">${pctIngExtras}% del total ingresado</div>
        <div style="margin-top:10px">
          <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;color:#2563EB;margin-bottom:4px">
            <span>Del total</span><span>${pctIngExtras}%</span>
          </div>
          <div style="height:8px;background:var(--brd);border-radius:4px">
            <div style="width:${pctIngExtras}%;height:100%;background:#2563EB;border-radius:4px;transition:width .5s"></div>
          </div>
        </div>
      </div>

      <!-- GASTOS -->
      <div class="card" style="margin:0;padding:14px 16px">
        <div style="font-size:11px;color:var(--t3);font-weight:700;text-transform:uppercase;margin-bottom:8px">💸 Total gastos</div>
        <div style="font-size:24px;font-weight:900;color:${cGasto}">${clp(F.totGastos)}</div>
        <div style="font-size:11px;color:var(--t3);margin-top:2px">${pctGastos}% de lo recaudado</div>
        <div style="margin-top:10px">
          <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;color:${cGasto};margin-bottom:4px">
            <span>Consumido</span><span>${pctGastos}%</span>
          </div>
          <div style="height:8px;background:var(--brd);border-radius:4px">
            <div style="width:${pctGastos}%;height:100%;background:${cGasto};border-radius:4px;transition:width .5s"></div>
          </div>
        </div>
      </div>

      <!-- SALDO DISPONIBLE -->
      <div class="card" style="margin:0;padding:14px 16px;background:${F.saldoTotal>=0?'linear-gradient(135deg,#0F6E56,#1D9E75)':'linear-gradient(135deg,#C0392B,#E24B4A)'};border-color:transparent">
        <div style="font-size:11px;color:rgba(255,255,255,0.7);font-weight:700;text-transform:uppercase;margin-bottom:8px">🏦 Saldo disponible</div>
        <div style="font-size:28px;font-weight:900;color:#fff">${clp(F.saldoTotal)}</div>
        <div style="font-size:11px;color:rgba(255,255,255,0.6);margin-top:2px">${pctSaldo}% del total ingresado</div>
        <div style="margin-top:10px">
          <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;color:rgba(255,255,255,0.85);margin-bottom:4px">
            <span>Disponible</span><span>${pctSaldo}%</span>
          </div>
          <div style="height:8px;background:rgba(255,255,255,0.2);border-radius:4px">
            <div style="width:${pctSaldo}%;height:100%;background:rgba(255,255,255,0.75);border-radius:4px;transition:width .5s"></div>
          </div>
        </div>
      </div>

    </div>`;

  const barra = ''; // integrated into metrics cards

  // Lista de movimientos — para tesorero incluye pagos con nombres; para apoderado solo movs públicos sin identificar personas
  const movList = recientes.length ? recientes.map(m=>{
    const label = m._tipo==='pago' ? 'Cuota' : (m.tipo==='ingreso'?'Ingreso':'Gasto');
    const colorClass = m._tipo==='pago' ? 'bgg' : (m.tipo==='ingreso'?'bgg':'bgr');
    // NUNCA mostrar nombres de alumnos a apoderado lector
    const desc = isLector
      ? escHtml(m.desc||m.descripcion||'Movimiento del curso')
      : (m._tipo==='pago' ? `Cuota ${m.periodo||''} — ${escHtml(getAluNombre(m.alumnoId))}` : escHtml(m.desc||m.descripcion||''));
    const monto = m._tipo==='pago' ? clp(m.monto) : (m.tipo==='gasto'?`-${clp(m.monto)}`:clp(m.monto));
    const color = m._tipo==='pago'||m.tipo==='ingreso' ? 'var(--g)' : 'var(--r)';
    return `<div class="info-row"><div><div style="font-size:14px;font-weight:500">${desc}</div><div style="font-size:12px;color:var(--t3)">${fmtDate(m.fecha)} · <span class="badge ${colorClass}" style="font-size:10px;padding:2px 6px">${label}</span></div></div><div style="font-weight:700;color:${color}">${monto}</div></div>`;
  }).join('') : '<div class="empty-state" style="padding:24px"><div>Sin movimientos registrados aún</div></div>';

  const esDesarrollador = false;
  const bienvenidaDevHtml = esDesarrollador ? `
  <div style="background:linear-gradient(135deg,#0F6E56,#1D9E75);border-radius:16px;padding:16px 20px;margin-bottom:16px;position:relative;overflow:hidden">
    <div style="position:absolute;right:-10px;top:-10px;font-size:80px;opacity:0.12">⚡</div>
    <div style="display:flex;align-items:center;gap:12px">
      <div style="width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,0.2);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0">👨‍💻</div>
      <div>
        <div style="font-size:15px;font-weight:800;color:#fff">¡Hola, Juvenal! 👋</div>
        <div style="font-size:12px;color:rgba(255,255,255,0.85);margin-top:2px">Desarrollador · Tesorero App v${APP_VERSION}</div>
      </div>
      <div style="margin-left:auto;text-align:right">
        <div style="font-size:10px;color:rgba(255,255,255,0.7)">Sesión activa</div>
        <div style="font-size:11px;font-weight:700;color:#E1F5EE">⭐ Modo Admin</div>
      </div>
    </div>
    <div style="margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.15);display:flex;gap:16px;font-size:11px;color:rgba(255,255,255,0.75)">
      <span>🏫 ${escHtml(cur?.nombre||'')} · ${cur?.anio||''}</span>
      <span>👥 ${F.alumnos} alumnos</span>
      <span>💰 Saldo: ${clp(F.saldo)}</span>
    </div>
  </div>` : '';

  const novedadNotasVisto = previewStorage.getItem('notas_novedad_visto');
  const bannerNotasDashboard = (!isLector && !novedadNotasVisto) ? `
    <div id="banner-novedad" style="background:linear-gradient(135deg,#0F6E56,#0a5240);color:#fff;border-radius:12px;padding:14px 18px;margin-bottom:16px;display:flex;align-items:center;gap:12px;box-shadow:0 2px 8px rgba(15,110,86,.25)">
      <span style="font-size:24px">🎉</span>
      <div style="flex:1">
        <div style="font-weight:700;font-size:14px;margin-bottom:2px">¡Nueva función: Libreta de notas!</div>
        <div style="font-size:13px;opacity:.9">Ahora puedes guardar notas y recordatorios importantes. Encuéntrala en el menú como <strong>Libreta</strong>.</div>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0">
        <button type="button" onclick="go('notas')" style="background:rgba(255,255,255,.25);border:none;color:#fff;border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer;font-weight:600">Ver ahora →</button>
        <button type="button" onclick="cerrarBannerNovedad()" style="background:rgba(255,255,255,.15);border:none;color:#fff;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer">✕</button>
      </div>
    </div>` : '';

  return `
  ${bannerNotasDashboard}
  ${esDesarrollador ? bienvenidaDevHtml : ''}
  ${!isLector?`
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
    <button class="btn bs" onclick="generarResumenAnualPDF()" title="Generar resumen anual en PDF">📄 Resumen anual PDF</button>
  </div>`:''}
  ${!isLector?metricasTesorero:`
    ${renderDeudaPersonal()}
    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <div style="font-size:15px;font-weight:800">📊 Transparencia del curso</div>
        <button type="button" onclick="refrescarDatosApoderado(this)"
          style="background:linear-gradient(135deg,#1a7fe8,#0f5bbf);color:#fff;border:none;border-radius:10px;padding:7px 14px;font-size:12px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:5px;box-shadow:0 3px 10px rgba(26,127,232,0.4)">
          ↻ Actualizar
        </button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">
        <div style="background:var(--gl);border-radius:12px;padding:14px;text-align:center">
          <div style="font-size:11px;color:var(--t3);font-weight:600;text-transform:uppercase;margin-bottom:4px">Cuotas recaudadas</div>
          <div style="font-size:20px;font-weight:900;color:var(--g)">${clp(F.totPagos)}</div>
          <div style="font-size:11px;color:var(--t3);margin-top:4px">de ${clp(F.totalEsperado)} esperado</div>
        </div>
        <div style="background:#F0F7FF;border-radius:12px;padding:14px;text-align:center">
          <div style="font-size:11px;color:var(--t3);font-weight:600;text-transform:uppercase;margin-bottom:4px">Cumplimiento cuotas</div>
          <div style="font-size:20px;font-weight:900;color:${F.pctCumpl>=80?'var(--g)':F.pctCumpl>=50?'#D97706':'var(--r)'}">
            ${F.pctCumpl}%
          </div>
          <div style="height:6px;background:var(--brd);border-radius:3px;margin-top:8px">
            <div style="width:${F.pctCumpl}%;height:100%;background:${F.pctCumpl>=80?'var(--g)':F.pctCumpl>=50?'#D97706':'var(--r)'};border-radius:3px"></div>
          </div>
        </div>
      </div>
      ${(()=>{
        const ingresos = getMovs(true).filter(m=>m.tipo==='ingreso');
        if(!ingresos.length) return '<p style="font-size:13px;color:var(--t3);text-align:center;padding:8px">Sin ingresos extras registrados.</p>';
        return '<div style="font-size:13px;font-weight:700;color:var(--t2);margin-bottom:8px">Ingresos extras del curso:</div>'
          + '<div style="display:flex;flex-direction:column;gap:6px">'
          + ingresos.map(m=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--bg);border-radius:8px">
              <div>
                <div style="font-size:13px;font-weight:600">${escHtml(m.desc||m.descripcion||'Ingreso')}</div>
                <div style="font-size:11px;color:var(--t3)">${fmtDate(m.fecha)}</div>
              </div>
              <div style="font-weight:700;color:var(--g)">${clp(m.monto)}</div>
            </div>`).join('')
          + '</div>';
      })()}
    </div>
    ${(()=>{ const bd=cur?.banco||cur?.bancoDatos; return bd?.nombre?`
    <div class="card" style="border:1px solid var(--b)30;background:var(--bl)20;margin-top:4px">
      <div class="card-title" style="color:var(--b)">🏦 Datos para transferencia</div>
      <p style="font-size:12px;color:var(--r);font-weight:600;margin-bottom:10px">⚠️ Verifica siempre el RUT antes de transferir</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        ${[['Nombre',bd.nombre],['RUT',bd.rut],['Banco',bd.banco],['Tipo de cuenta',bd.tipo],['N° de cuenta',bd.cuenta],['Correo',bd.email]].filter(([,v])=>v).map(([l,v])=>`
        <div style="background:#fff;border-radius:8px;padding:8px 10px;border:1px solid var(--brd)">
          <div style="font-size:10px;color:var(--t3);margin-bottom:2px">${l}</div>
          <div style="font-size:13px;font-weight:600;color:var(--t1)">${escHtml(v)}</div>
          <button onclick="navigator.clipboard.writeText('${escHtml(v)}').then(()=>showToast('¡Copiado!'))" style="margin-top:4px;background:none;border:1px solid var(--brd);border-radius:4px;padding:2px 8px;font-size:10px;cursor:pointer;color:var(--t3)">📋 Copiar</button>
        </div>`).join('')}
      </div>
    </div>`:''})()}
`}
  ${!isLector?alertasMora():''}
  ${!isLector?barra:''}
  <div class="g2">
    <div class="card">
      <div class="card-title">Ingresos vs Gastos por mes</div>
      <div class="legend"><div style="display:flex;align-items:center;gap:4px"><div class="ldot" style="background:var(--g)"></div>Ingresos</div><div style="display:flex;align-items:center;gap:4px"><div class="ldot" style="background:var(--r)"></div>Gastos</div></div>
      <div class="chart-wrap"><canvas id="chartBar"></canvas></div>
    </div>
    <div class="card">
      <div class="card-title">📊 Resumen financiero</div>
      <div style="font-size:11px;color:var(--t3);margin-bottom:14px">Composición del dinero del curso</div>
      <div id="chartResumen"></div>
    </div>
  </div>
  ${!isLector ? `
  <div class="card" style="margin-top:14px">
    <div class="card-title">Últimos movimientos</div>
    ${movList}
  </div>` : recientes.length ? `
  <div class="card" style="margin-top:14px">
    <div class="card-title">Últimos movimientos del curso</div>
    <div style="font-size:12px;color:var(--t3);margin-bottom:12px">Solo se muestran ingresos y gastos generales del curso, sin información individual.</div>
    ${movList}
  </div>` : ''}`;
}

function alertasMora(){
  const cur = getCurso();
  if(!cur) return '';
  const alumnos = getAlumnos();
  const pagos = getPagos().filter(p=>p.estado==='pagado');
  const cuotas = (DB.cuotas||[]).filter(c=>c.cursoId===S.cursoId&&c.activa);
  const hoy = new Date();
  const mesActual = hoy.getMonth()+1;
  const anioActual = hoy.getFullYear();

  // Alumnos sin pago este mes
  const alumnosSinPago = alumnos.filter(a=>{
    const cuotaMes = cuotas.find(c=>c.tipo==='mensual');
    if(!cuotaMes) return false;
    return !pagos.some(p=>p.alumnoId===a.id && p.cuotaId===cuotaMes.id &&
      new Date(p.fecha).getMonth()+1===mesActual &&
      new Date(p.fecha).getFullYear()===anioActual);
  });

  if(alumnosSinPago.length===0) return '';

  return `<div class="card" style="border-left:4px solid var(--r);margin-bottom:14px">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px">
      <div class="card-title" style="color:var(--r);margin:0">🔔 ${alumnosSinPago.length} alumno${alumnosSinPago.length>1?'s':''} sin pago este mes</div>
      <button class="btn" style="background:var(--rl);color:var(--r);border:1px solid var(--r);font-size:12px;padding:5px 12px" onclick="mensajeMasivoWsp()">💬 Avisar a todos por WhatsApp</button>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:6px">
      ${alumnosSinPago.slice(0,8).map(a=>`<span class="badge bgr">${escHtml(a.apellidos+', '+a.nombres)}</span>`).join('')}
      ${alumnosSinPago.length>8?`<span class="badge" style="background:#eee;color:var(--t2)">+${alumnosSinPago.length-8} más</span>`:''}
    </div>
  </div>`;
}

function mensajeMasivoWsp(){
  const cur = getCurso();
  const alumnos = getAlumnos();
  const pagos = getPagos().filter(p=>p.estado==='pagado');
  const cuotas = (DB.cuotas||[]).filter(c=>c.cursoId===S.cursoId&&c.activa);
  const hoy = new Date();
  const mesActual = hoy.getMonth()+1;
  const anioActual = hoy.getFullYear();
  const meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const mesNombre = meses[hoy.getMonth()];

  const cuotaMes = cuotas.find(c=>c.tipo==='mensual');
  const alumnosSinPago = alumnos.filter(a=>{
    if(!cuotaMes) return false;
    return !pagos.some(p=>p.alumnoId===a.id && p.cuotaId===cuotaMes.id &&
      new Date(p.fecha).getMonth()+1===mesActual &&
      new Date(p.fecha).getFullYear()===anioActual);
  });

  if(alumnosSinPago.length===0){ alert('✅ Todos los alumnos tienen su cuota al día.'); return; }

  const appUrl = DB.config?.appUrl || window.location.href;
  const bd = cur?.banco || cur?.bancoDatos;
  const datosBanco = bd?.nombre ? `

🏦 *Datos para transferencia:*
Nombre: ${bd.nombre}
RUT: ${bd.rut}
Banco: ${bd.banco}
Tipo: ${bd.tipo}
N° cuenta: ${bd.cuenta}
Correo: ${bd.email}` : '';

  // Enviar mensaje a cada apoderado con teléfono
  let enviados = 0;
  alumnosSinPago.forEach(alumno=>{
    const apoderados = (DB.apoderados||[]).filter(ap=>ap.alumnoId===alumno.id && ap.estado==='activo' && ap.telefono);
    apoderados.forEach(ap=>{
      const tel = ap.telefono.replace(/\D/g,'');
      const telInt = tel.startsWith('56')?tel:'56'+tel;
      const msg = encodeURIComponent(
        `Hola ${ap.nombre} 👋

Te recordamos que la cuota de *${mesNombre} ${anioActual}* de *${alumno.nombres} ${alumno.apellidos}* en *${cur?.nombre||'el curso'}* aún no ha sido registrada.

Monto: *${clp(cuotaMes?.monto||0)} CLP*${datosBanco}

_${cur?.tesorero||'Tesorero/a'} · ${cur?.nombre||''} · ${getColegio()?.nombre||''}_`
      );
      window.open(`https://wa.me/${telInt}?text=${msg}`, '_blank');
      enviados++;
    });
  });

  if(enviados===0) alert('⚠️ Ninguno de los '+V('miembros').toLowerCase()+' con mora tiene teléfono registrado. Ve a '+V('miembros')+' → Contactos para agregar los números.');
}

function getColegio(){
  const cur = getCurso();
  return (DB.colegios||[]).find(c=>c.id===cur?.colegioId);
}

function generarResumenPDF(){
  const cur = getCurso();
  const F = calcFinanzas();
  const alumnos = getAlumnos();
  const pagos = getPagos().filter(p=>p.estado==='pagado');
  const movs = getMovs(false);
  const hoy = new Date();
  const meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

  // Calcular resumen por alumno
  const resumenAlumnos = alumnos.map(a=>{
    const ps = pagos.filter(p=>p.alumnoId===a.id);
    const total = ps.reduce((s,p)=>s+p.monto,0);
    return { nombre: a.apellidos+', '+a.nombres, pagos: ps.length, total };
  }).sort((a,b)=>a.nombre.localeCompare(b.nombre,'es'));

  // Resumen por mes
  const porMes = {};
  pagos.forEach(p=>{ const m=p.fecha?.slice(0,7)||''; if(!porMes[m]) porMes[m]={ing:0,gas:0}; porMes[m].ing+=p.monto; });
  movs.forEach(m=>{ const mes=m.fecha?.slice(0,7)||''; if(!porMes[mes]) porMes[mes]={ing:0,gas:0}; if(m.tipo==='ingreso') porMes[mes].ing+=m.monto; else porMes[mes].gas+=m.monto; });

  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
  <title>Resumen Anual ${cur?.anio||hoy.getFullYear()} - ${cur?.nombre||''}</title>
  <style>
    body{font-family:Arial,sans-serif;margin:30px;color:#1a1a1a;font-size:13px}
    h1{color:#0F6E56;font-size:20px;margin-bottom:4px}
    h2{color:#0F6E56;font-size:15px;margin:20px 0 8px;border-bottom:2px solid #E1F5EE;padding-bottom:4px}
    .meta{color:#666;font-size:12px;margin-bottom:20px}
    .metricas{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
    .m{background:#E1F5EE;border-radius:8px;padding:12px;text-align:center}
    .m-val{font-size:18px;font-weight:700;color:#0F6E56}
    .m-lbl{font-size:11px;color:#666;margin-top:2px}
    table{width:100%;border-collapse:collapse;margin-bottom:16px}
    th{background:#0F6E56;color:#fff;padding:7px 10px;text-align:left;font-size:12px}
    td{padding:6px 10px;border-bottom:1px solid #eee;font-size:12px}
    tr:nth-child(even) td{background:#f9f9f9}
    .badge-g{background:#d4edda;color:#0F6E56;padding:2px 8px;border-radius:10px;font-size:11px}
    .badge-r{background:#fde;color:#c0392b;padding:2px 8px;border-radius:10px;font-size:11px}
    .footer{margin-top:30px;text-align:center;font-size:11px;color:#999;border-top:1px solid #eee;padding-top:12px}
    @media print{body{margin:15px}}
  </style></head><body>
  <h1>💰 Tesorero — Resumen Anual ${cur?.anio||hoy.getFullYear()}</h1>
  <div class="meta">
    📚 ${cur?.nombre||''} &nbsp;|&nbsp; 🏫 ${getColegio()?.nombre||''} &nbsp;|&nbsp;
    👤 Tesorero/a: ${cur?.tesorero||''} &nbsp;|&nbsp; 📅 Generado: ${hoy.toLocaleDateString('es-CL')}
  </div>
  <div class="metricas">
    <div class="m"><div class="m-val">${clp(F.totalIngresos)}</div><div class="m-lbl">Total recaudado</div></div>
    <div class="m"><div class="m-val">${clp(F.totGastos)}</div><div class="m-lbl">Total gastos</div></div>
    <div class="m"><div class="m-val">${clp(F.saldo)}</div><div class="m-lbl">Saldo disponible</div></div>
    <div class="m"><div class="m-val">${F.pctCumpl}%</div><div class="m-lbl">Cumplimiento</div></div>
  </div>
  <h2>📋 Estado de pagos por alumno</h2>
  <table><tr><th>Alumno</th><th>Pagos registrados</th><th>Total pagado</th><th>Estado</th></tr>
  ${resumenAlumnos.map(a=>`<tr><td>${escHtml(a.nombre)}</td><td>${a.pagos}</td><td style="font-weight:700;color:#0F6E56">${clp(a.total)}</td><td><span class="${a.total>0?'badge-g':'badge-r'}">${a.total>0?'Al día':'Sin pago'}</span></td></tr>`).join('')}
  </table>
  <h2>📅 Resumen mensual</h2>
  <table><tr><th>Mes</th><th>Ingresos</th><th>Gastos</th><th>Balance</th></tr>
  ${Object.entries(porMes).sort((a,b)=>a[0].localeCompare(b[0])).map(([mes,v])=>{
    const [anio,m]=mes.split('-');
    return `<tr><td>${meses[parseInt(m)-1]} ${anio}</td><td style="color:#0F6E56;font-weight:600">${clp(v.ing)}</td><td style="color:#e74c3c;font-weight:600">${clp(v.gas)}</td><td style="font-weight:700">${clp(v.ing-v.gas)}</td></tr>`;
  }).join('')}
  </table>
  <h2>💸 Movimientos de ingresos y gastos</h2>
  <table><tr><th>Fecha</th><th>Tipo</th><th>Descripción</th><th>Monto</th></tr>
  ${movs.sort((a,b)=>a.fecha?.localeCompare(b.fecha||'')).map(m=>`<tr>
    <td>${fmtDate(m.fecha)}</td>
    <td><span class="${m.tipo==='ingreso'?'badge-g':'badge-r'}">${m.tipo==='ingreso'?'Ingreso':'Gasto'}</span></td>
    <td>${escHtml(m.descripcion||'')}</td>
    <td style="font-weight:700;color:${m.tipo==='ingreso'?'#0F6E56':'#e74c3c'}">${m.tipo==='ingreso'?'+':'−'}${clp(m.monto)}</td>
  </tr>`).join('')}
  </table>
  <div class="footer">Generado por Tesorero v${APP_VERSION} · Desarrollado por Juvenal · ${hoy.getFullYear()}</div>
  </body></html>`;

  const ventana = window.open('','_blank');
  ventana.document.write(html);
  ventana.document.close();
  setTimeout(()=>ventana.print(), 500);
}

function renderFondoLector(alumnoId){
  const {total, historial} = getFondoAlumno(alumnoId);
  if(!historial.length && total===0) return '';
  const fondoCfg = getFondoEspecialConfig();
  return `<div class="card" style="margin-top:14px">
    <div class="card-title">🎓 ${escHtml(fondoCfg.nombre||'Fondo de actividades')}</div>
    <div style="background:var(--gl);border-radius:12px;padding:14px 16px;text-align:center;margin-bottom:14px">
      <div style="font-size:11px;color:var(--t3);font-weight:600;text-transform:uppercase;margin-bottom:4px">Fondo acumulado</div>
      <div style="font-size:26px;font-weight:900;color:var(--g);word-break:break-word">${clp(total)}</div>
    </div>
    <div style="font-size:13px;color:var(--t2);line-height:1.6;margin-bottom:14px">
      Este fondo corresponde a tu participación en actividades de recaudación del curso. El tesorero informará cómo se utilizará al final del año.
    </div>
    ${historial.length ? `
    <div class="card-title" style="font-size:13px;margin-bottom:8px">Historial de participación</div>
    <div class="tbl-wrap">
      <table class="tbl">
        <thead><tr><th>Actividad</th><th>Fecha</th><th>Aporte</th></tr></thead>
        <tbody>
          ${historial.map(h=>`<tr>
            <td>${escHtml(h.nombre)}</td>
            <td style="color:var(--t3)">${fmtDate(h.fecha)}</td>
            <td style="font-weight:700;color:var(--g)">${clp(h.monto)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : ''}
  </div>`;
}

function renderMisDatos(){
  const esCompartido = S.session?.esAccesoCompartido;
  const alumnoId = esCompartido ? null : S.session?.alumnoId;
  const alu = esCompartido ? null : (DB.alumnos||[]).find(a=>a.id===alumnoId);
  if(!alu) return '<div class="empty-state"><div>No se encontró información del alumno.</div></div>';

  const aps = (DB.apoderados||[]).filter(a=>a.alumnoId===alumnoId);
  const cur = getCurso();
  const col = (DB.colegios||[]).find(c=>c.id===cur?.colegioId);

  const apsHtml = aps.length===0
    ? `<div class="empty-state" style="padding:20px"><div>No hay apoderados registrados aún.</div></div>`
    : aps.map(ap=>`
      <div class="card" style="margin-bottom:12px;border:1px solid var(--brd)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:40px;height:40px;border-radius:50%;background:var(--gl);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;color:var(--g)">
              ${escHtml((ap.nombre||'?')[0].toUpperCase())}
            </div>
            <div>
              <div style="font-weight:700;font-size:15px;color:var(--t1)">${escHtml(ap.nombre||'')}</div>
              <div style="font-size:12px;color:var(--t3)">${escHtml(ap.relacion||'Apoderado/a')}</div>
            </div>
          </div>
          <button class="btn bp bs" onclick="showModal('editApoderado',{apId:'${ap.id}'})" style="font-size:12px">✏️ Editar</button>
        </div>
        <div style="display:grid;gap:8px">
          <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg);border-radius:8px">
            <span style="font-size:16px">📞</span>
            <div>
              <div style="font-size:11px;color:var(--t3)">Teléfono</div>
              <div style="font-size:14px;font-weight:600;color:var(--t1)">${ap.telefono ? escHtml(ap.telefono) : '<span style="color:var(--t3);font-style:italic">No registrado</span>'}</div>
            </div>
            ${ap.telefono ? `<button onclick="navigator.clipboard?.writeText('${escHtml(ap.telefono)}')" style="margin-left:auto;background:none;border:1px solid var(--brd);border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer;color:var(--t3)">📋</button>` : ''}
          </div>
          <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg);border-radius:8px">
            <span style="font-size:16px">✉️</span>
            <div>
              <div style="font-size:11px;color:var(--t3)">Correo electrónico</div>
              <div style="font-size:14px;font-weight:600;color:var(--t1)">${ap.email ? escHtml(ap.email) : '<span style="color:var(--t3);font-style:italic">No registrado</span>'}</div>
            </div>
            ${ap.email ? `<button onclick="navigator.clipboard?.writeText('${escHtml(ap.email)}')" style="margin-left:auto;background:none;border:1px solid var(--brd);border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer;color:var(--t3)">📋</button>` : ''}
          </div>
        </div>
      </div>`).join('');

  return `
  <div class="page-hdr"><div class="page-title">👤 Mis datos</div></div>

  <!-- Info del alumno -->
  <div class="card" style="margin-bottom:14px;background:var(--gl);border:1px solid var(--gm)30">
    <div style="display:flex;align-items:center;gap:12px">
      <div style="font-size:32px">🎒</div>
      <div>
        <div style="font-size:16px;font-weight:800;color:var(--g)">${escHtml((alu.nombres||'')+' '+(alu.apellidos||''))}</div>
        <div style="font-size:13px;color:var(--t2)">${escHtml(cur?.nombre||'')} · ${cur?.anio||''} · ${escHtml(col?.nombre||'')}</div>
      </div>
    </div>
  </div>

  <!-- Apoderados -->
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
    <div style="font-size:16px;font-weight:700;color:var(--t1)">Apoderados registrados</div>
    <button class="btn bp" onclick="showModal('addApoderadoLector',{aluId:'${alumnoId}'})" style="font-size:13px">+ Agregar ${V('contacto')}</button>
  </div>
  ${apsHtml}

  <div style="margin-top:16px;padding:12px 14px;background:var(--bg);border-radius:10px;font-size:12px;color:var(--t3);line-height:1.6">
    ℹ️ Los datos de contacto son visibles solo para ti y el tesorero del curso. No son compartidos públicamente.
  </div>`;
}


// ─── ACTIVIDADES CON FONDO INDIVIDUAL ────────────────────────────────────────

