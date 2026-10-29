// Requiere Node.js y Playwright (npm install --no-save playwright).
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
(async () => {
  const server = spawn('python', [path.join(root, 'iniciar.py'), '--no-browser'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let browser;
  try {
    const base = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('No arrancó el servidor local.')), 10000);
      server.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
      server.on('error', reject);
    });
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [], external = [], failed = [], dialogs = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(base)) external.push(request.url()); });
    page.on('response', response => { if (response.status() >= 400) failed.push(response.url() + ' ' + response.status()); });
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
    await page.goto(base);
    await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
    await page.evaluate(() => window.demoLista);
    assert.equal(await page.evaluate(() => calcFinanzas().saldo), 57000);
    assert.equal(await page.evaluate(() => DB.alumnos.length), 8);
    assert.equal(await page.evaluate(() => getMovs(true).length), 2);
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => Object.keys(_charts).length > 0), true);
    const sizes = [{width:390,height:844},{width:1440,height:1000}];
    for (const size of sizes) {
      await page.setViewportSize(size);
      for (const route of ['dashboard','alumnos','cuotas','pagos','fondo-especial','movimientos','cobranza','reportes','config','notas']) {
        await page.evaluate(route => go(route), route);
        await page.waitForTimeout(100);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Desbordamiento en ' + route + ' / ' + size.width);
      }
    }
    await page.evaluate(() => {
      go('alumnos'); showModal('addAlumno');
      document.getElementById('m-nombres').value='Alumno';
      document.getElementById('m-apellidos').value='Prueba modular';
      saveAlumno();
    });
    assert.equal(await page.evaluate(() => DB.alumnos.length), 9);
    await page.evaluate(() => {
      go('notas');document.getElementById('nota-texto').value='Prueba modular persistente';guardarNota();
      window.localStorage.setItem('dato-ajeno-demo','conservar');
    });
    const payments = await page.evaluate(() => {
      showModal('addPago',{aluId:'demo-a7',cuotaId:'q1',periodo:'Marzo'});
      const before=DB.pagos.length;
      document.getElementById('p-monto').value='-1';savePago('demo-a7','q1','multi');
      const rejected=DB.pagos.length===before;
      document.getElementById('p-monto').value='5000';savePago('demo-a7','q1','multi');
      const saldo=calcFinanzas().saldo;
      showModal('addPago',{aluId:'demo-a7',cuotaId:'q1',periodo:'Marzo'});
      savePago('demo-a7','q1','multi');closeModal();
      return {rejected,added:DB.pagos.length===before+1,saldo};
    });
    assert.deepEqual(payments,{rejected:true,added:true,saldo:62000});
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
    assert.equal(await page.evaluate(() => DB.alumnos.length),9);
    assert.equal(await page.evaluate(() => DB.notas.some(n=>n.texto==='Prueba modular persistente')),true);
    assert.equal(await page.evaluate(() => calcFinanzas().saldo),62000);
    const blocked = await page.evaluate(async () => {
      try { await fetch('https://sin-conexion.invalid/test',{method:'POST'});return false; }catch{return true;}
    });
    assert.equal(blocked,true);
    await page.evaluate(() => previewStorage.clear());
    assert.equal(await page.evaluate(() => window.localStorage.getItem('dato-ajeno-demo')),'conservar');
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
    assert.equal(await page.evaluate(() => DB.alumnos.length),8);
    assert.equal(await page.evaluate(() => calcFinanzas().saldo),57000);
    fs.mkdirSync(path.join(root,'capturas'),{recursive:true});
    for (const size of sizes) {
      await page.setViewportSize(size);await page.waitForTimeout(150);
      await page.screenshot({path:path.join(root,'capturas',size.width===390?'movil.png':'escritorio.png'),fullPage:true});
    }
    // Damaged local data must show a recovery screen without overwriting it.
    await page.evaluate(() => previewStorage.setItem(KEY,'{invalido'));
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.ready === 'error');
    assert.equal(await page.evaluate(() => previewStorage.getItem(KEY)),'{invalido');
    await page.evaluate(() => previewStorage.clear());
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(failed,[]);
    const result={resultado:'OK',seccionesPorPantalla:10,pantallas:sizes,persistencia:true,pagoPositivo:true,pagoNegativoRechazado:true,duplicadoRechazado:true,saldoVerificado:true,aislamientoLocal:true,datosDanadosRecuperables:true,erroresJavaScript:errors,solicitudesExternas:external,recursosFallidos:failed};
    fs.writeFileSync(path.join(root,'tests','resultado.json'),JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify(result,null,2));
  } finally { if(browser)await browser.close();server.kill(); }
})().catch(error=>{console.error(error);process.exitCode=1});
