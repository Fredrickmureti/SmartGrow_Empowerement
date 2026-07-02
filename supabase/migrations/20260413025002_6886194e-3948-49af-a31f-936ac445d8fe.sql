
-- 1. Add composite index for stock_movements performance
CREATE INDEX IF NOT EXISTS idx_stock_movements_product_org_date 
ON public.stock_movements (product_id, organization_id, movement_date DESC);

-- 2. Negative stock prevention trigger
CREATE OR REPLACE FUNCTION public.validate_stock_movement_quantity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_qty numeric;
  v_available_qty numeric;
BEGIN
  -- Only validate negative-quantity movements (stock decreases)
  IF NEW.quantity >= 0 THEN
    RETURN NEW;
  END IF;

  -- Exempt corrective movement types that must be allowed to go negative temporarily
  IF NEW.movement_type IN ('count', 'adjustment', 'migration') THEN
    RETURN NEW;
  END IF;

  -- Check warehouse-specific stock if warehouse_id is set
  IF NEW.warehouse_id IS NOT NULL THEN
    SELECT COALESCE(ws.quantity, 0) - COALESCE(ws.reserved_quantity, 0)
    INTO v_available_qty
    FROM warehouse_stock ws
    WHERE ws.warehouse_id = NEW.warehouse_id AND ws.product_id = NEW.product_id;

    IF v_available_qty IS NULL THEN
      v_available_qty := 0;
    END IF;

    IF (v_available_qty + NEW.quantity) < 0 THEN
      RAISE EXCEPTION 'Insufficient stock in warehouse. Available: %, Requested: %', v_available_qty, ABS(NEW.quantity);
    END IF;
  ELSE
    -- Check global product stock
    SELECT COALESCE(p.stock_quantity, 0)
    INTO v_current_qty
    FROM products p
    WHERE p.id = NEW.product_id;

    IF v_current_qty IS NULL THEN
      v_current_qty := 0;
    END IF;

    IF (v_current_qty + NEW.quantity) < 0 THEN
      RAISE EXCEPTION 'Insufficient stock. Available: %, Requested: %', v_current_qty, ABS(NEW.quantity);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Create the trigger (BEFORE INSERT, runs before the stock update trigger)
DROP TRIGGER IF EXISTS trg_validate_stock_movement_qty ON public.stock_movements;
CREATE TRIGGER trg_validate_stock_movement_qty
  BEFORE INSERT ON public.stock_movements
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_stock_movement_quantity();

-- 3. Extend approve_stock_adjustment_atomic to include GL posting server-side
CREATE OR REPLACE FUNCTION public.approve_stock_adjustment_atomic(p_adjustment_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_adjustment RECORD;
  v_item RECORD;
  v_org_id UUID;
  v_biz_id UUID;
  v_inventory_account_id UUID;
  v_adjustment_account_id UUID;
  v_total_positive numeric := 0;
  v_total_negative numeric := 0;
  v_journal_id UUID;
  v_cost numeric;
BEGIN
  -- Lock the adjustment row and verify it's still draft
  SELECT id, organization_id, business_id, status
  INTO v_adjustment
  FROM stock_adjustments
  WHERE id = p_adjustment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Adjustment not found');
  END IF;

  IF v_adjustment.status != 'draft' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Adjustment is not in draft status (current: ' || v_adjustment.status || ')');
  END IF;

  v_org_id := v_adjustment.organization_id;
  v_biz_id := v_adjustment.business_id;

  -- Create stock movements for each item
  FOR v_item IN
    SELECT * FROM stock_adjustment_items WHERE adjustment_id = p_adjustment_id
  LOOP
    INSERT INTO stock_movements (
      organization_id, business_id, product_id, movement_type,
      quantity, unit_cost, warehouse_id,
      reference_type, reference_id, notes, created_by
    ) VALUES (
      v_org_id, v_biz_id, v_item.product_id, 'adjustment',
      v_item.quantity_adjustment, v_item.unit_cost, v_item.warehouse_id,
      'stock_adjustment', p_adjustment_id, v_item.notes, p_user_id
    );

    -- Accumulate costs for GL posting
    v_cost := ABS(v_item.quantity_adjustment) * COALESCE(v_item.unit_cost, 0);
    IF v_cost > 0 THEN
      IF v_item.quantity_adjustment > 0 THEN
        v_total_positive := v_total_positive + v_cost;
      ELSE
        v_total_negative := v_total_negative + v_cost;
      END IF;
    END IF;
  END LOOP;

  -- Update adjustment status atomically
  UPDATE stock_adjustments
  SET status = 'approved',
      approved_by = p_user_id,
      approved_at = now()
  WHERE id = p_adjustment_id;

  -- GL Posting: look up default accounts for the organization
  SELECT 
    (SELECT a.id FROM accounts a WHERE a.organization_id = v_org_id AND a.detail_type = 'inventory' AND a.is_active = true LIMIT 1),
    (SELECT a.id FROM accounts a WHERE a.organization_id = v_org_id AND a.detail_type = 'inventory_adjustment' AND a.is_active = true LIMIT 1)
  INTO v_inventory_account_id, v_adjustment_account_id;

  -- Fallback: try operating_expenses for adjustment account
  IF v_adjustment_account_id IS NULL THEN
    SELECT a.id INTO v_adjustment_account_id
    FROM accounts a 
    WHERE a.organization_id = v_org_id AND a.detail_type = 'operating_expenses' AND a.is_active = true 
    LIMIT 1;
  END IF;

  -- Only post GL if both accounts are found and there are costs
  IF v_inventory_account_id IS NOT NULL AND v_adjustment_account_id IS NOT NULL AND (v_total_positive > 0 OR v_total_negative > 0) THEN
    -- Create journal entry
    INSERT INTO journal_entries (
      organization_id, business_id, entry_date, reference, memo,
      source_type, source_id, status, created_by
    ) VALUES (
      v_org_id, v_biz_id, CURRENT_DATE, 
      'ADJ-' || LEFT(p_adjustment_id::text, 8),
      'Stock adjustment approved',
      'stock_adjustment', 'stock-adj-' || p_adjustment_id::text,
      'posted', p_user_id
    ) RETURNING id INTO v_journal_id;

    -- Surplus entries: DR Inventory, CR Adjustment
    IF v_total_positive > 0 THEN
      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit_amount, credit_amount, description)
      VALUES 
        (v_journal_id, v_inventory_account_id, v_total_positive, 0, 'Stock Adjustment - Inventory Increase'),
        (v_journal_id, v_adjustment_account_id, 0, v_total_positive, 'Stock Adjustment - Inventory Increase Offset');
    END IF;

    -- Shortage entries: DR Adjustment, CR Inventory
    IF v_total_negative > 0 THEN
      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit_amount, credit_amount, description)
      VALUES 
        (v_journal_id, v_adjustment_account_id, v_total_negative, 0, 'Stock Adjustment - Shrinkage/Loss'),
        (v_journal_id, v_inventory_account_id, 0, v_total_negative, 'Stock Adjustment - Inventory Reduction');
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true, 'adjustment_id', p_adjustment_id, 'gl_posted', v_journal_id IS NOT NULL);
END;
$$;
