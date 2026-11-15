-- =============================================================================
-- E6_storage_comprobantes.sql  (v5 — Edge Function, sin Vault, sin pgjwt)
-- Bucket "comprobantes" privado + políticas RLS + RPC validación + Edge Function
--
-- EJECUTAR SOLO EN STAGING (rucgmytyxpfowznowxwd.supabase.co)
-- NO ejecutar en producción.
--
-- ── Cambios en v5 respecto a v4 ───────────────────────────────────────────────
--
-- [FIX-C1] verify_jwt = false en supabase/config.toml
--   Los apoderados no tienen sesión Supabase Auth; el gateway rechazaría con 401
--   cualquier request sin JWT válido. La protección real es el PIN con bcrypt.
--   Configurado en supabase/config.toml (no como flag en el comando deploy).
--
-- [FIX-C2] GRANT EXECUTE a service_role
--   v4: solo anon y authenticated. La Edge Function invoca la RPC con service_role
--   y, aunque postgres-superusuario llama directamente, el GRANT explícito es
--   necesario para evitar depender de defaults o de privilegios heredados.
--
-- [FIX-C3] starts_with() en lugar de LIKE
--   v4: `v_path NOT LIKE (v_prefix || '%')` — LIKE interpreta % y _ como comodines.
--   curso_id y p_mov_id son TEXT y podrían contener esos caracteres.
--   v5: `NOT starts_with(v_path, v_prefix)` — comparación literal, sin comodines.
--
-- [FIX-C4] Contador de intentos unificado con _apoderado_verificar_pin
--   v4: apoderado_abrir_comprobante mantenía su propio contador en pin_intentos_fallidos.
--   Problema: apoderado_acceso, apoderado_ver_pagos, etc. usan _apoderado_verificar_pin
--   que escribe en apoderado_intentos. Dos tablas → eludir el límite alternando endpoints.
--   v5: apoderado_abrir_comprobante delega a _apoderado_verificar_pin (misma tabla
--   apoderado_intentos que todos los demás RPCs). La tabla pin_intentos_fallidos se
--   mantiene (con sus REVOKEs) por idempotencia de migraciones anteriores, pero la
--   función ya no escribe en ella.
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
--   v5: La RPC apoderado_abrir_comprobante solo VALIDA y devuelve el storagePath.
--       La firma real la hace la Edge Function `apoderado-comprobante` en Deno,
--       usando supabase.storage.createSignedUrl() — la API oficial — con la
--       service_role key inyectada automáticamente por Supabase (SUPABASE_SERVICE_ROLE_KEY),
--       sin ninguna configuración manual de Vault.
--
-- [FIX-B3] Verificación de curso activo agregada (delegada a _apoderado_verificar_pin en v5)
--   v3: La RPC verificaba alumno activo pero no consultaba cursos.activo.
--   v4: Después de obtener v_curso_id del alumno, se consultaba cursos.activo.
--   v5: La verificación la realiza _apoderado_verificar_pin; apoderado_abrir_comprobante
--       distingue entre 'alumno_inactivo' y 'curso_inactivo' en el mapeo de errores.
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
-- NOTA v5: apoderado_abrir_comprobante ya NO escribe en esta tabla.
-- El control de intentos se delega a _apoderado_verificar_pin, que usa
-- la tabla apoderado_intentos (compartida con apoderado_acceso y todos
-- los demás RPCs de apoderado).
--
-- Esta sección se mantiene por idempotencia: si se ejecutó v3 o v4 antes,
-- los REVOKEs y el DROP POLICY siguen siendo necesarios para limpiar el estado.
CREATE TABLE IF NOT EXISTS public.pin_intentos_fallidos (
  cuenta_id       UUID         NOT NULL,
  alumno_id       TEXT         NOT NULL,
  intentos        INT          NOT NULL DEFAULT 0,
  bloqueado_hasta TIMESTAMPTZ,
  ultimo_intento  TIMESTAMPTZ,
  PRIMARY KEY (cuenta_id, alumno_id)
);

-- RLS habilitado para que los roles cliente NO accedan directamente.
ALTER TABLE public.pin_intentos_fallidos ENABLE ROW LEVEL SECURITY;

-- [FIX-B1] Eliminar cualquier política permisiva que hubiera en v3.
DROP POLICY IF EXISTS "pin_intentos_svc" ON public.pin_intentos_fallidos;

-- [FIX-B1] Revocar acceso directo a anon y authenticated.
REVOKE ALL ON TABLE public.pin_intentos_fallidos FROM anon;
REVOKE ALL ON TABLE public.pin_intentos_fallidos FROM authenticated;

COMMENT ON TABLE public.pin_intentos_fallidos IS
  'Tabla legacy (v3/v4). En v5, apoderado_abrir_comprobante usa apoderado_intentos '
  'a través de _apoderado_verificar_pin. Esta tabla ya no recibe escrituras nuevas. '
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


-- ── PARTE 4: RPC apoderado_abrir_comprobante (v5 — solo validación, sin firma) ─
--
-- Esta función VALIDA el acceso del apoderado y devuelve el storagePath.
-- La firma real de la URL la hace la Edge Function `apoderado-comprobante`
-- (ver supabase/functions/apoderado-comprobante/index.ts).
--
-- [FIX-C4] Control de intentos unificado:
--   Delega a _apoderado_verificar_pin (06_rpcs_apoderado.sql), que escribe en
--   apoderado_intentos — la misma tabla que apoderado_acceso, apoderado_ver_pagos
--   y todos los demás RPCs de apoderado. Alternar entre este endpoint y los demás
--   NO elude el límite de 5 intentos.
--
-- [FIX-C3] starts_with() en lugar de LIKE:
--   LIKE interpreta % y _ como comodines; curso_id y p_mov_id son TEXT y podrían
--   contener esos caracteres. starts_with() es comparación literal.
--
-- Flujo:
--   1. _apoderado_verificar_pin: rechaza PIN nulo, verifica bloqueo, bcrypt, incrementa.
--   2. Distingue alumno_inactivo vs curso_inactivo (error granular).
--   3. Obtiene curso_id del alumno (ya validado activo por step 1).
--   4. Verifica movimiento visible=TRUE del curso del alumno.
--   5. Extrae storagePath desde comprobante o archivos[0].storagePath.
--   6. Valida prefijo con starts_with (sin comodines).
--   7. Devuelve {ok:true, storage_path:"..."}.
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
  v_pin_result    TEXT;
  v_alumno_estado TEXT;
  v_curso_id      TEXT;
  v_archivos      JSONB;
  v_comprobante   TEXT;
  v_path          TEXT;
  v_prefix        TEXT;
BEGIN

  -- ── 1. Validar PIN + control unificado de intentos ─────────────────────────
  -- [FIX-C4] Delega a _apoderado_verificar_pin (06_rpcs_apoderado.sql).
  -- Escribe en apoderado_intentos — MISMA tabla que apoderado_acceso, etc.
  -- No hay contador independiente: alternar endpoints no elude el límite.
  v_pin_result := _apoderado_verificar_pin(p_cuenta_id, p_alumno_id, p_pin);

  CASE v_pin_result
    WHEN 'ok' THEN
      NULL;  -- continuar

    WHEN 'pin_requerido' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'pin_requerido');

    WHEN 'bloqueado' THEN
      RETURN jsonb_build_object(
        'ok',      false,
        'error',   'cuenta_bloqueada',
        'detalle', 'Demasiados intentos fallidos. Vuelve a intentarlo en unos minutos.'
      );

    WHEN 'sin_credencial' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'alumno_sin_pin');

    WHEN 'pin_incorrecto' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'pin_incorrecto');

    WHEN 'alumno_inactivo' THEN
      -- _apoderado_verificar_pin retorna 'alumno_inactivo' para AMBOS casos:
      -- alumno inactivo y curso inactivo.  Distinguir para el código preciso.
      SELECT a.estado, a.curso_id INTO v_alumno_estado, v_curso_id
      FROM   public.alumnos a
      WHERE  a.cuenta_id = p_cuenta_id AND a.id = p_alumno_id;

      IF NOT FOUND OR v_alumno_estado IS DISTINCT FROM 'activo' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'alumno_inactivo');
      END IF;
      -- Alumno activo pero curso inactivo
      RETURN jsonb_build_object('ok', false, 'error', 'curso_inactivo');

    ELSE
      -- Código desconocido devuelto por _apoderado_verificar_pin (ej: futuro)
      RETURN jsonb_build_object('ok', false, 'error', v_pin_result);
  END CASE;

  -- ── 2. Obtener curso_id del alumno ────────────────────────────────────────
  -- Alumno y curso ya validados activos por _apoderado_verificar_pin.
  SELECT a.curso_id INTO v_curso_id
  FROM   public.alumnos a
  WHERE  a.cuenta_id = p_cuenta_id AND a.id = p_alumno_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'alumno_no_encontrado');
  END IF;

  -- ── 3. Verificar movimiento: visible=TRUE, del curso del alumno ───────────
  SELECT archivos, comprobante INTO v_archivos, v_comprobante
  FROM   public.movimientos
  WHERE  cuenta_id = p_cuenta_id
    AND  id        = p_mov_id
    AND  curso_id  = v_curso_id
    AND  visible   = TRUE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'movimiento_no_accesible');
  END IF;

  -- ── 4. Extraer storagePath ────────────────────────────────────────────────
  v_path := v_comprobante;
  IF v_path IS NULL OR v_path = ''
     OR starts_with(v_path, 'https://')
     OR starts_with(v_path, 'data:')
  THEN
    IF jsonb_array_length(COALESCE(v_archivos, '[]'::jsonb)) > 0 THEN
      v_path := v_archivos->0->>'storagePath';
    END IF;
  END IF;

  IF v_path IS NULL OR v_path = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sin_comprobante');
  END IF;

  -- ── 5. Validar prefijo con starts_with (sin LIKE — evita comodines) ───────
  -- [FIX-C3] LIKE interpreta % y _ como comodines en el patrón.
  -- curso_id y p_mov_id son TEXT; podrían contener esos caracteres.
  -- starts_with() hace comparación literal, sin interpretación de comodines.
  v_prefix := p_cuenta_id::text || '/' || v_curso_id || '/' || p_mov_id || '/';
  IF NOT starts_with(v_path, v_prefix) THEN
    RETURN jsonb_build_object(
      'ok',      false,
      'error',   'ruta_invalida',
      'detalle', 'storagePath no corresponde a esta cuenta/curso/movimiento.'
    );
  END IF;

  -- ── 6. Devolver storagePath validado (la firma la hace la Edge Function) ──
  RETURN jsonb_build_object('ok', true, 'storage_path', v_path);
END;
$$;

COMMENT ON FUNCTION public.apoderado_abrir_comprobante(UUID, TEXT, TEXT, TEXT) IS
  'Valida acceso del apoderado y devuelve storage_path (NO firma). '
  'v5: delega PIN+intentos a _apoderado_verificar_pin (apoderado_intentos, '
  'misma tabla que todos los RPCs de apoderado). starts_with() en lugar de LIKE. '
  'Verificaciones: PIN, bloqueo 5 intentos/15 min, alumno activo, curso activo, '
  'movimiento visible=TRUE, ruta {cuenta}/{curso}/{mov}/. '
  'La URL firmada la genera la Edge Function apoderado-comprobante. '
  'verify_jwt=false en supabase/config.toml. Sin Vault. Sin pgjwt. Sin pg_net.';

REVOKE ALL    ON FUNCTION public.apoderado_abrir_comprobante(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.apoderado_abrir_comprobante(UUID, TEXT, TEXT, TEXT) TO anon;
GRANT  EXECUTE ON FUNCTION public.apoderado_abrir_comprobante(UUID, TEXT, TEXT, TEXT) TO authenticated;
-- [FIX-C2] La Edge Function invoca la RPC con service_role.
-- Conceder EXECUTE explícito sin depender de privilegios de superusuario heredados.
GRANT  EXECUTE ON FUNCTION public.apoderado_abrir_comprobante(UUID, TEXT, TEXT, TEXT) TO service_role;


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

-- 5e. Funciones — verificar grants incluyendo service_role
SELECT
  p.proname AS funcion,
  p.pronargs AS n_params,
  array_to_string(p.proconfig, ', ') AS search_path,
  CASE WHEN has_function_privilege('authenticated', p.oid, 'EXECUTE')
       THEN 'authenticated ✓' ELSE 'SIN GRANT ⚠' END AS grant_auth,
  CASE WHEN p.proname = 'apoderado_abrir_comprobante'
        AND has_function_privilege('anon', p.oid, 'EXECUTE')
       THEN 'anon ✓'
       WHEN p.proname = 'apoderado_abrir_comprobante'
       THEN 'SIN GRANT anon ⚠' ELSE '(no aplica)' END AS grant_anon,
  -- [FIX-C2] La Edge Function usa service_role; debe tener EXECUTE.
  CASE WHEN p.proname = 'apoderado_abrir_comprobante'
        AND has_function_privilege('service_role', p.oid, 'EXECUTE')
       THEN 'service_role ✓'
       WHEN p.proname = 'apoderado_abrir_comprobante'
       THEN 'SIN GRANT service_role ⚠' ELSE '(no aplica)' END AS grant_service_role
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('_tiene_acceso_a_mov_storage', 'apoderado_abrir_comprobante')
ORDER BY p.proname;

-- 5f. Verificar que el contador de intentos de apoderado_abrir_comprobante
-- es el mismo que usan apoderado_acceso y los demás RPCs: apoderado_intentos.
-- (pin_intentos_fallidos ya no recibe escrituras nuevas desde v5.)
SELECT
  relname AS tabla,
  'existe ✓' AS estado
FROM pg_class
WHERE relname IN ('apoderado_intentos', 'pin_intentos_fallidos')
  AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
ORDER BY relname;

-- 5g. Smoke test: función devuelve error reconocible con alumno/PIN inexistente
-- (safe: nunca devuelve datos reales)
SELECT public.apoderado_abrir_comprobante(
  '00000000-0000-0000-0000-000000000000'::UUID,
  'alumno-inexistente',
  'pin-de-prueba',
  'mov-inexistente'
) AS respuesta_esperada;
-- Esperado: {"ok": false, "error": "alumno_inactivo"}  (via _apoderado_verificar_pin)
-- o {"ok": false, "error": "sin_credencial"} si no encuentra el alumno en las tablas.
