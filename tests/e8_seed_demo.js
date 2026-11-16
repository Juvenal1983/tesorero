/**
 * tests/e8_seed_demo.js
 *
 * Siembra datos ficticios en STAGING para el recorrido manual B2 (planes de pago).
 * Crea: 1 curso demo, 3 alumnos ficticios, 1 cuota, código CC apoderado.
 *
 * NUNCA ejecutar contra producción (tmjqzaakzhecbldebyeg).
 *
 * Uso:
 *   node tests/e8_seed_demo.js           # crea fixtures y los imprime
 *   node tests/e8_seed_demo.js --cleanup # elimina los fixtures ya creados (IDs en e8_demo_ids.json)
 *
 * Variables de entorno requeridas (igual que e8_planes_abonos.js):
 *   STAGING_KEY    = <anon key de staging>
 *   STAGING_EMAIL  = <email del tesorero>
 *   STAGING_PASS   = <contraseña del tesorero>
 *   STAGING_URL    = https://rucgmytyxpfowznowxwd.supabase.co  (default incluido)
 *
 * Al terminar escribe tests/e8_demo_ids.json con los IDs generados.
 */

'use strict';

const path   = require('path');
const https  = require('https');
const fs     = require('fs');

try { require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') }); } catch(_){}

// ─── Guard de producción ──────────────────────────────────────────────────────
const BASE = (
  process.env.STAGING_URL ||
  process.env.STAGING_SUPABASE_URL ||
  'https://rucgmytyxpfowznowxwd.supabase.co'
).replace(/\/$/, '');

if (BASE.includes('tmjqzaakzhecbldebyeg')) {
  console.error('⛔ PROHIBIDO: BASE apunta a producción. Abortando.');
  process.exit(2);
}

const ANON_KEY = process.env.STAGING_KEY || process.env.STAGING_SUPABASE_ANON_KEY || '';
const EMAIL    = process.env.STAGING_EMAIL || process.env.STAGING_USER_A_EMAIL || '';
const PASS     = process.env.STAGING_PASS  || process.env.STAGING_USER_A_PASSWORD || '';

if (!ANON_KEY || !EMAIL || !PASS) {
  console.error('Faltan variables de entorno: STAGING_KEY, STAGING_EMAIL, STAGING_PASS');
  process.exit(1);
}

const IDS_FILE = path.resolve(__dirname, 'e8_demo_ids.json');
var JWT    = '';
var CUENTA = process.env.STAGING_CUENTA_ID || '';

// ─── HTTP helpers (mismos que e8_planes_abonos.js) ───────────────────────────
function req(method, url_path, body, extraHeaders) {
  return new Promise(function(resolve, reject) {
    var url  = new URL(url_path, BASE);
    var data = body ? JSON.stringify(body) : null;
    var hdrs = Object.assign({
      'Content-Type':  'application/json',
      'apikey':        ANON_KEY,
      'Authorization': 'Bearer ' + JWT,
      'Prefer':        'return=representation',
    }, extraHeaders || {});
    if (data) hdrs['Content-Length'] = String(Buffer.byteLength(data));
    var opts = { hostname: url.hostname, path: url.pathname + url.search,
                 method, headers: hdrs };
    var r = https.request(opts, function(res) {
      var raw = '';
      res.on('data', function(c) { raw += c; });
      res.on('end', function() {
        var parsed; try { parsed = JSON.parse(raw); } catch(_) { parsed = raw; }
        if (res.statusCode >= 400) {
          var msg = (parsed && (parsed.message || parsed.hint || parsed.error)) || raw;
          return reject(new Error('HTTP ' + res.statusCode + ': ' + msg));
        }
        resolve(parsed);
      });
    });
    r.on('error', reject);
    if (data) r.write(data); r.end();
  });
}

function GET(p)       { return req('GET', p); }
function POST(p, b)   { return req('POST', p, b); }
function DELETE(p, b) { return req('DELETE', p, b); }
function rpc(fn, p)   { return req('POST', '/rest/v1/rpc/' + fn, p, { Prefer: 'return=representation' }); }

// ─── Generador de ID corto ────────────────────────────────────────────────────
function uid(prefix) {
  return (prefix || '') + Math.random().toString(36).slice(2, 10);
}

// ─── Login ────────────────────────────────────────────────────────────────────
async function login() {
  var res = await POST('/auth/v1/token?grant_type=password', { email: EMAIL, password: PASS });
  JWT = res.access_token;
  if (!CUENTA) {
    // Obtener cuenta asociada al usuario
    var cuentas = await GET('/rest/v1/tesorero_cuentas?select=id&limit=1');
    if (!cuentas || !cuentas.length) throw new Error('No se encontró cuenta para el usuario.');
    CUENTA = cuentas[0].id;
  }
  console.log('  login OK — cuenta:', CUENTA);
}

// ─── Crear fixtures ───────────────────────────────────────────────────────────
async function seedDemo() {
  await login();

  const CURSO_ID = uid('demo-curs-');
  const CC_ID    = uid('demo-cc-');

  // 1. Curso demo
  await POST('/rest/v1/cursos', {
    id:        CURSO_ID,
    cuenta_id: CUENTA,
    nombre:    '5° Básico A — DEMO',
    anio:      new Date().getFullYear(),
    activo:    true,
  });
  console.log('  ✅ Curso creado:', CURSO_ID);

  // 2. Tres alumnos ficticios
  const alumnos = [
    { id: uid('demo-alu-'), nombres: 'Valentina', apellidos: 'Morales Pérez' },
    { id: uid('demo-alu-'), nombres: 'Matías',    apellidos: 'González Riquelme' },
    { id: uid('demo-alu-'), nombres: 'Isidora',   apellidos: 'Vidal Torres' },
  ];
  for (const a of alumnos) {
    await POST('/rest/v1/alumnos', {
      id:        a.id,
      cuenta_id: CUENTA,
      curso_id:  CURSO_ID,
      nombres:   a.nombres,
      apellidos: a.apellidos,
      estado:    'activo',
    });
  }
  console.log('  ✅ Alumnos creados:', alumnos.map(a => a.nombres).join(', '));

  // 3. Cuota mensual
  const CUOTA_ID = uid('demo-cuot-');
  await POST('/rest/v1/cuotas', {
    id:        CUOTA_ID,
    cuenta_id: CUENTA,
    curso_id:  CURSO_ID,
    nombre:    'Cuota Marzo 2026 — DEMO',
    tipo:      'mensual',
    monto:     90000,
    anio:      new Date().getFullYear(),
    activa:    true,
  });
  console.log('  ✅ Cuota creada:', CUOTA_ID, '— $90.000');

  // 4. Código CC apoderado
  var cc = await rpc('apoderado_cc_generar', { p_cuenta_id: CUENTA, p_curso_id: CURSO_ID });
  var CC_CODE = (cc && cc.codigo_cc) || (typeof cc === 'string' ? cc : null);
  console.log('  ✅ Código CC apoderado:', CC_CODE);

  // 5. Guardar IDs
  const ids = { CUENTA, CURSO_ID, CUOTA_ID, CC_CODE, alumnos };
  fs.writeFileSync(IDS_FILE, JSON.stringify(ids, null, 2));

  console.log('');
  console.log('══════════════════════════════════════════════');
  console.log('  DATOS PARA EL RECORRIDO DE STAGING (B2)');
  console.log('══════════════════════════════════════════════');
  console.log('  Cuenta:       ', CUENTA);
  console.log('  Curso:         5° Básico A — DEMO (' + CURSO_ID + ')');
  console.log('  Cuota:         Cuota Marzo 2026 — $90.000 (' + CUOTA_ID + ')');
  console.log('  Código CC:    ', CC_CODE);
  console.log('  Alumnos:');
  alumnos.forEach(function(a, i) {
    console.log('    ' + (i+1) + '. ' + a.nombres + ' ' + a.apellidos + ' (' + a.id + ')');
  });
  console.log('');
  console.log('  IDs guardados en:', IDS_FILE);
  console.log('  Limpieza: node tests/e8_seed_demo.js --cleanup');
  console.log('══════════════════════════════════════════════');
}

// ─── Limpiar fixtures ─────────────────────────────────────────────────────────
async function cleanup() {
  if (!fs.existsSync(IDS_FILE)) {
    console.error('No se encontró', IDS_FILE, '— nada que limpiar.');
    process.exit(0);
  }
  await login();
  const ids = JSON.parse(fs.readFileSync(IDS_FILE, 'utf8'));
  const { CURSO_ID, CUOTA_ID, alumnos } = ids;

  // Eliminar en orden: abonos → planes → alumnos → cuotas → cursos
  for (const a of (alumnos || [])) {
    await DELETE('/rest/v1/abonos?cuenta_id=eq.' + CUENTA + '&alumno_id=eq.' + a.id);
    await DELETE('/rest/v1/planes_pago?cuenta_id=eq.' + CUENTA + '&alumno_id=eq.' + a.id);
    await DELETE('/rest/v1/alumnos?cuenta_id=eq.' + CUENTA + '&id=eq.' + a.id);
  }
  if (CUOTA_ID)
    await DELETE('/rest/v1/cuotas?cuenta_id=eq.' + CUENTA + '&id=eq.' + CUOTA_ID);
  if (CURSO_ID)
    await DELETE('/rest/v1/cursos?cuenta_id=eq.' + CUENTA + '&id=eq.' + CURSO_ID);

  fs.unlinkSync(IDS_FILE);
  console.log('✅ Fixtures de demo eliminados.');
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const isCleanup = process.argv.includes('--cleanup');
(isCleanup ? cleanup() : seedDemo()).catch(function(err) {
  console.error('Error:', err.message || err);
  process.exit(1);
});
