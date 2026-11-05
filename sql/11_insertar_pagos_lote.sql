-- ============================================================
-- El Tesorero — "El Gran Cambio" v9
-- Archivo: sql/11_insertar_pagos_lote.sql
-- Propósito (B3): RPC transaccional para insertar múltiples pagos.
--
-- Garantías:
--   • Todo-o-nada: si falla cualquier inserción, ningún pago queda
--     guardado. El cliente recibe el error y puede reintentar.
--   • Idempotencia durable: la identidad de la operación se guarda en
--     operaciones_pagos, independiente del pago editable/eliminable.
--     Un reintento antiguo no puede recrear un pago eliminado.
--   • Identidad de contenido completa: el reintento debe enviar los
--     mismos campos esenciales (alumno, cuota, monto, periodo, fecha,
--     medio, estado). Si difiere → error 23505.
--   • Identidad de autor: solo el mismo auth.uid() que originó la
--     operación puede reintentarla. Otra sesión con la misma clave
--     es rechazada → error 42501.
--   • Autorización por curso (ítem 1):
--     – es_dueno() tiene acceso total (bypass de curso).
--     – Rol 'admin' con curso_id IS NOT NULL está acotado como tesorero.
--     – La función tiene_rol_en_curso() (esquema real) maneja la lógica.
--   • Integridad cross-cuenta: una idempotency_key de otra cuenta no
--     puede afectar esta (clave compuesta en operaciones_pagos).
--
-- Parámetros:
--   p_cuenta_id UUID
--   p_pagos     JSONB — array de objetos pago:
--     [{
--       alumno_id:       TEXT,
--       cuota_id:        TEXT,
--       monto:           INT  (> 0, entero CLP),
--       fecha:           DATE (ISO 8601 string),
--       medio:           TEXT,
--       estado:          TEXT default 'pagado',
--       periodo:         TEXT nullable,
--       obs:             TEXT nullable,
--       creado_por:      TEXT nullable,
--       idempotency_key: TEXT (UUID único por operación; nulo = sin idempotencia)
--     }]
--
-- Retorno: JSONB array con las filas de pagos insertadas o ya existentes.
--
-- Dependencias:
--   M001_idempotency_key.sql      — índice parcial en pagos.idempotency_key
--   M004_operaciones_idempotentes.sql — tabla operaciones_pagos
-- ============================================================

BEGIN;

SET search_path = public, extensions;

DROP FUNCTION IF EXISTS insertar_pagos_lote(UUID, JSONB);

CREATE OR REPLACE FUNCTION insertar_pagos_lote(
  p_cuenta_id UUID,
  p_pagos     JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_resultado    JSONB := '[]'::JSONB;
  v_item         JSONB;
  v_fila         pagos%ROWTYPE;
  v_op           operaciones_pagos%ROWTYPE;
  v_id           TEXT;
  v_monto        INT;
  v_monto_num    NUMERIC;
  v_alumno_id    TEXT;
  v_cuota_id     TEXT;
  v_curso_id     TEXT;
  v_idem_key     TEXT;
  v_caller_uid   UUID;
  v_es_dueno     BOOLEAN;
  v_periodo_in   TEXT;
  v_fecha_in     DATE;
  v_medio_in     TEXT;
  v_estado_in    TEXT;
BEGIN
  -- ── 1. Capturar identidad del llamante ────────────────────────────────────
  v_caller_uid := auth.uid();

  -- ── 2. Verificar autorización a nivel de cuenta ───────────────────────────
  -- ÍTEM 1: Solo es_dueno() tiene bypass total de curso.
  -- Rol 'admin' con curso_id IS NOT NULL está acotado como tesorero.
  -- La función tiene_rol_en_curso() del esquema real maneja ambos casos.
  v_es_dueno := es_dueno(p_cuenta_id);

  IF NOT v_es_dueno THEN
    -- Verificar que tiene al menos rol tesorero o admin en algún curso de la cuenta
    -- (tiene_rol_en_curso con curso_id NULL = cualquier curso, en la función real)
    IF NOT EXISTS (
      SELECT 1 FROM usuarios_cuenta uc
       WHERE uc.cuenta_id   = p_cuenta_id
         AND uc.auth_id     = v_caller_uid
         AND uc.rol         IN ('tesorero', 'admin')
         AND uc.desactivado IS DISTINCT FROM TRUE
    ) THEN
      RAISE EXCEPTION 'No autorizado: se requiere rol tesorero o admin en esta cuenta'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- ── 3. Validar estructura del array ───────────────────────────────────────
  IF p_pagos IS NULL OR jsonb_typeof(p_pagos) != 'array' THEN
    RAISE EXCEPTION 'insertar_pagos_lote: p_pagos debe ser un array JSON no nulo'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_pagos) = 0 THEN
    RETURN '[]'::JSONB;
  END IF;

  -- ── 4. Insertar cada pago en la misma transacción (todo-o-nada) ───────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_pagos)
  LOOP
    -- Campos obligatorios
    v_alumno_id  := v_item->>'alumno_id';
    v_cuota_id   := v_item->>'cuota_id';
    v_periodo_in := NULLIF(v_item->>'periodo', '');

    IF v_alumno_id IS NULL OR v_cuota_id IS NULL THEN
      RAISE EXCEPTION 'insertar_pagos_lote: cada pago requiere alumno_id y cuota_id'
        USING ERRCODE = '22023';
    END IF;

    -- Verificar que alumno_id pertenece a esta cuenta
    IF NOT EXISTS (
      SELECT 1 FROM alumnos
       WHERE cuenta_id = p_cuenta_id AND id = v_alumno_id
    ) THEN
      RAISE EXCEPTION 'insertar_pagos_lote: alumno_id=% no pertenece a la cuenta', v_alumno_id
        USING ERRCODE = '42501';
    END IF;

    -- Verificar que cuota_id pertenece a esta cuenta y obtener curso_id
    SELECT cu.curso_id INTO v_curso_id
      FROM cuotas cu
     WHERE cu.cuenta_id = p_cuenta_id AND cu.id = v_cuota_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'insertar_pagos_lote: cuota_id=% no pertenece a la cuenta', v_cuota_id
        USING ERRCODE = '42501';
    END IF;

    -- ── ÍTEM 1: Autorización por curso ───────────────────────────────────────
    -- es_dueno() bypasea la comprobación de curso.
    -- Cualquier otro rol (tesorero O admin) usa tiene_rol_en_curso(), que respeta
    -- curso_id IS NULL (acceso total) o curso_id = v_curso_id (acotado).
    IF NOT v_es_dueno THEN
      IF NOT tiene_rol_en_curso(p_cuenta_id, v_curso_id, ARRAY['tesorero', 'admin']) THEN
        RAISE EXCEPTION
          'insertar_pagos_lote: sin acceso al curso=% de esta cuota (usuario=%)',
          v_curso_id, v_caller_uid
          USING ERRCODE = '42501';
      END IF;
    END IF;

    -- Validar monto (entero positivo CLP; 0 no es un pago)
    v_monto_num := (v_item->>'monto')::NUMERIC;
    IF v_monto_num IS NULL OR v_monto_num <= 0 THEN
      RAISE EXCEPTION 'insertar_pagos_lote: monto inválido (%). Debe ser entero positivo en CLP',
        COALESCE(v_item->>'monto', 'NULL')
        USING ERRCODE = '22023';
    END IF;
    v_monto := ROUND(v_monto_num)::INT;

    -- Normalizar campos de identidad
    v_fecha_in  := COALESCE(NULLIF(v_item->>'fecha', ''), CURRENT_DATE::TEXT)::DATE;
    v_medio_in  := COALESCE(NULLIF(v_item->>'medio', ''), 'efectivo');
    v_estado_in := COALESCE(NULLIF(v_item->>'estado', ''), 'pagado');

    -- Generar id si no viene
    v_id := COALESCE(
      NULLIF(TRIM(v_item->>'id'), ''),
      'p-' || EXTRACT(EPOCH FROM NOW())::BIGINT::TEXT || '-' || SUBSTR(gen_random_uuid()::TEXT, 1, 8)
    );

    -- Idempotency key
    v_idem_key := NULLIF(TRIM(v_item->>'idempotency_key'), '');

    IF v_idem_key IS NOT NULL THEN
      -- ── Camino con idempotencia ───────────────────────────────────────────

      -- ── CONCURRENCIA: Serializar con advisory lock ────────────────────────
      -- Previene race condition donde dos sesiones simultáneas ambas ven NOT
      -- FOUND en operaciones_pagos y ambas intentan INSERT pagos por separado.
      -- pg_advisory_xact_lock bloquea hasta que la transacción anterior con
      -- la misma clave haga COMMIT o ROLLBACK, luego la libera automáticamente.
      -- hashtext() devuelve INTEGER (int4); la firma de dos argumentos es correcta.
      PERFORM pg_advisory_xact_lock(
        hashtext(p_cuenta_id::TEXT),
        hashtext(v_idem_key)
      );

      -- ── ÍTEM 2: Reservar slot de operación ANTES de insertar el pago ─────
      -- INSERT primero con pago_id=NULL (slot vacío).
      -- ON CONFLICT DO NOTHING: si ya existe (reintento), el INSERT es silencioso.
      -- La sesión que gana el advisory lock inserta; las siguientes encuentran
      -- la fila ya completa con pago_id real.
      INSERT INTO operaciones_pagos (
        cuenta_id, idempotency_key, auth_id,
        alumno_id, cuota_id, monto, periodo, fecha, medio, estado,
        pago_id
      )
      VALUES (
        p_cuenta_id, v_idem_key, v_caller_uid,
        v_alumno_id, v_cuota_id, v_monto, v_periodo_in, v_fecha_in, v_medio_in, v_estado_in,
        NULL   -- slot vacío: pago_id se establece después de INSERT pagos
      )
      ON CONFLICT (cuenta_id, idempotency_key) DO NOTHING;

      -- Leer el slot (recién insertado o ya existente) — siempre encuentra fila
      SELECT * INTO v_op
        FROM operaciones_pagos
       WHERE cuenta_id       = p_cuenta_id
         AND idempotency_key = v_idem_key;

      -- ── ÍTEM 1: Verificar identidad de autor ─────────────────────────────
      IF v_op.auth_id IS DISTINCT FROM v_caller_uid THEN
        RAISE EXCEPTION
          'insertar_pagos_lote: idempotency_key=% fue creada por otra sesión; '
          'operación rechazada (identidad de autor no coincide)',
          v_idem_key
          USING ERRCODE = '42501';
      END IF;

      -- ── ÍTEM 3: Verificar identidad de contenido completa ────────────────
      -- Comparar todos los campos esenciales de la transacción.
      -- obs y creado_por son anotaciones y no forman parte de la identidad.
      IF v_op.alumno_id  IS DISTINCT FROM v_alumno_id
      OR v_op.cuota_id   IS DISTINCT FROM v_cuota_id
      OR v_op.monto      IS DISTINCT FROM v_monto
      OR COALESCE(v_op.periodo, '') IS DISTINCT FROM COALESCE(v_periodo_in, '')
      OR v_op.fecha      IS DISTINCT FROM v_fecha_in
      OR v_op.medio      IS DISTINCT FROM v_medio_in
      OR v_op.estado     IS DISTINCT FROM v_estado_in
      THEN
        RAISE EXCEPTION
          'insertar_pagos_lote: idempotency_key=% ya existe con contenido distinto. '
          'Los campos esenciales (alumno/cuota/monto/periodo/fecha/medio/estado) deben '
          'coincidir en un reintento. Si el pago fue editado, recarga antes de reintentar.',
          v_idem_key
          USING ERRCODE = '23505';
      END IF;

      -- ── ÍTEM 2: Verificar si el pago ya fue creado ───────────────────────
      -- Si pago_id IS NOT NULL, el slot ya tiene un pago vinculado.
      IF v_op.pago_id IS NOT NULL THEN
        SELECT * INTO v_fila
          FROM pagos
         WHERE cuenta_id = p_cuenta_id AND id = v_op.pago_id;

        IF NOT FOUND THEN
          RAISE EXCEPTION
            'insertar_pagos_lote: idempotency_key=% corresponde a un pago que fue '
            'eliminado (pago_id=%). Un reintento no puede recrear un pago eliminado. '
            'Si fue un error, crea una nueva operación con nueva clave.',
            v_idem_key, v_op.pago_id
            USING ERRCODE = '23505';
        END IF;

        -- Pago existe: retornar idempotentemente
        v_resultado := v_resultado || to_jsonb(v_fila);
        CONTINUE;
      END IF;

      -- ── pago_id IS NULL: insertar pago y vincular al slot ────────────────
      INSERT INTO pagos (
        cuenta_id, id, alumno_id, cuota_id, monto, fecha, medio,
        estado, periodo, obs, creado_por, idempotency_key
      )
      VALUES (
        p_cuenta_id,
        v_id,
        v_alumno_id,
        v_cuota_id,
        v_monto,
        v_fecha_in,
        v_medio_in,
        v_estado_in,
        v_periodo_in,
        NULLIF(v_item->>'obs', ''),
        NULLIF(v_item->>'creado_por', ''),
        v_idem_key
      )
      RETURNING * INTO v_fila;

      -- Actualizar el slot con el pago_id real.
      -- WHERE pago_id IS NULL: protección extra si dos sesiones llegaran aquí
      -- (en la práctica el advisory lock lo impide; esto es defensa en profundidad).
      UPDATE operaciones_pagos
         SET pago_id = v_fila.id
       WHERE cuenta_id       = p_cuenta_id
         AND idempotency_key = v_idem_key
         AND pago_id         IS NULL;

    ELSE
      -- ── Camino sin idempotencia: INSERT directo ───────────────────────────
      -- Permite dos pagos legítimos iguales (ej: segunda cuota parcial)
      -- sin ninguna protección de duplicados — el operador es responsable.
      INSERT INTO pagos (
        cuenta_id, id, alumno_id, cuota_id, monto, fecha, medio,
        estado, periodo, obs, creado_por, idempotency_key
      )
      VALUES (
        p_cuenta_id,
        v_id,
        v_alumno_id,
        v_cuota_id,
        v_monto,
        v_fecha_in,
        v_medio_in,
        v_estado_in,
        v_periodo_in,
        NULLIF(v_item->>'obs', ''),
        NULLIF(v_item->>'creado_por', ''),
        NULL
      )
      RETURNING * INTO v_fila;
    END IF;

    -- Acumular resultado
    v_resultado := v_resultado || to_jsonb(v_fila);
  END LOOP;

  RETURN v_resultado;
END;
$$;

-- Solo los usuarios autenticados pueden llamar esta función
REVOKE EXECUTE ON FUNCTION insertar_pagos_lote(UUID, JSONB) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION insertar_pagos_lote(UUID, JSONB) TO authenticated;

COMMIT;
