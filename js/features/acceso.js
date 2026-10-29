// js/features/acceso.js — extraído de la copia de demostración.
function renderLogin(){
  return `
  <div class="login-wrap">
    <div class="login-card">
      <div class="login-logo" style="position:relative">${getLogoEstacional()}</div>
      ${getBannerEstacional()}
      <div class="login-sub">Administración financiera de cursos escolares</div>
      <div style="display:flex;align-items:center;justify-content:center;gap:6px;margin-bottom:6px;margin-top:-10px">
        <div style="width:18px;height:18px;background:linear-gradient(135deg,var(--g),var(--gm));border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;font-weight:900">J</div>
        <span style="font-size:10px;color:var(--t3)">by <strong style="color:var(--g)">Juvenal</strong> · v${APP_VERSION}</span>
      </div>
      <div class="tabs">
        <div class="tab active" id="tab-login"   onclick="switchLoginTab('login')">Iniciar sesión</div>
        <div class="tab"        id="tab-registro" onclick="switchLoginTab('registro')">Crear cuenta</div>
        <div class="tab"        id="tab-codigo"   onclick="switchLoginTab('codigo')">Soy apoderado</div>
      </div>


      <!-- PANEL LOGIN -->
      <div id="panel-login">
        <div class="fg"><label class="fl">Correo electrónico</label><input class="fi" id="l-email" type="email" placeholder="correo@mail.cl" autocomplete="email"></div>
        <div class="fg"><label class="fl">Contraseña</label><div style="position:relative"><input class="fi" id="l-pass" type="password" placeholder="••••••••" autocomplete="current-password" style="padding-right:44px"><button type="button" onclick="toggleVerPass('l-pass',this)" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;font-size:18px;color:var(--t3);padding:0;line-height:1" title="Mostrar contraseña">👁</button></div></div>
        <div style="display:flex;align-items:center;gap:8px;margin:6px 0 2px">
          <input type="checkbox" id="l-recordar" style="width:16px;height:16px;cursor:pointer;accent-color:var(--gm)">
          <label for="l-recordar" style="font-size:13px;color:var(--t2);cursor:pointer;user-select:none">Recordar mis credenciales</label>
        </div>
        <div id="login-err" class="alert ar" style="display:none"></div>
        <button class="btn bp" style="width:100%;justify-content:center;margin-top:4px" onclick="doLogin()">Ingresar</button>

        <!-- Acceso rápido — solo visible si hay usuario u1 configurado -->
        <div id="acceso-rapido" style="display:none;margin-top:12px;border:1px dashed var(--gm);border-radius:10px;padding:12px 14px;background:var(--gl)">
          <div style="font-size:12px;font-weight:700;color:var(--g);margin-bottom:6px">🔑 Acceso rápido</div>
          <div style="font-size:12px;color:var(--t2);margin-bottom:8px">
            Usuario: <code style="background:#fff;padding:1px 6px;border-radius:4px;font-weight:700">demo@example.invalid</code>
          </div>
          <button class="btn bp bs" style="width:100%;justify-content:center" onclick="accesoRapido()">
            → Rellenar email
          </button>
        </div>

        <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;margin-top:10px">
          <p style="font-size:12px;color:var(--t3)">
            ¿Eres tesorero/a de otro curso? <span style="color:var(--gm);cursor:pointer;font-weight:600" onclick="switchLoginTab('registro')">Crea tu cuenta →</span>
          </p>
          <p style="font-size:12px;color:var(--t3)">
            <span style="color:var(--b);cursor:pointer;font-weight:600" onclick="switchLoginTab('recuperar')">¿Olvidaste tu contraseña?</span>
          </p>
        </div>
      </div>

      <!-- PANEL RECUPERAR CONTRASEÑA -->
      <div id="panel-recuperar" style="display:none">
        <div class="alert ab" style="margin-bottom:14px">
          Ingresa tu correo y el <strong>código de recuperación</strong> que guardaste al registrarte para establecer una nueva contraseña.
        </div>
        <div class="fg"><label class="fl">Correo electrónico</label>
          <input class="fi" id="rec-email" type="email" placeholder="tucorreo@mail.cl">
        </div>
        <div class="fg"><label class="fl">Código de recuperación</label>
          <input class="fi" id="rec-codigo" placeholder="Ej: REC-XXXX-XXXX-XXXX"
            style="font-size:14px;letter-spacing:1px;text-transform:uppercase"
            oninput="this.value=this.value.toUpperCase()">
        </div>
        <div class="fg"><label class="fl">Nueva contraseña</label>
          <input class="fi" id="rec-pass" type="password" placeholder="Mínimo 6 caracteres" autocomplete="new-password">
        </div>
        <div class="fg"><label class="fl">Confirmar contraseña</label>
          <input class="fi" id="rec-pass2" type="password" placeholder="Repetir contraseña" autocomplete="new-password">
        </div>
        <div id="rec-err" class="alert ar" style="display:none;margin-bottom:8px"></div>
        <div id="rec-ok" class="alert ag" style="display:none;margin-bottom:8px"></div>
        <button class="btn bp" style="width:100%;justify-content:center" onclick="doRecuperar()">Restablecer contraseña</button>
        <p style="margin-top:12px;font-size:12px;color:var(--t3);text-align:center">
          <span style="color:var(--gm);cursor:pointer;font-weight:600" onclick="switchLoginTab('login')">← Volver a iniciar sesión</span>
        </p>
      </div>

      <!-- PANEL REGISTRO -->
      <div id="panel-registro" style="display:none">
        <div class="alert ab" style="margin-bottom:14px">
          Crea tu propia cuenta de tesorero/a. Necesitas un <strong>código de invitación</strong> para registrarte.
        </div>
        <div class="fg">
          <label class="fl">Código de invitación</label>
          <input class="fi" id="r-invitacion" placeholder="Ingresa el código que te entregaron"
            style="font-size:16px;letter-spacing:1px;text-transform:uppercase;font-weight:600"
            oninput="this.value=this.value.toUpperCase()">
          <div style="margin-top:8px;font-size:12px;color:var(--t3)">
            ¿No tienes código? 
            <span style="color:var(--gm);font-weight:600;cursor:pointer" onclick="mostrarSolicitudCodigo()">Solicita uno aquí →</span>
          </div>
        </div>
        <!-- Panel solicitud de código -->
        <div id="panel-solicitud-codigo" style="display:none;background:var(--gl);border:1px solid var(--gm)30;border-radius:12px;padding:14px;margin-bottom:10px">
          <div style="font-size:13px;font-weight:700;color:var(--g);margin-bottom:10px">📩 Solicitar código de acceso</div>
          <div class="fg" style="margin-bottom:8px"><label class="fl">Tu nombre</label><input class="fi" id="sol-nombre" placeholder="Nombre completo"></div>
          <div class="fg" style="margin-bottom:8px"><label class="fl">Tu correo</label><input class="fi" id="sol-email" type="email" placeholder="correo@mail.cl"></div>
          <div class="fg" style="margin-bottom:10px"><label class="fl">Tu colegio</label><input class="fi" id="sol-colegio" placeholder="Nombre del establecimiento"></div>
          <button onclick="enviarSolicitudCodigo()" class="btn bp" style="width:100%;justify-content:center">Enviar solicitud →</button>
          <div id="sol-msg" style="display:none;margin-top:8px"></div>
        </div>
        <div style="height:1px;background:var(--brd);margin:14px 0"></div>
        <div class="fg"><label class="fl">Tu nombre completo</label><input class="fi" id="r-nombre" placeholder="Ej: Ana Torres"></div>
        <div class="fg">
          <label class="fl">Región</label>
          <select class="fi" id="r-region" onchange="actualizarComunas()">
            <option value="">— Selecciona tu región —</option>
          </select>
        </div>
        <div class="fg">
          <label class="fl">Comuna</label>
          <select class="fi" id="r-comuna" onchange="actualizarColegios()" disabled>
            <option value="">— Primero elige una región —</option>
          </select>
        </div>
        <div class="fg">
          <label class="fl">Colegio / Escuela</label>
          <select class="fi" id="r-colegio-sel" onchange="manejarSeleccionColegio()" disabled>
            <option value="">— Primero elige una comuna —</option>
          </select>
        </div>
        <div class="fg" id="fg-colegio-manual" style="display:none">
          <label class="fl">Nombre de la institución (escríbelo)</label>
          <input class="fi" id="r-colegio" placeholder="Nombre completo del establecimiento">
          <div style="font-size:11px;color:var(--gm);margin-top:4px">✅ Este establecimiento quedará registrado para otros tesoreros</div>
        </div>
        <input type="hidden" id="r-colegio-hidden">
        <div class="fg-row">
          <div class="fg"><label class="fl">Curso</label><input class="fi" id="r-curso" placeholder="Ej: 3° Medio A"></div>
          <div class="fg"><label class="fl">Año</label><input class="fi" id="r-anio" type="number" value="2026" min="2020" max="2099"></div>
        </div>
        <div class="fg"><label class="fl">Correo de acceso</label><input class="fi" id="r-email" type="email" placeholder="tucorreo@mail.cl"></div>
        <div class="fg-row">
          <div class="fg"><label class="fl">Contraseña</label><input class="fi" id="r-pass" type="password" placeholder="Mínimo 6 caracteres" autocomplete="new-password"></div>
          <div class="fg"><label class="fl">Confirmar contraseña</label><input class="fi" id="r-pass2" type="password" placeholder="Repetir" autocomplete="new-password"></div>
        </div>
        <div class="fg"><label class="fl">Cuota mensual (CLP)</label><input class="fi" id="r-cuota" type="number" placeholder="Ej: 5000"></div>
        <div class="fg"><label class="fl">Mes de inicio de cuotas</label>
          <select class="fs" id="r-mes-inicio">
            <option value="0">Enero</option>
            <option value="1">Febrero</option>
            <option value="2" selected>Marzo</option>
            <option value="3">Abril</option>
            <option value="4">Mayo</option>
            <option value="5">Junio</option>
            <option value="6">Julio</option>
            <option value="7">Agosto</option>
            <option value="8">Septiembre</option>
            <option value="9">Octubre</option>
            <option value="10">Noviembre</option>
            <option value="11">Diciembre</option>
          </select>
        </div>
        <div class="fg"><label class="fl">Mes de término de cuotas</label>
          <select class="fs" id="r-mes-termino">
            <option value="0">Enero</option>
            <option value="1">Febrero</option>
            <option value="2">Marzo</option>
            <option value="3">Abril</option>
            <option value="4">Mayo</option>
            <option value="5">Junio</option>
            <option value="6">Julio</option>
            <option value="7">Agosto</option>
            <option value="8">Septiembre</option>
            <option value="9">Octubre</option>
            <option value="10">Noviembre</option>
            <option value="11" selected>Diciembre</option>
          </select>
        </div>
        <div id="registro-err" class="alert ar" style="display:none;margin-bottom:8px"></div>
        <button class="btn bp" style="width:100%;justify-content:center" onclick="doRegistro()">Crear cuenta y entrar →</button>
        <p style="margin-top:12px;font-size:12px;color:var(--t3);text-align:center">
          ¿Ya tienes cuenta? <span style="color:var(--gm);cursor:pointer;font-weight:600" onclick="switchLoginTab('login')">Inicia sesión →</span>
        </p>
      </div>

      <!-- PANEL CÓDIGO APODERADO -->
      <div id="panel-codigo" style="display:none">
        <!-- ACCESO RÁPIDO APODERADO (solo visible en pestaña Soy apoderado) -->
        <div id="panel-ap-rapido" style="display:none;margin-bottom:12px">
          <div style="background:var(--bl);border:1px solid var(--b)40;border-radius:12px;padding:14px 16px">
            <div style="font-size:12px;color:var(--t3);margin-bottom:8px">👋 Bienvenido/a de vuelta</div>
            <div id="ap-rapido-nombre" style="font-size:15px;font-weight:700;color:var(--t1);margin-bottom:10px"></div>
            <button onclick="reingresarApoderado()" style="width:100%;background:var(--b);border:none;color:#fff;padding:10px;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer">
              → Ingresar a mi cuenta
            </button>
            <div style="text-align:center;margin-top:8px">
              <span style="font-size:12px;color:var(--t3);cursor:pointer" onclick="limpiarSesionApoderado()">
                Ingresar con otro código →
              </span>
            </div>
          </div>
        </div>
        <!-- PASO 1: Código del curso -->
        <div id="paso-codigo">
          <div class="alert ab" style="margin-bottom:14px">
            Ingresa el código único que te entregó el tesorero del curso.
          </div>
          <div class="fg">
            <label class="fl">Código del curso</label>
            <input class="fi" id="l-codigo" type="text" placeholder="Ej: 5BB-2026-SSCC"
              style="font-size:18px;letter-spacing:2px;text-transform:uppercase">
          </div>
          <div id="codigo-err" class="alert ar" style="display:none;margin-bottom:8px"></div>
          <button class="btn bp" style="width:100%;justify-content:center" onclick="doVerificarCodigo()">
            Verificar código →
          </button>
        </div>

        <!-- PASO 2: Seleccionar alumno -->
        <div id="paso-alumno" style="display:none">
          <div class="alert ag" style="margin-bottom:14px">
            <strong id="paso2-curso-nombre"></strong><br>
            <span style="font-size:12px">Selecciona el nombre de tu hijo/a.</span>
          </div>
          <div class="fg" style="margin-bottom:10px">
            <label class="fl" id="label-busq-miembro">Buscar...</label>
            <input class="fi" id="busq-alumno-ap" placeholder="Escribe el nombre o apellido..."
              oninput="filtrarAlumnosSelector(this.value)">
          </div>
          <div id="lista-alumnos-selector" style="display:flex;flex-direction:column;gap:6px;max-height:260px;overflow-y:auto;margin-bottom:12px"></div>
          <div id="alumno-err" class="alert ar" style="display:none;margin-bottom:8px"></div>
          <div style="display:flex;gap:8px">
            <button class="btn" style="flex:1;justify-content:center" onclick="volverPaso1()">← Volver</button>
            <button class="btn bp" style="flex:2;justify-content:center" onclick="irPaso3()">Continuar →</button>
          </div>
        </div>

        <!-- PASO 3: PIN personal -->
        <div id="paso-pin" style="display:none">
          <div class="alert ag" style="margin-bottom:14px">
            <strong id="paso3-alumno-nombre"></strong><br>
            <span style="font-size:12px">Ingresa el PIN personal que te entregó el tesorero del curso.</span>
          </div>
          <div class="fg" style="margin-bottom:6px">
            <label class="fl">PIN de acceso</label>
            <input class="fi" id="l-pin" type="password" placeholder="••••••"
              style="font-size:24px;letter-spacing:6px;text-align:center"
              maxlength="10"
              oninput="document.getElementById('pin-err').style.display='none'"
              onkeydown="if(event.key==='Enter') doAccesoCodigo()">
          </div>
          <div id="pin-err" class="alert ar" style="display:none;margin-bottom:8px"></div>
          <div style="font-size:12px;color:var(--t3);margin-bottom:10px;text-align:center">
            ¿No tienes PIN? Solicítalo al tesorero del curso.
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;justify-content:center">
            <input type="checkbox" id="ap-recordar" style="width:16px;height:16px;cursor:pointer;accent-color:var(--gm)">
            <label for="ap-recordar" style="font-size:13px;color:var(--t2);cursor:pointer;user-select:none">Recordar mi acceso</label>
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn" style="flex:1;justify-content:center" onclick="volverPaso2()">← Volver</button>
            <button class="btn bp" style="flex:2;justify-content:center" onclick="doAccesoCodigo()">Acceder →</button>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}
function bindLogin(){
  var le=document.getElementById('l-email');
  var lp=document.getElementById('l-pass');
  var lc=document.getElementById('l-codigo');
  if(le) le.addEventListener('keydown',function(e){if(e.key==='Enter')doLogin();});
  if(lp) lp.addEventListener('keydown',function(e){if(e.key==='Enter')doLogin();});
  if(lc) lc.addEventListener('keydown',function(e){if(e.key==='Enter')doVerificarCodigo();});
  if(lc) lc.addEventListener('input',function(e){e.target.value=e.target.value.toUpperCase();});
  // Mostrar panel acceso rápido si apoderado tiene credenciales guardadas
  if(previewStorage.getItem('tesorero_ap_recordar')==='1'){
    var apAluId = previewStorage.getItem('tesorero_ap_aluId');
    var apAlu = (DB.alumnos||[]).find(function(a){return a.id===apAluId;});
    var nombreAp = apAlu ? (apAlu.nombres+' '+apAlu.apellidos) : 'tu alumno/a';
    var panelRapido = document.getElementById('panel-ap-rapido');
    var nombreEl = document.getElementById('ap-rapido-nombre');
    if(panelRapido){ panelRapido.style.display=''; }
    if(nombreEl){ nombreEl.textContent = '👨‍👩‍👧 Apoderado de '+nombreAp; }
  }

  // Auto-login apoderado si tiene sesión guardada (y no acaba de cerrar sesión)
  if(!window._skipApAutoLogin && previewStorage.getItem('tesorero_ap_recordar')==='1'){
    var apCursoId = previewStorage.getItem('tesorero_ap_cursoId');
    var apAluId   = previewStorage.getItem('tesorero_ap_aluId');
    var apPin     = previewStorage.getItem('tesorero_ap_pin');
    if(apCursoId && apAluId && apPin){
      // Buscar primero en DB local
      var apCurso = (DB.cursos||[]).find(function(c){return c.id===apCursoId;});
      var apAlu   = (DB.alumnos||[]).find(function(a){return a.id===apAluId;});
      if(apCurso && apAlu && String(apAlu.pin).trim()===apPin){
        // Sesión válida — crear sesión y cargar datos frescos antes de mostrar dashboard
        S.session={id:'ap_lector',nombre:'Apoderado de '+apAlu.nombres,rol:'apoderado_lector',cursoIds:[apCursoId],alumnoId:apAluId,alumnoNombre:apAlu.nombres+' '+apAlu.apellidos};
        S.cursoId=apCursoId;
        const tesoreroId = apCurso.tesoreraId || (DB.usuarios||[])[0]?.id || 'u1';
        sbGet('tesorero_datos','usuario_id=eq.'+encodeURIComponent(tesoreroId))
          .then(function(rows){ if(rows&&rows.length>0&&rows[0].datos) mergeDB(rows[0].datos); })
          .catch(function(){})
          .finally(function(){ go('dashboard'); });
        return;
      }
      // No encontrado localmente — buscar en Supabase con fetch parcial
      mostrarCargando('Cargando tu información...');
      fetch(SUPA_URL+'/rest/v1/tesorero_datos?select=usuario_id,datos->cursos,datos->alumnos',{
        headers:{'apikey':SUPA_KEY,'Authorization':'Bearer '+(_authToken||SUPA_KEY)}
      }).then(function(r){return r.json();}).then(async function(rows){
        for(var i=0;i<(rows||[]).length;i++){
          const cursos  = rows[i].cursos  || [];
          const alumnos = rows[i].alumnos || [];
          const c = cursos.find(function(x){return x.id===apCursoId;});
          if(!c) continue;
          const a = alumnos.find(function(x){return x.id===apAluId;});
          if(!a || String(a.pin).trim()!==apPin) continue;
          // Encontrado — cargar datos completos solo de este usuario
          const full = await sbGet('tesorero_datos','usuario_id=eq.'+encodeURIComponent(rows[i].usuario_id));
          if(full && full.length > 0 && full[0].datos){
            mergeDB(full[0].datos);
          }
          S.session={id:'ap_lector',nombre:'Apoderado de '+a.nombres,rol:'apoderado_lector',cursoIds:[apCursoId],alumnoId:apAluId,alumnoNombre:a.nombres+' '+a.apellidos};
          S.cursoId=apCursoId;
          go('dashboard');
          return;
        }
        // No encontrado — mostrar login normal
        render();
      }).catch(function(){render();});
      return;
    }
  }
  // Aplicar deep link si viene desde un link especial
  aplicarDeepLinkSiExiste();

  // Cargar credenciales guardadas (solo rellena el formulario — la autenticación real es via Supabase Auth)
  if(previewStorage.getItem('tesorero_recordar')==='1'){
    const savedEmail = previewStorage.getItem('tesorero_saved_email') || '';
    const savedPass  = previewStorage.getItem('tesorero_saved_pass')  || '';
    if(le) le.value = savedEmail;
    if(lp) lp.value = savedPass;
    const rc = document.getElementById('l-recordar');
    if(rc) rc.checked = true;
    // Solo intentar auto-login si el usuario ya tiene sesión activa en Supabase Auth
    // (authClient.auth.getSession lo maneja en initApp — no volver a cargar todos los datos)
  }
}

function accesoRapido(){
  // Solo rellena el email — la contraseña la escribe el usuario por seguridad
  document.getElementById('l-email').value = 'demo@example.invalid';
  document.getElementById('l-pass').focus();
}
function reingresarApoderado(){
  var apCursoId = previewStorage.getItem('tesorero_ap_cursoId');
  var apAluId   = previewStorage.getItem('tesorero_ap_aluId');
  var apPin     = previewStorage.getItem('tesorero_ap_pin');
  if(!apCursoId||!apAluId||!apPin){ switchLoginTab('codigo'); return; }

  mostrarCargando('Cargando tu información...');
  // Buscar en DB local primero
  var apCurso = (DB.cursos||[]).find(function(c){return c.id===apCursoId;});
  var apAlu   = (DB.alumnos||[]).find(function(a){return a.id===apAluId;});
  if(apCurso && apAlu && String(apAlu.pin).trim()===apPin){
    S.session={id:'ap_lector',nombre:'Apoderado de '+apAlu.nombres,rol:'apoderado_lector',cursoIds:[apCursoId],alumnoId:apAluId,alumnoNombre:apAlu.nombres+' '+apAlu.apellidos};
    S.cursoId=apCursoId;
    go('dashboard');
    return;
  }
  // Buscar en Supabase con fetch parcial
  fetch(SUPA_URL+'/rest/v1/tesorero_datos?select=usuario_id,datos->cursos,datos->alumnos',{
    headers:{'apikey':SUPA_KEY,'Authorization':'Bearer '+(_authToken||SUPA_KEY)}
  }).then(function(r){return r.json();}).then(async function(rows){
    for(var i=0;i<(rows||[]).length;i++){
      const cursos  = rows[i].cursos  || [];
      const alumnos = rows[i].alumnos || [];
      const c = cursos.find(function(x){return x.id===apCursoId;});
      if(!c) continue;
      const a = alumnos.find(function(x){return x.id===apAluId;});
      if(!a || String(a.pin).trim()!==apPin) continue;
      const full = await sbGet('tesorero_datos','usuario_id=eq.'+encodeURIComponent(rows[i].usuario_id));
      if(full && full.length > 0 && full[0].datos){ mergeDB(full[0].datos); }
      S.session={id:'ap_lector',nombre:'Apoderado de '+a.nombres,rol:'apoderado_lector',cursoIds:[apCursoId],alumnoId:apAluId,alumnoNombre:a.nombres+' '+a.apellidos};
      S.cursoId=apCursoId;
      go('dashboard');
      return;
    }
    render(); // no encontrado
  }).catch(function(){render();});
}

function switchLoginTab(t){
  ['login','registro','codigo','recuperar'].forEach(id=>{
    document.getElementById('tab-'+id)?.classList.toggle('active', id===t);
    const p=document.getElementById('panel-'+id);
    if(p) p.style.display = id===t ? '' : 'none';
  });
  // Al abrir el registro, inicializar selectores y cargar colegios desde Supabase
  if(t==='registro'){
    inicializarSelectoresRegistro();
    cargarColegiosSuapabase();
  }
}

function cargarColegiosSuapabase(){
  // Cargar colegios registrados por otros usuarios desde Supabase
  fetch(SUPA_URL+'/rest/v1/tesorero_datos?usuario_id=eq.colegios_chile&select=datos',{
    headers:{'apikey':SUPA_KEY,'Authorization':'Bearer '+(_authToken||SUPA_KEY)}
  }).then(r=>r.json()).then(rows=>{
    if(rows && rows[0] && rows[0].datos && rows[0].datos.colegiosRegistrados){
      const remotos = rows[0].datos.colegiosRegistrados;
      if(!DB.colegiosRegistrados) DB.colegiosRegistrados=[];
      remotos.forEach(c=>{
        const existe = DB.colegiosRegistrados.some(x=>x.nombre===c.nombre&&x.comuna===c.comuna);
        if(!existe) DB.colegiosRegistrados.push(c);
      });
    }
  }).catch(()=>{});
}
function mergeDB(datosNube){
  if(!datosNube||!datosNube.usuarios) return;
  function merge(a,b,k){k=k||'id';var m={};(a||[]).forEach(function(x){m[x[k]]=x;});(b||[]).forEach(function(x){m[x[k]]=x;});return Object.values(m);}
  DB.usuarios  =merge(DB.usuarios,  datosNube.usuarios);
  DB.colegios  =merge(DB.colegios,  datosNube.colegios);
  DB.cursos    =merge(DB.cursos,    datosNube.cursos);
  DB.alumnos   =merge(DB.alumnos,   datosNube.alumnos);
  DB.apoderados=merge(DB.apoderados,datosNube.apoderados);
  DB.cuotas    =merge(DB.cuotas,    datosNube.cuotas);
  DB.pagos     =merge(DB.pagos,     datosNube.pagos);
  DB.movimientos=merge(DB.movimientos,datosNube.movimientos);
  if(datosNube.config) DB.config=datosNube.config;
  previewStorage.setItem(KEY, JSON.stringify(DB));
}

// Flujo de login legacy — ahora que las contraseñas viven en Supabase Auth,
// la búsqueda se hace solo por email. El savedPass se mantiene en previewStorage
// solo para compatibilidad con versiones anteriores pero no se usa para autenticar.
function irDashboard(email){
  const u=(DB.usuarios||[]).find(function(x){return x.email.toLowerCase()===email;});
  if(!u) return false;
  setUserKey(u.id);
  S.session=u;
  if(u.cursoIds&&u.cursoIds.length===1){S.cursoId=u.cursoIds[0];go('dashboard');}
  else{go('selector');}
  return true;
}

function mostrarCargando(msg){
  var app=document.getElementById('app');
  if(app) app.innerHTML='<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:16px;color:#0F6E56"><div style="font-size:32px">cloud</div><div style="font-weight:600">'+msg+'</div></div>';
}

async function doLogin(){
  const email=document.getElementById('l-email').value.trim().toLowerCase();
  const pass=document.getElementById('l-pass').value;
  const errEl=document.getElementById('login-err');
  const btn=document.querySelector('[onclick="doLogin()"]');

  if(!email||!pass){
    if(errEl){errEl.textContent='Ingresa tu correo y contraseña.';errEl.style.display='';}
    return;
  }

  if(btn){btn.disabled=true;btn.textContent='Ingresando...';}
  if(errEl){errEl.textContent='Verificando...';errEl.style.display='';}

  try{
    // Intento 1: Supabase Auth con las credenciales ingresadas
    const okAuth = await loginConAuth(email, errEl);
    if(okAuth) return;

    // Intento 2: reusar sesión Supabase cacheada si el email coincide
    // (el usuario tiene JWT válido pero no recuerda su contraseña de Supabase)
    if(authClient){
      try{
        const { data: sd } = await authClient.auth.getSession();
        if(sd?.session?.user?.email?.toLowerCase()===email){
          _authToken = sd.session.access_token;
          const legacy = await buscarUsuarioLegacyPorEmail(sd.session.user.email, sd.session.user.id);
          if(legacy && legacy.datos){
            DB=legacy.datos; previewStorage.setItem(KEY,JSON.stringify(DB));
            _finalizarLogin({...legacy.user, authId:sd.session.user.id}, errEl);
            return;
          }
        }
      }catch(e2){}
    }

    // Intento 3: fallback local — contraseña guardada en previewStorage (u.pass)
    const uLocal=(DB.usuarios||[]).find(u=>
      String(u.email||'').toLowerCase()===email && u.pass===pass
    );
    if(uLocal){ _finalizarLogin(uLocal,errEl); return; }

    // Traducir el error real de Supabase a un mensaje útil
    if(errEl){
      const msg = (_lastAuthError?.message||'').toLowerCase();
      let textoFinal = 'Correo o contraseña incorrectos.';
      if(msg.includes('email not confirmed')){
        textoFinal = 'Tu correo aún no está confirmado. Revisa tu bandeja de entrada (o spam) y confirma tu cuenta.';
      } else if(msg.includes('too many requests') || msg.includes('rate limit')){
        textoFinal = 'Demasiados intentos. Espera unos minutos antes de volver a intentar.';
      } else if(msg.includes('user not found') || msg.includes('invalid login credentials')){
        textoFinal = 'Correo o contraseña incorrectos.';
      } else if(_lastAuthError?.message){
        // Error no reconocido — mostrar mensaje técnico para poder diagnosticar
        textoFinal = 'No se pudo iniciar sesión (' + _lastAuthError.message + '). Si el problema persiste, contáctanos.';
      }
      errEl.textContent = textoFinal;
      errEl.style.display='';
    }
  }catch(e){
    if(errEl){errEl.textContent='No fue posible iniciar sesión.';errEl.style.display='';}
  }finally{
    if(btn){btn.disabled=false;btn.textContent='Ingresar';}
  }
}
function _finalizarLogin(u,errEl){
  if(u.desactivado){if(errEl){errEl.textContent='Cuenta desactivada.';errEl.style.display='';}return;}
  if(errEl) errEl.style.display='none';
  S.session=u;
  setUserKey(u.id);
  const cloudId = u.authId || u.id; // UUID real de Supabase Auth para que pase el RLS
  loadFromCloud(cloudId).then(()=>{
    setTimeout(()=>migrarComprobantesAStorage().catch(()=>{}), 3000);
    setTimeout(()=>respaldoAutomatico(cloudId).catch(()=>{}), 5000);
  }).catch(()=>{});
  if(u.cursoIds&&u.cursoIds.length===1){S.cursoId=u.cursoIds[0];go('dashboard');}
  else{go('selector');}
}

/**
 * Finaliza el login en el flujo relacional v9.
 * NO llama a loadFromCloud(); los datos ya están en DB (cargados por cargarSesionV9).
 */
function _finalizarLoginV9(u, errEl, cursoIds) {
  if (errEl) errEl.style.display = 'none';
  S.session = u;
  S._v9CuentaId = u.id;  // UUID de tesorero_cuentas
  // En v9 sólo actualizamos KEY (para futuros saveDB) sin tocar DB,
  // porque cargarSesionV9() ya pobló DB desde las tablas relacionales.
  if (typeof _setUserKeyV9 === 'function') {
    try { _setUserKeyV9(u.id); } catch(_) {}
  }
  // Navegar al dashboard o al selector de cursos
  if (cursoIds && cursoIds.length === 1) {
    S.cursoId = cursoIds[0];
    go('dashboard');
  } else if (cursoIds && cursoIds.length > 1) {
    go('selector');
  } else {
    go('dashboard');
  }
}

async function respaldoAutomatico(userId){
  if(!userId || userId==='ap_lector') return;
  if(!_authToken) return; // sin token de auth no podemos subir al bucket privado
  try{
    const hoy = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const keyUltimo = 'tesorero_backup_'+userId;
    const ultimoRespaldo = previewStorage.getItem(keyUltimo);
    if(ultimoRespaldo === hoy) return; // ya se respaldó hoy

    const datosRespaldo = dbSinBase64();
    const contenido = JSON.stringify({ fecha: hoy, userId, datos: datosRespaldo });
    const blob = new Blob([contenido], { type: 'application/json' });
    const path = `respaldos/${userId}/${hoy}.json`;

    const res = await fetch(`${SUPA_URL}/storage/v1/object/${path}`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + _authToken,
        'apikey': SUPA_KEY,
        'Content-Type': 'application/json',
        'x-upsert': 'true',
      },
      body: blob,
    });

    if(res.ok || res.status===200){
      previewStorage.setItem(keyUltimo, hoy);
      console.log('✅ Respaldo automático guardado:', hoy);
    } else {
      console.warn('Respaldo: respuesta inesperada', res.status);
    }
  }catch(e){
    console.warn('Respaldo automático falló:', e?.message||e);
  }
}

// ─────────────────────────────────────────────
// DATOS CHILE — REGIONES, COMUNAS Y COLEGIOS
// ─────────────────────────────────────────────
const REGIONES_CHILE = {
  "Arica y Parinacota": ["Arica","Camarones","Putre","General Lagos"],
  "Tarapacá": ["Iquique","Alto Hospicio","Pozo Almonte","Camiña","Colchane","Huara","Pica"],
  "Antofagasta": ["Antofagasta","Mejillones","Sierra Gorda","Taltal","Calama","Ollagüe","San Pedro de Atacama","Tocopilla","María Elena"],
  "Atacama": ["Copiapó","Caldera","Tierra Amarilla","Chañaral","Diego de Almagro","Vallenar","Alto del Carmen","Freirina","Huasco"],
  "Coquimbo": ["La Serena","Coquimbo","Andacollo","La Higuera","Paiguano","Vicuña","Illapel","Canela","Los Vilos","Salamanca","Ovalle","Combarbalá","Monte Patria","Punitaqui","Río Hurtado"],
  "Valparaíso": ["Valparaíso","Casablanca","Concón","Juan Fernández","Puchuncaví","Quintero","Viña del Mar","Isla de Pascua","Los Andes","Calle Larga","Rinconada","San Esteban","La Ligua","Cabildo","Papudo","Petorca","Zapallar","Quillota","Calera","Hijuelas","La Cruz","Nogales","San Antonio","Algarrobo","Cartagena","El Quisco","El Tabo","Santo Domingo","San Felipe","Catemu","Llaillay","Panquehue","Putaendo","Santa María","Quilpué","Limache","Olmué","Villa Alemana"],
  "Metropolitana": ["Santiago","Cerrillos","Cerro Navia","Conchalí","El Bosque","Estación Central","Huechuraba","Independencia","La Cisterna","La Florida","La Granja","La Pintana","La Reina","Las Condes","Lo Barnechea","Lo Espejo","Lo Prado","Macul","Maipú","Ñuñoa","Pedro Aguirre Cerda","Peñalolén","Providencia","Pudahuel","Quilicura","Quinta Normal","Recoleta","Renca","San Joaquín","San Miguel","San Ramón","Vitacura","Puente Alto","Pirque","San José de Maipo","Colina","Lampa","Tiltil","San Bernardo","Buin","Calera de Tango","Paine","Melipilla","Alhué","Curacaví","María Pinto","San Pedro","Talagante","El Monte","Isla de Maipo","Padre Hurtado","Peñaflor"],
  "O'Higgins": ["Rancagua","Codegua","Coinco","Coltauco","Doñihue","Graneros","Las Cabras","Machalí","Malloa","Mostazal","Olivar","Peumo","Pichidegua","Quinta de Tilcoco","Rengo","Requínoa","San Vicente","Pichilemu","La Estrella","Litueche","Marchihue","Navidad","Paredones","San Fernando","Chépica","Chimbarongo","Lolol","Nancagua","Palmilla","Peralillo","Placilla","Pumanque","Santa Cruz"],
  "Maule": ["Talca","Constitución","Curepto","Empedrado","Maule","Pelarco","Pencahue","Río Claro","San Clemente","San Rafael","Cauquenes","Chanco","Pelluhue","Curicó","Hualañé","Licantén","Molina","Rauco","Romeral","Sagrada Familia","Teno","Vichuquén","Linares","Colbún","Longaví","Parral","Retiro","San Javier","Villa Alegre","Yerbas Buenas"],
  "Ñuble": ["Chillán","Bulnes","Cobquecura","Coelemu","Coihueco","Chillán Viejo","El Carmen","Ninhue","Ñiquén","Pemuco","Pinto","Portezuelo","Quillón","Quirihue","Ránquil","San Carlos","San Fabián","San Ignacio","San Nicolás","Treguaco","Yungay"],
  "Biobío": ["Concepción","Coronel","Chiguayante","Florida","Hualqui","Lota","Penco","San Pedro de la Paz","Santa Juana","Talcahuano","Tomé","Hualpén","Lebu","Arauco","Cañete","Contulmo","Curanilahue","Los Álamos","Tirúa","Los Ángeles","Antuco","Cabrero","Laja","Mulchén","Nacimiento","Negrete","Quilaco","Quilleco","San Rosendo","Santa Bárbara","Tucapel","Yumbel","Alto Biobío"],
  "La Araucanía": ["Temuco","Carahue","Cunco","Curarrehue","Freire","Galvarino","Gorbea","Lautaro","Loncoche","Melipeuco","Nueva Imperial","Padre Las Casas","Perquenco","Pitrufquén","Pucón","Saavedra","Teodoro Schmidt","Toltén","Vilcún","Villarrica","Cholchol","Angol","Collipulli","Curacautín","Ercilla","Lonquimay","Los Sauces","Lumaco","Purén","Renaico","Traiguén","Victoria"],
  "Los Ríos": ["Valdivia","Corral","Futrono","La Unión","Lago Ranco","Lanco","Los Lagos","Máfil","Mariquina","Paillaco","Panguipulli","Río Bueno"],
  "Los Lagos": ["Puerto Montt","Calbuco","Cochamó","Fresia","Frutillar","Los Muermos","Llanquihue","Maullín","Puerto Varas","Castro","Ancud","Chonchi","Curaco de Vélez","Dalcahue","Puqueldón","Queilén","Quellón","Quemchi","Quinchao","Osorno","Puerto Octay","Purranque","Puyehue","Río Negro","San Juan de la Costa","San Pablo","Chaitén","Futaleufú","Hualaihué","Palena"],
  "Aysén": ["Coihaique","Lago Verde","Aysén","Cisnes","Guaitecas","Cochrane","O'Higgins","Tortel","Chile Chico","Río Ibáñez"],
  "Magallanes": ["Punta Arenas","Laguna Blanca","Río Verde","San Gregorio","Cabo de Hornos","Antártica","Porvenir","Primavera","Timaukel","Natales","Torres del Paine"]
};

// Colegios conocidos por comuna (base inicial — se expande con registros de usuarios)
const COLEGIOS_BASE = {
  "Santiago": ["Liceo Aplicación","Liceo Barros Borgoño","Liceo 1 Javiera Carrera","Colegio San Ignacio","Colegio Sagrado Corazón","Instituto Nacional","Colegio Saint George's","Colegio The Grange School","Colegio Nido de Águilas"],
  "Las Condes": ["Colegio Manquecura Las Condes","Colegio Los Nogales","Colegio Alianza Francesa","Colegio Saint Gabriel's","Colegio Dunalastair"],
  "Providencia": ["Colegio Alianza Francesa","Instituto Alonso de Ercilla","Liceo Augusto D'Halmar"],
  "Maipú": ["Colegio Manquecura Maipú","Liceo Confederación Suiza","Colegio Mackay School"],
  "Puente Alto": ["Liceo Bicentenario Teresa Prats","Colegio Manquecura Puente Alto","Liceo Benjamín Vicuña Mackenna"],
  "Quilpué": ["Colegio Colegio de demostración","Liceo Bicentenario Quilpué","Colegio Pumahue Quilpué","Instituto Almirante Barroso"],
  "Viña del Mar": ["Colegio Alborada","Liceo Bicentenario Guillermo Rivera","Colegio San Rafael","Instituto Comercial de Viña del Mar"],
  "Valparaíso": ["Liceo Eduardo de la Barra","Colegio Alemán de Valparaíso","Instituto Superior de Comercio"],
  "Concepción": ["Liceo Enrique Molina Garmendia","Colegio Alemán de Concepción","Instituto Salesiano"],
  "Temuco": ["Liceo Pablo Neruda","Colegio Alemán de Temuco","Instituto Lastarria"],
  "Puerto Montt": ["Liceo Bicentenario Puerto Montt","Colegio Alemán de Puerto Montt","Instituto Comercial"],
  "La Serena": ["Liceo Gregorio Cordovez","Colegio Alemán de La Serena"],
  "Antofagasta": ["Liceo Domingo Santa María","Colegio Alemán de Antofagasta"],
  "Iquique": ["Liceo Luis Cruz Martínez","Colegio Inglés de Iquique"],
  "Rancagua": ["Liceo Oscár Castro","Colegio Inglés de Rancagua"],
  "Talca": ["Liceo Abate Molina","Colegio Alemán de Talca"],
};

function getColegiosComunaDB(comuna){
  // Primero los de la base estática
  const base = COLEGIOS_BASE[comuna] || [];
  // Luego los registrados por usuarios en DB
  const registrados = (DB.colegiosRegistrados||[])
    .filter(c=>c.comuna===comuna)
    .map(c=>c.nombre);
  // Combinar sin duplicados
  const todos = [...new Set([...base, ...registrados])];
  return todos.sort((a,b)=>a.localeCompare(b,'es'));
}

function inicializarSelectoresRegistro(){
  const sel = document.getElementById('r-region');
  if(!sel) return;
  sel.innerHTML = '<option value="">— Selecciona tu región —</option>';
  Object.keys(REGIONES_CHILE).sort().forEach(r=>{
    const o = document.createElement('option');
    o.value = r; o.textContent = r;
    sel.appendChild(o);
  });
}

function actualizarComunas(){
  const region = document.getElementById('r-region').value;
  const selComuna = document.getElementById('r-comuna');
  const selColegio = document.getElementById('r-colegio-sel');
  selComuna.innerHTML = '<option value="">— Selecciona tu comuna —</option>';
  selColegio.innerHTML = '<option value="">— Primero elige una comuna —</option>';
  selColegio.disabled = true;
  document.getElementById('fg-colegio-manual').style.display = 'none';
  if(!region){ selComuna.disabled=true; return; }
  selComuna.disabled = false;
  const comunas = REGIONES_CHILE[region] || [];
  comunas.sort().forEach(c=>{
    const o = document.createElement('option');
    o.value = c; o.textContent = c;
    selComuna.appendChild(o);
  });
}

function actualizarColegios(){
  const comuna = document.getElementById('r-comuna').value;
  const selColegio = document.getElementById('r-colegio-sel');
  document.getElementById('fg-colegio-manual').style.display = 'none';
  document.getElementById('r-colegio-hidden').value = '';
  if(!comuna){ selColegio.disabled=true; return; }
  selColegio.disabled = false;
  const colegios = getColegiosComunaDB(comuna);
  selColegio.innerHTML = '<option value="">— Selecciona tu colegio —</option>';
  colegios.forEach(c=>{
    const o = document.createElement('option');
    o.value = c; o.textContent = c;
    selColegio.appendChild(o);
  });
  // Opción para agregar uno nuevo
  const oNuevo = document.createElement('option');
  oNuevo.value = '__nuevo__';
  oNuevo.textContent = '➕ Mi '+V('institucion')+' no está en la lista...';
  selColegio.appendChild(oNuevo);
}

function manejarSeleccionColegio(){
  const val = document.getElementById('r-colegio-sel').value;
  const fgManual = document.getElementById('fg-colegio-manual');
  const inputManual = document.getElementById('r-colegio');
  const hidden = document.getElementById('r-colegio-hidden');
  if(val === '__nuevo__'){
    fgManual.style.display = '';
    inputManual.value = '';
    hidden.value = '';
    inputManual.focus();
  } else {
    fgManual.style.display = 'none';
    hidden.value = val;
    if(inputManual) inputManual.value = val;
  }
}

function registrarNuevoColegio(nombre, comuna, region){
  if(!nombre || !comuna) return;
  if(!DB.colegiosRegistrados) DB.colegiosRegistrados = [];
  const existe = DB.colegiosRegistrados.some(c=>
    c.nombre.toLowerCase()===nombre.toLowerCase() && c.comuna===comuna
  );
  if(!existe){
    DB.colegiosRegistrados.push({ nombre, comuna, region, fecha: isoToday() });
    // Guardar en Supabase también para que otros usuarios lo vean
    supaGuardar('colegios_chile', { colegiosRegistrados: DB.colegiosRegistrados }).catch(()=>{});
  }
}

async function doRegistro(){
  const invitacion = document.getElementById('r-invitacion').value.trim().toUpperCase();
  const nombre  = document.getElementById('r-nombre').value.trim();
  const region  = document.getElementById('r-region')?.value || '';
  const comuna  = document.getElementById('r-comuna')?.value || '';
  // Colegio: puede venir del selector o del campo manual
  const selColegio = document.getElementById('r-colegio-sel')?.value;
  const colegio = selColegio === '__nuevo__' || !selColegio
    ? (document.getElementById('r-colegio')?.value.trim() || '')
    : selColegio;
  const curso   = document.getElementById('r-curso').value.trim();
  const anio    = parseInt(document.getElementById('r-anio').value)||2026;
  const email   = document.getElementById('r-email').value.trim().toLowerCase();
  const pass    = document.getElementById('r-pass').value;
  const pass2   = document.getElementById('r-pass2').value;
  const cuota   = parseInt(document.getElementById('r-cuota').value)||0;
  const errEl   = document.getElementById('registro-err');

  const err = (msg)=>{ errEl.textContent=msg; errEl.style.display=''; errEl.scrollIntoView({block:'nearest'}); };

  // Validar código de invitación
  // Validar código de invitación
if(!invitacion) return err('Ingresa el código de invitación.');

let codigoObj = null;

// 1. Buscar primero en local
const codigos = DB.config?.codigosInvitacion || [];
codigoObj = codigos.find(c=>c.codigo===invitacion && c.activo && !c.usado);

// 2. Si no está local, buscar en Supabase
if(!codigoObj){
  try{
    const rows = await sbGet('codigos_invitacion','codigo=eq.'+encodeURIComponent(invitacion));
    if(rows && rows.length>0){
      const r = rows[0];
      if(r.activo && !r.usado){
        codigoObj = {
          codigo: r.codigo,
          tipo: r.tipo || 'prueba',
          activo: r.activo === true,
          usado: r.usado === true,
          creadoEn: r.creado_en || isoToday(),
          usadoPor: r.usado_por || null,
          usadoEn: r.usado_en || null
        };

        if(!DB.config) DB.config = {};
        if(!DB.config.codigosInvitacion) DB.config.codigosInvitacion = [];
        DB.config.codigosInvitacion.unshift(codigoObj);
        saveDB();
      }
    }
  }catch(e){}
}

if(!codigoObj) return err('Código de invitación inválido, ya utilizado o desactivado. Solicita uno nuevo al administrador.');

  if(!nombre)   return err('Ingresa tu nombre completo.');
  if(!region)   return err('Selecciona tu región.');
  if(!comuna)   return err('Selecciona tu comuna.');
  if(!colegio)  return err('Ingresa o selecciona el nombre de la '+V('institucion')+'.');
  if(!curso)    return err('Ingresa el nombre del curso.');
  if(!email||!email.includes('@')) return err('Ingresa un correo electrónico válido.');
  if(pass.length < 6)  return err('La contraseña debe tener al menos 6 caracteres.');
  if(pass !== pass2)   return err('Las contraseñas no coinciden.');
  if((DB.usuarios||[]).some(u=>u.email.toLowerCase()===email))
    return err('Ese correo ya está registrado. Inicia sesión.');
  
  // Verificar si el correo está bloqueado por prueba vencida
  errEl.textContent='Verificando...'; errEl.style.display='';
  try{
    const bloq = await sbGet('correos_bloqueados','email=eq.'+encodeURIComponent(email));
    if(bloq && bloq.length>0 && bloq[0].bloqueado){
      return err('Este correo ya tuvo un período de prueba gratuito. Para continuar usando Tesorero activa tu plan anual. Escríbenos a WhatsApp para activarlo.');
    }
  }catch(e){ /* Si la tabla no existe, ignorar */ }
  errEl.style.display='none';

  errEl.style.display='none';

  // Marcar código como usado
  const ci = codigos.findIndex(c=>c.codigo===invitacion);
  if(ci>=0){
    DB.config.codigosInvitacion[ci].usado = true;
    DB.config.codigosInvitacion[ci].usadoPor = email;
    DB.config.codigosInvitacion[ci].usadoEn = isoToday();
  }

  // Marcar también en Supabase
  if(typeof sbUpdateCode === 'function'){
    await sbUpdateCode(invitacion,{
      usado: true,
      usado_por: email,
      usado_en: isoToday(),
      activo: false
    });
  }

  // Registrar correo en tabla de bloqueos si es prueba gratuita
  if(codigoObj?.tipo==='prueba' || !codigoObj?.tipo){
    sbFetch('/rest/v1/correos_bloqueados',{method:'POST',
      headers:{'Prefer':'resolution=merge-duplicates'},
      body:JSON.stringify({email:email, bloqueado:true, tipo:'prueba', registrado_en:isoToday()})
    }).catch(()=>{});
  }

  // Generar IDs únicos
  const uId   = uid();
  const colId = uid();
  const curId = uid();
  const qId   = uid();
  const rnd   = Math.random().toString(36).slice(2,6).toUpperCase();
  const prefCurso = curso.replace(/[^a-zA-Z0-9]/g,'').slice(0,4).toUpperCase();
  const codigo = prefCurso+'-'+anio+'-'+rnd;

  if(!DB.usuarios) DB.usuarios=[];
  // Generar código de recuperación único para esta cuenta
  const codigoRec = generarCodigoRecuperacion();
  // Determinar tipo de plan según código
  const tipoCodigo = codigoObj?.tipo || 'prueba';
  const esAnual = tipoCodigo === 'anual';
  const esVIP   = tipoCodigo === 'vip';
  // Calcular fecha de vencimiento para plan anual
  const venceAnual = esAnual ? (() => {
    const d = new Date(); d.setFullYear(d.getFullYear()+1);
    return d.toISOString().slice(0,10);
  })() : null;
  // invitado:true = creado via código de invitación, no puede generar nuevos códigos
  DB.usuarios.push({
    id:uId, email, pass, nombre, rol:'tesorero', cursoIds:[curId],
    invitado:true, codigoRecuperacion:codigoRec, fechaRegistro:isoToday(),
    planVIP: esVIP || undefined,
    planAnual: esAnual || undefined,
    planAnualHasta: venceAnual || undefined
  });

  let colegioId = (DB.colegios||[]).find(c=>c.nombre.toLowerCase()===colegio.toLowerCase())?.id;
  if(!colegioId){
    if(!DB.colegios) DB.colegios=[];
    colegioId = colId;
    DB.colegios.push({id:colegioId, nombre:colegio, region, comuna, activo:true});
  }

  // Si es un colegio nuevo (escrito manualmente), registrarlo en la base compartida
  const selVal = document.getElementById('r-colegio-sel')?.value;
  if(selVal === '__nuevo__' && colegio){
    registrarNuevoColegio(colegio, comuna, region);
  }

  if(!DB.cursos) DB.cursos=[];
  DB.cursos.push({id:curId, colegioId, nombre:curso, anio, tesoreraId:uId, tesorero:nombre, codigo, activo:true, cuotaMensual:cuota, cuotaAnual:0, meta:0, region, comuna});

  if(cuota>0){
    if(!DB.cuotas) DB.cuotas=[];
    const mesInicioReg  = parseInt(document.getElementById('r-mes-inicio')?.value||'2');
    const mesTerminoReg = parseInt(document.getElementById('r-mes-termino')?.value||'11');
    DB.cursos[DB.cursos.length-1].mesInicioCuota  = mesInicioReg;
    DB.cursos[DB.cursos.length-1].mesTerminoCuota = mesTerminoReg;
    DB.cuotas.push({id:qId, cursoId:curId, tipo:'mensual', nombre:'Cuota Mensual '+anio, monto:cuota, activa:true, anio, mesInicio:mesInicioReg, mesTermino:mesTerminoReg, obs:'Vence el día 10 de cada mes'});
  }

  saveDB();

  // Crear usuario en Supabase Auth automáticamente
  let authId = null;
  if(authClient){
    try{
      const { data: signUpData, error: signUpError } = await authClient.auth.signUp({
        email: email,
        password: pass
      });
      if(!signUpError && signUpData?.user){
        authId = signUpData.user.id;
        // Capturar token JWT si la sesión se creó inmediatamente
        if(signUpData.session?.access_token){
          _authToken = signUpData.session.access_token;
        }
      }
    }catch(e){
      console.warn('No se pudo crear usuario en Supabase Auth:', e);
    }
  }

  // Subir datos a Supabase inmediatamente al crear cuenta
  S.session={id:uId, authId:authId||undefined, email, nombre, rol:'tesorero', cursoIds:[curId]};
  S.cursoId=curId;

  const cloudIdRegistro = authId || uId; // usar UUID real de Auth para que pase el RLS
  const datosPrimerSync = datosDelUsuario(uId);
  supaGuardar(cloudIdRegistro, datosPrimerSync).then(()=>{
    console.log('Cuenta sincronizada con Supabase al crear');
  }).catch(()=>{
    console.warn('No se pudo sincronizar con Supabase al crear cuenta');
  });

  // Registrar en tabla usuarios_app con auth_id
  sbFetch('/rest/v1/usuarios_app', {
    method: 'POST',
    headers: { 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify({
      id: uId,
      email: email,
      nombre: nombre,
      plan: tipoCodigo || 'prueba',
      fecha_registro: isoToday(),
      plan_hasta: venceAnual || null,
      plan_vip: esVIP || false,
      codigo_usado: invitacion || null,
      desactivado: false,
      auth_id: authId || null
    })
  }).catch(()=>{});

  // Mostrar código de recuperación — solo se muestra UNA VEZ
  mostrarCodigoRecuperacion(codigoRec, 'registro');

  go('dashboard');
}

// Paso 1: verificar código y mostrar selector de alumno
let _cursoTempId = null;
function doVerificarCodigo(){
  const code = document.getElementById('l-codigo').value.trim().toUpperCase();
  const errEl = document.getElementById('codigo-err');
  if(!code){ errEl.textContent='Ingresa el código del curso.'; errEl.style.display=''; return; }

  // Verificar si es código compartido (acceso total al curso)
  const cursoCompartido = (DB.cursos||[]).find(c=>c.codigoCompartido===code&&c.activo);
  if(cursoCompartido){
    errEl.style.display='none';
    // Login directo como lector compartido — sin PIN ni alumno
    S.session = {
      id: 'compartido_'+cursoCompartido.id,
      rol: 'apoderado_lector',
      nombre: 'Acceso compartido',
      cursoIds: [cursoCompartido.id],
      alumnoId: null,
      esAccesoCompartido: true
    };
    S.cursoId = cursoCompartido.id;
    go('dashboard');
    return;
  }

  // Buscar primero en DB local
  const cursoLocal = (DB.cursos||[]).find(c=>c.codigo===code&&c.activo);
  if(cursoLocal){
    errEl.style.display='none';
    _cursoTempId = cursoLocal.id;
    document.getElementById('paso-codigo').style.display='none';
    document.getElementById('paso-alumno').style.display='';
    document.getElementById('paso2-curso-nombre').textContent = cursoLocal.nombre+' · '+cursoLocal.anio;
    const lbl = document.getElementById('label-busq-miembro');
    if(lbl) lbl.textContent = 'Buscar '+V('miembro').toLowerCase()+'/a';
    renderAlumnosSelector('');
    return;
  }

  // No encontrado localmente — buscar en Supabase
  errEl.style.display='none';
  const btn = document.querySelector('#paso-codigo .btn.bp');
  if(btn){ btn.textContent='Buscando...'; btn.disabled=true; }

  // Usar siempre la anon key para apoderados (no necesitan auth)
  fetch(SUPA_URL+'/rest/v1/tesorero_datos?select=datos&usuario_id=neq.landing_visitas&usuario_id=neq.colegios_chile&usuario_id=neq.global&usuario_id=neq.ap_lector',{
    headers:{'apikey':SUPA_KEY,'Authorization':'Bearer '+SUPA_KEY}
  }).then(r=>r.json()).then(rows=>{
    if(btn){ btn.textContent='Verificar código →'; btn.disabled=false; }
    if(!Array.isArray(rows)){ errEl.textContent='Error al conectar con el servidor.'; errEl.style.display=''; return; }
    for(const row of rows){
      const d=row.datos;
      if(!d||!d.cursos) continue;
      // Verificar código compartido primero
      const cc = d.cursos.find(x=>x.codigoCompartido===code&&x.activo);
      if(cc){
        mergeDB(d);
        S.session = {
          id: 'compartido_'+cc.id,
          rol: 'apoderado_lector',
          nombre: 'Acceso compartido',
          cursoIds: [cc.id],
          alumnoId: null,
          esAccesoCompartido: true
        };
        S.cursoId = cc.id;
        go('dashboard');
        return;
      }
      const c = d.cursos.find(x=>x.codigo===code&&x.activo);
      if(!c) continue;
      // Encontrado — cargar datos del tesorero en DB
      mergeDB(d);
      _cursoTempId = c.id;
      errEl.style.display='none';
      document.getElementById('paso-codigo').style.display='none';
      document.getElementById('paso-alumno').style.display='';
      document.getElementById('paso2-curso-nombre').textContent = c.nombre+' · '+c.anio;
      renderAlumnosSelector('');
      return;
    }
    errEl.textContent='Código inválido o curso no encontrado.';
    errEl.style.display='';
  }).catch(()=>{
    if(btn){ btn.textContent='Verificar código →'; btn.disabled=false; }
    errEl.textContent='Error de conexión. Verifica tu internet e intenta de nuevo.';
    errEl.style.display='';
  });
}

function volverPaso1(){
  _cursoTempId = null; window._aluSelId = null;
  document.getElementById('paso-alumno').style.display='none';
  document.getElementById('paso-pin').style.display='none';
  document.getElementById('paso-codigo').style.display='';
  document.getElementById('busq-alumno-ap').value='';
  document.getElementById('alumno-err').style.display='none';
}

function volverPaso2(){
  window._aluSelId = null;
  document.getElementById('paso-pin').style.display='none';
  document.getElementById('paso-alumno').style.display='';
  document.getElementById('l-pin').value='';
  document.getElementById('pin-err').style.display='none';
}

function renderAlumnosSelector(busq){
  const lista = (DB.alumnos||[])
    .filter(a=>a.cursoId===_cursoTempId && a.estado==='activo')
    .filter(a=>!busq||`${a.nombres} ${a.apellidos}`.toLowerCase().includes(busq.toLowerCase()))
    .sort((a,b)=>`${a.apellidos} ${a.nombres}`.localeCompare(`${b.apellidos} ${b.nombres}`,'es'));
  const cont = document.getElementById('lista-alumnos-selector');
  if(!cont) return;
  if(!lista.length){
    cont.innerHTML=`<div style="font-size:13px;color:var(--t3);text-align:center;padding:12px">Sin resultados</div>`;
    return;
  }
  // Solo mostramos nombre — no si tiene PIN o no (no revelar info de seguridad)
  cont.innerHTML = lista.map(a=>`
    <div class="ap-alumno-card" onclick="seleccionarAlumnoAp('${a.id}',this)"
      style="display:flex;align-items:center;gap:12px;padding:12px 14px;border:1.5px solid var(--brd);border-radius:10px;cursor:pointer;transition:.15s"
      onmouseover="this.style.borderColor='var(--gm)'" onmouseout="if(!this.classList.contains('selected'))this.style.borderColor='var(--brd)'">
      <div style="width:38px;height:38px;border-radius:50%;background:var(--gl);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:var(--g);flex-shrink:0">
        ${(a.apellidos[0]||'?').toUpperCase()}
      </div>
      <div style="font-weight:600;font-size:14px">${escHtml(a.apellidos)}, ${escHtml(a.nombres)}</div>
      <div style="margin-left:auto;font-size:18px;display:none" class="ap-check">✓</div>
    </div>`).join('');
}

function filtrarAlumnosSelector(v){
  renderAlumnosSelector(v);
  window._aluSelId = null;
}

window._aluSelId = null;
function seleccionarAlumnoAp(aluId, el){
  window._aluSelId = aluId;
  document.querySelectorAll('.ap-alumno-card').forEach(c=>{
    c.classList.remove('selected');
    c.style.borderColor='var(--brd)';
    c.style.background='var(--wh)';
    c.querySelector('.ap-check').style.display='none';
  });
  el.classList.add('selected');
  el.style.borderColor='var(--gm)';
  el.style.background='var(--gl)';
  el.querySelector('.ap-check').style.display='';
  document.getElementById('alumno-err').style.display='none';
}

// Paso 2 → Paso 3: ir a pantalla de PIN
function irPaso3(){
  const errEl = document.getElementById('alumno-err');
  if(!window._aluSelId){
    errEl.textContent='Selecciona el nombre de tu hijo/a para continuar.';
    errEl.style.display=''; return;
  }
  const alu = (DB.alumnos||[]).find(a=>a.id===window._aluSelId);
  if(!alu){ errEl.textContent='Error al cargar datos. Intenta de nuevo.'; errEl.style.display=''; return; }
  errEl.style.display='none';
  document.getElementById('paso-alumno').style.display='none';
  document.getElementById('paso-pin').style.display='';
  document.getElementById('paso3-alumno-nombre').textContent = alu.apellidos+', '+alu.nombres;
  document.getElementById('l-pin').value='';
  setTimeout(()=>document.getElementById('l-pin').focus(), 100);
}

// Paso 3: verificar PIN y crear sesión
function doRecuperar(){
  const email  = document.getElementById('rec-email').value.trim().toLowerCase();
  const codigo = document.getElementById('rec-codigo').value.trim().toUpperCase();
  const pass   = document.getElementById('rec-pass').value;
  const pass2  = document.getElementById('rec-pass2').value;
  const errEl  = document.getElementById('rec-err');
  const okEl   = document.getElementById('rec-ok');
  const show   = msg=>{ errEl.textContent=msg; errEl.style.display=''; okEl.style.display='none'; };

  if(!email)  return show('Ingresa tu correo electrónico.');
  if(!codigo) return show('Ingresa tu código de recuperación.');
  if(!pass || pass.length<6) return show('La contraseña debe tener al menos 6 caracteres.');
  if(pass!==pass2) return show('Las contraseñas no coinciden.');

  const ui = (DB.usuarios||[]).findIndex(u=>
    u.email.toLowerCase()===email && u.codigoRecuperacion===codigo
  );
  if(ui<0){
    show('Correo o código de recuperación incorrecto.');
    return;
  }

  // Cambiar contraseña en Supabase Auth (fuente de verdad) y regenerar código de recuperación
  const nuevoCodigo = generarCodigoRecuperacion();
  // No guardamos la contraseña en DB local — solo en Supabase Auth
  delete DB.usuarios[ui].pass;
  DB.usuarios[ui].codigoRecuperacion = nuevoCodigo;
  saveDB();

  // Intentar cambiar en Supabase Auth si hay sesión activa
  if(authClient){
    authClient.auth.updateUser({ password: pass }).catch(()=>{});
  }

  errEl.style.display='none';
  okEl.textContent='✅ Contraseña restablecida. Ya puedes iniciar sesión.';
  okEl.style.display='';

  // Mostrar nuevo código de recuperación
  setTimeout(()=>{
    alert(
      '✅ Contraseña restablecida exitosamente.\n\n' +
      '🔑 Tu NUEVO código de recuperación es:\n\n' +
      nuevoCodigo + '\n\n' +
      '⚠️ Guárdalo en un lugar seguro. Este código reemplaza al anterior y es la única forma de recuperar tu cuenta si olvidas la contraseña.'
    );
    switchLoginTab('login');
  }, 800);
}

function generarCodigoRecuperacion(){
  const chars='23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const seg=()=>{ let s=''; for(let i=0;i<4;i++) s+=chars[Math.floor(Math.random()*chars.length)]; return s; };
  return 'REC-'+seg()+'-'+seg()+'-'+seg();
}

function mostrarCodigoRecuperacion(codigo, contexto){
  const msg =
    '🔑 CÓDIGO DE RECUPERACIÓN\n\n' +
    codigo + '\n\n' +
    '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
    'Guarda este código en un lugar seguro ' +
    '(foto, anotación, etc.).\n\n' +
    'Lo necesitarás si olvidas tu contraseña.\n' +
    'NO lo compartas con nadie.';
  alert(msg);
}

function verMiCodigoRecuperacion(){
  const u = (DB.usuarios||[]).find(x=>x.id===S.session?.id);
  if(!u){ alert('No se encontró tu cuenta.'); return; }
  if(!u.codigoRecuperacion){
    alert('No tienes código de recuperación generado. Cambia tu contraseña en Configuración para generar uno.');
    return;
  }
  mostrarCodigoRecuperacion(u.codigoRecuperacion, 'vista');
}

// Paso 3: verificar PIN y crear sesión
async function doAccesoCodigo(){
  const pin = document.getElementById('l-pin').value.trim();
  const errEl = document.getElementById('pin-err');
  if(!pin){ errEl.textContent='Ingresa tu PIN para continuar.'; errEl.style.display=''; return; }

  const curso = (DB.cursos||[]).find(c=>c.id===_cursoTempId);
  const alu   = (DB.alumnos||[]).find(a=>a.id===window._aluSelId);
  if(!curso||!alu){ errEl.textContent='Error al cargar datos. Intenta de nuevo.'; errEl.style.display=''; return; }

  // Verificar PIN — debe coincidir exactamente con el asignado al alumno
  if(!alu.pin){
    errEl.textContent='Este alumno aún no tiene PIN asignado. Solicítalo al tesorero del curso.';
    errEl.style.display=''; return;
  }
  if(String(alu.pin).trim() !== pin){
    errEl.textContent='PIN incorrecto. Verifica con el tesorero del curso.';
    errEl.style.display=''; return;
  }

  errEl.style.display='none';
  const recordarAp = document.getElementById('ap-recordar')?.checked || false;
  S.session={
    id:'ap_lector',
    nombre:'Apoderado de '+alu.nombres,
    rol:'apoderado_lector',
    cursoIds:[curso.id],
    alumnoId: alu.id,
    alumnoNombre: alu.nombres+' '+alu.apellidos
  };
  S.cursoId=curso.id;
  if(recordarAp){
    previewStorage.setItem('tesorero_ap_recordar','1');
    previewStorage.setItem('tesorero_ap_cursoId', curso.id);
    previewStorage.setItem('tesorero_ap_aluId',   alu.id);
    previewStorage.setItem('tesorero_ap_pin',      pin);
  } else {
    previewStorage.removeItem('tesorero_ap_recordar');
    previewStorage.removeItem('tesorero_ap_cursoId');
    previewStorage.removeItem('tesorero_ap_aluId');
    previewStorage.removeItem('tesorero_ap_pin');
  }
  window._aluSelId=null; _cursoTempId=null;

  // Cargar datos frescos desde la nube antes de mostrar el dashboard.
  // Sin esto, el apoderado solo ve los datos que había al cargar la página
  // y no verá gastos ni pagos añadidos por el tesorero después.
  const tesoreroId = curso.tesoreraId || (DB.usuarios||[])[0]?.id || 'u1';
  const rows = await sbGet('tesorero_datos','usuario_id=eq.'+encodeURIComponent(tesoreroId)).catch(()=>[]);
  if(rows && rows.length > 0 && rows[0].datos){
    mergeDB(rows[0].datos);
  }
  go('dashboard');
}
async function refrescarDatosApoderado(btnEl){
  if(btnEl){
    btnEl.disabled=true;
    btnEl.innerHTML='⏳ Actualizando…';
    btnEl.style.opacity='0.75';
  }
  try{
    const cur = (DB.cursos||[]).find(c=>c.id===S.cursoId);
    const tesoreroId = (cur&&cur.tesoreraId)||(DB.usuarios||[])[0]?.id||'u1';
    const res = await fetch(SUPA_URL+'/rest/v1/tesorero_datos?usuario_id=eq.'+encodeURIComponent(tesoreroId),{
      headers:{'apikey':SUPA_KEY,'Authorization':'Bearer '+(_authToken||SUPA_KEY)}
    });
    if(!res.ok) throw new Error('HTTP '+res.status);
    const rows = await res.json();
    if(rows&&rows.length>0&&rows[0].datos){
      const d=rows[0].datos;
      // Reemplazar directamente con los datos de la nube (fuente de verdad).
      // El apoderado es solo lectura — no tiene datos locales propios que preservar.
      // Usar merge aquí causaría que movimientos eliminados por el tesorero
      // siguieran apareciendo indefinidamente en la pantalla del apoderado.
      DB.movimientos = d.movimientos || [];
      DB.pagos       = d.pagos       || [];
      DB.cuotas      = d.cuotas      || [];
      DB.alumnos     = d.alumnos     || [];
    }
    showToast('✓ Datos actualizados');
    go(S.route);
  }catch(e){
    showToast('⚠️ No se pudo actualizar — revisa tu red');
  }finally{
    if(btnEl){
      btnEl.disabled=false;
      btnEl.innerHTML= btnEl.textContent.includes('datos') ? '↻ Actualizar datos' : '↻ Actualizar';
      btnEl.style.opacity='1';
    }
  }
}

function limpiarSesionApoderado(){
  // Borra completamente la sesión guardada del apoderado
  // Usar cuando quiere entrar con un código distinto
  previewStorage.removeItem('tesorero_ap_recordar');
  previewStorage.removeItem('tesorero_ap_cursoId');
  previewStorage.removeItem('tesorero_ap_aluId');
  previewStorage.removeItem('tesorero_ap_pin');
  window._skipApAutoLogin = true;
  // Ocultar panel rápido y mostrar formulario de código
  const p = document.getElementById('panel-ap-rapido');
  if(p) p.style.display = 'none';
  const paso = document.getElementById('paso-codigo');
  if(paso) paso.style.display = '';
  const inp = document.getElementById('l-codigo');
  if(inp){ inp.value=''; inp.focus(); }
}

function logoutLector(){
  // Cierra sesión del apoderado SIN borrar credenciales guardadas.
  // ── v9: invalidar epochs ANTES de limpiar el estado, igual que logout().
  //        Descarta fetches en vuelo que pudieran escribir en DB tras salir.
  if (typeof _v9SessionId !== 'undefined')     { _v9SessionId++; }
  if (typeof _selectCursoEpoch !== 'undefined') { _selectCursoEpoch++; }

  // Limpiar estado de sesión v9 (token, cuentaId, sesión)
  if (typeof _authToken !== 'undefined') { _authToken = null; }
  S._v9CuentaId = null;

  window._skipApAutoLogin = true;
  S.session=null; S.cursoId=null; S.route='login';

  // Conservar credenciales del apoderado para el próximo auto-login
  const apRecordar = previewStorage.getItem('tesorero_ap_recordar');
  const apCursoId  = previewStorage.getItem('tesorero_ap_cursoId');
  const apAluId    = previewStorage.getItem('tesorero_ap_aluId');
  const apPin      = previewStorage.getItem('tesorero_ap_pin');

  // ⚠️  Resetear KEY a la clave anónima ANTES de initDB().
  //     Sin esto, initDB() leería previewStorage[KEY] con la clave del usuario
  //     anterior y repoblaría DB con sus datos.
  if (typeof KEY !== 'undefined') { KEY = 'tesorero_5bsscc_2026'; }

  DB={}; initDB();
  if(apRecordar==='1'){
    previewStorage.setItem('tesorero_ap_recordar','1');
    previewStorage.setItem('tesorero_ap_cursoId', apCursoId||'');
    previewStorage.setItem('tesorero_ap_aluId',   apAluId||'');
    previewStorage.setItem('tesorero_ap_pin',      apPin||'');
  }
  render();
}

async function logout(){
  // ── v9: invalidar epoch ANTES del signOut para que los fetches en vuelo
  //        detecten la sesión caducada cuando resuelvan y se descarten.
  if (typeof _v9SessionId !== 'undefined') { _v9SessionId++; }
  // Incrementar epoch de selectCurso para descartar respuestas en vuelo
  if (typeof _selectCursoEpoch !== 'undefined') { _selectCursoEpoch++; }

  try{
    if(authClient){ await authClient.auth.signOut(); }
  }catch(e){}

  // Limpiar token y estado de sesión (propietario y delegado)
  if (typeof _authToken !== 'undefined') { _authToken = null; }
  S.session     = null;
  S.cursoId     = null;
  S.route       = 'login';
  S._v9CuentaId = null;

  // Cierra sesión del tesorero y borra TODO
  previewStorage.removeItem('tesorero_saved_email');
  previewStorage.removeItem('tesorero_saved_pass');
  previewStorage.removeItem('tesorero_recordar');
  previewStorage.removeItem('tesorero_ap_recordar');
  previewStorage.removeItem('tesorero_ap_cursoId');
  previewStorage.removeItem('tesorero_ap_aluId');
  previewStorage.removeItem('tesorero_ap_pin');

  // ⚠️  Resetear KEY a la clave anónima ANTES de initDB().
  //     Sin esto, initDB() leería previewStorage[KEY] con la clave del usuario
  //     anterior y repoblaría DB con sus datos tras el DB={}.
  if (typeof KEY !== 'undefined') { KEY = 'tesorero_5bsscc_2026'; }

  DB={}; initDB(); render();
}

function resetearYEntrar(){
  if(!confirm(
    '⚠️ Esto borrará todos los datos guardados en este navegador y cargará los datos iniciales.\n\n' +
    '¿Estás seguro/a? Esta acción no se puede deshacer.'
  )) return;
  // Limpiar todas las claves posibles
  ['tesorero_5bsscc_2026','tesorero_db_v1','tesorero_db_v2','tesorero_db'].forEach(k=>{
    try{ previewStorage.removeItem(k); }catch(e){}
  });
  DB = {};
  initDB();
  S.session = null; S.cursoId = null; S.route = 'login';
  render();
}

// ─────────────────────────────────────────────
// UTILIDADES DE LOGIN
// ─────────────────────────────────────────────

function toggleVerPass(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = '🙈';
    btn.title = 'Ocultar contraseña';
  } else {
    input.type = 'password';
    btn.textContent = '👁';
    btn.title = 'Mostrar contraseña';
  }
}

function mostrarPantallaResetPassword() {
  const app = document.getElementById('app');
  if (!app) return;
  app.innerHTML = `
  <div class="login-wrap">
    <div class="login-card">
      <div class="login-logo">🔐</div>
      <div style="text-align:center;font-size:18px;font-weight:700;margin-bottom:4px">Nueva contraseña</div>
      <div style="text-align:center;font-size:13px;color:var(--t2);margin-bottom:20px">Elige una contraseña para tu cuenta</div>
      <div class="fg">
        <label class="fl">Nueva contraseña</label>
        <div style="position:relative">
          <input class="fi" id="reset-pass1" type="password" placeholder="Mínimo 8 caracteres" autocomplete="new-password" style="padding-right:44px">
          <button type="button" onclick="toggleVerPass('reset-pass1',this)" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;font-size:18px;color:var(--t3);padding:0;line-height:1" title="Mostrar contraseña">👁</button>
        </div>
      </div>
      <div class="fg">
        <label class="fl">Confirmar contraseña</label>
        <div style="position:relative">
          <input class="fi" id="reset-pass2" type="password" placeholder="Repite la contraseña" autocomplete="new-password" style="padding-right:44px">
          <button type="button" onclick="toggleVerPass('reset-pass2',this)" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;font-size:18px;color:var(--t3);padding:0;line-height:1" title="Mostrar contraseña">👁</button>
        </div>
      </div>
      <div id="reset-err" class="alert ar" style="display:none"></div>
      <button class="btn bp" style="width:100%;justify-content:center;margin-top:8px" onclick="guardarResetPassword()">💾 Guardar contraseña</button>
    </div>
  </div>`;
  setTimeout(() => document.getElementById('reset-pass1')?.focus(), 100);
}

async function guardarResetPassword() {
  const p1  = document.getElementById('reset-pass1')?.value || '';
  const p2  = document.getElementById('reset-pass2')?.value || '';
  const err = document.getElementById('reset-err');
  const btn = document.querySelector('[onclick="guardarResetPassword()"]');

  if (p1.length < 8) { err.textContent = 'La contraseña debe tener al menos 8 caracteres.'; err.style.display = ''; return; }
  if (p1 !== p2)     { err.textContent = 'Las contraseñas no coinciden.'; err.style.display = ''; return; }

  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }
  try {
    const { error } = await authClient.auth.updateUser({ password: p1 });
    if (error) { err.textContent = 'Error: ' + error.message; err.style.display = ''; if(btn){btn.disabled=false;btn.textContent='💾 Guardar contraseña';} return; }
    showToast('✅ Contraseña guardada. Iniciando sesión...');
    // Limpiar hash de la URL sin recargar
    history.replaceState(null, '', window.location.pathname);
    // Iniciar sesión automáticamente con la sesión activa
    setTimeout(async () => {
      const { data } = await authClient.auth.getSession();
      if (data?.session?.user) {
        _authToken = data.session.access_token;
        const legacy = await buscarUsuarioLegacyPorEmail(data.session.user.email, data.session.user.id);
        if (legacy && legacy.datos) {
          DB = legacy.datos;
          previewStorage.setItem(KEY, JSON.stringify(DB));
          const u = { ...legacy.user, authId: data.session.user.id };
          S.session = u; setUserKey(u.id);
          if (u.cursoIds && u.cursoIds.length === 1) { S.cursoId = u.cursoIds[0]; go('dashboard'); }
          else { go('selector'); }
          return;
        }
      }
      render(); // fallback: mostrar login
    }, 1000);
  } catch(e) {
    err.textContent = 'No se pudo guardar la contraseña.';
    err.style.display = '';
    if (btn) { btn.disabled = false; btn.textContent = '💾 Guardar contraseña'; }
  }
}

// ─────────────────────────────────────────────
// SELECTOR DE CURSO
// ─────────────────────────────────────────────
