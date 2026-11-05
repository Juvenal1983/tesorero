-- ============================================================
-- Migración M004: tabla operaciones_pagos (identidad durable)
--
-- PROBLEMA RESUELTO:
--   En M001 la idempotencia se apoya en pagos.idempotency_key.
--   Si el pago se elimina después de insertarse, ON CONFLICT no
--   se activa y un reintento con la misma clave recrea el pago,
--   deshaciendo la eliminación legítima.
--
-- SOLUCIÓN:
--   tabla operaciones_pagos — un registro por operación de registro,
--   independiente de la fila en pagos.
--   • Al insertar un pago con idempotency_key: se crea registro en
--     operaciones_pagos (si no existe ya).
--   • En un reintento: se encuentra el registro de operación, se
--     verifica la identidad de contenido y autor, y se comprueba si
--     el pago referenciado (pago_id) todavía existe.
--     – Si sí existe: se retorna como éxito idempotente.
--     – Si fue eliminado: se rechaza con error explícito.
--       Un reintento antiguo NO puede deshacer una eliminación legítima.
--
-- CAMPOS DE IDENTIDAD DE OPERACIÓN (contenido completo):
--   alumno_id, cuota_id, monto, periodo, fecha, medio, estado
--   El observador (obs) y creado_por son anotaciones que pueden
--   cambiar; no forman parte de la identidad de la transacción.
--
-- CAMPO auth_id (identidad de autor):
--   Captura auth.uid() en el momento de la operación.
--   Un reintento de otra sesión/usuario con la misma clave es
--   rechazado — la clave es personal a la operación original.
--
-- Pre-condición: ejecutar SOLO en staging (rucgmytyxpfowznowxwd).
-- NUNCA ejecutar en producción (tmjqzaakzhecbldebyeg).
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS operaciones_pagos (
  -- Llave primaria compuesta: (cuenta, clave_operacion)
  cuenta_id       UUID        NOT NULL REFERENCES tesorero_cuentas(id) ON DELETE CASCADE,
  idempotency_key TEXT        NOT NULL,

  -- Identidad del autor — quién originó la operación
  auth_id         UUID        NOT NULL,

  -- Contenido esencial de la operación (identidad de transacción)
  alumno_id       TEXT        NOT NULL,
  cuota_id        TEXT        NOT NULL,
  monto           INT         NOT NULL CHECK (monto > 0),
  periodo         TEXT,
  fecha           DATE        NOT NULL,
  medio           TEXT        NOT NULL,
  estado          TEXT        NOT NULL DEFAULT 'pagado',

  -- Referencia débil al pago creado (NULL si operación fallida antes de insertar)
  -- Sin FK ON DELETE — el registro de operación sobrevive al borrado del pago
  pago_id         TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (cuenta_id, idempotency_key)
);

-- Índice para lookup rápido por pago_id (p.ej. verificar si pago sigue existiendo)
CREATE INDEX IF NOT EXISTS operaciones_pagos_pago_id_idx
  ON operaciones_pagos (cuenta_id, pago_id)
  WHERE pago_id IS NOT NULL;

-- Verificación post-migración
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'operaciones_pagos'
  ) THEN
    RAISE EXCEPTION 'M004: tabla operaciones_pagos no fue creada';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'operaciones_pagos' AND column_name = 'auth_id'
  ) THEN
    RAISE EXCEPTION 'M004: columna auth_id faltante en operaciones_pagos';
  END IF;

  RAISE NOTICE 'M004 verificada: operaciones_pagos creada con identidad de autor ✓';
END;
$$;

COMMIT;
