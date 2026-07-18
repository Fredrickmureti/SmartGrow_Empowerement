
-- ============================================================================
-- WMS Phase 14a.1 + 14b — Missing operational RPCs and E2E seed helper.
-- ADR 0079 (Inventory vs Warehouse split), ADR 0076 (Stock Event Fabric).
-- ============================================================================

-- Helper: resolve caller's active (business_id, branch_id).
-- Uses user_business_access; caller must belong to a business.
CREATE OR REPLACE FUNCTION public._wms_caller_business_branch()
RETURNS TABLE(business_id uuid, organization_id uuid, branch_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT uba.business_id, uba.organization_id,
         (SELECT b.id FROM public.branches b
           WHERE b.business_id = uba.business_id
           ORDER BY b.created_at ASC LIMIT 1) AS branch_id
  FROM public.user_business_access uba
  WHERE uba.user_id = auth.uid()
  ORDER BY uba.is_primary DESC NULLS LAST, uba.created_at ASC
  LIMIT 1;
END $$;

GRANT EXECUTE ON FUNCTION public._wms_caller_business_branch() TO authenticated;

-- Assert helper: caller belongs to a given business.
CREATE OR REPLACE FUNCTION public._wms_assert_business_access(p_business_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_business_access
    WHERE user_id = auth.uid() AND business_id = p_business_id
  ) THEN
    RAISE EXCEPTION 'access denied to business %', p_business_id
      USING ERRCODE = '42501';
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION public._wms_assert_business_access(uuid) TO authenticated;

-- ============================================================================
-- RPC 1: assign_wms_task — supervisor assigns a task to an operator.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.assign_wms_task(
  p_task_id uuid,
  p_assignee_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_task public.wms_tasks;
BEGIN
  SELECT * INTO v_task FROM public.wms_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wms_task % not found', p_task_id USING ERRCODE = 'P0002';
  END IF;

  PERFORM public._wms_assert_business_access(v_task.business_id);

  -- Idempotent: same assignee + already assigned → no-op.
  IF v_task.state = 'assigned' AND v_task.assignee_user_id = p_assignee_user_id THEN
    RETURN jsonb_build_object('task_id', v_task.id, 'state', v_task.state, 'noop', true);
  END IF;

  IF v_task.state NOT IN ('pending','assigned') THEN
    RAISE EXCEPTION 'cannot assign task in state %', v_task.state
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.wms_tasks
     SET assignee_user_id = p_assignee_user_id,
         state = 'assigned',
         updated_at = now()
   WHERE id = p_task_id;

  PERFORM public.emit_business_event(
    v_task.organization_id, v_task.business_id,
    'warehouse.task.assigned', 'wms_task', v_task.id,
    format('wms.task:%s:assigned:%s', v_task.id, p_assignee_user_id),
    jsonb_build_object('task_type', v_task.task_type,
                       'assignee_user_id', p_assignee_user_id),
    v_task.branch_id, v_task.warehouse_id
  );

  RETURN jsonb_build_object('task_id', v_task.id, 'state', 'assigned');
END $$;

GRANT EXECUTE ON FUNCTION public.assign_wms_task(uuid, uuid) TO authenticated;

-- ============================================================================
-- RPC 2: claim_pick_task — operator self-assigns a pick task.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.claim_pick_task(p_task_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_task public.wms_tasks;
  v_uid  uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_task FROM public.wms_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wms_task % not found', p_task_id USING ERRCODE = 'P0002';
  END IF;

  PERFORM public._wms_assert_business_access(v_task.business_id);

  IF v_task.task_type <> 'pick' THEN
    RAISE EXCEPTION 'task % is not a pick task (type=%)',
      p_task_id, v_task.task_type USING ERRCODE = '22023';
  END IF;

  -- Idempotent for the claimer.
  IF v_task.state = 'assigned' AND v_task.assignee_user_id = v_uid THEN
    RETURN jsonb_build_object('task_id', v_task.id, 'state', v_task.state, 'noop', true);
  END IF;

  IF v_task.state <> 'pending'
     AND NOT (v_task.state = 'assigned' AND v_task.assignee_user_id IS NULL) THEN
    RAISE EXCEPTION 'pick task % already claimed (state=%, assignee=%)',
      p_task_id, v_task.state, v_task.assignee_user_id USING ERRCODE = '55006';
  END IF;

  UPDATE public.wms_tasks
     SET assignee_user_id = v_uid,
         state = 'assigned',
         updated_at = now()
   WHERE id = p_task_id;

  PERFORM public.emit_business_event(
    v_task.organization_id, v_task.business_id,
    'warehouse.task.assigned', 'wms_task', v_task.id,
    format('wms.task:%s:assigned:%s', v_task.id, v_uid),
    jsonb_build_object('task_type', 'pick', 'assignee_user_id', v_uid, 'self_claim', true),
    v_task.branch_id, v_task.warehouse_id
  );

  RETURN jsonb_build_object('task_id', v_task.id, 'state', 'assigned');
END $$;

GRANT EXECUTE ON FUNCTION public.claim_pick_task(uuid) TO authenticated;

-- ============================================================================
-- RPC 3: cancel_pick_wave — cancel a wave and its pending pick tasks.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.cancel_pick_wave(
  p_wave_id uuid,
  p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wave public.wms_pick_waves;
  v_cancelled_tasks int := 0;
BEGIN
  SELECT * INTO v_wave FROM public.wms_pick_waves WHERE id = p_wave_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wms_pick_wave % not found', p_wave_id USING ERRCODE = 'P0002';
  END IF;

  PERFORM public._wms_assert_business_access(v_wave.business_id);

  -- Idempotent.
  IF v_wave.state = 'cancelled' THEN
    RETURN jsonb_build_object('wave_id', v_wave.id, 'state', 'cancelled', 'noop', true);
  END IF;

  IF v_wave.state NOT IN ('draft','released') THEN
    RAISE EXCEPTION 'cannot cancel wave in state %', v_wave.state
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.wms_pick_waves
     SET state = 'cancelled',
         notes = COALESCE(notes,'') || CASE WHEN p_reason IS NULL THEN '' ELSE E'\ncancel: ' || p_reason END,
         updated_at = now()
   WHERE id = p_wave_id;

  -- Cancel any pick tasks still open under this wave.
  WITH upd AS (
    UPDATE public.wms_tasks
       SET state = 'cancelled',
           cancel_reason = COALESCE(p_reason, 'wave cancelled'),
           updated_at = now()
     WHERE task_type = 'pick'
       AND source_doc_type = 'wms_pick_wave'
       AND source_doc_id = p_wave_id
       AND state IN ('pending','assigned','in_progress')
     RETURNING id
  )
  SELECT count(*) INTO v_cancelled_tasks FROM upd;

  PERFORM public.emit_business_event(
    v_wave.organization_id, v_wave.business_id,
    'warehouse.wave.released', -- reuse; no cancelled event type yet, payload carries state
    'wms_pick_wave', v_wave.id,
    format('wms.wave:%s:cancelled', v_wave.id),
    jsonb_build_object('state','cancelled','reason', p_reason,
                       'cancelled_tasks', v_cancelled_tasks),
    v_wave.branch_id, v_wave.warehouse_id
  );

  RETURN jsonb_build_object('wave_id', v_wave.id, 'state', 'cancelled',
                            'cancelled_tasks', v_cancelled_tasks);
END $$;

GRANT EXECUTE ON FUNCTION public.cancel_pick_wave(uuid, text) TO authenticated;

-- ============================================================================
-- RPC 4: record_goods_receipt_line — update qty + lot on a GRN line pre-completion.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.record_goods_receipt_line(
  p_grn_item_id uuid,
  p_quantity_received numeric,
  p_lot_number text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_grn_id uuid;
  v_grn public.goods_receipts;
BEGIN
  IF p_quantity_received IS NULL OR p_quantity_received < 0 THEN
    RAISE EXCEPTION 'quantity_received must be >= 0' USING ERRCODE = '22023';
  END IF;

  SELECT goods_receipt_id INTO v_grn_id
    FROM public.goods_receipt_items WHERE id = p_grn_item_id;
  IF v_grn_id IS NULL THEN
    RAISE EXCEPTION 'goods_receipt_item % not found', p_grn_item_id USING ERRCODE='P0002';
  END IF;

  SELECT * INTO v_grn FROM public.goods_receipts WHERE id = v_grn_id FOR UPDATE;
  PERFORM public._wms_assert_business_access(v_grn.business_id);

  IF v_grn.status = 'completed' THEN
    RAISE EXCEPTION 'goods_receipt % already completed', v_grn_id USING ERRCODE='22023';
  END IF;

  UPDATE public.goods_receipt_items
     SET quantity_received = p_quantity_received,
         lot_number = COALESCE(p_lot_number, lot_number)
   WHERE id = p_grn_item_id;

  UPDATE public.goods_receipts
     SET updated_at = now()
   WHERE id = v_grn_id;

  RETURN jsonb_build_object(
    'goods_receipt_item_id', p_grn_item_id,
    'goods_receipt_id', v_grn_id,
    'quantity_received', p_quantity_received
  );
END $$;

GRANT EXECUTE ON FUNCTION public.record_goods_receipt_line(uuid, numeric, text) TO authenticated;

-- ============================================================================
-- RPC 5: record_count_scan — upsert a count line during counting.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.record_count_scan(
  p_session_id uuid,
  p_location_id uuid,
  p_product_id uuid,
  p_counted_qty numeric,
  p_lot_number text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ses public.wms_count_sessions;
  v_line_id uuid;
  v_system_qty numeric := 0;
BEGIN
  IF p_counted_qty IS NULL OR p_counted_qty < 0 THEN
    RAISE EXCEPTION 'counted_qty must be >= 0' USING ERRCODE='22023';
  END IF;

  SELECT * INTO v_ses FROM public.wms_count_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wms_count_session % not found', p_session_id USING ERRCODE='P0002';
  END IF;
  PERFORM public._wms_assert_business_access(v_ses.business_id);

  -- Advance session to counting if still draft.
  IF v_ses.state = 'draft' THEN
    UPDATE public.wms_count_sessions SET state='counting', updated_at=now() WHERE id=p_session_id;
  ELSIF v_ses.state NOT IN ('counting') THEN
    RAISE EXCEPTION 'session % is % (must be draft or counting)', p_session_id, v_ses.state
      USING ERRCODE='22023';
  END IF;

  -- Best-effort system quantity from stock_quants (if present at this bin/lot).
  BEGIN
    SELECT COALESCE(SUM(quantity), 0) INTO v_system_qty
    FROM public.stock_quants
    WHERE location_id = p_location_id
      AND product_id = p_product_id
      AND (p_lot_number IS NULL OR lot_number IS NOT DISTINCT FROM p_lot_number);
  EXCEPTION WHEN OTHERS THEN
    v_system_qty := 0;
  END;

  -- Upsert by (session_id, location_id, product_id, lot_number).
  SELECT id INTO v_line_id
  FROM public.wms_count_lines
  WHERE session_id = p_session_id
    AND location_id = p_location_id
    AND product_id  = p_product_id
    AND lot_number IS NOT DISTINCT FROM p_lot_number;

  IF v_line_id IS NULL THEN
    INSERT INTO public.wms_count_lines(
      session_id, organization_id, business_id, location_id, product_id,
      lot_number, system_qty, counted_qty, variance_qty,
      counted_by, counted_at)
    VALUES (
      p_session_id, v_ses.organization_id, v_ses.business_id, p_location_id, p_product_id,
      p_lot_number, v_system_qty, p_counted_qty, p_counted_qty - v_system_qty,
      auth.uid(), now())
    RETURNING id INTO v_line_id;
  ELSE
    UPDATE public.wms_count_lines
       SET counted_qty = p_counted_qty,
           variance_qty = p_counted_qty - system_qty,
           counted_by = auth.uid(),
           counted_at = now(),
           updated_at = now()
     WHERE id = v_line_id;
  END IF;

  PERFORM public.emit_business_event(
    v_ses.organization_id, v_ses.business_id,
    'warehouse.count.recorded', 'wms_count_line', v_line_id,
    format('wms.count_line:%s:%s', v_line_id, extract(epoch from now())::bigint),
    jsonb_build_object('session_id', p_session_id, 'location_id', p_location_id,
                       'product_id', p_product_id, 'counted_qty', p_counted_qty,
                       'system_qty', v_system_qty),
    v_ses.branch_id, v_ses.warehouse_id
  );

  RETURN jsonb_build_object('count_line_id', v_line_id,
                            'variance_qty', p_counted_qty - v_system_qty);
END $$;

GRANT EXECUTE ON FUNCTION public.record_count_scan(uuid, uuid, uuid, numeric, text) TO authenticated;

-- ============================================================================
-- RPC 6: approve_count_variance — advance session counting → review.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.approve_count_variance(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_ses public.wms_count_sessions;
BEGIN
  SELECT * INTO v_ses FROM public.wms_count_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session % not found', p_session_id USING ERRCODE='P0002';
  END IF;
  PERFORM public._wms_assert_business_access(v_ses.business_id);

  IF v_ses.state = 'review' THEN
    RETURN jsonb_build_object('session_id', v_ses.id, 'state','review','noop', true);
  END IF;
  IF v_ses.state <> 'counting' THEN
    RAISE EXCEPTION 'session % must be counting (is %)', p_session_id, v_ses.state
      USING ERRCODE='22023';
  END IF;

  UPDATE public.wms_count_sessions SET state='review', updated_at=now() WHERE id=p_session_id;
  RETURN jsonb_build_object('session_id', v_ses.id, 'state','review');
END $$;

GRANT EXECUTE ON FUNCTION public.approve_count_variance(uuid) TO authenticated;

-- ============================================================================
-- E2E SEED — idempotent per caller's active business.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.wms_e2e_ensure_seed()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_biz uuid; v_org uuid; v_branch uuid;
  v_wh uuid;
  v_loc_in uuid; v_loc_stock uuid; v_loc_out uuid;
  v_prod_a uuid; v_prod_b uuid;
  v_vendor uuid;
  v_po uuid;
  v_po_line1 uuid; v_po_line2 uuid;
BEGIN
  SELECT business_id, organization_id, branch_id
    INTO v_biz, v_org, v_branch
    FROM public._wms_caller_business_branch();

  IF v_biz IS NULL THEN
    RAISE EXCEPTION 'caller has no business access' USING ERRCODE='42501';
  END IF;
  IF v_branch IS NULL THEN
    RAISE EXCEPTION 'business % has no branches; create one before running the E2E seed', v_biz
      USING ERRCODE='P0001';
  END IF;

  -- Warehouse (idempotent by (business_id, code)).
  SELECT id INTO v_wh FROM public.warehouses
   WHERE business_id = v_biz AND code = 'E2E_WH';
  IF v_wh IS NULL THEN
    INSERT INTO public.warehouses(organization_id, business_id, branch_id, code, name,
                                  is_active, is_sample_data)
    VALUES (v_org, v_biz, v_branch, 'E2E_WH', 'E2E Warehouse', true, true)
    RETURNING id INTO v_wh;
  END IF;

  -- Three locations: INBOUND (staging), STOCK, OUTBOUND.
  SELECT id INTO v_loc_in FROM public.stock_locations
   WHERE business_id = v_biz AND warehouse_id = v_wh AND code = 'E2E_INBOUND';
  IF v_loc_in IS NULL THEN
    INSERT INTO public.stock_locations(organization_id, business_id, branch_id, warehouse_id,
      code, name, location_type, usage, is_active, is_receiving_staging, structure_level)
    VALUES (v_org, v_biz, v_branch, v_wh, 'E2E_INBOUND', 'E2E Inbound Staging',
            'internal', 'internal', true, true, 'zone')
    RETURNING id INTO v_loc_in;
  END IF;

  SELECT id INTO v_loc_stock FROM public.stock_locations
   WHERE business_id = v_biz AND warehouse_id = v_wh AND code = 'E2E_STOCK';
  IF v_loc_stock IS NULL THEN
    INSERT INTO public.stock_locations(organization_id, business_id, branch_id, warehouse_id,
      code, name, location_type, usage, is_active, is_putaway_target, pick_sequence, structure_level)
    VALUES (v_org, v_biz, v_branch, v_wh, 'E2E_STOCK', 'E2E Stock Bin A1',
            'internal', 'internal', true, true, 10, 'bin')
    RETURNING id INTO v_loc_stock;
  END IF;

  SELECT id INTO v_loc_out FROM public.stock_locations
   WHERE business_id = v_biz AND warehouse_id = v_wh AND code = 'E2E_OUTBOUND';
  IF v_loc_out IS NULL THEN
    INSERT INTO public.stock_locations(organization_id, business_id, branch_id, warehouse_id,
      code, name, location_type, usage, is_active, structure_level)
    VALUES (v_org, v_biz, v_branch, v_wh, 'E2E_OUTBOUND', 'E2E Outbound Staging',
            'internal', 'internal', true, 'zone')
    RETURNING id INTO v_loc_out;
  END IF;

  -- Products (idempotent by (business_id, sku)).
  SELECT id INTO v_prod_a FROM public.products
   WHERE business_id = v_biz AND sku = 'E2E-SKU-A';
  IF v_prod_a IS NULL THEN
    INSERT INTO public.products(organization_id, business_id, name, sku, type, unit_price,
                                is_active, track_inventory, is_sample_data)
    VALUES (v_org, v_biz, 'E2E Product A', 'E2E-SKU-A', 'good', 10.00, true, true, true)
    RETURNING id INTO v_prod_a;
  END IF;

  SELECT id INTO v_prod_b FROM public.products
   WHERE business_id = v_biz AND sku = 'E2E-SKU-B';
  IF v_prod_b IS NULL THEN
    INSERT INTO public.products(organization_id, business_id, name, sku, type, unit_price,
                                is_active, track_inventory, is_sample_data)
    VALUES (v_org, v_biz, 'E2E Product B', 'E2E-SKU-B', 'good', 20.00, true, true, true)
    RETURNING id INTO v_prod_b;
  END IF;

  -- Vendor contact (idempotent by (business_id, name, type)).
  SELECT id INTO v_vendor FROM public.contacts
   WHERE business_id = v_biz AND name = 'E2E Vendor' AND type = 'vendor';
  IF v_vendor IS NULL THEN
    INSERT INTO public.contacts(organization_id, business_id, name, type, is_company,
                                supplier_rank, is_sample_data)
    VALUES (v_org, v_biz, 'E2E Vendor', 'vendor', true, 1, true)
    RETURNING id INTO v_vendor;
  END IF;

  -- Purchase order (idempotent by (business_id, po_number)).
  SELECT id INTO v_po FROM public.purchase_orders
   WHERE business_id = v_biz AND po_number = 'E2E-PO-0001';
  IF v_po IS NULL THEN
    INSERT INTO public.purchase_orders(organization_id, business_id, branch_id, vendor_id,
      po_number, status, order_date, subtotal, total, is_sample_data)
    VALUES (v_org, v_biz, v_branch, v_vendor, 'E2E-PO-0001', 'confirmed', CURRENT_DATE,
            100, 100, true)
    RETURNING id INTO v_po;

    INSERT INTO public.purchase_order_items(purchase_order_id, product_id, description,
      quantity, unit_price, line_total, sort_order, is_sample_data)
    VALUES (v_po, v_prod_a, 'E2E Product A', 5, 10.00, 50.00, 1, true)
    RETURNING id INTO v_po_line1;

    INSERT INTO public.purchase_order_items(purchase_order_id, product_id, description,
      quantity, unit_price, line_total, sort_order, is_sample_data)
    VALUES (v_po, v_prod_b, 'E2E Product B', 5, 20.00, 100.00, 2, true)
    RETURNING id INTO v_po_line2;
  END IF;

  RETURN jsonb_build_object(
    'business_id', v_biz,
    'branch_id', v_branch,
    'warehouse_id', v_wh,
    'locations', jsonb_build_object('inbound', v_loc_in, 'stock', v_loc_stock, 'outbound', v_loc_out),
    'products', jsonb_build_array(v_prod_a, v_prod_b),
    'vendor_id', v_vendor,
    'purchase_order_id', v_po
  );
END $$;

GRANT EXECUTE ON FUNCTION public.wms_e2e_ensure_seed() TO authenticated;

COMMENT ON FUNCTION public.wms_e2e_ensure_seed() IS
  'WMS Phase 14b — idempotent E2E fixture for the caller''s active business. Extend as later sub-phases (14c–14g) require additional entities.';
