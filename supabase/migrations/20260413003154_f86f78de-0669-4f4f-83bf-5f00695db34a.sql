
-- ============================================================
-- 1. DROP DUPLICATE TRIGGER (keeps trigger_update_product_stock)
-- ============================================================
DROP TRIGGER IF EXISTS trg_update_product_stock ON public.stock_movements;
DROP FUNCTION IF EXISTS public.update_product_stock_quantity();

-- ============================================================
-- 2. ADD warehouse_id TO stock_movements
-- ============================================================
ALTER TABLE public.stock_movements 
ADD COLUMN IF NOT EXISTS warehouse_id UUID REFERENCES public.warehouses(id);

CREATE INDEX IF NOT EXISTS idx_stock_movements_warehouse 
ON public.stock_movements(warehouse_id);

CREATE INDEX IF NOT EXISTS idx_stock_movements_product_date 
ON public.stock_movements(product_id, movement_date DESC);

CREATE INDEX IF NOT EXISTS idx_stock_movements_reference 
ON public.stock_movements(reference_type, reference_id);

-- ============================================================
-- 3. FIX finalize_table_order: create stock_movements instead 
--    of direct product UPDATE. The trigger handles stock_quantity.
-- ============================================================
CREATE OR REPLACE FUNCTION public.finalize_table_order(
  p_transaction_id UUID,
  p_payments JSONB,
  p_tip_amount NUMERIC DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_txn RECORD;
  v_payment JSONB;
  v_total_paid NUMERIC := 0;
  v_payment_status TEXT;
  v_product_id UUID;
  v_quantity NUMERIC;
  v_track_inventory BOOLEAN;
  v_available_stock NUMERIC;
  v_insufficient_stock JSONB := '[]'::JSONB;
  v_item RECORD;
  v_register_code TEXT;
  v_final_txn_number TEXT;
BEGIN
  -- Lock and fetch the transaction
  SELECT * INTO v_txn FROM pos_transactions WHERE id = p_transaction_id FOR UPDATE;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'transaction_not_found');
  END IF;
  
  IF v_txn.status != 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'transaction_not_pending', 'details', 'Transaction status is: ' || v_txn.status);
  END IF;
  
  -- Check stock availability for all items
  FOR v_item IN SELECT * FROM pos_transaction_items WHERE transaction_id = p_transaction_id
  LOOP
    IF v_item.product_id IS NOT NULL THEN
      SELECT track_inventory, stock_quantity INTO v_track_inventory, v_available_stock
      FROM products WHERE id = v_item.product_id FOR UPDATE;
      
      IF v_track_inventory = true AND COALESCE(v_available_stock, 0) < v_item.quantity THEN
        v_insufficient_stock := v_insufficient_stock || jsonb_build_object(
          'product_id', v_item.product_id,
          'product_name', v_item.description,
          'requested', v_item.quantity,
          'available', COALESCE(v_available_stock, 0)
        );
      END IF;
    END IF;
  END LOOP;
  
  IF jsonb_array_length(v_insufficient_stock) > 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_stock', 'details', v_insufficient_stock);
  END IF;
  
  -- Calculate payment total
  SELECT COALESCE(SUM((p->>'amount')::NUMERIC), 0) INTO v_total_paid
  FROM jsonb_array_elements(p_payments) AS p;
  
  v_payment_status := CASE WHEN v_total_paid >= v_txn.total THEN 'paid' ELSE 'partial' END;
  
  -- Generate a final transaction number
  SELECT register_code INTO v_register_code FROM pos_registers WHERE id = v_txn.register_id;
  v_final_txn_number := get_next_pos_transaction_number(v_txn.organization_id, COALESCE(v_register_code, 'REG'));
  
  -- Update the transaction to completed
  UPDATE pos_transactions SET
    status = 'completed',
    payment_status = v_payment_status,
    completed_at = now(),
    tip_amount = COALESCE(p_tip_amount, 0),
    transaction_number = v_final_txn_number,
    updated_at = now(),
    version = version + 1
  WHERE id = p_transaction_id;
  
  -- Insert payments
  FOR v_payment IN SELECT * FROM jsonb_array_elements(p_payments)
  LOOP
    INSERT INTO pos_transaction_payments (
      transaction_id, payment_method, amount, reference,
      card_last_four, card_type, mpesa_receipt_number, status
    ) VALUES (
      p_transaction_id,
      v_payment->>'payment_method',
      (v_payment->>'amount')::NUMERIC,
      v_payment->>'reference',
      v_payment->>'card_last_four',
      v_payment->>'card_type',
      CASE WHEN v_payment->>'payment_method' = 'mobile_money' THEN v_payment->>'reference' ELSE NULL END,
      'completed'
    );
  END LOOP;
  
  -- Deduct inventory via stock_movements (trigger auto-updates products.stock_quantity)
  FOR v_item IN SELECT * FROM pos_transaction_items WHERE transaction_id = p_transaction_id
  LOOP
    IF v_item.product_id IS NOT NULL THEN
      SELECT track_inventory INTO v_track_inventory FROM products WHERE id = v_item.product_id;
      IF v_track_inventory = true THEN
        INSERT INTO stock_movements (
          organization_id, product_id, movement_type, quantity,
          reference_type, reference_id, notes, created_by
        ) VALUES (
          v_txn.organization_id,
          v_item.product_id,
          'sale',
          -v_item.quantity,
          'pos_transaction',
          p_transaction_id,
          'POS sale ' || v_final_txn_number,
          v_txn.created_by
        );
      END IF;
    END IF;
  END LOOP;
  
  -- Update shift totals
  UPDATE pos_shifts SET
    total_sales = COALESCE(total_sales, 0) + v_txn.total,
    transaction_count = COALESCE(transaction_count, 0) + 1,
    total_tax = COALESCE(total_tax, 0) + v_txn.tax_amount,
    total_discount = COALESCE(total_discount, 0) + COALESCE(v_txn.discount_amount, 0),
    total_tips = COALESCE(total_tips, 0) + COALESCE(p_tip_amount, 0),
    updated_at = now()
  WHERE id = v_txn.shift_id;
  
  RETURN jsonb_build_object(
    'success', true,
    'transaction_id', p_transaction_id,
    'transaction_number', v_final_txn_number,
    'change', GREATEST(0, v_total_paid - v_txn.total)
  );
END;
$$;

-- ============================================================
-- 4. CREATE helper function for invoice stock movements
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_invoice_stock_movements(
  p_invoice_id UUID,
  p_organization_id UUID,
  p_created_by UUID DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item RECORD;
  v_inv RECORD;
BEGIN
  SELECT invoice_number INTO v_inv FROM invoices WHERE id = p_invoice_id;
  
  FOR v_item IN 
    SELECT ii.product_id, ii.quantity, p.track_inventory
    FROM invoice_items ii
    JOIN products p ON p.id = ii.product_id
    WHERE ii.invoice_id = p_invoice_id
      AND ii.product_id IS NOT NULL
      AND p.track_inventory = true
  LOOP
    INSERT INTO stock_movements (
      organization_id, product_id, movement_type, quantity,
      reference_type, reference_id, notes, created_by
    ) VALUES (
      p_organization_id,
      v_item.product_id,
      'sale',
      -v_item.quantity,
      'invoice',
      p_invoice_id,
      'Invoice ' || COALESCE(v_inv.invoice_number, ''),
      p_created_by
    );
  END LOOP;
END;
$$;
