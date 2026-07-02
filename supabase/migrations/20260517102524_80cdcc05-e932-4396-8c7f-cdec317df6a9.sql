CREATE OR REPLACE FUNCTION public.record_partial_delivery_atomic(
  p_dn_id uuid,
  p_user_id uuid,
  p_line_qtys jsonb,
  p_create_backorder boolean DEFAULT true,
  p_received_by text DEFAULT NULL::text,
  p_pod jsonb DEFAULT NULL::jsonb,
  p_received_by_user_id uuid DEFAULT NULL
)
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

  FOR v_line IN SELECT * FROM jsonb_array_elements(COALESCE(p_line_qtys, '[]'::jsonb))
  LOOP
    UPDATE public.delivery_note_items
       SET quantity_delivered = LEAST(
             GREATEST((v_line->>'quantity_delivered')::numeric, 0),
             quantity_ordered
           )
     WHERE id = (v_line->>'item_id')::uuid AND delivery_note_id = p_dn_id;
  END LOOP;

  SELECT COALESCE(SUM(quantity_delivered), 0) INTO v_total_delivered
    FROM public.delivery_note_items
   WHERE delivery_note_id = p_dn_id;
  IF v_total_delivered <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Nothing to deliver — cancel the delivery instead.');
  END IF;

  v_complete := public.complete_delivery_atomic(
    p_dn_id := p_dn_id,
    p_user_id := p_user_id,
    p_received_by := p_received_by,
    p_pod := p_pod,
    p_received_by_user_id := COALESCE(p_received_by_user_id, p_user_id)
  );
  IF NOT COALESCE((v_complete->>'success')::boolean, false) THEN
    RAISE EXCEPTION 'Complete failed: %', v_complete->>'error';
  END IF;

  IF p_create_backorder THEN
    SELECT COUNT(*) INTO v_remaining_count
      FROM public.delivery_note_items
     WHERE delivery_note_id = p_dn_id AND quantity_ordered > quantity_delivered;

    IF v_remaining_count > 0 THEN
      SELECT public.get_next_delivery_number(v_dn.organization_id) INTO v_new_number;
      INSERT INTO public.delivery_notes (
        organization_id, business_id, branch_id, contact_id, delivery_number,
        delivery_date, status, sales_order_id, source_invoice_id,
        received_by_contact_id, shipping_address, notes,
        is_backorder, backorder_of_dn_id, created_by
      ) VALUES (
        v_dn.organization_id, v_dn.business_id, v_dn.branch_id, v_dn.contact_id, v_new_number,
        CURRENT_DATE, 'pending', v_dn.sales_order_id, v_dn.source_invoice_id,
        v_dn.contact_id, v_dn.shipping_address,
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