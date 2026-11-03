-- ============================================================
-- El Tesorero — "El Gran Cambio" v9
-- Archivo: sql/06_rpcs_apoderado.sql
-- Propósito: RPCs SECURITY DEFINER para el flujo privado del apoderado.
--
-- ALCANCE: solo acceso privado (curso.codigo + alumno + PIN).
--   El acceso compartido (codigo_compartido) es un requisito pendiente
--   de diseño separado y NO está cubierto aquí.
--   "Recordar acceso entre sesiones" es un requisito pendiente de
--   solución segura (token firmado, cookie httpOnly u otro mecanismo).
--   Esta entrega solo mantiene el PIN en memoria del tab.
--
-- PRERREQUISITOS:
--   01_schema.sql → 02_rls.sql → 07_grants_supabase.sql
--   pgcrypto disponible (instalado en 01_schema.sql)
--
-- REVOCACIÓN DE ACCESO:
--   El flujo privado usa código-de-curso SOLO para el selector inicial
--   (apoderado_alumnos_curso); una vez que el apoderado obtuvo cuenta_id +
--   alumno_id puede llamar a los RPC restantes directamente, sin pasar por
--   el selector. Por eso cambiar el código NO revoca sesiones activas.
--
--   a) Cambiar cursos.codigo → los nuevos ingresos no encuentran el curso
--      en el selector. Las sesiones que ya tienen cuenta_id+alumno_id+PIN
--      en memoria del navegador siguen activas indefinidamente (incluso si
--      el apoderado recarga la página y reescribe el PIN a mano).
--      NO es un mecanismo de revocación confiable.
--   b) Desactivar curso (cursos.activo=FALSE) → TODOS los RPC (acceso,
--      editar, agregar, situación) verifican vigencia del curso en cada
--      llamada y retornan 'alumno_inactivo' de inmediato.
--      Revocación inmediata. Afecta a TODOS los flujos del curso.
--   c) Eliminar o cambiar pin_hash en alumnos_credenciales → el RPC rechaza
--      el PIN antiguo en la siguiente llamada. Revocación inmediata.
--      Solo afecta al alumno específico.
--   d) Cambiar alumnos.estado a 'inactivo' → el RPC rechaza en la siguiente
--      llamada. Revocación inmediata. Solo afecta al alumno específico.
--
--   RESUMEN: para revocar un alumno específico usar (c) o (d);
--   para revocar un curso completo usar (b).
--
-- CONCURRENCIA EN INTENTOS:
--   El incremento de intentos_fallo es atómico: INSERT ... ON CONFLICT DO UPDATE
--   usa apoderado_intentos.intentos_fallo + 1 (valor actual de la tabla), no una
--   variable pre-calculada en PL/pgSQL. Esto garantiza que dos conexiones
--   simultáneas produzcan intentos_fallo correcto (N+1, N+2) incluso en la
--   primera inserción (cuando no existe fila y FOR UPDATE no puede bloquear nada).
--   SELECT FOR UPDATE antes del INSERT sirve solo para verificar el bloqueo activo
--   y serializar el camino de respuesta cuando la fila ya existe.
--   El contador expira 1 hora después del último fallo: un bloqueo de 15 min
--   se levanta solo; el contador también se reinicia para no acumular fallos
--   de sesiones antiguas indefinidamente.
--
-- PROTECCIÓN CONTRA BLOQUEO PROVOCADO:
--   Limitación: un actor que conozca el alumno_id puede provocar el bloqueo
--   de otra familia con 5 intentos. El alumno_id no es secreto en la respuesta
--   del selector (necesario para identificar al alumno). Mitigación:
--     • El bloqueo dura solo 15 minutos y expira automáticamente.
--     • El tesorero puede reset manual via service_role:
--       DELETE FROM apoderado_intentos WHERE alumno_id='...' AND cuenta_id='...'
--     • La protección por IP pertenece a la capa de aplicación/proxy,
--       no a la capa SQL. Se documenta como pendiente.
-- ============================================================

-- ── Tabla de control de intentos ──────────────────────────────
-- No en 01_schema.sql porque es operacional, no estructura de negocio.
-- Separada del schema de negocio para poder truncar sin afectar datos.
CREATE TABLE IF NOT EXISTS apoderado_intentos (
  cuenta_id       UUID NOT NULL,
  alumno_id       TEXT NOT NULL,
  intentos_fallo  INT          NOT NULL DEFAULT 0,
  ultimo_fallo    TIMESTAMPTZ,
  bloqueado_hasta TIMESTAMPTZ,
  PRIMARY KEY (cuenta_id, alumno_id),
  FOREIGN KEY (cuenta_id, alumno_id)
    REFERENCES alumnos(cuenta_id, id) ON DELETE CASCADE
);

-- Sin acceso desde clientes: solo service_role puede leer/resetear bloqueos.
-- Los RPCs de abajo tienen SECURITY DEFINER y escriben directamente.
REVOKE ALL ON apoderado_intentos FROM PUBLIC, anon, authenticated;
GRANT ALL ON apoderado_intentos TO service_role;

-- RLS habilitado como defensa en profundidad: ninguna política → acceso denegado
-- por defecto para todos los roles que no sean propietario.
-- Las funciones SECURITY DEFINER pasan como propietario y no están sujetas a RLS.
ALTER TABLE apoderado_intentos ENABLE ROW LEVEL SECURITY;


-- ══════════════════════════════════════════════════════════════
-- RPC 1: Selector de alumnos por código de curso (sin PIN)
-- Volatilidad: STABLE (solo lectura, no escribe intentos)
-- Expone: solo alumno_id + nombre. Sin datos financieros ni contactos.
-- ══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION apoderado_alumnos_curso(p_codigo TEXT)
RETURNS TABLE(
  cuenta_id UUID,
  alumno_id TEXT,
  nombre    TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT
    a.cuenta_id,
    a.id        AS alumno_id,
    a.nombre
  FROM alumnos a
  JOIN cursos c
    ON c.cuenta_id = a.cuenta_id
   AND c.id = a.curso_id
  WHERE c.codigo  = p_codigo
    AND c.activo  = TRUE
    AND a.estado  = 'activo'
  ORDER BY a.nombre;
$$;

REVOKE EXECUTE ON FUNCTION apoderado_alumnos_curso(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION apoderado_alumnos_curso(TEXT) TO anon;


-- ══════════════════════════════════════════════════════════════
-- Función auxiliar interna: verificar PIN y estado de bloqueo.
-- Devuelve: 'ok', 'pin_requerido', 'pin_incorrecto', 'bloqueado',
--           'sin_credencial', 'alumno_inactivo'
-- Registra intentos fallidos con FOR UPDATE (serialización concurrente).
-- Volatilidad: VOLATILE (escribe en apoderado_intentos)
-- NO se expone a anon/authenticated: solo la usan los RPCs de este archivo.
-- ══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION _apoderado_verificar_pin(
  p_cuenta_id UUID,
  p_alumno_id TEXT,
  p_pin       TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_hash          TEXT;
  v_bloqueado     TIMESTAMPTZ;
  v_alumno_activo BOOLEAN;
  v_curso_activo  BOOLEAN;
BEGIN
  -- 1. Rechazo explícito de PIN nulo o vacío (antes de llamar a crypt)
  IF p_pin IS NULL OR length(trim(p_pin)) = 0 THEN
    RETURN 'pin_requerido';
  END IF;

  -- 2. Verificar vigencia del alumno y su curso
  SELECT
    (a.estado = 'activo') AS alumno_ok,
    COALESCE(c.activo, FALSE) AS curso_ok
  INTO v_alumno_activo, v_curso_activo
  FROM alumnos a
  LEFT JOIN cursos c ON c.cuenta_id = a.cuenta_id AND c.id = a.curso_id
  WHERE a.cuenta_id = p_cuenta_id AND a.id = p_alumno_id;

  IF NOT FOUND OR NOT v_alumno_activo OR NOT v_curso_activo THEN
    RETURN 'alumno_inactivo';
  END IF;

  -- 3. Verificar bloqueo por intentos (FOR UPDATE serializa concurrencia cuando la fila existe)
  SELECT bloqueado_hasta
  INTO v_bloqueado
  FROM apoderado_intentos
  WHERE cuenta_id = p_cuenta_id AND alumno_id = p_alumno_id
  FOR UPDATE;

  IF FOUND AND v_bloqueado IS NOT NULL AND v_bloqueado > now() THEN
    RETURN 'bloqueado';
  END IF;

  -- 4. Obtener hash del PIN
  SELECT pin_hash INTO v_hash
  FROM alumnos_credenciales
  WHERE cuenta_id = p_cuenta_id AND alumno_id = p_alumno_id;

  IF v_hash IS NULL THEN
    RETURN 'sin_credencial';
  END IF;

  -- 5. Verificar PIN con IS DISTINCT FROM (seguro contra NULL)
  IF crypt(p_pin, v_hash) IS DISTINCT FROM v_hash THEN

    -- Incremento atómico: el ON CONFLICT usa valores actuales de la tabla (no variables
    -- pre-calculadas), lo que garantiza conteo correcto incluso en la primera inserción
    -- cuando dos conexiones concurrentes pasan el SELECT FOR UPDATE sin encontrar fila.
    INSERT INTO apoderado_intentos
      (cuenta_id, alumno_id, intentos_fallo, ultimo_fallo, bloqueado_hasta)
    VALUES (
      p_cuenta_id, p_alumno_id, 1, now(), NULL
    )
    ON CONFLICT (cuenta_id, alumno_id) DO UPDATE SET
      intentos_fallo  = CASE
        WHEN apoderado_intentos.ultimo_fallo IS NULL
          OR apoderado_intentos.ultimo_fallo < now() - interval '1 hour'
        THEN 1
        ELSE apoderado_intentos.intentos_fallo + 1
      END,
      ultimo_fallo    = now(),
      bloqueado_hasta = CASE
        WHEN CASE
               WHEN apoderado_intentos.ultimo_fallo IS NULL
                 OR apoderado_intentos.ultimo_fallo < now() - interval '1 hour'
               THEN 1
               ELSE apoderado_intentos.intentos_fallo + 1
             END >= 5
        THEN now() + interval '15 minutes'
        ELSE apoderado_intentos.bloqueado_hasta
      END;

    RETURN 'pin_incorrecto';
  END IF;

  -- 6. PIN correcto: limpiar intentos
  DELETE FROM apoderado_intentos
  WHERE cuenta_id = p_cuenta_id AND alumno_id = p_alumno_id;

  RETURN 'ok';
END;
$$;

-- Función auxiliar: solo la llaman los RPCs de este archivo (SECURITY DEFINER)
REVOKE EXECUTE ON FUNCTION _apoderado_verificar_pin(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION _apoderado_verificar_pin(UUID, TEXT, TEXT) TO service_role;


-- ══════════════════════════════════════════════════════════════
-- RPC 2: Acceso con PIN — datos del alumno y contactos
-- Volatilidad: VOLATILE (llama a _apoderado_verificar_pin que escribe)
-- Retorna:
--   alumno: {id, nombre, estado, eximido, curso_id}
--     — sin obs (interna), sin cuenta_id
--   apoderados: [{id, nombre, relacion, telefono, email}]
--     — solo los de este alumno; sin estado interno
--   cuotas_estado: [{cuota_id, nombre, monto, tipo, periodo, estado_pago}]
--     — UNA FILA POR PAGO registrado (alumno+cuota+periodo).
--     — Si la cuota tiene pagos en Marzo (pagado) y Abril (pendiente),
--       devuelve dos filas con su estado individual.
--     — Cuotas activas del curso sin ningún pago: una fila con periodo=NULL
--       y estado_pago='pendiente'.
--     — eximido: sobreescribe todos los estados del alumno.
-- ══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION apoderado_acceso(
  p_cuenta_id UUID,
  p_alumno_id TEXT,
  p_pin       TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_result   TEXT;
  v_alumno   JSONB;
  v_apods    JSONB;
  v_cuotas   JSONB;
  v_curso_id TEXT;
BEGIN
  v_result := _apoderado_verificar_pin(p_cuenta_id, p_alumno_id, p_pin);

  IF v_result <> 'ok' THEN
    RETURN jsonb_build_object('error', v_result);
  END IF;

  -- Datos del alumno (sin obs interna, sin cuenta_id)
  SELECT jsonb_build_object(
    'id',       a.id,
    'nombre',   a.nombre,
    'estado',   a.estado,
    'eximido',  a.eximido,
    'curso_id', a.curso_id
  ), a.curso_id
  INTO v_alumno, v_curso_id
  FROM alumnos a
  WHERE a.cuenta_id = p_cuenta_id AND a.id = p_alumno_id;

  -- Apoderados del alumno (sin estado interno)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',       ap.id,
    'nombre',   ap.nombre,
    'relacion', ap.relacion,
    'telefono', ap.telefono,
    'email',    ap.email
  ) ORDER BY ap.nombre), '[]'::jsonb)
  INTO v_apods
  FROM apoderados ap
  WHERE ap.cuenta_id = p_cuenta_id
    AND ap.alumno_id = p_alumno_id
    AND ap.estado = 'activo';

  -- Estado de cuotas activas del curso — granularidad por período.
  --
  -- Cuotas tipo='mensual':
  --   Se generan los períodos esperados según el CALENDARIO de la cuota
  --   (mes_inicio..mes_termino del curso o de la propia cuota) y se hace
  --   LEFT JOIN con pagos.  Un período sin ninguna fila en pagos aparece
  --   como 'pendiente' con pago_id=NULL.  Esto garantiza que un mes que
  --   nunca fue registrado en pagos igual se informa al apoderado.
  --
  -- Cuotas de otro tipo (anual, etc.):
  --   LEFT JOIN directo sobre pagos; sin pago → una fila con periodo=NULL
  --   y estado='pendiente' (comportamiento anterior).
  --
  -- eximido sobreescribe todos los estados.
  WITH
  -- Nombres de mes en español (array 1-based)
  meses(idx, nombre) AS (
    VALUES (0,'Enero'),(1,'Febrero'),(2,'Marzo'),(3,'Abril'),
           (4,'Mayo'),(5,'Junio'),(6,'Julio'),(7,'Agosto'),
           (8,'Septiembre'),(9,'Octubre'),(10,'Noviembre'),(11,'Diciembre')
  ),
  -- Cuotas activas del curso con datos del curso para fallback de calendario
  cuotas_activas AS (
    SELECT
      c.id            AS cuota_id,
      c.nombre        AS cuota_nombre,
      c.monto         AS cuota_monto,
      c.tipo          AS cuota_tipo,
      COALESCE(c.mes_inicio,   cur.mes_inicio_cuota, 0)  AS mes_ini,
      COALESCE(c.mes_termino,  cur.mes_termino_cuota, 11) AS mes_fin,
      COALESCE(c.anio,         cur.anio,
               EXTRACT(YEAR FROM CURRENT_DATE)::int)      AS anio
    FROM cuotas c
    JOIN cursos cur
      ON  cur.cuenta_id = c.cuenta_id
      AND cur.id        = c.curso_id
    WHERE c.cuenta_id = p_cuenta_id
      AND c.curso_id  = v_curso_id
      AND c.activa    = TRUE
  ),
  -- Períodos esperados para cuotas mensuales (uno por mes del calendario)
  periodos_mensuales AS (
    SELECT
      ca.cuota_id,
      ca.cuota_nombre,
      ca.cuota_monto,
      ca.cuota_tipo,
      m.nombre || ' ' || ca.anio AS periodo_esperado
    FROM cuotas_activas ca
    JOIN generate_series(0, 11) AS gs(mes) ON gs.mes BETWEEN ca.mes_ini AND ca.mes_fin
    JOIN meses m ON m.idx = gs.mes
    WHERE ca.cuota_tipo = 'mensual'
  ),
  -- Resultado para cuotas mensuales: LEFT JOIN con pago real
  estado_mensual AS (
    SELECT
      pm.cuota_id,
      pm.cuota_nombre,
      pm.cuota_monto,
      pm.cuota_tipo,
      pm.periodo_esperado  AS periodo,
      p.id                 AS pago_id,
      CASE
        WHEN (SELECT eximido FROM alumnos
              WHERE cuenta_id = p_cuenta_id AND id = p_alumno_id) THEN 'eximido'
        WHEN p.id IS NOT NULL THEN COALESCE(p.estado, 'pendiente')
        ELSE 'pendiente'
      END AS estado_pago
    FROM periodos_mensuales pm
    LEFT JOIN pagos p
      ON  p.cuenta_id = p_cuenta_id
      AND p.cuota_id  = pm.cuota_id
      AND p.alumno_id = p_alumno_id
      AND p.periodo   = pm.periodo_esperado
  ),
  -- Resultado para cuotas no-mensuales: LEFT JOIN directo
  estado_otros AS (
    SELECT
      ca.cuota_id,
      ca.cuota_nombre,
      ca.cuota_monto,
      ca.cuota_tipo,
      p.periodo,
      p.id AS pago_id,
      CASE
        WHEN (SELECT eximido FROM alumnos
              WHERE cuenta_id = p_cuenta_id AND id = p_alumno_id) THEN 'eximido'
        WHEN p.id IS NOT NULL THEN COALESCE(p.estado, 'pendiente')
        ELSE 'pendiente'
      END AS estado_pago
    FROM cuotas_activas ca
    LEFT JOIN pagos p
      ON  p.cuenta_id = p_cuenta_id
      AND p.cuota_id  = ca.cuota_id
      AND p.alumno_id = p_alumno_id
    WHERE ca.cuota_tipo IS DISTINCT FROM 'mensual'
  ),
  -- Unión de ambos resultados
  estado_union AS (
    SELECT * FROM estado_mensual
    UNION ALL
    SELECT * FROM estado_otros
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'cuota_id',   eu.cuota_id,
    'nombre',     eu.cuota_nombre,
    'monto',      eu.cuota_monto,
    'tipo',       eu.cuota_tipo,
    'periodo',    eu.periodo,
    'pago_id',    eu.pago_id,
    'estado_pago', eu.estado_pago
  ) ORDER BY eu.cuota_nombre, eu.periodo NULLS LAST), '[]'::jsonb)
  INTO v_cuotas
  FROM estado_union eu;

  RETURN jsonb_build_object(
    'alumno',        v_alumno,
    'apoderados',    v_apods,
    'cuotas_estado', v_cuotas
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION apoderado_acceso(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION apoderado_acceso(UUID, TEXT, TEXT) TO anon;


-- ══════════════════════════════════════════════════════════════
-- RPC 3: Situación financiera detallada
-- Volatilidad: VOLATILE (llama a _apoderado_verificar_pin)
-- Retorna:
--   pagos: [{id, monto, fecha, medio, estado, periodo, cuota_nombre}]
--     — solo pagos de este alumno; sin obs ni creado_por
--   planes: [{id, periodo, monto_total, activo, abonos_count, monto_abonado,
--             abonos_pagados, monto_pagado, abonos_pendientes, monto_pendiente,
--             abonos: [{id, monto, fecha, estado, pagado}]}]
--     — solo planes de este alumno; con desglose de abonos pagados/pendientes
--   comprobantes: [{id, desc, fecha, monto, tipo, comprobante_url}]
--     — movimientos del curso con visible=TRUE y comprobante publicado
--   balance_curso: {total_ingresos, total_gastos, saldo}
--     — suma de movimientos visibles del curso (autorizado para publicar)
-- ══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION apoderado_situacion_financiera(
  p_cuenta_id UUID,
  p_alumno_id TEXT,
  p_pin       TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_result       TEXT;
  v_pagos        JSONB;
  v_planes       JSONB;
  v_comprobantes JSONB;
  v_balance      JSONB;
  v_curso_id     TEXT;
BEGIN
  v_result := _apoderado_verificar_pin(p_cuenta_id, p_alumno_id, p_pin);

  IF v_result <> 'ok' THEN
    RETURN jsonb_build_object('error', v_result);
  END IF;

  SELECT a.curso_id INTO v_curso_id
  FROM alumnos a WHERE a.cuenta_id = p_cuenta_id AND a.id = p_alumno_id;

  -- Pagos del alumno (sin obs, sin creado_por)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',           p.id,
    'monto',        p.monto,
    'fecha',        p.fecha,
    'medio',        p.medio,
    'estado',       p.estado,
    'periodo',      p.periodo,
    'cuota_nombre', c.nombre
  ) ORDER BY p.fecha DESC), '[]'::jsonb)
  INTO v_pagos
  FROM pagos p
  JOIN cuotas c ON c.cuenta_id = p.cuenta_id AND c.id = p.cuota_id
  WHERE p.cuenta_id = p_cuenta_id
    AND p.alumno_id = p_alumno_id;

  -- Planes de pago del alumno con desglose de abonos pagados/pendientes.
  -- abonos_pagados / monto_pagado: abonos con pagado=TRUE (cobrados).
  -- abonos_pendientes / monto_pendiente: abonos con pagado=FALSE (registrados, pendiente cobro).
  -- abonos: lista completa para que el apoderado vea el cronograma.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',                  pp.id,
    'periodo',             pp.periodo,
    'monto_total',         pp.monto_total,
    'activo',              pp.activo,
    'abonos_count',        (SELECT COUNT(*) FROM abonos ab
                            WHERE ab.cuenta_id = p_cuenta_id AND ab.plan_id = pp.id),
    'monto_abonado',       (SELECT COALESCE(SUM(ab.monto), 0) FROM abonos ab
                            WHERE ab.cuenta_id = p_cuenta_id AND ab.plan_id = pp.id
                              AND ab.pagado = TRUE),
    'abonos_pagados',      (SELECT COUNT(*) FROM abonos ab
                            WHERE ab.cuenta_id = p_cuenta_id AND ab.plan_id = pp.id
                              AND ab.pagado = TRUE),
    'monto_pagado',        (SELECT COALESCE(SUM(ab.monto), 0) FROM abonos ab
                            WHERE ab.cuenta_id = p_cuenta_id AND ab.plan_id = pp.id
                              AND ab.pagado = TRUE),
    'abonos_pendientes',   (SELECT COUNT(*) FROM abonos ab
                            WHERE ab.cuenta_id = p_cuenta_id AND ab.plan_id = pp.id
                              AND ab.pagado = FALSE),
    'monto_pendiente',     (SELECT COALESCE(SUM(ab.monto), 0) FROM abonos ab
                            WHERE ab.cuenta_id = p_cuenta_id AND ab.plan_id = pp.id
                              AND ab.pagado = FALSE),
    'abonos',              (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                              'id',     ab.id,
                              'monto',  ab.monto,
                              'fecha',  ab.fecha,
                              'estado', ab.estado,
                              'pagado', ab.pagado
                            ) ORDER BY ab.fecha), '[]'::jsonb)
                            FROM abonos ab
                            WHERE ab.cuenta_id = p_cuenta_id AND ab.plan_id = pp.id)
  ) ORDER BY pp.creado_en DESC), '[]'::jsonb)
  INTO v_planes
  FROM planes_pago pp
  WHERE pp.cuenta_id = p_cuenta_id
    AND pp.alumno_id = p_alumno_id;

  -- Comprobantes publicados del curso (visible=TRUE y con URL de comprobante).
  -- Son del curso, no exclusivos del alumno: reflejan ingresos/gastos publicados.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',              m.id,
    'desc',            m."desc",
    'fecha',           m.fecha,
    'monto',           m.monto,
    'tipo',            m.tipo,
    'comprobante_url', m.comprobante
  ) ORDER BY m.fecha DESC), '[]'::jsonb)
  INTO v_comprobantes
  FROM movimientos m
  WHERE m.cuenta_id  = p_cuenta_id
    AND m.curso_id   = v_curso_id
    AND m.visible    = TRUE
    AND m.comprobante IS NOT NULL;

  -- Balance del curso: misma lógica que calcFinanzas() del frontend.
  --   total_ingresos = pagos_pagados + abonos_pagados_de_planes_activos + movimientos_tipo_ingreso
  --   total_gastos   = movimientos_tipo_gasto (visible=TRUE)
  --   saldo          = total_ingresos − total_gastos
  -- No se exponen datos individuales de familias: solo totales del curso.
  SELECT jsonb_build_object(
    'total_recaudado_cuotas',
      COALESCE((
        SELECT SUM(p.monto)
        FROM pagos p
        WHERE p.cuenta_id = p_cuenta_id
          AND p.alumno_id IN (
            SELECT a.id FROM alumnos a
            WHERE a.cuenta_id = p_cuenta_id AND a.curso_id = v_curso_id
          )
          AND p.estado = 'pagado'
      ), 0),
    'total_abonos_pagados',
      COALESCE((
        SELECT SUM(ab.monto)
        FROM abonos ab
        JOIN planes_pago pp ON pp.cuenta_id = ab.cuenta_id AND pp.id = ab.plan_id
        WHERE ab.cuenta_id = p_cuenta_id
          AND pp.alumno_id IN (
            SELECT a.id FROM alumnos a
            WHERE a.cuenta_id = p_cuenta_id AND a.curso_id = v_curso_id
          )
          AND ab.pagado = TRUE
          AND pp.activo = TRUE
      ), 0),
    'total_ingresos_extra',
      COALESCE((
        SELECT SUM(m.monto)
        FROM movimientos m
        WHERE m.cuenta_id = p_cuenta_id
          AND m.curso_id  = v_curso_id
          AND m.tipo IN ('ingreso', 'aporte')
          AND m.visible   = TRUE
      ), 0),
    'total_gastos',
      COALESCE((
        SELECT SUM(m.monto)
        FROM movimientos m
        WHERE m.cuenta_id = p_cuenta_id
          AND m.curso_id  = v_curso_id
          AND m.tipo IN ('gasto', 'egreso')
          AND m.visible   = TRUE
      ), 0),
    'total_ingresos',
      COALESCE((
        SELECT SUM(p.monto) FROM pagos p
        WHERE p.cuenta_id = p_cuenta_id
          AND p.alumno_id IN (SELECT a.id FROM alumnos a WHERE a.cuenta_id = p_cuenta_id AND a.curso_id = v_curso_id)
          AND p.estado = 'pagado'
      ), 0)
      + COALESCE((
        SELECT SUM(ab.monto) FROM abonos ab
        JOIN planes_pago pp ON pp.cuenta_id = ab.cuenta_id AND pp.id = ab.plan_id
        WHERE ab.cuenta_id = p_cuenta_id
          AND pp.alumno_id IN (SELECT a.id FROM alumnos a WHERE a.cuenta_id = p_cuenta_id AND a.curso_id = v_curso_id)
          AND ab.pagado = TRUE AND pp.activo = TRUE
      ), 0)
      + COALESCE((
        SELECT SUM(m.monto) FROM movimientos m
        WHERE m.cuenta_id = p_cuenta_id AND m.curso_id = v_curso_id
          AND m.tipo IN ('ingreso', 'aporte') AND m.visible = TRUE
      ), 0),
    'saldo',
      COALESCE((
        SELECT SUM(p.monto) FROM pagos p
        WHERE p.cuenta_id = p_cuenta_id
          AND p.alumno_id IN (SELECT a.id FROM alumnos a WHERE a.cuenta_id = p_cuenta_id AND a.curso_id = v_curso_id)
          AND p.estado = 'pagado'
      ), 0)
      + COALESCE((
        SELECT SUM(ab.monto) FROM abonos ab
        JOIN planes_pago pp ON pp.cuenta_id = ab.cuenta_id AND pp.id = ab.plan_id
        WHERE ab.cuenta_id = p_cuenta_id
          AND pp.alumno_id IN (SELECT a.id FROM alumnos a WHERE a.cuenta_id = p_cuenta_id AND a.curso_id = v_curso_id)
          AND ab.pagado = TRUE AND pp.activo = TRUE
      ), 0)
      + COALESCE((
        SELECT SUM(m.monto) FROM movimientos m
        WHERE m.cuenta_id = p_cuenta_id AND m.curso_id = v_curso_id
          AND m.tipo IN ('ingreso', 'aporte') AND m.visible = TRUE
      ), 0)
      - COALESCE((
        SELECT SUM(m.monto) FROM movimientos m
        WHERE m.cuenta_id = p_cuenta_id AND m.curso_id = v_curso_id
          AND m.tipo IN ('gasto', 'egreso') AND m.visible = TRUE
      ), 0)
  )
  INTO v_balance;

  RETURN jsonb_build_object(
    'pagos',          v_pagos,
    'planes',         v_planes,
    'comprobantes',   v_comprobantes,
    'balance_curso',  v_balance
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION apoderado_situacion_financiera(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION apoderado_situacion_financiera(UUID, TEXT, TEXT) TO anon;


-- ══════════════════════════════════════════════════════════════
-- RPC 4: Editar contacto del apoderado
-- Volatilidad: VOLATILE (escribe en apoderados + llama verificar_pin)
-- Campos editables: nombre, relacion, telefono, email
--   — no permite cambiar alumno_id (sería cambio de titular, requiere tesorero)
-- ══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION apoderado_editar_contacto(
  p_cuenta_id    UUID,
  p_alumno_id    TEXT,
  p_pin          TEXT,
  p_apoderado_id TEXT,
  p_nombre       TEXT    DEFAULT NULL,
  p_relacion     TEXT    DEFAULT NULL,
  p_telefono     TEXT    DEFAULT NULL,
  p_email        TEXT    DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_result TEXT;
  v_owns   BOOLEAN;
BEGIN
  v_result := _apoderado_verificar_pin(p_cuenta_id, p_alumno_id, p_pin);

  IF v_result <> 'ok' THEN
    RETURN jsonb_build_object('error', v_result);
  END IF;

  -- El apoderado debe pertenecer a este alumno en esta cuenta
  SELECT EXISTS(
    SELECT 1 FROM apoderados
    WHERE cuenta_id  = p_cuenta_id
      AND id         = p_apoderado_id
      AND alumno_id  = p_alumno_id
      AND estado     = 'activo'
  ) INTO v_owns;

  IF NOT v_owns THEN
    RETURN jsonb_build_object('error', 'no_autorizado');
  END IF;

  UPDATE apoderados SET
    nombre   = COALESCE(p_nombre,   nombre),
    relacion = COALESCE(p_relacion, relacion),
    telefono = COALESCE(p_telefono, telefono),
    email    = COALESCE(p_email,    email)
  WHERE cuenta_id  = p_cuenta_id
    AND id         = p_apoderado_id
    AND alumno_id  = p_alumno_id;

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION apoderado_editar_contacto(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION apoderado_editar_contacto(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO anon;


-- ══════════════════════════════════════════════════════════════
-- RPC 5: Agregar contacto vinculado al alumno
-- Volatilidad: VOLATILE (INSERT en apoderados)
-- El PIN acredita a la familia (alumno), no a un adulto individual.
-- Un adulto con PIN válido puede agregar otro contacto de la misma familia.
-- No requiere confirmación del tesorero (comportamiento del original).
-- ══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION apoderado_agregar_contacto(
  p_cuenta_id UUID,
  p_alumno_id TEXT,
  p_pin       TEXT,
  p_nombre    TEXT,
  p_relacion  TEXT    DEFAULT NULL,
  p_telefono  TEXT    DEFAULT NULL,
  p_email     TEXT    DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_result    TEXT;
  v_nuevo_id  TEXT;
BEGIN
  v_result := _apoderado_verificar_pin(p_cuenta_id, p_alumno_id, p_pin);

  IF v_result <> 'ok' THEN
    RETURN jsonb_build_object('error', v_result);
  END IF;

  IF p_nombre IS NULL OR length(trim(p_nombre)) = 0 THEN
    RETURN jsonb_build_object('error', 'nombre_requerido');
  END IF;

  -- ID basado en UUID: garantiza unicidad incluso entre conexiones concurrentes.
  -- El prefijo 'apo-' mantiene compatibilidad con el formato textual de la app.
  v_nuevo_id := 'apo-' || gen_random_uuid()::text;

  INSERT INTO apoderados (cuenta_id, id, alumno_id, nombre, relacion, telefono, email, estado)
  VALUES (p_cuenta_id, v_nuevo_id, p_alumno_id, trim(p_nombre), p_relacion, p_telefono, p_email, 'activo');

  RETURN jsonb_build_object('ok', true, 'apoderado_id', v_nuevo_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION apoderado_agregar_contacto(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION apoderado_agregar_contacto(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO anon;


-- ══════════════════════════════════════════════════════════════
-- Nota de permisos en Supabase:
--   Las funciones SECURITY DEFINER ejecutan con los permisos del
--   propietario (postgres/service_role), no del llamador (anon).
--   anon tiene EXECUTE en las 4 funciones públicas y USAGE en schema public.
--   anon NO tiene SELECT directo en ninguna tabla de negocio.
--   apoderado_intentos: solo service_role (el tesorero puede resetear bloqueos
--   desde el dashboard de Supabase o via service_role key, nunca desde el cliente).
-- ══════════════════════════════════════════════════════════════
