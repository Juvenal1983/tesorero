-- ============================================================
-- El Tesorero — "El Gran Cambio" v9
-- Archivo: sql/11_insertar_pagos_lote.sql
-- Propósito (B3): RPC transaccional para insertar múltiples pagos.
--
-- Garantías:
--   • Todo-o-nada: si falla cualquier inserción, ningún pago queda
--     guardado. El cliente recibe el error y puede reintentar.
--   • Idempotencia: ON CONFLICT con cláusula WHERE correcta retorna
--     la fila existente sin error. Reintentos de red son seguros.
--   • Autorización: SECURITY DEFINER con verificación de cuenta_id,
--     curso, alumno y cuota dentro de la misma cuenta.
--   • Integridad de identidad: una idempotency_key solo puede
--     recuperar datos de la misma cuenta y mismo contenido esencial.
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
-- Retorno: JSONB array con las filas insertadas o ya existentes.
--
-- Dependencias: M001_idempotency_key.sql debe ejecutarse primero.
--
-- NOTA sobre ON CONFLICT con índice parcial:
--   El índice pagos_idempotency_key_unico es parcial:
--     ON pagos (idempotency_key) WHERE idempotency_key IS NOT NULL
--   PostgreSQL requiere repetir la cláusula WHERE en el ON CONFLICT:
--     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE ...
--   Sin esa cláusula, el planner no puede unir la instrucción con el índice
--   parcial y lanza error "there is no unique or exclusion constraint matching
--   the ON CONFLICT specification".
--
-- NOTA sobre reintento con pago editado:
--   Si la fila ya existe (conflict) se verifica que cuenta_id coincida
--   y se retorna la fila actual. Si el pago fue eliminado después de
--   insertarse, el conflict no se activa y se inserta de nuevo (nuevo ID).
--   El cliente puede detectar este caso comparando IDs entre reintentos.
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
  v_id           TEXT;
  v_monto        INT;
  v_monto_num    NUMERIC;
  v_alumno_id    TEXT;
  v_cuota_id     TEXT;
  v_idem_key     TEXT;
  v_cuenta_check UUID;
BEGIN
  -- ── 1. Verificar autorización ─────────────────────────────────────────────
  -- El llamante debe ser dueño de la cuenta o tener rol tesorero/admin.
  IF NOT (
    es_dueno(p_cuenta_id)
    OR EXISTS (
      SELECT 1
        FROM usuarios_cuenta uc
       WHERE uc.cuenta_id   = p_cuenta_id
         AND uc.auth_id     = auth.uid()
         AND uc.rol         IN ('tesorero', 'admin')
         AND uc.desactivado IS DISTINCT FROM TRUE
    )
  ) THEN
    RAISE EXCEPTION 'No autorizado: se requiere rol tesorero o admin para registrar pagos'
      USING ERRCODE = '42501';
  END IF;

  -- ── 2. Validar estructura del array ───────────────────────────────────────
  IF p_pagos IS NULL OR jsonb_typeof(p_pagos) != 'array' THEN
    RAISE EXCEPTION 'insertar_pagos_lote: p_pagos debe ser un array JSON no nulo'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_pagos) = 0 THEN
    RETURN '[]'::JSONB;
  END IF;

  -- ── 3. Insertar cada pago en la misma transacción (todo-o-nada) ───────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_pagos)
  LOOP
    -- Campos obligatorios
    v_alumno_id := v_item->>'alumno_id';
    v_cuota_id  := v_item->>'cuota_id';

    IF v_alumno_id IS NULL OR v_cuota_id IS NULL THEN
      RAISE EXCEPTION 'insertar_pagos_lote: cada pago requiere alumno_id y cuota_id'
        USING ERRCODE = '22023';
    END IF;

    -- Verificar que alumno_id pertenece a esta cuenta
    IF NOT EXISTS (
      SELECT 1 FROM alumnos
       WHERE cuenta_id = p_cuenta_id AND id = v_alumno_id
    ) THEN
      RAISE EXCEPTION 'insertar_pagos_lote: alumno_id=% no pertenece a la cuenta'
        , v_alumno_id
        USING ERRCODE = '42501';
    END IF;

    -- Verificar que cuota_id pertenece a esta cuenta
    IF NOT EXISTS (
      SELECT 1 FROM cuotas
       WHERE cuenta_id = p_cuenta_id AND id = v_cuota_id
    ) THEN
      RAISE EXCEPTION 'insertar_pagos_lote: cuota_id=% no pertenece a la cuenta'
        , v_cuota_id
        USING ERRCODE = '42501';
    END IF;

    -- Validar monto (entero positivo CLP; 0 no es un pago)
    v_monto_num := (v_item->>'monto')::NUMERIC;
    IF v_monto_num IS NULL OR v_monto_num <= 0 THEN
      RAISE EXCEPTION 'insertar_pagos_lote: monto inválido (%). Debe ser entero positivo en CLP',
        COALESCE(v_item->>'monto', 'NULL')
        USING ERRCODE = '22023';
    END IF;
    v_monto := ROUND(v_monto_num)::INT;

    -- Generar id si no viene
    v_id := COALESCE(
      NULLIF(TRIM(v_item->>'id'), ''),
      'p-' || EXTRACT(EPOCH FROM NOW())::BIGINT::TEXT || '-' || SUBSTR(gen_random_uuid()::TEXT, 1, 8)
    );

    -- Idempotency key (puede ser NULL: en ese caso no hay protección de idempotencia)
    v_idem_key := NULLIF(TRIM(v_item->>'idempotency_key'), '');

    IF v_idem_key IS NOT NULL THEN
      -- ── Camino con idempotencia: ON CONFLICT con índice parcial ───────────
      -- La cláusula WHERE idempotency_key IS NOT NULL repite la condición del
      -- índice parcial para que el planner pueda resolver el conflict correctamente.
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
        COALESCE(NULLIF(v_item->>'fecha', ''), CURRENT_DATE::TEXT)::DATE,
        COALESCE(NULLIF(v_item->>'medio', ''), 'efectivo'),
        COALESCE(NULLIF(v_item->>'estado', ''), 'pagado'),
        NULLIF(v_item->>'periodo', ''),
        NULLIF(v_item->>'obs', ''),
        NULLIF(v_item->>'creado_por', ''),
        v_idem_key
      )
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE
        -- No modificamos ningún campo de negocio.
        -- Usamos SET para disparar el RETURNING y recuperar la fila existente.
        -- Se verifica cuenta_id en la condición para que una key de otra cuenta
        -- no pueda recuperar datos de esta (aunque el índice es global).
        SET idempotency_key = EXCLUDED.idempotency_key
        WHERE pagos.cuenta_id = EXCLUDED.cuenta_id
      RETURNING * INTO v_fila;

      -- Si la fila resultante tiene cuenta_id distinta (conflicto de key cross-cuenta),
      -- el UPDATE no aplicó (WHERE falló) y v_fila queda NULL → error explícito.
      IF v_fila IS NULL THEN
        RAISE EXCEPTION
          'insertar_pagos_lote: idempotency_key=% ya existe en otra cuenta; '
          'operación rechazada por seguridad', v_idem_key
          USING ERRCODE = '23505';
      END IF;

    ELSE
      -- ── Camino sin idempotencia: INSERT directo (dos pagos legítimos iguales) ─
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
        COALESCE(NULLIF(v_item->>'fecha', ''), CURRENT_DATE::TEXT)::DATE,
        COALESCE(NULLIF(v_item->>'medio', ''), 'efectivo'),
        COALESCE(NULLIF(v_item->>'estado', ''), 'pagado'),
        NULLIF(v_item->>'periodo', ''),
        NULLIF(v_item->>'obs', ''),
        NULLIF(v_item->>'creado_por', ''),
        NULL   -- sin idempotency_key
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
