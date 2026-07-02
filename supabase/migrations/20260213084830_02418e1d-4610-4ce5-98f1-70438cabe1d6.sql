
-- =====================================================
-- Phase 2 & 3: Operational Completeness & Competitive Features
-- 1. Gift cards / store credit
-- 2. Stock reservations table  
-- 3. Add tip_amount param to process_pos_transaction RPC
-- 4. Exchange support columns
-- 5. Z-Report / X-Report view
-- =====================================================

-- =====================================================
-- 1. GIFT CARDS / STORE CREDIT
-- =====================================================

CREATE TABLE IF NOT EXISTS public.pos_gift_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  card_number TEXT NOT NULL,
  pin TEXT,
  initial_balance NUMERIC(15,2) NOT NULL DEFAULT 0,
  current_balance NUMERIC(15,2) NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'KES',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'expired', 'depleted')),
  issued_to_customer_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  issued_to_name TEXT,
  issued_by UUID,
  expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(organization_id, card_number)
);

CREATE TABLE IF NOT EXISTS public.pos_gift_card_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  gift_card_id UUID NOT NULL REFERENCES public.pos_gift_cards(id) ON DELETE CASCADE,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('issue', 'redeem', 'top_up', 'refund', 'adjustment', 'expire')),
  amount NUMERIC(15,2) NOT NULL,
  balance_after NUMERIC(15,2) NOT NULL,
  pos_transaction_id UUID REFERENCES public.pos_transactions(id) ON DELETE SET NULL,
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.pos_gift_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_gift_card_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view gift cards in their org"
  ON public.pos_gift_cards FOR SELECT
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can manage gift cards in their org"
  ON public.pos_gift_cards FOR ALL
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can view gift card transactions in their org"
  ON public.pos_gift_card_transactions FOR SELECT
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can manage gift card transactions in their org"
  ON public.pos_gift_card_transactions FOR ALL
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE INDEX IF NOT EXISTS idx_gift_cards_org ON public.pos_gift_cards(organization_id);
CREATE INDEX IF NOT EXISTS idx_gift_cards_number ON public.pos_gift_cards(organization_id, card_number);
CREATE INDEX IF NOT EXISTS idx_gift_card_txns_card ON public.pos_gift_card_transactions(gift_card_id);

-- =====================================================
-- 2. STOCK RESERVATIONS (Server-side)
-- =====================================================

CREATE TABLE IF NOT EXISTS public.pos_stock_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  register_id UUID NOT NULL REFERENCES public.pos_registers(id) ON DELETE CASCADE,
  quantity NUMERIC(15,4) NOT NULL,
  reserved_by UUID,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (now() + interval '15 minutes'),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.pos_stock_reservations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view stock reservations in their org"
  ON public.pos_stock_reservations FOR SELECT
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can manage stock reservations in their org"
  ON public.pos_stock_reservations FOR ALL
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE INDEX IF NOT EXISTS idx_stock_reservations_product ON public.pos_stock_reservations(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_reservations_expires ON public.pos_stock_reservations(expires_at);

-- Function to get available stock minus active reservations
CREATE OR REPLACE FUNCTION get_available_pos_stock(
  p_product_id UUID,
  p_exclude_register_id UUID DEFAULT NULL
) RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stock NUMERIC;
  v_reserved NUMERIC;
BEGIN
  SELECT COALESCE(stock_quantity, 0) INTO v_stock
  FROM products WHERE id = p_product_id;

  -- Sum active reservations (not expired), optionally excluding current register
  SELECT COALESCE(SUM(quantity), 0) INTO v_reserved
  FROM pos_stock_reservations
  WHERE product_id = p_product_id
    AND expires_at > now()
    AND (p_exclude_register_id IS NULL OR register_id != p_exclude_register_id);

  RETURN GREATEST(0, v_stock - v_reserved);
END;
$$;

-- Function to reserve stock for a cart
CREATE OR REPLACE FUNCTION reserve_pos_stock(
  p_organization_id UUID,
  p_product_id UUID,
  p_register_id UUID,
  p_quantity NUMERIC,
  p_reserved_by UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_available NUMERIC;
  v_existing_id UUID;
BEGIN
  -- Clean up expired reservations first
  DELETE FROM pos_stock_reservations WHERE expires_at <= now();

  -- Check availability
  v_available := get_available_pos_stock(p_product_id, p_register_id);

  IF v_available < p_quantity THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_stock', 'available', v_available);
  END IF;

  -- Upsert reservation (one per product per register)
  SELECT id INTO v_existing_id
  FROM pos_stock_reservations
  WHERE product_id = p_product_id AND register_id = p_register_id;

  IF v_existing_id IS NOT NULL THEN
    UPDATE pos_stock_reservations
    SET quantity = p_quantity,
        expires_at = now() + interval '15 minutes',
        reserved_by = COALESCE(p_reserved_by, reserved_by)
    WHERE id = v_existing_id;
  ELSE
    INSERT INTO pos_stock_reservations (organization_id, product_id, register_id, quantity, reserved_by)
    VALUES (p_organization_id, p_product_id, p_register_id, p_quantity, p_reserved_by);
  END IF;

  RETURN jsonb_build_object('success', true, 'available', v_available);
END;
$$;

-- Function to release reservations after transaction completes
CREATE OR REPLACE FUNCTION release_pos_stock_reservation(
  p_register_id UUID,
  p_product_id UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_product_id IS NOT NULL THEN
    DELETE FROM pos_stock_reservations 
    WHERE register_id = p_register_id AND product_id = p_product_id;
  ELSE
    DELETE FROM pos_stock_reservations WHERE register_id = p_register_id;
  END IF;
END;
$$;

-- =====================================================
-- 3. UPDATE process_pos_transaction to accept tip_amount
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
  p_created_by UUID DEFAULT NULL,
  p_tip_amount NUMERIC DEFAULT 0,
  p_original_transaction_id UUID DEFAULT NULL
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
    id, organization_id, register_id, shift_id, transaction_number,
    transaction_type, original_transaction_id,
    subtotal, tax_amount, discount_amount, total, tip_amount,
    payment_status, customer_id, customer_tin, customer_name,
    notes, cashier_id, created_by, table_session_id,
    status, completed_at, created_at
  ) VALUES (
    gen_random_uuid(), p_organization_id, p_register_id, p_shift_id, v_transaction_number,
    p_transaction_type, p_original_transaction_id,
    p_subtotal, p_tax_amount, p_discount_amount, p_total, COALESCE(p_tip_amount, 0),
    v_payment_status, p_customer_id, p_customer_tin, p_customer_name,
    p_notes, p_cashier_id, COALESCE(p_created_by, p_cashier_id), p_table_session_id,
    'completed', now(), now()
  ) RETURNING id INTO v_transaction_id;
  
  -- Insert transaction items and update stock atomically
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
      (v_item->>'cost_price')::NUMERIC, v_item_index,
      (v_item->>'tax_rate_id')::UUID, v_item->>'etims_tax_code'
    );
    
    -- Update stock (only for tracked inventory products, and only for sales)
    IF v_product_id IS NOT NULL AND p_transaction_type = 'sale' THEN
      SELECT track_inventory INTO v_track_inventory FROM products WHERE id = v_product_id;
      
      IF v_track_inventory = true THEN
        UPDATE products
        SET stock_quantity = GREATEST(0, COALESCE(stock_quantity, 0) - v_quantity),
            updated_at = now()
        WHERE id = v_product_id;
        
        INSERT INTO inventory_movements (
          organization_id, product_id, movement_type, quantity,
          reference_type, reference_id, notes, created_by
        ) VALUES (
          p_organization_id, v_product_id, 'pos_sale', -v_quantity,
          'pos_transaction', v_transaction_id,
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
      transaction_id, payment_method, amount, reference,
      mpesa_receipt_number, card_last_four, card_type, status
    ) VALUES (
      v_transaction_id, v_payment->>'payment_method',
      (v_payment->>'amount')::NUMERIC, v_payment->>'reference',
      v_payment->>'mpesa_receipt_number', v_payment->>'card_last_four',
      v_payment->>'card_type', 'completed'
    );
    
    IF (v_payment->>'payment_method') = 'cash' THEN
      v_cash_total := v_cash_total + (v_payment->>'amount')::NUMERIC;
    END IF;
  END LOOP;
  
  -- Atomically update shift expected cash
  IF v_cash_total > 0 THEN
    UPDATE pos_shifts
    SET expected_cash = COALESCE(expected_cash, 0) + v_cash_total
    WHERE id = p_shift_id;
  END IF;

  -- Release stock reservations for this register after successful transaction
  DELETE FROM pos_stock_reservations WHERE register_id = p_register_id;
  
  RETURN jsonb_build_object(
    'success', true,
    'transaction_id', v_transaction_id,
    'transaction_number', v_transaction_number,
    'change', GREATEST(0, v_total_paid - p_total)
  );
END;
$$;

-- =====================================================
-- 4. Z-REPORT VIEW (End of Day summary across all shifts)
-- =====================================================

CREATE OR REPLACE FUNCTION get_pos_z_report(
  p_organization_id UUID,
  p_date DATE DEFAULT CURRENT_DATE,
  p_register_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
  v_shifts JSONB;
  v_payment_breakdown JSONB;
  v_tax_summary JSONB;
  v_totals JSONB;
BEGIN
  -- Shifts summary
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'shift_id', s.id,
    'shift_number', s.shift_number,
    'user_id', s.user_id,
    'opened_at', s.opened_at,
    'closed_at', s.closed_at,
    'status', s.status,
    'opening_cash', s.opening_cash,
    'expected_cash', s.expected_cash,
    'actual_cash', s.actual_cash,
    'cash_difference', s.cash_difference
  )), '[]'::JSONB) INTO v_shifts
  FROM pos_shifts s
  WHERE s.organization_id = p_organization_id
    AND s.opened_at::DATE = p_date
    AND (p_register_id IS NULL OR s.register_id = p_register_id);

  -- Transaction totals
  SELECT jsonb_build_object(
    'total_sales', COALESCE(SUM(CASE WHEN transaction_type = 'sale' AND status = 'completed' THEN total ELSE 0 END), 0),
    'total_returns', COALESCE(SUM(CASE WHEN transaction_type = 'return' AND status = 'completed' THEN total ELSE 0 END), 0),
    'total_voids', COALESCE(SUM(CASE WHEN status = 'voided' THEN total ELSE 0 END), 0),
    'net_sales', COALESCE(SUM(CASE 
      WHEN status = 'completed' AND transaction_type = 'sale' THEN total 
      WHEN status = 'completed' AND transaction_type = 'return' THEN -total 
      ELSE 0 END), 0),
    'total_tax', COALESCE(SUM(CASE WHEN status = 'completed' AND transaction_type = 'sale' THEN tax_amount ELSE 0 END), 0),
    'total_discounts', COALESCE(SUM(CASE WHEN status = 'completed' THEN discount_amount ELSE 0 END), 0),
    'total_tips', COALESCE(SUM(CASE WHEN status = 'completed' THEN COALESCE(tip_amount, 0) ELSE 0 END), 0),
    'transaction_count', COUNT(*) FILTER (WHERE status = 'completed'),
    'void_count', COUNT(*) FILTER (WHERE status = 'voided'),
    'return_count', COUNT(*) FILTER (WHERE transaction_type = 'return' AND status = 'completed'),
    'avg_transaction', CASE 
      WHEN COUNT(*) FILTER (WHERE status = 'completed' AND transaction_type = 'sale') > 0 
      THEN COALESCE(SUM(CASE WHEN status = 'completed' AND transaction_type = 'sale' THEN total ELSE 0 END), 0) / COUNT(*) FILTER (WHERE status = 'completed' AND transaction_type = 'sale')
      ELSE 0 END
  ) INTO v_totals
  FROM pos_transactions t
  JOIN pos_shifts s ON s.id = t.shift_id
  WHERE t.organization_id = p_organization_id
    AND s.opened_at::DATE = p_date
    AND (p_register_id IS NULL OR t.register_id = p_register_id);

  -- Payment method breakdown
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'payment_method', tp.payment_method,
    'total_amount', tp.total_amount,
    'transaction_count', tp.txn_count
  )), '[]'::JSONB) INTO v_payment_breakdown
  FROM (
    SELECT 
      p.payment_method,
      SUM(p.amount) as total_amount,
      COUNT(DISTINCT p.transaction_id) as txn_count
    FROM pos_transaction_payments p
    JOIN pos_transactions t ON t.id = p.transaction_id
    JOIN pos_shifts s ON s.id = t.shift_id
    WHERE t.organization_id = p_organization_id
      AND s.opened_at::DATE = p_date
      AND t.status = 'completed'
      AND p.status = 'completed'
      AND (p_register_id IS NULL OR t.register_id = p_register_id)
    GROUP BY p.payment_method
  ) tp;

  -- Tax summary by rate
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'tax_rate', ti.tax_rate,
    'taxable_amount', ti.taxable_amount,
    'tax_amount', ti.tax_total
  )), '[]'::JSONB) INTO v_tax_summary
  FROM (
    SELECT 
      i.tax_rate,
      SUM(i.line_total - i.tax_amount) as taxable_amount,
      SUM(i.tax_amount) as tax_total
    FROM pos_transaction_items i
    JOIN pos_transactions t ON t.id = i.transaction_id
    JOIN pos_shifts s ON s.id = t.shift_id
    WHERE t.organization_id = p_organization_id
      AND s.opened_at::DATE = p_date
      AND t.status = 'completed'
      AND (p_register_id IS NULL OR t.register_id = p_register_id)
    GROUP BY i.tax_rate
    HAVING SUM(i.tax_amount) > 0
  ) ti;

  v_result := jsonb_build_object(
    'report_date', p_date,
    'generated_at', now(),
    'organization_id', p_organization_id,
    'register_id', p_register_id,
    'shifts', v_shifts,
    'totals', v_totals,
    'payment_breakdown', v_payment_breakdown,
    'tax_summary', v_tax_summary
  );

  RETURN v_result;
END;
$$;

-- X-Report reuses the same function with current shift data
CREATE OR REPLACE FUNCTION get_pos_x_report(
  p_organization_id UUID,
  p_shift_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
  v_shift RECORD;
  v_totals JSONB;
  v_payment_breakdown JSONB;
BEGIN
  SELECT * INTO v_shift FROM pos_shifts WHERE id = p_shift_id AND organization_id = p_organization_id;
  
  IF v_shift IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Shift not found');
  END IF;

  SELECT jsonb_build_object(
    'total_sales', COALESCE(SUM(CASE WHEN transaction_type = 'sale' AND status = 'completed' THEN total ELSE 0 END), 0),
    'total_returns', COALESCE(SUM(CASE WHEN transaction_type = 'return' AND status = 'completed' THEN total ELSE 0 END), 0),
    'total_voids', COALESCE(SUM(CASE WHEN status = 'voided' THEN total ELSE 0 END), 0),
    'net_sales', COALESCE(SUM(CASE 
      WHEN status = 'completed' AND transaction_type = 'sale' THEN total 
      WHEN status = 'completed' AND transaction_type = 'return' THEN -total 
      ELSE 0 END), 0),
    'total_tax', COALESCE(SUM(CASE WHEN status = 'completed' THEN tax_amount ELSE 0 END), 0),
    'total_discounts', COALESCE(SUM(CASE WHEN status = 'completed' THEN discount_amount ELSE 0 END), 0),
    'total_tips', COALESCE(SUM(CASE WHEN status = 'completed' THEN COALESCE(tip_amount, 0) ELSE 0 END), 0),
    'transaction_count', COUNT(*) FILTER (WHERE status = 'completed'),
    'void_count', COUNT(*) FILTER (WHERE status = 'voided'),
    'return_count', COUNT(*) FILTER (WHERE transaction_type = 'return' AND status = 'completed')
  ) INTO v_totals
  FROM pos_transactions
  WHERE shift_id = p_shift_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'payment_method', sub.payment_method,
    'total_amount', sub.total_amount,
    'transaction_count', sub.txn_count
  )), '[]'::JSONB) INTO v_payment_breakdown
  FROM (
    SELECT p.payment_method, SUM(p.amount) as total_amount, COUNT(DISTINCT p.transaction_id) as txn_count
    FROM pos_transaction_payments p
    JOIN pos_transactions t ON t.id = p.transaction_id
    WHERE t.shift_id = p_shift_id AND t.status = 'completed' AND p.status = 'completed'
    GROUP BY p.payment_method
  ) sub;

  v_result := jsonb_build_object(
    'shift_id', v_shift.id,
    'shift_number', v_shift.shift_number,
    'opened_at', v_shift.opened_at,
    'status', v_shift.status,
    'opening_cash', v_shift.opening_cash,
    'expected_cash', v_shift.expected_cash,
    'totals', v_totals,
    'payment_breakdown', v_payment_breakdown,
    'generated_at', now()
  );

  RETURN v_result;
END;
$$;

-- Trigger to update gift card timestamps
CREATE TRIGGER update_pos_gift_cards_updated_at
  BEFORE UPDATE ON public.pos_gift_cards
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
