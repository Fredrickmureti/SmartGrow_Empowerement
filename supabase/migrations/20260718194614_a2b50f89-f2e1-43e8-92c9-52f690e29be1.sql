
DROP FUNCTION IF EXISTS public.process_pos_transaction(
  uuid, uuid, uuid, uuid, jsonb, jsonb, numeric, numeric, numeric, numeric, text,
  uuid, text, text, text, uuid, uuid, uuid, numeric, uuid, text);
DROP FUNCTION IF EXISTS public.process_pos_return(
  uuid, uuid, uuid, uuid, jsonb, text, text, uuid, uuid);

-- ── 1. Helpers ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._pos_insert_line(_txn_id uuid, _payload jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF _txn_id IS NULL OR _payload IS NULL THEN
    RAISE EXCEPTION '_pos_insert_line: _txn_id and _payload are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO public.pos_transaction_items (
    transaction_id, product_id, description, quantity, unit_price,
    discount_type, discount_value, tax_rate, tax_amount, line_total,
    cost_price, sort_order, tax_rate_id, etims_tax_code,
    packaging_id, display_uom_id, display_quantity, lot_allocations,
    original_item_id, return_reason_id, return_reason_note
  ) VALUES (
    _txn_id,
    NULLIF(_payload->>'product_id','')::uuid,
    _payload->>'description',
    COALESCE((_payload->>'quantity')::numeric, 0),
    COALESCE((_payload->>'unit_price')::numeric, 0),
    _payload->>'discount_type',
    COALESCE((_payload->>'discount_value')::numeric, 0),
    COALESCE((_payload->>'tax_rate')::numeric, 0),
    COALESCE((_payload->>'tax_amount')::numeric, 0),
    COALESCE((_payload->>'line_total')::numeric, 0),
    COALESCE((_payload->>'cost_price')::numeric, 0),
    COALESCE((_payload->>'sort_order')::int, 0),
    NULLIF(_payload->>'tax_rate_id','')::uuid,
    _payload->>'etims_tax_code',
    NULLIF(_payload->>'packaging_id','')::uuid,
    NULLIF(_payload->>'display_uom_id','')::uuid,
    NULLIF(_payload->>'display_quantity','')::numeric,
    CASE WHEN jsonb_typeof(_payload->'lot_allocations') = 'array'
         THEN _payload->'lot_allocations' ELSE NULL END,
    NULLIF(_payload->>'original_item_id','')::uuid,
    NULLIF(_payload->>'return_reason_id','')::uuid,
    NULLIF(_payload->>'return_reason_note','')
  ) RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public._pos_insert_line(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._pos_insert_line(uuid, jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public._pos_record_payment(
  _txn_id uuid, _org_id uuid, _biz_id uuid, _branch_id uuid, _payload jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_method text; v_amount numeric; v_tendered numeric; v_change numeric;
BEGIN
  IF _txn_id IS NULL OR _payload IS NULL THEN
    RAISE EXCEPTION '_pos_record_payment: _txn_id and _payload are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_method   := _payload->>'payment_method';
  v_amount   := COALESCE((_payload->>'amount')::numeric, 0);
  v_tendered := COALESCE((_payload->>'tendered_amount')::numeric, v_amount);
  v_change   := COALESCE((_payload->>'change_given')::numeric, GREATEST(0, v_tendered - v_amount));
  INSERT INTO public.pos_transaction_payments (
    transaction_id, organization_id, business_id, branch_id,
    payment_method, amount, tendered_amount, change_given,
    reference, card_last_four, card_type, mpesa_receipt_number,
    status, processed_at
  ) VALUES (
    _txn_id, _org_id, _biz_id, _branch_id,
    v_method, v_amount, v_tendered, v_change,
    _payload->>'reference', _payload->>'card_last_four',
    _payload->>'card_type', _payload->>'mpesa_receipt_number',
    COALESCE(_payload->>'status','completed'), now()
  ) RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public._pos_record_payment(uuid, uuid, uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._pos_record_payment(uuid, uuid, uuid, uuid, jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public._pos_apply_lot_consumption(
  _org_id uuid, _biz_id uuid, _branch_id uuid, _warehouse_id uuid,
  _product_id uuid, _txn_id uuid, _txn_number text, _actor uuid,
  _allocations jsonb, _quantity numeric, _unit_cost numeric,
  _is_lot_tracked boolean, _direction text,
  _packaging_id uuid DEFAULT NULL, _uom_id uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_elem jsonb;
BEGIN
  IF _warehouse_id IS NULL THEN
    RAISE EXCEPTION '_pos_apply_lot_consumption: warehouse_id required (product=%, txn=%)',
      _product_id, _txn_id USING ERRCODE = 'check_violation';
  END IF;
  IF _direction NOT IN ('in','out') THEN
    RAISE EXCEPTION '_pos_apply_lot_consumption: _direction must be in/out, got %', _direction
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF _direction = 'out' THEN
    IF _is_lot_tracked AND _allocations IS NOT NULL
       AND jsonb_typeof(_allocations) = 'array'
       AND jsonb_array_length(_allocations) > 0 THEN
      PERFORM public.consume_lots_atomic(
        _org_id, _biz_id, _warehouse_id, _branch_id,
        _product_id, 'pos_sale', 'pos_transaction', _txn_id, _actor,
        'POS Sale: ' || COALESCE(_txn_number, _txn_id::text),
        _allocations, _unit_cost);
    ELSE
      PERFORM public._pos_write_stock_movement(
        _org_id, _biz_id, _branch_id, _product_id, _warehouse_id,
        'pos_sale', -_quantity, _unit_cost, _txn_id, _txn_number, _actor,
        NULL, NULL, _packaging_id, _uom_id);
    END IF;
  ELSE
    IF _is_lot_tracked AND _allocations IS NOT NULL
       AND jsonb_typeof(_allocations) = 'array'
       AND jsonb_array_length(_allocations) > 0 THEN
      FOR v_elem IN SELECT * FROM jsonb_array_elements(_allocations) LOOP
        PERFORM public._pos_write_stock_movement(
          _org_id, _biz_id, _branch_id, _product_id, _warehouse_id,
          'pos_return', COALESCE((v_elem->>'qty')::numeric, 0),
          _unit_cost, _txn_id, _txn_number, _actor,
          v_elem->>'lot_number', v_elem->>'serial_number', NULL, NULL);
      END LOOP;
    ELSE
      PERFORM public._pos_write_stock_movement(
        _org_id, _biz_id, _branch_id, _product_id, _warehouse_id,
        'pos_return', _quantity, _unit_cost, _txn_id, _txn_number, _actor,
        NULL, NULL, NULL, NULL);
    END IF;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public._pos_apply_lot_consumption(
  uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, jsonb, numeric, numeric, boolean, text, uuid, uuid
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._pos_apply_lot_consumption(
  uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, jsonb, numeric, numeric, boolean, text, uuid, uuid
) TO authenticated, service_role;

-- ── 2. process_pos_transaction (T6-complete)  ────────────────────────────────
CREATE FUNCTION public.process_pos_transaction(
  p_organization_id uuid, p_business_id uuid, p_register_id uuid, p_shift_id uuid,
  p_items jsonb, p_payments jsonb, p_subtotal numeric, p_tax_amount numeric,
  p_discount_amount numeric, p_total numeric, p_transaction_type text,
  p_customer_id uuid, p_customer_tin text, p_customer_name text, p_notes text,
  p_cashier_id uuid, p_created_by uuid, p_original_transaction_id uuid,
  p_tip_amount numeric, p_table_session_id uuid, p_idempotency_key text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_transaction_id uuid; v_transaction_number text; v_register_code text;
  v_register_branch_id uuid; v_register_business_id uuid; v_register_org_id uuid;
  v_default_warehouse_id uuid;
  v_item jsonb; v_payment jsonb; v_product_id uuid; v_quantity numeric;
  v_track_inventory boolean; v_on_hand numeric; v_reserved numeric;
  v_total_paid numeric := 0; v_total_tendered numeric := 0; v_total_change numeric := 0;
  v_cash_total numeric := 0; v_payment_status text := 'paid';
  v_item_index integer := 0; v_existing record; v_insufficient jsonb := '[]'::jsonb;
  v_product_name text; v_snapshot jsonb;
  v_p_amount numeric; v_p_tendered numeric; v_p_change numeric; v_p_method text;
  v_packaging_id uuid; v_display_uom_id uuid; v_display_quantity numeric;
  v_is_lot_tracked boolean; v_item_allocs jsonb; v_alloc_sum numeric;
  v_item_unit_cost numeric;
  v_resolved jsonb;
  v_req_unit_price numeric; v_req_discount_type text; v_req_discount_value numeric;
  v_req_line_total numeric; v_srv_unit_price numeric; v_srv_line_total numeric;
  v_srv_tax_amount numeric; v_srv_tax_rate numeric; v_srv_tax_rate_id uuid;
  v_srv_discount_amount numeric;
  v_srv_subtotal numeric := 0; v_srv_total_tax numeric := 0;
  v_srv_total_discount numeric := 0; v_srv_total numeric := 0;
  v_override_id uuid; v_override record; v_deviation numeric;
  v_override_required boolean;
  v_resolved_items jsonb := '[]'::jsonb;
  v_line_payload jsonb;
  c_tolerance CONSTANT numeric := 0.01;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id, transaction_number, branch_id, business_id, total INTO v_existing
    FROM public.pos_transactions
    WHERE organization_id = p_organization_id AND business_id = p_business_id
      AND register_id = p_register_id AND idempotency_key = p_idempotency_key LIMIT 1;
    IF v_existing.id IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'idempotent_replay', true,
        'transaction_id', v_existing.id, 'transaction_number', v_existing.transaction_number,
        'change', 0, 'branch_id', v_existing.branch_id, 'business_id', v_existing.business_id);
    END IF;
  END IF;

  SELECT register_code, branch_id, business_id, organization_id
    INTO v_register_code, v_register_branch_id, v_register_business_id, v_register_org_id
  FROM public.pos_registers WHERE id = p_register_id;

  IF v_register_code IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Register not found'); END IF;
  IF v_register_org_id IS DISTINCT FROM p_organization_id
     OR v_register_business_id IS DISTINCT FROM p_business_id THEN
    RAISE EXCEPTION 'Register % belongs to a different organization/business than supplied (org=%, biz=% vs supplied org=%, biz=%)',
      p_register_id, v_register_org_id, v_register_business_id, p_organization_id, p_business_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_register_branch_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Register has no branch context'); END IF;

  PERFORM public.assert_pos_caller_branch_access(v_register_branch_id);

  IF p_transaction_type = 'sale' AND COALESCE(p_total, 0) > 0
     AND (p_payments IS NULL OR jsonb_array_length(p_payments) = 0) THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_payments',
      'detail', 'A sale with a positive total requires at least one payment line.');
  END IF;

  v_default_warehouse_id := public._pos_resolve_branch_warehouse(
    v_register_org_id, v_register_business_id, v_register_branch_id, p_shift_id);

  -- T4 pessimistic lock
  IF p_transaction_type <> 'return' AND v_default_warehouse_id IS NOT NULL THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
      v_product_id := NULLIF(v_item->>'product_id', '')::uuid;
      v_quantity := COALESCE((v_item->>'quantity')::numeric, 0);
      IF v_product_id IS NULL OR v_quantity <= 0 THEN CONTINUE; END IF;
      SELECT track_inventory, COALESCE(NULLIF(name,''), '') INTO v_track_inventory, v_product_name
      FROM public.products WHERE id = v_product_id
        AND organization_id = v_register_org_id AND business_id = v_register_business_id;
      IF v_track_inventory IS NOT TRUE THEN CONTINUE; END IF;
      PERFORM pg_advisory_xact_lock(
        hashtextextended(v_product_id::text || ':' || v_default_warehouse_id::text, 0));
      SELECT COALESCE(SUM(sm.quantity), 0),
        COALESCE((SELECT SUM(quantity) FROM public.pos_stock_reservations
                   WHERE register_id = p_register_id AND product_id = v_product_id), 0)
      INTO v_on_hand, v_reserved FROM public.stock_movements sm
      WHERE sm.product_id = v_product_id AND sm.warehouse_id = v_default_warehouse_id;
      IF v_on_hand - v_reserved < v_quantity THEN
        v_insufficient := v_insufficient || jsonb_build_object(
          'product_id', v_product_id, 'product_name', v_product_name,
          'requested', v_quantity, 'available', GREATEST(0, v_on_hand - v_reserved));
      END IF;
    END LOOP;
  END IF;
  IF jsonb_array_length(v_insufficient) > 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_stock', 'details', v_insufficient);
  END IF;

  FOR v_payment IN SELECT * FROM jsonb_array_elements(p_payments) LOOP
    v_p_method := v_payment->>'payment_method';
    v_p_amount := COALESCE((v_payment->>'amount')::numeric, 0);
    v_p_tendered := COALESCE((v_payment->>'tendered_amount')::numeric, v_p_amount);
    v_p_change := COALESCE((v_payment->>'change_given')::numeric, GREATEST(0, v_p_tendered - v_p_amount));
    IF v_p_tendered < v_p_amount - 0.005 THEN
      RAISE EXCEPTION 'Payment line % has tendered (%) less than applied (%)', v_p_method, v_p_tendered, v_p_amount
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_p_method <> 'cash' AND v_p_change > 0.005 THEN
      RAISE EXCEPTION 'Non-cash payment % cannot return change (%)', v_p_method, v_p_change
        USING ERRCODE = 'check_violation';
    END IF;
    v_total_paid := v_total_paid + v_p_amount;
    v_total_tendered := v_total_tendered + v_p_tendered;
    v_total_change := v_total_change + v_p_change;
    IF v_p_method = 'cash' THEN v_cash_total := v_cash_total + v_p_amount; END IF;
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_product_id := NULLIF(v_item->>'product_id', '')::uuid;
    v_quantity := COALESCE((v_item->>'quantity')::numeric, 0);
    v_req_unit_price := COALESCE((v_item->>'unit_price')::numeric, 0);
    v_req_discount_type := v_item->>'discount_type';
    v_req_discount_value := COALESCE((v_item->>'discount_value')::numeric, 0);
    v_req_line_total := COALESCE((v_item->>'line_total')::numeric, 0);
    v_override_id := NULLIF(v_item->>'manager_override_id','')::uuid;

    v_resolved := public.pos_resolve_line(
      v_register_business_id, v_product_id, v_quantity,
      v_req_unit_price, v_req_discount_type, v_req_discount_value);

    v_srv_unit_price := COALESCE((v_resolved->>'unit_price')::numeric, 0);
    v_srv_tax_rate := COALESCE((v_resolved->>'tax_rate')::numeric, 0);
    v_srv_tax_rate_id := NULLIF(v_resolved->>'tax_rate_id','')::uuid;
    v_srv_discount_amount := COALESCE((v_resolved->>'discount_amount')::numeric, 0);
    v_srv_tax_amount := COALESCE((v_resolved->>'tax_amount')::numeric, 0);
    v_srv_line_total := COALESCE((v_resolved->>'line_total')::numeric, 0);

    IF v_product_id IS NOT NULL THEN
      v_deviation := ABS(COALESCE(v_req_unit_price,0) - v_srv_unit_price);
      v_override_required := v_deviation > c_tolerance;
      IF v_override_required THEN
        IF v_override_id IS NULL THEN
          RAISE EXCEPTION 'price_override_required for product % (client=%, catalog=%)',
            v_product_id, v_req_unit_price, v_srv_unit_price
            USING ERRCODE = 'insufficient_privilege';
        END IF;
        SELECT * INTO v_override FROM public.pos_manager_overrides
         WHERE id = v_override_id AND organization_id = v_register_org_id
           AND (business_id IS NULL OR business_id = v_register_business_id)
           AND status = 'approved' AND consumed_at IS NULL LIMIT 1;
        IF v_override.id IS NULL THEN
          RAISE EXCEPTION 'Manager override % missing, unapproved, or already consumed', v_override_id
            USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF v_override.override_type NOT IN ('price_override','discount_override','discount','price') THEN
          RAISE EXCEPTION 'Manager override % has wrong type % for a price deviation',
            v_override_id, v_override.override_type USING ERRCODE = 'insufficient_privilege';
        END IF;
        v_srv_unit_price := v_req_unit_price;
        v_srv_discount_amount := CASE
          WHEN v_req_discount_type = 'percentage'
            THEN ROUND(v_srv_unit_price * v_quantity * v_req_discount_value / 100.0, 4)
          WHEN v_req_discount_type = 'fixed'
            THEN LEAST(v_srv_unit_price * v_quantity, v_req_discount_value)
          ELSE 0 END;
        v_srv_tax_amount := ROUND(
          GREATEST(0, (v_srv_unit_price * v_quantity) - v_srv_discount_amount)
            * v_srv_tax_rate / 100.0, 4);
        v_srv_line_total := ROUND(
          GREATEST(0, (v_srv_unit_price * v_quantity) - v_srv_discount_amount)
            + v_srv_tax_amount, 4);
      END IF;
    END IF;

    v_srv_subtotal := v_srv_subtotal + (v_srv_unit_price * v_quantity);
    v_srv_total_discount := v_srv_total_discount + v_srv_discount_amount;
    v_srv_total_tax := v_srv_total_tax + v_srv_tax_amount;
    v_srv_total := v_srv_total + v_srv_line_total;

    v_resolved_items := v_resolved_items || jsonb_build_object(
      'product_id', v_product_id, 'quantity', v_quantity,
      'unit_price', v_srv_unit_price,
      'discount_type', v_req_discount_type,
      'discount_value', v_req_discount_value,
      'discount_amount', v_srv_discount_amount,
      'tax_rate', v_srv_tax_rate, 'tax_rate_id', v_srv_tax_rate_id,
      'tax_amount', v_srv_tax_amount, 'line_total', v_srv_line_total,
      'etims_tax_code', v_item->>'etims_tax_code', 'name', v_item->>'name',
      'cost_price', COALESCE((v_item->>'cost_price')::numeric, 0),
      'packaging_id', NULLIF(v_item->>'packaging_id','')::uuid,
      'display_uom_id', NULLIF(v_item->>'display_uom_id','')::uuid,
      'display_quantity', NULLIF(v_item->>'display_quantity','')::numeric,
      'lot_allocations', v_item->'lot_allocations',
      'manager_override_id', v_override_id);

    IF v_override_id IS NOT NULL AND v_override.id IS NOT NULL THEN
      UPDATE public.pos_manager_overrides
         SET consumed_at = now(), consumed_table = 'pos_transactions'
       WHERE id = v_override_id AND consumed_at IS NULL;
    END IF;
  END LOOP;

  v_payment_status := CASE WHEN v_total_paid + 0.005 >= v_srv_total THEN 'paid' ELSE 'partial' END;

  v_transaction_number := public.get_next_pos_transaction_number(
    p_organization_id, COALESCE(v_register_code, 'REG'));
  v_snapshot := jsonb_build_object(
    'items_submitted', p_items, 'items_resolved', v_resolved_items,
    'payments', p_payments,
    'client_totals', jsonb_build_object('subtotal', p_subtotal, 'tax_amount', p_tax_amount,
      'discount_amount', p_discount_amount, 'total', p_total),
    'server_totals', jsonb_build_object('subtotal', v_srv_subtotal, 'tax_amount', v_srv_total_tax,
      'discount_amount', v_srv_total_discount, 'total', v_srv_total),
    'committed_at', now());

  INSERT INTO public.pos_transactions (
    id, organization_id, business_id, branch_id, register_id, shift_id, transaction_number,
    transaction_type, original_transaction_id, subtotal, tax_amount, discount_amount, total, tip_amount,
    payment_status, customer_id, customer_tin, customer_name, notes, cashier_id, created_by,
    table_session_id, status, completed_at, created_at, idempotency_key, snapshot
  ) VALUES (
    gen_random_uuid(), v_register_org_id, v_register_business_id, v_register_branch_id,
    p_register_id, p_shift_id, v_transaction_number, p_transaction_type, p_original_transaction_id,
    v_srv_subtotal, v_srv_total_tax, v_srv_total_discount, v_srv_total, COALESCE(p_tip_amount, 0),
    v_payment_status, p_customer_id, p_customer_tin, p_customer_name, p_notes,
    p_cashier_id, COALESCE(p_created_by, p_cashier_id), p_table_session_id,
    'completed', now(), now(), p_idempotency_key, v_snapshot
  ) RETURNING id INTO v_transaction_id;

  v_item_index := 0;
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_resolved_items) LOOP
    v_product_id := NULLIF(v_item->>'product_id', '')::uuid;
    v_quantity := COALESCE((v_item->>'quantity')::numeric, 0);
    v_packaging_id := NULLIF(v_item->>'packaging_id', '')::uuid;
    v_display_uom_id := NULLIF(v_item->>'display_uom_id', '')::uuid;
    v_display_quantity := NULLIF(v_item->>'display_quantity','')::numeric;
    v_item_unit_cost := COALESCE((v_item->>'cost_price')::numeric, 0);

    v_is_lot_tracked := false; v_track_inventory := false;
    IF v_product_id IS NOT NULL THEN
      SELECT COALESCE(is_lot_tracked,false), track_inventory
        INTO v_is_lot_tracked, v_track_inventory
        FROM public.products WHERE id = v_product_id
          AND organization_id = v_register_org_id AND business_id = v_register_business_id;
    END IF;

    v_item_allocs := NULL;
    IF p_transaction_type = 'sale' AND v_is_lot_tracked AND COALESCE(v_track_inventory,false)
       AND v_quantity > 0 AND v_default_warehouse_id IS NOT NULL THEN
      IF (v_item ? 'lot_allocations')
         AND jsonb_typeof(v_item->'lot_allocations') = 'array'
         AND jsonb_array_length(v_item->'lot_allocations') > 0 THEN
        v_item_allocs := v_item->'lot_allocations';
        SELECT COALESCE(SUM((e->>'qty')::numeric), 0) INTO v_alloc_sum
          FROM jsonb_array_elements(v_item_allocs) AS e;
        IF v_alloc_sum <> v_quantity THEN
          RAISE EXCEPTION 'POS lot_allocations sum (%) must equal quantity (%) for product %',
            v_alloc_sum, v_quantity, v_product_id USING ERRCODE = 'check_violation';
        END IF;
      ELSE
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                  'lot_number', r.lot_number, 'serial_number', r.serial_number, 'qty', r.qty)), '[]'::jsonb)
          INTO v_item_allocs
          FROM public.resolve_fefo_lots(v_register_business_id, v_default_warehouse_id, v_product_id, v_quantity) r;
        IF v_item_allocs IS NULL OR jsonb_array_length(v_item_allocs) = 0 THEN
          RAISE EXCEPTION 'No lots available to fulfil sale of % unit(s) of product %',
            v_quantity, v_product_id USING ERRCODE='no_data_found';
        END IF;
      END IF;
    END IF;

    v_line_payload := jsonb_build_object(
      'product_id', v_product_id, 'description', v_item->>'name',
      'quantity', v_quantity, 'unit_price', (v_item->>'unit_price')::numeric,
      'discount_type', v_item->>'discount_type',
      'discount_value', COALESCE((v_item->>'discount_value')::numeric, 0),
      'tax_rate', COALESCE((v_item->>'tax_rate')::numeric, 0),
      'tax_amount', COALESCE((v_item->>'tax_amount')::numeric, 0),
      'line_total', (v_item->>'line_total')::numeric,
      'cost_price', v_item_unit_cost, 'sort_order', v_item_index,
      'tax_rate_id', v_item->>'tax_rate_id', 'etims_tax_code', v_item->>'etims_tax_code',
      'packaging_id', v_packaging_id, 'display_uom_id', v_display_uom_id,
      'display_quantity', v_display_quantity, 'lot_allocations', v_item_allocs);
    PERFORM public._pos_insert_line(v_transaction_id, v_line_payload);

    IF v_product_id IS NOT NULL AND COALESCE(v_track_inventory,false) THEN
      IF v_default_warehouse_id IS NULL THEN
        RAISE EXCEPTION 'No active warehouse found for POS register branch % — create a branch warehouse before selling tracked inventory', v_register_branch_id
          USING ERRCODE = 'check_violation';
      END IF;
      PERFORM public._pos_apply_lot_consumption(
        v_register_org_id, v_register_business_id, v_register_branch_id, v_default_warehouse_id,
        v_product_id, v_transaction_id, v_transaction_number,
        COALESCE(p_created_by, p_cashier_id),
        v_item_allocs, v_quantity, v_item_unit_cost, v_is_lot_tracked,
        CASE WHEN p_transaction_type = 'return' THEN 'in' ELSE 'out' END,
        v_packaging_id, v_display_uom_id);
    END IF;
    v_item_index := v_item_index + 1;
  END LOOP;

  FOR v_payment IN SELECT * FROM jsonb_array_elements(p_payments) LOOP
    PERFORM public._pos_record_payment(
      v_transaction_id, v_register_org_id, v_register_business_id, v_register_branch_id,
      v_payment);
  END LOOP;

  UPDATE public.pos_shifts SET
    total_sales = total_sales + CASE WHEN p_transaction_type = 'sale' THEN v_srv_total ELSE 0 END,
    total_returns = total_returns + CASE WHEN p_transaction_type = 'return' THEN v_srv_total ELSE 0 END,
    total_transactions = total_transactions + 1,
    cash_payments = cash_payments + v_cash_total,
    card_payments = card_payments + (v_total_paid - v_cash_total),
    expected_cash = COALESCE(expected_cash, 0) + v_cash_total,
    updated_at = now()
  WHERE id = p_shift_id AND organization_id = v_register_org_id
    AND business_id = v_register_business_id AND branch_id = v_register_branch_id;

  DELETE FROM public.pos_stock_reservations WHERE register_id = p_register_id;

  IF p_table_session_id IS NOT NULL THEN
    UPDATE public.pos_table_sessions SET status = 'completed', closed_at = now(),
      total_amount = v_srv_total, updated_at = now() WHERE id = p_table_session_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'idempotent_replay', false,
    'transaction_id', v_transaction_id, 'transaction_number', v_transaction_number,
    'change', v_total_change, 'tendered', v_total_tendered,
    'branch_id', v_register_branch_id, 'business_id', v_register_business_id,
    'server_totals', jsonb_build_object('subtotal', v_srv_subtotal, 'tax_amount', v_srv_total_tax,
      'discount_amount', v_srv_total_discount, 'total', v_srv_total),
    'client_totals', jsonb_build_object('subtotal', p_subtotal, 'tax_amount', p_tax_amount,
      'discount_amount', p_discount_amount, 'total', p_total),
    'total_matches_server', ABS(COALESCE(p_total,0) - v_srv_total) <= 0.01);
END $$;

-- ── 3. process_pos_return (T6-complete + T6b advisory lock)  ──────────────────
CREATE FUNCTION public.process_pos_return(
  p_organization_id uuid, p_register_id uuid, p_shift_id uuid,
  p_original_transaction_id uuid, p_items jsonb, p_refund_method text,
  p_notes text, p_created_by uuid, p_override_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_transaction_id UUID; v_transaction_number TEXT; v_register_code TEXT;
  v_register_branch_id UUID; v_register_business_id UUID; v_register_org_id UUID;
  v_default_warehouse_id UUID; v_item JSONB;
  v_product_id UUID; v_quantity NUMERIC; v_track_inventory BOOLEAN;
  v_subtotal NUMERIC := 0; v_tax_amount NUMERIC := 0; v_total NUMERIC := 0;
  v_item_index INT := 0; v_original_status TEXT; v_original_business_id UUID;
  v_original_item_id UUID; v_returnable NUMERIC; v_item_total NUMERIC; v_item_tax NUMERIC;
  v_reason_id UUID; v_reason_code TEXT; v_reason_requires_note BOOLEAN;
  v_reason_requires_override BOOLEAN; v_reason_note TEXT;
  v_unit_price NUMERIC; v_tax_rate NUMERIC; v_cost_price NUMERIC; v_description TEXT;
  v_refund_tender TEXT; v_is_cross_tender BOOLEAN := false;
  v_any_reason_needs_override BOOLEAN := false; v_override_reason_codes TEXT := '';
  v_is_lot_tracked boolean; v_orig_allocs jsonb; v_return_allocs jsonb;
  v_orig_qty numeric; v_remaining numeric; v_take numeric; v_elem jsonb;
  v_line_payload jsonb;
BEGIN
  SELECT register_code, branch_id, business_id, organization_id
    INTO v_register_code, v_register_branch_id, v_register_business_id, v_register_org_id
  FROM public.pos_registers WHERE id = p_register_id;
  IF v_register_code IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_register', 'details', 'Register not found');
  END IF;
  IF v_register_org_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'Register % belongs to a different organization than supplied', p_register_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_register_branch_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_register', 'details', 'Register has no branch context');
  END IF;
  PERFORM public.assert_pos_caller_branch_access(v_register_branch_id);

  SELECT status, business_id INTO v_original_status, v_original_business_id
  FROM public.pos_transactions
  WHERE id = p_original_transaction_id AND organization_id = p_organization_id;
  IF v_original_status IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'original_not_found', 'details', 'Original transaction not found');
  END IF;
  IF v_original_status = 'voided' THEN
    RETURN jsonb_build_object('success', false, 'error', 'original_voided', 'details', 'Cannot return a voided transaction');
  END IF;
  IF v_original_status != 'completed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_status',
      'details', 'Original transaction is not completed (status: ' || v_original_status || ')');
  END IF;
  IF v_original_business_id IS DISTINCT FROM v_register_business_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'cross_company_return',
      'details', 'Original transaction belongs to a different company than this register');
  END IF;

  v_refund_tender := CASE WHEN p_refund_method = 'store_credit' THEN 'voucher' ELSE p_refund_method END;
  SELECT NOT EXISTS (SELECT 1 FROM public.pos_transaction_payments
     WHERE transaction_id = p_original_transaction_id AND payment_method = v_refund_tender
       AND COALESCE(status, 'completed') = 'completed') INTO v_is_cross_tender;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_original_item_id := (v_item->>'original_item_id')::UUID;
    v_quantity := (v_item->>'quantity')::NUMERIC;
    IF v_original_item_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'missing_original_item',
        'details', 'Each return line must reference an original_item_id');
    END IF;
    IF v_quantity IS NULL OR v_quantity <= 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_quantity',
        'details', 'Return quantity must be greater than zero');
    END IF;
    SELECT returnable_qty INTO v_returnable FROM public.v_pos_returnable_qty
    WHERE original_item_id = v_original_item_id AND original_transaction_id = p_original_transaction_id;
    IF v_returnable IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'item_not_found',
        'details', 'Original item not found on this transaction');
    END IF;
    IF v_quantity > v_returnable THEN
      RETURN jsonb_build_object('success', false, 'error', 'over_return',
        'details', format('Cannot return %s — only %s remaining for this line', v_quantity, v_returnable));
    END IF;
    v_reason_id := NULLIF(v_item->>'return_reason_id','')::UUID;
    IF v_reason_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'missing_reason',
        'details', 'A return reason is required for every line');
    END IF;
    SELECT code, requires_note, requires_manager_override
      INTO v_reason_code, v_reason_requires_note, v_reason_requires_override
    FROM public.pos_return_reasons WHERE id = v_reason_id AND is_active = true;
    IF v_reason_code IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_reason',
        'details', 'Selected return reason is not valid');
    END IF;
    v_reason_note := NULLIF(trim(coalesce(v_item->>'return_reason_note','')), '');
    IF v_reason_requires_note AND v_reason_note IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'reason_note_required',
        'details', format('Reason "%s" requires an explanatory note', v_reason_code));
    END IF;
    IF NOT v_reason_requires_note AND v_reason_note IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'reason_note_not_allowed',
        'details', 'Free-text note only allowed for reasons that require a note');
    END IF;
    IF COALESCE(v_reason_requires_override, false) THEN
      v_any_reason_needs_override := true;
      IF position(v_reason_code IN v_override_reason_codes) = 0 THEN
        v_override_reason_codes := v_override_reason_codes ||
          CASE WHEN v_override_reason_codes = '' THEN '' ELSE ',' END || v_reason_code;
      END IF;
    END IF;
    SELECT unit_price, tax_rate INTO v_unit_price, v_tax_rate
    FROM public.v_pos_returnable_qty WHERE original_item_id = v_original_item_id;
    v_item_total := v_unit_price * v_quantity;
    v_item_tax := v_item_total * COALESCE(v_tax_rate, 0) / 100;
    v_subtotal := v_subtotal + v_item_total;
    v_tax_amount := v_tax_amount + v_item_tax;
  END LOOP;
  v_total := v_subtotal + v_tax_amount;

  IF v_any_reason_needs_override AND p_override_id IS NULL THEN
    RAISE EXCEPTION 'override_required' USING ERRCODE = 'check_violation',
      HINT = format('Reason(s) %s require manager approval', v_override_reason_codes),
      DETAIL = 'reason_requires_override';
  END IF;

  IF v_is_cross_tender THEN
    PERFORM public.assert_manager_override('cross_tender_refund', v_total, p_organization_id,
      v_register_business_id, p_shift_id, p_override_id, 'pos_transactions', NULL);
  ELSE
    PERFORM public.assert_manager_override('refund', v_total, p_organization_id,
      v_register_business_id, p_shift_id, p_override_id, 'pos_transactions', NULL);
  END IF;

  v_default_warehouse_id := public._pos_resolve_branch_warehouse(
    v_register_org_id, v_register_business_id, v_register_branch_id, p_shift_id);
  v_transaction_number := public.get_next_pos_transaction_number(p_organization_id, v_register_code);

  INSERT INTO public.pos_transactions (
    id, organization_id, business_id, branch_id, register_id, shift_id, transaction_number,
    transaction_type, original_transaction_id, subtotal, tax_amount, discount_amount, total,
    payment_status, status, completed_at, created_by, notes, created_at
  ) VALUES (
    gen_random_uuid(), p_organization_id, v_register_business_id, v_register_branch_id,
    p_register_id, p_shift_id, v_transaction_number, 'return', p_original_transaction_id,
    v_subtotal, v_tax_amount, 0, v_total, 'refunded', 'completed', now(), p_created_by,
    COALESCE(p_notes, '') || ' Return for txn ' || p_original_transaction_id::TEXT, now()
  ) RETURNING id INTO v_transaction_id;

  IF p_override_id IS NOT NULL THEN
    UPDATE public.pos_manager_overrides SET consumed_ref_id = v_transaction_id,
      transaction_id = v_transaction_id, amount = v_total,
      metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'original_transaction_id', p_original_transaction_id,
        'refund_tender', v_refund_tender, 'is_cross_tender', v_is_cross_tender,
        'reason_required_override', v_any_reason_needs_override,
        'override_reason_codes', v_override_reason_codes)
     WHERE id = p_override_id;
  END IF;

  v_item_index := 0;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_original_item_id := (v_item->>'original_item_id')::UUID;
    v_quantity := (v_item->>'quantity')::NUMERIC;
    v_reason_id := (v_item->>'return_reason_id')::UUID;
    v_reason_note := NULLIF(trim(coalesce(v_item->>'return_reason_note','')), '');
    SELECT product_id, unit_price, tax_rate, cost_price, description
      INTO v_product_id, v_unit_price, v_tax_rate, v_cost_price, v_description
    FROM public.v_pos_returnable_qty WHERE original_item_id = v_original_item_id;
    v_item_total := v_unit_price * v_quantity;
    v_item_tax := v_item_total * COALESCE(v_tax_rate, 0) / 100;

    v_track_inventory := false;
    IF v_product_id IS NOT NULL AND v_default_warehouse_id IS NOT NULL THEN
      SELECT track_inventory INTO v_track_inventory FROM public.products
       WHERE id = v_product_id
         AND organization_id = p_organization_id
         AND business_id = v_register_business_id;
      -- T6b: mutual exclusion vs sale path on same SKU.
      IF COALESCE(v_track_inventory,false) THEN
        PERFORM pg_advisory_xact_lock(
          hashtextextended(v_product_id::text || ':' || v_default_warehouse_id::text, 0));
      END IF;
    END IF;

    v_is_lot_tracked := false;
    v_return_allocs := NULL;
    IF v_product_id IS NOT NULL THEN
      SELECT COALESCE(is_lot_tracked,false) INTO v_is_lot_tracked
        FROM public.products WHERE id = v_product_id;
    END IF;

    IF v_is_lot_tracked THEN
      SELECT lot_allocations, quantity INTO v_orig_allocs, v_orig_qty
        FROM public.pos_transaction_items WHERE id = v_original_item_id;
      IF v_orig_allocs IS NOT NULL
         AND jsonb_typeof(v_orig_allocs) = 'array'
         AND jsonb_array_length(v_orig_allocs) > 0 THEN
        v_remaining := v_quantity;
        v_return_allocs := '[]'::jsonb;
        FOR v_elem IN SELECT * FROM jsonb_array_elements(v_orig_allocs) LOOP
          EXIT WHEN v_remaining <= 0;
          v_take := LEAST(v_remaining, COALESCE((v_elem->>'qty')::numeric, 0));
          IF v_take > 0 THEN
            v_return_allocs := v_return_allocs || jsonb_build_array(jsonb_build_object(
              'lot_number',  v_elem->>'lot_number',
              'serial_number', v_elem->>'serial_number',
              'qty', v_take));
            v_remaining := v_remaining - v_take;
          END IF;
        END LOOP;
        IF v_remaining > 0 THEN
          RAISE EXCEPTION 'Original lot allocations cannot cover return qty % for product %', v_quantity, v_product_id
            USING ERRCODE='check_violation';
        END IF;
      END IF;
    END IF;

    v_line_payload := jsonb_build_object(
      'product_id', v_product_id, 'description', v_description,
      'quantity', v_quantity, 'unit_price', v_unit_price,
      'discount_type', NULL, 'discount_value', 0,
      'tax_rate', COALESCE(v_tax_rate, 0), 'tax_amount', v_item_tax,
      'line_total', v_item_total + v_item_tax,
      'cost_price', v_cost_price, 'sort_order', v_item_index,
      'original_item_id', v_original_item_id,
      'return_reason_id', v_reason_id,
      'return_reason_note', v_reason_note,
      'lot_allocations', v_return_allocs);
    PERFORM public._pos_insert_line(v_transaction_id, v_line_payload);

    IF v_product_id IS NOT NULL AND COALESCE(v_track_inventory, false) THEN
      IF v_default_warehouse_id IS NULL THEN
        RAISE EXCEPTION 'No active warehouse for POS register branch %; create one before processing returns', v_register_branch_id
          USING ERRCODE = 'check_violation';
      END IF;
      PERFORM public._pos_apply_lot_consumption(
        p_organization_id, v_register_business_id, v_register_branch_id, v_default_warehouse_id,
        v_product_id, v_transaction_id, v_transaction_number, p_created_by,
        v_return_allocs, v_quantity, COALESCE(v_cost_price, 0),
        v_is_lot_tracked, 'in', NULL, NULL);
    END IF;
    v_item_index := v_item_index + 1;
  END LOOP;

  PERFORM public._pos_record_payment(
    v_transaction_id, p_organization_id, v_register_business_id, v_register_branch_id,
    jsonb_build_object(
      'payment_method', v_refund_tender,
      'amount', -v_total,
      'reference', 'Refund - ' || v_transaction_number,
      'status', 'completed'));

  IF p_refund_method = 'cash' THEN
    UPDATE public.pos_shifts SET expected_cash = COALESCE(expected_cash, 0) - v_total,
      total_returns = COALESCE(total_returns, 0) + v_total, updated_at = now() WHERE id = p_shift_id;
  ELSE
    UPDATE public.pos_shifts SET total_returns = COALESCE(total_returns, 0) + v_total,
      updated_at = now() WHERE id = p_shift_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'transaction_id', v_transaction_id,
    'transaction_number', v_transaction_number, 'refund_amount', v_total,
    'business_id', v_register_business_id, 'branch_id', v_register_branch_id,
    'cross_tender', v_is_cross_tender, 'reason_required_override', v_any_reason_needs_override);
END $$;

-- ── 4. T7: payment.received topic + trigger ──────────────────────────────────
INSERT INTO public.business_event_topics (topic_prefix, description, producer_domain, consumer_domains)
VALUES ('payment.received',
        'A POS payment line was completed (tender applied to a sale or return).',
        'pos', ARRAY['finance','analytics','crm'])
ON CONFLICT (topic_prefix) DO UPDATE
  SET description = EXCLUDED.description,
      producer_domain = EXCLUDED.producer_domain,
      consumer_domains = EXCLUDED.consumer_domains;

CREATE OR REPLACE FUNCTION public.trg_pos_payment_emit_event_fn()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_txn RECORD;
BEGIN
  IF COALESCE(NEW.status, 'completed') <> 'completed' THEN
    RETURN NULL;
  END IF;
  SELECT organization_id, business_id, branch_id, transaction_number, transaction_type
    INTO v_txn FROM public.pos_transactions WHERE id = NEW.transaction_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO public.business_event_outbox (
    org_id, branch_id, event_type, source_doc_type, source_doc_id,
    payload, status, idempotency_key, actor_user_id, source
  ) VALUES (
    v_txn.organization_id, v_txn.branch_id, 'payment.received',
    'pos_transaction', NEW.transaction_id,
    jsonb_build_object(
      'payment_id', NEW.id, 'transaction_id', NEW.transaction_id,
      'transaction_number', v_txn.transaction_number,
      'transaction_type', v_txn.transaction_type,
      'business_id', v_txn.business_id, 'branch_id', v_txn.branch_id,
      'payment_method', NEW.payment_method, 'amount', NEW.amount,
      'tendered_amount', NEW.tendered_amount, 'change_given', NEW.change_given,
      'reference', NEW.reference, 'mpesa_receipt_number', NEW.mpesa_receipt_number,
      'processed_at', NEW.processed_at),
    'pending',
    'payment.received:' || NEW.id::text,
    NULL, 'pos_transaction_payments'
  ) ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_pos_payment_emit_event ON public.pos_transaction_payments;
CREATE TRIGGER trg_pos_payment_emit_event
AFTER INSERT ON public.pos_transaction_payments
FOR EACH ROW EXECUTE FUNCTION public.trg_pos_payment_emit_event_fn();

COMMENT ON FUNCTION public._pos_insert_line(uuid, jsonb) IS
  'POS Transaction Engine helper (T6). Single source of truth for pos_transaction_items writes.';
COMMENT ON FUNCTION public._pos_record_payment(uuid, uuid, uuid, uuid, jsonb) IS
  'POS Transaction Engine helper (T6). Single source of truth for pos_transaction_payments writes.';
COMMENT ON FUNCTION public._pos_apply_lot_consumption(uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, jsonb, numeric, numeric, boolean, text, uuid, uuid) IS
  'POS Transaction Engine helper (T6). Routes outbound sale (lot-aware) and inbound return (per-allocation) movements through one path.';
COMMENT ON FUNCTION public.trg_pos_payment_emit_event_fn() IS
  'Emits payment.received outbox event per completed pos_transaction_payments row. Idempotency key: payment.received:<payment_id>.';
