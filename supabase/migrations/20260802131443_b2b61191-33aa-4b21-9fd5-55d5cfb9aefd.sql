-- =====================================================================
-- ADR 0105 — Packaging Master, Phase 2 (RPC write layer + audit/events)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Event + audit helpers
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.emit_packaging_event(
  p_type text, p_row public.wms_packaging_types
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    INSERT INTO public.business_event_outbox (
      event_type, organization_id, business_id,
      source_doc_type, source_doc_id, payload, idempotency_key, status
    ) VALUES (
      p_type, p_row.organization_id, p_row.business_id,
      'wms_packaging_type', p_row.id,
      jsonb_build_object(
        'packaging_type_id', p_row.id,
        'code', p_row.code,
        'name', p_row.name,
        'packaging_class', p_row.packaging_class,
        'lifecycle_status', p_row.lifecycle_status,
        'row_version', p_row.row_version
      ),
      'wms.packaging_type:' || p_row.id || ':' || p_row.row_version || ':' || p_type,
      'pending'
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'packaging event emission failed: %', SQLERRM;
  END;
END; $$;

REVOKE ALL ON FUNCTION public.emit_packaging_event(text, public.wms_packaging_types) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.emit_packaging_event(text, public.wms_packaging_types) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public._wms_packaging_log(
  p_row public.wms_packaging_types,
  p_event_type text,
  p_from public.wms_packaging_lifecycle DEFAULT NULL,
  p_to public.wms_packaging_lifecycle DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_warehouse_id uuid DEFAULT NULL,
  p_qty_delta numeric DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.wms_packaging_events (
    business_id, packaging_type_id, event_type, from_status, to_status,
    warehouse_id, qty_delta, reason, payload, actor_id
  ) VALUES (
    p_row.business_id, p_row.id, p_event_type, p_from, p_to,
    p_warehouse_id, p_qty_delta, p_reason, COALESCE(p_payload, '{}'::jsonb), auth.uid()
  );
END; $$;

REVOKE ALL ON FUNCTION public._wms_packaging_log(public.wms_packaging_types, text,
  public.wms_packaging_lifecycle, public.wms_packaging_lifecycle, text, uuid, numeric, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._wms_packaging_log(public.wms_packaging_types, text,
  public.wms_packaging_lifecycle, public.wms_packaging_lifecycle, text, uuid, numeric, jsonb)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public._wms_packaging_assert_write(p_business_id uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'WMS_PKG_AUTH: authentication required';
  END IF;
  IF NOT public.user_can_access_business(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'WMS_PKG_FORBIDDEN: business access denied';
  END IF;
  IF NOT public.user_has_module_permission(auth.uid(), p_business_id, 'inventory', 'write') THEN
    RAISE EXCEPTION 'WMS_PKG_FORBIDDEN: inventory:write required';
  END IF;
END; $$;

REVOKE ALL ON FUNCTION public._wms_packaging_assert_write(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._wms_packaging_assert_write(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2) wms_packaging_upsert
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_packaging_upsert(
  p_business_id uuid,
  p_payload jsonb,
  p_id uuid DEFAULT NULL,
  p_row_version integer DEFAULT NULL
) RETURNS public.wms_packaging_types
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row public.wms_packaging_types;
  v_org uuid;
  v_num  jsonb := COALESCE(p_payload, '{}'::jsonb);
BEGIN
  PERFORM public._wms_packaging_assert_write(p_business_id);

  SELECT organization_id INTO v_org FROM public.businesses WHERE id = p_business_id;

  IF p_id IS NULL THEN
    INSERT INTO public.wms_packaging_types (
      organization_id, business_id, code, name, packaging_class, material,
      inner_length_cm, inner_width_cm, inner_height_cm,
      outer_length_cm, outer_width_cm, outer_height_cm,
      max_weight_kg, tare_weight_kg, max_volume_fill_pct, dim_weight_divisor,
      is_returnable, is_stackable, nest_ratio, units_per_layer, layers_per_unit,
      hazmat_class, un_rating, temp_min_c, temp_max_c,
      cost, lifecycle_status, notes, created_by, updated_by
    ) VALUES (
      v_org, p_business_id,
      trim(v_num->>'code'), trim(v_num->>'name'),
      COALESCE((v_num->>'packaging_class')::public.wms_packaging_class, 'carton'),
      NULLIF(trim(COALESCE(v_num->>'material','')), ''),
      (v_num->>'inner_length_cm')::numeric,
      (v_num->>'inner_width_cm')::numeric,
      (v_num->>'inner_height_cm')::numeric,
      NULLIF(v_num->>'outer_length_cm','')::numeric,
      NULLIF(v_num->>'outer_width_cm','')::numeric,
      NULLIF(v_num->>'outer_height_cm','')::numeric,
      COALESCE(NULLIF(v_num->>'max_weight_kg','')::numeric, 30),
      COALESCE(NULLIF(v_num->>'tare_weight_kg','')::numeric, 0),
      COALESCE(NULLIF(v_num->>'max_volume_fill_pct','')::numeric, 85),
      NULLIF(v_num->>'dim_weight_divisor','')::numeric,
      COALESCE((v_num->>'is_returnable')::boolean, false),
      COALESCE((v_num->>'is_stackable')::boolean, true),
      NULLIF(v_num->>'nest_ratio','')::numeric,
      NULLIF(v_num->>'units_per_layer','')::integer,
      NULLIF(v_num->>'layers_per_unit','')::integer,
      NULLIF(trim(COALESCE(v_num->>'hazmat_class','')), ''),
      NULLIF(trim(COALESCE(v_num->>'un_rating','')), ''),
      NULLIF(v_num->>'temp_min_c','')::numeric,
      NULLIF(v_num->>'temp_max_c','')::numeric,
      COALESCE(NULLIF(v_num->>'cost','')::numeric, 0),
      COALESCE((v_num->>'lifecycle_status')::public.wms_packaging_lifecycle, 'active'),
      NULLIF(trim(COALESCE(v_num->>'notes','')), ''),
      auth.uid(), auth.uid()
    ) RETURNING * INTO v_row;

    PERFORM public._wms_packaging_log(v_row, 'created', NULL, v_row.lifecycle_status, NULL, NULL, NULL, v_num);
    PERFORM public.emit_packaging_event('warehouse.packaging.created', v_row);
    RETURN v_row;
  END IF;

  SELECT * INTO v_row FROM public.wms_packaging_types
   WHERE id = p_id AND business_id = p_business_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WMS_PKG_NOT_FOUND: packaging type not found';
  END IF;
  IF p_row_version IS NOT NULL AND p_row_version <> v_row.row_version THEN
    RAISE EXCEPTION 'WMS_PKG_STALE: record changed by another user (v% <> v%)',
      p_row_version, v_row.row_version;
  END IF;

  UPDATE public.wms_packaging_types SET
    code                = COALESCE(NULLIF(trim(COALESCE(v_num->>'code','')), ''), code),
    name                = COALESCE(NULLIF(trim(COALESCE(v_num->>'name','')), ''), name),
    packaging_class     = COALESCE((v_num->>'packaging_class')::public.wms_packaging_class, packaging_class),
    material            = CASE WHEN v_num ? 'material' THEN NULLIF(trim(COALESCE(v_num->>'material','')),'') ELSE material END,
    inner_length_cm     = COALESCE(NULLIF(v_num->>'inner_length_cm','')::numeric, inner_length_cm),
    inner_width_cm      = COALESCE(NULLIF(v_num->>'inner_width_cm','')::numeric, inner_width_cm),
    inner_height_cm     = COALESCE(NULLIF(v_num->>'inner_height_cm','')::numeric, inner_height_cm),
    outer_length_cm     = CASE WHEN v_num ? 'outer_length_cm' THEN NULLIF(v_num->>'outer_length_cm','')::numeric ELSE outer_length_cm END,
    outer_width_cm      = CASE WHEN v_num ? 'outer_width_cm'  THEN NULLIF(v_num->>'outer_width_cm','')::numeric  ELSE outer_width_cm END,
    outer_height_cm     = CASE WHEN v_num ? 'outer_height_cm' THEN NULLIF(v_num->>'outer_height_cm','')::numeric ELSE outer_height_cm END,
    max_weight_kg       = COALESCE(NULLIF(v_num->>'max_weight_kg','')::numeric, max_weight_kg),
    tare_weight_kg      = COALESCE(NULLIF(v_num->>'tare_weight_kg','')::numeric, tare_weight_kg),
    max_volume_fill_pct = COALESCE(NULLIF(v_num->>'max_volume_fill_pct','')::numeric, max_volume_fill_pct),
    dim_weight_divisor  = CASE WHEN v_num ? 'dim_weight_divisor' THEN NULLIF(v_num->>'dim_weight_divisor','')::numeric ELSE dim_weight_divisor END,
    is_returnable       = COALESCE((v_num->>'is_returnable')::boolean, is_returnable),
    is_stackable        = COALESCE((v_num->>'is_stackable')::boolean, is_stackable),
    nest_ratio          = CASE WHEN v_num ? 'nest_ratio' THEN NULLIF(v_num->>'nest_ratio','')::numeric ELSE nest_ratio END,
    units_per_layer     = CASE WHEN v_num ? 'units_per_layer' THEN NULLIF(v_num->>'units_per_layer','')::integer ELSE units_per_layer END,
    layers_per_unit     = CASE WHEN v_num ? 'layers_per_unit' THEN NULLIF(v_num->>'layers_per_unit','')::integer ELSE layers_per_unit END,
    hazmat_class        = CASE WHEN v_num ? 'hazmat_class' THEN NULLIF(trim(COALESCE(v_num->>'hazmat_class','')),'') ELSE hazmat_class END,
    un_rating           = CASE WHEN v_num ? 'un_rating' THEN NULLIF(trim(COALESCE(v_num->>'un_rating','')),'') ELSE un_rating END,
    temp_min_c          = CASE WHEN v_num ? 'temp_min_c' THEN NULLIF(v_num->>'temp_min_c','')::numeric ELSE temp_min_c END,
    temp_max_c          = CASE WHEN v_num ? 'temp_max_c' THEN NULLIF(v_num->>'temp_max_c','')::numeric ELSE temp_max_c END,
    cost                = COALESCE(NULLIF(v_num->>'cost','')::numeric, cost),
    notes               = CASE WHEN v_num ? 'notes' THEN NULLIF(trim(COALESCE(v_num->>'notes','')),'') ELSE notes END,
    updated_by          = auth.uid()
  WHERE id = p_id
  RETURNING * INTO v_row;

  PERFORM public._wms_packaging_log(v_row, 'updated', NULL, NULL, NULL, NULL, NULL, v_num);
  PERFORM public.emit_packaging_event('warehouse.packaging.updated', v_row);
  RETURN v_row;
END; $$;

REVOKE ALL ON FUNCTION public.wms_packaging_upsert(uuid, jsonb, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_packaging_upsert(uuid, jsonb, uuid, integer) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3) wms_packaging_set_lifecycle
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_packaging_set_lifecycle(
  p_id uuid,
  p_status public.wms_packaging_lifecycle,
  p_reason text DEFAULT NULL,
  p_row_version integer DEFAULT NULL
) RETURNS public.wms_packaging_types
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row public.wms_packaging_types;
  v_from public.wms_packaging_lifecycle;
BEGIN
  SELECT * INTO v_row FROM public.wms_packaging_types WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WMS_PKG_NOT_FOUND: packaging type not found'; END IF;
  PERFORM public._wms_packaging_assert_write(v_row.business_id);
  IF p_row_version IS NOT NULL AND p_row_version <> v_row.row_version THEN
    RAISE EXCEPTION 'WMS_PKG_STALE: record changed by another user';
  END IF;

  v_from := v_row.lifecycle_status;
  IF v_from = p_status THEN RETURN v_row; END IF;

  IF p_status = 'retired' AND EXISTS (
    SELECT 1 FROM public.wms_pack_cartons pc
     WHERE pc.packaging_type_id = p_id AND pc.sealed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'WMS_PKG_IN_USE: open cartons still use this packaging';
  END IF;

  UPDATE public.wms_packaging_types
     SET lifecycle_status = p_status, updated_by = auth.uid()
   WHERE id = p_id RETURNING * INTO v_row;

  PERFORM public._wms_packaging_log(v_row, 'lifecycle_changed', v_from, p_status, p_reason);
  PERFORM public.emit_packaging_event('warehouse.packaging.lifecycle_changed', v_row);
  RETURN v_row;
END; $$;

REVOKE ALL ON FUNCTION public.wms_packaging_set_lifecycle(uuid, public.wms_packaging_lifecycle, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_packaging_set_lifecycle(uuid, public.wms_packaging_lifecycle, text, integer) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 4) wms_packaging_archive — hard delete only when never used
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_packaging_archive(
  p_id uuid,
  p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row public.wms_packaging_types;
  v_used integer;
BEGIN
  SELECT * INTO v_row FROM public.wms_packaging_types WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WMS_PKG_NOT_FOUND: packaging type not found'; END IF;
  PERFORM public._wms_packaging_assert_write(v_row.business_id);

  SELECT count(*) INTO v_used FROM public.wms_pack_cartons WHERE packaging_type_id = p_id;

  IF v_used > 0 THEN
    -- Referenced by history: retire instead of destroying the audit trail.
    PERFORM public.wms_packaging_set_lifecycle(p_id, 'retired', COALESCE(p_reason, 'archive requested'));
    RETURN jsonb_build_object('deleted', false, 'retired', true, 'usage_count', v_used);
  END IF;

  PERFORM public._wms_packaging_log(v_row, 'archived', v_row.lifecycle_status, NULL, p_reason);
  PERFORM public.emit_packaging_event('warehouse.packaging.archived', v_row);
  DELETE FROM public.wms_packaging_types WHERE id = p_id;
  RETURN jsonb_build_object('deleted', true, 'retired', false, 'usage_count', 0);
END; $$;

REVOKE ALL ON FUNCTION public.wms_packaging_archive(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_packaging_archive(uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5) Carrier rule + availability writers
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_packaging_set_carrier_rule(
  p_packaging_type_id uuid,
  p_carrier_id uuid,
  p_service_code text DEFAULT NULL,
  p_is_allowed boolean DEFAULT true,
  p_is_oversize boolean DEFAULT false,
  p_surcharge_amount numeric DEFAULT 0,
  p_dim_weight_divisor numeric DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS public.wms_packaging_carriers
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pkg public.wms_packaging_types;
  v_row public.wms_packaging_carriers;
BEGIN
  SELECT * INTO v_pkg FROM public.wms_packaging_types WHERE id = p_packaging_type_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'WMS_PKG_NOT_FOUND: packaging type not found'; END IF;
  PERFORM public._wms_packaging_assert_write(v_pkg.business_id);

  INSERT INTO public.wms_packaging_carriers (
    business_id, packaging_type_id, carrier_id, service_code, is_allowed,
    is_oversize, surcharge_amount, dim_weight_divisor, notes
  ) VALUES (
    v_pkg.business_id, p_packaging_type_id, p_carrier_id, p_service_code,
    COALESCE(p_is_allowed, true), COALESCE(p_is_oversize, false),
    COALESCE(p_surcharge_amount, 0), p_dim_weight_divisor, p_notes
  )
  ON CONFLICT (packaging_type_id, carrier_id, service_code) DO UPDATE
     SET is_allowed = EXCLUDED.is_allowed,
         is_oversize = EXCLUDED.is_oversize,
         surcharge_amount = EXCLUDED.surcharge_amount,
         dim_weight_divisor = EXCLUDED.dim_weight_divisor,
         notes = EXCLUDED.notes,
         updated_at = now()
  RETURNING * INTO v_row;

  PERFORM public._wms_packaging_log(v_pkg, 'carrier_rule_set', NULL, NULL, p_notes, NULL, NULL,
    jsonb_build_object('carrier_id', p_carrier_id, 'service_code', p_service_code,
                       'is_allowed', v_row.is_allowed, 'is_oversize', v_row.is_oversize));
  RETURN v_row;
END; $$;

REVOKE ALL ON FUNCTION public.wms_packaging_set_carrier_rule(uuid, uuid, text, boolean, boolean, numeric, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_packaging_set_carrier_rule(uuid, uuid, text, boolean, boolean, numeric, numeric, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.wms_packaging_set_availability(
  p_packaging_type_id uuid,
  p_warehouse_id uuid,
  p_qty_on_hand numeric DEFAULT NULL,
  p_reorder_point numeric DEFAULT NULL,
  p_is_stocked boolean DEFAULT true
) RETURNS public.wms_packaging_availability
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pkg public.wms_packaging_types;
  v_row public.wms_packaging_availability;
  v_prior numeric;
BEGIN
  SELECT * INTO v_pkg FROM public.wms_packaging_types WHERE id = p_packaging_type_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'WMS_PKG_NOT_FOUND: packaging type not found'; END IF;
  PERFORM public._wms_packaging_assert_write(v_pkg.business_id);

  SELECT qty_on_hand INTO v_prior FROM public.wms_packaging_availability
   WHERE packaging_type_id = p_packaging_type_id AND warehouse_id = p_warehouse_id;

  INSERT INTO public.wms_packaging_availability (
    business_id, warehouse_id, packaging_type_id, is_stocked, qty_on_hand, reorder_point, last_counted_at
  ) VALUES (
    v_pkg.business_id, p_warehouse_id, p_packaging_type_id,
    COALESCE(p_is_stocked, true), COALESCE(p_qty_on_hand, 0), COALESCE(p_reorder_point, 0),
    CASE WHEN p_qty_on_hand IS NOT NULL THEN now() ELSE NULL END
  )
  ON CONFLICT (packaging_type_id, warehouse_id) DO UPDATE
     SET is_stocked = COALESCE(p_is_stocked, public.wms_packaging_availability.is_stocked),
         qty_on_hand = COALESCE(p_qty_on_hand, public.wms_packaging_availability.qty_on_hand),
         reorder_point = COALESCE(p_reorder_point, public.wms_packaging_availability.reorder_point),
         last_counted_at = CASE WHEN p_qty_on_hand IS NOT NULL THEN now()
                                ELSE public.wms_packaging_availability.last_counted_at END,
         updated_at = now()
  RETURNING * INTO v_row;

  PERFORM public._wms_packaging_log(v_pkg, 'availability_set', NULL, NULL, NULL,
    p_warehouse_id, COALESCE(p_qty_on_hand, 0) - COALESCE(v_prior, 0),
    jsonb_build_object('reorder_point', v_row.reorder_point, 'is_stocked', v_row.is_stocked));
  RETURN v_row;
END; $$;

REVOKE ALL ON FUNCTION public.wms_packaging_set_availability(uuid, uuid, numeric, numeric, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_packaging_set_availability(uuid, uuid, numeric, numeric, boolean) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 6) Close the client write path — RPC-only from here on
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS wms_packaging_types_write ON public.wms_packaging_types;
DROP POLICY IF EXISTS wms_packaging_carriers_write ON public.wms_packaging_carriers;
DROP POLICY IF EXISTS wms_packaging_availability_write ON public.wms_packaging_availability;

REVOKE INSERT, UPDATE, DELETE ON public.wms_packaging_types FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.wms_packaging_carriers FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.wms_packaging_availability FROM authenticated;