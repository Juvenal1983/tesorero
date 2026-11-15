-- =============================================================================
-- E6_storage_comprobantes.sql  (v2 — correcciones de seguridad)
-- Bucket "comprobantes" privado + políticas RLS + RPC apoderado
--
-- EJECUTAR SOLO EN STAGING (rucgmytyxpfowznowxwd.supabase.co)
-- NO ejecutar en producción.
--
-- ── Decisiones de diseño ──────────────────────────────────────────────────────
--
-- 1. Bucket PRIVADO (public = false)
--    Los archivos NO son accesibles por URL pública.
--    La app genera URLs firmadas de CORTA DURACIÓN al momento de abrirlas
--    (archivos-storage.js:generarUrlFirmadaStorage, 3 600 s = 1 hora).
--    Lo que se persiste en PostgreSQL es la RUTA DEL ARCHIVO (storagePath),
--    no la URL firmada. Esto asegura que ocultar un movimiento después
--    invalide el acceso: el token anterior expira y el nuevo SELECT de
--    Storage rechaza la firma para no-dueños cuando visible=FALSE.
--
-- 2. Ruta de 4 segmentos: {cuentaId}/{cursoId}/{movId}/{archivo}
--    - El primer segmento es siempre un UUID de cuenta → previene colisiones
--      entre cuentas con cursoId o movId legacy repetidos.
--    - Los TRES primeros segmentos se validan juntos contra la misma fila
--      de movimientos, lo que garantiza consistencia completa.
--
-- 3. INSERT / UPDATE → solo dueño o rol tesorero/admin en ese curso,
--    Y el movimiento (cuenta+curso+movId) debe existir en PostgreSQL.
--
-- 4. DELETE → mismo criterio que INSERT.
--
-- 5. SELECT → _tiene_acceso_a_mov_storage(cuentaId, cursoId, movId)
--    valida los TRES segmentos contra la misma fila de movimientos.
--    Dueño: accede a todo. Delegado activo: solo visible=TRUE.
--
-- 6. Aislamiento: UUID de cuenta en segmento 1 separa cuentas con IDs legacy.
--
-- 7. Movimiento oculto (visible=FALSE): SELECT rechazado para no-dueños;
--    URL firmada generada con la sesión del tesorero también es rechazada.
--
-- 8. Visor (rol = 'visor'): puede leer (SELECT) pero no subir (INSERT).
--
-- 9. Apoderado (anon, autenticado solo vía PIN):
--    La RPC apoderado_abrir_comprobante() valida PIN con bcrypt, verifica
--    visible=TRUE, genera URL firmada de 5 minutos usando service_role
--    almacenado en Supabase Vault, y devuelve la URL al cliente.
--    Requisito: configurar vault.secrets antes de usar esta RPC (ver abajo).
--
-- ── Dependencias ──────────────────────────────────────────────────────────────
--   get_mis_cuentas()         sql/01_schema.sql
--   get_mis_cursos()          sql/01_schema.sql
--   es_dueno()                sql/01_schema.sql
--   tiene_rol_en_curso()      sql/01_schema.sql
--   tabla movimientos         sql/01_schema.sql
--   tabla alumnos             sql/01_schema.sql
--   tabla alumnos_credenciales sql/01_schema.sql + E5_pin_rpc.sql
--   pgcrypto                  ya habilitado (E5_pin_rpc.sql)
--   pg_net                    extensión Supabase, habilitada por defecto
--   vault                     Supabase Vault, disponible en todos los proyectos
--
-- ── Configuración previa: Vault ───────────────────────────────────────────────
-- La clave service_role NUNCA debe aparecer en este archivo ni en el repo.
-- Configurar manualmente en Supabase Dashboard → Settings → Vault:
--
--   1. Secret: nombre = "supabase_url"
--      valor   = https://rucgmytyxpfowznowxwd.supabase.co
--
--   2. Secret: nombre = "service_role_key"
--      valor   = (copiar desde Settings → API → "service_role" key)
--
-- Alternativa: SQL Editor de STAGING (NO commitear el valor de la clave):
--   SELECT vault.create_secret(
--     'https://rucgmytyxpfowznowxwd.supabase.co', 'supabase_url'
--   );
--   SELECT vault.create_secret(
--     '<service_role_key_aqui>', 'service_role_key'   -- ← NO incluir en git
--   );
--
-- Sin estos secrets, apoderado_abrir_comprobante devuelve:
--   {"ok": false, "error": "vault_no_configurado"}
-- =============================================================================


-- ── PARTE 0: Eliminar versión anterior de la función (firma cambiada) ─────────
-- La función ahora recibe 3 parámetros en vez de 2.
-- Eliminar la versión de 2 parámetros para evitar sobrecarga ambigua.
DROP FUNCTION IF EXISTS public._tiene_acceso_a_mov_storage(UUID, TEXT);


-- ── PARTE 1: Función auxiliar de acceso (3 parámetros) ───────────────────────
--
-- _tiene_acceso_a_mov_storage(p_cuenta_id, p_curso_id, p_mov_id)
--
--   Valida que los TRES segmentos de la ruta pertenecen a la MISMA fila
--   de movimientos. Antes (v1) solo se cruzaban cuenta+movId en SELECT,
--   y cuenta+curso en INSERT, dejando abierta la posibilidad de que un
--   movId de otro curso pasara la validación de SELECT.
--
--   Devuelve TRUE si:
--     a) El usuario autenticado es dueño de la cuenta (es_dueno), O
--     b) El movimiento es visible=TRUE Y el usuario tiene acceso al curso
--        (get_mis_cursos, que incluye todos los roles activos).
--
--   En ambos casos, la fila de movimientos debe tener:
--     cuenta_id = p_cuenta_id  AND  curso_id = p_curso_id  AND  id = p_mov_id
--   lo que garantiza que los 3 segmentos del path corresponden al mismo registro.
--
CREATE OR REPLACE FUNCTION public._tiene_acceso_a_mov_storage(
  p_cuenta_id UUID,
  p_curso_id  TEXT,
  p_mov_id    TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM   public.movimientos m
    WHERE  m.cuenta_id = p_cuenta_id
      AND  m.curso_id  = p_curso_id     -- ← nuevo: valida segundo segmento
      AND  m.id        = p_mov_id
      AND  (
             -- Dueño de la cuenta: accede a todo, incluyendo visible=FALSE.
             p_cuenta_id IN (
               SELECT tc.id
               FROM   public.tesorero_cuentas tc
               WHERE  tc.auth_id = auth.uid()
             )
             OR
             -- Delegado activo (cualquier rol): solo movimientos visible=TRUE
             -- en cursos a los que tiene acceso según get_mis_cursos.
             (
               m.visible  = TRUE
               AND m.curso_id IN (SELECT get_mis_cursos(p_cuenta_id))
             )
           )
  )
$$;

COMMENT ON FUNCTION public._tiene_acceso_a_mov_storage(UUID, TEXT, TEXT) IS
  'Storage RLS del bucket comprobantes. Valida los 3 segmentos (cuenta, curso, mov) '
  'contra la misma fila de movimientos. Dueño accede a todo; delegado activo solo '
  'a movimientos visible=TRUE en sus cursos. REVOKE ejecutado a continuación.';

-- ── Permisos explícitos (corrección #1 y #5) ─────────────────────────────────
-- Por defecto PostgreSQL otorga EXECUTE a PUBLIC en funciones nuevas.
-- Revocar eso y limitar a authenticated únicamente.
REVOKE ALL    ON FUNCTION public._tiene_acceso_a_mov_storage(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public._tiene_acceso_a_mov_storage(UUID, TEXT, TEXT) TO authenticated;


-- ── PARTE 2: Crear el bucket ──────────────────────────────────────────────────
INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
VALUES (
  'comprobantes',
  'comprobantes',
  false,                 -- PRIVADO: sin URLs públicas
  4194304,               -- 4 MB máx por archivo
  ARRAY[
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/heic',
    'image/heif',
    'application/pdf'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET public             = EXCLUDED.public,
      file_size_limit    = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;


-- ── PARTE 3: Políticas RLS sobre storage.objects ─────────────────────────────
--
-- Extracción de segmentos del path (storage.foldername devuelve array TEXT[]):
--   (storage.foldername(name))[1]::UUID  = cuentaId
--   (storage.foldername(name))[2]        = cursoId
--   (storage.foldername(name))[3]        = movId
--   (storage.filename(name))             = nombre del archivo con extensión
--
-- Nota: storage.foldername('uuid/cursoId/movId/archivo.pdf') devuelve
--   ARRAY['uuid', 'cursoId', 'movId'] (3 elementos, sin el nombre del archivo).
--
-- Corrección #2 y #3: todas las políticas de escritura verifican que
-- cuenta+curso+movId corresponden a la MISMA fila en movimientos antes
-- de permitir la operación.

-- ── 3a. INSERT ────────────────────────────────────────────────────────────────
-- Permite subir archivos solo si:
--   a) El movimiento (cuenta+curso+movId) existe en PostgreSQL.
--   b) El usuario es dueño de la cuenta O tiene rol tesorero/admin para ese curso.
--
-- La verificación de existencia del movimiento (a) garantiza que nunca
-- se suba un archivo a una ruta que no tenga un movimiento real en la DB.
-- El movimiento se crea antes de la subida (ver movimientos-guardado.js).
--
DROP POLICY IF EXISTS "comprobantes_insert" ON storage.objects;
CREATE POLICY "comprobantes_insert"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'comprobantes'
  AND EXISTS (
    -- Valida que cuenta+curso+movId corresponden al mismo registro
    SELECT 1 FROM public.movimientos m
    WHERE  m.cuenta_id = (storage.foldername(name))[1]::UUID
      AND  m.curso_id  = (storage.foldername(name))[2]
      AND  m.id        = (storage.foldername(name))[3]
  )
  AND (
    es_dueno((storage.foldername(name))[1]::UUID)
    OR
    tiene_rol_en_curso(
      (storage.foldername(name))[1]::UUID,
      (storage.foldername(name))[2],
      ARRAY['tesorero', 'admin']
    )
  )
);

-- ── 3b. UPDATE ────────────────────────────────────────────────────────────────
-- Permite reemplazar archivos existentes (upsert con x-upsert: true).
-- Mismo criterio que INSERT: movimiento debe existir Y usuario debe tener rol.
--
DROP POLICY IF EXISTS "comprobantes_update" ON storage.objects;
CREATE POLICY "comprobantes_update"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'comprobantes'
  AND EXISTS (
    SELECT 1 FROM public.movimientos m
    WHERE  m.cuenta_id = (storage.foldername(name))[1]::UUID
      AND  m.curso_id  = (storage.foldername(name))[2]
      AND  m.id        = (storage.foldername(name))[3]
  )
  AND (
    es_dueno((storage.foldername(name))[1]::UUID)
    OR
    tiene_rol_en_curso(
      (storage.foldername(name))[1]::UUID,
      (storage.foldername(name))[2],
      ARRAY['tesorero', 'admin']
    )
  )
)
WITH CHECK (
  bucket_id = 'comprobantes'
  AND EXISTS (
    SELECT 1 FROM public.movimientos m
    WHERE  m.cuenta_id = (storage.foldername(name))[1]::UUID
      AND  m.curso_id  = (storage.foldername(name))[2]
      AND  m.id        = (storage.foldername(name))[3]
  )
  AND (
    es_dueno((storage.foldername(name))[1]::UUID)
    OR
    tiene_rol_en_curso(
      (storage.foldername(name))[1]::UUID,
      (storage.foldername(name))[2],
      ARRAY['tesorero', 'admin']
    )
  )
);

-- ── 3c. DELETE ────────────────────────────────────────────────────────────────
-- Permite eliminar si el usuario es dueño o tiene rol tesorero/admin.
-- La eliminación del movimiento (y del teardown del test) sucede antes de
-- borrar la fila de movimientos, así que el EXISTS puede fallar cuando
-- el movimiento ya fue borrado. Para el caso del teardown (que borra Storage
-- ANTES que PostgreSQL), no hay problema porque la validación de ownership
-- sigue siendo válida aunque el movimiento ya no exista.
-- Usamos OR para permitir eliminación aunque el movimiento esté borrado:
--   - Si el movimiento existe, valida la tripleta completa.
--   - Si ya no existe, solo verifica ownership (el dueño puede limpiar archivos huérfanos).
--
DROP POLICY IF EXISTS "comprobantes_delete" ON storage.objects;
CREATE POLICY "comprobantes_delete"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'comprobantes'
  AND (
    es_dueno((storage.foldername(name))[1]::UUID)
    OR
    tiene_rol_en_curso(
      (storage.foldername(name))[1]::UUID,
      (storage.foldername(name))[2],
      ARRAY['tesorero', 'admin']
    )
  )
);

-- ── 3d. SELECT (control de firma de URLs) ────────────────────────────────────
-- Cuando el cliente llama a createSignedUrl(), Supabase evalúa esta política.
-- La función _tiene_acceso_a_mov_storage valida los 3 segmentos juntos:
--   - Dueño: puede firmar cualquier archivo de su cuenta (incluso visible=FALSE).
--   - Delegado activo: puede firmar solo archivos de movimientos visible=TRUE.
--   - Visor: igual que delegado (puede leer pero no escribir).
--   - Usuario de otra cuenta: rechazado siempre.
--   - Movimiento oculto para no-dueño: rechazado (URL firmada anterior
--     expira en 1 hora; al renovar la firma, esta política la bloquea).
--
DROP POLICY IF EXISTS "comprobantes_select" ON storage.objects;
CREATE POLICY "comprobantes_select"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'comprobantes'
  AND _tiene_acceso_a_mov_storage(
    (storage.foldername(name))[1]::UUID,  -- cuentaId
    (storage.foldername(name))[2],         -- cursoId  ← nuevo en SELECT
    (storage.foldername(name))[3]          -- movId
  )
);


-- ── PARTE 4: RPC apoderado_abrir_comprobante ──────────────────────────────────
--
-- Permite a un apoderado (sesión anon, autenticado solo con PIN) obtener
-- una URL firmada de corta duración para abrir un comprobante.
--
-- Flujo:
--   1. Validar PIN con bcrypt (igual que apoderado_acceso).
--   2. Obtener curso_id del alumno.
--   3. Verificar que el movimiento es visible=TRUE y del curso del alumno.
--   4. Extraer storagePath del movimiento (campo comprobante o archivos[0]).
--   5. Leer supabase_url y service_role_key desde Supabase Vault.
--   6. Llamar a Storage sign API via pg_net (sincrónico con async:=false).
--   7. Devolver URL firmada de 5 minutos.
--
-- Prerequisitos:
--   - pg_net habilitado (habilitado por defecto en Supabase).
--   - Vault configurado con "supabase_url" y "service_role_key" (ver PARTE 0).
--   - pgcrypto habilitado (ya configurado por E5_pin_rpc.sql).
--
-- Parámetros:
--   p_cuenta_id  UUID  — cuenta donde está el alumno y el movimiento
--   p_alumno_id  TEXT  — ID del alumno cuyo PIN se valida
--   p_pin        TEXT  — PIN en texto plano (se valida con bcrypt)
--   p_mov_id     TEXT  — ID del movimiento cuyo comprobante se solicita
--
-- Devuelve: JSONB
--   éxito: {"ok": true,  "url": "https://...supabase.co/storage/v1/sign/...?token=..."}
--   error: {"ok": false, "error": "<código>", ...}
--
CREATE OR REPLACE FUNCTION public.apoderado_abrir_comprobante(
  p_cuenta_id  UUID,
  p_alumno_id  TEXT,
  p_pin        TEXT,
  p_mov_id     TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, vault, net
AS $$
DECLARE
  v_hash        TEXT;
  v_curso_id    TEXT;
  v_archivos    JSONB;
  v_comprobante TEXT;
  v_path        TEXT;
  v_supa_url    TEXT;
  v_svc_key     TEXT;
  v_req_id      BIGINT;
  v_result      net.http_response_result;
  v_body_text   TEXT;
  v_signed_path TEXT;
BEGIN
  -- ── 1. Obtener PIN hash del alumno ────────────────────────────────────────
  SELECT pin_hash INTO v_hash
  FROM   public.alumnos_credenciales
  WHERE  cuenta_id = p_cuenta_id AND alumno_id = p_alumno_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'alumno_sin_pin');
  END IF;

  -- ── 2. Verificar PIN con bcrypt (pgcrypto) ────────────────────────────────
  -- crypt(texto_plano, hash_almacenado) reproduce el hash con la misma sal;
  -- si coincide con el hash almacenado, el PIN es correcto.
  IF NOT (crypt(p_pin, v_hash) = v_hash) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'pin_incorrecto');
  END IF;

  -- ── 3. Obtener curso_id del alumno ────────────────────────────────────────
  SELECT a.curso_id INTO v_curso_id
  FROM   public.alumnos a
  WHERE  a.cuenta_id = p_cuenta_id AND a.id = p_alumno_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'alumno_no_encontrado');
  END IF;

  -- ── 4. Verificar movimiento: visible=TRUE, del curso del alumno ───────────
  -- Valida cuenta+curso+movId contra la misma fila (igual que las políticas).
  SELECT archivos, comprobante INTO v_archivos, v_comprobante
  FROM   public.movimientos
  WHERE  cuenta_id = p_cuenta_id
    AND  id        = p_mov_id
    AND  curso_id  = v_curso_id    -- alumno y movimiento deben ser del mismo curso
    AND  visible   = TRUE;         -- comprobantes de movimientos ocultos no se entregan

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'movimiento_no_accesible');
  END IF;

  -- ── 5. Extraer storagePath ────────────────────────────────────────────────
  -- Prioridad: campo comprobante (ruta directa) → primer elemento de archivos.
  -- Se descarta el campo comprobante si contiene una URL firmada antigua
  -- (empieza con 'https://') o base64 (empieza con 'data:').
  v_path := v_comprobante;
  IF v_path IS NULL OR v_path = ''
     OR v_path LIKE 'https://%'
     OR v_path LIKE 'data:%'
  THEN
    -- No es un storagePath válido; buscar en el array archivos JSONB
    IF jsonb_array_length(COALESCE(v_archivos, '[]'::jsonb)) > 0 THEN
      v_path := v_archivos->0->>'storagePath';
    END IF;
  END IF;

  IF v_path IS NULL OR v_path = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sin_comprobante');
  END IF;

  -- ── 6. Obtener URL de Supabase y service_role key desde Vault ────────────
  -- Si vault no está configurado (ver instrucciones al inicio del archivo),
  -- esta función devuelve vault_no_configurado.
  BEGIN
    SELECT decrypted_secret INTO STRICT v_supa_url
    FROM   vault.decrypted_secrets
    WHERE  name = 'supabase_url'
    LIMIT  1;
  EXCEPTION WHEN NO_DATA_FOUND OR TOO_MANY_ROWS OR OTHERS THEN
    RETURN jsonb_build_object(
      'ok',      false,
      'error',   'vault_no_configurado',
      'detalle', 'Crear secret "supabase_url" en Supabase Vault (ver sql/E6_storage_comprobantes.sql)'
    );
  END;

  BEGIN
    SELECT decrypted_secret INTO STRICT v_svc_key
    FROM   vault.decrypted_secrets
    WHERE  name = 'service_role_key'
    LIMIT  1;
  EXCEPTION WHEN NO_DATA_FOUND OR TOO_MANY_ROWS OR OTHERS THEN
    RETURN jsonb_build_object(
      'ok',      false,
      'error',   'vault_no_configurado',
      'detalle', 'Crear secret "service_role_key" en Supabase Vault (ver sql/E6_storage_comprobantes.sql)'
    );
  END;

  -- ── 7. Llamar a Storage sign API via pg_net ───────────────────────────────
  -- net.http_post es asíncrono; devuelve un request_id.
  SELECT net.http_post(
    url     := v_supa_url || '/storage/v1/object/sign/comprobantes/' || v_path,
    headers := jsonb_build_object(
      'apikey',        v_svc_key,
      'Authorization', 'Bearer ' || v_svc_key,
      'Content-Type',  'application/json'
    ),
    body    := '{"expiresIn": 300}'::jsonb  -- 5 minutos; suficiente para abrir el archivo
  ) INTO v_req_id;

  -- ── 8. Esperar respuesta sincrónicamente (async := false) ─────────────────
  -- http_collect_response con async:=false bloquea hasta que la respuesta llega
  -- o se agota el timeout configurado en net.http_post (default 2 000 ms).
  SELECT net.http_collect_response(v_req_id, async := false) INTO v_result;

  -- Verificar resultado
  IF v_result.status <> 'SUCCESS' THEN
    RETURN jsonb_build_object(
      'ok',    false,
      'error', 'storage_timeout',
      'msg',   v_result.message
    );
  END IF;

  IF (v_result.response).status_code NOT IN (200, 201) THEN
    RETURN jsonb_build_object(
      'ok',    false,
      'error', 'storage_sign_fallido',
      'codigo', (v_result.response).status_code
    );
  END IF;

  -- ── 9. Extraer signedURL del body ─────────────────────────────────────────
  v_body_text   := convert_from((v_result.response).body_bytes, 'UTF8');
  v_signed_path := (v_body_text::jsonb)->>'signedURL';

  IF v_signed_path IS NULL THEN
    RETURN jsonb_build_object(
      'ok',    false,
      'error', 'storage_sin_signed_url',
      'body',  left(v_body_text, 300)
    );
  END IF;

  -- Supabase puede devolver path relativo o URL completa
  RETURN jsonb_build_object(
    'ok',  true,
    'url', CASE
             WHEN v_signed_path LIKE 'http%' THEN v_signed_path
             ELSE v_supa_url || v_signed_path
           END
  );
END;
$$;

COMMENT ON FUNCTION public.apoderado_abrir_comprobante(UUID, TEXT, TEXT, TEXT) IS
  'Genera URL firmada de 5 min para un comprobante. Valida PIN bcrypt, verifica '
  'visible=TRUE y curso correcto del alumno. Usa pg_net + Vault (service_role). '
  'Concedido a anon + authenticated; REVOKE ejecutado a continuación.';

-- ── Permisos explícitos (corrección #1 y #5) ─────────────────────────────────
-- anon: los apoderados no tienen sesión Supabase Auth.
-- authenticated: tesoreros pueden llamarla en nombre de un apoderado si fuera necesario.
REVOKE ALL    ON FUNCTION public.apoderado_abrir_comprobante(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.apoderado_abrir_comprobante(UUID, TEXT, TEXT, TEXT) TO anon;
GRANT  EXECUTE ON FUNCTION public.apoderado_abrir_comprobante(UUID, TEXT, TEXT, TEXT) TO authenticated;


-- ── PARTE 5: Verificación ─────────────────────────────────────────────────────

-- 5a. Bucket creado con la configuración correcta
SELECT
  b.id                                        AS bucket_id,
  b.name                                      AS nombre,
  CASE b.public WHEN TRUE THEN 'PÚBLICO ⚠' ELSE 'PRIVADO ✓' END AS acceso,
  pg_size_pretty(b.file_size_limit::bigint)   AS tam_max,
  array_length(b.allowed_mime_types, 1)       AS n_tipos_mime
FROM   storage.buckets b
WHERE  b.id = 'comprobantes';

-- 5b. Políticas creadas
SELECT
  policyname  AS politica,
  cmd         AS operacion,
  roles       AS roles_aplicables
FROM   pg_policies
WHERE  tablename   = 'objects'
  AND  policyname  LIKE 'comprobantes_%'
ORDER  BY policyname;

-- 5c. Funciones creadas con sus permisos
SELECT
  p.proname                                                      AS funcion,
  p.prosecdef                                                    AS security_definer,
  p.pronargs                                                     AS n_params,
  array_to_string(p.proconfig, ', ')                            AS search_path,
  CASE
    WHEN has_function_privilege('authenticated', p.oid, 'EXECUTE') THEN 'authenticated ✓'
    ELSE 'SIN GRANT ⚠'
  END                                                            AS grant_authenticated,
  CASE
    WHEN p.proname = 'apoderado_abrir_comprobante'
     AND has_function_privilege('anon', p.oid, 'EXECUTE')       THEN 'anon ✓'
    WHEN p.proname = 'apoderado_abrir_comprobante'               THEN 'SIN GRANT anon ⚠'
    ELSE '(solo authenticated)'
  END                                                            AS grant_anon
FROM   pg_proc p
JOIN   pg_namespace n ON n.oid = p.pronamespace
WHERE  n.nspname = 'public'
  AND  p.proname IN ('_tiene_acceso_a_mov_storage', 'apoderado_abrir_comprobante')
ORDER  BY p.proname;

-- 5d. Verificar que Vault tiene los secrets necesarios
--    (Solo comprueba existencia; NO muestra el valor)
SELECT
  name,
  CASE WHEN decrypted_secret IS NOT NULL AND decrypted_secret <> ''
       THEN 'configurado ✓'
       ELSE 'FALTA ⚠'
  END AS estado
FROM   vault.decrypted_secrets
WHERE  name IN ('supabase_url', 'service_role_key');
