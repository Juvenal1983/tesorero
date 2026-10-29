// js/core/menu.js — extraído de la copia de demostración.
function toggleMasMenu(){
  const menu=document.getElementById('mas-menu');
  const overlay=document.getElementById('mas-overlay');
  if(!menu) return;
  const open=menu.style.display==='none'||menu.style.display==='';
  menu.style.display=open?'block':'none';
  if(overlay) overlay.style.display=open?'block':'none';
}
function closeMasMenu(){
  const menu=document.getElementById('mas-menu');
  const overlay=document.getElementById('mas-overlay');
  if(menu) menu.style.display='none';
  if(overlay) overlay.style.display='none';
}
function bindNav(){ /* done inline via onclick */ }
function bindSelector(){ /* done inline */ }

// ─────────────────────────────────────────────
// PWA SETUP
// ─────────────────────────────────────────────
