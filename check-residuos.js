/**
 * check-residuos.js
 * Verifica y limpia fixtures residuales del EXEC_ID interrumpido (mwggyd89)
 * y de cualquier otra ejecución de test-e6 incompleta.
 *
 * Uso:
 *   node check-residuos.js          <- solo muestra lo que quedó
 *   node check-residuos.js --limpiar <- elimina los residuos mostrados
 */
'use strict';
require('dotenv').config();

const LIMPIAR = process.argv.includes('--limpiar');

const URL   = (process.env.STAGING_URL || process.env.STAGING_SUPABASE_URL || '').replace(/\/$/, '');
const KEY   = process.env.STAGING_KEY  || process.env.STAGING_SUPABASE_ANON_KEY || '';
const EMAIL = process.env.STAGING_EMAIL || process.env.STAGING_USER_A_EMAIL || '';
const PASS  = process.env.STAGING_PASS  || process.env.STAGING_USER_A_PASSWORD || '';

if (!URL || !KEY || !EMAIL || !PASS) {
  console.error('Faltan variables en .env');
  process.exit(1);
}
if (URL.includes('tmjqzaakzhecbldebyeg')) {
  console.error('URL apunta a PRODUCCION. Abortando.');
  process.exit(1);
}

const BASE = URL + '/rest/v1';

(async () => {
  // 1. Login
  const loginRes = await fetch(URL + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { 'apikey': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  });
  if (!loginRes.ok) { console.error('Login falló:', await loginRes.text()); process.exit(1); }
  const tok = (await loginRes.json()).access_token;

  const h = {
    'apikey': KEY,
    'Authorization': 'Bearer ' + tok,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  };

  // 2. Obtener cuenta
  const cuentas = await (await fetch(BASE + '/tesorero_cuentas?select=id&limit=1', { headers: h })).json();
  const cid = cuentas?.[0]?.id;
  if (!cid) { console.error('No se encontró cuenta'); process.exit(1); }
  console.log('cuenta_id:', cid);

  // 3. Buscar residuos de cualquier run de test-e6
  const checks = [
    { tabla: 'movimientos', filtro: `desc=like.E6*`,       campo: 'id,desc,monto' },
    { tabla: 'alumnos',     filtro: `nombres=eq.E6Fixture`, campo: 'id,nombres,apellidos' },
    { tabla: 'cursos',      filtro: `nombre=like.[test-e6]*`, campo: 'id,nombre' },
  ];

  let totalResiduos = 0;
  for (const { tabla, filtro, campo } of checks) {
    const url = `${BASE}/${tabla}?cuenta_id=eq.${cid}&${filtro}&select=${campo}`;
    const rows = await (await fetch(url, { headers: h })).json();
    if (rows.length === 0) {
      console.log(`  ${tabla}: sin residuos`);
    } else {
      console.log(`  ${tabla} (${rows.length} residuo/s):`);
      rows.forEach(r => console.log('    ', JSON.stringify(r)));
      totalResiduos += rows.length;
    }
  }

  if (totalResiduos === 0) {
    console.log('\nEstaging limpio — no hay residuos de test-e6.');
    return;
  }

  if (!LIMPIAR) {
    console.log(`\n${totalResiduos} residuo/s encontrado/s.`);
    console.log('Para eliminarlos, ejecuta:\n  node check-residuos.js --limpiar');
    return;
  }

  // 4. Limpiar en orden (movimientos primero para respetar FK)
  console.log('\nEliminando residuos...');
  for (const { tabla, filtro } of checks) {
    const url = `${BASE}/${tabla}?cuenta_id=eq.${cid}&${filtro}`;
    const r = await fetch(url, { method: 'DELETE', headers: { ...h, 'Prefer': 'return=minimal' } });
    console.log(`  DELETE ${tabla}: HTTP ${r.status} ${r.ok ? 'OK' : await r.text()}`);
  }
  console.log('Hecho.');
})().catch(err => { console.error('Error:', err.message); process.exit(1); });
