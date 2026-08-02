-- =========================================================================
-- Returns Phase 2 — server-side operations
-- =========================================================================

-- 1) Capture --------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_capture_return_line(
  p_return_id uuid,
  p_product_id uuid,
  p_received_qty numeric,
  p_expected_qty numeric DEFAULT NULL,
  p_lpn_id uuid DEFAULT NULL,
  p_lot_number text DEFAULT NULL,
  p_serial_number text DEFAULT NULL,
  p_uom text DEFAULT NULL,
  p_condition_code public.wms_return_condition DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_client_scan_id text DEFAULT NULL,
  p_device_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_prior jsonb;
  v_ord public.wms_return_orders%ROWTYPE;
  v_line_id uuid;
  v_unexpected boolean := false;
  v_result jsonb;
BEGIN
  v_prior := public._wms_client_scan_lookup(p_device_id, p_client_scan_id);
  IF v_prior IS NOT NULL THEN
    RETURN v_prior || jsonb_build_object('replayed', true);
  END IF;

  SELECT * INTO v_ord FROM public.wms_return_orders WHERE id = p_return_id FOR UPDATE;
  IF v_ord.id IS NULL THEN RAISE EXCEPTION 'return order % not found', p_return_id USING ERRCODE = '22023'; END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_ord.business_id) THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;
  IF v_ord.state NOT IN ('authorized','in_transit','received','inspecting') THEN
    RAISE EXCEPTION 'cannot capture lines while return is %', v_ord.state USING ERRCODE = '22023';
  END IF;
  IF p_received_qty IS NULL OR p_received_qty < 0 THEN
    RAISE EXCEPTION 'received_qty must be >= 0' USING ERRCODE = '22023';
  END IF;

  -- Prefer an expected, uncaptured line for this product (and lot when given).
  SELECT id INTO v_line_id
    FROM public.wms_return_lines
   WHERE return_order_id = v_ord.id
     AND product_id = p_product_id
     AND captured_at IS NULL
     AND (p_lot_number IS NULL OR lot_number IS NULL OR lot_number = p_lot_number)
   ORDER BY (lot_number IS NOT DISTINCT FROM p_lot_number) DESC, created_at
   LIMIT 1
   FOR UPDATE;

  IF v_line_id IS NOT NULL THEN
    UPDATE public.wms_return_lines SET
      received_qty   = COALESCE(received_qty, 0) + p_received_qty,
      lot_number     = COALESCE(p_lot_number, lot_number),
      serial_number  = COALESCE(p_serial_number, serial_number),
      uom            = COALESCE(p_uom, uom),
      lpn_id         = COALESCE(p_lpn_id, lpn_id),
      condition_code = COALESCE(p_condition_code, condition_code),
      notes          = COALESCE(p_notes, notes),
      captured_by    = auth.uid(),
      captured_at    = now(),
      row_version    = row_version + 1,
      updated_at     = now()
    WHERE id = v_line_id;
  ELSE
    v_unexpected := true;
    INSERT INTO public.wms_return_lines (
      return_order_id, organization_id, business_id, warehouse_id,
      product_id, lpn_id, lot_number, serial_number, uom,
      expected_qty, received_qty, condition_code,
      captured_by, captured_at, notes
    ) VALUES (
      v_ord.id, v_ord.organization_id, v_ord.business_id, v_ord.warehouse_id,
      p_product_id, p_lpn_id, p_lot_number, p_serial_number, p_uom,
      COALESCE(p_expected_qty, 0), p_received_qty, p_condition_code,
      auth.uid(), now(), p_notes
    ) RETURNING id INTO v_line_id;
  END IF;

  v_result := jsonb_build_object(
    'line_id', v_line_id, 'return_id', v_ord.id,
    'received_qty', p_received_qty, 'unexpected', v_unexpected, 'replayed', false
  );

  PERFORM public._wms_emit_outbox(
    'warehouse.return.line_captured',
    'wms.return:' || v_line_id::text || ':line_captured',
    v_ord.organization_id, v_ord.business_id,
    jsonb_build_object(
      'aggregate_id', v_ord.id, 'line_id', v_line_id,
      'warehouse_id', v_ord.warehouse_id, 'branch_id', v_ord.branch_id,
      'actor_id', auth.uid(), 'occurred_at', now(),
      'extra', v_result
    )
  );

  PERFORM public._wms_client_scan_record(
    p_device_id, p_client_scan_id, 'wms_capture_return_line',
    v_result, v_ord.organization_id, v_ord.business_id, v_ord.warehouse_id
  );

  RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION public.wms_capture_return_line(uuid,uuid,numeric,numeric,uuid,text,text,text,public.wms_return_condition,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_capture_return_line(uuid,uuid,numeric,numeric,uuid,text,text,text,public.wms_return_condition,text,text,text) TO authenticated, service_role;

-- 2) Inspect --------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_inspect_return_line(
  p_line_id uuid,
  p_row_version integer,
  p_inspection_state public.wms_return_line_inspection_state,
  p_condition_code public.wms_return_condition DEFAULT NULL,
  p_checks jsonb DEFAULT '[]'::jsonb,
  p_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_line public.wms_return_lines%ROWTYPE;
  v_ord public.wms_return_orders%ROWTYPE;
  v_insp uuid;
  v_check jsonb;
  v_new_rv integer;
BEGIN
  SELECT * INTO v_line FROM public.wms_return_lines WHERE id = p_line_id FOR UPDATE;
  IF v_line.id IS NULL THEN RAISE EXCEPTION 'return line % not found', p_line_id USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_ord FROM public.wms_return_orders WHERE id = v_line.return_order_id;
  IF NOT public.user_can_access_business(auth.uid(), v_line.business_id) THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;
  IF v_line.row_version <> p_row_version THEN
    RAISE EXCEPTION 'return line changed since it was loaded (row_version % <> %)', v_line.row_version, p_row_version
      USING ERRCODE = '40001';
  END IF;
  IF v_line.captured_at IS NULL THEN
    RAISE EXCEPTION 'line must be captured before inspection' USING ERRCODE = '22023';
  END IF;
  IF p_inspection_state IN ('passed','failed','conditional') AND COALESCE(v_line.received_qty,0) <= 0 THEN
    RAISE EXCEPTION 'cannot conclude inspection on a zero-quantity line' USING ERRCODE = '22023';
  END IF;

  v_insp := v_line.qc_inspection_id;
  IF v_insp IS NULL THEN
    INSERT INTO public.wms_qc_inspections (
      organization_id, business_id, branch_id, warehouse_id,
      source_doc_type, source_doc_id, product_id, lot_number, serial_number,
      quantity, sample_size, sample_strategy, state, inspector_id, inspected_at,
      notes, created_by
    ) VALUES (
      v_line.organization_id, v_line.business_id, v_ord.branch_id, v_line.warehouse_id,
      'sales_return', v_line.return_order_id, v_line.product_id, v_line.lot_number, v_line.serial_number,
      COALESCE(v_line.received_qty, 0), 0, 'full', 'in_review', auth.uid(), now(),
      p_notes, auth.uid()
    ) RETURNING id INTO v_insp;
  END IF;

  UPDATE public.wms_qc_inspections SET
    state = CASE p_inspection_state
              WHEN 'passed' THEN 'accepted'
              WHEN 'failed' THEN 'rejected'
              WHEN 'conditional' THEN 'partially_accepted'
              WHEN 'inspecting' THEN 'in_review'
              ELSE state END,
    accepted_qty = CASE WHEN p_inspection_state = 'passed' THEN COALESCE(v_line.received_qty,0) ELSE accepted_qty END,
    rejected_qty = CASE WHEN p_inspection_state = 'failed' THEN COALESCE(v_line.received_qty,0) ELSE rejected_qty END,
    inspector_id = auth.uid(),
    inspected_at = now(),
    notes        = COALESCE(p_notes, notes),
    updated_at   = now()
  WHERE id = v_insp;

  IF p_checks IS NOT NULL AND jsonb_typeof(p_checks) = 'array' THEN
    FOR v_check IN SELECT * FROM jsonb_array_elements(p_checks) LOOP
      INSERT INTO public.wms_qc_inspection_checks (
        inspection_id, check_code, check_label, expected, actual, pass, severity, photo_url, recorded_by
      ) VALUES (
        v_insp,
        COALESCE(v_check->>'check_code', 'check'),
        COALESCE(v_check->>'check_label', COALESCE(v_check->>'check_code','check')),
        v_check->>'expected', v_check->>'actual',
        CASE WHEN v_check ? 'pass' THEN (v_check->>'pass')::boolean ELSE NULL END,
        NULLIF(v_check->>'severity',''),
        v_check->>'photo_url',
        auth.uid()
      );
    END LOOP;
  END IF;

  v_new_rv := v_line.row_version + 1;
  UPDATE public.wms_return_lines SET
    qc_inspection_id = v_insp,
    inspection_state = p_inspection_state,
    condition_code   = COALESCE(p_condition_code, condition_code),
    inspected_by     = auth.uid(),
    inspected_at     = now(),
    notes            = COALESCE(p_notes, notes),
    row_version      = v_new_rv,
    updated_at       = now()
  WHERE id = v_line.id;

  PERFORM public._wms_emit_outbox(
    'warehouse.return.line_inspected',
    'wms.return:' || v_line.id::text || ':line_inspected:' || v_new_rv::text,
    v_line.organization_id, v_line.business_id,
    jsonb_build_object(
      'aggregate_id', v_line.return_order_id, 'line_id', v_line.id,
      'warehouse_id', v_line.warehouse_id, 'branch_id', v_ord.branch_id,
      'actor_id', auth.uid(), 'occurred_at', now(),
      'extra', jsonb_build_object(
        'inspection_id', v_insp,
        'inspection_state', p_inspection_state,
        'condition_code', COALESCE(p_condition_code, v_line.condition_code)
      )
    )
  );

  RETURN jsonb_build_object('line_id', v_line.id, 'inspection_id', v_insp, 'row_version', v_new_rv);
END $$;

REVOKE ALL ON FUNCTION public.wms_inspect_return_line(uuid,integer,public.wms_return_line_inspection_state,public.wms_return_condition,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_inspect_return_line(uuid,integer,public.wms_return_line_inspection_state,public.wms_return_condition,jsonb,text) TO authenticated, service_role;

-- 3) Disposition ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_disposition_return_line(
  p_line_id uuid,
  p_row_version integer,
  p_disposition public.wms_return_disposition DEFAULT NULL,
  p_restock_qty numeric DEFAULT NULL,
  p_quarantine_qty numeric DEFAULT 0,
  p_scrap_qty numeric DEFAULT 0,
  p_destination_location_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_line public.wms_return_lines%ROWTYPE;
  v_ord public.wms_return_orders%ROWTYPE;
  v_rule public.wms_return_disposition_rules%ROWTYPE;
  v_disp public.wms_return_disposition;
  v_dest uuid := p_destination_location_id;
  v_restock numeric;
  v_quar numeric := COALESCE(p_quarantine_qty, 0);
  v_scrap numeric := COALESCE(p_scrap_qty, 0);
  v_new_rv integer;
BEGIN
  SELECT * INTO v_line FROM public.wms_return_lines WHERE id = p_line_id FOR UPDATE;
  IF v_line.id IS NULL THEN RAISE EXCEPTION 'return line % not found', p_line_id USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_ord FROM public.wms_return_orders WHERE id = v_line.return_order_id;
  IF NOT public.user_can_access_business(auth.uid(), v_line.business_id) THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;
  IF v_line.row_version <> p_row_version THEN
    RAISE EXCEPTION 'return line changed since it was loaded (row_version % <> %)', v_line.row_version, p_row_version
      USING ERRCODE = '40001';
  END IF;
  IF v_line.posted_at IS NOT NULL THEN
    RAISE EXCEPTION 'line already posted; disposition is immutable' USING ERRCODE = '22023';
  END IF;
  IF v_line.captured_at IS NULL THEN
    RAISE EXCEPTION 'line must be captured before disposition' USING ERRCODE = '22023';
  END IF;

  -- Rule default when the caller did not force a disposition.
  IF p_disposition IS NULL THEN
    SELECT * INTO v_rule
      FROM public.wms_return_disposition_rules r
     WHERE r.business_id = v_line.business_id
       AND r.is_active
       AND (r.warehouse_id IS NULL OR r.warehouse_id = v_line.warehouse_id)
       AND (r.return_kind IS NULL OR r.return_kind = v_ord.return_kind)
       AND (r.condition_code IS NULL OR r.condition_code = v_line.condition_code)
       AND (r.product_id IS NULL OR r.product_id = v_line.product_id)
       AND (r.customer_id IS NULL OR r.customer_id = v_ord.customer_id)
     ORDER BY r.priority, r.created_at
     LIMIT 1;
    v_disp := v_rule.disposition;
    v_dest := COALESCE(v_dest, v_rule.destination_location_id);
    IF v_disp IS NULL THEN
      RAISE EXCEPTION 'no disposition supplied and no matching disposition rule' USING ERRCODE = '22023';
    END IF;
    IF COALESCE(v_rule.requires_inspection, true) AND v_line.inspection_state IN ('pending','inspecting') THEN
      RAISE EXCEPTION 'disposition rule "%" requires a concluded inspection', v_rule.name USING ERRCODE = '22023';
    END IF;
  ELSE
    v_disp := p_disposition;
  END IF;

  -- Quantity split. Default: everything to the primary disposition bucket.
  v_restock := COALESCE(p_restock_qty,
    CASE WHEN v_disp = 'restock' THEN COALESCE(v_line.received_qty,0) - v_quar - v_scrap ELSE 0 END);
  IF v_disp = 'quarantine' AND p_quarantine_qty IS NULL THEN v_quar := COALESCE(v_line.received_qty,0); END IF;
  IF v_disp = 'scrap' AND COALESCE(p_scrap_qty,0) = 0 THEN v_scrap := COALESCE(v_line.received_qty,0) - v_restock - v_quar; END IF;

  IF v_restock < 0 OR v_quar < 0 OR v_scrap < 0 THEN
    RAISE EXCEPTION 'disposition quantities must be >= 0' USING ERRCODE = '22023';
  END IF;
  IF (v_restock + v_quar + v_scrap) > COALESCE(v_line.received_qty, 0) THEN
    RAISE EXCEPTION 'disposition quantities (%) exceed received quantity (%)',
      v_restock + v_quar + v_scrap, COALESCE(v_line.received_qty,0) USING ERRCODE = '22023';
  END IF;

  -- Destination location must belong to this warehouse and be usable.
  IF v_dest IS NOT NULL THEN
    PERFORM 1 FROM public.stock_locations l
     WHERE l.id = v_dest AND l.warehouse_id = v_line.warehouse_id AND l.is_active;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'destination location is not an active location of this warehouse' USING ERRCODE = '22023';
    END IF;
  END IF;

  v_new_rv := v_line.row_version + 1;
  UPDATE public.wms_return_lines SET
    disposition             = v_disp,
    restock_qty             = v_restock,
    quarantine_qty          = v_quar,
    scrap_qty               = v_scrap,
    destination_location_id = COALESCE(v_dest, destination_location_id),
    dispositioned_by        = auth.uid(),
    dispositioned_at        = now(),
    blocked_reason          = NULL,
    notes                   = COALESCE(p_notes, notes),
    row_version             = v_new_rv,
    updated_at              = now()
  WHERE id = v_line.id;

  PERFORM public._wms_emit_outbox(
    'warehouse.return.line_dispositioned',
    'wms.return:' || v_line.id::text || ':line_dispositioned:' || v_new_rv::text,
    v_line.organization_id, v_line.business_id,
    jsonb_build_object(
      'aggregate_id', v_line.return_order_id, 'line_id', v_line.id,
      'warehouse_id', v_line.warehouse_id, 'branch_id', v_ord.branch_id,
      'actor_id', auth.uid(), 'occurred_at', now(),
      'extra', jsonb_build_object(
        'disposition', v_disp, 'restock_qty', v_restock,
        'quarantine_qty', v_quar, 'scrap_qty', v_scrap,
        'destination_location_id', v_dest,
        'rule_id', v_rule.id
      )
    )
  );

  RETURN jsonb_build_object(
    'line_id', v_line.id, 'row_version', v_new_rv, 'disposition', v_disp,
    'restock_qty', v_restock, 'quarantine_qty', v_quar, 'scrap_qty', v_scrap
  );
END $$;

REVOKE ALL ON FUNCTION public.wms_disposition_return_line(uuid,integer,public.wms_return_disposition,numeric,numeric,numeric,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_disposition_return_line(uuid,integer,public.wms_return_disposition,numeric,numeric,numeric,uuid,text) TO authenticated, service_role;

-- 4) Post dispositions ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_post_return_dispositions(
  p_return_id uuid,
  p_row_version integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_ord public.wms_return_orders%ROWTYPE;
  v_line public.wms_return_lines%ROWTYPE;
  v_branch uuid;
  v_quarantine uuid;
  v_stock uuid;
  v_dest uuid;
  v_lot uuid;
  v_posted integer := 0;
  v_blocked integer := 0;
  v_tasks integer := 0;
  v_summary jsonb := '{}'::jsonb;
  v_restock_total numeric := 0;
  v_quar_total numeric := 0;
  v_scrap_total numeric := 0;
BEGIN
  SELECT * INTO v_ord FROM public.wms_return_orders WHERE id = p_return_id FOR UPDATE;
  IF v_ord.id IS NULL THEN RAISE EXCEPTION 'return order % not found', p_return_id USING ERRCODE = '22023'; END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_ord.business_id) THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;
  IF v_ord.row_version <> p_row_version THEN
    RAISE EXCEPTION 'return changed since it was loaded (row_version % <> %)', v_ord.row_version, p_row_version
      USING ERRCODE = '40001';
  END IF;
  IF v_ord.state NOT IN ('received','inspecting') THEN
    RAISE EXCEPTION 'return must be received or inspecting to post dispositions (state is %)', v_ord.state
      USING ERRCODE = '22023';
  END IF;

  v_branch := COALESCE(v_ord.branch_id, (SELECT branch_id FROM public.warehouses WHERE id = v_ord.warehouse_id));

  SELECT id INTO v_quarantine FROM public.stock_locations
   WHERE warehouse_id = v_ord.warehouse_id AND is_active AND location_type = 'quarantine'
   ORDER BY is_default DESC NULLS LAST, code LIMIT 1;

  SELECT id INTO v_stock FROM public.stock_locations
   WHERE warehouse_id = v_ord.warehouse_id AND is_active AND location_type = 'internal'
   ORDER BY is_default DESC NULLS LAST, code LIMIT 1;

  FOR v_line IN
    SELECT * FROM public.wms_return_lines
     WHERE return_order_id = v_ord.id
     ORDER BY created_at
     FOR UPDATE
  LOOP
    -- Blocked: nothing to post yet.
    IF v_line.disposition IS NULL OR v_line.captured_at IS NULL THEN
      UPDATE public.wms_return_lines
         SET blocked_reason = CASE WHEN v_line.captured_at IS NULL
                                   THEN 'not captured' ELSE 'no disposition' END,
             row_version = row_version + 1, updated_at = now()
       WHERE id = v_line.id;
      v_blocked := v_blocked + 1;
      PERFORM public.wms_raise_exception(
        v_ord.warehouse_id, 'other',
        'Return line cannot be posted: ' ||
          CASE WHEN v_line.captured_at IS NULL THEN 'not captured' ELSE 'no disposition' END,
        'wms_return_line', v_line.id, NULL, v_line.lpn_id, 2,
        jsonb_build_object('return_order_id', v_ord.id, 'product_id', v_line.product_id)
      );
      PERFORM public._wms_emit_outbox(
        'warehouse.return.blocked',
        'wms.return:' || v_line.id::text || ':blocked:' || (v_line.row_version + 1)::text,
        v_ord.organization_id, v_ord.business_id,
        jsonb_build_object(
          'aggregate_id', v_ord.id, 'line_id', v_line.id,
          'warehouse_id', v_ord.warehouse_id, 'branch_id', v_branch,
          'actor_id', auth.uid(), 'occurred_at', now(),
          'extra', jsonb_build_object('reason',
            CASE WHEN v_line.captured_at IS NULL THEN 'not captured' ELSE 'no disposition' END)
        )
      );
      CONTINUE;
    END IF;

    IF v_line.posted_at IS NOT NULL THEN CONTINUE; END IF;

    v_dest := COALESCE(v_line.destination_location_id, v_stock);

    -- Restock: goods come back on the books as available stock.
    IF COALESCE(v_line.restock_qty, 0) > 0 THEN
      INSERT INTO public.stock_movements (
        organization_id, business_id, branch_id, warehouse_id,
        product_id, movement_type, quantity, reference_type, reference_id,
        lot_number, source_location_id, destination_location_id,
        movement_date, notes, is_sample_data
      ) VALUES (
        v_ord.organization_id, v_ord.business_id, v_branch, v_ord.warehouse_id,
        v_line.product_id, 'return_in', v_line.restock_qty, 'wms_return_order', v_ord.id,
        v_line.lot_number, NULL, v_dest, now(),
        'Return restock (' || v_ord.code || ')', false
      );
      v_restock_total := v_restock_total + v_line.restock_qty;

      INSERT INTO public.wms_tasks (
        organization_id, business_id, branch_id, warehouse_id,
        task_type, state, priority, source_doc_type, source_doc_id,
        destination_location_id, product_id, lot_number, lpn_id, quantity, notes, created_by
      ) VALUES (
        v_ord.organization_id, v_ord.business_id, v_branch, v_ord.warehouse_id,
        'putaway', 'available', 90, 'wms_return_order', v_ord.id,
        v_dest, v_line.product_id, v_line.lot_number, COALESCE(v_line.lpn_out_id, v_line.lpn_id),
        v_line.restock_qty, 'Putaway returned stock (' || v_ord.code || ')', auth.uid()
      );
      v_tasks := v_tasks + 1;
    END IF;

    -- Quarantine: on the books, not available.
    IF COALESCE(v_line.quarantine_qty, 0) > 0 THEN
      INSERT INTO public.stock_movements (
        organization_id, business_id, branch_id, warehouse_id,
        product_id, movement_type, quantity, reference_type, reference_id,
        lot_number, source_location_id, destination_location_id,
        movement_date, notes, is_sample_data
      ) VALUES (
        v_ord.organization_id, v_ord.business_id, v_branch, v_ord.warehouse_id,
        v_line.product_id, 'quarantine_hold', v_line.quarantine_qty, 'wms_return_order', v_ord.id,
        v_line.lot_number, v_dest, COALESCE(v_quarantine, v_dest), now(),
        'Return quarantine (' || v_ord.code || ')', false
      );
      v_quar_total := v_quar_total + v_line.quarantine_qty;

      IF v_line.lot_number IS NOT NULL THEN
        SELECT id INTO v_lot FROM public.stock_lots
         WHERE business_id = v_ord.business_id AND product_id = v_line.product_id
           AND lot_number = v_line.lot_number
         ORDER BY created_at DESC LIMIT 1;
        IF v_lot IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM public.lot_quarantine q WHERE q.lot_id = v_lot AND q.status = 'active'
        ) THEN
          INSERT INTO public.lot_quarantine (
            organization_id, business_id, lot_id, warehouse_id, status, reason, authorised_by, notes
          ) VALUES (
            v_ord.organization_id, v_ord.business_id, v_lot, v_ord.warehouse_id, 'active',
            'Returned goods quarantined on RMA ' || v_ord.code, auth.uid(), v_line.blocked_reason
          );
        END IF;
      END IF;
    END IF;

    -- Scrap: goods leave the books.
    IF COALESCE(v_line.scrap_qty, 0) > 0 THEN
      INSERT INTO public.stock_movements (
        organization_id, business_id, branch_id, warehouse_id,
        product_id, movement_type, quantity, reference_type, reference_id,
        lot_number, source_location_id, destination_location_id,
        movement_date, notes, is_sample_data
      ) VALUES (
        v_ord.organization_id, v_ord.business_id, v_branch, v_ord.warehouse_id,
        v_line.product_id, 'scrap', v_line.scrap_qty, 'wms_return_order', v_ord.id,
        v_line.lot_number, v_dest, NULL, now(),
        'Return scrap (' || v_ord.code || ')', false
      );
      v_scrap_total := v_scrap_total + v_line.scrap_qty;

      INSERT INTO public.wms_tasks (
        organization_id, business_id, branch_id, warehouse_id,
        task_type, state, priority, source_doc_type, source_doc_id,
        source_location_id, product_id, lot_number, quantity, notes, created_by
      ) VALUES (
        v_ord.organization_id, v_ord.business_id, v_branch, v_ord.warehouse_id,
        'move', 'available', 80, 'wms_return_order', v_ord.id,
        v_dest, v_line.product_id, v_line.lot_number, v_line.scrap_qty,
        'Dispose scrapped return stock (' || v_ord.code || ')', auth.uid()
      );
      v_tasks := v_tasks + 1;
    END IF;

    -- Vendor return: stage the goods for an outbound vendor shipment.
    IF v_line.disposition = 'return_to_vendor' THEN
      INSERT INTO public.wms_tasks (
        organization_id, business_id, branch_id, warehouse_id,
        task_type, state, priority, source_doc_type, source_doc_id,
        source_location_id, product_id, lot_number, quantity, notes, created_by
      ) VALUES (
        v_ord.organization_id, v_ord.business_id, v_branch, v_ord.warehouse_id,
        'return', 'available', 85, 'wms_return_order', v_ord.id,
        v_dest, v_line.product_id, v_line.lot_number, COALESCE(v_line.received_qty, 0),
        'Return to vendor (' || v_ord.code || ')', auth.uid()
      );
      v_tasks := v_tasks + 1;
    END IF;

    UPDATE public.wms_return_lines
       SET posted_at = now(), blocked_reason = NULL,
           row_version = row_version + 1, updated_at = now()
     WHERE id = v_line.id;
    v_posted := v_posted + 1;
  END LOOP;

  v_summary := jsonb_build_object(
    'posted_lines', v_posted, 'blocked_lines', v_blocked, 'tasks_created', v_tasks,
    'restock_qty', v_restock_total, 'quarantine_qty', v_quar_total, 'scrap_qty', v_scrap_total,
    'posted_at', now()
  );

  UPDATE public.wms_return_orders
     SET disposition_summary = v_summary,
         posted_at = CASE WHEN v_blocked = 0 THEN now() ELSE posted_at END,
         updated_at = now()
   WHERE id = v_ord.id;

  PERFORM public._wms_emit_outbox(
    'warehouse.return.dispositions_posted',
    'wms.return:' || v_ord.id::text || ':dispositions_posted:' || v_ord.row_version::text,
    v_ord.organization_id, v_ord.business_id,
    jsonb_build_object(
      'aggregate_id', v_ord.id, 'warehouse_id', v_ord.warehouse_id, 'branch_id', v_branch,
      'actor_id', auth.uid(), 'occurred_at', now(), 'extra', v_summary
    )
  );

  RETURN v_summary || jsonb_build_object('return_id', v_ord.id, 'row_version', v_ord.row_version);
END $$;

REVOKE ALL ON FUNCTION public.wms_post_return_dispositions(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_post_return_dispositions(uuid,integer) TO authenticated, service_role;

-- 5) Close ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_close_return(
  p_return_id uuid,
  p_row_version integer,
  p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_ord public.wms_return_orders%ROWTYPE;
  v_open integer;
BEGIN
  SELECT * INTO v_ord FROM public.wms_return_orders WHERE id = p_return_id;
  IF v_ord.id IS NULL THEN RAISE EXCEPTION 'return order % not found', p_return_id USING ERRCODE = '22023'; END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_ord.business_id) THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO v_open
    FROM public.wms_return_lines l
   WHERE l.return_order_id = v_ord.id
     AND (l.disposition IS NULL OR l.posted_at IS NULL);
  IF v_open > 0 THEN
    RAISE EXCEPTION '% return line(s) are not dispositioned and posted', v_open USING ERRCODE = '22023';
  END IF;

  RETURN public.wms_transition_return(p_return_id, 'closed', p_row_version, p_reason, '{}'::jsonb);
END $$;

REVOKE ALL ON FUNCTION public.wms_close_return(uuid,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_close_return(uuid,integer,text) TO authenticated, service_role;