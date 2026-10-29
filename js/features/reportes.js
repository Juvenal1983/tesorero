// js/features/reportes.js — extraído de la copia de demostración.
function renderReportes(){
  const isLector = S.session.rol==='apoderado_lector';
  const F = calcFinanzas();
  const cur = getCurso();
  const alumnos = getAlumnos();
  const pagos = getPagos().filter(p=>p.estado==='pagado');

  let cumplRows = '';
  if(!isLector){
    alumnos.forEach(a=>{
      const ps = pagos.filter(p=>p.alumnoId===a.id);
      const totPag = ps.reduce((s,p)=>s+p.monto,0);
      cumplRows += `<tr>
        <td style="font-weight:500">${escHtml(a.nombres+' '+a.apellidos)}</td>
        <td>${ps.length} pagos</td>
        <td style="font-weight:700;color:var(--g)">${clp(totPag)}</td>
        <td><span class="badge ${totPag>0?'bgg':'bgr'}">${totPag>0?'Al día':'Pendiente'}</span></td>
      </tr>`;
    });
  }

  // Comprobantes: todos los movimientos con archivos visibles para el rol actual
  const movsConComp = getMovs(isLector).filter(m=>getArchivos(m).length>0);

  return `
  <div class="page-hdr"><div class="page-title">Reportes de ${V('grupo').toLowerCase()}</div>
    <button class="btn" onclick="printReporte()">🖨️ Imprimir / PDF</button>
  </div>
  ${isLector?`<div class="role-banner">👁️ Vista apoderado — información financiera general del curso</div>`:''}
  <div class="card" style="margin-bottom:14px" id="print-area">
    <div style="margin-bottom:16px">
      <div style="font-size:18px;font-weight:800">${escHtml(cur.nombre||'')} · ${cur.anio||''}</div>
      <div style="font-size:13px;color:var(--t3)">Reporte generado el ${new Date().toLocaleDateString('es-CL')} · Tesorero: ${escHtml(cur.tesorero||'')}</div>
    </div>
    <div class="g4" style="margin-bottom:20px">
      <div class="metric"><div class="m-label">Total ingresos</div><div class="m-value mv-g">${clp(F.totalIngresos)}</div></div>
      <div class="metric"><div class="m-label">Total gastos</div><div class="m-value mv-r">${clp(F.totGastos)}</div></div>
      <div class="metric"><div class="m-label">Saldo</div><div class="m-value mv-b">${clp(F.saldo)}</div></div>
      <div class="metric"><div class="m-label">Cumplimiento</div><div class="m-value mv-a">${F.pctCumpl}%</div></div>
    </div>
    <div style="margin-bottom:16px">
      <div class="info-row"><span>Cuotas mensuales cobradas</span><span style="font-weight:700;color:var(--g)">${clp(pagos.filter(p=>{const q=(DB.cuotas||[]).find(x=>x.id===p.cuotaId);return q&&q.tipo==='mensual';}).reduce((s,p)=>s+p.monto,0))}</span></div>
      <div class="info-row"><span>Cuotas anuales cobradas</span><span style="font-weight:700;color:var(--g)">${clp(pagos.filter(p=>{const q=(DB.cuotas||[]).find(x=>x.id===p.cuotaId);return q&&q.tipo==='anual';}).reduce((s,p)=>s+p.monto,0))}</span></div>
      <div class="info-row"><span>Ingresos extra</span><span style="font-weight:700;color:var(--g)">${clp(F.totIngExtra)}</span></div>
      <div class="info-row"><span>Total gastos</span><span style="font-weight:700;color:var(--r)">${clp(F.totGastos)}</span></div>
      <div class="info-row" style="font-size:16px;font-weight:700"><span>Saldo disponible</span><span style="color:${F.saldo>=0?'var(--g)':'var(--r)'}">${clp(F.saldo)}</span></div>
    </div>
    <div style="margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px"><span>Progreso de recaudación</span><span style="font-weight:700">${F.pctCumpl}%</span></div>
      <div class="progress-bar" style="height:10px"><div class="progress-fill" style="width:${F.pctCumpl}%;background:${F.pctCumpl>75?'var(--g)':F.pctCumpl>40?'var(--a)':'var(--r)'}"></div></div>
    </div>
  </div>
  <div class="card" style="margin-bottom:14px">
    <div class="card-title">Movimientos visibles</div>
    <div class="chart-wrap"><canvas id="chartRepBar"></canvas></div>
  </div>

  <!-- COMPROBANTES -->
  <div class="card" style="margin-bottom:14px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px">
      <div>
        <div class="card-title" style="margin-bottom:2px">📎 Comprobantes adjuntos</div>
        <div style="font-size:12px;color:var(--t3)">${movsConComp.length} comprobante${movsConComp.length!==1?'s':''} disponible${movsConComp.length!==1?'s':''} · Solo lectura para apoderados</div>
      </div>
    </div>
    ${movsConComp.length===0
      ? `<div class="empty-state" style="padding:24px"><div style="font-size:32px;margin-bottom:8px">📂</div><div>Sin comprobantes adjuntos aún</div>${!isLector?'<div style="font-size:12px;color:var(--t3);margin-top:4px">Adjunta fotos o PDFs al registrar gastos en Movimientos</div>':''}</div>`
      : `<div style="display:flex;flex-direction:column;gap:14px">
          ${movsConComp.map(m=>{
            const archs=getArchivos(m);
            return `<div style="border:1px solid var(--brd);border-radius:var(--rad);overflow:hidden;background:var(--wh)">
              <div style="padding:10px 14px;border-bottom:1px solid #f0efea;display:flex;justify-content:space-between;align-items:center">
                <div>
                  <div style="font-size:13px;font-weight:700">${escHtml(m.desc||'')}</div>
                  <div style="font-size:11px;color:var(--t3);margin-top:1px">
                    <span style="color:var(--r);font-weight:600">-${clp(m.monto)}</span> · ${fmtDate(m.fecha)} · ${archs.length} archivo${archs.length!==1?'s':''}
                  </div>
                </div>
              </div>
              <div style="display:flex;flex-wrap:wrap;gap:10px;padding:12px 14px">
                ${archs.map((a,i)=>`
                  <div style="cursor:pointer;text-align:center" onclick="verComprobante('${m.id}',${i})">
                    ${a.tipo==='application/pdf'
                      ? `<div style="width:80px;height:80px;background:var(--rl);border-radius:8px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font-size:26px">📄<span style="font-size:9px;color:var(--r);font-weight:700">PDF</span></div>`
                      : `<img src="${getArchivoSrc(a)}" style="width:80px;height:80px;object-fit:cover;border-radius:8px;display:block">`
                    }
                    <div style="font-size:9px;color:var(--t3);margin-top:3px;max-width:80px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${escHtml(a.nombre)}</div>
                  </div>`).join('')}
              </div>
            </div>`;
          }).join('')}
        </div>`
    }
  </div>

  ${!isLector&&cumplRows?`
  <div class="card">
    <div class="card-title">Estado de pagos por alumno <span style="font-size:12px;color:var(--r);font-weight:400">(solo visible para tesorero)</span></div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Alumno</th><th>Pagos registrados</th><th>Total pagado</th><th>Estado</th></tr></thead>
      <tbody>${cumplRows}</tbody>
    </table></div>
  </div>`:''}`;
}

function drawReporteCharts(){
  const pagos=getPagos().filter(p=>p.estado==='pagado');
  const movs=getMovs();
  const ingMes=Array(12).fill(0), gasMes=Array(12).fill(0);
  pagos.forEach(p=>{ const m=parseInt((p.fecha||'').split('-')[1]); if(m>=1&&m<=12) ingMes[m-1]+=p.monto; });
  movs.filter(m=>m.tipo==='ingreso').forEach(m=>{ const mo=parseInt((m.fecha||'').split('-')[1]); if(mo>=1&&mo<=12) ingMes[mo-1]+=m.monto; });
  movs.filter(m=>m.tipo==='gasto').forEach(m=>{ const mo=parseInt((m.fecha||'').split('-')[1]); if(mo>=1&&mo<=12) gasMes[mo-1]+=m.monto; });
  // Incluir ingresos por actividades
  getActividades().forEach(a=>{ const mo=parseInt((a.fecha||'').split('-')[1]); if(mo>=1&&mo<=12) ingMes[mo-1]+=(a.montoTotal||0); });
  const c=document.getElementById('chartRepBar');
  if(c){_charts.repbar=new Chart(c,{type:'bar',data:{labels:MESES.map(m=>m.slice(0,3)),datasets:[
    {label:'💰 Ingresos',data:ingMes,backgroundColor:'#1D9E75',borderRadius:4},
    {label:'💸 Gastos',data:gasMes,backgroundColor:'#E24B4A',borderRadius:4}
  ]},options:{responsive:true,maintainAspectRatio:false,
    plugins:{legend:{display:true,position:'top',labels:{font:{size:11},boxWidth:10,padding:8}},
      tooltip:{callbacks:{label:ctx=>' '+ctx.dataset.label+': $'+Math.round(ctx.raw).toLocaleString('es-CL')}}
    },
    scales:{x:{grid:{display:false}},y:{grid:{color:'rgba(0,0,0,.04)'},ticks:{callback:v=>v===0?'$0':'$'+Math.round(v/1000)+'k'}}}}});}
}
function printReporte(){window.print();}

// ─────────────────────────────────────────────
// CONFIGURACIÓN
// ─────────────────────────────────────────────

// ─── GESTIÓN DE USUARIOS ─────────────────────────────────────────────────────
