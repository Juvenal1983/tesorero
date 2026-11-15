-- =============================================================================
-- E6_storage_comprobantes.sql  (v4 — Edge Function, sin Vault, sin pgjwt)
-- Bucket "comprobantes" privado + políticas RLS + RPC validación + Edge Function
--
-- EJECUTAR SOLO EN STAGING (rucgmytyxpfowznowxwd.supabase.co)
-- NO ejecutar en producción.
--
-- ── Cambios en v4 respecto a v3 ───────────────────────────────────────────────
--
-- [FIX-B1] Política irrestricta en pin_intentos_fallidos eliminada
--   v3: `CREATE POLICY "pin_intentos_svc" FOR ALL TO authenticated, anon
--        USING (true) WITH CHECK (true)` — abre acceso directo irrestricto.
--   v4: Se elimina esa política. Se REVOCA acceso directo a anon y authenticated.
--       Las funciones SECURITY DEFINER ejecutan como el propietario de la función
--       (postgres, superusuario), que no es evaluado por RLS. No se necesita ninguna
--       política abierta. El cliente nunca puede consultar la tabla directamente.
--
-- [FIX-B2] pgjwt eliminado — reemplazado por Edge Function oficial
--   v3: extensions.sign() de pgjwt generaba el token JWT directamente en PostgreSQL.
--       Problema: requería que el usuario copiara manualmente el JWT Secret al Vault
--       sin demostración previa de que el token sea compatible con Storage.
--   v4: La RPC apoderado_abrir_comprobante solo VALIDA y devuelve el storagePath.
--       La firma real la hace la Edge Function `apoderado-comprobante` en Deno,
--       usando supabase.storage.createSignedUrl() — la API oficial — con la
--       service_role key inyectada automáticamente por Supabase (SUPABASE_SERVICE_ROLE_KEY),
--       sin ninguna configuración manual de Vault.
--
-- [FIX-B3] Verificación de curso activo agregada
--   v3: La RPC verificaba alumno activo pero no consultaba cursos.activo.
--   v4: Después de obtener v_curso_id del alumno, se consulta cursos.activo.
--       Si el curso no existe o está inactivo → error 'curso_inactivo'.
--
-- ── Arquitectura v4 ───────────────────────────────────────────────────────────
--
--   Browser (apoderado)
--     │  POST /functions/v1/apoderado-comprobante
--     │  {p_cuenta_id, p_alumno_id, p_pin, p_mov_id}
--     ▼
--   Edge Function (Deno, service_role automática)
--     │  1. llama apoderado_abrir_comprobante() RPC con service_role
--     │  2. si ok → supabase.storage.createSignedUrl(path, 300)
--     │  3. devuelve {ok:true, url:"https://...?token=..."}
--     ▼
--   PostgreSQL RPC apoderado_abrir_comprobante
--     │  1. rechaza PIN nulo/vacío
--     │  2. verifica bloqueo de intentos
--     │  3. verifica PIN con bcrypt (IS DISTINCT FROM — NULL-safe)
--     │  4. incrementa/reinicia contador de intentos
--     │  5. verifica alumno activo
--     │  6. verifica curso activo  ← NUEVO en v4
--     │  7. verifica movimiento visible=TRUE
--     │  8. valida que storagePath empieza con {cuenta}/{curso}/{mov}/
--     │  9. devuelve {ok:true, storage_path:"..."}
--     ▼
--   pin_intentos_fallidos (tabla protegida; solo accesible por SECURITY DEFINER)
--
-- ── Sin configuración manual de Vault ─────────────────────────────────────────
-- v4 no requiere vault.create_secret. La Edge Function usa:
--   Deno.env.get('SUPABASE_URL')               — inyectado por Supabase automáticamente
--   Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')  — inyectado por Supabase automáticamente
--
-- ── Para desplegar la Edge Function ──────────────────────────────────────────
-- Código en: supabase/functions/apoderado-comprobante/index.ts
-- Desplegar:  supabase functions deploy apoderado-comprobante --project-ref rucgmytyxpfowznowxwd
-- URL resultante: https://rucgmytyxpfowznowxwd.supabase.co/functions/v1/apoderado-comprobante
--
-- ── Dependencias ──────────────────────────────────────────────────────────────
--   get_mis_cursos()           sql/01_schema.sql
--   es_dueno()                 sql/01_schema.sql
--   tiene_rol_en_curso()       sql/01_schema.sql
--   tabla movimientos          sql/01_schema.sql
--   tabla alumnos              sql/01_schema.sql
--   tabla cursos               sql/01_schema.sql  ← nueva dependencia (curso activo)
--   tabla alumnos_credenciales sql/01_schema.sql + E5_pin_rpc.sql
--   pgcrypto                   ya habilitado (E5_pin_rpc.sql)
--   (pgjwt NO es necesario en v4)
--   (pg_net NO es necesario en v4)
--   (vault NO es necesario en v4)
-- =============================================================================


-- ── PARTE 0a: Tabla pin_intentos_fallidos ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pin_intentos_fallidos (
  cuenta_id       UUID         NOT NULL,
  alumno_id       TEXT         NOT NULL,
  intentos        INT          NOT NULL DEFAULT 0,
  bloqueado_hasta TIMESTAMPTZ,
  ultimo_intento  TIMESTAMPTZ,
  PRIMARY KEY (cuenta_id, alumno_id)
);

-- RLS habilitado para que los roles cliente NO accedan directamente.
-- Las funciones SECURITY DEFINER ejecutan como postgres (superusuario),
-- que bypasea RLS sin necesidad de ninguna política permisiva.
ALTER TABLE public.pin_intentos_fallidos ENABLE ROW LEVEL SECURITY;

-- [FIX-B1] Eliminar cualquier política permisiva que hubiera en v3.
DROP POLICY IF EXISTS "pin_intentos_svc" ON public.pin_intentos_fallidos;

-- [FIX-B1] Revocar acceso directo a anon y authenticated.
-- Con RLS habilitado y sin política permisiva, estos roles no pueden
-- leer ni escribir la tabla aunque tuvieran permisos de tabla.
REVOKE ALL ON TABLE public.pin_intentos_fallidos FROM anon;
REVOKE ALL ON TABLE public.pin_intentos_fallidos FROM authenticated;

COMMENT ON TABLE public.pin_intentos_fallidos IS
  'Contador de intentos fallidos de PIN por alumno. '
  'Accesible SOLO por funciones SECURITY DEFINER (propietario = postgres). '
  'Sin políticas permisivas — anon y authenticated no pueden consultarla directamente.';


-- ── PARTE 0b: Eliminar versión anterior de la función ────────────────────────
DROP FUNCTION IF EXISTS public._tiene_acceso_a_mov_storage(UUID, TEXT);


-- ── PARTE 1: Función auxiliar de acceso (3 parámetros) ───────────────────────
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
      AND  m.curso_id  = p_curso_id
      AND  m.id        = p_mov_id
      AND  (
             p_cuenta_id IN (
               SELECT tc.id
               FROM   public.tesorero_cuentas tc
               WHERE  tc.auth_id = auth.uid()
             )
             OR
             (
               m.visible  = TRUE
               AND m.curso_id IN (SELECT get_mis_cursos(p_cuenta_id))
             )
           )
  )
$$;

COMMENT ON FUNCTION public._tiene_acceso_a_mov_storage(UUID, TEXT, TEXT) IS
  'Storage RLS: valida cuenta+curso+movimiento contra la misma fila. '
  'Dueño accede a todo; delegado activo solo a visible=TRUE.';

REVOKE ALL    ON FUNCTION public._tiene_acceso_a_mov_storage(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public._tiene_acceso_a_mov_storage(UUID, TEXT, TEXT) TO authenticated;


-- ── PARTE 2: Crear el bucket ──────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'comprobantes', 'comprobantes', false, 4194304,
  ARRAY['image/jpeg','image/jpg','image/png','image/gif','image/webp',
        'image/heic','image/heif','application/pdf']
)
ON CONFLICT (id) DO UPDATE
  SET public             = EXCLUDED.public,
      file_size_limit    = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;


-- ── PARTE 3: Políticas RLS sobre storage.objects ─────────────────────────────

DROP POLICY IF EXISTS "comprobantes_insert" ON storage.objects;
CREATE POLICY "comprobantes_insert"
ON storage.objects FOR INSERT TO authenticated
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
    OR tiene_rol_en_curso(
      (storage.foldername(name))[1]::UUID,
      (storage.foldername(name))[2],
      ARRAY['tesorero', 'admin']
    )
  )
);

DROP POLICY IF EXISTS "comprobantes_update" ON storage.objects;
CREATE POLICY "comprobantes_update"
ON storage.objects FOR UPDATE TO authenticated
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
    OR tiene_rol_en_curso(
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
    OR tiene_rol_en_curso(
      (storage.foldername(name))[1]::UUID,
      (storage.foldername(name))[2],
      ARRAY['tesorero', 'admin']
    )
  )
);

DROP POLICY IF EXISTS "comprobantes_delete" ON storage.objects;
CREATE POLICY "comprobantes_delete"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'comprobantes'
  AND (
    es_dueno((storage.foldername(name))[1]::UUID)
    OR tiene_rol_en_curso(
      (storage.foldername(name))[1]::UUID,
      (storage.foldername(name))[2],
      ARRAY['tesorero', 'admin']
    )
  )
);

DROP POLICY IF EXISTS "comprobantes_select" ON storage.objects;
CREATE POLICY "comprobantes_select"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'comprobantes'
  AND _tiene_acceso_a_mov_storage(
    (storage.foldername(name))[1]::UUID,
    (storage.foldername(name))[2],
    (storage.foldername(name))[3]
  )
);


-- ── PARTE 4: RPC apoderado_abrir_comprobante (v4 — solo validación, sin firma) ─
--
-- Esta función VALIDA el acceso del apoderado y devuelve el storagePath.
-- La firma real de la URL la hace la Edge Function `apoderado-comprobante`
-- (ver supabase/functions/apoderado-comprobante/index.ts).
--
-- Flujo:
--   1. Rechaza PIN nulo/vacío.
--   2. Verifica bloqueo de intentos.
--   3. Verifica PIN con bcrypt (IS DISTINCT FROM — NULL-safe).
--   4. Incrementa/reinicia contador de intentos.
--   5. Verifica alumno activo.
--   6. Verifica curso activo.          ← NUEVO en v4
--   7. Verifica movimiento visible=TRUE del curso del alumno.
--   8. Valida que storagePath empieza con {cuentaId}/{cursoId}/{movId}/.
--   9. Devuelve {ok:true, storage_path:"..."}.
--
-- La firma la hace la Edge Function sobre storage_path.
-- (Sin Vault. Sin pgjwt. Sin pg_net.)
--
-- Parámetros:
--   p_cuenta_id  UUID  — cuenta donde está el alumno y el movimiento
--   p_alumno_id  TEXT  — ID del alumno cuyo PIN se valida
--   p_pin        TEXT  — PIN en texto plano (se valida con bcrypt)
--   p_mov_id     TEXT  — ID del movimiento cuyo comprobante se solicita
--
-- Devuelve: JSONB
--   éxito: {"ok": true, "storage_path": "{uuid}/{cursoId}/{movId}/{file}"}
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
SET search_path = public, extensions
AS $$
DECLARE
  v_hash           TEXT;
  v_intentos       INT;
  v_bloqueado_hasta TIMESTAMPTZ;
  v_curso_id       TEXT;
  v_alumno_estado  TEXT;
  v_curso_activo   BOOLEAN;
  v_archivos       JSONB;
  v_comprobante    TEXT;
  v_path           TEXT;
  v_prefix         TEXT;
BEGIN

  -- ── 1. Rechazar PIN nulo o vacío ──────────────────────────────────────────
  IF p_pin IS NULL OR trim(p_pin) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'pin_requerido');
  END IF;

  -- ── 2. Verificar bloqueo por intentos fallidos ────────────────────────────
  SELECT intentos, bloqueado_hasta
  INTO   v_intentos, v_bloqueado_hasta
  FROM   public.pin_intentos_fallidos
  WHERE  cuenta_id = p_cuenta_id AND alumno_id = p_alumno_id;

  IF FOUND AND v_bloqueado_hasta IS NOT NULL AND v_bloqueado_hasta > now() THEN
    RETURN jsonb_build_object(
      'ok',      false,
      'error',   'cuenta_bloqueada',
      'detalle', 'Demasiados intentos fallidos. Vuelve a intentarlo en unos minutos.',
      'hasta',   to_char(v_bloqueado_hasta AT TIME ZONE 'UTC', 'HH24:MI UTC')
    );
  END IF;

  -- ── 3. Obtener PIN hash del alumno ────────────────────────────────────────
  SELECT pin_hash INTO v_hash
  FROM   public.alumnos_credenciales
  WHERE  cuenta_id = p_cuenta_id AND alumno_id = p_alumno_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'alumno_sin_pin');
  END IF;

  -- ── 4. Verificar PIN con bcrypt (NULL-safe) ───────────────────────────────
  -- IS DISTINCT FROM evita el bypass: crypt(NULL, hash) = NULL,
  -- pero NULL IS DISTINCT FROM hash → TRUE → el bloque se ejecuta siempre.
  IF crypt(p_pin, v_hash) IS DISTINCT FROM v_hash THEN

    INSERT INTO public.pin_intentos_fallidos (cuenta_id, alumno_id, intentos, ultimo_intento)
    VALUES (p_cuenta_id, p_alumno_id, 1, now())
    ON CONFLICT (cuenta_id, alumno_id) DO UPDATE
      SET intentos       = pin_intentos_fallidos.intentos + 1,
          ultimo_intento = now(),
          bloqueado_hasta = CASE
            WHEN pin_intentos_fallidos.intentos + 1 >= 5
            THEN now() + interval '15 minutes'
            ELSE NULL
          END;

    RETURN jsonb_build_object('ok', false, 'error', 'pin_incorrecto');
  END IF;

  -- ── 5. PIN correcto: reiniciar contador ──────────────────────────────────
  UPDATE public.pin_intentos_fallidos
  SET intentos = 0, bloqueado_hasta = NULL, ultimo_intento = now()
  WHERE cuenta_id = p_cuenta_id AND alumno_id = p_alumno_id;

  -- ── 6. Verificar alumno activo ────────────────────────────────────────────
  SELECT a.curso_id, a.estado INTO v_curso_id, v_alumno_estado
  FROM   public.alumnos a
  WHERE  a.cuenta_id = p_cuenta_id AND a.id = p_alumno_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'alumno_no_encontrado');
  END IF;

  IF v_alumno_estado IS DISTINCT FROM 'activo' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'alumno_inactivo');
  END IF;

  -- ── 7. Verificar curso activo ─────────────────────────────────────────────
  -- [FIX-B3] Consulta explícita a cursos.activo.
  SELECT activo INTO v_curso_activo
  FROM   public.cursos
  WHERE  cuenta_id = p_cuenta_id AND id = v_curso_id;

  IF NOT FOUND OR NOT v_curso_activo THEN
    RETURN jsonb_build_object('ok', false, 'error', 'curso_inactivo');
  END IF;

  -- ── 8. Verificar movimiento: visible=TRUE, del curso del alumno ───────────
  SELECT archivos, comprobante INTO v_archivos, v_comprobante
  FROM   public.movimientos
  WHERE  cuenta_id = p_cuenta_id
    AND  id        = p_mov_id
    AND  curso_id  = v_curso_id
    AND  visible   = TRUE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'movimiento_no_accesible');
  END IF;

  -- ── 9. Extraer storagePath ────────────────────────────────────────────────
  v_path := v_comprobante;
  IF v_path IS NULL OR v_path = ''
     OR v_path LIKE 'https://%'
     OR v_path LIKE 'data:%'
  THEN
    IF jsonb_array_length(COALESCE(v_archivos, '[]'::jsonb)) > 0 THEN
      v_path := v_archivos->0->>'storagePath';
    END IF;
  END IF;

  IF v_path IS NULL OR v_path = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sin_comprobante');
  END IF;

  -- ── 10. Validar que el storagePath pertenece a esta cuenta/curso/movimiento ─
  v_prefix := p_cuenta_id::text || '/' || v_curso_id || '/' || p_mov_id || '/';
  IF v_path NOT LIKE (v_prefix || '%') THEN
    RETURN jsonb_build_object(
      'ok',      false,
      'error',   'ruta_invalida',
      'detalle', 'storagePath no corresponde a esta cuenta/curso/movimiento.'
    );
  END IF;

  -- ── 11. Devolver storagePath validado (la firma la hace la Edge Function) ──
  RETURN jsonb_build_object('ok', true, 'storage_path', v_path);
END;
$$;

COMMENT ON FUNCTION public.apoderado_abrir_comprobante(UUID, TEXT, TEXT, TEXT) IS
  'Valida acceso del apoderado y devuelve storage_path (NO firma). '
  'Verificaciones: PIN null-safe (IS DISTINCT FROM), bloqueo 5 intentos/15 min, '
  'alumno activo, curso activo, movimiento visible=TRUE, ruta {cuenta}/{curso}/{mov}/. '
  'La URL firmada la genera la Edge Function apoderado-comprobante. '
  'Sin Vault. Sin pgjwt. Sin pg_net.';

REVOKE ALL    ON FUNCTION public.apoderado_abrir_comprobante(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.apoderado_abrir_comprobante(UUID, TEXT, TEXT, TEXT) TO anon;
GRANT  EXECUTE ON FUNCTION public.apoderado_abrir_comprobante(UUID, TEXT, TEXT, TEXT) TO authenticated;


-- ── PARTE 5: Verificación ─────────────────────────────────────────────────────

-- 5a. Bucket
SELECT
  b.id,
  CASE b.public WHEN TRUE THEN 'PÚBLICO ⚠' ELSE 'PRIVADO ✓' END AS acceso,
  pg_size_pretty(b.file_size_limit::bigint) AS tam_max,
  array_length(b.allowed_mime_types, 1) AS n_tipos_mime
FROM storage.buckets b WHERE b.id = 'comprobantes';

-- 5b. Políticas Storage
SELECT policyname, cmd, roles FROM pg_policies
WHERE tablename = 'objects' AND policyname LIKE 'comprobantes_%'
ORDER BY policyname;

-- 5c. Tabla pin_intentos_fallidos
SELECT
  t.tablename,
  CASE WHEN t.rowsecurity THEN 'RLS activo ✓' ELSE 'SIN RLS ⚠' END AS rls,
  COUNT(pol.policyname) AS n_politicas,
  CASE WHEN COUNT(pol.policyname) = 0 THEN 'sin políticas (correcto) ✓'
       ELSE 'con políticas ⚠ — verificar' END AS politicas
FROM pg_tables t
LEFT JOIN pg_policies pol ON pol.tablename = t.tablename
WHERE t.tablename = 'pin_intentos_fallidos'
GROUP BY t.tablename, t.rowsecurity;

-- 5d. Privilegios directos sobre pin_intentos_fallidos
-- Debe mostrar VACÍO para anon y authenticated (no deben tener acceso directo).
SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_name = 'pin_intentos_fallidos'
  AND grantee IN ('anon', 'authenticated')
ORDER BY grantee, privilege_type;

-- 5e. Funciones
SELECT
  p.proname AS funcion,
  p.pronargs AS n_params,
  array_to_string(p.proconfig, ', ') AS search_path,
  CASE WHEN has_function_privilege('authenticated', p.oid, 'EXECUTE')
       THEN 'authenticated ✓' ELSE 'SIN GRANT ⚠' END AS grant_authenticated,
  CASE WHEN p.proname = 'apoderado_abrir_comprobante'
        AND has_function_privilege('anon', p.oid, 'EXECUTE')
       THEN 'anon ✓'
       WHEN p.proname = 'apoderado_abrir_comprobante'
       THEN 'SIN GRANT anon ⚠' ELSE '(solo authenticated)' END AS grant_anon
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('_tiene_acceso_a_mov_storage', 'apoderado_abrir_comprobante')
ORDER BY p.proname;

-- 5f. Verificar que la función devuelve storage_path (no url) con un PIN inválido
-- (safe: solo prueba la ruta de error, nunca devuelve datos reales)
SELECT public.apoderado_abrir_comprobante(
  '00000000-0000-0000-0000-000000000000'::UUID,
  'alumno-inexistente',
  'pin-de-prueba',
  'mov-inexistente'
) AS respuesta_esperada;
-- Esperado: {"ok": false, "error": "alumno_sin_pin"}
