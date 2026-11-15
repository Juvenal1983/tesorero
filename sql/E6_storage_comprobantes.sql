-- =============================================================================
-- E6_storage_comprobantes.sql
-- Bucket "comprobantes" privado + políticas RLS para Supabase Storage
--
-- EJECUTAR SOLO EN STAGING (rucgmytyxpfowznowxwd.supabase.co)
-- NO ejecutar en producción.
--
-- ── Decisiones de diseño ──────────────────────────────────────────────────────
--
-- 1. Bucket PRIVADO (public = false)
--    Los archivos NO son accesibles por URL pública.
--    El app genera URLs firmadas (/storage/v1/object/sign/…?token=…) que
--    llevan el token de acceso en el query string. window.open(signedUrl)
--    sigue funcionando sin cambios en la lógica de visualización.
--
-- 2. Ruta de 4 segmentos: {cuentaId}/{cursoId}/{movId}/{archivo}
--    - El primer segmento es siempre un UUID de cuenta → previene colisiones
--      entre cuentas que tengan cursoId o movId legacy con el mismo texto.
--    - Los tres primeros segmentos permiten validar acceso desde Storage RLS
--      sin necesidad de llamar a otras tablas para "adivinar" a qué cuenta
--      pertenece el archivo.
--
-- 3. INSERT / UPDATE → solo dueño o rol tesorero/admin en ese curso
--    Réplica exacta del criterio de movimientos DML (02_rls.sql: mov_insert).
--
-- 4. DELETE → mismo criterio que INSERT
--
-- 5. SELECT → función _tiene_acceso_a_mov_storage() que replica mov_select:
--    - Dueño de la cuenta ve todo.
--    - Delegado activo (visor/editor/tesorero/admin) ve solo visible=TRUE
--      y solo en cursos de su acceso.
--    - Ningún usuario de otra cuenta puede ver el archivo (get_mis_cuentas).
--
-- 6. Aislamiento entre cuentas con IDs legacy repetidos
--    La cuentaId (UUID) encabeza la ruta. Dos cuentas con cursoId "5to-A"
--    generan rutas distintas: uuid-cta-1/5to-A/… vs uuid-cta-2/5to-A/…
--
-- 7. Movimiento oculto (visible=FALSE)
--    _tiene_acceso_a_mov_storage rechaza la firma para no-dueños aunque
--    conozcan la ruta exacta.
--
-- 8. Visor (rol = 'visor') → puede leer (SELECT) pero no subir (INSERT).
--    La política INSERT exige tesorero, admin o dueño.
--
-- 9. Apoderado (rol anon, autenticado solo vía PIN)
--    No tiene sesión Supabase Auth → no puede llamar a createSignedUrl
--    directamente desde el cliente. Los comprobantes de movimientos
--    visibles les llegan a través de las RPCs del lado tesorero que
--    ya filtran por visible=TRUE. El flujo directo apoderado→Storage
--    requiere una Edge Function (fuera del alcance de E6).
--
-- ── Dependencias ──────────────────────────────────────────────────────────────
--   get_mis_cuentas()         sql/01_schema.sql línea ~473
--   get_mis_cursos()          sql/01_schema.sql línea ~484
--   es_dueno()                sql/01_schema.sql línea ~496
--   tiene_rol_en_curso()      sql/01_schema.sql línea ~510
--   tabla movimientos         sql/01_schema.sql línea ~340
--   tabla tesorero_cuentas    sql/01_schema.sql línea ~112
--   tabla cursos              sql/01_schema.sql línea ~148
-- =============================================================================


-- ── PARTE 1: Función auxiliar de acceso ──────────────────────────────────────
--
-- _tiene_acceso_a_mov_storage(p_cuenta_id, p_mov_id)
--   Replica la lógica de la política mov_select (02_rls.sql) para que
--   Storage RLS pueda evaluar visibilidad sin acceder directamente a la
--   tabla movimientos en el contexto de storage.objects.
--
--   Devuelve TRUE si:
--     a) El usuario autenticado es dueño de la cuenta (es_dueno), o
--     b) El movimiento es visible=TRUE Y el usuario tiene acceso al curso
--        a través de get_mis_cursos (incluye todos los roles activos).
--
--   Devuelve FALSE si:
--     - El usuario no tiene ninguna relación con esa cuenta.
--     - El movimiento es visible=FALSE y el usuario no es dueño.
--     - La cuenta no existe.
--
CREATE OR REPLACE FUNCTION _tiene_acceso_a_mov_storage(
  p_cuenta_id UUID,
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
    FROM   movimientos m
    WHERE  m.cuenta_id = p_cuenta_id
      AND  m.id        = p_mov_id
      AND  (
             -- Dueño de la cuenta: accede a todo, incluyendo visible=FALSE.
             p_cuenta_id IN (
               SELECT id
               FROM   tesorero_cuentas
               WHERE  auth_id = auth.uid()
             )
             OR
             -- Delegado activo (cualquier rol): solo movimientos visible=TRUE
             -- y solo en cursos a los que tiene acceso según get_mis_cursos.
             (
               m.visible  = TRUE
               AND m.curso_id IN (SELECT get_mis_cursos(p_cuenta_id))
             )
           )
  )
$$;

COMMENT ON FUNCTION _tiene_acceso_a_mov_storage(UUID, TEXT) IS
  'Usado en Storage RLS del bucket comprobantes. Replica mov_select: dueño '
  'accede a todo; delegado activo solo a movimientos visible=TRUE en sus cursos.';


-- ── PARTE 2: Crear el bucket ──────────────────────────────────────────────────
--
-- Configuración:
--   public = false          → bucket privado; sin URLs públicas
--   file_size_limit         → 4 MB (igual al límite del modal de comprobantes)
--   allowed_mime_types      → imágenes comunes + PDF (igual que el input del modal)
--
-- ON CONFLICT DO UPDATE: si el bucket ya existe (ejecución idempotente),
-- actualiza public, file_size_limit y allowed_mime_types sin recrearlo.
--
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
  false,
  4194304,
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
-- Supabase habilita RLS en storage.objects automáticamente.
-- Cada política se elimina antes de recrearse para que el script sea idempotente.
--
-- Extracción de segmentos del path (storage.foldername devuelve array TEXT[]):
--   (storage.foldername(name))[1]::UUID  = cuentaId
--   (storage.foldername(name))[2]        = cursoId  (TEXT)
--   (storage.foldername(name))[3]        = movId    (TEXT)
--   (storage.filename(name))             = nombre del archivo con extensión
--
-- Nota: storage.foldername(name) no incluye el nombre del archivo;
-- devuelve solo los segmentos de directorio. Para una ruta
-- "uuid/cursoId/movId/archivo.pdf" el array tiene 3 elementos:
--   [1] = "uuid"
--   [2] = "cursoId"
--   [3] = "movId"
--
-- storage.filename(name) devuelve "archivo.pdf".

-- ── 3a. INSERT ────────────────────────────────────────────────────────────────
-- Permite subir archivos solo si el usuario es dueño de la cuenta (es_dueno)
-- o tiene rol tesorero o admin para ese curso (tiene_rol_en_curso).
-- Rol visor y rol editor NO tienen permiso de escritura en movimientos
-- (réplica exacta del criterio mov_insert en 02_rls.sql).
--
DROP POLICY IF EXISTS "comprobantes_insert" ON storage.objects;
CREATE POLICY "comprobantes_insert"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'comprobantes'
  AND (
    es_dueno((storage.foldername(name))[1]::UUID)
    OR
    tiene_rol_en_curso(
      (storage.foldername(name))[1]::UUID,   -- cuentaId
      (storage.foldername(name))[2],          -- cursoId
      ARRAY['tesorero', 'admin']
    )
  )
);

-- ── 3b. UPDATE ────────────────────────────────────────────────────────────────
-- Permite reemplazar archivos existentes (upsert con x-upsert: true).
-- Mismo criterio que INSERT.
--
DROP POLICY IF EXISTS "comprobantes_update" ON storage.objects;
CREATE POLICY "comprobantes_update"
ON storage.objects
FOR UPDATE
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
)
WITH CHECK (
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

-- ── 3c. DELETE ────────────────────────────────────────────────────────────────
-- Permite eliminar archivos si se es dueño o tiene rol tesorero/admin.
-- Incluye la limpieza automática del teardown del test.
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

-- ── 3d. SELECT (control de firma de URLs) ─────────────────────────────────────
-- Cuando el cliente llama a createSignedUrl(), Supabase evalúa esta política.
-- Si la política devuelve FALSE, la firma es rechazada con 403.
--
-- La política delega en _tiene_acceso_a_mov_storage():
--   - Dueño: puede firmar cualquier archivo de su cuenta.
--   - Delegado activo: puede firmar solo archivos de movimientos visible=TRUE
--     en sus cursos.
--   - Visor: igual que delegado (puede leer pero no escribir).
--   - Usuario de otra cuenta: rechazado siempre.
--   - Movimiento oculto (visible=FALSE) para no-dueño: rechazado.
--
DROP POLICY IF EXISTS "comprobantes_select" ON storage.objects;
CREATE POLICY "comprobantes_select"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'comprobantes'
  AND _tiene_acceso_a_mov_storage(
    (storage.foldername(name))[1]::UUID,   -- cuentaId (primer segmento)
    (storage.foldername(name))[3]          -- movId (tercer segmento)
  )
);


-- ── PARTE 4: Verificación ─────────────────────────────────────────────────────
-- Ejecutar después de las partes anteriores para confirmar la configuración.

-- 4a. Bucket creado con la configuración correcta
SELECT
  b.id                                        AS bucket_id,
  b.name                                      AS nombre,
  CASE b.public WHEN TRUE THEN 'PÚBLICO' ELSE 'PRIVADO' END AS acceso,
  pg_size_pretty(b.file_size_limit::bigint)   AS tam_max,
  array_length(b.allowed_mime_types, 1)       AS n_tipos_mime
FROM   storage.buckets b
WHERE  b.id = 'comprobantes';

-- 4b. Políticas creadas
SELECT
  policyname  AS politica,
  cmd         AS operacion,
  roles       AS roles_aplicables
FROM   pg_policies
WHERE  tablename   = 'objects'
  AND  policyname  LIKE 'comprobantes_%'
ORDER  BY policyname;

-- 4c. Función auxiliar creada
SELECT
  proname     AS funcion,
  prosecdef   AS security_definer,
  prokind     AS tipo
FROM   pg_proc
WHERE  proname = '_tiene_acceso_a_mov_storage';
