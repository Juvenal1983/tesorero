// El único recurso accesible mediante fetch es el JSON ficticio de este paquete.
const PREVIEW_PREFIX = 'tesorero-modular-demo:v1:';
const previewStorage = new Proxy({}, {
  get(_target, key) {
    const methods = {
      getItem: name => window.localStorage.getItem(PREVIEW_PREFIX + name),
      setItem: (name, value) => window.localStorage.setItem(PREVIEW_PREFIX + name, value),
      removeItem: name => window.localStorage.removeItem(PREVIEW_PREFIX + name),
      clear: () => Object.keys(window.localStorage)
        .filter(name => name.startsWith(PREVIEW_PREFIX))
        .forEach(name => window.localStorage.removeItem(name))
    };
    return methods[key];
  },
  ownKeys: () => Object.keys(window.localStorage)
    .filter(name => name.startsWith(PREVIEW_PREFIX))
    .map(name => name.slice(PREVIEW_PREFIX.length)),
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true })
});
const cargarRecursoLocal = window.fetch.bind(window);
const DEMO_URL = new URL('data/demo.json', document.baseURI).href;
window.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, document.baseURI);
  const method = String(options.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (url.href !== DEMO_URL || method !== 'GET') {
    throw new Error('Demostración local: conexión externa desactivada.');
  }
  return cargarRecursoLocal(url.href, { method: 'GET', cache: 'no-store', redirect: 'error', credentials: 'omit' });
};
function avisoEnlaceDemo() {
  alert('Esta demostración no envía mensajes ni abre servicios externos.');
}
window.open = () => { avisoEnlaceDemo(); return null; };
document.addEventListener('click', event => {
  const link = event.target.closest('a[href]');
  if (link && /^(https?:|mailto:|tel:|sms:)/i.test(link.getAttribute('href'))) {
    event.preventDefault();
    avisoEnlaceDemo();
  }
}, true);
