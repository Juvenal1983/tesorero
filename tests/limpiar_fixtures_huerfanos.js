/**
 * tests/limpiar_fixtures_huerfanos.js
 *
 * Limpia fixtures de ejecuciones anteriores del test e7_ui.js que no
 * se eliminaron por un fallo en el teardown.
 *
 * Uso:
 *   node tests/limpiar_fixtures_huerfanos.js [exec_id...]
 *
 * Ejemplos:
 *   node tests/limpiar_fixtures_huerfanos.js mwi1u7sa
 *   node tests/limpiar_fixtures_huerfanos.js mwi1u7sa abc12345
 *
 * Sin argumentos: busca y lista todos los cursos cuyo nombre empiece
 * con "[e7ui]" o "[e7ui-B]" delimitados por la cuenta del usuario A.
 * No borra nada sin argumento — solo muestra lo que encuentra.
 *
 * Con argumentos: borra exactamente los IDs generados por esas ejecuciones:
 *   cursos:           crs-e7ui-<id>  y  crs-e7ui2-<id>
 *   alumnos:          alu-e7ui-{1,2,3}-<id>
 *   fondo_movimientos: filtrado por curso_id
 *   actividades:       filtrado por curso_id
 *   usuarios_cuenta:   uc-e7ui-c-<id>
 *
 * Producción nunca tocada: aborta si SUPA_URL = tmjqzaakzhecbldebyeg.supabase.co
 *
 * Variables de entorno (.env):
 *   STAGING_URL / STAGING_SUPABASE_URL
 *   STAGING_KEY / STAGING_SUPABASE_ANON_KEY
 *   STAGING_EMAIL / STAGING_USER_A_EMAIL
 *   STAGING_PASS  / STAGING_USER_A_PASSWORD
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const SUPA_URL   = (process.env.STAGING_URL || process.env.STAGING_SUPABASE_URL || '').replace(/\/$/, '');
const ANON_KEY   = process.env.STAGING_KEY  || process.env.STAGING_SUPABASE_ANON_KEY || '';
const USER_EMAIL = process.env.STAGING_EMAIL || process.env.STAGING_USER_A_EMAIL || '';
const USER_PASS  = process.env.STAGING_PASS  || process.env.STAGING_USER_A_PASSWORD || '';

if (SUPA_URL.includes('tmjqzaakzhecbldebyeg')) {
  console.error('🚫 URL apunta a producción. Abortando.'); process.exit(1);
}
if (!SUPA_URL || !ANON_KEY || !USER_EMAIL || !USER_PASS) {
  console.error('❌ Faltan variables en .env (STAGING_URL/KEY/EMAIL/PASS)'); process.exit(1);
}

// ── REST helper ──────────────────────────────────────────────────────────────
async function rest(urlPath, opts = {}, token = '') {
  const url = `${SUPA_URL}/rest/v1${urlPath}`;
  const res = await fetch(url, {
    method: opts.method || 'GET',
    body:   opts.body   || undefined,
    headers: {
      'apikey':        ANON_KEY,
      'Authorization': `Bearer ${token || ANON_KEY}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
      'Prefer':        opts.prefer ?? 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, body: text ? JSON.parse(text) : null };
}

// ── Autenticar ────────────────────────────────────────────────────────────────
async function autenticar() {
  const res = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: USER_EMAIL, password: USER_PASS }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(`Auth: ${JSON.stringify(data)}`);
  return data.access_token;
}

// ── Limpiar un exec_id ────────────────────────────────────────────────────────
async function limpiarExecId(jwt, cuentaId, execId) {
  const cursoId  = `crs-e7ui-${execId}`;
  const curso2Id = `crs-e7ui2-${execId}`;
  const ucId     = `uc-e7ui-c-${execId}`;
  const aluIds   = [1, 2, 3].map(i => `alu-e7ui-${i}-${execId}`);

  console.log(`\n  Limpiando exec_id="${execId}"`);
  console.log(`    cursos: ${cursoId}, ${curso2Id}`);
  console.log(`    alumnos: ${aluIds.join(', ')}`);
  console.log(`    usuarios_cuenta: ${ucId}`);

  let eliminados = 0;

  // membresía visor C
  const rUC = await rest(
    `/usuarios_cuenta?id=eq.${encodeURIComponent(ucId)}&cuenta_id=eq.${encodeURIComponent(cuentaId)}`,
    { method: 'DELETE', headers: { 'Prefer': '' } }, jwt
  );
  if (rUC.status === 204 || rUC.status === 200) {
    console.log(`    ✓ usuarios_cuenta ${ucId} eliminado`); eliminados++;
  } else {
    console.log(`    - usuarios_cuenta ${ucId}: HTTP ${rUC.status} (puede no existir)`);
  }

  // fondo_movimientos y actividades del curso fixture
  for (const tabla of ['fondo_movimientos', 'actividades']) {
    const r = await rest(
      `/${tabla}?cuenta_id=eq.${encodeURIComponent(cuentaId)}&curso_id=eq.${encodeURIComponent(cursoId)}`,
      { method: 'DELETE', headers: { 'Prefer': '' } }, jwt
    );
    if (r.status === 204 || r.status === 200) {
      console.log(`    ✓ ${tabla} del curso ${cursoId} eliminados`); eliminados++;
    } else {
      console.log(`    - ${tabla}: HTTP ${r.status}`);
    }
  }

  // alumnos
  const rAlu = await rest(
    `/alumnos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&curso_id=eq.${encodeURIComponent(cursoId)}`,
    { method: 'DELETE', headers: { 'Prefer': '' } }, jwt
  );
  if (rAlu.status === 204 || rAlu.status === 200) {
    console.log(`    ✓ alumnos del curso ${cursoId} eliminados`); eliminados++;
  } else {
    console.log(`    - alumnos: HTTP ${rAlu.status}`);
  }

  // cursos
  for (const id of [cursoId, curso2Id]) {
    const r = await rest(
      `/cursos?id=eq.${encodeURIComponent(id)}&cuenta_id=eq.${encodeURIComponent(cuentaId)}`,
      { method: 'DELETE', headers: { 'Prefer': '' } }, jwt
    );
    if (r.status === 204 || r.status === 200) {
      console.log(`    ✓ curso ${id} eliminado`); eliminados++;
    } else {
      console.log(`    - curso ${id}: HTTP ${r.status} (puede no existir)`);
    }
  }

  return eliminados;
}

// ── Listar fixtures huérfanos ─────────────────────────────────────────────────
async function listarHuerfanos(jwt, cuentaId) {
  const rC = await rest(
    `/cursos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&nombre=like.%5Be7ui%5D%25&select=id,nombre,created_at`,
    {}, jwt
  );
  const rC2 = await rest(
    `/cursos?cuenta_id=eq.${encodeURIComponent(cuentaId)}&nombre=like.%5Be7ui-B%5D%25&select=id,nombre,created_at`,
    {}, jwt
  );
  const todos = [...(rC.body || []), ...(rC2.body || [])];
  if (!todos.length) {
    console.log('  No se encontraron cursos e7ui huérfanos.');
    return;
  }
  console.log(`\n  Cursos e7ui encontrados (${todos.length}):`);
  for (const c of todos) {
    // Extraer exec_id del nombre: "[e7ui] <exec_id>" o "[e7ui-B] <exec_id>"
    const execId = (c.nombre || '').replace(/^\[e7ui[^\]]*\]\s*/, '');
    console.log(`    id="${c.id}"  nombre="${c.nombre}"  exec_id="${execId}"  created_at="${c.created_at}"`);
  }
  console.log('\n  Para limpiar, pasa los exec_id como argumentos:');
  const ids = [...new Set(todos.map(c => (c.nombre || '').replace(/^\[e7ui[^\]]*\]\s*/, '')))];
  console.log(`    node tests/limpiar_fixtures_huerfanos.js ${ids.join(' ')}`);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
(async () => {
  const args = process.argv.slice(2).filter(Boolean);

  console.log('\n=== Limpieza de fixtures e7ui huérfanos ===');
  console.log(`SUPA: ${SUPA_URL}`);

  const jwt = await autenticar();
  const rCta = await rest('/tesorero_cuentas?select=id', {}, jwt);
  if (!rCta.ok || !rCta.body?.length) {
    console.error('No se encontró cuenta para usuario A'); process.exit(1);
  }
  const cuentaId = rCta.body[0].id;
  console.log(`Cuenta: ${cuentaId}`);

  if (!args.length) {
    console.log('\nSin argumentos — listando fixtures huérfanos encontrados:');
    await listarHuerfanos(jwt, cuentaId);
  } else {
    console.log(`\nLimpiando exec_ids: ${args.join(', ')}`);
    let total = 0;
    for (const id of args) {
      total += await limpiarExecId(jwt, cuentaId, id);
    }
    console.log(`\n  Total de operaciones completadas: ${total}`);
  }
  console.log('');
})().catch(e => { console.error(e.message); process.exit(1); });
