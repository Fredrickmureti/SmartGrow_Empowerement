-- =====================================================================
-- ADR 0105 — Packaging Master, Phase 3b
--   Idempotent packaging assignment at pack + replay whitelist
-- =====================================================================

ALTER TABLE public.wms_pack_cartons
  ADD COLUMN IF NOT EXISTS tare_applied_kg numeric NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.assign_packaging_to_pack(
  p_carton_id uuid,
  p_packaging_type_id uuid
) RETURNS public.wms_pack_cartons
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row  public.wms_pack_cartons;
  v_pkg  public.wms_packaging_types;
  v_tare numeric;
BEGIN
  SELECT * INTO v_row FROM public.wms_pack_cartons WHERE id = p_carton_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WMS_PACK_CARTON_NOT_FOUND: %', p_carton_id;
  END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_row.business_id) THEN
    RAISE EXCEPTION 'WMS_PKG_FORBIDDEN: business access denied';
  END IF;
  IF NOT public.user_has_module_permission(auth.uid(), v_row.business_id, 'inventory', 'write') THEN
    RAISE EXCEPTION 'WMS_PKG_FORBIDDEN: inventory:write required';
  END IF;
  IF v_row.sealed_at IS NOT NULL THEN
    RAISE EXCEPTION 'WMS_PACK_CARTON_SEALED: carton % is sealed', p_carton_id;
  END IF;

  -- Idempotent: same packaging already stamped -> no weight movement.
  IF v_row.packaging_type_id IS NOT DISTINCT FROM p_packaging_type_id THEN
    RETURN v_row;
  END IF;

  SELECT * INTO v_pkg FROM public.wms_packaging_types WHERE id = p_packaging_type_id;
  IF NOT FOUND OR v_pkg.business_id <> v_row.business_id THEN
    RAISE EXCEPTION 'WMS_PKG_NOT_FOUND: packaging type not available for this business';
  END IF;
  IF v_pkg.lifecycle_status NOT IN ('active', 'restricted') THEN
    RAISE EXCEPTION 'WMS_PKG_NOT_USABLE: packaging % is %', v_pkg.code, v_pkg.lifecycle_status;
  END IF;

  v_tare := COALESCE(v_pkg.tare_weight_kg, 0);

  UPDATE public.wms_pack_cartons
     SET packaging_type_id = p_packaging_type_id,
         carton_type_id    = p_packaging_type_id,   -- legacy column kept in step until Phase 8
         length_cm = COALESCE(v_pkg.outer_length_cm, v_pkg.inner_length_cm, length_cm),
         width_cm  = COALESCE(v_pkg.outer_width_cm,  v_pkg.inner_width_cm,  width_cm),
         height_cm = COALESCE(v_pkg.outer_height_cm, v_pkg.inner_height_cm, height_cm),
         -- Remove the previously applied tare before adding the new one.
         weight_kg = CASE
                       WHEN weight_kg IS NULL THEN v_tare
                       ELSE GREATEST(0, weight_kg - COALESCE(tare_applied_kg, 0)) + v_tare
                     END,
         tare_applied_kg = v_tare,
         updated_at = now()
   WHERE id = p_carton_id
   RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE ALL ON FUNCTION public.assign_packaging_to_pack(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_packaging_to_pack(uuid, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- Replay dispatcher — add the packaging-master entries
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_replay_guarded_call(
  p_rpc text,
  p_args jsonb,
  p_client_scan_id text DEFAULT NULL,
  p_device_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_prior     jsonb;
  v_result    jsonb;
  v_business  uuid;
  v_org       uuid;
  v_warehouse uuid;
  v_carton    public.wms_carton_types;
BEGIN
  IF p_rpc IS NULL OR length(p_rpc) = 0 THEN
    RAISE EXCEPTION 'WMS_REPLAY_BAD_RPC: rpc name required';
  END IF;
  p_args := COALESCE(p_args, '{}'::jsonb);

  v_prior := public._wms_client_scan_lookup(p_device_id, p_client_scan_id);
  IF v_prior IS NOT NULL THEN
    RETURN jsonb_build_object('replayed', true, 'rpc', p_rpc, 'result', v_prior);
  END IF;

  CASE p_rpc

    WHEN 'receive_goods_to_wms' THEN
      v_result := public.receive_goods_to_wms(
        (p_args->>'p_goods_receipt_id')::uuid,
        NULLIF(p_args->>'p_staging_location_id','')::uuid
      );

    WHEN 'complete_pick_task' THEN
      v_result := public.complete_pick_task(
        (p_args->>'p_task_id')::uuid,
        (p_args->>'p_picked_qty')::numeric,
        NULLIF(p_args->>'p_lpn_id','')::uuid
      );
      SELECT t.business_id, t.organization_id, t.warehouse_id
        INTO v_business, v_org, v_warehouse
        FROM public.wms_tasks t WHERE t.id = (p_args->>'p_task_id')::uuid;

    WHEN 'complete_putaway_task' THEN
      v_result := public.complete_putaway_task((p_args->>'p_task_id')::uuid);
      SELECT t.business_id, t.organization_id, t.warehouse_id
        INTO v_business, v_org, v_warehouse
        FROM public.wms_tasks t WHERE t.id = (p_args->>'p_task_id')::uuid;

    WHEN 'complete_pack_task' THEN
      v_result := public.complete_pack_task((p_args->>'p_task_id')::uuid);
      SELECT t.business_id, t.organization_id, t.warehouse_id
        INTO v_business, v_org, v_warehouse
        FROM public.wms_tasks t WHERE t.id = (p_args->>'p_task_id')::uuid;

    WHEN 'open_pack_carton' THEN
      v_result := jsonb_build_object('carton_id', public.open_pack_carton(
        (p_args->>'p_wave_id')::uuid,
        (p_args->>'p_sales_order_id')::uuid,
        NULLIF(p_args->>'p_shipment_lpn_code','')
      ));

    WHEN 'suggest_carton' THEN
      SELECT * INTO v_carton FROM public.suggest_carton(
        (p_args->>'p_business_id')::uuid,
        ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_args->'p_product_ids','[]'::jsonb)))::uuid[],
        ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_args->'p_quantities','[]'::jsonb)))::numeric[]
      );
      v_result := COALESCE(to_jsonb(v_carton), 'null'::jsonb);

    WHEN 'suggest_packaging' THEN
      v_result := public.suggest_packaging(
        (p_args->>'p_business_id')::uuid,
        COALESCE(p_args->'p_lines', '[]'::jsonb),
        COALESCE(p_args->'p_options', '{}'::jsonb)
      );

    WHEN 'assign_carton_to_pack' THEN
      v_result := to_jsonb(public.assign_carton_to_pack(
        (p_args->>'p_carton_id')::uuid,
        NULLIF(p_args->>'p_carton_type_id','')::uuid
      ));

    WHEN 'assign_packaging_to_pack' THEN
      v_result := to_jsonb(public.assign_packaging_to_pack(
        (p_args->>'p_carton_id')::uuid,
        NULLIF(p_args->>'p_packaging_type_id','')::uuid
      ));

    WHEN 'wms_sscc_allocate' THEN
      v_result := public.wms_sscc_allocate(
        (p_args->>'p_business_id')::uuid,
        (p_args->>'p_entity_type')::public.wms_sscc_entity,
        NULLIF(p_args->>'p_entity_id','')::uuid,
        COALESCE((p_args->>'p_count')::int, 1),
        COALESCE(p_args->'p_options', '{}'::jsonb)
      );

    WHEN 'wms_sscc_mark_printed' THEN
      v_result := to_jsonb(public.wms_sscc_mark_printed(
        (p_args->>'p_business_id')::uuid,
        p_args->>'p_sscc',
        COALESCE((p_args->>'p_copies')::int, 1),
        COALESCE((p_args->>'p_is_reprint')::boolean, false),
        NULLIF(p_args->>'p_reason',''),
        COALESCE(p_args->'p_payload', '{}'::jsonb)
      ));

    WHEN 'assign_line_to_carton' THEN
      v_result := public.assign_line_to_carton(
        (p_args->>'p_carton_id')::uuid,
        (p_args->>'p_wave_line_id')::uuid,
        (p_args->>'p_qty')::numeric
      );

    WHEN 'seal_pack_carton' THEN
      v_result := public.seal_pack_carton(
        (p_args->>'p_carton_id')::uuid,
        NULLIF(p_args->>'p_weight_kg','')::numeric,
        COALESCE(p_args->'p_dims', 'null'::jsonb)
      );

    WHEN 'record_count' THEN
      v_result := public.record_count(
        (p_args->>'p_line_id')::uuid,
        (p_args->>'p_counted_qty')::numeric,
        NULLIF(p_args->>'p_note','')
      );

    WHEN 'post_count_session' THEN
      v_result := public.post_count_session((p_args->>'p_session_id')::uuid);

    WHEN 'create_pick_wave' THEN
      v_result := public.create_pick_wave(
        (p_args->>'p_warehouse_id')::uuid,
        ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_args->'p_sales_order_ids','[]'::jsonb)))::uuid[],
        NULLIF(p_args->>'p_notes','')
      );

    WHEN 'release_pick_wave' THEN
      v_result := public.release_pick_wave((p_args->>'p_wave_id')::uuid);

    WHEN 'load_carton_onto_manifest' THEN
      v_result := jsonb_build_object('manifest_carton_id', public.load_carton_onto_manifest(
        (p_args->>'p_manifest_id')::uuid,
        (p_args->>'p_carton_id')::uuid
      ));

    WHEN 'close_loading_manifest' THEN
      PERFORM public.close_loading_manifest((p_args->>'p_manifest_id')::uuid);
      v_result := jsonb_build_object('manifest_id', p_args->>'p_manifest_id', 'closed', true);

    WHEN 'dispatch_loading_manifest' THEN
      v_result := public.dispatch_loading_manifest(
        (p_args->>'p_manifest_id')::uuid,
        NULLIF(p_args->>'p_departure_at','')::timestamptz
      );

    WHEN 'accept_qc_inspection' THEN
      v_result := to_jsonb(public.accept_qc_inspection(
        (p_args->>'p_inspection_id')::uuid,
        NULLIF(p_args->>'p_accepted_qty','')::numeric,
        NULLIF(p_args->>'p_notes','')
      ));

    WHEN 'reject_qc_inspection' THEN
      v_result := to_jsonb(public.reject_qc_inspection(
        (p_args->>'p_inspection_id')::uuid,
        NULLIF(p_args->>'p_rejected_qty','')::numeric,
        NULLIF(p_args->>'p_disposition',''),
        NULLIF(p_args->>'p_notes','')
      ));

    WHEN 'cancel_qc_inspection' THEN
      v_result := to_jsonb(public.cancel_qc_inspection(
        (p_args->>'p_inspection_id')::uuid,
        NULLIF(p_args->>'p_reason','')
      ));

    ELSE
      RAISE EXCEPTION 'WMS_REPLAY_UNSUPPORTED_RPC: % is not replay-whitelisted', p_rpc;
  END CASE;

  v_result := COALESCE(v_result, '{}'::jsonb);

  IF v_business IS NULL THEN
    v_business := NULLIF(v_result->>'business_id','')::uuid;
    v_org       := COALESCE(v_org, NULLIF(v_result->>'organization_id','')::uuid);
    v_warehouse := COALESCE(v_warehouse, NULLIF(v_result->>'warehouse_id','')::uuid);
  END IF;

  PERFORM public._wms_client_scan_record(
    p_device_id, p_client_scan_id, p_rpc, v_result, v_org, v_business, v_warehouse
  );

  RETURN jsonb_build_object('replayed', false, 'rpc', p_rpc, 'result', v_result);
END $$;

REVOKE ALL ON FUNCTION public.wms_replay_guarded_call(text, jsonb, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_replay_guarded_call(text, jsonb, text, text) TO authenticated, service_role;