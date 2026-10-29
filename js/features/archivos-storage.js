// js/features/archivos-storage.js — extraído de la copia de demostración.
async function subirArchivoStorage(archivo, movId){
  try{
    if(!archivo.data) return null;

    // Determinar tipo MIME y extensión correcta
    const mimeToExt = {
      'image/jpeg':'jpg','image/jpg':'jpg','image/png':'png',
      'image/gif':'gif','image/webp':'webp','image/heic':'jpg',
      'image/heif':'jpg','application/pdf':'pdf'
    };
    // Detectar tipo desde el data URL si no viene en archivo.tipo
    let tipo = archivo.tipo || 'image/jpeg';
    if(archivo.data.startsWith('data:')){
      const match = archivo.data.match(/^data:([^;]+);/);
      if(match) tipo = match[1];
    }
    // HEIC convertir a jpeg para compatibilidad
    if(tipo==='image/heic'||tipo==='image/heif') tipo='image/jpeg';
    const ext = mimeToExt[tipo] || 'jpg';

    // Convertir base64 a Blob
    const base64 = archivo.data.includes(',') ? archivo.data.split(',')[1] : archivo.data;
    const byteStr = atob(base64);
    const ab = new ArrayBuffer(byteStr.length);
    const ia = new Uint8Array(ab);
    for(let i=0;i<byteStr.length;i++) ia[i]=byteStr.charCodeAt(i);
    const blob = new Blob([ab], {type: tipo});

    const cursoId = S.cursoId || 'sin-curso';
    const path = cursoId+'/'+movId+'/'+uid()+'.'+ext;
    const token = _authToken || SUPA_KEY;

    const res = await fetch(SUPA_URL+'/storage/v1/object/comprobantes/'+path, {
      method: 'POST',
      headers: {
        'apikey': SUPA_KEY,
        'Authorization': 'Bearer '+token,
        'Content-Type': tipo,
        'x-upsert': 'true'
      },
      body: blob
    });

    if(!res.ok){
      const err = await res.text().catch(()=>'');
      console.warn('Storage upload failed:', res.status, err);
      if(typeof showToast==='function') showToast('⚠️ Error al subir imagen ('+res.status+'): '+err.slice(0,60));
      return null;
    }

    // URL pública del archivo
    const publicUrl = SUPA_URL+'/storage/v1/object/public/comprobantes/'+path;
    if(typeof showToast==='function') showToast('✅ Imagen subida OK');
    return publicUrl;
  }catch(e){
    console.warn('Error subiendo a Storage:', e);
    if(typeof showToast==='function') showToast('⚠️ Error al subir: '+e.message);
    return null;
  }
}

// Migración automática de comprobantes base64 a Supabase Storage
// Se ejecuta silenciosamente al cargar la app
async function migrarComprobantesAStorage(){
  if(!S.session || !S.cursoId) return;
  const movs = DB.movimientos || [];
  let migrados = 0;
  for(const m of movs){
    if(!m.archivos || !m.archivos.length) continue;
    let cambio = false;
    const nuevosArchivos = [];
    for(const arch of m.archivos){
      if(arch.url){ nuevosArchivos.push(arch); continue; }
      if(arch.data){
        const url = await subirArchivoStorage(arch, m.id);
        if(url){
          nuevosArchivos.push({url, nombre:arch.nombre||'comprobante', tipo:arch.tipo||'image/jpeg'});
          cambio = true;
          migrados++;
        } else {
          nuevosArchivos.push(arch);
        }
      }
    }
    if(cambio){
      m.archivos = nuevosArchivos;
      // Solo quitar el flag de pendiente si TODOS los archivos quedaron con url
      if(nuevosArchivos.every(a=>a.url)) delete m._pendienteStorage;
    }
  }
  if(migrados > 0){
    console.log('Migrados '+migrados+' comprobantes a Storage');
    saveDB(); // marca timestamp local optimista + sube a la nube de forma robusta
    showToast('✅ '+migrados+' comprobante'+( migrados!==1?'s':'')+' sincronizado'+( migrados!==1?'s':'')+' con la nube');
  }
}

async function subirArchivosStorage(archivos, movId){
  const resultados = [];
  for(const arch of archivos){
    if(arch.url){
      // Ya está en Storage — mantener
      resultados.push(arch);
      continue;
    }
    if(!arch.data) continue;
    const url = await subirArchivoStorage(arch, movId);
    if(url){
      resultados.push({url, nombre:arch.nombre, tipo:arch.tipo});
    } else {
      // Si falla el upload, guardar base64 como fallback
      resultados.push(arch);
    }
  }
  return resultados;
}

