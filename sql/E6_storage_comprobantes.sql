-- =============================================================================
-- E6_storage_comprobantes.sql
-- Bucket "comprobantes" + políticas RLS para Supabase Storage
--
-- EJECUTAR SOLO EN STAGING (rucgmytyxpfowznowxwd.supabase.co)
-- Revisar con el usuario antes de ejecutar.
--
-- Decisiones de diseño:
--   • Bucket PÚBLICO: el app genera URLs públicas
--     (/storage/v1/object/public/comprobantes/...) y las abre con window.open.
--     Con bucket privado las URLs requieren firma y el app no las genera.
--   • INSERT restringido a usuarios autenticados cuyo curso pertenezca
--     a una cuenta que les corresponde (dueño o delegado activo vía get_mis_cuentas).
--   • DELETE restringido al mismo criterio que INSERT.
--   • No hay política SELECT explícita: en bucket público, Storage ignora RLS
--     para GET y los archivos son accesibles con la URL exacta (sin listar bucket).
--
-- Path de archivo: {cursoId}/{movId}/{uid}.{ext}
--   El primer segmento es siempre el curso_id.
--   La función get_mis_cuentas() devuelve las cuentas accesibles para auth.uid().
-- =============================================================================

-- ── 1. Crear el bucket ────────────────────────────────────────────────────────
-- Si ya existe no hace nada (INSERT ... ON CONFLICT DO NOTHING).
-- public = true  → URLs del tipo /storage/v1/object/public/... son accesibles
--                  sin Authorization header (compatible con el app).
-- file_size_limit = 4194304 → 4 MB, igual al límite del modal de comprobantes.
-- allowed_mime_types → solo imágenes y PDF (como acepta el input del modal).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'comprobantes',
  'comprobantes',
  true,
  4194304,
  ARRAY[
    'image/jpeg', 'image/jpg', 'image/png', 'image/gif',
    'image/webp', 'image/heic', 'image/heif',
    'application/pdf'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET public             = EXCLUDED.public,
      file_size_limit    = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;


-- ── 2. Políticas RLS sobre storage.objects ────────────────────────────────────
-- Supabase habilita RLS en storage.objects automáticamente.

-- 2a. INSERT — solo usuarios autenticados, solo en cursos de sus cuentas
-- storage.foldername(name) devuelve el array de segmentos del path.
-- El primer segmento [1] es el cursoId.
DROP POLICY IF EXISTS "comprobantes_insert_autenticado" ON storage.objects;
CREATE POLICY "comprobantes_insert_autenticado"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'comprobantes'
  AND (storage.foldername(name))[1] IN (
    SELECT c.id
    FROM   public.cursos c
    WHERE  c.cuenta_id IN (SELECT id FROM get_mis_cuentas())
  )
);

-- 2b. UPDATE — mismo criterio que INSERT (permite x-upsert: true del app)
DROP POLICY IF EXISTS "comprobantes_update_autenticado" ON storage.objects;
CREATE POLICY "comprobantes_update_autenticado"
ON storage.objects FOR UPDATE
TO authenticated
USING (
  bucket_id = 'comprobantes'
  AND (storage.foldername(name))[1] IN (
    SELECT c.id
    FROM   public.cursos c
    WHERE  c.cuenta_id IN (SELECT id FROM get_mis_cuentas())
  )
);

-- 2c. DELETE — mismo criterio (teardown del test + acción manual del tesorero)
DROP POLICY IF EXISTS "comprobantes_delete_autenticado" ON storage.objects;
CREATE POLICY "comprobantes_delete_autenticado"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'comprobantes'
  AND (storage.foldername(name))[1] IN (
    SELECT c.id
    FROM   public.cursos c
    WHERE  c.cuenta_id IN (SELECT id FROM get_mis_cuentas())
  )
);

-- ── 3. Verificación ───────────────────────────────────────────────────────────
-- Ejecutar después del bloque anterior para confirmar la configuración.
SELECT
  b.id,
  b.name,
  b.public,
  pg_size_pretty(b.file_size_limit::bigint) AS tam_max,
  b.allowed_mime_types,
  COUNT(p.policyname) AS n_politicas
FROM   storage.buckets b
LEFT JOIN pg_policies p
  ON p.tablename = 'objects'
 AND p.policyname LIKE 'comprobantes_%'
WHERE  b.id = 'comprobantes'
GROUP BY b.id, b.name, b.public, b.file_size_limit, b.allowed_mime_types;
