
-- ============================================================
-- Batch T4 · POS Transaction Engine — Pessimistic availability
-- ============================================================
-- The prior availability check inside process_pos_transaction was a
-- plain aggregate SELECT with no row locking. Two concurrent
-- terminals could each pass the check for the last unit of a SKU and
-- both commit stock_movements, driving on-hand negative.
--
-- Fix: at the top of the availability loop, acquire a *transactional*
-- advisory lock keyed on (product_id, warehouse_id). The lock is
-- released automatically at COMMIT/ROLLBACK. Concurrent commits
-- against the same SKU serialise; the second one re-runs the check
-- with the first's stock_movements insert already visible and either
-- passes (still enough on-hand) or returns insufficient_stock.
--
-- Implementation notes:
--   * We use pg_advisory_xact_lock(hashtextextended(...)) rather than
--     SELECT … FOR UPDATE on warehouse_stock because warehouse_stock
--     rows are lazily created; not every (product, warehouse) has a
--     row yet. Advisory locks give us serialisation without requiring
--     row existence.
--   * Every other stage (money math, lot allocation, GL) still runs
--     inside the same Postgres transaction, so the lock protects the
--     whole check-then-act critical section.
--   * pos_stock_reservations is already the unified view (T3), so the
--     reservation subtraction reads generic stock_reservations
--     (source_type='pos') transparently.

CREATE OR REPLACE FUNCTION public.process_pos_transaction(
  p_organization_id uuid, p_business_id uuid, p_register_id uuid,
  p_shift_id uuid, p_items jsonb, p_payments jsonb,
  p_subtotal numeric, p_tax_amount numeric, p_discount_amount numeric,
  p_total numeric, p_transaction_type text DEFAULT 'sale'::text,
  p_customer_id uuid DEFAULT NULL::uuid, p_customer_tin text DEFAULT NULL::text,
  p_customer_name text DEFAULT NULL::text, p_notes text DEFAULT NULL::text,
  p_cashier_id uuid DEFAULT NULL::uuid, p_created_by uuid DEFAULT NULL::uuid,
  p_original_transaction_id uuid DEFAULT NULL::uuid, p_tip_amount numeric DEFAULT 0,
  p_table_session_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_transaction_id uuid; v_transaction_number text; v_register_code text;
  v_register_branch_id uuid; v_register_business_id uuid; v_register_org_id uuid;
  v_shift_warehouse_id uuid; v_default_warehouse_id uuid;
  v_item jsonb; v_payment jsonb; v_product_id uuid; v_quantity numeric;
  v_track_inventory boolean; v_on_hand numeric; v_reserved numeric;
  v_total_paid numeric := 0; v_total_tendered numeric := 0; v_total_change numeric := 0;
  v_cash_total numeric := 0; v_payment_status text := 'paid';
  v_item_index integer := 0; v_existing record; v_insufficient jsonb := '[]'::jsonb;
  v_product_name text; v_snapshot jsonb;
  v_p_amount numeric; v_p_tendered numeric; v_p_change numeric; v_p_method text;
  v_packaging_id uuid; v_display_uom_id uuid; v_display_quantity numeric;
  v_is_lot_tracked boolean; v_item_allocs jsonb; v_alloc_sum numeric;
  v_item_unit_cost numeric; v_new_item_id uuid;
  -- Batch T1 additions
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
  c_tolerance CONSTANT numeric := 0.01;
BEGIN
  -- --- Idempotent replay ---
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

  -- --- Register / branch resolution + branch caller assertion ---
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

  SELECT warehouse_id INTO v_shift_warehouse_id FROM public.pos_shifts
  WHERE id = p_shift_id AND organization_id = v_register_org_id
    AND business_id = v_register_business_id AND register_id = p_register_id;
  v_default_warehouse_id := v_shift_warehouse_id;
  IF v_default_warehouse_id IS NULL THEN
    SELECT id INTO v_default_warehouse_id FROM public.warehouses
     WHERE organization_id = v_register_org_id AND business_id = v_register_business_id
       AND branch_id = v_register_branch_id AND is_active = true
       AND COALESCE(is_in_transit, false) = false
     ORDER BY is_default DESC, created_at ASC LIMIT 1;
  END IF;

  -- ============================================================
  --  Batch T4 · Pessimistic stock availability
  -- ============================================================
  -- For every tracked line, acquire a transactional advisory lock
  -- keyed to (product_id, warehouse_id) BEFORE reading on-hand /
  -- reservations. Concurrent process_pos_transaction calls against
  -- the same SKU serialise here; the loser sees the winner's
  -- stock_movements insert and correctly reports insufficient_stock.
  -- Lock is released on COMMIT/ROLLBACK.
  IF p_transaction_type <> 'return' AND v_default_warehouse_id IS NOT NULL THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
      v_product_id := NULLIF(v_item->>'product_id', '')::uuid;
      v_quantity := COALESCE((v_item->>'quantity')::numeric, 0);
      IF v_product_id IS NULL OR v_quantity <= 0 THEN CONTINUE; END IF;

      SELECT track_inventory, COALESCE(NULLIF(name,''), '') INTO v_track_inventory, v_product_name
      FROM public.products WHERE id = v_product_id
        AND organization_id = v_register_org_id AND business_id = v_register_business_id;
      IF v_track_inventory IS NOT TRUE THEN CONTINUE; END IF;

      -- T4: pessimistic per-(product, warehouse) lock. hashtextextended
      -- returns bigint, exactly what pg_advisory_xact_lock expects.
      PERFORM pg_advisory_xact_lock(
        hashtextextended(v_product_id::text || ':' || v_default_warehouse_id::text, 0)
      );

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

  -- --- Payment aggregation & validation ---
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

  -- ============================================================
  --  Batch T1 · Server-authoritative money math (unchanged)
  -- ============================================================
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
      v_req_unit_price, v_req_discount_type, v_req_discount_value
    );

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
         WHERE id = v_override_id
           AND organization_id = v_register_org_id
           AND (business_id IS NULL OR business_id = v_register_business_id)
           AND status = 'approved'
           AND consumed_at IS NULL
         LIMIT 1;
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
      'product_id', v_product_id,
      'quantity', v_quantity,
      'unit_price', v_srv_unit_price,
      'discount_type', v_req_discount_type,
      'discount_value', v_req_discount_value,
      'discount_amount', v_srv_discount_amount,
      'tax_rate', v_srv_tax_rate,
      'tax_rate_id', v_srv_tax_rate_id,
      'tax_amount', v_srv_tax_amount,
      'line_total', v_srv_line_total,
      'etims_tax_code', v_item->>'etims_tax_code',
      'name', v_item->>'name',
      'cost_price', COALESCE((v_item->>'cost_price')::numeric, 0),
      'packaging_id', NULLIF(v_item->>'packaging_id','')::uuid,
      'display_uom_id', NULLIF(v_item->>'display_uom_id','')::uuid,
      'display_quantity', NULLIF(v_item->>'display_quantity','')::numeric,
      'lot_allocations', v_item->'lot_allocations',
      'manager_override_id', v_override_id
    );

    IF v_override_id IS NOT NULL AND v_override.id IS NOT NULL THEN
      UPDATE public.pos_manager_overrides
         SET consumed_at = now(), consumed_table = 'pos_transactions'
       WHERE id = v_override_id AND consumed_at IS NULL;
    END IF;
  END LOOP;

  v_payment_status := CASE
    WHEN v_total_paid + 0.005 >= v_srv_total THEN 'paid'
    ELSE 'partial' END;

  v_transaction_number := public.get_next_pos_transaction_number(
    p_organization_id, COALESCE(v_register_code, 'REG'));
  v_snapshot := jsonb_build_object(
    'items_submitted', p_items,
    'items_resolved', v_resolved_items,
    'payments', p_payments,
    'client_totals', jsonb_build_object(
      'subtotal', p_subtotal, 'tax_amount', p_tax_amount,
      'discount_amount', p_discount_amount, 'total', p_total),
    'server_totals', jsonb_build_object(
      'subtotal', v_srv_subtotal, 'tax_amount', v_srv_total_tax,
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

    v_is_lot_tracked := false;
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
                  'lot_number', r.lot_number,
                  'serial_number', r.serial_number,
                  'qty', r.qty)), '[]'::jsonb)
          INTO v_item_allocs
          FROM public.resolve_fefo_lots(v_register_business_id, v_default_warehouse_id, v_product_id, v_quantity) r;
        IF v_item_allocs IS NULL OR jsonb_array_length(v_item_allocs) = 0 THEN
          RAISE EXCEPTION 'No lots available to fulfil sale of % unit(s) of product %',
            v_quantity, v_product_id USING ERRCODE='no_data_found';
        END IF;
      END IF;
    END IF;

    INSERT INTO public.pos_transaction_items (
      transaction_id, product_id, description, quantity, unit_price, discount_type, discount_value,
      tax_rate, tax_amount, line_total, cost_price, sort_order, tax_rate_id, etims_tax_code,
      packaging_id, display_uom_id, display_quantity, lot_allocations
    ) VALUES (
      v_transaction_id, v_product_id, v_item->>'name', v_quantity,
      (v_item->>'unit_price')::numeric, v_item->>'discount_type',
      COALESCE((v_item->>'discount_value')::numeric, 0),
      COALESCE((v_item->>'tax_rate')::numeric, 0),
      COALESCE((v_item->>'tax_amount')::numeric, 0),
      (v_item->>'line_total')::numeric, v_item_unit_cost,
      v_item_index, NULLIF(v_item->>'tax_rate_id', '')::uuid, v_item->>'etims_tax_code',
      v_packaging_id, v_display_uom_id, v_display_quantity, v_item_allocs
    ) RETURNING id INTO v_new_item_id;

    IF v_product_id IS NOT NULL AND COALESCE(v_track_inventory,false) THEN
      IF v_default_warehouse_id IS NULL THEN
        RAISE EXCEPTION 'No active warehouse found for POS register branch % — create a branch warehouse before selling tracked inventory', v_register_branch_id
          USING ERRCODE = 'check_violation';
      END IF;

      IF p_transaction_type = 'sale' AND v_is_lot_tracked THEN
        PERFORM public.consume_lots_atomic(
          v_register_org_id, v_register_business_id, v_default_warehouse_id, v_register_branch_id,
          v_product_id, 'pos_sale', 'pos_transaction', v_transaction_id,
          COALESCE(p_created_by, p_cashier_id),
          'POS Sale: ' || v_transaction_number,
          v_item_allocs, v_item_unit_cost
        );
      ELSE
        INSERT INTO public.stock_movements (
          organization_id, business_id, branch_id, product_id, warehouse_id,
          movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by, movement_date,
          source_packaging_id, source_uom_id
        ) VALUES (
          v_register_org_id, v_register_business_id, v_register_branch_id,
          v_product_id, v_default_warehouse_id,
          CASE WHEN p_transaction_type = 'return' THEN 'pos_return' ELSE 'pos_sale' END,
          CASE WHEN p_transaction_type = 'return' THEN v_quantity ELSE -v_quantity END,
          v_item_unit_cost,
          'pos_transaction', v_transaction_id,
          CASE WHEN p_transaction_type = 'return' THEN 'POS Return: ' ELSE 'POS Sale: ' END || v_transaction_number,
          COALESCE(p_created_by, p_cashier_id), now(),
          v_packaging_id, v_display_uom_id);
      END IF;
    END IF;
    v_item_index := v_item_index + 1;
  END LOOP;

  FOR v_payment IN SELECT * FROM jsonb_array_elements(p_payments) LOOP
    v_p_method := v_payment->>'payment_method';
    v_p_amount := COALESCE((v_payment->>'amount')::numeric, 0);
    v_p_tendered := COALESCE((v_payment->>'tendered_amount')::numeric, v_p_amount);
    v_p_change := COALESCE((v_payment->>'change_given')::numeric, GREATEST(0, v_p_tendered - v_p_amount));
    INSERT INTO public.pos_transaction_payments (
      transaction_id, payment_method, amount, tendered_amount, change_given, reference,
      card_last_four, card_type, mpesa_receipt_number, status, processed_at
    ) VALUES (
      v_transaction_id, v_p_method, v_p_amount, v_p_tendered, v_p_change,
      v_payment->>'reference', v_payment->>'card_last_four', v_payment->>'card_type',
      v_payment->>'mpesa_receipt_number', 'completed', now());
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
    'server_totals', jsonb_build_object(
      'subtotal', v_srv_subtotal, 'tax_amount', v_srv_total_tax,
      'discount_amount', v_srv_total_discount, 'total', v_srv_total),
    'client_totals', jsonb_build_object(
      'subtotal', p_subtotal, 'tax_amount', p_tax_amount,
      'discount_amount', p_discount_amount, 'total', p_total),
    'total_matches_server',
      ABS(COALESCE(p_total,0) - v_srv_total) <= 0.01
  );
END $function$;
