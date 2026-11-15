-- =============================================================================
-- E6_storage_comprobantes.sql  (v3 — correcciones seguridad + pgjwt)
-- Bucket "comprobantes" privado + políticas RLS + RPC apoderado
--
-- EJECUTAR SOLO EN STAGING (rucgmytyxpfowznowxwd.supabase.co)
-- NO ejecutar en producción.
--
-- ── Cambios en v3 respecto a v2 ───────────────────────────────────────────────
--
-- [FIX-1] NULL PIN bypass corregido
--   v2: `IF NOT (crypt(p_pin, v_hash) = v_hash)` — no rechaza NULL en PostgreSQL
--       porque `crypt(NULL, v_hash) = v_hash` → NULL, y `NOT NULL` → NULL,
--       que el condicional interpreta como FALSE (no entra al bloque → pasa).
--   v3: Comprobación explícita de PIN nulo/vacío al inicio, y comparación
--       NULL-safe con IS DISTINCT FROM:
--         IF p_pin IS NULL OR trim(p_pin) = '' THEN RETURN error END IF;
--         IF crypt(p_pin, v_hash) IS DISTINCT FROM v_hash THEN ...
--
-- [FIX-2] pg_net eliminado — reemplazado por pgjwt (firma en base de datos)
--   v2: net.http_post → net.http_collect_response(async:=false)
--       Las solicitudes pg_net se despachan DESPUÉS del commit de la transacción.
--       Llamar a http_collect_response dentro de la misma transacción bloquea
--       indefinidamente esperando una respuesta de una solicitud no enviada (deadlock).
--   v3: extensions.sign() de pgjwt genera el JWT de Storage directamente en
--       PostgreSQL, sincrónicamente, sin ninguna llamada de red.
--       Payload: {"url": "/comprobantes/{storagePath}", "exp": unix_ts + 300}
--       URL: {SUPA_URL}/storage/v1/object/sign/comprobantes/{path}?token={jwt}
--       Secret: "jwt_secret" (en lugar de "service_role_key")
--
-- [FIX-3] Validación de ruta antes de firmar
--   v2: solo se verificaba que el movimiento existía y era visible=TRUE.
--   v3: además se comprueba que el storagePath solicitado comienza con
--       {cuentaId}/{cursoId}/{movId}/ para evitar que una autorización válida
--       de movimiento permita firmar un archivo de otra ruta.
--
-- [FIX-4] Bloqueo de intentos fallidos (tabla pin_intentos_fallidos)
--   v3: 5 intentos fallidos → bloqueo 15 minutos.
--       Tabla: pin_intentos_fallidos(cuenta_id, alumno_id, intentos, bloqueado_hasta, ultimo_intento)
--       Con RLS habilitado y políticas para funciones SECURITY DEFINER.
--
-- [FIX-5] Validación de alumno y curso activos
--   v3: comprueba que el alumno tiene estado='activo' en la tabla alumnos.
--
-- ── Decisiones de diseño (bucket) ─────────────────────────────────────────────
--
-- 1. Bucket PRIVADO (public = false)
--    Los archivos NO son accesibles por URL pública.
--    La app genera URLs firmadas de CORTA DURACIÓN al momento de abrirlas.
--    Lo que se persiste en PostgreSQL es la RUTA DEL ARCHIVO (storagePath).
--
-- 2. Ruta de 4 segmentos: {cuentaId}/{cursoId}/{movId}/{archivo}
--    - El primer segmento es siempre un UUID de cuenta.
--    - Los TRES primeros segmentos se validan juntos contra movimientos.
--
-- ── Dependencias ──────────────────────────────────────────────────────────────
--   get_mis_cursos()           sql/01_schema.sql
--   es_dueno()                 sql/01_schema.sql
--   tiene_rol_en_curso()       sql/01_schema.sql
--   tabla movimientos          sql/01_schema.sql
--   tabla alumnos              sql/01_schema.sql
--   tabla alumnos_credenciales sql/01_schema.sql + E5_pin_rpc.sql
--   pgcrypto                   ya habilitado (E5_pin_rpc.sql)
--   pgjwt                      CREATE EXTENSION pgjwt SCHEMA extensions (ver PARTE 0)
--   vault                      Supabase Vault, disponible en todos los proyectos
--   (pg_net NO es necesario en v3)
--
-- ── Configuración previa: Vault ───────────────────────────────────────────────
-- Los secrets NUNCA deben aparecer en este archivo ni en el repositorio.
-- Configurar manualmente en Supabase Dashboard → Settings → Vault:
--
--   1. Secret: nombre = "supabase_url"
--      valor   = https://rucgmytyxpfowznowxwd.supabase.co
--
--   2. Secret: nombre = "jwt_secret"
--      valor   = (copiar desde Settings → API → JWT Settings → JWT Secret)
--      ← CAMBIO v3: era "service_role_key"; ahora se usa el JWT secret para pgjwt
--
-- Alternativa: SQL Editor de STAGING (NO commitear el valor del secret):
--   SELECT vault.create_secret(
--     'https://rucgmytyxpfowznowxwd.supabase.co', 'supabase_url'
--   );
--   SELECT vault.create_secret(
--     '<jwt_secret_aqui>', 'jwt_secret'   -- ← NO incluir en git
--   );
--
-- Sin estos secrets, apoderado_abrir_comprobante devuelve:
--   {"ok": false, "error": "vault_no_configurado"}
-- =============================================================================


-- ── PARTE 0a: Habilitar pgjwt ─────────────────────────────────────────────────
-- pgjwt provee extensions.sign(payload jsonb, secret text, algorithm text)
-- que genera JWTs sincrónicamente dentro de PostgreSQL, sin llamadas de red.
-- Supabase lo tiene disponible; solo hay que habilitarlo si no está activo.
CREATE EXTENSION IF NOT EXISTS pgjwt SCHEMA extensions;


-- ── PARTE 0b: Tabla pin_intentos_fallidos ─────────────────────────────────────
-- Registra intentos fallidos por (cuenta_id, alumno_id).
-- 5 intentos fallidos → bloqueo de 15 minutos (bloqueado_hasta).
-- Cuando el PIN es correcto, se reinicia el contador.
CREATE TABLE IF NOT EXISTS public.pin_intentos_fallidos (
  cuenta_id      UUID         NOT NULL,
  alumno_id      TEXT         NOT NULL,
  intentos       INT          NOT NULL DEFAULT 0,
  bloqueado_hasta TIMESTAMPTZ,
  ultimo_intento  TIMESTAMPTZ,
  PRIMARY KEY (cuenta_id, alumno_id)
);

-- RLS: habilitado; las políticas permiten acceso solo a funciones SECURITY DEFINER.
ALTER TABLE public.pin_intentos_fallidos ENABLE ROW LEVEL SECURITY;

-- Funciones SECURITY DEFINER pueden hacer SELECT/INSERT/UPDATE usando service_role
-- (que RLS no evalúa). Las políticas siguientes permiten también a authenticated
-- y anon en caso de que la función ejecute con SECURITY INVOKER por error.
DROP POLICY IF EXISTS "pin_intentos_svc"  ON public.pin_intentos_fallidos;
CREATE POLICY "pin_intentos_svc"
ON public.pin_intentos_fallidos
FOR ALL
TO authenticated, anon
USING  (true)   -- lectura permitida en contexto SECURITY DEFINER
WITH CHECK (true);

COMMENT ON TABLE public.pin_intentos_fallidos IS
  'Contador de intentos fallidos de PIN por alumno. '
  'Usada por apoderado_abrir_comprobante para bloquear tras 5 intentos (15 min).';


-- ── PARTE 0c: Eliminar versión anterior de la función ────────────────────────
-- Eliminar la versión de 2 parámetros de _tiene_acceso_a_mov_storage.
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
  'Storage RLS del bucket comprobantes. Valida los 3 segmentos (cuenta, curso, mov) '
  'contra la misma fila de movimientos. Dueño accede a todo; delegado activo solo '
  'a movimientos visible=TRUE en sus cursos. REVOKE ejecutado a continuación.';

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

-- ── 3a. INSERT ────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "comprobantes_insert" ON storage.objects;
CREATE POLICY "comprobantes_insert"
ON storage.objects
FOR INSERT
TO authenticated
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

-- ── 3b. UPDATE ────────────────────────────────────────────────────────────────
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

-- ── 3d. SELECT ────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "comprobantes_select" ON storage.objects;
CREATE POLICY "comprobantes_select"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'comprobantes'
  AND _tiene_acceso_a_mov_storage(
    (storage.foldername(name))[1]::UUID,
    (storage.foldername(name))[2],
    (storage.foldername(name))[3]
  )
);


-- ── PARTE 4: RPC apoderado_abrir_comprobante (v3 — pgjwt, sin pg_net) ─────────
--
-- Genera una URL firmada de Supabase Storage usando pgjwt directamente en la DB,
-- sin llamadas de red. La firma se produce en la misma transacción, sincrónicamente.
--
-- Flujo:
--   1. Rechazar PIN nulo/vacío explícitamente.
--   2. Comprobar bloqueo por intentos fallidos.
--   3. Obtener PIN hash del alumno.
--   4. Verificar PIN con bcrypt (IS DISTINCT FROM — NULL-safe).
--   5. Si PIN incorrecto: incrementar contador; bloquear si llega a 5.
--   6. Si PIN correcto: reiniciar contador.
--   7. Verificar que el alumno está activo.
--   8. Obtener curso_id del alumno.
--   9. Verificar movimiento: visible=TRUE, del curso del alumno.
--  10. Extraer storagePath del movimiento.
--  11. Validar que el storagePath pertenece a esta cuenta/curso/mov.
--  12. Leer supabase_url y jwt_secret desde Supabase Vault.
--  13. Generar JWT con pgjwt (extensions.sign) — sin llamada de red.
--  14. Devolver URL firmada.
--
-- Parámetros:
--   p_cuenta_id  UUID  — cuenta donde está el alumno y el movimiento
--   p_alumno_id  TEXT  — ID del alumno cuyo PIN se valida
--   p_pin        TEXT  — PIN en texto plano (se valida con bcrypt)
--   p_mov_id     TEXT  — ID del movimiento cuyo comprobante se solicita
--
-- Devuelve: JSONB
--   éxito: {"ok": true,  "url": "https://...supabase.co/storage/v1/object/sign/...?token=..."}
--   error: {"ok": false, "error": "<código>", ...}
--
-- Prerequisitos:
--   - pgjwt habilitado (PARTE 0a de este script).
--   - Vault configurado con "supabase_url" y "jwt_secret" (ver encabezado).
--   - pgcrypto habilitado (ya configurado por E5_pin_rpc.sql).
--   - Tabla pin_intentos_fallidos creada (PARTE 0b de este script).
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
SET search_path = public, extensions, vault
AS $$
DECLARE
  v_hash           TEXT;
  v_intentos       INT;
  v_bloqueado_hasta TIMESTAMPTZ;
  v_curso_id       TEXT;
  v_alumno_estado  TEXT;
  v_archivos       JSONB;
  v_comprobante    TEXT;
  v_path           TEXT;
  v_prefix         TEXT;
  v_supa_url       TEXT;
  v_jwt_secret     TEXT;
  v_token          TEXT;
  v_exp            BIGINT;
BEGIN

  -- ── 1. Rechazar PIN nulo o vacío ──────────────────────────────────────────
  -- crypt(NULL, hash) = NULL, y NOT NULL = NULL → condición no se dispara.
  -- Comprobamos explícitamente antes de cualquier consulta.
  IF p_pin IS NULL OR trim(p_pin) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'pin_requerido');
  END IF;

  -- ── 2. Comprobar bloqueo por intentos fallidos ────────────────────────────
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
  -- IS DISTINCT FROM: devuelve TRUE cuando cualquiera de los lados es NULL
  -- o cuando los valores difieren — nunca NULL. Elimina el bypass de PIN nulo.
  IF crypt(p_pin, v_hash) IS DISTINCT FROM v_hash THEN

    -- ── 5. Incrementar contador de intentos fallidos ──────────────────────
    INSERT INTO public.pin_intentos_fallidos (cuenta_id, alumno_id, intentos, ultimo_intento)
    VALUES (p_cuenta_id, p_alumno_id, 1, now())
    ON CONFLICT (cuenta_id, alumno_id) DO UPDATE
      SET intentos       = pin_intentos_fallidos.intentos + 1,
          ultimo_intento = now(),
          -- Bloquear 15 minutos si se alcanzan 5 intentos fallidos
          bloqueado_hasta = CASE
            WHEN pin_intentos_fallidos.intentos + 1 >= 5
            THEN now() + interval '15 minutes'
            ELSE NULL
          END;

    RETURN jsonb_build_object('ok', false, 'error', 'pin_incorrecto');
  END IF;

  -- ── 6. PIN correcto: reiniciar contador de intentos ──────────────────────
  UPDATE public.pin_intentos_fallidos
  SET intentos = 0, bloqueado_hasta = NULL, ultimo_intento = now()
  WHERE cuenta_id = p_cuenta_id AND alumno_id = p_alumno_id;

  -- ── 7. Verificar que el alumno está activo ────────────────────────────────
  SELECT a.curso_id, a.estado INTO v_curso_id, v_alumno_estado
  FROM   public.alumnos a
  WHERE  a.cuenta_id = p_cuenta_id AND a.id = p_alumno_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'alumno_no_encontrado');
  END IF;

  IF v_alumno_estado IS DISTINCT FROM 'activo' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'alumno_inactivo');
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
  -- El path DEBE empezar con "{cuentaId}/{cursoId}/{movId}/" para evitar que
  -- una autorización válida sobre un movimiento permita firmar archivos de otro.
  v_prefix := p_cuenta_id::text || '/' || v_curso_id || '/' || p_mov_id || '/';
  IF v_path NOT LIKE (v_prefix || '%') THEN
    RETURN jsonb_build_object(
      'ok',      false,
      'error',   'ruta_invalida',
      'detalle', 'El storagePath no corresponde a esta cuenta/curso/movimiento.'
    );
  END IF;

  -- ── 11. Leer supabase_url y jwt_secret desde Vault ───────────────────────
  -- jwt_secret es el secreto JWT de Supabase (Settings → API → JWT Settings).
  -- Es distinto de service_role_key; lo usa pgjwt para firmar tokens de Storage.
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
    SELECT decrypted_secret INTO STRICT v_jwt_secret
    FROM   vault.decrypted_secrets
    WHERE  name = 'jwt_secret'
    LIMIT  1;
  EXCEPTION WHEN NO_DATA_FOUND OR TOO_MANY_ROWS OR OTHERS THEN
    RETURN jsonb_build_object(
      'ok',      false,
      'error',   'vault_no_configurado',
      'detalle', 'Crear secret "jwt_secret" en Supabase Vault (ver sql/E6_storage_comprobantes.sql)'
    );
  END;

  -- ── 12. Generar JWT con pgjwt (sin llamada de red) ────────────────────────
  -- Supabase Storage valida tokens con payload {"url": "/comprobantes/{path}", "exp": unix_ts}.
  -- extensions.sign(payload jsonb, secret text, algorithm text) → TEXT (JWT compacto)
  -- Vigencia: 5 minutos (300 segundos).
  v_exp   := extract(epoch from now())::BIGINT + 300;
  v_token := extensions.sign(
    jsonb_build_object(
      'url', '/comprobantes/' || v_path,
      'exp', v_exp
    ),
    v_jwt_secret,
    'HS256'
  );

  -- ── 13. Devolver URL firmada ──────────────────────────────────────────────
  -- Formato: {SUPA_URL}/storage/v1/object/sign/comprobantes/{path}?token={jwt}
  RETURN jsonb_build_object(
    'ok',  true,
    'url', v_supa_url
           || '/storage/v1/object/sign/comprobantes/'
           || v_path
           || '?token='
           || v_token
  );
END;
$$;

COMMENT ON FUNCTION public.apoderado_abrir_comprobante(UUID, TEXT, TEXT, TEXT) IS
  'Genera URL firmada de 5 min para un comprobante. '
  'Valida PIN bcrypt (NULL-safe con IS DISTINCT FROM), bloqueo de intentos (5 → 15 min), '
  'alumno activo, movimiento visible=TRUE, ruta {cuentaId}/{cursoId}/{movId}. '
  'Firma con pgjwt (extensions.sign) — sin pg_net, sin llamada de red. '
  'Secret Vault: "jwt_secret" (NO service_role_key). '
  'Concedido a anon + authenticated.';

REVOKE ALL    ON FUNCTION public.apoderado_abrir_comprobante(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.apoderado_abrir_comprobante(UUID, TEXT, TEXT, TEXT) TO anon;
GRANT  EXECUTE ON FUNCTION public.apoderado_abrir_comprobante(UUID, TEXT, TEXT, TEXT) TO authenticated;


-- ── PARTE 5: Verificación ─────────────────────────────────────────────────────

-- 5a. pgjwt habilitado
SELECT
  extname                                      AS extension,
  CASE WHEN extname IS NOT NULL THEN 'activa ✓' ELSE 'FALTA ⚠' END AS estado,
  extversion                                   AS version
FROM pg_extension
WHERE extname = 'pgjwt';

-- 5b. Bucket creado con la configuración correcta
SELECT
  b.id                                        AS bucket_id,
  b.name                                      AS nombre,
  CASE b.public WHEN TRUE THEN 'PÚBLICO ⚠' ELSE 'PRIVADO ✓' END AS acceso,
  pg_size_pretty(b.file_size_limit::bigint)   AS tam_max,
  array_length(b.allowed_mime_types, 1)       AS n_tipos_mime
FROM   storage.buckets b
WHERE  b.id = 'comprobantes';

-- 5c. Políticas creadas
SELECT
  policyname  AS politica,
  cmd         AS operacion,
  roles       AS roles_aplicables
FROM   pg_policies
WHERE  tablename   = 'objects'
  AND  policyname  LIKE 'comprobantes_%'
ORDER  BY policyname;

-- 5d. Tabla pin_intentos_fallidos
SELECT
  tablename,
  CASE WHEN rowsecurity THEN 'RLS activo ✓' ELSE 'SIN RLS ⚠' END AS rls
FROM pg_tables
WHERE tablename = 'pin_intentos_fallidos';

-- 5e. Funciones creadas con sus permisos
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

-- 5f. Verificar que Vault tiene los secrets necesarios
--    (Solo comprueba existencia; NO muestra el valor)
--    CAMBIO v3: "jwt_secret" en lugar de "service_role_key"
SELECT
  name,
  CASE WHEN decrypted_secret IS NOT NULL AND decrypted_secret <> ''
       THEN 'configurado ✓'
       ELSE 'FALTA ⚠'
  END AS estado
FROM   vault.decrypted_secrets
WHERE  name IN ('supabase_url', 'jwt_secret');
