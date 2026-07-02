
-- ============================================================
-- 1. reserve_stock — atomic stock reservation
-- ============================================================
CREATE OR REPLACE FUNCTION public.reserve_stock(
  p_organization_id UUID,
  p_product_id UUID,
  p_warehouse_id UUID,
  p_quantity NUMERIC,
  p_reference_type TEXT DEFAULT NULL,
  p_reference_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_on_hand NUMERIC;
  v_reserved NUMERIC;
  v_available NUMERIC;
BEGIN
  -- Lock the row to prevent concurrent reservation races
  SELECT quantity, reserved_quantity
  INTO v_on_hand, v_reserved
  FROM warehouse_stock
  WHERE organization_id = p_organization_id
    AND product_id = p_product_id
    AND warehouse_id = p_warehouse_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'No stock record found', 'available', 0);
  END IF;

  v_available := COALESCE(v_on_hand, 0) - COALESCE(v_reserved, 0);

  IF v_available < p_quantity THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient available stock', 'available', v_available);
  END IF;

  UPDATE warehouse_stock
  SET reserved_quantity = COALESCE(reserved_quantity, 0) + p_quantity,
      updated_at = now()
  WHERE organization_id = p_organization_id
    AND product_id = p_product_id
    AND warehouse_id = p_warehouse_id;

  RETURN jsonb_build_object('success', true, 'reserved', p_quantity, 'available', v_available - p_quantity);
END;
$$;

-- ============================================================
-- 2. release_stock — release reserved stock
-- ============================================================
CREATE OR REPLACE FUNCTION public.release_stock(
  p_organization_id UUID,
  p_product_id UUID,
  p_warehouse_id UUID,
  p_quantity NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_reserved NUMERIC;
  v_release_qty NUMERIC;
BEGIN
  SELECT reserved_quantity
  INTO v_current_reserved
  FROM warehouse_stock
  WHERE organization_id = p_organization_id
    AND product_id = p_product_id
    AND warehouse_id = p_warehouse_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'No stock record found');
  END IF;

  -- Never release more than what's reserved
  v_release_qty := LEAST(p_quantity, COALESCE(v_current_reserved, 0));

  UPDATE warehouse_stock
  SET reserved_quantity = COALESCE(reserved_quantity, 0) - v_release_qty,
      updated_at = now()
  WHERE organization_id = p_organization_id
    AND product_id = p_product_id
    AND warehouse_id = p_warehouse_id;

  RETURN jsonb_build_object('success', true, 'released', v_release_qty);
END;
$$;

-- ============================================================
-- 3. approve_stock_adjustment_atomic — atomic adjustment approval
-- ============================================================
CREATE OR REPLACE FUNCTION public.approve_stock_adjustment_atomic(
  p_adjustment_id UUID,
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_adjustment RECORD;
  v_item RECORD;
  v_org_id UUID;
  v_biz_id UUID;
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
  END LOOP;

  -- Update adjustment status atomically
  UPDATE stock_adjustments
  SET status = 'approved',
      approved_by = p_user_id,
      approved_at = now()
  WHERE id = p_adjustment_id;

  RETURN jsonb_build_object('success', true, 'adjustment_id', p_adjustment_id);
END;
$$;

-- ============================================================
-- 4. get_next_adjustment_number — race-safe sequential numbering
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_next_adjustment_number(
  p_organization_id UUID,
  p_business_id UUID DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_last_number TEXT;
  v_next_int INTEGER;
BEGIN
  -- Advisory lock scoped to this org to prevent concurrent number generation
  PERFORM pg_advisory_xact_lock(hashtext(p_organization_id::text || 'adj_number'));

  IF p_business_id IS NOT NULL THEN
    SELECT adjustment_number INTO v_last_number
    FROM stock_adjustments
    WHERE organization_id = p_organization_id
      AND business_id = p_business_id
    ORDER BY created_at DESC
    LIMIT 1;
  ELSE
    SELECT adjustment_number INTO v_last_number
    FROM stock_adjustments
    WHERE organization_id = p_organization_id
    ORDER BY created_at DESC
    LIMIT 1;
  END IF;

  IF v_last_number IS NOT NULL THEN
    v_next_int := COALESCE(
      NULLIF(regexp_replace(v_last_number, '[^0-9]', '', 'g'), '')::INTEGER,
      0
    ) + 1;
  ELSE
    v_next_int := 1;
  END IF;

  RETURN 'ADJ-' || LPAD(v_next_int::TEXT, 5, '0');
END;
$$;
