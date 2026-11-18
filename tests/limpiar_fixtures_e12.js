/**
 * tests/limpiar_fixtures_e12.js
 *
 * Limpieza de fixtures residuales de un run de E12.
 *
 * Fase 1 (solo lectura): busca cursos/alumnos/pagos con el EXEC_ID indicado,
 *   muestra los IDs exactos y el plan de borrado.
 * Fase 2 (escritura): pide confirmación Y/n y ejecuta DELETE + verificación GET.
 *
 * Uso:
 *   node tests/limpiar_fixtures_e12.js mwlkf5p9
 *
 * Variables de entorno requeridas (mismas que e12):
 *   STAGING_SUPABASE_URL / STAGING_URL
 *   STAGING_SUPABASE_ANON_KEY / STAGING_KEY
 *   STAGING_USER_A_EMAIL / STAGING_EMAIL
 *   STAGING_USER_A_PASSWORD / STAGING_PASS
 *   STAGING_CUENTA_ID (opcional — si no está, se descubre por auth_id)
 */

'use strict';

const path     = require('path');
const https    = require('https');
const readline = require('readline');

try { require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') }); } catch(_) {}

const EXEC_ID_ARG = process.argv[2];
if (!EXEC_ID_ARG) {
  console.error('Uso: node tests/limpiar_fixtures_e12.js <exec_id>');
  console.error('Ejemplo: node tests/limpiar_fixtures_e12.js mwlkf5p9');
  process.exit(1);
}

const SUPA_URL = (process.env.STAGING_SUPABASE_URL || process.env.STAGING_URL || '').replace(/\/$/, '');
const ANON_KEY = process.env.STAGING_SUPABASE_ANON_KEY || process.env.STAGING_KEY || '';
const EMAIL    = process.env.STAGING_USER_A_EMAIL || process.env.STAGING_EMAIL || '';
const PASS     = process.env.STAGING_USER_A_PASSWORD || process.env.STAGING_PASS || '';

const PROD_HOST    = 'tmjqzaakzhecbldebyeg.supabase.co';
const STAGING_HOST = 'rucgmytyxpfowznowxwd.supabase.co';

if (!SUPA_URL || !ANON_KEY || !EMAIL || !PASS) {
  console.error('❌ Faltan variables de entorno'); process.exit(1);
}
let parsedHost;
try { parsedHost = new URL(SUPA_URL).hostname; } catch(_) { process.exit(2); }
if (parsedHost === PROD_HOST || parsedHost !== STAGING_HOST) {
  console.error('🛑 URL no autorizada:', parsedHost); process.exit(2);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function _fetch(urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const url  = new URL(SUPA_URL + urlPath);
    const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const hdrs = {
      'apikey':       ANON_KEY,
      'Content-Type': 'application/json',
      'Accept':       'application/json',
      'Prefer':       opts.prefer !== undefined ? opts.prefer : 'return=representation',
      ...(opts.headers || {}),
    };
    if (opts.auth) hdrs['Authorization'] = 'Bearer ' + opts.auth;
    if (body) hdrs['Content-Length'] = String(Buffer.byteLength(body));
    const req = https.request(
      { hostname: url.hostname, path: url.pathname + url.search,
        method: opts.method || 'GET', headers: hdrs },
      res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          let parsed; try { parsed = JSON.parse(data); } catch(_) { parsed = data; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
function supaAuth(urlPath, jwt, opts = {}) {
  return _fetch(urlPath, { ...opts, auth: jwt });
}
function supaAnon(urlPath, opts = {}) {
  return _fetch(urlPath, opts);
}

function preguntar(pregunta) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(pregunta, ans => { rl.close(); res(ans.trim()); }));
}

// ── Autenticación e identidad ─────────────────────────────────────────────────

async function login() {
  const r = await supaAnon('/auth/v1/token?grant_type=password', {
    method: 'POST', prefer: '',
    body: { email: EMAIL, password: PASS },
  });
  if (r.status !== 200 || !r.body?.access_token)
    throw new Error('Login fallido: ' + JSON.stringify(r.body));
  return r.body.access_token;
}

function jwtSub(token) {
  try {
    const payload = token.split('.')[1];
    const padded  = payload + '='.repeat((4 - payload.length % 4) % 4);
    return JSON.parse(Buffer.from(padded, 'base64url').toString('utf8')).sub || null;
  } catch { return null; }
}

async function descubrirCuenta(jwt) {
  const sub = jwtSub(jwt);
  if (!sub) throw new Error('descubrirCuenta: no se pudo extraer sub del JWT');
  const r = await supaAuth(
    `/rest/v1/tesorero_cuentas?auth_id=eq.${encodeURIComponent(sub)}&select=id&limit=1`, jwt
  );
  if (r.status !== 200 || !Array.isArray(r.body) || r.body.length === 0)
    throw new Error(`descubrirCuenta: auth_id=${sub} → ${JSON.stringify(r.body)}`);
  return r.body[0].id;
}

// ── Búsqueda de residuos (solo lectura) ───────────────────────────────────────

async function buscarResiduos(jwt, cuentaId, execId) {
  // Cursos: nombre LIKE 'FixtureCurso-{execId}-%'
  const rC = await supaAuth(
    `/rest/v1/cursos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&nombre=like.FixtureCurso-${encodeURIComponent(execId)}-*&select=id,nombre`,
    jwt
  );
  const cursos = (rC.status === 200 && Array.isArray(rC.body)) ? rC.body : [];

  // Alumnos: apellidos = execId (todos los fixtures usan el execId como apellido)
  const rA = await supaAuth(
    `/rest/v1/alumnos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&apellidos=eq.${encodeURIComponent(execId)}&select=id,nombres,apellidos,curso_id`,
    jwt
  );
  const alumnos = (rA.status === 200 && Array.isArray(rA.body)) ? rA.body : [];

  // Pagos: obs = 'FixturePago E12 {execId}'
  const obsValor = `FixturePago E12 ${execId}`;
  const rP = await supaAuth(
    `/rest/v1/pagos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&obs=eq.${encodeURIComponent(obsValor)}&select=id,obs,alumno_id,fecha`,
    jwt
  );
  const pagos = (rP.status === 200 && Array.isArray(rP.body)) ? rP.body : [];

  return { cursos, alumnos, pagos };
}

// ── Limpieza con verificación ─────────────────────────────────────────────────

async function eliminar(jwt, cuentaId, tabla, id) {
  const rDel = await supaAuth(
    `/rest/v1/${tabla}?id=eq.${encodeURIComponent(id)}&cuenta_id=eq.${encodeURIComponent(cuentaId)}`,
    jwt, { method: 'DELETE', prefer: '' }
  );
  if (rDel.status < 200 || rDel.status >= 300)
    return { ok: false, razon: `DELETE HTTP ${rDel.status}` };
  const rGet = await supaAuth(
    `/rest/v1/${tabla}?id=eq.${encodeURIComponent(id)}&select=id`, jwt
  );
  if (rGet.status !== 200) return { ok: false, razon: `GET verificación HTTP ${rGet.status}` };
  if (Array.isArray(rGet.body) && rGet.body.length > 0)
    return { ok: false, razon: 'sigue en DB después de DELETE' };
  return { ok: true };
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  Limpiar fixtures E12 — run ${EXEC_ID_ARG} (staging)`);
  console.log('══════════════════════════════════════════════════════════════\n');
  console.log(`Staging : ${SUPA_URL}`);

  // ── Login ─────────────────────────────────────────────────────────────────
  let jwt, cuentaId;
  try {
    jwt      = await login();
    cuentaId = process.env.STAGING_CUENTA_ID || await descubrirCuenta(jwt);
    console.log(`Cuenta  : ${cuentaId}`);
    console.log('Login OK\n');
  } catch (e) {
    console.error('❌ Login/cuenta fallido:', e.message); process.exit(1);
  }

  // ── Fase 1: solo lectura ──────────────────────────────────────────────────
  console.log(`[Fase 1] Buscar residuos del run "${EXEC_ID_ARG}" (solo lectura)…`);
  let residuos;
  try {
    residuos = await buscarResiduos(jwt, cuentaId, EXEC_ID_ARG);
  } catch (e) {
    console.error('❌ Error en búsqueda:', e.message); process.exit(1);
  }

  const { cursos, alumnos, pagos } = residuos;
  const total = cursos.length + alumnos.length + pagos.length;

  console.log(`\n[Cursos encontrados: ${cursos.length}]`);
  if (cursos.length === 0) console.log('  (ninguno)');
  else cursos.forEach(c => console.log(`  ${c.id}  "${c.nombre}"`));

  console.log(`\n[Alumnos encontrados: ${alumnos.length}]`);
  if (alumnos.length === 0) console.log('  (ninguno)');
  else alumnos.forEach(a => console.log(`  ${a.id}  "${a.nombres} ${a.apellidos}"  curso_id=${a.curso_id}`));

  console.log(`\n[Pagos encontrados: ${pagos.length}]`);
  if (pagos.length === 0) console.log('  (ninguno)');
  else pagos.forEach(p => console.log(`  ${p.id}  alumno_id=${p.alumno_id}  fecha=${p.fecha}`));

  if (total === 0) {
    console.log('\n✅ No se encontraron residuos del run ' + EXEC_ID_ARG + '. Sin acción necesaria.');
    process.exit(0);
  }

  // ── Plan de borrado ───────────────────────────────────────────────────────
  console.log('\n[Plan de limpieza — delimitado por cuenta]');
  console.log(`  Cuenta : ${cuentaId}`);
  console.log(`  Staging: ${SUPA_URL}`);
  console.log(`  Orden  : pagos → alumnos → cursos (respeta FK)`);
  console.log(`  Pagos  : ${pagos.length} DELETE en /rest/v1/pagos?id=eq.{id}&cuenta_id=eq.${cuentaId}`);
  console.log(`  Alumnos: ${alumnos.length} DELETE en /rest/v1/alumnos?id=eq.{id}&cuenta_id=eq.${cuentaId}`);
  console.log(`  Cursos : ${cursos.length} DELETE en /rest/v1/cursos?id=eq.{id}&cuenta_id=eq.${cuentaId}`);
  console.log(`  Total  : ${total} registros`);

  // ── Confirmación ─────────────────────────────────────────────────────────
  const resp = await preguntar('\n¿Ejecutar limpieza? (Y/n) > ');
  if (resp.toLowerCase() !== 'y' && resp !== '') {
    console.log('  Cancelado.'); process.exit(0);
  }

  // ── Fase 2: borrado con verificación ─────────────────────────────────────
  console.log('\n[Fase 2] Eliminando…');
  let fallos = 0;

  for (const p of pagos) {
    const r = await eliminar(jwt, cuentaId, 'pagos', p.id);
    if (r.ok) console.log(`  ✅ pago   ${p.id}`);
    else { console.error(`  ❌ pago   ${p.id}: ${r.razon}`); fallos++; }
  }
  for (const a of alumnos) {
    const r = await eliminar(jwt, cuentaId, 'alumnos', a.id);
    if (r.ok) console.log(`  ✅ alumno ${a.id}`);
    else { console.error(`  ❌ alumno ${a.id}: ${r.razon}`); fallos++; }
  }
  for (const c of cursos) {
    const r = await eliminar(jwt, cuentaId, 'cursos', c.id);
    if (r.ok) console.log(`  ✅ curso  ${c.id}`);
    else { console.error(`  ❌ curso  ${c.id}: ${r.razon}`); fallos++; }
  }

  console.log(`\n[Resumen] ${total - fallos}/${total} eliminados correctamente`);
  if (fallos > 0) {
    console.error(`  ❌ ${fallos} fallo(s) — revisar manualmente`);
    process.exit(1);
  } else {
    console.log('  ✅ Limpieza completa y verificada.');
    process.exit(0);
  }
})();
