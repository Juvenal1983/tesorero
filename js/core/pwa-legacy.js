// js/core/pwa-legacy.js — extraído de la copia de demostración.
let _deferredPrompt=null;
function setupPWA(){
  const manifest={name:'Tesorero',short_name:'Tesorero',description:'Administración financiera de cursos escolares',start_url:'.',display:'standalone',background_color:'#F5F9F7',theme_color:'#0F6E56',orientation:'portrait-primary',icons:[{src:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="38" fill="%230F6E56"/><text y="140" x="96" text-anchor="middle" font-size="120" font-family="serif">💰</text></svg>',sizes:'192x192',type:'image/svg+xml'},{src:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="100" fill="%230F6E56"/><text y="370" x="256" text-anchor="middle" font-size="320" font-family="serif">💰</text></svg>',sizes:'512x512',type:'image/svg+xml',purpose:'any maskable'}]};
  const blob=new Blob([JSON.stringify(manifest)],{type:'application/json'});
  document.getElementById('pwa-manifest').href=URL.createObjectURL(blob);

  const SW_CODE=`
const CACHE='tesorero-20260905-1317';
const ASSETS=['${location.href}'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim();});
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(resp=>{const clone=resp.clone();caches.open(CACHE).then(c=>c.put(e.request,clone));return resp;}).catch(()=>caches.match('${location.href}'))))});`;
  try{
    const swBlob=new Blob([SW_CODE],{type:'application/javascript'});
    const swURL=URL.createObjectURL(swBlob);
    navigator.serviceWorker?.register(swURL).then(()=>console.log('SW registrado')).catch(()=>{});
  }catch(e){}

  window.addEventListener('beforeinstallprompt',e=>{
    e.preventDefault(); _deferredPrompt=e;
    const badge=document.getElementById('install-badge');
    if(badge) badge.style.display='';
  });
}
function doInstall(){
  if(!_deferredPrompt) return;
  _deferredPrompt.prompt();
  _deferredPrompt.userChoice.then(()=>{_deferredPrompt=null;});
}

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────
