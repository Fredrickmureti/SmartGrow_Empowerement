-- ============================================================
-- Phase F.1 — In-transit pseudo-warehouse infrastructure
-- ============================================================

-- Mark warehouses as virtual/in-transit so the UI hides them.
ALTER TABLE public.warehouses
  ADD COLUMN IF NOT EXISTS is_in_transit BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_warehouses_in_transit
  ON public.warehouses (business_id) WHERE is_in_transit = true;

-- Resolve (or lazily create) the in-transit warehouse for a company.
-- The warehouse is parked under the company's HQ branch — it's a
-- bookkeeping bucket, not an operational location, so the branch is
-- arbitrary as long as it satisfies the NOT NULL constraint.
CREATE OR REPLACE FUNCTION public.get_or_create_in_transit_warehouse(
  p_business_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wh_id UUID;
  v_org_id UUID;
  v_branch_id UUID;
BEGIN
  -- Fast path
  SELECT id INTO v_wh_id
  FROM public.warehouses
  WHERE business_id = p_business_id AND is_in_transit = true
  LIMIT 1;

  IF v_wh_id IS NOT NULL THEN
    RETURN v_wh_id;
  END IF;

  -- Resolve org + HQ branch for the FK
  SELECT b.organization_id INTO v_org_id
  FROM public.businesses b WHERE b.id = p_business_id;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Business % not found', p_business_id;
  END IF;

  SELECT id INTO v_branch_id
  FROM public.branches
  WHERE business_id = p_business_id AND is_headquarters = true
  LIMIT 1;

  IF v_branch_id IS NULL THEN
    SELECT id INTO v_branch_id
    FROM public.branches
    WHERE business_id = p_business_id
    ORDER BY created_at ASC
    LIMIT 1;
  END IF;

  IF v_branch_id IS NULL THEN
    RAISE EXCEPTION 'Business % has no branches; cannot create in-transit warehouse', p_business_id;
  END IF;

  INSERT INTO public.warehouses (
    organization_id, business_id, branch_id,
    code, name, is_active, is_in_transit
  ) VALUES (
    v_org_id, p_business_id, v_branch_id,
    'IN-TRANSIT', 'In Transit (system)', true, true
  )
  ON CONFLICT (business_id, code) DO UPDATE SET is_in_transit = true
  RETURNING id INTO v_wh_id;

  RETURN v_wh_id;
END;
$$;

-- ============================================================
-- Phase F.2 — Approve transfer = dispatch leg (source → in-transit)
-- ============================================================
CREATE OR REPLACE FUNCTION public.approve_stock_transfer_atomic(
  p_transfer_id UUID,
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
  v_in_transit_wh UUID;
  v_source_qty NUMERIC;
BEGIN
  SELECT * INTO v_transfer
  FROM public.stock_transfers
  WHERE id = p_transfer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Transfer not found');
  END IF;

  IF v_transfer.status NOT IN ('draft', 'pending') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Transfer must be draft or pending. Current: ' || v_transfer.status
    );
  END IF;

  v_in_transit_wh := public.get_or_create_in_transit_warehouse(v_transfer.business_id);

  -- For each requested line: dispatch source → in-transit
  FOR v_item IN
    SELECT id, product_id, quantity_requested
    FROM public.stock_transfer_items
    WHERE transfer_id = p_transfer_id
      AND quantity_requested > 0
  LOOP
    SELECT COALESCE(quantity, 0) INTO v_source_qty
    FROM public.warehouse_stock
    WHERE warehouse_id = v_transfer.from_warehouse_id
      AND product_id = v_item.product_id
    FOR UPDATE;

    IF v_source_qty < v_item.quantity_requested THEN
      RAISE EXCEPTION 'Insufficient stock for product %. Available: %, Requested: %',
        v_item.product_id, v_source_qty, v_item.quantity_requested;
    END IF;

    -- Outbound from source
    INSERT INTO public.stock_movements (
      organization_id, business_id, branch_id, product_id, warehouse_id,
      movement_type, quantity, reference_type, reference_id,
      notes, created_by
    ) VALUES (
      v_transfer.organization_id, v_transfer.business_id, v_transfer.from_branch_id,
      v_item.product_id, v_transfer.from_warehouse_id,
      'transfer', -v_item.quantity_requested,
      'stock_transfer', p_transfer_id,
      'Dispatch (' || v_transfer.transfer_number || ')',
      p_user_id
    );

    -- Inbound to in-transit (use source branch — bucket lives where it left)
    INSERT INTO public.stock_movements (
      organization_id, business_id, branch_id, product_id, warehouse_id,
      movement_type, quantity, reference_type, reference_id,
      notes, created_by
    ) VALUES (
      v_transfer.organization_id, v_transfer.business_id, v_transfer.from_branch_id,
      v_item.product_id, v_in_transit_wh,
      'transfer', v_item.quantity_requested,
      'stock_transfer', p_transfer_id,
      'In-transit (' || v_transfer.transfer_number || ')',
      p_user_id
    );
  END LOOP;

  UPDATE public.stock_transfers
  SET status = 'approved',
      approved_by = p_user_id,
      approved_at = NOW()
  WHERE id = p_transfer_id;

  RETURN jsonb_build_object('success', true, 'in_transit_warehouse_id', v_in_transit_wh);
END;
$$;

-- ============================================================
-- Phase F.3 — Complete transfer = receive leg (in-transit → destination)
-- ============================================================
-- Replaces the original which moved source → destination directly.
CREATE OR REPLACE FUNCTION public.complete_stock_transfer_atomic(
  p_transfer_id UUID,
  p_items JSONB,
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_transfer RECORD;
  v_transfer_item RECORD;
  v_in_transit_wh UUID;
  v_in_transit_qty NUMERIC;
  v_received NUMERIC;
  v_elem JSONB;
BEGIN
  SELECT * INTO v_transfer
  FROM public.stock_transfers
  WHERE id = p_transfer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Transfer not found');
  END IF;

  IF v_transfer.status != 'approved' THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Transfer must be in approved status. Current: ' || v_transfer.status);
  END IF;

  v_in_transit_wh := public.get_or_create_in_transit_warehouse(v_transfer.business_id);

  FOR v_elem IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT * INTO v_transfer_item
    FROM public.stock_transfer_items
    WHERE id = (v_elem->>'id')::UUID
      AND transfer_id = p_transfer_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Transfer item % not found', v_elem->>'id';
    END IF;

    v_received := (v_elem->>'quantity_received')::NUMERIC;

    IF v_received <= 0 THEN
      CONTINUE;
    END IF;

    -- Cannot receive more than what's in transit (= what was dispatched)
    SELECT COALESCE(quantity, 0) INTO v_in_transit_qty
    FROM public.warehouse_stock
    WHERE warehouse_id = v_in_transit_wh
      AND product_id = v_transfer_item.product_id
    FOR UPDATE;

    IF v_in_transit_qty < v_received THEN
      RAISE EXCEPTION 'In-transit stock for product % is %, cannot receive %',
        v_transfer_item.product_id, v_in_transit_qty, v_received;
    END IF;

    UPDATE public.stock_transfer_items
    SET quantity_received = v_received
    WHERE id = v_transfer_item.id;

    -- Out from in-transit (use destination branch from here on)
    INSERT INTO public.stock_movements (
      organization_id, business_id, branch_id, product_id, warehouse_id,
      movement_type, quantity, reference_type, reference_id,
      notes, created_by
    ) VALUES (
      v_transfer.organization_id, v_transfer.business_id, v_transfer.from_branch_id,
      v_transfer_item.product_id, v_in_transit_wh,
      'transfer', -v_received,
      'stock_transfer', p_transfer_id,
      'Receive out of transit (' || v_transfer.transfer_number || ')',
      p_user_id
    );

    -- Inbound to destination
    INSERT INTO public.stock_movements (
      organization_id, business_id, branch_id, product_id, warehouse_id,
      movement_type, quantity, reference_type, reference_id,
      notes, created_by
    ) VALUES (
      v_transfer.organization_id, v_transfer.business_id, v_transfer.to_branch_id,
      v_transfer_item.product_id, v_transfer.to_warehouse_id,
      'transfer', v_received,
      'stock_transfer', p_transfer_id,
      'Receive (' || v_transfer.transfer_number || ')',
      p_user_id
    );
  END LOOP;

  UPDATE public.stock_transfers
  SET status = 'completed',
      actual_arrival_date = CURRENT_DATE,
      completed_by = p_user_id,
      completed_at = NOW()
  WHERE id = p_transfer_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

-- ============================================================
-- Phase F.4 — Cancel an approved transfer = reverse dispatch leg
-- ============================================================
CREATE OR REPLACE FUNCTION public.cancel_stock_transfer_atomic(
  p_transfer_id UUID,
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
  v_in_transit_wh UUID;
  v_in_transit_qty NUMERIC;
BEGIN
  SELECT * INTO v_transfer
  FROM public.stock_transfers
  WHERE id = p_transfer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Transfer not found');
  END IF;

  IF v_transfer.status NOT IN ('draft', 'pending', 'approved') THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Only draft, pending, or approved transfers can be cancelled. Current: ' || v_transfer.status);
  END IF;

  -- If approved, return in-transit stock to source
  IF v_transfer.status = 'approved' THEN
    v_in_transit_wh := public.get_or_create_in_transit_warehouse(v_transfer.business_id);

    FOR v_item IN
      SELECT product_id, quantity_requested
      FROM public.stock_transfer_items
      WHERE transfer_id = p_transfer_id
        AND quantity_requested > 0
    LOOP
      SELECT COALESCE(quantity, 0) INTO v_in_transit_qty
      FROM public.warehouse_stock
      WHERE warehouse_id = v_in_transit_wh
        AND product_id = v_item.product_id
      FOR UPDATE;

      -- If partial receipt has occurred, return only what's still in transit
      IF v_in_transit_qty <= 0 THEN
        CONTINUE;
      END IF;

      INSERT INTO public.stock_movements (
        organization_id, business_id, branch_id, product_id, warehouse_id,
        movement_type, quantity, reference_type, reference_id, notes, created_by
      ) VALUES (
        v_transfer.organization_id, v_transfer.business_id, v_transfer.from_branch_id,
        v_item.product_id, v_in_transit_wh,
        'transfer', -LEAST(v_in_transit_qty, v_item.quantity_requested),
        'stock_transfer', p_transfer_id,
        'Cancel: out of transit (' || v_transfer.transfer_number || ')',
        p_user_id
      );

      INSERT INTO public.stock_movements (
        organization_id, business_id, branch_id, product_id, warehouse_id,
        movement_type, quantity, reference_type, reference_id, notes, created_by
      ) VALUES (
        v_transfer.organization_id, v_transfer.business_id, v_transfer.from_branch_id,
        v_item.product_id, v_transfer.from_warehouse_id,
        'transfer', LEAST(v_in_transit_qty, v_item.quantity_requested),
        'stock_transfer', p_transfer_id,
        'Cancel: return to source (' || v_transfer.transfer_number || ')',
        p_user_id
      );
    END LOOP;
  END IF;

  UPDATE public.stock_transfers
  SET status = 'cancelled', updated_at = NOW()
  WHERE id = p_transfer_id;

  RETURN jsonb_build_object('success', true);
END;
$$;