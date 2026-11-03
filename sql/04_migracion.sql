-- ============================================================
-- El Tesorero — "El Gran Cambio" v8
-- Archivo: sql/04_migracion.sql
-- Cambios v8 (resuelve revisión v7):
--
--   Fix 1: Prevalidación de pagos históricos ambiguos.
--     Antes de insertar, detecta pares de pagos en staging que colisionan
--     en el índice de unicidad (mismo alumno+cuota+COALESCE(periodo,'')+
--     estado=pagado) con IDs distintos. Si existen, detiene la migración
--     con EXCEPTION y lista los IDs y montos conflictivos para conciliación.
--     ON CONFLICT ahora es nombrado: (cuenta_id, id) → solo ignora la PK
--     (re-import idempotente). Ya no silencia colisiones de unicidad de negocio.
--
-- Cambios v6 (resuelve revisión v5):
--
--   Fix 4: PIN ahora se hashea con bcrypt (crypt(pin, gen_salt('bf'))).
--     Nunca se guarda texto plano en pin_hash.
--     Verificación: crypt(input, pin_hash) = pin_hash (desde backend).
--
--   Fix 5: lookup de cuenta_uuid SIEMPRE por origen_auth_id primero.
--     Si el email del JSON cambia después de un import anterior, la cuenta
--     se reconoce por su UUID de origen (estable), no por email (mutable).
--     Fallback a email solo para cuentas genuinamente nuevas (sin conflicto).
--     Si aun así no se encuentra, se lanza EXCEPTION (no WARNING silencioso).
--
-- Cambios v5 (resuelve ALTO 5, ALTO 6, ALTO 7):
--
--   ALTO 5: auth_id de tesorero_cuentas es siempre NULL al migrar.
--     Se guarda el UUID de origen en origen_auth_id para auditoría.
--     El mapeo real se realiza EN 05_mapeo_auth.sql por email, sin
--     condición IS NULL (para que funcione incluso si el UUID de destino
--     ya fue asignado por otro mecanismo previo).
--
--   ALTO 6: planesPago usa formato real del HTML original:
--     {id, alumnoId, cuotaId, periodo, montoTotal,
--      abonos:[{monto, fecha, pagado, fechaPago}], activo, creadoEn}
--     Los abonos se iteran desde plan.abonos (anidado), no desde la raíz.
--     Cada abono recibe id sintético = plan.id || '_ab_' || indice.
--     Se migra: periodo, monto_total, creado_en, activo.
--
--   ALTO 7: fondo_movimientos acepta tipos reales:
--     aporte, rendimiento, actividad, multa (CHECK actualizado en 01_schema.sql).
--     Se migran: nombre, monto_total, monto_individual (JSONB), participantes.
--     El campo 'desc' del formato antiguo se mapea a 'nombre' si existe.
--
--   PIN: migrado a alumnos_credenciales; columna pin eliminada de alumnos.
--
-- ── Semántica de idempotencia ────────────────────────────────────
--   ON CONFLICT DO NOTHING: re-ejecutar es seguro. Sin embargo, esta
--   migración no sobreescribe ediciones posteriores al primer import.
--   Para actualizar registros modificados se necesita una migración
--   incremental separada (fuera del alcance de esta v5).
-- ============================================================

DO $$
DECLARE
  rec            RECORD;
  cuenta_uuid    UUID;
  datos          JSONB;
  item           JSONB;
  abono          JSONB;
  primer_url     TEXT;
  n_cursos       INT;
  curso_key      TEXT;
  abono_idx      INT;
  abono_id       TEXT;
BEGIN
  FOR rec IN
    SELECT td.usuario_id, td.datos
    FROM _staging.tesorero_datos td
  LOOP
    datos := rec.datos;

    -- ── 1. Crear cuenta del tesorero principal ─────────────────
    -- auth_id = NULL: se asignará por email en 05_mapeo_auth.sql.
    -- origen_auth_id = rec.usuario_id: UUID del proyecto de origen.
    INSERT INTO tesorero_cuentas (auth_id, origen_auth_id, email, nombre)
    VALUES (
      NULL,            -- ALTO 5: NO asignar UUID de origen como auth_id
      rec.usuario_id,  -- guardar UUID de origen para diagnóstico
      COALESCE(datos->'usuarios'->0->>'email',
               rec.usuario_id::TEXT || '@sin-email.local'),
      COALESCE(datos->'usuarios'->0->>'nombre', 'Sin nombre')
    )
    ON CONFLICT (origen_auth_id) DO NOTHING;  -- idempotente por origen

    -- Fix 5: obtener cuenta_uuid PRIMERO por origen_auth_id (clave estable de reimportación).
    -- Si el email del JSON cambió después de un import anterior, el UUID de origen
    -- sigue siendo la clave correcta.  Fallback a email solo para cuentas nuevas.
    SELECT id INTO cuenta_uuid
    FROM tesorero_cuentas
    WHERE origen_auth_id = rec.usuario_id;

    IF cuenta_uuid IS NULL THEN
      -- Fallback: cuenta genuinamente nueva (sin conflicto por origen_auth_id).
      SELECT id INTO cuenta_uuid
      FROM tesorero_cuentas
      WHERE LOWER(email) = LOWER(
        COALESCE(datos->'usuarios'->0->>'email',
                 rec.usuario_id::TEXT || '@sin-email.local')
      );
    END IF;

    IF cuenta_uuid IS NULL THEN
      -- Error fatal: la cuenta debió haber sido creada o ya existir.
      -- Nunca omitir silenciosamente; detener para que el operador corrija.
      RAISE EXCEPTION
        'Fix 5 FAIL: No se pudo obtener cuenta_uuid para usuario_id=% (email=%). '
        'Posible corrupción de datos o error de lógica. Abortar migración.',
        rec.usuario_id,
        COALESCE(datos->'usuarios'->0->>'email', '(sin email)');
    END IF;

    -- ── 1b. Suscripción inicial ────────────────────────────────
    INSERT INTO suscripciones (cuenta_id, plan, activo)
    VALUES (cuenta_uuid, 'prueba', true)
    ON CONFLICT DO NOTHING;

    -- ── 2. Colegios ───────────────────────────────────────────
    FOR item IN SELECT * FROM jsonb_array_elements(COALESCE(datos->'colegios', '[]'))
    LOOP
      INSERT INTO colegios (cuenta_id, id, nombre, activo, ciudad)
      VALUES (
        cuenta_uuid,
        item->>'id',
        COALESCE(item->>'nombre', 'Sin nombre'),
        COALESCE((item->>'activo')::BOOLEAN, true),
        item->>'ciudad'
      )
      ON CONFLICT DO NOTHING;
    END LOOP;

    -- ── 3. Cursos ─────────────────────────────────────────────
    FOR item IN SELECT * FROM jsonb_array_elements(COALESCE(datos->'cursos', '[]'))
    LOOP
      INSERT INTO cursos (
        cuenta_id, id, colegio_id, nombre, anio, activo,
        codigo, tesorero, tesorera_id, banco, meta,
        cuota_anual, cuota_mensual, fondo_especial,
        mes_inicio_cuota, mes_termino_cuota, comuna, region
      )
      VALUES (
        cuenta_uuid,
        item->>'id',
        item->>'colegioId',
        COALESCE(item->>'nombre', 'Sin nombre'),
        (item->>'anio')::INT,
        COALESCE((item->>'activo')::BOOLEAN, true),
        item->>'codigo',
        item->>'tesorero',
        item->>'tesoreraId',
        item->'banco',
        COALESCE((item->>'meta')::INT, 0),
        COALESCE((item->>'cuotaAnual')::INT, 0),
        COALESCE((item->>'cuotaMensual')::INT, 0),
        item->'fondoEspecial',
        COALESCE((item->>'mesInicioCuota')::INT, 3),
        COALESCE((item->>'mesTerminoCuota')::INT, 11),
        item->>'comuna',
        item->>'region'
      )
      ON CONFLICT DO NOTHING;
    END LOOP;

    -- ── 4. Alumnos ────────────────────────────────────────────
    -- ALTO 3 fix: PIN va a alumnos_credenciales, no a alumnos.
    FOR item IN SELECT * FROM jsonb_array_elements(COALESCE(datos->'alumnos', '[]'))
    LOOP
      INSERT INTO alumnos (
        cuenta_id, id, curso_id, nombre, nombres, apellidos,
        estado, obs, eximido
      )
      VALUES (
        cuenta_uuid,
        item->>'id',
        item->>'cursoId',
        TRIM(COALESCE(item->>'nombres','') || ' ' || COALESCE(item->>'apellidos','')),
        item->>'nombres',
        item->>'apellidos',
        COALESCE(item->>'estado', 'activo'),
        item->>'obs',
        COALESCE((item->>'eximido')::BOOLEAN, false)
      )
      ON CONFLICT DO NOTHING;

      -- Fix 4: PIN hasheado con bcrypt antes de escribir en alumnos_credenciales.
      -- Nunca se guarda texto plano. Verificación desde backend:
      --   crypt(pin_ingresado, pin_hash) = pin_hash
      IF item->>'pin' IS NOT NULL AND item->>'pin' <> '' THEN
        INSERT INTO alumnos_credenciales (cuenta_id, alumno_id, pin_hash)
        VALUES (cuenta_uuid, item->>'id', crypt(item->>'pin', gen_salt('bf')))
        ON CONFLICT DO NOTHING;
      END IF;
    END LOOP;

    -- ── 5. Apoderados ─────────────────────────────────────────
    FOR item IN SELECT * FROM jsonb_array_elements(COALESCE(datos->'apoderados', '[]'))
    LOOP
      INSERT INTO apoderados (
        cuenta_id, id, alumno_id, nombre, relacion, estado, telefono, email
      )
      VALUES (
        cuenta_uuid,
        item->>'id',
        item->>'alumnoId',
        COALESCE(item->>'nombre', 'Sin nombre'),
        item->>'relacion',
        COALESCE(item->>'estado', 'activo'),
        item->>'telefono',
        item->>'email'
      )
      ON CONFLICT DO NOTHING;
    END LOOP;

    -- ── 6. Cuotas ─────────────────────────────────────────────
    FOR item IN SELECT * FROM jsonb_array_elements(COALESCE(datos->'cuotas', '[]'))
    LOOP
      INSERT INTO cuotas (
        cuenta_id, id, curso_id, nombre, monto, tipo, anio,
        activa, mes_inicio, mes_termino, obs
      )
      VALUES (
        cuenta_uuid,
        item->>'id',
        item->>'cursoId',
        COALESCE(item->>'nombre', 'Sin nombre'),
        COALESCE((item->>'monto')::INT, 0),
        item->>'tipo',
        (item->>'anio')::INT,
        COALESCE((item->>'activa')::BOOLEAN, true),
        (item->>'mesInicio')::INT,
        (item->>'mesTermino')::INT,
        item->>'obs'
      )
      ON CONFLICT DO NOTHING;
    END LOOP;

    -- ── 7. Pagos ──────────────────────────────────────────────
    -- Fix 1 v8: Prevalidar colisiones de unicidad antes de insertar.
    -- Detecta pares de pagos en staging con IDs distintos pero misma
    -- clave de negocio (alumno+cuota+COALESCE(periodo,'')+estado=pagado).
    -- Si existen, la migración se detiene con EXCEPTION: no se deben
    -- silenciar pérdidas financieras. El operador debe conciliar los
    -- registros ambiguos manualmente antes de volver a importar.
    DECLARE
      v_dup_count INT := 0;
      v_dup_msg   TEXT := '';
      v_dup_row   RECORD;
    BEGIN
      FOR v_dup_row IN
        SELECT
          p1->>'id'       AS id1,
          p2->>'id'       AS id2,
          p1->>'alumnoId' AS alumno_id,
          p1->>'cuotaId'  AS cuota_id,
          COALESCE(p1->>'periodo', '') AS periodo_norm,
          (p1->>'monto')::INT         AS monto1,
          (p2->>'monto')::INT         AS monto2
        FROM jsonb_array_elements(COALESCE(datos->'pagos', '[]')) AS p1
        JOIN jsonb_array_elements(COALESCE(datos->'pagos', '[]')) AS p2
          ON (p1->>'alumnoId') = (p2->>'alumnoId')
         AND (p1->>'cuotaId')  = (p2->>'cuotaId')
         AND COALESCE(p1->>'periodo','') = COALESCE(p2->>'periodo','')
         AND COALESCE(p1->>'estado','')  = 'pagado'
         AND COALESCE(p2->>'estado','')  = 'pagado'
         AND (p1->>'id') < (p2->>'id')   -- evitar par duplicado (a,b) y (b,a)
      LOOP
        v_dup_count := v_dup_count + 1;
        v_dup_msg := v_dup_msg ||
          FORMAT(E'\n  alumno=%s cuota=%s periodo="%s" → id1=%s($%s) id2=%s($%s)',
            v_dup_row.alumno_id, v_dup_row.cuota_id, v_dup_row.periodo_norm,
            v_dup_row.id1, v_dup_row.monto1,
            v_dup_row.id2, v_dup_row.monto2);
      END LOOP;

      IF v_dup_count > 0 THEN
        RAISE EXCEPTION
          'MIGRACIÓN DETENIDA (cuenta %): % par(es) de pagos pagados colisionan '
          'en el índice de unicidad. Concilie los IDs y montos antes de continuar:%',
          cuenta_uuid, v_dup_count, v_dup_msg
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END;

    FOR item IN SELECT * FROM jsonb_array_elements(COALESCE(datos->'pagos', '[]'))
    LOOP
      INSERT INTO pagos (
        cuenta_id, id, alumno_id, cuota_id, monto, fecha,
        medio, estado, periodo, obs, creado_por
      )
      VALUES (
        cuenta_uuid,
        item->>'id',
        item->>'alumnoId',
        item->>'cuotaId',
        COALESCE((item->>'monto')::INT, 0),
        (item->>'fecha')::DATE,
        item->>'medio',
        item->>'estado',
        item->>'periodo',
        item->>'obs',
        item->>'creadoPor'
      )
      -- Fix 1 v8: ON CONFLICT nombrado — solo ignora colisión de PK
      -- (re-import del mismo pago). No silencia la unicidad de negocio.
      ON CONFLICT (cuenta_id, id) DO NOTHING;
    END LOOP;

    -- ── 8. Abonos directos de raíz (si los hay) ───────────────
    -- En formato nuevo los abonos van DENTRO de cada plan.
    -- Esta sección mantiene compatibilidad con datos que tengan
    -- abonos en la raíz (formato simplificado antiguo).
    FOR item IN SELECT * FROM jsonb_array_elements(COALESCE(datos->'abonos', '[]'))
    LOOP
      IF item->>'id' IS NOT NULL THEN
        INSERT INTO abonos (
          cuenta_id, id, alumno_id, cuota_id, plan_id,
          monto, fecha, medio, estado, obs, creado_por
        )
        VALUES (
          cuenta_uuid,
          item->>'id',
          item->>'alumnoId',
          item->>'cuotaId',
          NULL,  -- abono directo, sin plan
          COALESCE((item->>'monto')::INT, 0),
          (item->>'fecha')::DATE,
          item->>'medio',
          COALESCE(item->>'estado', 'registrado'),
          item->>'obs',
          item->>'creadoPor'
        )
        ON CONFLICT DO NOTHING;
      END IF;
    END LOOP;

    -- ── 9. Planes de pago + abonos anidados (formato HTML real) ─
    -- ALTO 6 fix: iterar plan.abonos[], no datos.abonos[].
    -- Estructura real: {id, alumnoId, cuotaId, periodo, montoTotal,
    --                   abonos:[{monto, fecha, pagado, fechaPago}],
    --                   activo, creadoEn}
    FOR item IN SELECT * FROM jsonb_array_elements(COALESCE(datos->'planesPago', '[]'))
    LOOP
      INSERT INTO planes_pago (
        cuenta_id, id, alumno_id, cuota_id,
        periodo, monto_total, activo, creado_en, obs
      )
      VALUES (
        cuenta_uuid,
        item->>'id',
        item->>'alumnoId',
        item->>'cuotaId',
        item->>'periodo',                                -- "Anual 2025" etc.
        COALESCE((item->>'montoTotal')::INT, 0),
        COALESCE((item->>'activo')::BOOLEAN, true),
        (item->>'creadoEn')::DATE,
        item->>'obs'
      )
      ON CONFLICT DO NOTHING;

      -- Iterar los abonos ANIDADOS dentro del plan.
      abono_idx := 0;
      FOR abono IN SELECT * FROM jsonb_array_elements(COALESCE(item->'abonos', '[]'))
      LOOP
        abono_id := item->>'id' || '_ab_' || abono_idx::TEXT;

        INSERT INTO abonos (
          cuenta_id, id, alumno_id, cuota_id, plan_id,
          monto, fecha, pagado, fecha_pago, estado
        )
        VALUES (
          cuenta_uuid,
          abono_id,
          item->>'alumnoId',
          item->>'cuotaId',
          item->>'id',   -- plan_id: vinculado al plan padre
          COALESCE((abono->>'monto')::INT, 0),
          (abono->>'fecha')::DATE,
          COALESCE((abono->>'pagado')::BOOLEAN, false),
          CASE WHEN abono->>'fechaPago' IS NOT NULL
               THEN (abono->>'fechaPago')::DATE
               ELSE NULL END,
          CASE WHEN COALESCE((abono->>'pagado')::BOOLEAN, false)
               THEN 'pagado' ELSE 'pendiente' END
        )
        ON CONFLICT DO NOTHING;

        abono_idx := abono_idx + 1;
      END LOOP;
    END LOOP;

    -- ── 10. Movimientos ───────────────────────────────────────
    FOR item IN SELECT * FROM jsonb_array_elements(COALESCE(datos->'movimientos', '[]'))
    LOOP
      primer_url := NULL;
      IF jsonb_array_length(COALESCE(item->'archivos', '[]')) > 0 THEN
        primer_url := item->'archivos'->0->>'url';
      END IF;

      INSERT INTO movimientos (
        cuenta_id, id, curso_id, tipo, monto, "desc", obs, fecha,
        categoria, visible, comprobante, archivos, creado_por, responsable
      )
      VALUES (
        cuenta_uuid,
        item->>'id',
        item->>'cursoId',
        COALESCE(item->>'tipo', 'ingreso'),
        COALESCE((item->>'monto')::INT, 0),
        item->>'desc',
        item->>'obs',
        (item->>'fecha')::DATE,
        item->>'categoria',
        COALESCE((item->>'visible')::BOOLEAN, true),
        primer_url,
        item->'archivos',
        item->>'creadoPor',
        item->>'responsable'
      )
      ON CONFLICT DO NOTHING;
    END LOOP;

    -- ── 11. Fondo movimientos (formato HTML real) ─────────────
    -- ALTO 7 fix: tipos reales (aporte, rendimiento, actividad, multa).
    -- Campos reales: nombre, montoTotal, montoIndividual, participantes.
    -- 'desc' (formato antiguo) → 'nombre' como fallback.
    FOR item IN SELECT * FROM jsonb_array_elements(COALESCE(datos->'fondoMovimientos', '[]'))
    LOOP
      INSERT INTO fondo_movimientos (
        cuenta_id, id, curso_id, tipo,
        nombre, monto_total, monto_individual, participantes,
        "desc", fecha, obs, creado_por
      )
      VALUES (
        cuenta_uuid,
        item->>'id',
        item->>'cursoId',
        -- Acepta tipos reales; fallback 'aporte' si viene vacío.
        COALESCE(item->>'tipo', 'aporte'),
        -- nombre: campo real del HTML (saveMovFondo usa 'nombre').
        COALESCE(item->>'nombre', item->>'desc'),
        -- montoTotal (formato real) o monto (formato simplificado antiguo).
        COALESCE(
          (item->>'montoTotal')::INT,
          (item->>'monto')::INT,
          0
        ),
        -- montoIndividual: {"alumnoId": monto, ...}
        item->'montoIndividual',
        -- participantes: array de alumnoIds
        item->'participantes',
        -- desc: compatibilidad con formato antiguo
        item->>'desc',
        (item->>'fecha')::DATE,
        item->>'obs',
        item->>'creadoPor'
      )
      ON CONFLICT DO NOTHING;
    END LOOP;

    -- ── 12. Notas ─────────────────────────────────────────────
    -- v5: todas las notas migran como privada=TRUE.
    FOR item IN SELECT * FROM jsonb_array_elements(COALESCE(datos->'notas', '[]'))
    LOOP
      INSERT INTO notas (cuenta_id, id, curso_id, texto, color, fijada, privada, fecha)
      VALUES (
        cuenta_uuid,
        item->>'id',
        item->>'cursoId',
        COALESCE(item->>'texto', ''),
        item->>'color',
        COALESCE((item->>'fijada')::BOOLEAN, false),
        TRUE,  -- privada=TRUE por defecto al migrar
        (item->>'fecha')::TIMESTAMPTZ
      )
      ON CONFLICT DO NOTHING;
    END LOOP;

    -- ── 13. Usuarios con acceso a la cuenta ───────────────────
    -- cursoIds=[] → CONTINUE (sin fila; el dueño accede por auth_id en tesorero_cuentas).
    -- Usuarios con N cursos → N filas, una por curso.
    -- auth_id = NULL: se asigna en 05_mapeo_auth.sql.
    FOR item IN SELECT * FROM jsonb_array_elements(COALESCE(datos->'usuarios', '[]'))
    LOOP
      n_cursos := jsonb_array_length(COALESCE(item->'cursoIds', '[]'));
      IF n_cursos = 0 THEN
        CONTINUE;
      END IF;

      FOR curso_key IN SELECT * FROM jsonb_array_elements_text(item->'cursoIds')
      LOOP
        INSERT INTO usuarios_cuenta (
          cuenta_id, id, auth_id, email, nombre, rol,
          curso_id, desactivado, plan_anual, plan_anual_hasta, fecha_registro
        )
        VALUES (
          cuenta_uuid,
          COALESCE(item->>'id', '') || '_' || curso_key,
          NULL,  -- auth_id se asigna por email en 05_mapeo_auth.sql
          LOWER(TRIM(COALESCE(item->>'email', ''))),
          item->>'nombre',
          COALESCE(item->>'rol', 'visor'),
          curso_key,
          COALESCE((item->>'desactivado')::BOOLEAN, false),
          COALESCE((item->>'planAnual')::BOOLEAN, false),
          (item->>'planAnualHasta')::DATE,
          (item->>'fechaRegistro')::DATE
        )
        ON CONFLICT DO NOTHING;
      END LOOP;
    END LOOP;

    -- ── 14. Códigos de invitación ─────────────────────────────
    FOR item IN SELECT * FROM jsonb_array_elements(
      COALESCE(datos->'config'->'codigosInvitacion', '[]')
    )
    LOOP
      INSERT INTO codigos_invitacion (
        cuenta_id, id, para, codigo, tipo, notas,
        activo, usado, usado_en, usado_por, vence_el
      )
      VALUES (
        cuenta_uuid,
        COALESCE(item->>'codigo', gen_random_uuid()::TEXT),
        item->>'para',
        COALESCE(item->>'codigo', ''),
        item->>'tipo',
        item->>'notas',
        COALESCE((item->>'activo')::BOOLEAN, true),
        COALESCE((item->>'usado')::BOOLEAN, false),
        (item->>'usadoEn')::DATE,
        item->>'usadoPor',
        (item->>'venceEl')::DATE
      )
      ON CONFLICT DO NOTHING;
    END LOOP;

    -- ── 15. Usuarios externos ──────────────────────────────────
    FOR item IN SELECT * FROM jsonb_array_elements(
      COALESCE(datos->'usuariosExternos', '[]')
    )
    LOOP
      INSERT INTO usuarios_externos (
        cuenta_id, id, email, nombre, codigo_usado,
        desactivado, plan_anual, plan_anual_hasta,
        fecha_registro, ultima_actividad
      )
      VALUES (
        cuenta_uuid,
        item->>'id',
        item->>'email',
        item->>'nombre',
        item->>'codigoUsado',
        COALESCE((item->>'desactivado')::BOOLEAN, false),
        COALESCE((item->>'planAnual')::BOOLEAN, false),
        (item->>'planAnualHasta')::DATE,
        (item->>'fechaRegistro')::DATE,
        (item->>'ultimaActividad')::TIMESTAMPTZ
      )
      ON CONFLICT DO NOTHING;
    END LOOP;

    -- ── 16. Config de cuenta ──────────────────────────────────
    INSERT INTO config_cuenta (
      cuenta_id, moneda, tipo_org, app_url, plantilla_pago, categorias
    )
    VALUES (
      cuenta_uuid,
      'CLP',
      datos->'config'->>'tipoOrg',
      datos->'config'->>'appUrl',
      datos->'config'->>'plantillaPago',
      datos->'categorias'
    )
    ON CONFLICT DO NOTHING;

    RAISE NOTICE 'Migrada cuenta para usuario_id: %', rec.usuario_id;
  END LOOP;

  RAISE NOTICE '=== Migración v5 completada ===';
END;
$$;
