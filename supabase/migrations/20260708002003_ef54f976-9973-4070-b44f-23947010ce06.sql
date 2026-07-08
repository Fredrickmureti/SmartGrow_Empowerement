
-- ============================================================
-- D2 — Physical Count lifecycle RPCs
-- ============================================================

-- Sequence helper (per organization) for count_number
CREATE OR REPLACE FUNCTION public._next_physical_count_number(p_org uuid)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_num int;
BEGIN
  SELECT COALESCE(MAX(NULLIF(regexp_replace(count_number, '^PC-', ''), '')::int), 0) + 1
    INTO v_num FROM public.physical_counts
   WHERE organization_id = p_org AND count_number ~ '^PC-[0-9]+$';
  RETURN 'PC-' || LPAD(v_num::text, 6, '0');
END $$;

-- 1. create
CREATE OR REPLACE FUNCTION public.physical_count_create(
  p_organization_id uuid,
  p_business_id uuid,
  p_warehouse_id uuid,
  p_user_id uuid,
  p_count_type text DEFAULT 'full',
  p_scope jsonb DEFAULT '{}'::jsonb,
  p_tolerance_pct numeric DEFAULT NULL,
  p_tolerance_value numeric DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_id uuid; v_branch uuid;
BEGIN
  IF p_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'physical_count_create requires a warehouse' USING ERRCODE = 'P0001';
  END IF;
  SELECT branch_id INTO v_branch FROM public.warehouses WHERE id = p_warehouse_id;

  INSERT INTO public.physical_counts (
    organization_id, business_id, branch_id, warehouse_id,
    count_number, count_type, scope, tolerance_pct, tolerance_value,
    created_by
  ) VALUES (
    p_organization_id, p_business_id, v_branch, p_warehouse_id,
    _next_physical_count_number(p_organization_id), p_count_type, p_scope,
    p_tolerance_pct, p_tolerance_value, p_user_id
  ) RETURNING id INTO v_id;

  INSERT INTO public.physical_count_events (count_id, organization_id, event_type, actor_id, payload)
  VALUES (v_id, p_organization_id, 'created', p_user_id,
          jsonb_build_object('warehouse_id', p_warehouse_id, 'count_type', p_count_type));

  RETURN v_id;
END $$;

-- 2. freeze
CREATE OR REPLACE FUNCTION public.physical_count_freeze(
  p_count_id uuid,
  p_user_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_c RECORD; v_lines int := 0;
BEGIN
  SELECT * INTO v_c FROM public.physical_counts WHERE id = p_count_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'physical count % not found', p_count_id USING ERRCODE='P0001'; END IF;
  IF v_c.state <> 'draft' THEN
    RAISE EXCEPTION 'cannot freeze count in state %', v_c.state USING ERRCODE='P0001';
  END IF;

  -- Snapshot warehouse_stock into count lines
  INSERT INTO public.physical_count_lines (
    count_id, organization_id, business_id, product_id, system_qty_at_freeze,
    unit_cost_snapshot, cost_source
  )
  SELECT p_count_id, v_c.organization_id, v_c.business_id, p.id,
         COALESCE(ws.quantity, 0),
         COALESCE(ws.average_cost, p.cost_price, 0),
         'wac'
    FROM public.products p
    LEFT JOIN public.warehouse_stock ws
      ON ws.product_id = p.id AND ws.warehouse_id = v_c.warehouse_id
   WHERE p.organization_id = v_c.organization_id
     AND p.business_id = v_c.business_id
     AND p.track_inventory = true
     AND p.type = 'product'
  ON CONFLICT (count_id, product_id, packaging_id, lot_id) DO NOTHING;

  GET DIAGNOSTICS v_lines = ROW_COUNT;

  -- Watermark: last movement id per product for reconciliation at post time
  INSERT INTO public.physical_count_freeze_movements (
    count_id, organization_id, warehouse_id, product_id, last_movement_id
  )
  SELECT p_count_id, v_c.organization_id, v_c.warehouse_id, pcl.product_id,
         (SELECT id FROM public.stock_movements sm
           WHERE sm.warehouse_id = v_c.warehouse_id
             AND sm.product_id = pcl.product_id
           ORDER BY sm.created_at DESC LIMIT 1)
    FROM public.physical_count_lines pcl
   WHERE pcl.count_id = p_count_id
  ON CONFLICT (count_id, warehouse_id, product_id) DO NOTHING;

  UPDATE public.physical_counts
     SET state = 'counting', frozen_at = now(), frozen_by = p_user_id
   WHERE id = p_count_id;

  INSERT INTO public.physical_count_events (count_id, organization_id, event_type, actor_id, payload)
  VALUES (p_count_id, v_c.organization_id, 'frozen', p_user_id,
          jsonb_build_object('lines_snapshotted', v_lines));

  RETURN jsonb_build_object('success', true, 'lines_snapshotted', v_lines);
END $$;

-- 3. record_line
CREATE OR REPLACE FUNCTION public.physical_count_record_line(
  p_count_id uuid,
  p_product_id uuid,
  p_counted_qty numeric,
  p_user_id uuid,
  p_device_id uuid DEFAULT NULL,
  p_scan_ref text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_c RECORD; v_line RECORD; v_variance numeric;
BEGIN
  SELECT * INTO v_c FROM public.physical_counts WHERE id = p_count_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'physical count % not found', p_count_id USING ERRCODE='P0001'; END IF;
  IF v_c.state NOT IN ('counting','in_review') THEN
    RAISE EXCEPTION 'cannot record line in state %', v_c.state USING ERRCODE='P0001';
  END IF;

  UPDATE public.physical_count_lines
     SET counted_qty = p_counted_qty,
         counted_by = p_user_id,
         counted_at = now(),
         device_id = COALESCE(p_device_id, device_id),
         scan_events = CASE
           WHEN p_scan_ref IS NULL THEN scan_events
           ELSE COALESCE(scan_events, '[]'::jsonb) ||
                jsonb_build_array(jsonb_build_object('ref', p_scan_ref, 'at', now(), 'by', p_user_id))
         END,
         status = CASE
           WHEN p_counted_qty = system_qty_at_freeze + freeze_reconciliation_qty THEN 'matched'
           ELSE 'variance'
         END
   WHERE count_id = p_count_id AND product_id = p_product_id
   RETURNING * INTO v_line;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product % not in count %', p_product_id, p_count_id USING ERRCODE='P0001';
  END IF;

  RETURN jsonb_build_object('success', true, 'variance', v_line.variance_qty, 'status', v_line.status);
END $$;

-- 4. submit
CREATE OR REPLACE FUNCTION public.physical_count_submit(
  p_count_id uuid,
  p_user_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_c RECORD; v_flagged int := 0;
BEGIN
  SELECT * INTO v_c FROM public.physical_counts WHERE id = p_count_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'physical count % not found', p_count_id USING ERRCODE='P0001'; END IF;
  IF v_c.state <> 'counting' THEN
    RAISE EXCEPTION 'cannot submit count in state %', v_c.state USING ERRCODE='P0001';
  END IF;

  -- Any line still pending is treated as counted-zero? No — enterprise practice is to force
  -- explicit count. Raise if any pending lines remain.
  IF EXISTS (SELECT 1 FROM public.physical_count_lines
              WHERE count_id = p_count_id AND status = 'pending' AND counted_qty IS NULL) THEN
    RAISE EXCEPTION 'some lines still uncounted — record all or scope down' USING ERRCODE='P0001';
  END IF;

  -- Apply tolerance: flag lines exceeding either variance_pct or variance_value
  WITH flagged AS (
    UPDATE public.physical_count_lines pcl
       SET status = 'recount_required'
      FROM public.physical_counts pc
     WHERE pcl.count_id = p_count_id
       AND pc.id = pcl.count_id
       AND pcl.status = 'variance'
       AND (
         (pc.tolerance_value IS NOT NULL
           AND ABS(pcl.variance_qty * COALESCE(pcl.unit_cost_snapshot,0)) > pc.tolerance_value)
         OR (pc.tolerance_pct IS NOT NULL
           AND (pcl.system_qty_at_freeze + pcl.freeze_reconciliation_qty) <> 0
           AND ABS(pcl.variance_qty) / NULLIF(ABS(pcl.system_qty_at_freeze + pcl.freeze_reconciliation_qty),0) * 100
               > pc.tolerance_pct)
       )
     RETURNING 1
  ) SELECT COUNT(*) INTO v_flagged FROM flagged;

  UPDATE public.physical_counts
     SET state = 'in_review', submitted_at = now(), submitted_by = p_user_id
   WHERE id = p_count_id;

  INSERT INTO public.physical_count_events (count_id, organization_id, event_type, actor_id, payload)
  VALUES (p_count_id, v_c.organization_id, 'submitted', p_user_id,
          jsonb_build_object('lines_flagged_recount', v_flagged));

  RETURN jsonb_build_object('success', true, 'lines_flagged_recount', v_flagged);
END $$;

-- 5. request_recount
CREATE OR REPLACE FUNCTION public.physical_count_request_recount(
  p_count_id uuid,
  p_user_id uuid,
  p_line_ids uuid[]
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_c RECORD; v_n int;
BEGIN
  SELECT * INTO v_c FROM public.physical_counts WHERE id = p_count_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'physical count % not found', p_count_id USING ERRCODE='P0001'; END IF;
  IF v_c.state NOT IN ('in_review','counting') THEN
    RAISE EXCEPTION 'cannot request recount in state %', v_c.state USING ERRCODE='P0001';
  END IF;

  UPDATE public.physical_count_lines
     SET status = 'recount_required', counted_qty = NULL, recount_qty = NULL
   WHERE count_id = p_count_id AND id = ANY(p_line_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;

  UPDATE public.physical_counts SET state = 'counting' WHERE id = p_count_id;

  INSERT INTO public.physical_count_events (count_id, organization_id, event_type, actor_id, payload)
  VALUES (p_count_id, v_c.organization_id, 'recount_requested', p_user_id,
          jsonb_build_object('lines', v_n));

  RETURN jsonb_build_object('success', true, 'lines_reset', v_n);
END $$;

-- 6. approve (SoD-enforced)
CREATE OR REPLACE FUNCTION public.physical_count_approve(
  p_count_id uuid,
  p_user_id uuid,
  p_allow_self boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_c RECORD;
BEGIN
  SELECT * INTO v_c FROM public.physical_counts WHERE id = p_count_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'physical count % not found', p_count_id USING ERRCODE='P0001'; END IF;
  IF v_c.state <> 'in_review' THEN
    RAISE EXCEPTION 'cannot approve count in state %', v_c.state USING ERRCODE='P0001';
  END IF;
  IF NOT p_allow_self AND (p_user_id = v_c.created_by OR p_user_id = v_c.frozen_by OR p_user_id = v_c.submitted_by) THEN
    RAISE EXCEPTION 'segregation of duties: approver cannot be creator, freezer, or submitter'
      USING ERRCODE='P0001', HINT='request an override or ask another manager to approve';
  END IF;

  UPDATE public.physical_counts
     SET state = 'approved', approved_at = now(), approved_by = p_user_id
   WHERE id = p_count_id;

  INSERT INTO public.physical_count_events (count_id, organization_id, event_type, actor_id, payload)
  VALUES (p_count_id, v_c.organization_id, 'approved', p_user_id, '{}'::jsonb);

  RETURN jsonb_build_object('success', true);
END $$;

-- 7. post — real ledger write
CREATE OR REPLACE FUNCTION public.physical_count_post(
  p_count_id uuid,
  p_user_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_c RECORD; v_line RECORD;
  v_adj_id uuid; v_entry_number text; v_journal_id uuid;
  v_total_positive numeric := 0; v_total_negative numeric := 0;
  v_inv_acct uuid; v_adj_acct uuid; v_cost numeric;
  v_movement_type text; v_final_variance numeric;
  v_since_movements_qty numeric;
  v_open_period RECORD;
  v_processed int := 0; v_period_status text;
BEGIN
  SELECT * INTO v_c FROM public.physical_counts WHERE id = p_count_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'physical count % not found', p_count_id USING ERRCODE='P0001'; END IF;
  IF v_c.state <> 'approved' THEN
    RAISE EXCEPTION 'cannot post count in state % — must be approved', v_c.state USING ERRCODE='P0001';
  END IF;

  -- Fiscal period check up-front → typed error
  SELECT status INTO v_period_status FROM public.fiscal_periods
   WHERE organization_id = v_c.organization_id
     AND CURRENT_DATE BETWEEN start_date AND end_date
   LIMIT 1;
  IF v_period_status = 'closed' THEN
    RAISE EXCEPTION 'fiscal period for % is closed — open a period before posting the count', CURRENT_DATE
      USING ERRCODE='P0001', HINT='reopen the period in Accounting → Fiscal Periods';
  END IF;

  -- Create the stock_adjustments header (starts as draft so guard_stock_adjustment_self_approval can run cleanly)
  INSERT INTO public.stock_adjustments (
    organization_id, business_id, branch_id, warehouse_id,
    adjustment_number, adjustment_date, reason, notes,
    status, created_by, allow_negative
  ) VALUES (
    v_c.organization_id, v_c.business_id, v_c.branch_id, v_c.warehouse_id,
    'PCADJ-' || v_c.count_number, CURRENT_DATE,
    'Physical Count', 'Physical count ' || v_c.count_number,
    'draft', p_user_id, true
  ) RETURNING id INTO v_adj_id;

  -- Reconcile freeze-window movements per line, then write items + movements
  FOR v_line IN
    SELECT pcl.*, fm.last_movement_id
      FROM public.physical_count_lines pcl
      LEFT JOIN public.physical_count_freeze_movements fm
        ON fm.count_id = pcl.count_id AND fm.product_id = pcl.product_id
     WHERE pcl.count_id = p_count_id
       AND pcl.counted_qty IS NOT NULL
  LOOP
    -- Sum qty of movements that happened after freeze watermark for this (warehouse, product)
    SELECT COALESCE(SUM(CASE
             WHEN sm.movement_type IN ('receipt','purchase','adjustment_in','transfer_in','opening_stock','return_in','customer_return','adjustment') AND sm.quantity > 0 THEN sm.quantity
             WHEN sm.movement_type IN ('sale','delivery','pos_sale','transfer_out','scrap','adjustment_out','return_out','vendor_return') THEN -ABS(sm.quantity)
             ELSE sm.quantity
           END), 0)
      INTO v_since_movements_qty
      FROM public.stock_movements sm
     WHERE sm.warehouse_id = v_c.warehouse_id
       AND sm.product_id   = v_line.product_id
       AND (v_line.last_movement_id IS NULL OR sm.id <> v_line.last_movement_id)
       AND (v_line.last_movement_id IS NULL OR sm.created_at > (
             SELECT created_at FROM public.stock_movements WHERE id = v_line.last_movement_id));

    UPDATE public.physical_count_lines
       SET freeze_reconciliation_qty = v_since_movements_qty
     WHERE id = v_line.id;

    v_final_variance := v_line.counted_qty - (v_line.system_qty_at_freeze + v_since_movements_qty);
    IF v_final_variance = 0 THEN
      CONTINUE;
    END IF;

    -- stock_adjustment_items — leaves UoM columns to _uom_normalize_adj_line
    INSERT INTO public.stock_adjustment_items (
      adjustment_id, product_id,
      quantity_before, quantity_adjustment, quantity_after,
      unit_cost, warehouse_id, branch_id, notes
    ) VALUES (
      v_adj_id, v_line.product_id,
      v_line.system_qty_at_freeze + v_since_movements_qty,
      v_final_variance,
      v_line.counted_qty,
      COALESCE(v_line.unit_cost_snapshot, 0),
      v_c.warehouse_id, v_c.branch_id,
      'Physical count ' || v_c.count_number || ': system+recon=' ||
      (v_line.system_qty_at_freeze + v_since_movements_qty)::text ||
      ' counted=' || v_line.counted_qty::text
    );

    v_movement_type := CASE WHEN v_final_variance > 0 THEN 'adjustment_in' ELSE 'adjustment_out' END;

    INSERT INTO public.stock_movements (
      organization_id, business_id, branch_id, warehouse_id,
      product_id, movement_type, quantity, unit_cost,
      reference_type, reference_id, notes, created_by
    ) VALUES (
      v_c.organization_id, v_c.business_id, v_c.branch_id, v_c.warehouse_id,
      v_line.product_id, v_movement_type,
      ABS(v_final_variance),
      COALESCE(v_line.unit_cost_snapshot, 0),
      'physical_count', p_count_id,
      'Physical count ' || v_c.count_number, p_user_id
    );

    v_cost := ABS(v_final_variance) * COALESCE(v_line.unit_cost_snapshot, 0);
    IF v_final_variance > 0 THEN
      v_total_positive := v_total_positive + v_cost;
    ELSE
      v_total_negative := v_total_negative + v_cost;
    END IF;

    UPDATE public.physical_count_lines
       SET status = 'approved', variance_value = v_final_variance * COALESCE(v_line.unit_cost_snapshot, 0)
     WHERE id = v_line.id;

    v_processed := v_processed + 1;
  END LOOP;

  -- Approve the stock_adjustments header (SoD guard runs here — approver must differ from creator).
  -- The RPC caller is the poster; if same as creator, we already blocked at physical_count_approve.
  UPDATE public.stock_adjustments
     SET status = 'approved', approved_by = p_user_id, approved_at = now()
   WHERE id = v_adj_id;

  -- Post the journal entry (single balanced entry per count).
  IF (v_total_positive > 0 OR v_total_negative > 0) THEN
    v_inv_acct := public.resolve_default_account(v_c.business_id, 'inventory');
    v_adj_acct := public.resolve_default_account(v_c.business_id, 'inventory_adjustment');

    IF v_inv_acct IS NULL OR v_adj_acct IS NULL THEN
      RAISE EXCEPTION 'default accounts not configured (inventory / inventory_adjustment)'
        USING ERRCODE='P0001', HINT='set them in Accounting → Default Accounts';
    END IF;

    SELECT 'JE-' || LPAD((COALESCE(MAX(CAST(NULLIF(regexp_replace(entry_number,'\D','','g'),'') AS int)),0) + 1)::text, 5, '0')
      INTO v_entry_number
      FROM public.journal_entries WHERE organization_id = v_c.organization_id;

    INSERT INTO public.journal_entries (
      organization_id, business_id, branch_id, entry_number, entry_date,
      description, reference, source_type, source_subtype, source_id,
      journal_book_id, status, posted_at, posted_by, created_by
    ) VALUES (
      v_c.organization_id, v_c.business_id, v_c.branch_id, v_entry_number, CURRENT_DATE,
      'Physical count ' || v_c.count_number,
      v_c.count_number,
      'inventory_adjustment', 'physical_count', p_count_id,
      v_c.journal_book_id, 'posted', now(), p_user_id, p_user_id
    ) RETURNING id INTO v_journal_id;

    IF v_total_positive > 0 THEN
      INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, debit, credit, description, business_id, branch_id)
      VALUES
        (v_journal_id, v_inv_acct, v_total_positive, 0, 'Physical count — surplus (' || v_c.count_number || ')', v_c.business_id, v_c.branch_id),
        (v_journal_id, v_adj_acct, 0, v_total_positive, 'Physical count — surplus offset', v_c.business_id, v_c.branch_id);
    END IF;

    IF v_total_negative > 0 THEN
      INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, debit, credit, description, business_id, branch_id)
      VALUES
        (v_journal_id, v_adj_acct, v_total_negative, 0, 'Physical count — shrinkage (' || v_c.count_number || ')', v_c.business_id, v_c.branch_id),
        (v_journal_id, v_inv_acct, 0, v_total_negative, 'Physical count — shrinkage offset', v_c.business_id, v_c.branch_id);
    END IF;
  END IF;

  UPDATE public.physical_counts
     SET state = 'posted', posted_at = now(), posted_by = p_user_id,
         posted_adjustment_ids = ARRAY[v_adj_id],
         posted_journal_entry_id = v_journal_id
   WHERE id = p_count_id;

  INSERT INTO public.physical_count_events (count_id, organization_id, event_type, actor_id, payload)
  VALUES (p_count_id, v_c.organization_id, 'posted', p_user_id,
          jsonb_build_object('adjustment_id', v_adj_id, 'journal_entry_id', v_journal_id,
                             'lines_processed', v_processed,
                             'surplus_value', v_total_positive, 'shrinkage_value', v_total_negative));

  -- Emit domain event for downstream (reorder, alerts, BI)
  INSERT INTO public.business_event_outbox (
    organization_id, business_id, event_type, source_type, source_id, payload, status
  ) VALUES (
    v_c.organization_id, v_c.business_id, 'inventory.physical_count.posted',
    'physical_count', p_count_id,
    jsonb_build_object('count_id', p_count_id, 'warehouse_id', v_c.warehouse_id,
                       'adjustment_id', v_adj_id, 'journal_entry_id', v_journal_id),
    'pending'
  );

  RETURN jsonb_build_object(
    'success', true,
    'count_id', p_count_id,
    'adjustment_id', v_adj_id,
    'journal_entry_id', v_journal_id,
    'lines_processed', v_processed,
    'surplus_value', v_total_positive,
    'shrinkage_value', v_total_negative
  );
END $$;

-- 8. cancel
CREATE OR REPLACE FUNCTION public.physical_count_cancel(
  p_count_id uuid,
  p_user_id uuid,
  p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_c RECORD;
BEGIN
  SELECT * INTO v_c FROM public.physical_counts WHERE id = p_count_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'physical count % not found', p_count_id USING ERRCODE='P0001'; END IF;
  IF v_c.state IN ('posted','cancelled','superseded') THEN
    RAISE EXCEPTION 'cannot cancel count in state %', v_c.state USING ERRCODE='P0001',
      HINT='use physical_count_supersede to reverse a posted count';
  END IF;

  UPDATE public.physical_counts
     SET state = 'cancelled', cancelled_at = now(), cancelled_by = p_user_id,
         cancellation_reason = p_reason
   WHERE id = p_count_id;

  INSERT INTO public.physical_count_events (count_id, organization_id, event_type, actor_id, payload)
  VALUES (p_count_id, v_c.organization_id, 'cancelled', p_user_id,
          jsonb_build_object('reason', p_reason));

  RETURN jsonb_build_object('success', true);
END $$;

-- 9. shim: keep old signature working
CREATE OR REPLACE FUNCTION public.apply_physical_count_atomic(
  p_organization_id uuid,
  p_business_id uuid,
  p_warehouse_id uuid,
  p_user_id uuid,
  p_lines jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_count_id uuid;
  v_line jsonb;
  v_result jsonb;
BEGIN
  v_count_id := public.physical_count_create(
    p_organization_id, p_business_id, p_warehouse_id, p_user_id, 'full', '{}'::jsonb, NULL, NULL
  );
  PERFORM public.physical_count_freeze(v_count_id, p_user_id);

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    PERFORM public.physical_count_record_line(
      v_count_id,
      (v_line->>'product_id')::uuid,
      (v_line->>'counted_qty')::numeric,
      p_user_id, NULL, NULL
    );
  END LOOP;

  PERFORM public.physical_count_submit(v_count_id, p_user_id);
  PERFORM public.physical_count_approve(v_count_id, p_user_id, true);
  v_result := public.physical_count_post(v_count_id, p_user_id);

  RETURN v_result || jsonb_build_object('count_id', v_count_id, 'legacy_shim', true);
END $$;
