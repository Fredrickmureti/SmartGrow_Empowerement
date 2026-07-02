
-- =====================================================
-- Enhanced Atomic Transaction Processing Function
-- Handles all fields, shift cash update, inventory movements, track_inventory check
-- =====================================================

CREATE OR REPLACE FUNCTION process_pos_transaction(
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
  p_created_by UUID DEFAULT NULL
) RETURNS JSONB
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
BEGIN
  -- Get register code for transaction number
  SELECT register_code INTO v_register_code
  FROM pos_registers WHERE id = p_register_id;
  
  IF v_register_code IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_register', 'details', 'Register not found');
  END IF;
  
  -- Generate transaction number
  v_transaction_number := get_next_pos_transaction_number(p_organization_id, v_register_code);
  
  -- Check stock availability with locks (only for sales, not returns)
  IF p_transaction_type != 'return' THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
      v_product_id := (v_item->>'product_id')::UUID;
      v_quantity := (v_item->>'quantity')::NUMERIC;
      
      IF v_product_id IS NOT NULL THEN
        -- Check if product tracks inventory
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
    
    -- If any items have insufficient stock, return error
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
    id,
    organization_id,
    register_id,
    shift_id,
    transaction_number,
    transaction_type,
    subtotal,
    tax_amount,
    discount_amount,
    total,
    payment_status,
    customer_id,
    customer_tin,
    customer_name,
    notes,
    cashier_id,
    created_by,
    table_session_id,
    status,
    completed_at,
    created_at
  ) VALUES (
    gen_random_uuid(),
    p_organization_id,
    p_register_id,
    p_shift_id,
    v_transaction_number,
    p_transaction_type,
    p_subtotal,
    p_tax_amount,
    p_discount_amount,
    p_total,
    v_payment_status,
    p_customer_id,
    p_customer_tin,
    p_customer_name,
    p_notes,
    p_cashier_id,
    COALESCE(p_created_by, p_cashier_id),
    p_table_session_id,
    'completed',
    now(),
    now()
  ) RETURNING id INTO v_transaction_id;
  
  -- Insert transaction items and update stock atomically
  v_item_index := 0;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item->>'product_id')::UUID;
    v_quantity := (v_item->>'quantity')::NUMERIC;
    
    -- Insert item with all fields
    INSERT INTO pos_transaction_items (
      transaction_id,
      product_id,
      description,
      quantity,
      unit_price,
      discount_type,
      discount_value,
      tax_rate,
      tax_amount,
      line_total,
      cost_price,
      sort_order,
      tax_rate_id,
      etims_tax_code
    ) VALUES (
      v_transaction_id,
      v_product_id,
      v_item->>'name',
      v_quantity,
      (v_item->>'unit_price')::NUMERIC,
      v_item->>'discount_type',
      COALESCE((v_item->>'discount_value')::NUMERIC, 0),
      COALESCE((v_item->>'tax_rate')::NUMERIC, 0),
      COALESCE((v_item->>'tax_amount')::NUMERIC, 0),
      (v_item->>'line_total')::NUMERIC,
      (v_item->>'cost_price')::NUMERIC,
      v_item_index,
      (v_item->>'tax_rate_id')::UUID,
      v_item->>'etims_tax_code'
    );
    
    -- Update stock (only for tracked inventory products, and not for returns)
    IF v_product_id IS NOT NULL AND p_transaction_type != 'return' THEN
      SELECT track_inventory INTO v_track_inventory FROM products WHERE id = v_product_id;
      
      IF v_track_inventory = true THEN
        UPDATE products
        SET stock_quantity = GREATEST(0, COALESCE(stock_quantity, 0) - v_quantity),
            updated_at = now()
        WHERE id = v_product_id;
        
        -- Create inventory movement record for audit trail
        INSERT INTO inventory_movements (
          organization_id,
          product_id,
          movement_type,
          quantity,
          reference_type,
          reference_id,
          notes,
          created_by
        ) VALUES (
          p_organization_id,
          v_product_id,
          'pos_sale',
          -v_quantity,
          'pos_transaction',
          v_transaction_id,
          'POS Sale: ' || v_transaction_number,
          COALESCE(p_created_by, p_cashier_id)
        );
      END IF;
    END IF;
    
    v_item_index := v_item_index + 1;
  END LOOP;
  
  -- Insert payments
  FOR v_payment IN SELECT * FROM jsonb_array_elements(p_payments)
  LOOP
    INSERT INTO pos_transaction_payments (
      transaction_id,
      payment_method,
      amount,
      reference,
      mpesa_receipt_number,
      card_last_four,
      card_type,
      status
    ) VALUES (
      v_transaction_id,
      v_payment->>'payment_method',
      (v_payment->>'amount')::NUMERIC,
      v_payment->>'reference',
      v_payment->>'mpesa_receipt_number',
      v_payment->>'card_last_four',
      v_payment->>'card_type',
      'completed'
    );
    
    -- Track cash total for shift update
    IF (v_payment->>'payment_method') = 'cash' THEN
      v_cash_total := v_cash_total + (v_payment->>'amount')::NUMERIC;
    END IF;
  END LOOP;
  
  -- Atomically update shift expected cash (no race condition)
  IF v_cash_total > 0 THEN
    UPDATE pos_shifts
    SET expected_cash = COALESCE(expected_cash, 0) + v_cash_total
    WHERE id = p_shift_id;
  END IF;
  
  -- Return success with transaction details
  RETURN jsonb_build_object(
    'success', true,
    'transaction_id', v_transaction_id,
    'transaction_number', v_transaction_number,
    'change', GREATEST(0, v_total_paid - p_total)
  );
END;
$$;
