
-- Phase R3 — Delivery lifecycle security & POD mirroring

-- 1. Lock down internal helper (no direct invoker access)
REVOKE EXECUTE ON FUNCTION public._log_dn_event(uuid, text, uuid, text, jsonb)
  FROM PUBLIC;
DO $$ BEGIN
  EXECUTE 'REVOKE EXECUTE ON FUNCTION public._log_dn_event(uuid, text, uuid, text, jsonb) FROM anon';
EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  EXECUTE 'REVOKE EXECUTE ON FUNCTION public._log_dn_event(uuid, text, uuid, text, jsonb) FROM authenticated';
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- 2. dispatch_delivery_atomic: validate dispatch_officer_id membership
CREATE OR REPLACE FUNCTION public.dispatch_delivery_atomic(
  p_dn_id uuid, p_user_id uuid, p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_dn record; v_officer uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE='42501'; END IF;
  SELECT id, business_id, status INTO v_dn FROM public.delivery_notes WHERE id = p_dn_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Not found'); END IF;
  IF NOT public.user_can_access_business(p_user_id, v_dn.business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF v_dn.status NOT IN ('pending','ready_to_dispatch') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only pending or ready deliveries can be dispatched');
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
    status = 'dispatched',
    dispatched_at = now(),
    shipping_method = COALESCE(p_payload->>'shipping_method', shipping_method),
    carrier_id = COALESCE(NULLIF(p_payload->>'carrier_id','')::uuid, carrier_id),
    tracking_number = COALESCE(p_payload->>'tracking_number', tracking_number),
    dispatch_officer_id = COALESCE(v_officer, dispatch_officer_id),
    dispatch_route = COALESCE(p_payload->>'dispatch_route', dispatch_route),
    dispatch_instructions = COALESCE(p_payload->>'dispatch_instructions', dispatch_instructions),
    driver_name = COALESCE(p_payload->>'driver_name', driver_name),
    vehicle_number = COALESCE(p_payload->>'vehicle_number', vehicle_number),
    freight_cost = COALESCE((NULLIF(p_payload->>'freight_cost',''))::numeric, freight_cost),
    freight_currency = COALESCE(p_payload->>'freight_currency', freight_currency),
    updated_at = now()
   WHERE id = p_dn_id;
  PERFORM public._log_dn_event(p_dn_id, 'dispatched', p_user_id, NULL, p_payload);
  RETURN jsonb_build_object('success', true);
END $$;

-- 3. complete_delivery_atomic: mirror POD received_by_contact_id onto DN row
CREATE OR REPLACE FUNCTION public.complete_delivery_atomic(
  p_dn_id uuid,
  p_user_id uuid,
  p_received_by text DEFAULT NULL,
  p_pod jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_dn record;
  v_so_branch_id uuid;
  v_warehouse_id uuid;
  v_branch_id uuid;
  v_org_id uuid;
  v_biz_id uuid;
  v_item record;
  v_unit_cost numeric;
  v_line_cost numeric;
  v_total_cogs numeric := 0;
  v_inventory_acct uuid;
  v_cogs_acct uuid;
  v_journal_id uuid;
  v_entry_no text;
  v_movement_count int := 0;
  v_so_id uuid;
  v_all_fulfilled boolean;
  v_any_fulfilled boolean;
  v_cogs_lines jsonb;
  v_currency text;
  v_pod_id uuid;
  v_is_partial boolean := false;
  v_pod_contact uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE='42501'; END IF;

  SELECT id, organization_id, business_id, branch_id, sales_order_id, delivery_number, status
    INTO v_dn FROM public.delivery_notes WHERE id = p_dn_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Delivery note not found'); END IF;

  IF v_dn.status IN ('delivered','partial','cancelled') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Delivery already finalised');
  END IF;

  v_org_id := v_dn.organization_id;
  v_biz_id := v_dn.business_id;
  v_so_id := v_dn.sales_order_id;

  IF v_biz_id IS NULL OR NOT public.user_can_access_business(p_user_id, v_biz_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_biz_id USING ERRCODE='42501';
  END IF;

  SELECT id, branch_id INTO v_warehouse_id, v_branch_id
    FROM public.warehouses
   WHERE organization_id = v_org_id AND business_id = v_biz_id
     AND COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = COALESCE(v_dn.branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
     AND is_active = true AND COALESCE(is_in_transit, false) = false
   ORDER BY is_default DESC NULLS LAST, created_at ASC LIMIT 1;

  IF v_warehouse_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'No active warehouse found for this branch — create one before delivering.');
  END IF;

  IF v_so_id IS NOT NULL THEN
    SELECT branch_id INTO v_so_branch_id FROM public.sales_orders WHERE id = v_so_id;
    IF v_so_branch_id IS NOT NULL AND v_branch_id IS NOT NULL AND v_so_branch_id <> v_branch_id THEN
      RETURN jsonb_build_object('success', false, 'error', 'Sales order is in a different branch than the warehouse.');
    END IF;
  END IF;

  FOR v_item IN
    SELECT dni.id, dni.product_id, dni.description, dni.quantity_ordered, dni.quantity_delivered,
           dni.sales_order_item_id, p.cost_price, p.track_inventory
      FROM public.delivery_note_items dni
 LEFT JOIN public.products p ON p.id = dni.product_id
     WHERE dni.delivery_note_id = p_dn_id AND dni.quantity_delivered > 0
  LOOP
    IF v_item.quantity_delivered < v_item.quantity_ordered THEN
      v_is_partial := true;
    END IF;
    IF v_item.sales_order_item_id IS NOT NULL THEN
      UPDATE public.sales_order_items
         SET quantity_fulfilled = COALESCE(quantity_fulfilled, 0) + v_item.quantity_delivered
       WHERE id = v_item.sales_order_item_id;
    END IF;
    IF v_item.product_id IS NULL OR NOT COALESCE(v_item.track_inventory, true) THEN CONTINUE; END IF;

    v_unit_cost := COALESCE(v_item.cost_price, 0);
    INSERT INTO public.stock_movements (
      organization_id, business_id, branch_id, warehouse_id,
      product_id, movement_type, quantity, unit_cost,
      reference_type, reference_id, notes, created_by
    ) VALUES (
      v_org_id, v_biz_id, v_branch_id, v_warehouse_id,
      v_item.product_id, 'delivery', -ABS(v_item.quantity_delivered), v_unit_cost,
      'delivery_note', p_dn_id,
      'Delivery ' || v_dn.delivery_number || COALESCE(' — ' || v_item.description, ''),
      p_user_id
    );
    v_movement_count := v_movement_count + 1;
    v_line_cost := ABS(v_item.quantity_delivered) * v_unit_cost;
    v_total_cogs := v_total_cogs + v_line_cost;
  END LOOP;

  IF v_total_cogs > 0 THEN
    SELECT COALESCE(base_currency, 'USD') INTO v_currency FROM public.businesses WHERE id = v_biz_id;
    SELECT id INTO v_inventory_acct FROM public.accounts
     WHERE organization_id = v_org_id AND business_id = v_biz_id
       AND detail_type = 'inventory' AND is_active = true LIMIT 1;
    SELECT id INTO v_cogs_acct FROM public.accounts
     WHERE organization_id = v_org_id AND business_id = v_biz_id
       AND detail_type = 'cost_of_goods_sold' AND is_active = true LIMIT 1;

    IF v_inventory_acct IS NOT NULL AND v_cogs_acct IS NOT NULL THEN
      SELECT public.get_next_journal_entry_number(v_org_id) INTO v_entry_no;
      v_cogs_lines := jsonb_build_array(
        jsonb_build_object('account_id', v_cogs_acct, 'debit', v_total_cogs, 'credit', 0, 'description', 'COGS - ' || v_dn.delivery_number),
        jsonb_build_object('account_id', v_inventory_acct, 'debit', 0, 'credit', v_total_cogs, 'description', 'Inventory reduction - ' || v_dn.delivery_number)
      );
      v_journal_id := public.post_journal_entry_atomic(
        _org_id := v_org_id, _business_id := v_biz_id,
        _entry_number := v_entry_no, _entry_date := CURRENT_DATE,
        _reference := 'COGS-' || v_dn.delivery_number,
        _description := 'COGS for delivery ' || v_dn.delivery_number,
        _source_type := 'delivery_note', _source_id := p_dn_id,
        _created_by := p_user_id, _is_closing := false, _is_adjusting := false,
        _lines := v_cogs_lines, _currency := v_currency, _exchange_rate := NULL,
        _source_subtype := 'cogs', _branch_id := v_branch_id
      );
    END IF;
  END IF;

  v_pod_contact := NULLIF(p_pod->>'received_by_contact_id','')::uuid;

  UPDATE public.delivery_notes
     SET status = CASE WHEN v_is_partial THEN 'partial' ELSE 'delivered' END,
         delivered_at = now(),
         received_by = COALESCE(p_received_by, received_by),
         received_by_contact_id = COALESCE(v_pod_contact, received_by_contact_id),
         updated_at = now()
   WHERE id = p_dn_id;

  IF p_pod IS NOT NULL AND p_pod <> '{}'::jsonb THEN
    INSERT INTO public.delivery_proofs (
      delivery_note_id, organization_id, business_id,
      signature_url, photo_urls, received_by_contact_id, received_by_name,
      received_at, gps_lat, gps_lng, notes, created_by
    ) VALUES (
      p_dn_id, v_org_id, v_biz_id,
      p_pod->>'signature_url',
      COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_pod->'photo_urls')), ARRAY[]::text[]),
      v_pod_contact,
      COALESCE(p_pod->>'received_by_name', p_received_by),
      COALESCE(NULLIF(p_pod->>'received_at','')::timestamptz, now()),
      NULLIF(p_pod->>'gps_lat','')::numeric,
      NULLIF(p_pod->>'gps_lng','')::numeric,
      p_pod->>'notes',
      p_user_id
    ) RETURNING id INTO v_pod_id;
  END IF;

  IF v_so_id IS NOT NULL THEN
    SELECT bool_and(quantity_fulfilled >= quantity), bool_or(quantity_fulfilled > 0)
      INTO v_all_fulfilled, v_any_fulfilled
      FROM public.sales_order_items WHERE sales_order_id = v_so_id;
    IF v_all_fulfilled THEN
      UPDATE public.sales_orders SET status = 'fulfilled', updated_at = now()
       WHERE id = v_so_id AND status NOT IN ('invoiced','cancelled');
    ELSIF v_any_fulfilled THEN
      UPDATE public.sales_orders SET status = 'partial', updated_at = now()
       WHERE id = v_so_id AND status NOT IN ('invoiced','cancelled','fulfilled');
    END IF;
  END IF;

  PERFORM public._log_dn_event(p_dn_id, CASE WHEN v_is_partial THEN 'partially_delivered' ELSE 'delivered' END,
    p_user_id, p_received_by,
    jsonb_build_object('movements', v_movement_count, 'cogs', v_total_cogs, 'pod_id', v_pod_id));

  RETURN jsonb_build_object(
    'success', true, 'delivery_id', p_dn_id, 'warehouse_id', v_warehouse_id,
    'movements_created', v_movement_count, 'gl_posted', v_journal_id IS NOT NULL,
    'cogs_total', v_total_cogs, 'pod_id', v_pod_id, 'partial', v_is_partial
  );
END $$;
