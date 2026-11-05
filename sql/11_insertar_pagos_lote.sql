-- ============================================================
-- El Tesorero — "El Gran Cambio" v9
-- Archivo: sql/11_insertar_pagos_lote.sql
-- Propósito (B3): RPC transaccional para insertar múltiples pagos.
--
-- Garantías:
--   • Todo-o-nada: si falla cualquier inserción, ningún pago queda
--     guardado. El cliente recibe el error y puede reintentar.
--   • Idempotencia: ON CONFLICT (idempotency_key) DO UPDATE retorna
--     la fila existente sin error. Reintentos de red son seguros.
--   • Autorización: SECURITY DEFINER con verificación de cuenta_id.
--   • NO confundir con atomicidad UI de Promise.allSettled: esta
--     función garantiza atomicidad real en PostgreSQL (una sola TX).
--
-- Parámetros:
--   p_cuenta_id UUID
--   p_pagos     JSONB — array de objetos pago:
--     [{
--       alumno_id:       TEXT,
--       cuota_id:        TEXT,
--       monto:           INT,
--       fecha:           DATE (ISO 8601 string),
--       medio:           TEXT,
--       estado:          TEXT default 'pagado',
--       periodo:         TEXT nullable,
--       obs:             TEXT nullable,
--       creado_por:      TEXT nullable,
--       idempotency_key: TEXT (UUID único por operación)
--     }]
--
-- Retorno: JSONB array con las filas insertadas/existentes.
--
-- Dependencias: M001_idempotency_key.sql debe ejecutarse primero.
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
  v_resultado  JSONB := '[]'::JSONB;
  v_item       JSONB;
  v_fila       pagos%ROWTYPE;
  v_id         TEXT;
  v_monto      INT;
  v_monto_num  NUMERIC;
  v_alumno_id  TEXT;
  v_cuota_id   TEXT;
BEGIN
  -- Verificar que el llamante es dueño de la cuenta o tiene rol adecuado
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

  -- Validar que p_pagos es un array JSON no vacío
  IF p_pagos IS NULL OR jsonb_typeof(p_pagos) != 'array' THEN
    RAISE EXCEPTION 'insertar_pagos_lote: p_pagos debe ser un array JSON no nulo'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_pagos) = 0 THEN
    RETURN '[]'::JSONB;
  END IF;

  -- Insertar cada pago en una sola transacción (todo-o-nada)
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_pagos)
  LOOP
    -- Validar campos obligatorios
    v_alumno_id := v_item->>'alumno_id';
    v_cuota_id  := v_item->>'cuota_id';

    IF v_alumno_id IS NULL OR v_cuota_id IS NULL THEN
      RAISE EXCEPTION 'insertar_pagos_lote: cada pago requiere alumno_id y cuota_id'
        USING ERRCODE = '22023';
    END IF;

    -- Validar monto (debe ser entero positivo en CLP)
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

    -- Insertar con idempotencia:
    --   Si llega el mismo idempotency_key de un reintento de red,
    --   ON CONFLICT retorna la fila existente sin modificarla.
    INSERT INTO pagos (
      cuenta_id,
      id,
      alumno_id,
      cuota_id,
      monto,
      fecha,
      medio,
      estado,
      periodo,
      obs,
      creado_por,
      idempotency_key
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
      NULLIF(v_item->>'idempotency_key', '')
    )
    ON CONFLICT (idempotency_key) DO UPDATE
      -- No modificamos nada; solo forzamos el RETURNING para recuperar la fila existente
      SET idempotency_key = EXCLUDED.idempotency_key
    RETURNING * INTO v_fila;

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
