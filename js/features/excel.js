// js/features/excel.js — extraído de la copia de demostración.
function descargarPlantillaExcel(){
  if(typeof XLSX === 'undefined'){ showToast('⚠️ Cargando librería, intenta en unos segundos'); return; }
  const v = VOCABULARIOS[DB.config?.tipoOrg||'curso'] || VOCABULARIOS.curso;
  const wb = XLSX.utils.book_new();
  // Hoja 1: Miembros
  const ws1 = XLSX.utils.aoa_to_sheet([
    ['nombres','apellidos','telefono_contacto','nombre_contacto','email_contacto'],
    ['Juan','Pérez','912345678','María Pérez','maria@email.com'],
    ['Ana','González','987654321','Pedro González','pedro@email.com'],
  ]);
  ws1['!cols']=[{wch:18},{wch:18},{wch:16},{wch:22},{wch:26}];
  XLSX.utils.book_append_sheet(wb,ws1,v.miembros);
  // Hoja 2: Cuotas
  const ws2 = XLSX.utils.aoa_to_sheet([
    ['nombre','tipo','monto','mes_inicio','mes_fin','anio'],
    ['Cuota mensual','mensual','5000','Marzo','Diciembre','2026'],
    ['Cuota anual','anual','50000','','','2026'],
    ['Paseo fin de año','extraordinaria','15000','','','2026'],
  ]);
  ws2['!cols']=[{wch:22},{wch:14},{wch:10},{wch:12},{wch:12},{wch:8}];
  XLSX.utils.book_append_sheet(wb,ws2,'Cuotas');
  // Hoja 3: Pagos
  const ws3 = XLSX.utils.aoa_to_sheet([
    ['apellidos_miembro','nombres_miembro','nombre_cuota','periodo','monto','fecha','medio'],
    ['Pérez','Juan','Cuota mensual','Marzo','5000','2026-03-10','Transferencia'],
    ['González','Ana','Cuota mensual','Marzo','5000','2026-03-15','Efectivo'],
  ]);
  ws3['!cols']=[{wch:18},{wch:18},{wch:20},{wch:12},{wch:10},{wch:12},{wch:14}];
  XLSX.utils.book_append_sheet(wb,ws3,'Pagos históricos');
  // Hoja 4: Movimientos
  const ws4 = XLSX.utils.aoa_to_sheet([
    ['tipo','descripcion','monto','categoria','fecha','responsable'],
    ['gasto','Materiales kermés','25000','Material','2026-04-15','Juan Tesorero'],
    ['ingreso','Rifa de marzo','45000','Rifa','2026-03-20','Juan Tesorero'],
  ]);
  ws4['!cols']=[{wch:10},{wch:28},{wch:10},{wch:14},{wch:12},{wch:18}];
  XLSX.utils.book_append_sheet(wb,ws4,'Gastos e Ingresos');
  XLSX.writeFile(wb,'Plantilla_Tesorero_App.xlsx');
  showToast('✅ Plantilla descargada');
}

function detectarCol(headers,opciones){
  const h=headers.map(x=>String(x||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,''));
  for(const op of opciones){ const idx=h.findIndex(x=>x.includes(op)); if(idx>=0) return idx; }
  return -1;
}

function procesarExcelImportado(input){
  const file=input.files[0]; if(!file) return;
  if(typeof XLSX==='undefined'){showToast('⚠️ Cargando librería, intenta en unos segundos');return;}
  const reader=new FileReader();
  reader.onload=function(e){
    try{
      const wb=XLSX.read(e.target.result,{type:'array'});
      const res=parsearExcel(wb);
      if(res) mostrarPreviewImport(res);
    }catch(err){ alert('Error al leer el archivo: '+err.message); }
  };
  reader.readAsArrayBuffer(file);
  input.value='';
}

function parsearExcel(wb){
  const res={miembros:[],cuotas:[],pagos:[],movimientos:[],errores:[]};
  const sn=wb.SheetNames.map(s=>s.toLowerCase());

  // Miembros
  const im=sn.findIndex(s=>['miembro','alumno','socio','vecino','integrante'].some(k=>s.includes(k)));
  if(im>=0){
    const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[im]],{header:1,defval:''});
    if(rows.length>1){
      const h=rows[0];
      const cN=detectarCol(h,['nombre','name','first']);
      const cA=detectarCol(h,['apellido','lastname','last']);
      const cT=detectarCol(h,['telefono','celular','fono','phone','tel','movil']);
      const cC=detectarCol(h,['contacto','apoderado','familiar','tutor']);
      const cE=detectarCol(h,['email','correo','mail']);
      for(let i=1;i<rows.length;i++){
        const r=rows[i];
        const nom=String(r[cN>=0?cN:0]||'').trim();
        const ape=String(r[cA>=0?cA:1]||'').trim();
        if(!nom&&!ape) continue;
        if(res.miembros.length>=150){res.errores.push('Límite de 150 miembros. Se importarán los primeros 150.');break;}
        res.miembros.push({nombres:nom,apellidos:ape,
          telefono:cT>=0?String(r[cT]||'').trim():'',
          nombreContacto:cC>=0?String(r[cC]||'').trim():'',
          email:cE>=0?String(r[cE]||'').trim():''});
      }
    }
  }

  // Cuotas
  const ic=sn.findIndex(s=>s.includes('cuota'));
  if(ic>=0){
    const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[ic]],{header:1,defval:''});
    if(rows.length>1){
      const h=rows[0];
      const cN=detectarCol(h,['nombre','cuota','descripcion']);
      const cT=detectarCol(h,['tipo','type']);
      const cM=detectarCol(h,['monto','precio','valor','amount']);
      const cI=detectarCol(h,['inicio','desde','start','mes_inicio']);
      const cF=detectarCol(h,['fin','hasta','end','termino','mes_fin']);
      for(let i=1;i<rows.length;i++){
        const r=rows[i];
        const nom=String(r[cN>=0?cN:0]||'').trim(); if(!nom) continue;
        const tipoStr=String(r[cT>=0?cT:1]||'').toLowerCase();
        const tipo=tipoStr.includes('anual')?'anual':tipoStr.includes('extra')?'extraordinaria':'mensual';
        const monto=parseInt(String(r[cM>=0?cM:2]||'0').replace(/\D/g,''))||0; if(!monto) continue;
        const mesI=MESES.findIndex(m=>m.toLowerCase()===String(r[cI>=0?cI:3]||'').trim().toLowerCase());
        const mesF=MESES.findIndex(m=>m.toLowerCase()===String(r[cF>=0?cF:4]||'').trim().toLowerCase());
        res.cuotas.push({nombre:nom,tipo,monto,mesInicio:mesI>=0?mesI:2,mesTermino:mesF>=0?mesF:11});
      }
    }
  }

  // Pagos
  const ip=sn.findIndex(s=>s.includes('pago'));
  if(ip>=0){
    const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[ip]],{header:1,defval:''});
    if(rows.length>1){
      const h=rows[0];
      const cA=detectarCol(h,['apellido','lastname']);
      const cN=detectarCol(h,['nombre','firstname']);
      const cC=detectarCol(h,['cuota','nombre_cuota','concepto']);
      const cP=detectarCol(h,['periodo','mes','period']);
      const cM=detectarCol(h,['monto','valor','amount']);
      const cF=detectarCol(h,['fecha','date']);
      const cMe=detectarCol(h,['medio','metodo','forma']);
      for(let i=1;i<rows.length;i++){
        const r=rows[i];
        const ape=String(r[cA>=0?cA:0]||'').trim();
        const nom=String(r[cN>=0?cN:1]||'').trim();
        if(!ape&&!nom) continue;
        const monto=parseInt(String(r[cM>=0?cM:4]||'0').replace(/\D/g,''))||0; if(!monto) continue;
        res.pagos.push({apellido:ape,nombre:nom,
          cuota:String(r[cC>=0?cC:2]||'').trim(),
          periodo:String(r[cP>=0?cP:3]||'').trim(),
          monto,fecha:String(r[cF>=0?cF:5]||'').trim(),
          medio:String(r[cMe>=0?cMe:6]||'Transferencia').trim()});
      }
    }
  }

  // Movimientos
  const iMov=sn.findIndex(s=>s.includes('gasto')||s.includes('ingreso')||s.includes('movimiento'));
  if(iMov>=0){
    const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[iMov]],{header:1,defval:''});
    if(rows.length>1){
      const h=rows[0];
      const cT=detectarCol(h,['tipo','type']);
      const cD=detectarCol(h,['descripcion','detalle','concepto','description']);
      const cM=detectarCol(h,['monto','valor','amount']);
      const cC=detectarCol(h,['categoria','category','rubro']);
      const cF=detectarCol(h,['fecha','date']);
      const cR=detectarCol(h,['responsable','persona','quien']);
      for(let i=1;i<rows.length;i++){
        const r=rows[i];
        const desc=String(r[cD>=0?cD:1]||'').trim(); if(!desc) continue;
        const monto=parseInt(String(r[cM>=0?cM:2]||'0').replace(/\D/g,''))||0; if(!monto) continue;
        const tipoStr=String(r[cT>=0?cT:0]||'').toLowerCase();
        res.movimientos.push({tipo:tipoStr.includes('ingreso')?'ingreso':'gasto',
          desc,monto,categoria:String(r[cC>=0?cC:3]||'Otro').trim(),
          fecha:String(r[cF>=0?cF:4]||isoToday()).trim(),
          responsable:String(r[cR>=0?cR:5]||'').trim()});
      }
    }
  }

  if(!res.miembros.length&&!res.cuotas.length&&!res.pagos.length&&!res.movimientos.length){
    alert('No se encontraron datos válidos.\n\nVerifica que las hojas del Excel tengan nombres como "Miembros", "Cuotas", "Pagos" o "Gastos e Ingresos".\n\nDescarga la plantilla para ver el formato exacto.');
    return null;
  }
  return res;
}

function previewCard(icon,label,count,ejemplos){
  if(!count) return `<div style="background:var(--bg);border-radius:12px;padding:12px;opacity:.5"><div style="font-size:11px;color:var(--t3);font-weight:700;text-transform:uppercase;margin-bottom:4px">${label}</div><div style="font-size:22px;font-weight:900;color:var(--t3)">0</div><div style="font-size:11px;color:var(--t3)">Sin datos</div></div>`;
  return `<div style="background:var(--gl);border-radius:12px;padding:12px"><div style="font-size:11px;color:var(--g);font-weight:700;text-transform:uppercase;margin-bottom:4px">${icon} ${label}</div><div style="font-size:28px;font-weight:900;color:var(--g);margin-bottom:6px">${count}</div>${ejemplos.map(e=>`<div style="font-size:11px;color:var(--t2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">• ${escHtml(String(e))}</div>`).join('')}${count>3?`<div style="font-size:11px;color:var(--t3);margin-top:2px">...y ${count-3} más</div>`:''}</div>`;
}

function mostrarPreviewImport(res){
  document.getElementById('modal-import-preview')?.remove();
  const overlay=document.createElement('div');
  overlay.id='modal-import-preview';
  overlay.style.cssText='position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px';
  const errHTML=res.errores.length?`<div style="background:#FFF0F0;border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:13px;color:#E24B4A">⚠️ ${res.errores.join('<br>')}</div>`:'';
  const resJson=JSON.stringify(res).replace(/</g,'\\u003c').replace(/'/g,"\\'");
  overlay.innerHTML=`
    <div style="background:#fff;border-radius:20px;padding:24px;max-width:460px;width:100%;max-height:90vh;overflow-y:auto">
      <div style="font-size:18px;font-weight:800;margin-bottom:6px">📊 Vista previa de importación</div>
      <div style="font-size:13px;color:var(--t2);margin-bottom:16px">Revisa los datos. No se reemplazarán registros existentes — solo se agregarán los nuevos.</div>
      ${errHTML}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:20px">
        ${previewCard('👥','Miembros',res.miembros.length,res.miembros.slice(0,3).map(m=>m.apellidos+', '+m.nombres))}
        ${previewCard('💳','Cuotas',res.cuotas.length,res.cuotas.slice(0,3).map(c=>c.nombre+' — '+clp(c.monto)))}
        ${previewCard('✅','Pagos',res.pagos.length,res.pagos.slice(0,3).map(p=>p.apellido+' · '+p.periodo))}
        ${previewCard('💸','Movimientos',res.movimientos.length,res.movimientos.slice(0,3).map(m=>m.desc+' · '+clp(m.monto)))}
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button onclick="document.getElementById('modal-import-preview').remove()" style="padding:10px 20px;border-radius:10px;border:1.5px solid var(--brd);background:#fff;font-size:14px;cursor:pointer;font-family:inherit">Cancelar</button>
        <button onclick="confirmarImportacion(window._importRes)" style="padding:10px 20px;border-radius:10px;border:none;background:var(--g);color:#fff;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit">✅ Importar todo</button>
      </div>
    </div>`;
  window._importRes=res;
  document.body.appendChild(overlay);
}

function confirmarImportacion(res){
  document.getElementById('modal-import-preview')?.remove();
  if(!res) return;
  let imp={miembros:0,cuotas:0,pagos:0,movimientos:0};
  if(!DB.alumnos) DB.alumnos=[];
  if(!DB.apoderados) DB.apoderados=[];
  if(!DB.cuotas) DB.cuotas=[];
  if(!DB.pagos) DB.pagos=[];
  if(!DB.movimientos) DB.movimientos=[];

  for(const m of res.miembros){
    const existe=DB.alumnos.find(a=>a.apellidos.toLowerCase()===m.apellidos.toLowerCase()&&a.nombres.toLowerCase()===m.nombres.toLowerCase());
    if(existe) continue;
    const aluId=uid();
    DB.alumnos.push({id:aluId,cursoId:S.cursoId,nombres:m.nombres,apellidos:m.apellidos,
      pin:String(Math.floor(1000+Math.random()*9000)),estado:'activo',creadoPor:'importacion'});
    if(m.nombreContacto||m.telefono)
      DB.apoderados.push({id:uid(),alumnoId:aluId,
        nombre:m.nombreContacto||m.nombres+' '+m.apellidos,
        telefono:m.telefono,email:m.email,estado:'activo',principal:true});
    imp.miembros++;
  }

  for(const c of res.cuotas){
    const existe=DB.cuotas.find(q=>q.nombre.toLowerCase()===c.nombre.toLowerCase()&&q.cursoId===S.cursoId);
    if(existe) continue;
    DB.cuotas.push({id:uid(),cursoId:S.cursoId,nombre:c.nombre,tipo:c.tipo,monto:c.monto,
      mesInicio:c.mesInicio,mesTermino:c.mesTermino,anio:new Date().getFullYear(),activa:true});
    imp.cuotas++;
  }

  for(const p of res.pagos){
    const alu=DB.alumnos.find(a=>a.apellidos.toLowerCase().includes(p.apellido.toLowerCase())||a.nombres.toLowerCase().includes(p.nombre.toLowerCase()));
    if(!alu) continue;
    const cuota=DB.cuotas.find(q=>q.cursoId===S.cursoId&&q.nombre.toLowerCase().includes(p.cuota.toLowerCase()));
    if(!cuota) continue;
    const existe=DB.pagos.find(pg=>pg.alumnoId===alu.id&&pg.cuotaId===cuota.id&&pg.periodo===p.periodo);
    if(existe) continue;
    DB.pagos.push({id:uid(),cuotaId:cuota.id,alumnoId:alu.id,periodo:p.periodo,monto:p.monto,
      fecha:p.fecha||isoToday(),estado:'pagado',medio:p.medio||'Transferencia',
      obs:'Importado desde Excel',creadoPor:'importacion'});
    imp.pagos++;
  }

  for(const m of res.movimientos){
    const existe=DB.movimientos.find(x=>x.cursoId===S.cursoId&&(x.desc||x.descripcion||'').toLowerCase()===m.desc.toLowerCase()&&x.monto===m.monto&&x.fecha===m.fecha);
    if(existe) continue;
    DB.movimientos.push({id:uid(),cursoId:S.cursoId,tipo:m.tipo,desc:m.desc,descripcion:m.desc,
      monto:m.monto,categoria:m.categoria,fecha:m.fecha||isoToday(),
      responsable:m.responsable,visible:true,archivos:[],creadoPor:'importacion'});
    imp.movimientos++;
  }

  saveDB();
  const resumen=[
    imp.miembros   ?`👥 ${imp.miembros} miembro${imp.miembros!==1?'s':''}`:'',
    imp.cuotas     ?`💳 ${imp.cuotas} cuota${imp.cuotas!==1?'s':''}`:'',
    imp.pagos      ?`✅ ${imp.pagos} pago${imp.pagos!==1?'s':''}`:'',
    imp.movimientos?`💸 ${imp.movimientos} movimiento${imp.movimientos!==1?'s':''}`:'',
  ].filter(Boolean).join(' · ');
  showToast('✅ Importado: '+(resumen||'Sin datos nuevos'));
  go('config');
}

// ─── SUPABASE STORAGE — COMPROBANTES ────────────────────────────────────────
