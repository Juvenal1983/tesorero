// Arranque exclusivo de demostración. Nunca inicia autenticación ni sincronización.
function guardarEstadoLocal() {
  DB._lastSaved = new Date().toISOString();
  try {
    previewStorage.setItem(KEY, JSON.stringify(DB));
    document.querySelectorAll('.pro-saved').forEach(element => {
      element.innerHTML = '<span class="pro-dot"></span> Guardado en este dispositivo';
    });
  } catch (error) {
    alert('No se pudo guardar. Exporta un respaldo antes de cerrar.');
    throw error;
  }
}
function reiniciarDemo() {
  if (!confirm('¿Restablecer los datos ficticios? Se borrarán los cambios de esta demostración.')) return;
  try { previewStorage.clear(); location.reload(); }
  catch { alert('El navegador no permite acceder al almacenamiento local.'); }
}
function validarDatosDemo(datos) {
  const tablas = ['usuarios', 'colegios', 'cursos', 'alumnos', 'apoderados', 'cuotas', 'pagos', 'movimientos'];
  if (!datos || tablas.some(tabla => !Array.isArray(datos[tabla]))) throw new Error('Estructura de datos inválida.');
  if (!datos.usuarios[0]?.id || !datos.cursos[0]?.id) throw new Error('Falta el usuario o el curso de demostración.');
  return datos;
}
function crearDatosDemo() { return JSON.parse(JSON.stringify(DEMO)); }
saveDB = guardarEstadoLocal;
setupPWA = () => {};
verificarSuscripcion = () => {};
verificarFechaEspecial = () => {};
// Las funciones heredadas de envío permanecen visibles, pero nunca envían mensajes.
enviarEmailNotif = avisoEnlaceDemo;
enviarWhatsapp = avisoEnlaceDemo;
KEY = 'tesorero_pro_demo_v1';
window.demoLista = (async function iniciarDemo() {
  try {
    const response = await fetch('data/demo.json');
    if (!response.ok) throw new Error('No se pudo cargar data/demo.json.');
    DEMO = validarDatosDemo(await response.json());
    const guardado = previewStorage.getItem(KEY);
    DB = guardado ? validarDatosDemo(JSON.parse(guardado)) : crearDatosDemo();
    previewStorage.setItem('notas_novedad_visto', '1');
    S.session = DB.usuarios[0];
    S.cursoId = DB.cursos[0].id;
    S.route = 'dashboard';
    saveDB();
    render();
    document.documentElement.dataset.ready = 'true';
    return true;
  } catch (error) {
    document.getElementById('app').innerHTML = `<main style="padding:32px;max-width:640px;margin:auto"><h1>No se pudo abrir la demostración</h1><p>${escHtml(error.message)}</p><p>Inicia la carpeta con <strong>python iniciar.py</strong>. Si hay datos locales dañados, puedes restablecer solo esta demostración.</p><button class="btn bp" onclick="reiniciarDemo()">Restablecer demostración</button></main>`;
    document.documentElement.dataset.ready = 'error';
    return false;
  }
})();
