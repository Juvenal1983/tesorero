// js/features/archivos-storage.js
//
// ── Notas de acceso (bucket privado) ─────────────────────────────────────────
// El bucket "comprobantes" es PRIVADO. Los archivos NO tienen URL pública.
//
// Lo que se persiste en PostgreSQL es la RUTA DEL ARCHIVO (storagePath), NO
// una URL firmada. Las URLs firmadas se generan de CORTA DURACIÓN al momento
// de abrir el comprobante, verificando autorización en ese instante.
//
// Esto garantiza que si un movimiento se oculta (visible=FALSE), las URLs
// anteriores expiran y no se pueden renovar para no-propietarios.
//
// Ruta de 4 segmentos: {cuentaId}/{cursoId}/{movId}/{uid}.{ext}
//   - cuentaId (UUID)  → primer segmento, aísla cuentas con IDs legacy iguales
//   - cursoId  (TEXT)  → segundo segmento, validado en Storage RLS
//   - movId    (TEXT)  → tercer segmento, validado con cuenta+curso en la misma fila
//   - {uid}.{ext}      → nombre único del archivo
//
// Formato devuelto por subirArchivoStorage():
//   { storagePath, nombre, tipo }
//     storagePath → ruta dentro del bucket (lo que se persiste en PostgreSQL)
//     nombre      → nombre original del archivo
//     tipo        → MIME type
//   (NO incluye 'url' — la URL firmada se genera on-demand en verComprobante)
//
// El campo "comprobante" de movimientos almacena el storagePath.
// El campo "archivos" (JSONB) almacena objetos { storagePath, nombre, tipo }.
//
// Para compatibilidad con datos legados:
//   - Si comprobante empieza con 'https://': es una URL firmada antigua (posiblemente expirada).
//   - Si comprobante empieza con 'data:': es base64 antiguo.
//   - En cualquier otro caso: es un storagePath (nuevo formato).
// =============================================================================

// ── Generar URL firmada ───────────────────────────────────────────────────────
// Llama al endpoint /storage/v1/object/sign/comprobantes/{storagePath}.
// expiresIn: tiempo en segundos. Por defecto 3 600 s = 1 hora.
// Se llama al momento de ABRIR el archivo, no al subirlo.
// Devuelve la URL firmada completa o null si falla.
async function generarUrlFirmadaStorage(storagePath, expiresIn) {
  expiresIn = expiresIn || 3600; // 1 hora por defecto (no 1 año)
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
// Devuelve { storagePath, nombre, tipo } o null si falla.
// NO devuelve 'url' — la URL firmada se genera on-demand al abrir el archivo.
// storagePath es lo que se persiste en PostgreSQL.
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

    if(typeof showToast==='function') showToast('✅ Comprobante subido correctamente');
    // Devolver solo storagePath (sin url — se genera on-demand al abrir)
    return { storagePath, nombre: archivo.nombre || 'comprobante', tipo };
  }catch(e){
    console.warn('[Storage] Error subiendo a Storage:', e);
    if(typeof showToast==='function') showToast('⚠️ Error al subir: '+e.message);
    return null;
  }
}

// ── Migrar comprobantes base64 a Supabase Storage ─────────────────────────────
// Se ejecuta silenciosamente al cargar la app en modo V9 cuando hay archivos
// con 'data' (base64) sin 'storagePath'.
async function migrarComprobantesAStorage(){
  if(!S.session || !S.cursoId) return;
  const movs = DB.movimientos || [];
  let migrados = 0;
  for(const m of movs){
    if(!m.archivos || !m.archivos.length) continue;
    let cambio = false;
    const nuevosArchivos = [];
    for(const arch of m.archivos){
      // Mantener archivos que ya tienen storagePath o url (ya migrados)
      if(arch.storagePath || arch.url){ nuevosArchivos.push(arch); continue; }
      if(arch.data){
        // subirArchivoStorage ahora devuelve { storagePath, nombre, tipo } o null
        const resultado = await subirArchivoStorage(arch, m.id);
        if(resultado){
          nuevosArchivos.push(resultado); // { storagePath, nombre, tipo }
          cambio = true;
          migrados++;
        } else {
          nuevosArchivos.push(arch); // mantener original si falla
        }
      }
    }
    if(cambio){
      m.archivos = nuevosArchivos;
      // Limpiar flag pendiente solo si TODOS los archivos tienen storagePath o url
      if(nuevosArchivos.every(a => a.storagePath || a.url)) delete m._pendienteStorage;

      // En V9_RELACIONAL: persistir en PostgreSQL vía RPC
      // En modo legado: saveDB() (localStorage)
      if(typeof V9_RELACIONAL !== 'undefined' && V9_RELACIONAL) {
        const cuentaId = S._v9CuentaId;
        if(cuentaId){
          // Actualizar storagePath principal en campo comprobante
          const primerPath = (nuevosArchivos.find(a => a.storagePath) || {}).storagePath || null;
          const patchData = { archivos: nuevosArchivos };
          if(primerPath) patchData.comprobante = primerPath;
          try {
            await actualizarMovimientoV9(cuentaId, m.id, patchData, _authToken);
          } catch(e) {
            console.warn('[Storage] Error persistiendo migración en v9:', e);
          }
        }
      } else {
        saveDB(); // modo legado: sincronizar localStorage
      }
    }
  }
  if(migrados > 0){
    console.log('Migrados '+migrados+' comprobantes a Storage');
    if(typeof showToast==='function') {
      showToast('✅ '+migrados+' comprobante'+( migrados!==1?'s':'')+' sincronizado'+( migrados!==1?'s':'')+' con la nube');
    }
  }
}

// ── Subir múltiples archivos ───────────────────────────────────────────────────
// Itera sobre los archivos adjuntos. Si un archivo ya tiene storagePath o url,
// se mantiene sin re-subir. Si tiene 'data' (base64), se sube.
async function subirArchivosStorage(archivos, movId){
  const resultados = [];
  for(const arch of archivos){
    if(arch.storagePath || arch.url){
      // Ya fue subido (tiene storagePath en nuevo formato, o url en formato antiguo).
      // Conservar tal cual para no re-subir ni perder el archivo.
      resultados.push(arch);
      continue;
    }
    if(!arch.data) continue;
    // subirArchivoStorage devuelve { storagePath, nombre, tipo } o null.
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
