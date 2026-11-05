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
--   • Idempotencia estricta: el reintento DEBE enviar el mismo
--     contenido esencial (alumno_id, cuota_id, monto, periodo).
--     Si difiere, el RPC lanza error 23505 para detectar uso
--     indebido de la clave o payload corrupto.
--   • Autorización por curso: el tesorero debe tener acceso
--     explícito al curso de la cuota (usuarios_cuenta.curso_id).
--     NULL en curso_id = todos los cursos de la cuenta (admin).
--   • Integridad de identidad: una idempotency_key solo puede
--     recuperar datos de la misma cuenta. Cross-cuenta → error.
--   • Propiedad de alumno/cuota dentro de la cuenta verificada.
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
--   PostgreSQL requiere repetir la cláusula WHERE en el ON CONFLICT.
--
-- NOTA sobre reintento con pago editado/eliminado:
--   Si la fila fue ELIMINADA después de insertarse, el conflicto no
--   se activa y se inserta de nuevo (nuevo comportamiento seguro).
--   El cliente puede detectar el cambio comparando IDs entre reintentos.
--   Si la fila fue EDITADA, el RPC detecta discrepancia de contenido
--   y lanza error 23505 — el cliente debe recargar antes de reintentar.
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
  v_curso_id     TEXT;
  v_idem_key     TEXT;
  v_caller_uid   UUID;
  v_es_admin     BOOLEAN;
  v_periodo_in   TEXT;
BEGIN
  -- ── 1. Capturar identidad del llamante ────────────────────────────────────
  v_caller_uid := auth.uid();

  -- ── 2. Verificar autorización a nivel de cuenta ───────────────────────────
  -- El llamante debe ser dueño de la cuenta O tener rol tesorero/admin.
  -- La verificación de alcance por curso se hace pago a pago (paso 3c).
  v_es_admin := es_dueno(p_cuenta_id)
    OR EXISTS (
      SELECT 1 FROM usuarios_cuenta uc
       WHERE uc.cuenta_id   = p_cuenta_id
         AND uc.auth_id     = v_caller_uid
         AND uc.rol         IN ('admin')
         AND uc.desactivado IS DISTINCT FROM TRUE
    );

  IF NOT v_es_admin THEN
    -- Verificar al menos que tiene rol tesorero en algún curso de esta cuenta
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
    v_alumno_id := v_item->>'alumno_id';
    v_cuota_id  := v_item->>'cuota_id';
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

    IF v_curso_id IS NULL THEN
      RAISE EXCEPTION 'insertar_pagos_lote: cuota_id=% no pertenece a la cuenta', v_cuota_id
        USING ERRCODE = '42501';
    END IF;

    -- ── 3c. Verificación de alcance por curso ────────────────────────────────
    -- El tesorero puede operar solo en los cursos asignados (usuarios_cuenta.curso_id).
    -- NULL en curso_id = todos los cursos (admin/dueno).
    IF NOT v_es_admin THEN
      IF NOT EXISTS (
        SELECT 1 FROM usuarios_cuenta uc
         WHERE uc.cuenta_id   = p_cuenta_id
           AND uc.auth_id     = v_caller_uid
           AND uc.rol         IN ('tesorero', 'admin')
           AND uc.desactivado IS DISTINCT FROM TRUE
           AND (uc.curso_id IS NULL OR uc.curso_id = v_curso_id)
      ) THEN
        RAISE EXCEPTION
          'insertar_pagos_lote: el tesorero no tiene acceso al curso=% de esta cuota',
          v_curso_id
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

    -- Generar id si no viene
    v_id := COALESCE(
      NULLIF(TRIM(v_item->>'id'), ''),
      'p-' || EXTRACT(EPOCH FROM NOW())::BIGINT::TEXT || '-' || SUBSTR(gen_random_uuid()::TEXT, 1, 8)
    );

    -- Idempotency key (puede ser NULL: en ese caso no hay protección de idempotencia)
    v_idem_key := NULLIF(TRIM(v_item->>'idempotency_key'), '');

    IF v_idem_key IS NOT NULL THEN
      -- ── Camino con idempotencia ───────────────────────────────────────────
      -- ON CONFLICT repite la condición del índice parcial (WHERE idempotency_key IS NOT NULL).
      -- DO UPDATE con WHERE cuenta_id garantiza aislamiento cross-cuenta.
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
        v_periodo_in,
        NULLIF(v_item->>'obs', ''),
        NULLIF(v_item->>'creado_por', ''),
        v_idem_key
      )
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE
        -- No modificamos campos de negocio.
        -- SET disparará RETURNING con la fila actual (para verificación posterior).
        -- WHERE garantiza aislamiento: una key de otra cuenta no afecta esta.
        SET idempotency_key = EXCLUDED.idempotency_key
        WHERE pagos.cuenta_id = EXCLUDED.cuenta_id
      RETURNING * INTO v_fila;

      -- ── Verificar aislamiento cross-cuenta ───────────────────────────────
      IF v_fila IS NULL THEN
        RAISE EXCEPTION
          'insertar_pagos_lote: idempotency_key=% ya existe en otra cuenta; operación rechazada',
          v_idem_key
          USING ERRCODE = '23505';
      END IF;

      -- ── Verificar identidad de contenido ────────────────────────────────
      -- En un reintento legítimo, el payload debe ser idéntico al original.
      -- Si difiere, puede ser: (a) payload corrupto, (b) reutilización indebida de key,
      -- (c) el pago fue editado tras la primera inserción.
      -- En cualquier caso, rechazar — el cliente debe recargar antes de reintentar.
      IF v_fila.alumno_id  != v_alumno_id
         OR v_fila.cuota_id   != v_cuota_id
         OR v_fila.monto       != v_monto
         OR COALESCE(v_fila.periodo, '') != COALESCE(v_periodo_in, '')
      THEN
        RAISE EXCEPTION
          'insertar_pagos_lote: idempotency_key=% ya existe con contenido distinto '
          '(alumno/cuota/monto/periodo difieren). '
          'Si el pago fue editado, recarga la página antes de reintentar.',
          v_idem_key
          USING ERRCODE = '23505';
      END IF;

    ELSE
      -- ── Camino sin idempotencia: INSERT directo ───────────────────────────
      -- Permite dos pagos legítimos iguales (ej: una segunda cuota parcial)
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
        COALESCE(NULLIF(v_item->>'fecha', ''), CURRENT_DATE::TEXT)::DATE,
        COALESCE(NULLIF(v_item->>'medio', ''), 'efectivo'),
        COALESCE(NULLIF(v_item->>'estado', ''), 'pagado'),
        v_periodo_in,
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
