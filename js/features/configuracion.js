// js/features/configuracion.js — extraído de la copia de demostración.
function renderConfig(){
  const cur = getCurso();
  const usr = S.session;

  // ── Visor: acceso restringido ────────────────────────────────────────────
  if (esVisor()) {
    const col = (DB.colegios||[]).find(c=>c.id===cur.colegioId);
    return `
    <div class="page-hdr"><div class="page-title">Configuración</div></div>
    <div class="card" style="text-align:center;padding:36px 24px">
      <div style="font-size:48px;margin-bottom:12px">🔒</div>
      <div style="font-size:17px;font-weight:800;color:var(--t1);margin-bottom:8px">Acceso restringido</div>
      <div style="font-size:14px;color:var(--t3);margin-bottom:20px;max-width:320px;margin-left:auto;margin-right:auto">
        El rol <strong>Visor</strong> tiene acceso de solo lectura. La configuración de la cuenta y del curso está reservada al administrador.
      </div>
      <div style="background:var(--gl);border-radius:12px;padding:16px 20px;display:inline-block;text-align:left;margin:0 auto">
        <div style="font-size:12px;color:var(--t3);font-weight:700;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">Curso activo</div>
        <div style="font-size:15px;font-weight:700;color:var(--t1)">${escHtml(cur.nombre||'')} · ${cur.anio||''}</div>
        ${col?`<div style="font-size:13px;color:var(--t3);margin-top:2px">${escHtml(col.nombre||'')}</div>`:''}
      </div>
    </div>`;
  }
  // ────────────────────────────────────────────────────────────────────────

  const misCursos = (DB.cursos||[]).filter(c=>(usr.cursoIds||[]).includes(c.id));
  const colegiosMap = {};
  (DB.colegios||[]).forEach(c=>colegiosMap[c.id]=c);

  return `
  <div class="page-hdr"><div class="page-title">Configuración</div></div>

  <!-- TIPO DE ORGANIZACIÓN -->
  <div class="card" style="margin-bottom:14px;border:2px solid var(--g);background:var(--gl)">
    <div class="card-title" style="margin-bottom:12px">🏢 Tipo de organización</div>
    <p style="font-size:13px;color:var(--t2);margin-bottom:14px">Adapta el lenguaje de la app a tu tipo de organización. Los menús, botones y etiquetas se ajustan automáticamente.</p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">
      ${Object.entries(VOCABULARIOS).map(([key,v])=>{
        const activo = (DB.config?.tipoOrg||'curso')===key;
        return `<button type="button" onclick="cambiarTipoOrg('${key}')"
          style="padding:10px 12px;border-radius:10px;border:2px solid ${activo?'var(--g)':'var(--brd)'};background:${activo?'var(--g)':'var(--wh)'};color:${activo?'#fff':'var(--ink)'};cursor:pointer;text-align:left;font-family:inherit;transition:.2s">
          <div style="font-size:18px;margin-bottom:4px">${v.icono}</div>
          <div style="font-size:13px;font-weight:${activo?'700':'500'}">${v.nombre}</div>
          <div style="font-size:11px;opacity:.7;margin-top:2px">${v.miembro} · ${v.grupo}</div>
        </button>`;
      }).join('')}
    </div>
    ${(DB.config?.tipoOrg||'curso')==='personalizado'?`
    <div style="border-top:1px solid var(--brd);padding-top:14px;margin-top:4px">
      <div style="font-size:12px;font-weight:700;color:var(--t2);margin-bottom:10px">PERSONALIZAR TÉRMINOS</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        ${[
          ['miembro','Miembro (singular)','Ej: Socio, Vecino, Jugador'],
          ['miembros','Miembros (plural)','Ej: Socios, Vecinos, Jugadores'],
          ['contacto','Contacto (singular)','Ej: Familiar, Apoderado'],
          ['grupo','Grupo (singular)','Ej: Equipo, Sector, Curso'],
          ['institucion','Institución','Ej: Club, Junta, Colegio'],
          ['gestor','Gestor','Ej: Tesorero/a, Secretario/a'],
        ].map(([k,label,ph])=>`
          <div class="fg" style="margin:0">
            <label class="fl">${label}</label>
            <input class="fi" style="font-size:13px" placeholder="${ph}"
              value="${escHtml(DB.config?.vocabCustom?.[k]||VOCABULARIOS.personalizado[k]||'')}"
              onchange="setVocabCustom('${k}',this.value)">
          </div>`).join('')}
      </div>
    </div>`:``}
    <div style="font-size:12px;background:rgba(15,110,86,.08);border-radius:8px;padding:8px 12px;margin-top:8px;color:var(--g)">
      <strong>Activo:</strong> ${V('icono')} ${V('nombre')} — ${V('miembro')} · ${V('grupo')} · ${V('institucion')}
    </div>
  </div>

  <!-- MIS ${V('grupos').toUpperCase()} -->
  <div class="card" style="margin-bottom:14px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px">
      <div class="card-title" style="margin:0">🏫 Mis cursos</div>
      <button class="btn bp bs" onclick="showModal('addCursoModal')">+ Agregar ${V('grupo').toLowerCase()}</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;max-height:520px;overflow-y:auto;padding-right:4px">
      ${misCursos.map(c=>{
        const col = colegiosMap[c.colegioId]||{};
        const esActivo = c.id === S.cursoId;
        return `<div style="display:flex;align-items:center;gap:10px;padding:12px 14px;border:1.5px solid ${esActivo?'var(--gm)':'var(--brd)'};border-radius:10px;background:${esActivo?'var(--gl)':'var(--wh)'}">
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:14px">${escHtml(c.nombre)} <span style="font-size:12px;color:var(--t3)">· ${c.anio}</span></div>
            <div style="font-size:12px;color:var(--t3);margin-top:2px">${escHtml(col.nombre||('Sin '+V('institucion')))} · Código: <code style="font-weight:700">${c.codigo||'—'}</code></div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            ${esActivo
              ? `<span class="badge bgg" style="align-self:center">Activo</span>`
              : `<button class="btn bs bp" onclick="selectCurso('${c.id}')" style="font-size:12px;padding:4px 10px">Ir →</button>`
            }
            ${misCursos.length > 1
              ? `<button class="btn bs bd" onclick="confirmarQuitarCurso('${c.id}')" title="Desvincular este curso" style="font-size:12px;padding:4px 8px">✕</button>`
              : ''
            }
          </div>
        </div>`;
      }).join('')}
    </div>
    <p style="font-size:12px;color:var(--t3);margin-top:10px">
      Puedes gestionar múltiples cursos de distintos colegios desde una sola cuenta. Usa "Ir →" para cambiar de curso activo.
    </p>
  </div>

  <div class="card" style="margin-bottom:14px">
    <div class="card-title">👤 Mi cuenta</div>
    <div class="fg-row">
      <div class="fg">
        <label class="fl">Nombre completo</label>
        <input class="fi" id="cfg-usr-nombre" value="${escHtml(usr.nombre||'')}">
      </div>
      <div class="fg">
        <label class="fl">Correo (usuario de acceso)</label>
        <input class="fi" id="cfg-usr-email" type="email" value="${escHtml(usr.email||'')}">
      </div>
      <div class="fg">
        <label class="fl">Nueva contraseña</label>
        <input class="fi" id="cfg-usr-pass" type="password" placeholder="Dejar vacío para no cambiar" autocomplete="new-password">
      </div>
      <div class="fg">
        <label class="fl">Confirmar nueva contraseña</label>
        <input class="fi" id="cfg-usr-pass2" type="password" placeholder="Repetir contraseña" autocomplete="new-password">
      </div>
    </div>
    <div id="cuenta-msg" style="display:none;margin-bottom:10px"></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn bp" onclick="saveCuenta()">Guardar datos de cuenta</button>
      <button class="btn" onclick="verMiCodigoRecuperacion()" title="Ver tu código de recuperación">🔑 Ver código de recuperación</button>
    </div>
  </div>

  <div class="card" style="margin-bottom:14px">
    <div class="card-title">🔗 URL de la app</div>
    <p style="font-size:13px;color:var(--t2);margin-bottom:10px">
      Esta URL se incluye en los mensajes de WhatsApp que envías a los apoderados. Debe ser la dirección de tu app en Netlify.
    </p>
    <div class="fg" style="margin-bottom:10px">
      <label class="fl">URL de Netlify</label>
      <input class="fi" id="cfg-app-url" type="url"
        placeholder="https://app.eltesorero.cl"
        value="${escHtml(DB.config?.appUrl||'https://app.eltesorero.cl')}">
    </div>
    ${!DB.config?.appUrl ? `<div class="alert ab" style="margin-bottom:10px">
      ⚠️ Sin URL configurada los mensajes de WhatsApp no incluirán el enlace correcto.
    </div>` : `<div class="alert ag" style="margin-bottom:10px">
      ✓ URL configurada: <strong>${escHtml(DB.config.appUrl)}</strong>
    </div>`}
    <button class="btn bp" onclick="saveAppUrl()">💾 Guardar URL</button>
  </div>

  <div class="card" style="margin-bottom:14px">
    <div class="card-title">Datos del ${V('grupo')}</div>
    <div class="fg-row">
      <div class="fg"><label class="fl">Nombre de la ${V('institucion')}</label><input class="fi" id="cfg-colegio" value="${escHtml((DB.colegios||[]).find(c=>c.id===cur.colegioId)?.nombre||'')}"></div>
      <div class="fg"><label class="fl">Nombre del ${V('grupo')}</label><input class="fi" id="cfg-nombre" value="${escHtml(cur.nombre||'')}"></div>
      <div class="fg"><label class="fl">Año / Temporada</label><input class="fi" id="cfg-anio" type="number" value="${cur.anio||2026}"></div>
      <div class="fg"><label class="fl">Nombre del ${V('gestor')}</label><input class="fi" id="cfg-tesorero" value="${escHtml(cur.tesorero||'')}"></div>
      <div class="fg"><label class="fl">Cuota mensual (CLP)</label><input class="fi" id="cfg-men" type="number" value="${cur.cuotaMensual||0}"></div>
      <div class="fg"><label class="fl">Mes de inicio de cuotas</label>
        <select class="fs" id="cfg-mes-inicio">
          ${['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'].map((m,i)=>`<option value="${i}" ${(cur.mesInicioCuota!==undefined?cur.mesInicioCuota:vocab().mesInicioDefault)===i?'selected':''}>${m}</option>`).join('')}
        </select>
      </div>
      <div class="fg"><label class="fl">Mes de término de cuotas</label>
        <select class="fs" id="cfg-mes-termino">
          ${['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'].map((m,i)=>`<option value="${i}" ${(cur.mesTerminoCuota!==undefined?cur.mesTerminoCuota:vocab().mesFinDefault)===i?'selected':''}>${m}</option>`).join('')}
        </select>
      </div>
      <div class="fg"><label class="fl">Cuota anual (CLP)</label><input class="fi" id="cfg-anu" type="number" value="${cur.cuotaAnual||0}"></div>
    </div>
    <button class="btn bp" onclick="saveCfg()">Guardar cambios</button>
  </div>
  <div class="card" style="margin-bottom:14px">
    <div class="card-title">Código de acceso del curso</div>
    <div class="highlight-box">
      <div style="font-size:28px;font-weight:900;letter-spacing:3px;color:var(--g);font-family:monospace">${cur.codigo||'—'}</div>
      <div style="font-size:13px;color:var(--t3);margin-top:6px">Comparte este código con los apoderados para que accedan como lectores</div>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn" onclick="copyCodigo()">📋 Copiar código</button>
      <button class="btn" onclick="regenCodigo()">🔄 Regenerar código</button>
    </div>
  </div>

  <div class="card" style="margin-bottom:14px">
    <div class="card-title">👥 Acceso compartido del curso</div>
    <p style="font-size:13px;color:var(--t2);margin-bottom:12px">
      Un código único que da acceso a <strong>toda la información del curso</strong> sin PIN individual. Ideal para directivos o cursos donde no importa la privacidad por alumno.
    </p>
    ${(()=>{
      const cc = getCurso()?.codigoCompartido;
      if(cc){
        return '<div style="background:var(--gl);border-radius:10px;padding:12px 16px;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">'
          +'<div><div style="font-size:11px;color:var(--t3);margin-bottom:2px">Código activo</div>'
          +'<code style="font-size:18px;font-weight:700;letter-spacing:2px;color:var(--g)">'+escHtml(cc)+'</code></div>'
          +'<div style="display:flex;gap:6px">'
          +'<button class="btn bs" onclick="copiarCodigoCompartido()">📋</button>'
          +'<button class="btn bs bd" onclick="desactivarCodigoCompartido()">🗑 Desactivar</button>'
          +'</div></div>'
          +'<div style="font-size:12px;color:var(--a);margin-bottom:12px">⚠️ Quien tenga este código puede ver <strong>todos</strong> los datos del curso.</div>'
          +'<button class="btn bp" onclick="generarCodigoCompartido()" style="font-size:13px">🔄 Regenerar código</button>';
      }
      return '<div class="alert ab" style="margin-bottom:12px">No hay código compartido activo. El acceso es solo por PIN individual.</div>'
        +'<button class="btn bp" onclick="generarCodigoCompartido()" style="font-size:13px">+ Generar código compartido</button>';
    })()}
  </div>
  ${esOwner() ? `
  <div class="card">
    <div class="card-title">🎟️ Códigos de acceso</div>
    <p style="font-size:13px;color:var(--t2);margin-bottom:10px">
      Genera códigos para que otros tesoreros puedan registrarse. Los códigos de <strong>prueba</strong> dan 30 días gratis. Los <strong>VIP</strong> dan acceso ilimitado sin costo.
    </p>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:6px">
      <div style="background:var(--gl);border:1px solid var(--gm)30;border-radius:10px;padding:10px;text-align:center">
        <div style="font-size:11px;color:var(--t3);margin-bottom:6px;font-weight:600">PRUEBA · 30 DÍAS</div>
        <button class="btn bp" style="width:100%;justify-content:center;font-size:12px" onclick="generarCodigoInvitacion()">+ Generar código</button>
        <button class="btn bp" style="width:100%;justify-content:center;font-size:12px;margin-top:4px" onclick="generarLoteInvitaciones(5)">+ Generar 5 códigos</button>
      </div>
      <div style="background:#EFF6FF;border:1px solid #2563EB30;border-radius:10px;padding:10px;text-align:center">
        <div style="font-size:11px;color:#2563EB;margin-bottom:6px;font-weight:600">💳 PLAN PRO · 1 AÑO</div>
        <button class="btn" style="width:100%;justify-content:center;font-size:12px;background:#2563EB;color:#fff;border:none" onclick="generarCodigoAnual()">+ Generar código</button>
        <div style="font-size:10px;color:#2563EB;margin-top:6px">Para usuarios de pago</div>
      </div>
      <div style="background:#FFF8E7;border:1px solid #EF9F2730;border-radius:10px;padding:10px;text-align:center">
        <div style="font-size:11px;color:#B8860B;margin-bottom:6px;font-weight:600">⭐ VIP · ILIMITADO</div>
        <button class="btn" style="width:100%;justify-content:center;font-size:12px;background:#EF9F27;color:#fff;border:none" onclick="generarCodigoVIP()">+ Generar código VIP</button>
        <div style="font-size:10px;color:#B8860B;margin-top:6px">Para amigos y cercanos</div>
      </div>
    </div>
    <div style="font-size:11px;color:var(--t3);margin-bottom:12px;text-align:center">
      Tu número de WhatsApp para solicitudes: 
      <strong id="config-tu-tel" style="color:var(--g);cursor:pointer" onclick="configurarTelAdmin()">${DB.config?.telAdmin||'⚙️ Configurar'}</strong>
    </div>
    <div id="lista-invitaciones">
      ${renderListaInvitaciones()}
    </div>

  </div>` : ''}
  <div class="card">
    <div class="card-title">📝 Plantilla de mensaje de pago</div>
    <p style="font-size:13px;color:var(--t2);margin-bottom:12px">
      Este mensaje se usa al notificar al apoderado por WhatsApp o correo. También puedes editarlo en el momento de registrar cada pago.
    </p>
    <div style="background:var(--bl);border:1px solid #85B7EB;border-radius:8px;padding:10px 14px;font-size:12px;color:#185FA5;margin-bottom:12px;line-height:1.7">
      <strong>Variables disponibles</strong> (se reemplazan automáticamente):<br>
      <code style="background:rgba(0,0,0,.06);border-radius:3px;padding:1px 5px">{alumno}</code> nombre del alumno &nbsp;·&nbsp;
      <code style="background:rgba(0,0,0,.06);border-radius:3px;padding:1px 5px">{cuota}</code> nombre de la cuota &nbsp;·&nbsp;
      <code style="background:rgba(0,0,0,.06);border-radius:3px;padding:1px 5px">{periodo}</code> mes/año &nbsp;·&nbsp;
      <code style="background:rgba(0,0,0,.06);border-radius:3px;padding:1px 5px">{monto}</code> monto CLP &nbsp;·&nbsp;
      <code style="background:rgba(0,0,0,.06);border-radius:3px;padding:1px 5px">{fecha}</code> fecha &nbsp;·&nbsp;
      <code style="background:rgba(0,0,0,.06);border-radius:3px;padding:1px 5px">{medio}</code> medio de pago &nbsp;·&nbsp;
      <code style="background:rgba(0,0,0,.06);border-radius:3px;padding:1px 5px">{curso}</code> &nbsp;·&nbsp;
      <code style="background:rgba(0,0,0,.06);border-radius:3px;padding:1px 5px">{colegio}</code>
    </div>
    <div style="position:relative">
      <textarea id="cfg-plantilla"
        style="width:100%;min-height:160px;resize:none;padding:12px 14px;border:1.5px solid var(--brd);border-radius:8px;font-size:13px;font-family:inherit;color:var(--t2);background:var(--wh);line-height:1.7;outline:none;-webkit-user-select:text;user-select:text;touch-action:manipulation"
        onfocus="this.style.borderColor='var(--gm)'" onblur="this.style.borderColor='var(--brd)'"
        placeholder="Escribe tu plantilla aquí usando las variables de arriba…"
      >${escHtml(DB.config?.plantillaPago||PLANTILLA_PAGO_DEFAULT)}</textarea>
    </div>
    <div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap">
      <button class="btn bp" onclick="savePlantillaCfg()">💾 Guardar plantilla</button>
      <button class="btn" onclick="resetPlantillaCfg()">↩ Restaurar</button>
      <button class="btn bs" onclick="document.getElementById('cfg-plantilla').blur()" style="font-size:12px">⌨️ Cerrar teclado</button>
    </div>
    ${DB.config?.plantillaPago?`<div style="font-size:12px;color:var(--gm);margin-top:8px;font-weight:600">✓ Tienes una plantilla personalizada activa</div>`:''}
  </div>
  <div class="card" id="card-migracion">
    <div class="card-title">📦 Importar datos de versión anterior</div>
    <p style="font-size:13px;color:var(--t2);margin-bottom:14px">
      Si usaste una versión anterior de Tesorero en este mismo navegador y quieres recuperar esos datos (alumnos, pagos, movimientos), presiona el botón. La app buscará automáticamente los datos guardados.
    </p>
    <div id="migracion-resultado"></div>
    <button class="btn bp" onclick="intentarMigracion()">🔄 Buscar y recuperar datos anteriores</button>
  </div>
  <!-- DATOS BANCARIOS -->
  <div class="card">
    <div class="card-title">🏦 Datos bancarios para transferencias</div>
    <p style="font-size:13px;color:var(--t3);margin-bottom:14px">Los apoderados podrán ver y copiar estos datos para realizar sus pagos.</p>
    <div style="display:grid;gap:10px">
      <div class="fg" style="margin:0"><label class="fl">Nombre titular</label><input class="fi" id="banco-nombre" placeholder="Nombre completo" value="${escHtml(cur?.banco?.nombre||'')}"></div>
      <div class="fg" style="margin:0"><label class="fl">RUT</label><input class="fi" id="banco-rut" placeholder="12.345.678-9" value="${escHtml(cur?.banco?.rut||'')}"></div>
      <div class="fg" style="margin:0"><label class="fl">Banco</label>
        <select class="fi" id="banco-banco">
          ${['','Banco de Chile','Banco Santander','BancoEstado','Scotiabank','BICE','Itaú','Falabella','Ripley','Security','Consorcio','HSBC','BCI','Mercado Pago','Mach','Tenpo'].map(b=>`<option value="${b}" ${(cur?.banco?.banco||'')==b?'selected':''}>${b||'— Seleccionar —'}</option>`).join('')}
        </select>
      </div>
      <div class="fg" style="margin:0"><label class="fl">Tipo de cuenta</label>
        <select class="fi" id="banco-tipo">
          ${['','Cuenta Corriente','Cuenta Vista','Cuenta de Ahorro','Cuenta RUT'].map(t=>`<option value="${t}" ${(cur?.banco?.tipo||'')==t?'selected':''}>${t||'— Seleccionar —'}</option>`).join('')}
        </select>
      </div>
      <div class="fg" style="margin:0"><label class="fl">Número de cuenta</label><input class="fi" id="banco-cuenta" placeholder="123456789" value="${escHtml(cur?.banco?.cuenta||'')}"></div>
      <div class="fg" style="margin:0"><label class="fl">Correo para comprobante</label><input class="fi" id="banco-email" type="email" placeholder="correo@mail.cl" value="${escHtml(cur?.banco?.email||'')}"></div>
    </div>
    <button class="btn bp" style="margin-top:14px" onclick="saveDatosBancarios()">💾 Guardar datos bancarios</button>
    <div id="banco-msg" style="display:none;margin-top:10px"></div>
  </div>

  <!-- EXPORTAR / IMPORTAR -->
  <div class="card">
    <div class="card-title">📤 Respaldo de datos</div>
    <p style="font-size:13px;color:var(--t3);margin-bottom:10px">Exporta tus datos como archivo de respaldo o impórtalos desde otro dispositivo.</p>
    ${(()=>{
      const ur = previewStorage.getItem('tesorero_ultimo_respaldo');
      if(!ur) return '';
      const dias = Math.floor((new Date() - new Date(ur)) / (1000*60*60*24));
      const color = dias >= 30 ? 'var(--r)' : dias >= 14 ? 'var(--a)' : 'var(--g)';
      const icono = dias >= 30 ? '⚠️' : dias >= 14 ? '🕐' : '✅';
      const txt   = dias === 0 ? 'Hoy' : dias === 1 ? 'Ayer' : 'Hace ' + dias + ' días';
      return '<div style="display:flex;align-items:center;gap:8px;background:var(--bg);border-radius:8px;padding:8px 12px;margin-bottom:12px;font-size:13px">' +
        '<span>' + icono + '</span>' +
        '<div><span style="color:var(--t3)">Último respaldo: </span><strong style="color:' + color + '">' + txt + '</strong></div>' +
        '</div>';
    })()}
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">
      <button class="btn bp" onclick="forzarSincronizacion()" style="background:var(--g);color:#fff;border:none">
        ☁️ Sincronizar con la nube ahora
      </button>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn bp" onclick="exportarDatosConFecha()">⬇️ Exportar mis datos</button>
      <label class="btn" style="cursor:pointer">⬆️ Importar datos<input type="file" accept=".json" style="display:none" onchange="importarDatos(event)"></label>
    </div>
    <div id="export-msg" style="display:none;margin-top:10px"></div>
  </div>

  <!-- MANTENIMIENTO DE DATOS -->
  <div class="card" style="border:2px solid #D97706;background:#FFFBF0">
    <div class="card-title" style="color:#D97706">🔧 Mantenimiento de datos</div>
    <p style="font-size:13px;color:var(--t2);margin-bottom:14px">
      Detecta y corrige inconsistencias en la base de datos local.
    </p>
    ${(()=>{
      const huerfanos = (DB.planesPago||[]).filter(p=>{
        if(!p.activo) return false;
        return !(DB.cuotas||[]).find(q=>q.id===p.cuotaId);
      });
      const afectados = [...new Set(huerfanos.map(p=>{
        const a=(DB.alumnos||[]).find(x=>x.id===p.alumnoId);
        return a?(a.apellidos+', '+a.nombres):p.alumnoId;
      }))];
      if(!huerfanos.length) return `
        <div style="display:flex;align-items:center;gap:8px;background:#E1F5EE;border-radius:8px;padding:10px 14px;font-size:13px;color:#085041">
          ✅ Sin planes de pago huérfanos detectados.
        </div>`;
      return `
        <div style="background:#FFF0F0;border-radius:8px;padding:12px 14px;margin-bottom:12px;font-size:13px">
          <div style="font-weight:700;color:#E24B4A;margin-bottom:6px">⚠️ ${huerfanos.length} plan${huerfanos.length!==1?'es':''} sin cuota asociada:</div>
          <div style="color:var(--t2)">${afectados.map(n=>`• ${escHtml(n)}`).join('<br>')}</div>
          <div style="font-size:12px;color:var(--t3);margin-top:6px">Generan deuda fantasma en Cobranza y el badge 📅 incorrecto en Pagos.</div>
        </div>
        <button class="btn" onclick="limpiarPlanesHuerfanos()" style="background:#E24B4A;color:#fff;border:none;font-weight:700">
          🧹 Eliminar planes huérfanos (${huerfanos.length})
        </button>`;
    })()}
    <div style="margin-top:14px;padding-top:14px;border-top:1px solid rgba(217,119,6,0.2)">
      <button class="btn" onclick="forzarMigracionComprobantes(this)" style="background:#2563EB;color:#fff;border:none;font-weight:700;font-size:13px;width:100%">
        ☁️ Sincronizar comprobantes con la nube
      </button>
      <div style="font-size:12px;color:var(--t3);margin-top:6px">Sube todos los comprobantes locales a Supabase para que los apoderados puedan verlos.</div>
    </div>
  </div>

  <!-- IMPORTAR / EXPORTAR EXCEL -->
  <div class="card" style="margin-bottom:14px;border:2px solid #2563EB;background:#EFF6FF">
    <div class="card-title" style="color:#2563EB">📊 Importar / Exportar Excel</div>
    <p style="font-size:13px;color:var(--t2);margin-bottom:16px">
      Importa miembros, cuotas, pagos históricos y movimientos desde Excel. También puedes descargar una plantilla con el formato exacto para llenarla y subirla.
    </p>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn bp bs" onclick="descargarPlantillaExcel()" style="font-size:13px">
        ⬇️ Descargar plantilla Excel
      </button>
      <button class="btn bp" onclick="document.getElementById('excel-import-input').click()" style="font-size:13px;background:#2563EB;border-color:#2563EB">
        ⬆️ Subir Excel con mis datos
      </button>
      <input type="file" id="excel-import-input" accept=".xlsx,.xls,.csv" style="display:none" onchange="procesarExcelImportado(this)">
    </div>
    <div style="margin-top:12px;background:rgba(37,99,235,0.06);border-radius:8px;padding:10px 14px">
      <div style="font-size:12px;font-weight:700;color:#2563EB;margin-bottom:6px">📋 La plantilla incluye 4 hojas:</div>
      <div style="font-size:12px;color:var(--t2);line-height:1.8">
        <span style="font-weight:600">1. Miembros</span> — nombre, apellido, teléfono, email del contacto<br>
        <span style="font-weight:600">2. Cuotas</span> — nombre, tipo, monto y período<br>
        <span style="font-weight:600">3. Pagos históricos</span> — quién pagó, qué cuota, cuándo y cuánto<br>
        <span style="font-weight:600">4. Gastos e Ingresos</span> — descripción, monto, categoría y fecha
      </div>
    </div>
  </div>

  <!-- NUEVO AÑO ACADÉMICO -->
  <div class="card" style="border:2px solid var(--b)40;background:var(--bl)20">
    <div class="card-title" style="color:var(--b)">📅 Nuevo año académico</div>
    <p style="font-size:13px;color:var(--t2);margin-bottom:14px">
      Migra todos los alumnos y apoderados al año ${(getCurso()?.anio||2026)+1}. 
      Se conservan los datos de contacto y se limpian los pagos, cuotas y movimientos del año anterior.
    </p>
    <div style="background:#fff;border:1px solid var(--brd);border-radius:10px;padding:12px;margin-bottom:14px;font-size:13px">
      <div style="font-weight:700;margin-bottom:8px;color:var(--t1)">¿Qué se conserva y qué se limpia?</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
        <div style="color:#0F6E56">✅ Alumnos y apoderados</div>
        <div style="color:#E24B4A">🗑 Pagos del año anterior</div>
        <div style="color:#0F6E56">✅ Datos bancarios</div>
        <div style="color:#E24B4A">🗑 Cuotas del año anterior</div>
        <div style="color:#0F6E56">✅ PINs de acceso</div>
        <div style="color:#E24B4A">🗑 Ingresos y gastos</div>
        <div style="color:#0F6E56">✅ Configuración del curso</div>
        <div style="color:#E24B4A">🗑 Comprobantes adjuntos</div>
      </div>
    </div>
    <button class="btn" style="background:var(--b);color:#fff;font-weight:700" onclick="migrarNuevoAnio()">
      📅 Iniciar año ${(getCurso()?.anio||2026)+1}
    </button>
    <div id="migracion-anio-msg" style="display:none;margin-top:10px"></div>
  </div>

  <div class="card" style="margin-bottom:14px">
    <div class="card-title">🎓 Fondo Especial</div>
    <p style="font-size:13px;color:var(--t2);margin-bottom:14px">
      Activa esta opción si tu curso maneja un fondo individual por alumno (ej: fondo de viaje, de egreso, de licenciatura). 
      Al activarlo aparecerán las secciones <strong>Actividades</strong> y <strong>Fondo Especial</strong> en el menú.
    </p>
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px">
      ${getCurso()?.fondoEspecial?.activo
        ? `<button class="btn bp" onclick="toggleFondoEspecial(false)" style="background:var(--g);border:none;color:#fff;font-weight:700;padding:8px 18px;border-radius:8px;cursor:pointer">✅ Activado — toca para desactivar</button>`
        : `<button class="btn" onclick="toggleFondoEspecial(true)" style="background:#eee;border:1px solid var(--brd);font-weight:700;padding:8px 18px;border-radius:8px;cursor:pointer">⭕ Desactivado — toca para activar</button>`
      }
    </div>
    ${getCurso()?.fondoEspecial?.activo?`
    <div class="fg">
      <label class="fl">Nombre del fondo</label>
      <input class="fi" id="cfg-fondo-nombre" value="${escHtml(getCurso()?.fondoEspecial?.nombre||'Fondo Especial')}" placeholder="Ej: Fondo de Viaje, Fondo de Egreso">
    </div>
    <button class="btn bp" onclick="guardarNombreFondo()">💾 Guardar nombre</button>
    `:''}
  </div>

  ${esOwner() ? `
  <div class="card" style="margin-bottom:14px">
    <div class="card-title">👥 Gestión de usuarios</div>
    <p style="font-size:13px;color:var(--t2);margin-bottom:10px">Usuarios registrados con código de invitación. Puedes ver cuántos días les quedan y activar su plan.</p>
    <div style="position:relative;margin-bottom:12px">
      <input class="fi" id="buscador-usuarios" placeholder="🔍 Buscar por nombre o correo..." oninput="filtrarUsuarios(this.value)" style="padding-left:14px">
    </div>
    <div id="lista-usuarios-admin">${renderUsuariosAdmin()}</div>
  </div>` : ''}

  <!-- PLANTILLAS COBRANZA -->
  <div class="card" style="margin-bottom:14px">
    <div class="card-title">💬 Plantillas de cobranza</div>
    <p style="font-size:13px;color:var(--t2);margin-bottom:10px">
      Edita los mensajes que se usan en el módulo de Cobranza. Puedes usar emojis y personalizar el tono.
    </p>
    <div style="background:var(--bg);border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:12px;color:var(--t2)">
      <strong>Variables disponibles</strong> (se reemplazan automáticamente):<br>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">
        ${['{apoderado}','{alumno}','{periodo}','{monto}','{tesorero}','{curso}'].map(v=>`<code style="background:var(--wh);border:1px solid var(--brd);border-radius:4px;padding:2px 6px;font-size:11px">${v}</code>`).join('')}
      </div>
    </div>
    ${renderPlantillasCobranzaHtml()}
    <button class="btn bp" onclick="guardarPlantillasCobranza()">💾 Guardar plantillas</button>
  </div>

    <!-- ZONA DE PELIGRO -->
  <div class="card">
    <div class="card-title" style="color:var(--r)">Zona de peligro</div>
    <p style="font-size:14px;color:var(--t2);margin-bottom:14px">Borra todos los datos registrados y parte desde cero. Esta acción no se puede deshacer.</p>
    <button class="btn bd" onclick="resetDemo()">⚠️ Limpiar todos los datos y partir de cero</button>
  </div>`;
}
