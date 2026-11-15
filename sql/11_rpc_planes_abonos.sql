-- sql/11_rpc_planes_abonos.sql
-- RPC para cerrar un plan de pago cuando todos sus abonos están pagados.
-- SECURITY DEFINER porque planes_update (02_rls.sql) solo permite es_dueno.
-- La función valida acceso + que todos los abonos estén pagados antes de cerrar.
--
-- ⚠️ Ejecutar en staging (rucgmytyxpfowznowxwd) solo con aprobación explícita.
--    NO ejecutar en producción (tmjqzaakzhecbldebyeg).

CREATE OR REPLACE FUNCTION cerrar_plan_si_completo(
  p_cuenta_id UUID,
  p_plan_id   UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total   INT;
  v_pagados INT;
  v_cerrado BOOLEAN := FALSE;
BEGIN
  -- Verificar que el plan pertenece a la cuenta del llamante
  IF NOT EXISTS (
    SELECT 1 FROM planes_pago
    WHERE id = p_plan_id AND cuenta_id = p_cuenta_id
  ) THEN
    RAISE EXCEPTION 'plan_not_found';
  END IF;

  -- Verificar acceso: debe ser dueño, admin o tesorero del curso
  IF NOT (
    es_dueno(p_cuenta_id) OR
    EXISTS (
      SELECT 1 FROM planes_pago pp
      WHERE pp.id = p_plan_id
        AND pp.cuenta_id = p_cuenta_id
        AND tiene_rol_en_curso(
              p_cuenta_id,
              _curso_de_cuota(p_cuenta_id, pp.cuota_id),
              ARRAY['admin','tesorero']
            )
    )
  ) THEN
    RAISE EXCEPTION 'permission_denied';
  END IF;

  -- Contar abonos del plan
  SELECT COUNT(*), COUNT(*) FILTER (WHERE pagado = TRUE)
    INTO v_total, v_pagados
    FROM abonos
   WHERE plan_id = p_plan_id AND cuenta_id = p_cuenta_id;

  -- Solo cerrar si TODOS están pagados (y hay al menos uno)
  IF v_total > 0 AND v_total = v_pagados THEN
    UPDATE planes_pago
       SET activo = FALSE
     WHERE id = p_plan_id AND cuenta_id = p_cuenta_id;
    v_cerrado := TRUE;
  END IF;

  RETURN jsonb_build_object(
    'plan_id',   p_plan_id,
    'cerrado',   v_cerrado,
    'total',     v_total,
    'pagados',   v_pagados
  );
END;
$$;

-- Solo usuarios autenticados pueden llamar esta función
REVOKE ALL ON FUNCTION cerrar_plan_si_completo(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cerrar_plan_si_completo(UUID, UUID) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC para reactivar un plan de pago al revertir un abono pagado.
-- SECURITY DEFINER porque planes_update solo permite es_dueno.

CREATE OR REPLACE FUNCTION reabrir_plan_pago(
  p_cuenta_id UUID,
  p_plan_id   UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Verificar acceso
  IF NOT (
    es_dueno(p_cuenta_id) OR
    EXISTS (
      SELECT 1 FROM planes_pago pp
      WHERE pp.id = p_plan_id
        AND pp.cuenta_id = p_cuenta_id
        AND tiene_rol_en_curso(
              p_cuenta_id,
              _curso_de_cuota(p_cuenta_id, pp.cuota_id),
              ARRAY['admin','tesorero']
            )
    )
  ) THEN
    RAISE EXCEPTION 'permission_denied';
  END IF;

  UPDATE planes_pago
     SET activo = TRUE
   WHERE id = p_plan_id AND cuenta_id = p_cuenta_id;

  RETURN jsonb_build_object('plan_id', p_plan_id, 'activo', TRUE);
END;
$$;

REVOKE ALL ON FUNCTION reabrir_plan_pago(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reabrir_plan_pago(UUID, UUID) TO authenticated;
