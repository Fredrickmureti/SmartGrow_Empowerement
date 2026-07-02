CREATE OR REPLACE FUNCTION public.process_pos_transaction(p_organization_id uuid, p_business_id uuid, p_register_id uuid, p_shift_id uuid, p_items jsonb, p_payments jsonb, p_subtotal numeric, p_tax_amount numeric, p_discount_amount numeric, p_total numeric, p_transaction_type text DEFAULT 'sale'::text, p_customer_id uuid DEFAULT NULL::uuid, p_customer_tin text DEFAULT NULL::text, p_customer_name text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_cashier_id uuid DEFAULT NULL::uuid, p_created_by uuid DEFAULT NULL::uuid, p_original_transaction_id uuid DEFAULT NULL::uuid, p_tip_amount numeric DEFAULT 0, p_table_session_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_transaction_id uuid;
  v_transaction_number text;
  v_register_code text;
  v_register_branch_id uuid;
  v_register_business_id uuid;
  v_register_org_id uuid;
  v_shift_warehouse_id uuid;
  v_default_warehouse_id uuid;
  v_item jsonb;
  v_payment jsonb;
  v_product_id uuid;
  v_quantity numeric;
  v_track_inventory boolean;
  v_on_hand numeric;
  v_reserved numeric;
  v_total_paid numeric := 0;
  v_cash_total numeric := 0;
  v_payment_status text := 'paid';
  v_item_index integer := 0;
  v_existing record;
  v_insufficient jsonb := '[]'::jsonb;
  v_product_name text;
  v_currency text;
  v_snapshot jsonb;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id, transaction_number, branch_id, business_id, total
      INTO v_existing
    FROM public.pos_transactions
    WHERE organization_id = p_organization_id
      AND business_id     = p_business_id
      AND register_id     = p_register_id
      AND idempotency_key = p_idempotency_key
    LIMIT 1;

    IF v_existing.id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'success', true, 'idempotent_replay', true,
        'transaction_id', v_existing.id,
        'transaction_number', v_existing.transaction_number,
        'change', 0,
        'branch_id', v_existing.branch_id,
        'business_id', v_existing.business_id
      );
    END IF;
  END IF;

  SELECT register_code, branch_id, business_id, organization_id
    INTO v_register_code, v_register_branch_id, v_register_business_id, v_register_org_id
  FROM public.pos_registers
  WHERE id = p_register_id;

  IF v_register_code IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Register not found');
  END IF;

  IF v_register_org_id IS DISTINCT FROM p_organization_id
     OR v_register_business_id IS DISTINCT FROM p_business_id THEN
    RAISE EXCEPTION 'Register % belongs to a different organization/business than supplied (org=%, biz=% vs supplied org=%, biz=%)',
      p_register_id, v_register_org_id, v_register_business_id, p_organization_id, p_business_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_register_branch_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Register has no branch context');
  END IF;

  IF p_transaction_type = 'sale'
     AND COALESCE(p_total, 0) > 0
     AND (p_payments IS NULL OR jsonb_array_length(p_payments) = 0) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'no_payments',
      'detail', 'A sale with a positive total requires at least one payment line.'
    );
  END IF;

  SELECT warehouse_id INTO v_shift_warehouse_id
  FROM public.pos_shifts
  WHERE id = p_shift_id
    AND organization_id = v_register_org_id
    AND business_id     = v_register_business_id
    AND register_id     = p_register_id;

  v_default_warehouse_id := v_shift_warehouse_id;

  IF v_default_warehouse_id IS NULL THEN
    SELECT id INTO v_default_warehouse_id
    FROM public.warehouses
    WHERE organization_id = v_register_org_id
      AND business_id     = v_register_business_id
      AND branch_id       = v_register_branch_id
      AND is_active       = true
      AND COALESCE(is_in_transit, false) = false
    ORDER BY is_default DESC, created_at ASC
    LIMIT 1;
  END IF;

  IF p_transaction_type <> 'return' AND v_default_warehouse_id IS NOT NULL THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
      v_product_id := NULLIF(v_item->>'product_id', '')::uuid;
      v_quantity   := COALESCE((v_item->>'quantity')::numeric, 0);
      IF v_product_id IS NULL OR v_quantity <= 0 THEN CONTINUE; END IF;

      SELECT track_inventory, name INTO v_track_inventory, v_product_name
      FROM public.products
      WHERE id = v_product_id
        AND organization_id = v_register_org_id
        AND business_id     = v_register_business_id;

      IF COALESCE(v_track_inventory, false) = false THEN CONTINUE; END IF;

      SELECT COALESCE(quantity, 0) INTO v_on_hand
      FROM public.warehouse_stock
      WHERE product_id = v_product_id AND warehouse_id = v_default_warehouse_id
      FOR UPDATE;
      IF v_on_hand IS NULL THEN v_on_hand := 0; END IF;

      SELECT COALESCE(SUM(quantity), 0) INTO v_reserved
      FROM public.pos_stock_reservations
      WHERE product_id  = v_product_id
        AND branch_id   = v_register_branch_id
        AND register_id <> p_register_id
        AND (expires_at IS NULL OR expires_at > now());

      IF (v_on_hand - v_reserved) < v_quantity THEN
        v_insufficient := v_insufficient || jsonb_build_object(
          'product_id', v_product_id,
          'product_name', v_product_name,
          'requested', v_quantity,
          'available', GREATEST(0, v_on_hand - v_reserved)
        );
      END IF;
    END LOOP;

    IF jsonb_array_length(v_insufficient) > 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'insufficient_stock', 'details', v_insufficient);
    END IF;
  END IF;

  SELECT COALESCE(SUM((p->>'amount')::numeric), 0) INTO v_total_paid
  FROM jsonb_array_elements(p_payments) p;

  IF v_total_paid < p_total AND p_transaction_type = 'sale' THEN
    v_payment_status := 'partial';
  END IF;

  v_transaction_number := public.get_next_pos_transaction_number(
    v_register_org_id, COALESCE(v_register_code, 'REG')
  );

  -- Resolve currency for snapshot. Canonical column on businesses is base_currency.
  -- Never silently fall back to a hardcoded code (per no-silent-currency-fallback policy).
  SELECT base_currency INTO v_currency
  FROM public.businesses
  WHERE id = v_register_business_id;

  IF v_currency IS NULL THEN
    RAISE EXCEPTION 'Business % has no base_currency configured; cannot snapshot POS transaction', v_register_business_id
      USING ERRCODE = 'check_violation';
  END IF;

  v_snapshot := jsonb_build_object(
    'schema_version', 1,
    'committed_at', now(),
    'transaction_number', v_transaction_number,
    'transaction_type', p_transaction_type,
    'organization_id', v_register_org_id,
    'business_id', v_register_business_id,
    'branch_id', v_register_branch_id,
    'register_id', p_register_id,
    'register_code', v_register_code,
    'shift_id', p_shift_id,
    'cashier_id', p_cashier_id,
    'currency', v_currency,
    'customer', jsonb_build_object(
      'id', p_customer_id, 'name', p_customer_name, 'tin', p_customer_tin
    ),
    'totals', jsonb_build_object(
      'subtotal', p_subtotal, 'tax', p_tax_amount, 'discount', p_discount_amount,
      'tip', COALESCE(p_tip_amount, 0), 'total', p_total,
      'paid', v_total_paid, 'change', GREATEST(0, v_total_paid - p_total)
    ),
    'items', COALESCE(p_items, '[]'::jsonb),
    'payments', COALESCE(p_payments, '[]'::jsonb),
    'notes', p_notes,
    'idempotency_key', p_idempotency_key
  );

  INSERT INTO public.pos_transactions (
    id, organization_id, business_id, branch_id, register_id, shift_id, transaction_number,
    transaction_type, original_transaction_id,
    subtotal, tax_amount, discount_amount, total, tip_amount,
    payment_status, customer_id, customer_tin, customer_name,
    notes, cashier_id, created_by, table_session_id,
    status, completed_at, created_at, idempotency_key, snapshot
  ) VALUES (
    gen_random_uuid(), v_register_org_id, v_register_business_id, v_register_branch_id,
    p_register_id, p_shift_id, v_transaction_number,
    p_transaction_type, p_original_transaction_id,
    p_subtotal, p_tax_amount, p_discount_amount, p_total, COALESCE(p_tip_amount, 0),
    v_payment_status, p_customer_id, p_customer_tin, p_customer_name,
    p_notes, p_cashier_id, COALESCE(p_created_by, p_cashier_id), p_table_session_id,
    'completed', now(), now(), p_idempotency_key, v_snapshot
  ) RETURNING id INTO v_transaction_id;

  v_item_index := 0;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := NULLIF(v_item->>'product_id', '')::uuid;
    v_quantity   := COALESCE((v_item->>'quantity')::numeric, 0);

    INSERT INTO public.pos_transaction_items (
      transaction_id, product_id, description, quantity,
      unit_price, discount_type, discount_value,
      tax_rate, tax_amount, line_total, cost_price, sort_order,
      tax_rate_id, etims_tax_code
    ) VALUES (
      v_transaction_id, v_product_id, v_item->>'name', v_quantity,
      (v_item->>'unit_price')::numeric, v_item->>'discount_type',
      COALESCE((v_item->>'discount_value')::numeric, 0),
      COALESCE((v_item->>'tax_rate')::numeric, 0),
      COALESCE((v_item->>'tax_amount')::numeric, 0),
      (v_item->>'line_total')::numeric,
      COALESCE((v_item->>'cost_price')::numeric, 0),
      v_item_index,
      NULLIF(v_item->>'tax_rate_id', '')::uuid,
      v_item->>'etims_tax_code'
    );

    IF v_product_id IS NOT NULL THEN
      SELECT track_inventory INTO v_track_inventory
      FROM public.products
      WHERE id = v_product_id
        AND organization_id = v_register_org_id
        AND business_id     = v_register_business_id;

      IF v_track_inventory = true THEN
        IF v_default_warehouse_id IS NULL THEN
          RAISE EXCEPTION 'No active warehouse found for POS register branch % — create a branch warehouse before selling tracked inventory', v_register_branch_id
            USING ERRCODE = 'check_violation';
        END IF;

        INSERT INTO public.stock_movements (
          organization_id, business_id, branch_id, product_id, warehouse_id,
          movement_type, quantity, unit_cost,
          reference_type, reference_id, notes, created_by, movement_date
        ) VALUES (
          v_register_org_id, v_register_business_id, v_register_branch_id,
          v_product_id, v_default_warehouse_id,
          CASE WHEN p_transaction_type = 'return' THEN 'pos_return' ELSE 'pos_sale' END,
          CASE WHEN p_transaction_type = 'return' THEN v_quantity ELSE -v_quantity END,
          COALESCE((v_item->>'cost_price')::numeric, 0),
          'pos_transaction', v_transaction_id,
          CASE WHEN p_transaction_type = 'return' THEN 'POS Return: ' ELSE 'POS Sale: ' END || v_transaction_number,
          COALESCE(p_created_by, p_cashier_id),
          now()
        );
      END IF;
    END IF;

    v_item_index := v_item_index + 1;
  END LOOP;

  FOR v_payment IN SELECT * FROM jsonb_array_elements(p_payments)
  LOOP
    INSERT INTO public.pos_transaction_payments (
      transaction_id, payment_method, amount, reference,
      card_last_four, card_type, mpesa_receipt_number, status, processed_at
    ) VALUES (
      v_transaction_id,
      v_payment->>'payment_method',
      (v_payment->>'amount')::numeric,
      v_payment->>'reference',
      v_payment->>'card_last_four',
      v_payment->>'card_type',
      v_payment->>'mpesa_receipt_number',
      'completed',
      now()
    );

    IF v_payment->>'payment_method' = 'cash' THEN
      v_cash_total := v_cash_total + (v_payment->>'amount')::numeric;
    END IF;
  END LOOP;

  UPDATE public.pos_shifts SET
    total_sales        = total_sales + CASE WHEN p_transaction_type = 'sale'   THEN p_total ELSE 0 END,
    total_returns      = total_returns + CASE WHEN p_transaction_type = 'return' THEN p_total ELSE 0 END,
    total_transactions = total_transactions + 1,
    cash_payments      = cash_payments + v_cash_total,
    card_payments      = card_payments + (v_total_paid - v_cash_total),
    expected_cash      = COALESCE(expected_cash, 0) + v_cash_total,
    updated_at         = now()
  WHERE id = p_shift_id
    AND organization_id = v_register_org_id
    AND business_id     = v_register_business_id
    AND branch_id       = v_register_branch_id;

  DELETE FROM public.pos_stock_reservations WHERE register_id = p_register_id;

  IF p_table_session_id IS NOT NULL THEN
    UPDATE public.pos_table_sessions SET
      status = 'completed', closed_at = now(),
      total_amount = p_total, updated_at = now()
    WHERE id = p_table_session_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'idempotent_replay', false,
    'transaction_id', v_transaction_id,
    'transaction_number', v_transaction_number,
    'change', GREATEST(0, v_total_paid - p_total),
    'branch_id', v_register_branch_id,
    'business_id', v_register_business_id
  );
END;
$function$;