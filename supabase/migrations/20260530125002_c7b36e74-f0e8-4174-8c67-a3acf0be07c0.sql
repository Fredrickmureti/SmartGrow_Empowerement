-- 1. Fix consume_lots_atomic sign convention -----------------------------------
CREATE OR REPLACE FUNCTION public.consume_lots_atomic(
  p_organization_id uuid, p_business_id uuid, p_warehouse_id uuid, p_branch_id uuid,
  p_product_id uuid, p_movement_type text, p_reference_type text, p_reference_id uuid,
  p_user_id uuid, p_notes text, p_allocations jsonb, p_unit_cost numeric DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_alloc jsonb; v_qty numeric; v_total numeric := 0;
  v_lot text; v_serial text; v_override boolean;
  v_mid uuid; v_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF p_allocations IS NULL OR jsonb_array_length(p_allocations) = 0 THEN
    RAISE EXCEPTION 'allocations array required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_movement_type NOT IN
     ('sale','delivery','pos_sale','transfer_out','scrap','adjustment_out','return_out','vendor_return') THEN
    RAISE EXCEPTION 'consume_lots_atomic only handles outbound movement types, got %', p_movement_type
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
    v_lot      := v_alloc->>'lot_number';
    v_serial   := v_alloc->>'serial_number';
    v_qty      := (v_alloc->>'qty')::numeric;
    v_override := COALESCE((v_alloc->>'allocation_override')::boolean, false);

    IF v_lot IS NULL OR v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'each allocation needs lot_number and positive qty: %', v_alloc
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    INSERT INTO public.stock_movements (
      organization_id, business_id, branch_id, warehouse_id,
      product_id, movement_type, quantity, unit_cost,
      reference_type, reference_id, notes,
      lot_number, serial_number, created_by
    ) VALUES (
      p_organization_id, p_business_id, p_branch_id, p_warehouse_id,
      p_product_id, p_movement_type::stock_movement_type, -v_qty,   -- negative for outbound
      COALESCE(p_unit_cost, 0),
      p_reference_type, p_reference_id,
      COALESCE(p_notes, '') || CASE WHEN v_override THEN ' [lot override]' ELSE '' END,
      v_lot, v_serial, p_user_id
    ) RETURNING id INTO v_mid;

    v_ids   := v_ids || v_mid;
    v_total := v_total + v_qty;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'movement_ids', to_jsonb(v_ids),
    'total_qty', v_total,
    'lot_count', jsonb_array_length(p_allocations)
  );
END;
$fn$;

-- 2. Add dispatch_allocations column -------------------------------------------
ALTER TABLE public.stock_transfer_items
  ADD COLUMN IF NOT EXISTS dispatch_allocations jsonb;

COMMENT ON COLUMN public.stock_transfer_items.dispatch_allocations IS
  'JSON array of {lot_number, serial_number, qty} captured at approval time. Replayed FEFO on receipt.';

-- 3. Rewire approve_stock_transfer_atomic --------------------------------------
CREATE OR REPLACE FUNCTION public.approve_stock_transfer_atomic(p_transfer_id uuid, p_user_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_transfer RECORD;
  v_item RECORD;
  v_in_transit_wh uuid;
  v_source_qty numeric;
  v_is_lot_tracked boolean;
  v_lot RECORD;
  v_allocs jsonb;
BEGIN
  SELECT * INTO v_transfer FROM public.stock_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Transfer not found');
  END IF;
  IF v_transfer.status NOT IN ('draft','pending') THEN
    RETURN jsonb_build_object('success', false,
      'error', 'Transfer must be draft or pending. Current: ' || v_transfer.status);
  END IF;

  v_in_transit_wh := public.get_or_create_in_transit_warehouse(v_transfer.business_id);

  FOR v_item IN
    SELECT id, product_id, quantity_requested
      FROM public.stock_transfer_items
     WHERE transfer_id = p_transfer_id
       AND quantity_requested > 0
  LOOP
    SELECT COALESCE(quantity, 0) INTO v_source_qty
      FROM public.warehouse_stock
     WHERE warehouse_id = v_transfer.from_warehouse_id
       AND product_id   = v_item.product_id
     FOR UPDATE;

    IF v_source_qty < v_item.quantity_requested THEN
      RAISE EXCEPTION 'Insufficient stock for product %. Available: %, Requested: %',
        v_item.product_id, v_source_qty, v_item.quantity_requested;
    END IF;

    SELECT COALESCE(is_lot_tracked, false) INTO v_is_lot_tracked
      FROM public.products WHERE id = v_item.product_id;

    IF v_is_lot_tracked THEN
      v_allocs := '[]'::jsonb;
      FOR v_lot IN
        SELECT * FROM public.resolve_fefo_lots(
          v_transfer.business_id, v_transfer.from_warehouse_id,
          v_item.product_id, v_item.quantity_requested)
      LOOP
        -- Dispatch out of source (negative)
        INSERT INTO public.stock_movements (
          organization_id, business_id, branch_id, product_id, warehouse_id,
          movement_type, quantity, reference_type, reference_id,
          notes, lot_number, serial_number, created_by
        ) VALUES (
          v_transfer.organization_id, v_transfer.business_id, v_transfer.from_branch_id,
          v_item.product_id, v_transfer.from_warehouse_id,
          'transfer', -v_lot.qty, 'stock_transfer', p_transfer_id,
          'Dispatch (' || v_transfer.transfer_number || ')',
          v_lot.lot_number, v_lot.serial_number, p_user_id
        );
        -- Into in-transit (positive) with same lot
        INSERT INTO public.stock_movements (
          organization_id, business_id, branch_id, product_id, warehouse_id,
          movement_type, quantity, reference_type, reference_id,
          notes, lot_number, serial_number, created_by
        ) VALUES (
          v_transfer.organization_id, v_transfer.business_id, v_transfer.from_branch_id,
          v_item.product_id, v_in_transit_wh,
          'transfer', v_lot.qty, 'stock_transfer', p_transfer_id,
          'In-transit (' || v_transfer.transfer_number || ')',
          v_lot.lot_number, v_lot.serial_number, p_user_id
        );
        v_allocs := v_allocs || jsonb_build_object(
          'lot_number', v_lot.lot_number,
          'serial_number', v_lot.serial_number,
          'qty', v_lot.qty);
      END LOOP;

      UPDATE public.stock_transfer_items
         SET dispatch_allocations = v_allocs
       WHERE id = v_item.id;
    ELSE
      -- Non-lot-tracked: original aggregate behavior
      INSERT INTO public.stock_movements (
        organization_id, business_id, branch_id, product_id, warehouse_id,
        movement_type, quantity, reference_type, reference_id, notes, created_by
      ) VALUES (
        v_transfer.organization_id, v_transfer.business_id, v_transfer.from_branch_id,
        v_item.product_id, v_transfer.from_warehouse_id,
        'transfer', -v_item.quantity_requested,
        'stock_transfer', p_transfer_id,
        'Dispatch (' || v_transfer.transfer_number || ')', p_user_id
      );
      INSERT INTO public.stock_movements (
        organization_id, business_id, branch_id, product_id, warehouse_id,
        movement_type, quantity, reference_type, reference_id, notes, created_by
      ) VALUES (
        v_transfer.organization_id, v_transfer.business_id, v_transfer.from_branch_id,
        v_item.product_id, v_in_transit_wh,
        'transfer', v_item.quantity_requested,
        'stock_transfer', p_transfer_id,
        'In-transit (' || v_transfer.transfer_number || ')', p_user_id
      );
    END IF;
  END LOOP;

  UPDATE public.stock_transfers
     SET status = 'approved', approved_by = p_user_id, approved_at = NOW()
   WHERE id = p_transfer_id;

  RETURN jsonb_build_object('success', true, 'in_transit_warehouse_id', v_in_transit_wh);
END;
$fn$;

-- 4. Rewire complete_stock_transfer_atomic -------------------------------------
CREATE OR REPLACE FUNCTION public.complete_stock_transfer_atomic(
  p_transfer_id uuid, p_items jsonb, p_user_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_transfer RECORD; v_transfer_item RECORD; v_elem jsonb;
  v_in_transit_wh uuid; v_in_transit_qty numeric; v_received numeric;
  v_is_lot_tracked boolean;
  v_alloc jsonb; v_alloc_qty numeric; v_take numeric; v_remaining numeric;
BEGIN
  SELECT * INTO v_transfer FROM public.stock_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Transfer not found');
  END IF;
  IF v_transfer.status != 'approved' THEN
    RETURN jsonb_build_object('success', false,
      'error', 'Transfer must be in approved status. Current: ' || v_transfer.status);
  END IF;

  v_in_transit_wh := public.get_or_create_in_transit_warehouse(v_transfer.business_id);

  FOR v_elem IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_transfer_item
      FROM public.stock_transfer_items
     WHERE id = (v_elem->>'id')::uuid
       AND transfer_id = p_transfer_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Transfer item % not found', v_elem->>'id';
    END IF;

    v_received := (v_elem->>'quantity_received')::numeric;
    IF v_received <= 0 THEN CONTINUE; END IF;

    SELECT COALESCE(quantity, 0) INTO v_in_transit_qty
      FROM public.warehouse_stock
     WHERE warehouse_id = v_in_transit_wh
       AND product_id   = v_transfer_item.product_id
     FOR UPDATE;
    IF v_in_transit_qty < v_received THEN
      RAISE EXCEPTION 'In-transit stock for product % is %, cannot receive %',
        v_transfer_item.product_id, v_in_transit_qty, v_received;
    END IF;

    UPDATE public.stock_transfer_items
       SET quantity_received = v_received
     WHERE id = v_transfer_item.id;

    SELECT COALESCE(is_lot_tracked, false) INTO v_is_lot_tracked
      FROM public.products WHERE id = v_transfer_item.product_id;

    IF v_is_lot_tracked
       AND v_transfer_item.dispatch_allocations IS NOT NULL
       AND jsonb_array_length(v_transfer_item.dispatch_allocations) > 0 THEN
      -- Replay stored allocations in order, taking up to v_received
      v_remaining := v_received;
      FOR v_alloc IN SELECT * FROM jsonb_array_elements(v_transfer_item.dispatch_allocations) LOOP
        EXIT WHEN v_remaining <= 0;
        v_alloc_qty := (v_alloc->>'qty')::numeric;
        v_take := LEAST(v_alloc_qty, v_remaining);

        -- Out of in-transit (negative)
        INSERT INTO public.stock_movements (
          organization_id, business_id, branch_id, product_id, warehouse_id,
          movement_type, quantity, reference_type, reference_id,
          notes, lot_number, serial_number, created_by
        ) VALUES (
          v_transfer.organization_id, v_transfer.business_id, v_transfer.from_branch_id,
          v_transfer_item.product_id, v_in_transit_wh,
          'transfer', -v_take, 'stock_transfer', p_transfer_id,
          'Receive out of transit (' || v_transfer.transfer_number || ')',
          v_alloc->>'lot_number', v_alloc->>'serial_number', p_user_id
        );
        -- Into destination (positive)
        INSERT INTO public.stock_movements (
          organization_id, business_id, branch_id, product_id, warehouse_id,
          movement_type, quantity, reference_type, reference_id,
          notes, lot_number, serial_number, created_by
        ) VALUES (
          v_transfer.organization_id, v_transfer.business_id, v_transfer.to_branch_id,
          v_transfer_item.product_id, v_transfer.to_warehouse_id,
          'transfer', v_take, 'stock_transfer', p_transfer_id,
          'Receive (' || v_transfer.transfer_number || ')',
          v_alloc->>'lot_number', v_alloc->>'serial_number', p_user_id
        );
        v_remaining := v_remaining - v_take;
      END LOOP;

      IF v_remaining > 0 THEN
        RAISE EXCEPTION 'Stored dispatch allocations (%) shorter than received qty % for product %',
          v_transfer_item.dispatch_allocations, v_received, v_transfer_item.product_id;
      END IF;
    ELSE
      -- Non-lot-tracked or legacy approval without recorded allocations
      INSERT INTO public.stock_movements (
        organization_id, business_id, branch_id, product_id, warehouse_id,
        movement_type, quantity, reference_type, reference_id, notes, created_by
      ) VALUES (
        v_transfer.organization_id, v_transfer.business_id, v_transfer.from_branch_id,
        v_transfer_item.product_id, v_in_transit_wh,
        'transfer', -v_received, 'stock_transfer', p_transfer_id,
        'Receive out of transit (' || v_transfer.transfer_number || ')', p_user_id
      );
      INSERT INTO public.stock_movements (
        organization_id, business_id, branch_id, product_id, warehouse_id,
        movement_type, quantity, reference_type, reference_id, notes, created_by
      ) VALUES (
        v_transfer.organization_id, v_transfer.business_id, v_transfer.to_branch_id,
        v_transfer_item.product_id, v_transfer.to_warehouse_id,
        'transfer', v_received, 'stock_transfer', p_transfer_id,
        'Receive (' || v_transfer.transfer_number || ')', p_user_id
      );
    END IF;
  END LOOP;

  UPDATE public.stock_transfers
     SET status = 'completed',
         actual_arrival_date = CURRENT_DATE,
         completed_by = p_user_id,
         completed_at = NOW()
   WHERE id = p_transfer_id;

  RETURN jsonb_build_object('success', true);
END;
$fn$;