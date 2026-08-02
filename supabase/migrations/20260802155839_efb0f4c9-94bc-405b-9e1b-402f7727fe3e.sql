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
  v_row     public.wms_packaging_availability;
  v_pkg     public.wms_packaging_types;
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

  -- Audit ledger (ADR 0105 §4). Positional args match _wms_packaging_log.
  BEGIN
    PERFORM public._wms_packaging_log(
      v_pkg,
      'consumed',
      NULL::public.wms_packaging_lifecycle,
      NULL::public.wms_packaging_lifecycle,
      p_reference_type,
      p_warehouse_id,
      -p_qty,
      jsonb_build_object(
        'qty_on_hand', v_row.qty_on_hand,
        'reorder_point', v_row.reorder_point,
        'reference_type', p_reference_type,
        'reference_id', p_reference_id
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'wms packaging consume audit failed: %', SQLERRM;
  END;

  -- Outbox written directly: emit_packaging_event keys on row_version, which
  -- would collapse every consumption of the same packaging type into one event.
  BEGIN
    INSERT INTO public.business_event_outbox (
      event_type, organization_id, business_id, warehouse_id,
      source_doc_type, source_doc_id, payload, idempotency_key, status, actor_user_id
    ) VALUES (
      'warehouse.packaging.consumed',
      v_pkg.organization_id, v_pkg.business_id, p_warehouse_id,
      'wms_packaging_type', v_pkg.id,
      jsonb_build_object(
        'packaging_type_id', v_pkg.id,
        'code', v_pkg.code,
        'packaging_class', v_pkg.packaging_class,
        'qty', p_qty,
        'qty_on_hand', v_row.qty_on_hand,
        'reorder_point', v_row.reorder_point,
        'warehouse_id', p_warehouse_id,
        'reference_type', p_reference_type,
        'reference_id', p_reference_id
      ),
      'wms.packaging.consumed:' || COALESCE(p_reference_type, 'adhoc') || ':'
        || COALESCE(p_reference_id::text, gen_random_uuid()::text) || ':' || v_pkg.id::text,
      'pending', auth.uid()
    );

    IF v_reorder THEN
      INSERT INTO public.business_event_outbox (
        event_type, organization_id, business_id, warehouse_id,
        source_doc_type, source_doc_id, payload, idempotency_key, status, actor_user_id
      ) VALUES (
        'warehouse.packaging.reorder_needed',
        v_pkg.organization_id, v_pkg.business_id, p_warehouse_id,
        'wms_packaging_type', v_pkg.id,
        jsonb_build_object(
          'packaging_type_id', v_pkg.id,
          'code', v_pkg.code,
          'warehouse_id', p_warehouse_id,
          'qty_on_hand', v_row.qty_on_hand,
          'reorder_point', v_row.reorder_point
        ),
        'wms.packaging.reorder_needed:' || v_pkg.id::text || ':'
          || COALESCE(p_warehouse_id::text, 'all') || ':' || v_row.qty_on_hand::text,
        'pending', auth.uid()
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