// js/features/archivos-storage.js — extraído de la copia de demostración.
//
// ── Notas de acceso (bucket privado) ─────────────────────────────────────────
// El bucket "comprobantes" es PRIVADO. Los archivos no tienen URL pública.
// El acceso se realiza mediante URLs firmadas (signed URLs) con un token en
// el query string. La función generarUrlFirmadaStorage() las genera usando
// el JWT del tesorero autenticado; no requiere cabecera Authorization al
// abrirlas (el token va en ?token=…).
//
// Ruta de 4 segmentos: {cuentaId}/{cursoId}/{movId}/{uid}.{ext}
//   - cuentaId (UUID)  → primer segmento, aísla cuentas con IDs legacy iguales
//   - cursoId  (TEXT)  → segundo segmento, validado en Storage RLS
//   - movId    (TEXT)  → tercer segmento, validado en _tiene_acceso_a_mov_storage
//   - {uid}.{ext}      → nombre único del archivo
//
// Formato devuelto por subirArchivoStorage():
//   { storagePath, url, nombre, tipo }
//     storagePath → ruta dentro del bucket (sin esquema ni host)
//     url         → URL firmada lista para window.open() y para almacenar en PG
//     nombre      → nombre original del archivo
//     tipo        → MIME type
//
// El campo "comprobante" de movimientos almacena la URL firmada.
// El campo "archivos" (JSONB) almacena objetos { storagePath, url, nombre, tipo }.
// Cuando la URL firmada expire, la app puede regenerarla llamando a
// generarUrlFirmadaStorage(storagePath) con la sesión activa del tesorero.
// =============================================================================

// ── Generar URL firmada ───────────────────────────────────────────────────────
// Llama al endpoint /storage/v1/object/sign/comprobantes/{storagePath}.
// expiresIn: tiempo en segundos (por defecto 365 días = 31 536 000 s).
// Devuelve la URL firmada completa o null si falla.
async function generarUrlFirmadaStorage(storagePath, expiresIn) {
  expiresIn = expiresIn || 31536000; // 1 año por defecto
  const token = _authToken || SUPA_KEY;
  try {
    const res = await fetch(
      SUPA_URL + '/storage/v1/object/sign/comprobantes/' + storagePath,
      {
        method: 'POST',
        headers: {
          'apikey': SUPA_KEY,
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expiresIn }),
      }
    );
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.warn('[Storage] generarUrlFirmadaStorage falló:', res.status, err);
      return null;
    }
    const data = await res.json();
    // Supabase devuelve { signedURL: '/storage/v1/object/sign/…?token=…' }
    // El campo puede llamarse signedURL o signedUrl según la versión.
    const relativePath = data.signedURL || data.signedUrl || null;
    if (!relativePath) {
      console.warn('[Storage] Respuesta sin signedURL:', data);
      return null;
    }
    // Si ya es una URL completa (empieza con http) devolverla tal cual.
    // Si es un path relativo, prepender SUPA_URL.
    return relativePath.startsWith('http') ? relativePath : SUPA_URL + relativePath;
  } catch (e) {
    console.warn('[Storage] Error al generar URL firmada:', e);
    return null;
  }
}

// ── Subir un archivo a Storage ────────────────────────────────────────────────
// Devuelve { storagePath, url, nombre, tipo } o null si falla.
// storagePath → ruta dentro del bucket (para regenerar URLs firmadas).
// url         → URL firmada lista para almacenar en PG y abrir con window.open.
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

    // ── Ruta 4 segmentos: {cuentaId}/{cursoId}/{movId}/{uid}.{ext} ────────────
    // cuentaId en primer segmento previene colisiones entre cuentas con IDs
    // legacy repetidos (ej. dos cuentas con curso "5to-A").
    const cuentaId = (S && S._v9CuentaId) ? S._v9CuentaId : 'sin-cuenta';
    const cursoId  = (S && S.cursoId)     ? S.cursoId     : 'sin-curso';
    const storagePath = cuentaId + '/' + cursoId + '/' + movId + '/' + uid() + '.' + ext;
    const token = _authToken || SUPA_KEY;

    const res = await fetch(SUPA_URL+'/storage/v1/object/comprobantes/'+storagePath, {
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
      console.warn('[Storage] upload falló:', res.status, err);
      if(typeof showToast==='function') showToast('⚠️ Error al subir imagen ('+res.status+'): '+err.slice(0,60));
      return null;
    }

    // ── Generar URL firmada (bucket privado) ──────────────────────────────────
    // No usar URL pública — el bucket es privado. La URL firmada incluye un
    // token en el query string que autoriza el acceso sin cabecera Authorization.
    const signedUrl = await generarUrlFirmadaStorage(storagePath);
    if (!signedUrl) {
      console.warn('[Storage] Archivo subido pero no se pudo generar URL firmada para:', storagePath);
      if(typeof showToast==='function') showToast('⚠️ Comprobante subido sin URL de acceso — intenta recargar');
      return null;
    }

    if(typeof showToast==='function') showToast('✅ Comprobante subido correctamente');
    return { storagePath, url: signedUrl, nombre: archivo.nombre || 'comprobante', tipo };
  }catch(e){
    console.warn('[Storage] Error subiendo a Storage:', e);
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
      // Ya tiene URL (pudo subirse antes) — mantener tal cual.
      // Si tiene storagePath podría regenerarse; por ahora se conserva.
      resultados.push(arch);
      continue;
    }
    if(!arch.data) continue;
    // subirArchivoStorage devuelve { storagePath, url, nombre, tipo } o null.
    const resultado = await subirArchivoStorage(arch, movId);
    if(resultado){
      resultados.push(resultado);
    } else {
      // Si falla el upload, mantener el objeto original (puede ser base64)
      // para no perder el archivo. El flag _pendienteStorage se conserva.
      resultados.push(arch);
    }
  }
  return resultados;
}

