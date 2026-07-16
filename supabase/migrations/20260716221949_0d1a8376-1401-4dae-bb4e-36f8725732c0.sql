
-- =====================================================================
-- ADR-0068 · Phase C — split stock transfers into directional movements
-- =====================================================================

-- 1) Helper: resolve a business's virtual transit location -------------
CREATE OR REPLACE FUNCTION public.get_business_transit_location(p_business_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_loc uuid;
  v_org uuid;
BEGIN
  SELECT id INTO v_loc
    FROM public.stock_locations
   WHERE business_id = p_business_id
     AND location_type = 'transit'
     AND warehouse_id IS NULL
   LIMIT 1;

  IF v_loc IS NOT NULL THEN
    RETURN v_loc;
  END IF;

  -- Self-heal: if a business was created after Phase 4 seeded, mint one now.
  SELECT organization_id INTO v_org FROM public.businesses WHERE id = p_business_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Business % not found', p_business_id;
  END IF;

  INSERT INTO public.stock_locations (
    organization_id, business_id, warehouse_id, code, name,
    location_type, usage, is_active, is_default
  ) VALUES (
    v_org, p_business_id, NULL, 'TRANSIT', 'In Transit',
    'transit'::stock_location_type, 'virtual'::stock_location_usage, true, false
  )
  RETURNING id INTO v_loc;

  RETURN v_loc;
END $$;

GRANT EXECUTE ON FUNCTION public.get_business_transit_location(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_business_transit_location(uuid) IS
  'ADR-0068: canonical resolver for the business-scoped virtual transit location '
  '(Phase 4, ADR-0065). Self-heals when a business was created without a seeded row.';


-- 2) Rewrite approve_stock_transfer_atomic (dispatch leg) --------------
CREATE OR REPLACE FUNCTION public.approve_stock_transfer_atomic(p_transfer_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_transfer       RECORD;
  v_item           RECORD;
  v_in_transit_wh  uuid;
  v_transit_loc    uuid;
  v_source_loc     uuid;
  v_source_qty     numeric;
  v_is_lot_tracked boolean;
  v_lot            RECORD;
  v_allocs         jsonb;
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
  v_transit_loc   := public.get_business_transit_location(v_transfer.business_id);

  SELECT id INTO v_source_loc
    FROM public.stock_locations
   WHERE warehouse_id = v_transfer.from_warehouse_id AND is_default
   LIMIT 1;

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
        -- Out of source warehouse: transfer_out, source loc = source WH default
        INSERT INTO public.stock_movements (
          organization_id, business_id, branch_id, product_id, warehouse_id,
          movement_type, quantity, reference_type, reference_id,
          notes, lot_number, serial_number, created_by,
          source_location_id, destination_location_id
        ) VALUES (
          v_transfer.organization_id, v_transfer.business_id, v_transfer.from_branch_id,
          v_item.product_id, v_transfer.from_warehouse_id,
          'transfer_out', -v_lot.qty, 'stock_transfer', p_transfer_id,
          'Dispatch (' || v_transfer.transfer_number || ')',
          v_lot.lot_number, v_lot.serial_number, p_user_id,
          v_source_loc, NULL
        );
        -- Into transit: transfer_in, destination = business virtual transit location
        INSERT INTO public.stock_movements (
          organization_id, business_id, branch_id, product_id, warehouse_id,
          movement_type, quantity, reference_type, reference_id,
          notes, lot_number, serial_number, created_by,
          source_location_id, destination_location_id
        ) VALUES (
          v_transfer.organization_id, v_transfer.business_id, v_transfer.from_branch_id,
          v_item.product_id, v_in_transit_wh,
          'transfer_in', v_lot.qty, 'stock_transfer', p_transfer_id,
          'In-transit (' || v_transfer.transfer_number || ')',
          v_lot.lot_number, v_lot.serial_number, p_user_id,
          NULL, v_transit_loc
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
      INSERT INTO public.stock_movements (
        organization_id, business_id, branch_id, product_id, warehouse_id,
        movement_type, quantity, reference_type, reference_id, notes, created_by,
        source_location_id, destination_location_id
      ) VALUES (
        v_transfer.organization_id, v_transfer.business_id, v_transfer.from_branch_id,
        v_item.product_id, v_transfer.from_warehouse_id,
        'transfer_out', -v_item.quantity_requested,
        'stock_transfer', p_transfer_id,
        'Dispatch (' || v_transfer.transfer_number || ')', p_user_id,
        v_source_loc, NULL
      );
      INSERT INTO public.stock_movements (
        organization_id, business_id, branch_id, product_id, warehouse_id,
        movement_type, quantity, reference_type, reference_id, notes, created_by,
        source_location_id, destination_location_id
      ) VALUES (
        v_transfer.organization_id, v_transfer.business_id, v_transfer.from_branch_id,
        v_item.product_id, v_in_transit_wh,
        'transfer_in', v_item.quantity_requested,
        'stock_transfer', p_transfer_id,
        'In-transit (' || v_transfer.transfer_number || ')', p_user_id,
        NULL, v_transit_loc
      );
    END IF;
  END LOOP;

  UPDATE public.stock_transfers
     SET status = 'approved', approved_by = p_user_id, approved_at = NOW()
   WHERE id = p_transfer_id;

  RETURN jsonb_build_object('success', true, 'in_transit_warehouse_id', v_in_transit_wh);
END;
$fn$;


-- 3) Rewrite complete_stock_transfer_atomic (receive leg) -------------
CREATE OR REPLACE FUNCTION public.complete_stock_transfer_atomic(p_transfer_id uuid, p_items jsonb, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_transfer       RECORD;
  v_transfer_item  RECORD;
  v_elem           jsonb;
  v_in_transit_wh  uuid;
  v_transit_loc    uuid;
  v_dest_loc       uuid;
  v_in_transit_qty numeric;
  v_received       numeric;
  v_is_lot_tracked boolean;
  v_alloc          jsonb;
  v_alloc_qty      numeric;
  v_take           numeric;
  v_remaining      numeric;
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
  v_transit_loc   := public.get_business_transit_location(v_transfer.business_id);

  SELECT id INTO v_dest_loc
    FROM public.stock_locations
   WHERE warehouse_id = v_transfer.to_warehouse_id AND is_default
   LIMIT 1;

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
      v_remaining := v_received;
      FOR v_alloc IN SELECT * FROM jsonb_array_elements(v_transfer_item.dispatch_allocations) LOOP
        EXIT WHEN v_remaining <= 0;
        v_alloc_qty := (v_alloc->>'qty')::numeric;
        v_take := LEAST(v_alloc_qty, v_remaining);

        -- Out of transit: transfer_out, source = business virtual transit
        INSERT INTO public.stock_movements (
          organization_id, business_id, branch_id, product_id, warehouse_id,
          movement_type, quantity, reference_type, reference_id,
          notes, lot_number, serial_number, created_by,
          source_location_id, destination_location_id
        ) VALUES (
          v_transfer.organization_id, v_transfer.business_id, v_transfer.to_branch_id,
          v_transfer_item.product_id, v_in_transit_wh,
          'transfer_out', -v_take, 'stock_transfer', p_transfer_id,
          'Receive out of transit (' || v_transfer.transfer_number || ')',
          v_alloc->>'lot_number', v_alloc->>'serial_number', p_user_id,
          v_transit_loc, NULL
        );
        -- Into destination: transfer_in, destination = dest WH default
        INSERT INTO public.stock_movements (
          organization_id, business_id, branch_id, product_id, warehouse_id,
          movement_type, quantity, reference_type, reference_id,
          notes, lot_number, serial_number, created_by,
          source_location_id, destination_location_id
        ) VALUES (
          v_transfer.organization_id, v_transfer.business_id, v_transfer.to_branch_id,
          v_transfer_item.product_id, v_transfer.to_warehouse_id,
          'transfer_in', v_take, 'stock_transfer', p_transfer_id,
          'Receive (' || v_transfer.transfer_number || ')',
          v_alloc->>'lot_number', v_alloc->>'serial_number', p_user_id,
          NULL, v_dest_loc
        );
        v_remaining := v_remaining - v_take;
      END LOOP;

      IF v_remaining > 0 THEN
        RAISE EXCEPTION 'Stored dispatch allocations (%) shorter than received qty % for product %',
          v_transfer_item.dispatch_allocations, v_received, v_transfer_item.product_id;
      END IF;
    ELSE
      INSERT INTO public.stock_movements (
        organization_id, business_id, branch_id, product_id, warehouse_id,
        movement_type, quantity, reference_type, reference_id, notes, created_by,
        source_location_id, destination_location_id
      ) VALUES (
        v_transfer.organization_id, v_transfer.business_id, v_transfer.to_branch_id,
        v_transfer_item.product_id, v_in_transit_wh,
        'transfer_out', -v_received, 'stock_transfer', p_transfer_id,
        'Receive out of transit (' || v_transfer.transfer_number || ')', p_user_id,
        v_transit_loc, NULL
      );
      INSERT INTO public.stock_movements (
        organization_id, business_id, branch_id, product_id, warehouse_id,
        movement_type, quantity, reference_type, reference_id, notes, created_by,
        source_location_id, destination_location_id
      ) VALUES (
        v_transfer.organization_id, v_transfer.business_id, v_transfer.to_branch_id,
        v_transfer_item.product_id, v_transfer.to_warehouse_id,
        'transfer_in', v_received, 'stock_transfer', p_transfer_id,
        'Receive (' || v_transfer.transfer_number || ')', p_user_id,
        NULL, v_dest_loc
      );
    END IF;
  END LOOP;

  UPDATE public.stock_transfers
     SET status = 'completed', completed_at = NOW(), updated_at = NOW()
   WHERE id = p_transfer_id;

  RETURN jsonb_build_object('success', true);
END;
$fn$;

COMMENT ON FUNCTION public.approve_stock_transfer_atomic(uuid, uuid) IS
  'ADR-0068: dispatch leg. Emits transfer_out from source warehouse default '
  'location, transfer_in to business virtual transit location.';

COMMENT ON FUNCTION public.complete_stock_transfer_atomic(uuid, jsonb, uuid) IS
  'ADR-0068: receive leg. Emits transfer_out from business virtual transit '
  'location, transfer_in to destination warehouse default location.';
