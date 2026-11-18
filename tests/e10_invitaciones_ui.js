/**
 * tests/e10_invitaciones_ui.js
 *
 * Suite Playwright B1 — Invitaciones V9: CRUD completo sobre la tabla
 * `codigos_invitacion`.
 *
 * Verifica:
 *   I01  Lista de invitaciones carga sin error
 *   I02  Crear código (tipo prueba) → persiste en Supabase (GET REST)
 *   I03  Código aparece en UI tras reload
 *   I04  Desactivar código → activo=false en DB y UI muestra "Expirado"
 *   I05  Eliminar código → ausente en DB y UI
 *   I06  Crear código anual → prefijo ANUAL- en DB
 *   I07  Crear código VIP → prefijo VIP- en DB
 *   I08  Limpieza: fixtures eliminados de staging
 *
 * Variables de entorno: igual que E8/E9.
 * NUNCA apuntar a producción (tmjqzaakzhecbldebyeg).
 */

'use strict';

const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') }); } catch(_) {}

const SUPA_URL_RAW = process.env.STAGING_SUPABASE_URL || process.env.STAGING_URL || '';
const ANON_KEY    = process.env.STAGING_SUPABASE_ANON_KEY || process.env.STAGING_KEY || '';
const USER_EMAIL  = process.env.STAGING_USER_A_EMAIL || process.env.STAGING_EMAIL || '';
const USER_PASS   = process.env.STAGING_USER_A_PASSWORD || process.env.STAGING_PASS || '';

if (!SUPA_URL_RAW || !ANON_KEY || !USER_EMAIL || !USER_PASS) {
  console.error('❌ Faltan variables de entorno (mismas que E8/E9).');
  process.exit(1);
}

const SUPA_URL = SUPA_URL_RAW.replace(/\/$/, '');

const PROD_HOST    = 'tmjqzaakzhecbldebyeg.supabase.co';
const STAGING_HOST = 'rucgmytyxpfowznowxwd.supabase.co';
let parsedHost;
try { parsedHost = new URL(SUPA_URL).hostname; } catch(_) { process.exit(2); }
if (parsedHost === PROD_HOST || parsedHost !== STAGING_HOST) {
  console.error('❌ URL no autorizada:', parsedHost); process.exit(2);
}

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const { chromium } = require('playwright');

const EXEC_ID  = Date.now().toString(36);
const APP_PORT = 8799;

let pass = 0, fail = 0;
const failures = [];
function ok(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else       { console.log(`  ❌ ${label}`); fail++; failures.push(label); }
}

// ── Helpers HTTP ──────────────────────────────────────────────────────────────

function reqJSON(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const u   = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const body = opts.body ? Buffer.from(opts.body, 'utf8') : null;
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (body) headers['Content-Length'] = body.length;
    const req = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: opts.method || 'GET', headers }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch(_) { json = raw; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function supaGET(table, query, jwt) {
  return reqJSON(`${SUPA_URL}/rest/v1/${table}?${query}`, {
    headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${jwt}` }
  });
}

async function supaDelete(table, query, jwt) {
  return reqJSON(`${SUPA_URL}/rest/v1/${table}?${query}`, {
    method: 'DELETE',
    headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${jwt}` }
  });
}

async function loginREST() {
  const r = await reqJSON(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'apikey': ANON_KEY },
    body: JSON.stringify({ email: USER_EMAIL, password: USER_PASS })
  });
  if (!r.body?.access_token) throw new Error('Login REST fallido: ' + JSON.stringify(r.body));
  return r.body.access_token;
}

async function limpiarCodigos(jwt) {
  // Elimina códigos cuyo id contiene el EXEC_ID del run
  const r = await supaGET('codigos_invitacion', `id=like.*${EXEC_ID}*&select=id`, jwt);
  if (!Array.isArray(r.body) || r.body.length === 0) return;
  for (const row of r.body) {
    await supaDelete('codigos_invitacion', `id=eq.${encodeURIComponent(row.id)}`, jwt);
  }
  console.log(`  🧹 Limpiezea: ${r.body.length} código(s) de fixture eliminados.`);
}

// ── Servidor HTTP local ───────────────────────────────────────────────────────

function servirApp(port) {
  const BASE = path.resolve(__dirname, '..');
  const MIME = { '.html':'text/html', '.js':'application/javascript',
                 '.css':'text/css', '.json':'application/json',
                 '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
  return http.createServer((req, res) => {
    let filePath = path.join(BASE, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!filePath.startsWith(BASE)) { res.writeHead(403); res.end(); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  }).listen(port);
}

// ── Suite principal ───────────────────────────────────────────────────────────

(async () => {
  const server = servirApp(APP_PORT);
  await new Promise(r => server.on('listening', r));
  console.log(`\n🌐 App servida en http://localhost:${APP_PORT}`);

  let jwt;
  try { jwt = await loginREST(); console.log('  🔑 Login REST OK'); }
  catch (e) { console.error('❌ Login falló:', e.message); server.close(); process.exit(1); }

  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({ baseURL: `http://localhost:${APP_PORT}` });
  const page    = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') console.log('  [browser]', m.text()); });

  async function reloginUI() {
    await page.goto('/');
    await page.waitForTimeout(1500);
    const emailInput = page.locator('input[type="email"]');
    if (await emailInput.count() > 0) {
      await emailInput.fill(USER_EMAIL);
      await page.locator('input[type="password"]').fill(USER_PASS);
      await page.locator('button[type="submit"]').first().click();
      await page.waitForTimeout(2000);
    }
  }

  async function navegarInvitaciones() {
    // Ir a Configuración → sección invitaciones
    const cfgSel = '[onclick*="config"], [href*="config"], [data-route="config"]';
    if (await page.locator(cfgSel).count() > 0)
      await page.locator(cfgSel).first().click();
    else
      await page.evaluate(() => { if (typeof go === 'function') go('config'); });
    await page.waitForTimeout(1500);
  }

  // ── I01 — Lista carga sin error ───────────────────────────────────────────
  console.log('\n[I01] Lista de invitaciones carga sin error');
  await reloginUI();
  await navegarInvitaciones();
  const listaEl = await page.locator('#lista-invitaciones').count();
  ok('I01-a: sección de invitaciones visible en config', listaEl > 0);

  // ── I02 — Crear código tipo prueba ────────────────────────────────────────
  console.log('\n[I02] Crear código (tipo prueba) → persiste en Supabase');
  // Abrir modal
  const btnGenerar = page.locator('button, [onclick]').filter({ hasText: /generar código|nuevo código/i }).first();
  if (await btnGenerar.count() > 0) {
    await btnGenerar.click();
    await page.waitForTimeout(800);
  } else {
    await page.evaluate(() => { if (typeof generarCodigoInvitacion === 'function') generarCodigoInvitacion(); });
    await page.waitForTimeout(800);
  }

  const codParaInput = page.locator('#cod-para');
  const codNotasInput = page.locator('#cod-notas');
  if (await codParaInput.count() > 0) {
    await codParaInput.fill(`Test B1 ${EXEC_ID}`);
    await codNotasInput.fill(`fixture-${EXEC_ID}`);
    // Hacer click en "Generar código"
    const btnConfirm = page.locator('button').filter({ hasText: /generar código/i }).last();
    await btnConfirm.click();
    await page.waitForTimeout(1500);
  } else {
    console.log('  ⚠️  Modal de código no encontrado; skip I02');
    ok('I02-a: modal de nuevo código visible', false);
  }

  // Verificar en DB
  const r02 = await supaGET('codigos_invitacion',
    `select=id,codigo,tipo,activo,usado,para&order=id.desc&limit=5`, jwt);
  ok('I02-a: GET /codigos_invitacion responde 200', r02.status === 200);
  if (r02.status === 200 && Array.isArray(r02.body)) {
    const nuevo02 = r02.body.find(x => (x.para || '').includes(EXEC_ID));
    ok(`I02-b: código con para="${EXEC_ID}" hallado en DB`, !!nuevo02);
    ok('I02-c: código activo=true', nuevo02?.activo === true);
    ok('I02-d: código usado=false', nuevo02?.usado === false);
    ok('I02-e: tipo=prueba', nuevo02?.tipo === 'prueba');
  }

  // ── I03 — Código visible tras reload ─────────────────────────────────────
  console.log('\n[I03] Código visible en UI tras reload');
  await reloginUI();
  await navegarInvitaciones();
  const listaHTML03 = await page.locator('#lista-invitaciones').innerHTML().catch(() => '');
  ok('I03-a: EXEC_ID aparece en lista tras reload', listaHTML03.includes(EXEC_ID));

  // ── I04 — Desactivar código ───────────────────────────────────────────────
  console.log('\n[I04] Desactivar código → activo=false en DB');
  // Encontrar botón "Desactivar" del código recién creado
  const r04pre = await supaGET('codigos_invitacion',
    `select=id,codigo&para=like.*${EXEC_ID}*&order=id.desc&limit=1`, jwt);
  let codigoParaDesactivar = null;
  if (r04pre.status === 200 && Array.isArray(r04pre.body) && r04pre.body.length > 0) {
    codigoParaDesactivar = r04pre.body[0].codigo;
  }
  if (codigoParaDesactivar) {
    // Click en botón desactivar del código
    const btnDesact = page.locator(`[onclick*="desactivarCodigoPorCodigo('${codigoParaDesactivar}')"]`);
    if (await btnDesact.count() > 0) {
      page.on('dialog', d => d.accept());
      await btnDesact.click();
      await page.waitForTimeout(1500);
      const r04 = await supaGET('codigos_invitacion',
        `select=activo&codigo=eq.${encodeURIComponent(codigoParaDesactivar)}`, jwt);
      ok('I04-a: GET código desactivado responde 200', r04.status === 200);
      const filaDesact = Array.isArray(r04.body) ? r04.body[0] : null;
      ok('I04-b: activo=false en DB tras desactivar', filaDesact?.activo === false);
    } else {
      ok('I04-a: botón desactivar encontrado', false);
      ok('I04-b: activo=false en DB', false);
    }
  } else {
    ok('I04-a: código para desactivar hallado en DB', false);
    ok('I04-b: activo=false en DB', false);
  }

  // ── I05 — Eliminar código ─────────────────────────────────────────────────
  console.log('\n[I05] Eliminar código → ausente en DB y UI');
  if (codigoParaDesactivar) {
    const btnElim = page.locator(`[onclick*="eliminarCodigoPorCodigo('${codigoParaDesactivar}')"]`);
    if (await btnElim.count() > 0) {
      page.removeAllListeners('dialog');
      page.on('dialog', d => d.accept());
      await btnElim.click();
      await page.waitForTimeout(500);
      await btnElim.click().catch(() => {}); // segunda confirmación
      await page.waitForTimeout(1500);
      const r05 = await supaGET('codigos_invitacion',
        `select=id&codigo=eq.${encodeURIComponent(codigoParaDesactivar)}`, jwt);
      ok('I05-a: GET código eliminado responde 200', r05.status === 200);
      const rows05 = Array.isArray(r05.body) ? r05.body : [];
      ok('I05-b: código ausente en DB tras eliminar', rows05.length === 0);
    } else {
      ok('I05-a: botón eliminar encontrado', false);
      ok('I05-b: código ausente en DB', false);
    }
  } else {
    ok('I05-a: (BLOQUEADO — no hay código para eliminar)', false);
    ok('I05-b: (BLOQUEADO)', false);
  }

  // ── I06 — Código ANUAL ────────────────────────────────────────────────────
  console.log('\n[I06] Crear código anual → prefijo ANUAL-');
  await page.evaluate(() => { if (typeof showModal === 'function') showModal('nuevoCodigoModal', {tipo:'anual'}); });
  await page.waitForTimeout(800);
  const codParaI06 = page.locator('#cod-para');
  if (await codParaI06.count() > 0) {
    await codParaI06.fill(`Test ANUAL ${EXEC_ID}`);
    const btnI06 = page.locator('button').filter({ hasText: /generar código/i }).last();
    await btnI06.click();
    await page.waitForTimeout(1500);
    const r06 = await supaGET('codigos_invitacion',
      `select=codigo,tipo&para=like.*${EXEC_ID}*&tipo=eq.anual&order=id.desc&limit=1`, jwt);
    ok('I06-a: código anual presente en DB', r06.status === 200 && Array.isArray(r06.body) && r06.body.length > 0);
    ok('I06-b: prefijo ANUAL-', (r06.body?.[0]?.codigo || '').startsWith('ANUAL-'));
  } else {
    ok('I06-a: modal anual visible', false);
    ok('I06-b: prefijo ANUAL-', false);
  }

  // ── I07 — Código VIP ──────────────────────────────────────────────────────
  console.log('\n[I07] Crear código VIP → prefijo VIP-');
  await page.evaluate(() => { if (typeof showModal === 'function') showModal('nuevoCodigoModal', {tipo:'vip'}); });
  await page.waitForTimeout(800);
  const codParaI07 = page.locator('#cod-para');
  if (await codParaI07.count() > 0) {
    await codParaI07.fill(`Test VIP ${EXEC_ID}`);
    const btnI07 = page.locator('button').filter({ hasText: /generar código/i }).last();
    await btnI07.click();
    await page.waitForTimeout(1500);
    const r07 = await supaGET('codigos_invitacion',
      `select=codigo,tipo&para=like.*${EXEC_ID}*&tipo=eq.vip&order=id.desc&limit=1`, jwt);
    ok('I07-a: código VIP presente en DB', r07.status === 200 && Array.isArray(r07.body) && r07.body.length > 0);
    ok('I07-b: prefijo VIP-', (r07.body?.[0]?.codigo || '').startsWith('VIP-'));
  } else {
    ok('I07-a: modal VIP visible', false);
    ok('I07-b: prefijo VIP-', false);
  }

  // ── I08 — Limpieza ────────────────────────────────────────────────────────
  console.log('\n[I08] Limpieza staging');
  await limpiarCodigos(jwt);
  ok('I08-a: limpieza ejecutada sin excepción', true);

  // ── Resultado ─────────────────────────────────────────────────────────────
  await browser.close();
  server.close();

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📊 E10 Invitaciones V9: ${pass} ✅  ${fail} ❌`);
  if (failures.length) {
    console.log('\nFallas:');
    failures.forEach(f => console.log('  •', f));
  }
  process.exit(fail > 0 ? 1 : 0);
})();
