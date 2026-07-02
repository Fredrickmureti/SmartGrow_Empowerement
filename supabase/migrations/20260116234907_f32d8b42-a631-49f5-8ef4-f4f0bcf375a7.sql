-- =====================================================
-- Atomic Transaction Processing Function
-- =====================================================

-- Create atomic transaction processing function
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
  p_warehouse_id UUID DEFAULT NULL
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
  v_insufficient_stock JSONB := '[]'::JSONB;
BEGIN
  -- Get register code for transaction number
  SELECT register_code INTO v_register_code
  FROM pos_registers WHERE id = p_register_id;
  
  -- Generate transaction number
  v_transaction_number := get_next_pos_transaction_number(p_organization_id, v_register_code);
  
  -- First, check all stock availability with locks
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item->>'product_id')::UUID;
    v_quantity := (v_item->>'quantity')::NUMERIC;
    
    -- Check and lock stock
    IF p_warehouse_id IS NOT NULL THEN
      SELECT quantity - reserved_quantity INTO v_available_stock
      FROM warehouse_stock
      WHERE warehouse_id = p_warehouse_id AND product_id = v_product_id
      FOR UPDATE;
    ELSE
      SELECT stock_quantity INTO v_available_stock
      FROM products
      WHERE id = v_product_id
      FOR UPDATE;
    END IF;
    
    -- Track insufficient stock
    IF COALESCE(v_available_stock, 0) < v_quantity THEN
      v_insufficient_stock := v_insufficient_stock || jsonb_build_object(
        'product_id', v_product_id,
        'product_name', v_item->>'name',
        'requested', v_quantity,
        'available', COALESCE(v_available_stock, 0)
      );
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
  
  -- Create the transaction
  INSERT INTO pos_transactions (
    id,
    organization_id,
    register_id,
    shift_id,
    transaction_number,
    subtotal,
    tax_amount,
    discount_amount,
    total,
    customer_id,
    customer_tin,
    customer_name,
    notes,
    cashier_id,
    status,
    etims_status,
    created_at
  ) VALUES (
    gen_random_uuid(),
    p_organization_id,
    p_register_id,
    p_shift_id,
    v_transaction_number,
    p_subtotal,
    p_tax_amount,
    p_discount_amount,
    p_total,
    p_customer_id,
    p_customer_tin,
    p_customer_name,
    p_notes,
    p_cashier_id,
    'completed',
    'not_applicable',
    now()
  ) RETURNING id INTO v_transaction_id;
  
  -- Insert transaction items and update stock atomically
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item->>'product_id')::UUID;
    v_quantity := (v_item->>'quantity')::NUMERIC;
    
    -- Insert item
    INSERT INTO pos_transaction_items (
      transaction_id,
      product_id,
      quantity,
      unit_price,
      discount_amount,
      tax_amount,
      line_total
    ) VALUES (
      v_transaction_id,
      v_product_id,
      v_quantity,
      (v_item->>'unit_price')::NUMERIC,
      COALESCE((v_item->>'discount_amount')::NUMERIC, 0),
      COALESCE((v_item->>'tax_amount')::NUMERIC, 0),
      (v_item->>'line_total')::NUMERIC
    );
    
    -- Update stock
    IF p_warehouse_id IS NOT NULL THEN
      UPDATE warehouse_stock
      SET quantity = quantity - v_quantity,
          updated_at = now()
      WHERE warehouse_id = p_warehouse_id AND product_id = v_product_id;
    ELSE
      UPDATE products
      SET stock_quantity = COALESCE(stock_quantity, 0) - v_quantity,
          updated_at = now()
      WHERE id = v_product_id;
    END IF;
  END LOOP;
  
  -- Insert payments
  FOR v_payment IN SELECT * FROM jsonb_array_elements(p_payments)
  LOOP
    INSERT INTO pos_transaction_payments (
      transaction_id,
      payment_method,
      amount,
      reference,
      mpesa_receipt_number
    ) VALUES (
      v_transaction_id,
      v_payment->>'payment_method',
      (v_payment->>'amount')::NUMERIC,
      v_payment->>'reference',
      v_payment->>'mpesa_receipt_number'
    );
  END LOOP;
  
  -- Return success with transaction details
  RETURN jsonb_build_object(
    'success', true,
    'transaction_id', v_transaction_id,
    'transaction_number', v_transaction_number
  );
END;
$$;

-- =====================================================
-- Stock Management Functions
-- =====================================================

-- Create function to get available stock
CREATE OR REPLACE FUNCTION get_available_stock(
  p_product_id UUID,
  p_warehouse_id UUID DEFAULT NULL
) RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_stock NUMERIC;
BEGIN
  IF p_warehouse_id IS NOT NULL THEN
    SELECT quantity - reserved_quantity INTO v_stock
    FROM warehouse_stock
    WHERE product_id = p_product_id AND warehouse_id = p_warehouse_id;
  ELSE
    SELECT stock_quantity INTO v_stock
    FROM products
    WHERE id = p_product_id;
  END IF;
  
  RETURN COALESCE(v_stock, 0);
END;
$$;

-- Create function to reserve stock
CREATE OR REPLACE FUNCTION reserve_stock(
  p_product_id UUID,
  p_warehouse_id UUID,
  p_quantity NUMERIC
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_available NUMERIC;
BEGIN
  SELECT quantity - reserved_quantity INTO v_available
  FROM warehouse_stock
  WHERE product_id = p_product_id AND warehouse_id = p_warehouse_id
  FOR UPDATE;
  
  IF v_available >= p_quantity THEN
    UPDATE warehouse_stock
    SET reserved_quantity = reserved_quantity + p_quantity,
        updated_at = now()
    WHERE product_id = p_product_id AND warehouse_id = p_warehouse_id;
    RETURN true;
  END IF;
  
  RETURN false;
END;
$$;

-- Create function to release reserved stock
CREATE OR REPLACE FUNCTION release_reserved_stock(
  p_product_id UUID,
  p_warehouse_id UUID,
  p_quantity NUMERIC
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE warehouse_stock
  SET reserved_quantity = GREATEST(0, reserved_quantity - p_quantity),
      updated_at = now()
  WHERE product_id = p_product_id AND warehouse_id = p_warehouse_id;
  
  RETURN true;
END;
$$;

-- Enable realtime for warehouse_stock
ALTER PUBLICATION supabase_realtime ADD TABLE warehouse_stock;