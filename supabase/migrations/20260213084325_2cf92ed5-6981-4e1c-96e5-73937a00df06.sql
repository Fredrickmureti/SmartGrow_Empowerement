
-- =====================================================
-- Phase 1: Enterprise POS Readiness
-- 1. Atomic process_pos_return RPC
-- 2. Void transaction RPC (process_pos_void)  
-- 3. POS Accounting integration trigger on shift close
-- 4. Add tip_amount to pos_transactions
-- =====================================================

-- Add tip_amount column to pos_transactions
ALTER TABLE public.pos_transactions
ADD COLUMN IF NOT EXISTS tip_amount NUMERIC(15,2) DEFAULT 0;

-- Add original_transaction_id for returns/exchanges linking
ALTER TABLE public.pos_transactions
ADD COLUMN IF NOT EXISTS original_transaction_id UUID REFERENCES public.pos_transactions(id) ON DELETE SET NULL;

-- Add voided_by, voided_at, void_reason for void workflow
ALTER TABLE public.pos_transactions
ADD COLUMN IF NOT EXISTS voided_by UUID,
ADD COLUMN IF NOT EXISTS voided_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS void_reason TEXT;

-- Add journal_entry_id to pos_shifts for accounting link
ALTER TABLE public.pos_shifts
ADD COLUMN IF NOT EXISTS journal_entry_id UUID REFERENCES public.journal_entries(id) ON DELETE SET NULL;

-- =====================================================
-- 1. ATOMIC RETURN RPC
-- Mirrors process_pos_transaction with return-specific logic:
-- - Validates original transaction exists and is completed
-- - Checks for double-return (quantity already returned)
-- - Creates return transaction, items, payment
-- - Restores stock atomically
-- - Updates shift expected cash
-- =====================================================

CREATE OR REPLACE FUNCTION process_pos_return(
  p_organization_id UUID,
  p_register_id UUID,
  p_shift_id UUID,
  p_original_transaction_id UUID,
  p_items JSONB,  -- [{product_id, original_item_id, description, quantity, unit_price, tax_rate, cost_price}]
  p_refund_method TEXT DEFAULT 'cash',  -- cash, card, voucher
  p_notes TEXT DEFAULT NULL,
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
  v_product_id UUID;
  v_quantity NUMERIC;
  v_track_inventory BOOLEAN;
  v_subtotal NUMERIC := 0;
  v_tax_amount NUMERIC := 0;
  v_total NUMERIC := 0;
  v_item_index INT := 0;
  v_original_status TEXT;
  v_already_returned NUMERIC;
  v_original_qty NUMERIC;
  v_item_total NUMERIC;
  v_item_tax NUMERIC;
BEGIN
  -- Validate original transaction exists and is completed
  SELECT status INTO v_original_status
  FROM pos_transactions
  WHERE id = p_original_transaction_id
    AND organization_id = p_organization_id;

  IF v_original_status IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'original_not_found', 'details', 'Original transaction not found');
  END IF;

  IF v_original_status != 'completed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_status', 'details', 'Original transaction is not completed (status: ' || v_original_status || ')');
  END IF;

  -- Get register code
  SELECT register_code INTO v_register_code
  FROM pos_registers WHERE id = p_register_id;

  IF v_register_code IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_register', 'details', 'Register not found');
  END IF;

  -- Validate each return item against original and check double-return
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item->>'product_id')::UUID;
    v_quantity := (v_item->>'quantity')::NUMERIC;

    -- Get original item quantity
    SELECT quantity INTO v_original_qty
    FROM pos_transaction_items
    WHERE id = (v_item->>'original_item_id')::UUID
      AND transaction_id = p_original_transaction_id;

    IF v_original_qty IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'item_not_found', 
        'details', 'Original item not found: ' || COALESCE(v_item->>'description', 'unknown'));
    END IF;

    -- Check how much has already been returned for this product from this transaction
    SELECT COALESCE(SUM(ti.quantity), 0) INTO v_already_returned
    FROM pos_transaction_items ti
    JOIN pos_transactions t ON t.id = ti.transaction_id
    WHERE t.original_transaction_id = p_original_transaction_id
      AND t.transaction_type = 'return'
      AND t.status = 'completed'
      AND ti.product_id = v_product_id;

    IF v_quantity > (v_original_qty - v_already_returned) THEN
      RETURN jsonb_build_object('success', false, 'error', 'excess_return',
        'details', format('Cannot return %s of "%s" — only %s remaining (%s already returned)',
          v_quantity, v_item->>'description', v_original_qty - v_already_returned, v_already_returned));
    END IF;
  END LOOP;

  -- Generate transaction number
  v_transaction_number := get_next_pos_transaction_number(p_organization_id, v_register_code);

  -- Calculate totals
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_quantity := (v_item->>'quantity')::NUMERIC;
    v_item_total := (v_item->>'unit_price')::NUMERIC * v_quantity;
    v_item_tax := v_item_total * COALESCE((v_item->>'tax_rate')::NUMERIC, 0) / 100;
    v_subtotal := v_subtotal + v_item_total;
    v_tax_amount := v_tax_amount + v_item_tax;
  END LOOP;
  v_total := v_subtotal + v_tax_amount;

  -- Create return transaction
  INSERT INTO pos_transactions (
    id, organization_id, register_id, shift_id, transaction_number,
    transaction_type, original_transaction_id,
    subtotal, tax_amount, discount_amount, total,
    payment_status, status, completed_at, created_by, notes, created_at
  ) VALUES (
    gen_random_uuid(), p_organization_id, p_register_id, p_shift_id, v_transaction_number,
    'return', p_original_transaction_id,
    v_subtotal, v_tax_amount, 0, v_total,
    'refunded', 'completed', now(), p_created_by,
    COALESCE(p_notes, '') || ' Return for txn ' || p_original_transaction_id::TEXT, now()
  ) RETURNING id INTO v_transaction_id;

  -- Insert return items and restore stock atomically
  v_item_index := 0;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item->>'product_id')::UUID;
    v_quantity := (v_item->>'quantity')::NUMERIC;
    v_item_total := (v_item->>'unit_price')::NUMERIC * v_quantity;
    v_item_tax := v_item_total * COALESCE((v_item->>'tax_rate')::NUMERIC, 0) / 100;

    INSERT INTO pos_transaction_items (
      transaction_id, product_id, description, quantity,
      unit_price, discount_type, discount_value,
      tax_rate, tax_amount, line_total, cost_price, sort_order
    ) VALUES (
      v_transaction_id, v_product_id, v_item->>'description', v_quantity,
      (v_item->>'unit_price')::NUMERIC, NULL, 0,
      COALESCE((v_item->>'tax_rate')::NUMERIC, 0), v_item_tax, v_item_total + v_item_tax,
      (v_item->>'cost_price')::NUMERIC, v_item_index
    );

    -- Restore stock for tracked inventory products
    IF v_product_id IS NOT NULL THEN
      SELECT track_inventory INTO v_track_inventory FROM products WHERE id = v_product_id;
      IF v_track_inventory = true THEN
        UPDATE products
        SET stock_quantity = COALESCE(stock_quantity, 0) + v_quantity, updated_at = now()
        WHERE id = v_product_id;

        INSERT INTO inventory_movements (
          organization_id, product_id, movement_type, quantity,
          reference_type, reference_id, notes, created_by
        ) VALUES (
          p_organization_id, v_product_id, 'pos_return', v_quantity,
          'pos_transaction', v_transaction_id,
          'POS Return: ' || v_transaction_number, p_created_by
        );
      END IF;
    END IF;

    v_item_index := v_item_index + 1;
  END LOOP;

  -- Create refund payment record
  INSERT INTO pos_transaction_payments (
    transaction_id, payment_method, amount, reference, status
  ) VALUES (
    v_transaction_id,
    CASE WHEN p_refund_method = 'store_credit' THEN 'voucher' ELSE p_refund_method END,
    -v_total,
    'Refund - ' || v_transaction_number,
    'completed'
  );

  -- Update shift expected cash if cash refund
  IF p_refund_method = 'cash' THEN
    UPDATE pos_shifts
    SET expected_cash = COALESCE(expected_cash, 0) - v_total
    WHERE id = p_shift_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'transaction_id', v_transaction_id,
    'transaction_number', v_transaction_number,
    'refund_amount', v_total
  );
END;
$$;

-- =====================================================
-- 2. VOID TRANSACTION RPC
-- Atomically voids a completed transaction:
-- - Validates transaction is completed and not already voided
-- - Restores stock for all items
-- - Reverses shift cash
-- - Marks transaction as voided with reason/auditor
-- =====================================================

CREATE OR REPLACE FUNCTION process_pos_void(
  p_organization_id UUID,
  p_transaction_id UUID,
  p_void_reason TEXT,
  p_voided_by UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_transaction RECORD;
  v_item RECORD;
  v_payment RECORD;
  v_track_inventory BOOLEAN;
  v_cash_refund NUMERIC := 0;
BEGIN
  -- Lock and validate the transaction
  SELECT * INTO v_transaction
  FROM pos_transactions
  WHERE id = p_transaction_id
    AND organization_id = p_organization_id
  FOR UPDATE;

  IF v_transaction IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_found', 'details', 'Transaction not found');
  END IF;

  IF v_transaction.status = 'voided' THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_voided', 'details', 'Transaction is already voided');
  END IF;

  IF v_transaction.status != 'completed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_status', 'details', 'Only completed transactions can be voided');
  END IF;

  -- Restore stock for all items
  FOR v_item IN 
    SELECT ti.*, p.track_inventory
    FROM pos_transaction_items ti
    LEFT JOIN products p ON p.id = ti.product_id
    WHERE ti.transaction_id = p_transaction_id
  LOOP
    IF v_item.product_id IS NOT NULL AND v_item.track_inventory = true THEN
      UPDATE products
      SET stock_quantity = COALESCE(stock_quantity, 0) + v_item.quantity, updated_at = now()
      WHERE id = v_item.product_id;

      INSERT INTO inventory_movements (
        organization_id, product_id, movement_type, quantity,
        reference_type, reference_id, notes, created_by
      ) VALUES (
        p_organization_id, v_item.product_id, 'void', v_item.quantity,
        'pos_transaction', p_transaction_id,
        'Voided: ' || v_transaction.transaction_number || ' - ' || p_void_reason,
        p_voided_by
      );
    END IF;
  END LOOP;

  -- Calculate cash to reverse from shift
  SELECT COALESCE(SUM(amount), 0) INTO v_cash_refund
  FROM pos_transaction_payments
  WHERE transaction_id = p_transaction_id
    AND payment_method = 'cash';

  -- Reverse shift expected cash
  IF v_cash_refund > 0 THEN
    UPDATE pos_shifts
    SET expected_cash = COALESCE(expected_cash, 0) - v_cash_refund
    WHERE id = v_transaction.shift_id;
  END IF;

  -- Mark transaction as voided
  UPDATE pos_transactions
  SET status = 'voided',
      voided_by = p_voided_by,
      voided_at = now(),
      void_reason = p_void_reason,
      updated_at = now()
  WHERE id = p_transaction_id;

  -- Mark all payments as voided
  UPDATE pos_transaction_payments
  SET status = 'voided'
  WHERE transaction_id = p_transaction_id;

  RETURN jsonb_build_object(
    'success', true,
    'transaction_id', p_transaction_id,
    'transaction_number', v_transaction.transaction_number,
    'voided_amount', v_transaction.total
  );
END;
$$;

-- =====================================================
-- 3. POS ACCOUNTING: Generate journal entries on shift close
-- Creates consolidated journal entry per shift:
-- DR Cash/Bank by payment method -> CR Sales Revenue + Sales Tax Payable
-- DR COGS -> CR Inventory Asset
-- =====================================================

CREATE OR REPLACE FUNCTION generate_pos_shift_journal_entry()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_journal_entry_id UUID;
  v_entry_number TEXT;
  v_payment RECORD;
  v_total_revenue NUMERIC := 0;
  v_total_tax NUMERIC := 0;
  v_total_cogs NUMERIC := 0;
  v_total_discounts NUMERIC := 0;
  v_business_id UUID;
  v_cash_account_id UUID;
  v_revenue_account_id UUID;
  v_tax_account_id UUID;
  v_cogs_account_id UUID;
  v_inventory_account_id UUID;
  v_mapping RECORD;
BEGIN
  -- Only trigger when shift status changes to 'closed'
  IF NEW.status != 'closed' OR OLD.status = 'closed' THEN
    RETURN NEW;
  END IF;

  -- Get totals from completed sale transactions in this shift
  SELECT 
    COALESCE(SUM(CASE WHEN transaction_type = 'sale' THEN subtotal ELSE -subtotal END), 0),
    COALESCE(SUM(CASE WHEN transaction_type = 'sale' THEN tax_amount ELSE -tax_amount END), 0),
    COALESCE(SUM(CASE WHEN transaction_type = 'sale' THEN discount_amount ELSE -discount_amount END), 0)
  INTO v_total_revenue, v_total_tax, v_total_discounts
  FROM pos_transactions
  WHERE shift_id = NEW.id
    AND status = 'completed'
    AND transaction_type IN ('sale', 'return');

  -- Skip if no transactions
  IF v_total_revenue = 0 AND v_total_tax = 0 THEN
    RETURN NEW;
  END IF;

  -- Calculate COGS from cost_price * quantity across completed sales
  SELECT COALESCE(SUM(
    CASE WHEN t.transaction_type = 'sale' 
      THEN COALESCE(ti.cost_price, 0) * ti.quantity 
      ELSE -COALESCE(ti.cost_price, 0) * ti.quantity 
    END
  ), 0) INTO v_total_cogs
  FROM pos_transaction_items ti
  JOIN pos_transactions t ON t.id = ti.transaction_id
  WHERE t.shift_id = NEW.id
    AND t.status = 'completed'
    AND t.transaction_type IN ('sale', 'return');

  -- Get business_id from register
  SELECT r.branch_id INTO v_business_id
  FROM pos_registers r
  WHERE r.id = NEW.register_id;

  -- Try to get mapped accounts from pos_gl_mappings, fallback to finding by account code
  SELECT debit_account_id INTO v_cash_account_id
  FROM pos_gl_mappings
  WHERE organization_id = NEW.organization_id
    AND transaction_type = 'sale'
    AND payment_method = 'cash'
    AND is_active = true
  LIMIT 1;

  SELECT credit_account_id INTO v_revenue_account_id
  FROM pos_gl_mappings
  WHERE organization_id = NEW.organization_id
    AND transaction_type = 'sale'
    AND payment_method IS NULL
    AND is_active = true
  LIMIT 1;

  -- If no mappings configured, look for accounts by code patterns
  IF v_cash_account_id IS NULL THEN
    SELECT id INTO v_cash_account_id FROM accounts
    WHERE organization_id = NEW.organization_id AND code LIKE '1%' AND account_type = 'asset' AND is_active = true
    ORDER BY code LIMIT 1;
  END IF;

  IF v_revenue_account_id IS NULL THEN
    SELECT id INTO v_revenue_account_id FROM accounts
    WHERE organization_id = NEW.organization_id AND code LIKE '4%' AND account_type = 'revenue' AND is_active = true
    ORDER BY code LIMIT 1;
  END IF;

  SELECT id INTO v_tax_account_id FROM accounts
  WHERE organization_id = NEW.organization_id AND (name ILIKE '%tax payable%' OR name ILIKE '%vat payable%' OR name ILIKE '%sales tax%') AND is_active = true
  ORDER BY code LIMIT 1;

  SELECT id INTO v_cogs_account_id FROM accounts
  WHERE organization_id = NEW.organization_id AND (name ILIKE '%cost of goods%' OR name ILIKE '%cogs%') AND is_active = true
  ORDER BY code LIMIT 1;

  SELECT id INTO v_inventory_account_id FROM accounts
  WHERE organization_id = NEW.organization_id AND (name ILIKE '%inventory%' OR name ILIKE '%stock%') AND account_type = 'asset' AND is_active = true
  ORDER BY code LIMIT 1;

  -- Only create journal entry if we have at least cash and revenue accounts
  IF v_cash_account_id IS NULL OR v_revenue_account_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Generate journal entry number
  v_entry_number := get_next_journal_entry_number(NEW.organization_id);

  -- Create the journal entry
  INSERT INTO journal_entries (
    organization_id, business_id, entry_number, entry_date,
    description, reference, status, created_by
  ) VALUES (
    NEW.organization_id, v_business_id, v_entry_number, CURRENT_DATE,
    'POS Shift Close - ' || COALESCE(NEW.shift_number, NEW.id::TEXT),
    'POS-' || COALESCE(NEW.shift_number, ''),
    'posted', NEW.user_id
  ) RETURNING id INTO v_journal_entry_id;

  -- DR: Payment method accounts (by payment method breakdown)
  FOR v_payment IN
    SELECT 
      tp.payment_method,
      SUM(tp.amount) as total_amount
    FROM pos_transaction_payments tp
    JOIN pos_transactions t ON t.id = tp.transaction_id
    WHERE t.shift_id = NEW.id
      AND t.status = 'completed'
      AND tp.status = 'completed'
    GROUP BY tp.payment_method
    HAVING SUM(tp.amount) != 0
  LOOP
    -- Find account for this payment method (from mappings or fallback)
    SELECT debit_account_id INTO v_cash_account_id
    FROM pos_gl_mappings
    WHERE organization_id = NEW.organization_id
      AND transaction_type = 'sale'
      AND payment_method = v_payment.payment_method
      AND is_active = true
    LIMIT 1;

    -- Fallback to default cash/asset account
    IF v_cash_account_id IS NULL THEN
      SELECT id INTO v_cash_account_id FROM accounts
      WHERE organization_id = NEW.organization_id AND code LIKE '1%' AND account_type = 'asset' AND is_active = true
      ORDER BY code LIMIT 1;
    END IF;

    IF v_cash_account_id IS NOT NULL AND v_payment.total_amount > 0 THEN
      INSERT INTO journal_entry_lines (
        journal_entry_id, account_id, description,
        debit_amount, credit_amount
      ) VALUES (
        v_journal_entry_id, v_cash_account_id,
        'POS ' || v_payment.payment_method || ' receipts',
        v_payment.total_amount, 0
      );
    END IF;
  END LOOP;

  -- CR: Sales Revenue (subtotal minus discounts)
  IF v_revenue_account_id IS NOT NULL AND (v_total_revenue - v_total_discounts) > 0 THEN
    INSERT INTO journal_entry_lines (
      journal_entry_id, account_id, description,
      debit_amount, credit_amount
    ) VALUES (
      v_journal_entry_id, v_revenue_account_id,
      'POS Sales Revenue',
      0, v_total_revenue - v_total_discounts
    );
  END IF;

  -- CR: Sales Tax Payable
  IF v_tax_account_id IS NOT NULL AND v_total_tax > 0 THEN
    INSERT INTO journal_entry_lines (
      journal_entry_id, account_id, description,
      debit_amount, credit_amount
    ) VALUES (
      v_journal_entry_id, v_tax_account_id,
      'POS Sales Tax Collected',
      0, v_total_tax
    );
  END IF;

  -- DR: COGS / CR: Inventory (if we have both accounts and COGS > 0)
  IF v_cogs_account_id IS NOT NULL AND v_inventory_account_id IS NOT NULL AND v_total_cogs > 0 THEN
    INSERT INTO journal_entry_lines (
      journal_entry_id, account_id, description,
      debit_amount, credit_amount
    ) VALUES (
      v_journal_entry_id, v_cogs_account_id,
      'POS Cost of Goods Sold',
      v_total_cogs, 0
    );

    INSERT INTO journal_entry_lines (
      journal_entry_id, account_id, description,
      debit_amount, credit_amount
    ) VALUES (
      v_journal_entry_id, v_inventory_account_id,
      'POS Inventory Reduction',
      0, v_total_cogs
    );
  END IF;

  -- Link journal entry to shift
  NEW.journal_entry_id := v_journal_entry_id;

  RETURN NEW;
END;
$$;

-- Create the trigger on pos_shifts
DROP TRIGGER IF EXISTS trg_pos_shift_close_journal ON public.pos_shifts;
CREATE TRIGGER trg_pos_shift_close_journal
  BEFORE UPDATE ON public.pos_shifts
  FOR EACH ROW
  EXECUTE FUNCTION generate_pos_shift_journal_entry();

-- Create index for the new original_transaction_id column
CREATE INDEX IF NOT EXISTS idx_pos_transactions_original ON public.pos_transactions(original_transaction_id);
CREATE INDEX IF NOT EXISTS idx_pos_transactions_voided ON public.pos_transactions(status) WHERE status = 'voided';
