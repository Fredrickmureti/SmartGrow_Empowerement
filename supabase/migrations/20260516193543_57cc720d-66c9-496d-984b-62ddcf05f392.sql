-- Tighten update_delivery_logistics_atomic: add dispatch officer membership check
CREATE OR REPLACE FUNCTION public.update_delivery_logistics_atomic(p_dn_id uuid, p_user_id uuid, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_dn record;
  v_officer uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE='42501'; END IF;
  SELECT id, business_id INTO v_dn FROM public.delivery_notes WHERE id = p_dn_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Not found'); END IF;
  IF NOT public.user_can_access_business(p_user_id, v_dn.business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF (p_payload ? 'carrier_id') AND NULLIF(p_payload->>'carrier_id','') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.carriers c
      WHERE c.id = (p_payload->>'carrier_id')::uuid AND c.business_id = v_dn.business_id
    ) THEN RAISE EXCEPTION 'Carrier does not belong to this company'; END IF;
  END IF;
  v_officer := NULLIF(p_payload->>'dispatch_officer_id','')::uuid;
  IF v_officer IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.user_business_access uba
      WHERE uba.user_id = v_officer AND uba.business_id = v_dn.business_id
    ) THEN RAISE EXCEPTION 'Dispatch officer is not a member of this company'; END IF;
  END IF;
  UPDATE public.delivery_notes SET
    shipping_method = COALESCE(p_payload->>'shipping_method', shipping_method),
    carrier_id = COALESCE(NULLIF(p_payload->>'carrier_id','')::uuid, carrier_id),
    tracking_number = COALESCE(p_payload->>'tracking_number', tracking_number),
    dispatch_officer_id = COALESCE(v_officer, dispatch_officer_id),
    dispatch_route = COALESCE(p_payload->>'dispatch_route', dispatch_route),
    dispatch_instructions = COALESCE(p_payload->>'dispatch_instructions', dispatch_instructions),
    driver_name = COALESCE(p_payload->>'driver_name', driver_name),
    vehicle_number = COALESCE(p_payload->>'vehicle_number', vehicle_number),
    freight_cost = COALESCE(NULLIF(p_payload->>'freight_cost','')::numeric, freight_cost),
    freight_currency = COALESCE(p_payload->>'freight_currency', freight_currency),
    shipping_address = COALESCE(p_payload->>'shipping_address', shipping_address),
    notes = COALESCE(p_payload->>'notes', notes),
    updated_at = now()
   WHERE id = p_dn_id;
  PERFORM public._log_dn_event(p_dn_id, 'logistics_updated', p_user_id, NULL, p_payload);
  RETURN jsonb_build_object('success', true);
END $function$;

-- Guard record_partial_delivery_atomic against the "ship nothing, mark delivered" hole
CREATE OR REPLACE FUNCTION public.record_partial_delivery_atomic(p_dn_id uuid, p_user_id uuid, p_line_qtys jsonb, p_create_backorder boolean DEFAULT true, p_received_by text DEFAULT NULL::text, p_pod jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_dn record;
  v_line jsonb;
  v_backorder_id uuid;
  v_complete jsonb;
  v_remaining_count int := 0;
  v_total_delivered numeric := 0;
  v_new_number text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_dn FROM public.delivery_notes WHERE id = p_dn_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Not found'); END IF;
  IF NOT public.user_can_access_business(p_user_id, v_dn.business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF v_dn.status IN ('delivered','partial','cancelled') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Delivery already finalised');
  END IF;

  -- Apply per-line delivered quantities
  FOR v_line IN SELECT * FROM jsonb_array_elements(COALESCE(p_line_qtys, '[]'::jsonb))
  LOOP
    UPDATE public.delivery_note_items
       SET quantity_delivered = LEAST(
             GREATEST((v_line->>'quantity_delivered')::numeric, 0),
             quantity_ordered
           )
     WHERE id = (v_line->>'item_id')::uuid AND delivery_note_id = p_dn_id;
  END LOOP;

  -- Guard: refuse zero-quantity partial deliveries
  SELECT COALESCE(SUM(quantity_delivered), 0) INTO v_total_delivered
    FROM public.delivery_note_items
   WHERE delivery_note_id = p_dn_id;
  IF v_total_delivered <= 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Nothing to deliver — cancel the delivery instead.'
    );
  END IF;

  -- Complete with whatever quantities are now on the lines
  v_complete := public.complete_delivery_atomic(p_dn_id, p_user_id, p_received_by, p_pod);
  IF NOT COALESCE((v_complete->>'success')::boolean, false) THEN
    RAISE EXCEPTION 'Complete failed: %', v_complete->>'error';
  END IF;

  -- Build backorder for remaining quantities
  IF p_create_backorder THEN
    SELECT COUNT(*) INTO v_remaining_count
      FROM public.delivery_note_items
     WHERE delivery_note_id = p_dn_id AND quantity_ordered > quantity_delivered;

    IF v_remaining_count > 0 THEN
      SELECT public.get_next_delivery_number(v_dn.organization_id) INTO v_new_number;
      INSERT INTO public.delivery_notes (
        organization_id, business_id, branch_id, contact_id, delivery_number,
        delivery_date, status, sales_order_id, shipping_address, notes,
        is_backorder, backorder_of_dn_id, created_by
      ) VALUES (
        v_dn.organization_id, v_dn.business_id, v_dn.branch_id, v_dn.contact_id, v_new_number,
        CURRENT_DATE, 'pending', v_dn.sales_order_id, v_dn.shipping_address,
        'Backorder of ' || v_dn.delivery_number,
        true, p_dn_id, p_user_id
      ) RETURNING id INTO v_backorder_id;

      INSERT INTO public.delivery_note_items (
        delivery_note_id, product_id, sales_order_item_id, description,
        quantity_ordered, quantity_delivered, sort_order
      )
      SELECT v_backorder_id, product_id, sales_order_item_id, description,
             (quantity_ordered - quantity_delivered), (quantity_ordered - quantity_delivered),
             sort_order
        FROM public.delivery_note_items
       WHERE delivery_note_id = p_dn_id AND quantity_ordered > quantity_delivered;

      PERFORM public._log_dn_event(p_dn_id, 'backorder_created', p_user_id, NULL,
        jsonb_build_object('backorder_id', v_backorder_id, 'backorder_number', v_new_number));
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'complete_result', v_complete,
    'backorder_id', v_backorder_id
  );
END $function$;