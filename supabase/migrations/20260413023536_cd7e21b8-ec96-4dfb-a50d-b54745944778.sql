
-- ============================================================
-- 1. ATOMIC STOCK TRANSFER RPC
-- ============================================================
CREATE OR REPLACE FUNCTION public.complete_stock_transfer_atomic(
  p_transfer_id UUID,
  p_items JSONB, -- array of {id: uuid, quantity_received: int}
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_transfer RECORD;
  v_item RECORD;
  v_transfer_item RECORD;
  v_source_qty NUMERIC;
  v_results JSONB := '[]'::JSONB;
  v_elem JSONB;
BEGIN
  -- Lock and fetch the transfer
  SELECT * INTO v_transfer
  FROM stock_transfers
  WHERE id = p_transfer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Transfer not found');
  END IF;

  IF v_transfer.status != 'approved' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Transfer must be in approved status. Current: ' || v_transfer.status);
  END IF;

  -- Process each item
  FOR v_elem IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    -- Get transfer item
    SELECT * INTO v_transfer_item
    FROM stock_transfer_items
    WHERE id = (v_elem->>'id')::UUID
      AND transfer_id = p_transfer_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Transfer item % not found', v_elem->>'id';
    END IF;

    -- Skip zero quantities
    IF (v_elem->>'quantity_received')::NUMERIC <= 0 THEN
      CONTINUE;
    END IF;

    -- Validate source stock
    SELECT COALESCE(quantity, 0) INTO v_source_qty
    FROM warehouse_stock
    WHERE warehouse_id = v_transfer.from_warehouse_id
      AND product_id = v_transfer_item.product_id;

    IF v_source_qty < (v_elem->>'quantity_received')::NUMERIC THEN
      RAISE EXCEPTION 'Insufficient stock for product %. Available: %, Requested: %',
        v_transfer_item.product_id, v_source_qty, v_elem->>'quantity_received';
    END IF;

    -- Update the transfer item
    UPDATE stock_transfer_items
    SET quantity_received = (v_elem->>'quantity_received')::NUMERIC
    WHERE id = v_transfer_item.id;

    -- Create outbound movement (source warehouse)
    INSERT INTO stock_movements (
      organization_id, business_id, product_id, warehouse_id,
      movement_type, quantity, reference_type, reference_id,
      notes, created_by
    ) VALUES (
      v_transfer.organization_id,
      v_transfer.business_id,
      v_transfer_item.product_id,
      v_transfer.from_warehouse_id,
      'transfer',
      -(v_elem->>'quantity_received')::NUMERIC,
      'stock_transfer',
      p_transfer_id,
      'Transfer out (' || v_transfer.transfer_number || ')',
      p_user_id
    );

    -- Create inbound movement (destination warehouse)
    INSERT INTO stock_movements (
      organization_id, business_id, product_id, warehouse_id,
      movement_type, quantity, reference_type, reference_id,
      notes, created_by
    ) VALUES (
      v_transfer.organization_id,
      v_transfer.business_id,
      v_transfer_item.product_id,
      v_transfer.to_warehouse_id,
      'transfer',
      (v_elem->>'quantity_received')::NUMERIC,
      'stock_transfer',
      p_transfer_id,
      'Transfer in (' || v_transfer.transfer_number || ')',
      p_user_id
    );
  END LOOP;

  -- Mark transfer as completed
  UPDATE stock_transfers
  SET status = 'completed',
      actual_arrival_date = CURRENT_DATE,
      completed_by = p_user_id,
      completed_at = NOW()
  WHERE id = p_transfer_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

-- ============================================================
-- 2. WEIGHTED AVERAGE COST TRIGGER
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_weighted_average_cost()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_qty NUMERIC;
  v_current_cost NUMERIC;
  v_new_avg NUMERIC;
BEGIN
  -- Only process receipt-type movements with positive quantity and unit_cost
  IF NEW.quantity > 0 AND NEW.unit_cost IS NOT NULL AND NEW.unit_cost > 0
     AND NEW.movement_type IN ('receipt', 'purchase', 'return_in', 'opening')
  THEN
    SELECT COALESCE(stock_quantity, 0), COALESCE(cost_price, 0)
    INTO v_current_qty, v_current_cost
    FROM products
    WHERE id = NEW.product_id;

    -- Only recalculate if we have meaningful values
    IF (v_current_qty + NEW.quantity) > 0 THEN
      v_new_avg := (v_current_qty * v_current_cost + NEW.quantity * NEW.unit_cost)
                   / (v_current_qty + NEW.quantity);

      UPDATE products
      SET cost_price = ROUND(v_new_avg, 4)
      WHERE id = NEW.product_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Create the trigger (fires AFTER the stock quantity trigger updates the product)
CREATE TRIGGER trg_update_weighted_average_cost
AFTER INSERT ON public.stock_movements
FOR EACH ROW
EXECUTE FUNCTION public.update_weighted_average_cost();
