
-- ============================================================
-- 1. Fix process_pos_transaction: remove direct UPDATE, rely on trigger
-- ============================================================

-- Drop both overloads
DROP FUNCTION IF EXISTS public.process_pos_transaction(
  uuid, uuid, uuid, jsonb, jsonb, numeric, numeric, numeric, numeric,
  uuid, text, text, text, uuid, uuid, text, uuid, uuid, numeric, uuid
);
DROP FUNCTION IF EXISTS public.process_pos_transaction(
  uuid, uuid, uuid, jsonb, jsonb, numeric, numeric, numeric, numeric,
  uuid, text, text, text, uuid, uuid, text, uuid, uuid, numeric, uuid, uuid
);

-- Create single consolidated function
CREATE OR REPLACE FUNCTION public.process_pos_transaction(
  p_organization_id UUID,
  p_register_id UUID,
  p_shift_id UUID,
  p_items JSONB,
  p_payments JSONB,
  p_subtotal NUMERIC,
  p_tax_amount NUMERIC,
  p_discount_amount NUMERIC,
  p_total NUMERIC,
  p_customer_id UUID DEFAULT NULL,
  p_customer_tin TEXT DEFAULT NULL,
  p_customer_name TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL,
  p_cashier_id UUID DEFAULT NULL,
  p_warehouse_id UUID DEFAULT NULL,
  p_transaction_type TEXT DEFAULT 'sale',
  p_table_session_id UUID DEFAULT NULL,
  p_created_by UUID DEFAULT NULL,
  p_tip_amount NUMERIC DEFAULT 0,
  p_original_transaction_id UUID DEFAULT NULL,
  p_business_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_transaction_id UUID;
  v_transaction_number TEXT;
  v_register_code TEXT;
  v_item JSONB;
  v_payment JSONB;
  v_product_id UUID;
  v_quantity NUMERIC;
  v_available_stock NUMERIC;
  v_track_inventory BOOLEAN;
  v_insufficient_stock JSONB := '[]'::JSONB;
  v_total_paid NUMERIC := 0;
  v_cash_total NUMERIC := 0;
  v_payment_status TEXT;
  v_item_index INT := 0;
  v_default_warehouse_id UUID;
BEGIN
  -- Get register code for transaction number
  SELECT register_code INTO v_register_code
  FROM pos_registers WHERE id = p_register_id;

  IF v_register_code IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_register', 'details', 'Register not found');
  END IF;

  -- Resolve warehouse: use provided, else default for org
  v_default_warehouse_id := p_warehouse_id;
  IF v_default_warehouse_id IS NULL THEN
    SELECT id INTO v_default_warehouse_id
    FROM warehouses
    WHERE organization_id = p_organization_id AND is_default = true
    LIMIT 1;
  END IF;

  -- Generate transaction number
  v_transaction_number := get_next_pos_transaction_number(p_organization_id, v_register_code);

  -- Check stock availability with locks (only for sales, not returns)
  IF p_transaction_type = 'sale' THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
      v_product_id := (v_item->>'product_id')::UUID;
      v_quantity := (v_item->>'quantity')::NUMERIC;

      IF v_product_id IS NOT NULL THEN
        SELECT track_inventory, stock_quantity INTO v_track_inventory, v_available_stock
        FROM products
        WHERE id = v_product_id
        FOR UPDATE;

        IF v_track_inventory = true AND COALESCE(v_available_stock, 0) < v_quantity THEN
          v_insufficient_stock := v_insufficient_stock || jsonb_build_object(
            'product_id', v_product_id,
            'product_name', v_item->>'name',
            'requested', v_quantity,
            'available', COALESCE(v_available_stock, 0)
          );
        END IF;
      END IF;
    END LOOP;

    IF jsonb_array_length(v_insufficient_stock) > 0 THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'insufficient_stock',
        'details', v_insufficient_stock
      );
    END IF;
  END IF;

  -- Calculate payment status
  SELECT COALESCE(SUM((p->>'amount')::NUMERIC), 0) INTO v_total_paid
  FROM jsonb_array_elements(p_payments) AS p;

  v_payment_status := CASE WHEN v_total_paid >= p_total THEN 'paid' ELSE 'partial' END;

  -- Create the transaction
  INSERT INTO pos_transactions (
    id, organization_id, business_id, register_id, shift_id, transaction_number,
    transaction_type, original_transaction_id,
    subtotal, tax_amount, discount_amount, total, tip_amount,
    payment_status, customer_id, customer_tin, customer_name,
    notes, cashier_id, created_by, table_session_id,
    status, completed_at, created_at
  ) VALUES (
    gen_random_uuid(), p_organization_id, p_business_id, p_register_id, p_shift_id, v_transaction_number,
    p_transaction_type, p_original_transaction_id,
    p_subtotal, p_tax_amount, p_discount_amount, p_total, COALESCE(p_tip_amount, 0),
    v_payment_status, p_customer_id, p_customer_tin, p_customer_name,
    p_notes, p_cashier_id, COALESCE(p_created_by, p_cashier_id), p_table_session_id,
    'completed', now(), now()
  ) RETURNING id INTO v_transaction_id;

  -- Insert transaction items and create stock movements (NO direct product update)
  v_item_index := 0;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item->>'product_id')::UUID;
    v_quantity := (v_item->>'quantity')::NUMERIC;

    INSERT INTO pos_transaction_items (
      transaction_id, product_id, description, quantity,
      unit_price, discount_type, discount_value,
      tax_rate, tax_amount, line_total, cost_price, sort_order,
      tax_rate_id, etims_tax_code
    ) VALUES (
      v_transaction_id, v_product_id, v_item->>'name', v_quantity,
      (v_item->>'unit_price')::NUMERIC, v_item->>'discount_type',
      COALESCE((v_item->>'discount_value')::NUMERIC, 0),
      COALESCE((v_item->>'tax_rate')::NUMERIC, 0),
      COALESCE((v_item->>'tax_amount')::NUMERIC, 0),
      (v_item->>'line_total')::NUMERIC,
      (v_item->>'cost_price')::NUMERIC,
      v_item_index,
      (v_item->>'tax_rate_id')::UUID,
      v_item->>'etims_tax_code'
    );

    -- Create stock movement instead of direct UPDATE
    -- The update_product_stock trigger will handle products.stock_quantity and warehouse_stock
    IF v_product_id IS NOT NULL THEN
      SELECT track_inventory INTO v_track_inventory FROM products WHERE id = v_product_id;

      IF v_track_inventory = true THEN
        IF p_transaction_type = 'sale' THEN
          INSERT INTO stock_movements (
            organization_id, business_id, product_id, warehouse_id,
            movement_type, quantity, unit_cost,
            reference_type, reference_id, notes, created_by, movement_date
          ) VALUES (
            p_organization_id, p_business_id, v_product_id, v_default_warehouse_id,
            'pos_sale', -v_quantity, COALESCE((v_item->>'cost_price')::NUMERIC, 0),
            'pos_transaction', v_transaction_id,
            'POS Sale: ' || v_transaction_number,
            COALESCE(p_created_by, p_cashier_id),
            now()
          );
        ELSIF p_transaction_type = 'return' THEN
          INSERT INTO stock_movements (
            organization_id, business_id, product_id, warehouse_id,
            movement_type, quantity, unit_cost,
            reference_type, reference_id, notes, created_by, movement_date
          ) VALUES (
            p_organization_id, p_business_id, v_product_id, v_default_warehouse_id,
            'pos_return', v_quantity, COALESCE((v_item->>'cost_price')::NUMERIC, 0),
            'pos_transaction', v_transaction_id,
            'POS Return: ' || v_transaction_number,
            COALESCE(p_created_by, p_cashier_id),
            now()
          );
        END IF;
      END IF;
    END IF;

    v_item_index := v_item_index + 1;
  END LOOP;

  -- Insert payments
  FOR v_payment IN SELECT * FROM jsonb_array_elements(p_payments)
  LOOP
    INSERT INTO pos_transaction_payments (
      transaction_id, payment_method, amount, reference,
      card_last_four, card_type, mpesa_receipt_number, status, processed_at
    ) VALUES (
      v_transaction_id,
      v_payment->>'payment_method',
      (v_payment->>'amount')::NUMERIC,
      v_payment->>'reference',
      v_payment->>'card_last_four',
      v_payment->>'card_type',
      v_payment->>'mpesa_receipt_number',
      'completed',
      now()
    );

    IF v_payment->>'payment_method' = 'cash' THEN
      v_cash_total := v_cash_total + (v_payment->>'amount')::NUMERIC;
    END IF;
  END LOOP;

  -- Update shift totals
  UPDATE pos_shifts SET
    total_sales = total_sales + CASE WHEN p_transaction_type = 'sale' THEN p_total ELSE 0 END,
    total_returns = total_returns + CASE WHEN p_transaction_type = 'return' THEN p_total ELSE 0 END,
    total_transactions = total_transactions + 1,
    cash_payments = cash_payments + v_cash_total,
    card_payments = card_payments + (v_total_paid - v_cash_total),
    expected_cash = COALESCE(expected_cash, 0) + v_cash_total,
    updated_at = now()
  WHERE id = p_shift_id;

  -- Release stock reservations for this register after successful transaction
  DELETE FROM pos_stock_reservations WHERE register_id = p_register_id;

  -- Update table session if provided
  IF p_table_session_id IS NOT NULL THEN
    UPDATE pos_table_sessions SET
      status = 'completed',
      closed_at = now(),
      total_amount = p_total,
      updated_at = now()
    WHERE id = p_table_session_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'transaction_id', v_transaction_id,
    'transaction_number', v_transaction_number,
    'change', GREATEST(0, v_total_paid - p_total)
  );
END;
$$;

-- ============================================================
-- 2. Stock reconciliation function
-- ============================================================

CREATE OR REPLACE FUNCTION public.reconcile_stock_quantities(p_organization_id UUID)
RETURNS TABLE (
  product_id UUID,
  product_name TEXT,
  sku TEXT,
  stored_quantity NUMERIC,
  calculated_quantity NUMERIC,
  difference NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p.id AS product_id,
    p.name AS product_name,
    p.sku,
    COALESCE(p.stock_quantity, 0) AS stored_quantity,
    COALESCE(sm.total, 0) AS calculated_quantity,
    COALESCE(p.stock_quantity, 0) - COALESCE(sm.total, 0) AS difference
  FROM products p
  LEFT JOIN (
    SELECT product_id, SUM(quantity) AS total
    FROM stock_movements
    WHERE organization_id = p_organization_id
    GROUP BY product_id
  ) sm ON sm.product_id = p.id
  WHERE p.organization_id = p_organization_id
    AND p.track_inventory = true
    AND COALESCE(p.stock_quantity, 0) != COALESCE(sm.total, 0)
  ORDER BY ABS(COALESCE(p.stock_quantity, 0) - COALESCE(sm.total, 0)) DESC;
$$;
