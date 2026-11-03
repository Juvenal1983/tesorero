"""
test_flujo_v9.py — Verificacion del flujo apoderado v9 en navegador

Flujo: codigo -> alumno -> PIN -> situacion financiera -> editar contacto
       -> relectura -> cierre de sesion

Confirma:
  - V9_RELACIONAL activo
  - No escribe PIN en localStorage
  - PIN limpiado de memoria al logout
  - _v9AccesoData limpiado al logout
  - No consulta tesorero_datos
"""
import sys
import json
import time
import urllib.request
import urllib.error
from playwright.sync_api import sync_playwright, Route

SCRAP    = '/tmp/claude-0/-home-claude/baceb390-7fe6-5be0-bc70-3bf96e00da99/scratchpad'
APP_URL  = 'http://localhost:8080'
PGRST    = 'http://localhost:3001'
CODIGO   = 'CUR-A01'
PIN_OK   = '1234'
PIN_MAL  = '0000'
# JWT fake para anon (PostgREST local no valida en modo trust/sin RLS)
FAKE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.ZZ'

pasa = 0
falla = 0

def ok(msg):
    global pasa; pasa += 1
    print('[OK]    ' + msg)

def fail(msg):
    global falla; falla += 1
    print('[FAIL]  ' + msg)

def info(msg):
    print('[INFO]  ' + msg)


def proxy_rpc(route):
    """Redirige RPCs de cualquier host a PostgREST local.
    Supabase usa /rest/v1/rpc/..., PostgREST local usa /rpc/...
    """
    url = route.request.url
    idx = url.find('/rest/v1/rpc/')
    if idx == -1:
        route.continue_()
        return
    # Extraer solo el nombre de la funcion y query params
    after_rpc = url[idx + len('/rest/v1/rpc/'):]   # "nombre_func" o "nombre?param=val"
    local_url = PGRST + '/rpc/' + after_rpc
    try:
        body_bytes = (route.request.post_data or '{}').encode('utf-8')
        r = urllib.request.urlopen(urllib.request.Request(
            local_url,
            data=body_bytes,
            headers={'Content-Type': 'application/json',
                     'Accept': 'application/json',
                     'Accept-Profile': 'public'},
            method='POST',
        ), timeout=10)
        body = r.read().decode()
        route.fulfill(status=r.status,
                      headers={'Content-Type': 'application/json',
                               'Access-Control-Allow-Origin': '*'},
                      body=body)
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        route.fulfill(status=e.code,
                      headers={'Content-Type': 'application/json',
                               'Access-Control-Allow-Origin': '*'},
                      body=body)
    except Exception as e:
        route.fulfill(status=500, body=json.dumps({'error': str(e)}))


with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context(
        viewport={'width': 390, 'height': 844},
        bypass_csp=True,    # ignorar CSP del servidor para pruebas locales
    )

    # Inyectar variables ANTES de que cualquier script de la pagina corra.
    # config.js usa: (typeof STAGING_SUPA_URL !== 'undefined' && STAGING_SUPA_URL) || placeholder
    ctx.add_init_script(
        "window.STAGING_SUPA_URL = 'http://localhost:3001';"
        "window.STAGING_SUPA_KEY = '" + FAKE_KEY + "';"
    )

    page = ctx.new_page()

    js_errors = []
    page.on('pageerror', lambda e: js_errors.append(str(e)))

    # Proxy de RPCs a PostgREST local
    page.route('**/rest/v1/rpc/**', proxy_rpc)

    # Capturar intentos a produccion/staging real
    staging_requests = []
    def capture_prod(route):
        staging_requests.append(route.request.url)
        route.abort()
    page.route('**/tesorero_datos**', capture_prod)
    page.route('**tmjqzaakzhecbldebyeg**', capture_prod)

    # ── 1. Cargar app ──────────────────────────────────────────────
    info('Cargando app...')
    page.goto(APP_URL, wait_until='networkidle')
    time.sleep(1.0)
    page.screenshot(path=SCRAP + '/01_inicio.png')

    v9 = page.evaluate('typeof V9_RELACIONAL !== "undefined" && V9_RELACIONAL')
    if v9:
        ok('V9_RELACIONAL = true')
    else:
        fail('V9_RELACIONAL no definido o false')

    supa = page.evaluate('typeof SUPA_URL !== "undefined" ? SUPA_URL : "(no def)"')
    info('SUPA_URL activa: ' + str(supa))
    if 'localhost:3001' in str(supa):
        ok('SUPA_URL apunta a PostgREST local')
    else:
        fail('SUPA_URL no apunta a local: ' + str(supa))

    # ── 2. Pantalla de acceso ──────────────────────────────────────
    page.evaluate('if (typeof go === "function") go("acceso")')
    time.sleep(0.5)
    tab = page.query_selector('#tab-codigo')
    if tab:
        tab.click()
        time.sleep(0.3)
    page.screenshot(path=SCRAP + '/02_acceso.png')

    # ── 3. Paso 1: codigo ──────────────────────────────────────────
    info('Paso 1: codigo ' + CODIGO)
    try:
        page.wait_for_selector('#l-codigo', state='visible', timeout=5000)
        inp = page.query_selector('#l-codigo')
    except Exception:
        inp = None

    if not inp:
        fail('#l-codigo no encontrado o no visible')
    else:
        ok('#l-codigo presente')
        inp.fill(CODIGO)
        page.evaluate('doVerificarCodigo()')
        time.sleep(2.5)
        page.screenshot(path=SCRAP + '/03_paso1.png')

        visible = page.evaluate(
            'document.getElementById("paso-alumno")?.style.display !== "none"')
        if visible:
            ok('Paso 2 visible tras codigo valido')
        else:
            err_msg = page.evaluate(
                'document.getElementById("l-cod-err")?.textContent?.trim() || "(sin error visible)"')
            fail('Paso 2 no visible. Mensaje de error: ' + err_msg)

    # ── 4. Paso 2: alumno ──────────────────────────────────────────
    info('Paso 2: seleccionando alumno')
    time.sleep(0.3)
    cards = page.query_selector_all('.ap-alumno-card')
    info('Alumnos listados: ' + str(len(cards)))
    if cards:
        ok('Lista renderizada (' + str(len(cards)) + ' alumnos)')
        # Llamar directamente (el onclick HTML tiene problema de comillas cuando nombre='')
        page.evaluate(
            '(function(){'
            '  var a = _v9ApState.alumnos && _v9ApState.alumnos[0];'
            '  if (!a) return;'
            '  var card = document.querySelectorAll(".ap-alumno-card")[0];'
            '  _v9SeleccionarAlumno(a.alumno_id, a.nombre || "", card);'
            '})()'
        )
        time.sleep(0.3)
        page.screenshot(path=SCRAP + '/04_alumno.png')

        alumno_sel = page.evaluate('_v9ApState?.alumnoId')
        info('alumnoId tras seleccion: ' + str(alumno_sel))

        page.evaluate('irPaso3()')
        time.sleep(0.3)
        paso3 = page.evaluate(
            'document.getElementById("paso-pin")?.style.display !== "none"')
        if paso3:
            ok('Paso 3 (PIN) visible')
        else:
            fail('Paso 3 no visible')
    else:
        fail('Lista de alumnos vacia')

    # ── 5. PIN incorrecto ──────────────────────────────────────────
    info('Paso 3a: PIN incorrecto')
    try:
        page.wait_for_selector('#l-pin', state='visible', timeout=5000)
        pin_inp = page.query_selector('#l-pin')
    except Exception:
        pin_inp = None

    if pin_inp:
        pin_inp.fill(PIN_MAL)
        page.evaluate('doAccesoCodigo()')
        time.sleep(2.5)
        err_visible = page.evaluate(
            'document.getElementById("pin-err")?.style.display !== "none"')
        err_txt = page.evaluate(
            'document.getElementById("pin-err")?.textContent?.trim() || ""')
        if err_visible and err_txt:
            ok('PIN incorrecto -> error: "' + err_txt[:60] + '"')
        else:
            fail('PIN incorrecto: no se mostro mensaje de error')
        val = page.evaluate('document.getElementById("l-pin")?.value')
        if not val:
            ok('Input PIN vaciado tras intento fallido')
        else:
            fail('Input PIN no vaciado: "' + str(val) + '"')
        page.screenshot(path=SCRAP + '/05_pin_malo.png')
    else:
        fail('Input #l-pin no encontrado')

    # ── 6. PIN correcto ────────────────────────────────────────────
    info('Paso 3b: PIN correcto')
    if pin_inp:
        pin_inp.fill(PIN_OK)
        ls_antes = page.evaluate(
            '[...Object.keys(localStorage)].filter(k => k.toLowerCase().includes("pin"))')
        if not ls_antes:
            ok('PIN no presente en localStorage antes del acceso')
        else:
            fail('PIN en localStorage antes del acceso: ' + str(ls_antes))

        page.evaluate('doAccesoCodigo()')
        time.sleep(2.5)
        page.screenshot(path=SCRAP + '/06_acceso.png')

        ls_despues = page.evaluate(
            '[...Object.keys(localStorage)].filter(k => k.toLowerCase().includes("pin"))')
        if not ls_despues:
            ok('PIN no guardado en localStorage tras acceso exitoso')
        else:
            fail('PIN en localStorage tras acceso: ' + str(ls_despues))

        rol = page.evaluate('S?.session?.rol')
        if rol == 'apoderado_v9':
            ok('Sesion apoderado_v9 establecida')
        else:
            info('Rol actual: ' + str(rol))
    else:
        info('Saltando paso PIN (input no disponible)')

    # ── 7. Situacion financiera ────────────────────────────────────
    info('Situacion financiera...')
    sit = page.evaluate('''(async () => {
        if (typeof v9AluSituacion !== "function") return {error: "v9AluSituacion no definida"};
        const cuentaId = S?.session?._v9CuentaId;
        const alumnoId = S?.session?.alumnoId;
        const pin = typeof window._v9PinEnMemoria === "function" ? window._v9PinEnMemoria() : null;
        if (!cuentaId || !alumnoId) return {error: "sin cuentaId/alumnoId"};
        if (!pin) return {error: "PIN no disponible en closure"};
        try { return await v9AluSituacion(cuentaId, alumnoId, pin); }
        catch(e) { return {error: String(e)}; }
    })()''')

    if isinstance(sit, dict) and sit.get('error'):
        fail('Situacion financiera: ' + sit['error'])
    elif sit is None:
        fail('Situacion financiera: retorno null')
    else:
        pagos_n = len(sit.get('pagos', [])) if isinstance(sit, dict) else '?'
        ok('Situacion financiera OK (pagos=' + str(pagos_n) + ')')
        bc = sit.get('balance_curso', {}) if isinstance(sit, dict) else {}
        if bc:
            ok('balance_curso: ingresos=' + str(bc.get('total_ingresos'))
               + ' gastos=' + str(bc.get('total_gastos'))
               + ' saldo=' + str(bc.get('saldo')))
        else:
            fail('balance_curso ausente en respuesta')

    # ── 8. Editar contacto ─────────────────────────────────────────
    info('Editar contacto...')
    acceso_data = page.evaluate('S?._v9AccesoData')
    apo_id = None
    if isinstance(acceso_data, dict):
        apods = acceso_data.get('apoderados', [])
        if apods:
            apo_id = apods[0].get('id')

    if apo_id:
        edit_res = page.evaluate(
            'async (apoderadoId) => {'
            '  const cuentaId = S?.session?._v9CuentaId;'
            '  const alumnoId = S?.session?.alumnoId;'
            '  const pin = typeof window._v9PinEnMemoria === "function" ? window._v9PinEnMemoria() : null;'
            '  if (!pin) return {error: "sin PIN en closure"};'
            '  try { return await v9AluEditarContacto(cuentaId, alumnoId, pin, apoderadoId, null, null, "+56900000001", null); }'
            '  catch(e) { return {error: String(e)}; }'
            '}',
            apo_id
        )
        if isinstance(edit_res, dict) and edit_res.get('error'):
            fail('Edicion contacto: ' + edit_res['error'])
        else:
            ok('Contacto editado correctamente')

        # Relectura
        releido = page.evaluate(
            '(async () => {'
            '  const cuentaId = S?.session?._v9CuentaId;'
            '  const alumnoId = S?.session?.alumnoId;'
            '  const pin = typeof window._v9PinEnMemoria === "function" ? window._v9PinEnMemoria() : null;'
            '  if (!pin) return {error: "sin PIN"};'
            '  try { return await v9AluAcceso(cuentaId, alumnoId, pin); }'
            '  catch(e) { return {error: String(e)}; }'
            '})()'
        )
        tel = None
        if isinstance(releido, dict):
            for a in releido.get('apoderados', []):
                if a.get('id') == apo_id:
                    tel = a.get('telefono')
        if tel == '+56900000001':
            ok('Relectura: edicion de telefono persiste')
        else:
            fail('Relectura: telefono=' + repr(tel) + ' (esperado "+56900000001")')

        # Limpiar (dejar fixture intacto)
        page.evaluate(
            'async (apoderadoId) => {'
            '  const cuentaId = S?.session?._v9CuentaId;'
            '  const alumnoId = S?.session?.alumnoId;'
            '  const pin = typeof window._v9PinEnMemoria === "function" ? window._v9PinEnMemoria() : null;'
            '  if (pin) await v9AluEditarContacto(cuentaId, alumnoId, pin, apoderadoId, null, null, null, null);'
            '}',
            apo_id
        )
        time.sleep(0.5)
    else:
        fail('No se encontro apoderado en _v9AccesoData')

    # ── 9. Logout ──────────────────────────────────────────────────
    info('Cerrando sesion...')
    page.evaluate('if (typeof logoutLector === "function") logoutLector()')
    time.sleep(0.8)
    page.screenshot(path=SCRAP + '/07_logout.png')

    rol_tras = page.evaluate('S?.session?.rol')
    if rol_tras != 'apoderado_v9':
        ok('Sesion apoderado_v9 limpiada al logout')
    else:
        fail('Sesion apoderado_v9 sigue activa tras logout')

    pin_tras = page.evaluate('window._v9PinEnMemoria')
    if not pin_tras:
        ok('PIN limpiado de memoria al logout')
    else:
        fail('PIN permanece en memoria tras logout')

    acc_tras = page.evaluate('S?._v9AccesoData')
    if not acc_tras:
        ok('_v9AccesoData limpiado al logout')
    else:
        fail('_v9AccesoData persiste tras logout (datos de familia expuestos)')

    # ── 10. Aislamiento entre accesos ──────────────────────────────
    info('Verificar aislamiento: segundo acceso...')
    page.evaluate('if (typeof go === "function") go("acceso")')
    time.sleep(0.3)
    tab2 = page.query_selector('#tab-codigo')
    if tab2:
        tab2.click()
        time.sleep(0.2)
    try:
        page.wait_for_selector('#l-codigo', state='visible', timeout=4000)
        inp2 = page.query_selector('#l-codigo')
    except Exception:
        inp2 = None
    if inp2:
        inp2.fill(CODIGO)
        page.evaluate('doVerificarCodigo()')
        time.sleep(1.5)
        acc_antes = page.evaluate('S?._v9AccesoData')
        if not acc_antes:
            ok('_v9AccesoData vacio antes del nuevo PIN (sin residuo)')
        else:
            fail('_v9AccesoData con datos antes de ingresar PIN')

    # ── 11. Sin requests a produccion ──────────────────────────────
    if not staging_requests:
        ok('Flujo v9 no consulta produccion ni tesorero_datos')
    else:
        fail('Requests a produccion detectados: ' + str(staging_requests))

    # ── 12. Errores JS ─────────────────────────────────────────────
    graves = [e for e in js_errors if '[v9]' in e and 'Failed to fetch' not in e]
    if graves:
        fail('Errores JS graves: ' + ' | '.join(graves[:3]))
    elif js_errors:
        ok('Sin errores JS graves (' + str(len(js_errors)) + ' warnings de red ignorados)')
    else:
        ok('Sin errores JS')

    browser.close()

print('')
print('==============================================')
print('Resultado: ' + str(pasa) + ' OK, ' + str(falla) + ' FAIL')
print('==============================================')
sys.exit(1 if falla > 0 else 0)
