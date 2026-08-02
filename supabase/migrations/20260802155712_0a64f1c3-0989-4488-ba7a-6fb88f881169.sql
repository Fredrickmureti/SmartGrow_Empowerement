-- ── Phase 6 (ADR 0105 §3): packaging supply is consumed when a carton seals ──

ALTER TABLE public.wms_pack_cartons
  ADD COLUMN IF NOT EXISTS packaging_consumed_at timestamptz;

COMMENT ON COLUMN public.wms_pack_cartons.packaging_consumed_at IS
  'Set once when the carton''s packaging type was deducted from wms_packaging_availability (ADR 0105 Phase 6). Idempotency stamp — never cleared.';

CREATE OR REPLACE FUNCTION public.wms_packaging_consume(
  p_business_id uuid,
  p_warehouse_id uuid,
  p_packaging_type_id uuid,
  p_qty numeric DEFAULT 1,
  p_reference_type text DEFAULT NULL,
  p_reference_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row    public.wms_packaging_availability;
  v_pkg    public.wms_packaging_types;
  v_reorder boolean := false;
BEGIN
  IF p_packaging_type_id IS NULL OR p_business_id IS NULL THEN
    RETURN jsonb_build_object('consumed', false, 'reason', 'missing_packaging');
  END IF;
  IF COALESCE(p_qty, 0) <= 0 THEN
    RETURN jsonb_build_object('consumed', false, 'reason', 'non_positive_qty');
  END IF;

  SELECT * INTO v_pkg
    FROM public.wms_packaging_types
   WHERE id = p_packaging_type_id AND business_id = p_business_id;
  IF v_pkg.id IS NULL THEN
    RETURN jsonb_build_object('consumed', false, 'reason', 'unknown_packaging_type');
  END IF;

  -- Only tracked (is_stocked) packaging carries a balance. Untracked packaging
  -- is a no-op, not an error: many 3PLs do not count envelopes.
  SELECT * INTO v_row
    FROM public.wms_packaging_availability
   WHERE business_id = p_business_id
     AND packaging_type_id = p_packaging_type_id
     AND warehouse_id IS NOT DISTINCT FROM p_warehouse_id
   FOR UPDATE;

  IF v_row.id IS NULL OR v_row.is_stocked IS NOT TRUE THEN
    RETURN jsonb_build_object('consumed', false, 'reason', 'not_stocked');
  END IF;

  UPDATE public.wms_packaging_availability
     SET qty_on_hand = GREATEST(0, COALESCE(qty_on_hand, 0) - p_qty),
         updated_at  = now()
   WHERE id = v_row.id
  RETURNING * INTO v_row;

  v_reorder := v_row.reorder_point IS NOT NULL
               AND COALESCE(v_row.qty_on_hand, 0) <= v_row.reorder_point;

  BEGIN
    PERFORM public._wms_packaging_log(
      p_business_id,
      p_packaging_type_id,
      'consumed',
      jsonb_build_object(
        'qty', p_qty,
        'warehouse_id', p_warehouse_id,
        'qty_on_hand', v_row.qty_on_hand,
        'reorder_point', v_row.reorder_point,
        'reference_type', p_reference_type,
        'reference_id', p_reference_id
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'wms packaging consume audit failed: %', SQLERRM;
  END;

  BEGIN
    PERFORM public.emit_packaging_event(
      p_business_id,
      p_packaging_type_id,
      'warehouse.packaging.consumed',
      jsonb_build_object(
        'qty', p_qty,
        'warehouse_id', p_warehouse_id,
        'qty_on_hand', v_row.qty_on_hand,
        'reference_type', p_reference_type,
        'reference_id', p_reference_id
      )
    );
    IF v_reorder THEN
      PERFORM public.emit_packaging_event(
        p_business_id,
        p_packaging_type_id,
        'warehouse.packaging.reorder_needed',
        jsonb_build_object(
          'warehouse_id', p_warehouse_id,
          'qty_on_hand', v_row.qty_on_hand,
          'reorder_point', v_row.reorder_point
        )
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'wms packaging consume outbox emit failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object(
    'consumed', true,
    'qty', p_qty,
    'qty_on_hand', v_row.qty_on_hand,
    'reorder_needed', v_reorder
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.wms_packaging_consume(uuid, uuid, uuid, numeric, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_packaging_consume(uuid, uuid, uuid, numeric, text, uuid) TO service_role;

-- ── seal now consumes the packaging supply, exactly once per carton ──
CREATE OR REPLACE FUNCTION public.seal_pack_carton(
  p_carton_id uuid,
  p_weight_kg numeric DEFAULT NULL::numeric,
  p_dims jsonb DEFAULT NULL::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_carton record;
  v_consume jsonb := jsonb_build_object('consumed', false, 'reason', 'no_packaging_type');
BEGIN
  SELECT * INTO v_carton FROM public.wms_pack_cartons WHERE id = p_carton_id;
  IF v_carton.id IS NULL THEN RAISE EXCEPTION 'carton % not found', p_carton_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_carton.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;
  IF v_carton.sealed_at IS NOT NULL THEN RAISE EXCEPTION 'carton already sealed'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.wms_pick_wave_lines
     WHERE packed_carton_id = p_carton_id
  ) THEN
    RAISE EXCEPTION 'cannot seal an empty carton';
  END IF;

  UPDATE public.wms_pack_cartons
     SET sealed_at = now(),
         sealed_by = auth.uid(),
         weight_kg = COALESCE(p_weight_kg, weight_kg),
         length_cm = COALESCE((p_dims->>'length_cm')::numeric, length_cm),
         width_cm  = COALESCE((p_dims->>'width_cm')::numeric,  width_cm),
         height_cm = COALESCE((p_dims->>'height_cm')::numeric, height_cm)
   WHERE id = p_carton_id;

  IF v_carton.shipment_lpn_id IS NOT NULL THEN
    UPDATE public.wms_license_plates
       SET status = 'sealed', sealed_at = now()
     WHERE id = v_carton.shipment_lpn_id;
  END IF;

  -- Packaging supply: one unit of the stamped packaging type leaves stock.
  -- Guarded by packaging_consumed_at so a replay cannot double-deduct, and
  -- by an exception block so a supply problem never blocks the seal.
  IF v_carton.packaging_type_id IS NOT NULL AND v_carton.packaging_consumed_at IS NULL THEN
    BEGIN
      v_consume := public.wms_packaging_consume(
        v_carton.business_id,
        v_carton.warehouse_id,
        v_carton.packaging_type_id,
        1,
        'wms_pack_carton',
        p_carton_id
      );
      IF (v_consume->>'consumed')::boolean THEN
        UPDATE public.wms_pack_cartons
           SET packaging_consumed_at = now()
         WHERE id = p_carton_id AND packaging_consumed_at IS NULL;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'wms packaging consume on seal failed: %', SQLERRM;
      v_consume := jsonb_build_object('consumed', false, 'reason', 'error');
    END;
  END IF;

  BEGIN
    INSERT INTO public.business_event_outbox (
      org_id, branch_id, warehouse_id, event_type,
      source_doc_type, source_doc_id, payload, idempotency_key, status, actor_user_id
    ) VALUES (
      v_carton.organization_id, v_carton.branch_id, v_carton.warehouse_id,
      'warehouse.carton.sealed',
      'wms_pack_carton', p_carton_id,
      jsonb_build_object(
        'carton_id', p_carton_id,
        'business_id', v_carton.business_id,
        'wave_id', v_carton.wave_id,
        'sales_order_id', v_carton.sales_order_id,
        'shipment_lpn_id', v_carton.shipment_lpn_id,
        'packaging_type_id', v_carton.packaging_type_id,
        'packaging_consumed', v_consume,
        'weight_kg', p_weight_kg,
        'dims', p_dims
      ),
      'wms.carton.sealed:' || p_carton_id::text,
      'pending', auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'wms carton sealed outbox emit failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object(
    'carton_id', p_carton_id,
    'sealed_at', now(),
    'packaging', v_consume
  );
END;
$function$;