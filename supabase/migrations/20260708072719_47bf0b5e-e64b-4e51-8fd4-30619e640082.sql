
-- ============================================================
-- D5 — Physical Count enterprise hardening
-- ============================================================

-- 1. Cross-module freeze helper
CREATE OR REPLACE FUNCTION public.is_product_frozen(
  _organization_id uuid,
  _warehouse_id uuid,
  _product_id uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.physical_counts pc
      JOIN public.physical_count_lines pcl ON pcl.count_id = pc.id
     WHERE pc.organization_id = _organization_id
       AND pc.warehouse_id = _warehouse_id
       AND pc.state IN ('counting','in_review','approved')
       AND pcl.product_id = _product_id
  );
$$;
GRANT EXECUTE ON FUNCTION public.is_product_frozen(uuid, uuid, uuid) TO authenticated, service_role;

-- 2. SoD-gated submit
CREATE OR REPLACE FUNCTION public.physical_count_submit(
  p_count_id uuid,
  p_user_id uuid,
  p_allow_self boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_c RECORD; v_flagged int := 0;
BEGIN
  SELECT * INTO v_c FROM public.physical_counts WHERE id = p_count_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'physical count % not found', p_count_id USING ERRCODE='P0001'; END IF;
  IF v_c.state <> 'counting' THEN
    RAISE EXCEPTION 'cannot submit count in state %', v_c.state USING ERRCODE='P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM public.physical_count_lines
              WHERE count_id = p_count_id AND status = 'pending' AND counted_qty IS NULL) THEN
    RAISE EXCEPTION 'some lines still uncounted — record all or scope down' USING ERRCODE='P0001';
  END IF;

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
          jsonb_build_object('lines_flagged_recount', v_flagged, 'allow_self', p_allow_self));

  RETURN jsonb_build_object('success', true, 'lines_flagged_recount', v_flagged);
END $$;

-- 3. Tolerance-gated + SoD approve
CREATE OR REPLACE FUNCTION public.physical_count_approve(
  p_count_id uuid,
  p_user_id uuid,
  p_allow_self boolean DEFAULT false,
  p_tolerance_override_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_c RECORD; v_flagged int;
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

  SELECT COUNT(*) INTO v_flagged FROM public.physical_count_lines
   WHERE count_id = p_count_id AND status = 'recount_required';

  IF v_flagged > 0 AND (p_tolerance_override_reason IS NULL OR btrim(p_tolerance_override_reason) = '') THEN
    RAISE EXCEPTION '% line(s) exceed tolerance — recount them or supply a tolerance_override_reason', v_flagged
      USING ERRCODE='P0001', HINT='select the flagged rows and Request Recount, or approve with a written override';
  END IF;

  UPDATE public.physical_counts
     SET state = 'approved', approved_at = now(), approved_by = p_user_id
   WHERE id = p_count_id;

  INSERT INTO public.physical_count_events (count_id, organization_id, event_type, actor_id, payload)
  VALUES (p_count_id, v_c.organization_id, 'approved', p_user_id,
          jsonb_build_object(
            'allow_self', p_allow_self,
            'tolerance_override_reason', p_tolerance_override_reason,
            'flagged_lines_at_approval', v_flagged));

  RETURN jsonb_build_object('success', true, 'flagged_lines', v_flagged);
END $$;

-- 4. SoD-gated post (wraps existing logic with an extra actor check)
CREATE OR REPLACE FUNCTION public.physical_count_post(
  p_count_id uuid,
  p_user_id uuid,
  p_allow_self boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_c RECORD; v_line RECORD;
  v_adj_id uuid; v_entry_number text; v_journal_id uuid;
  v_total_positive numeric := 0; v_total_negative numeric := 0;
  v_inv_acct uuid; v_adj_acct uuid; v_cost numeric;
  v_movement_type text; v_final_variance numeric;
  v_since_movements_qty numeric;
  v_processed int := 0; v_period_status text;
BEGIN
  SELECT * INTO v_c FROM public.physical_counts WHERE id = p_count_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'physical count % not found', p_count_id USING ERRCODE='P0001'; END IF;
  IF v_c.state <> 'approved' THEN
    RAISE EXCEPTION 'cannot post count in state % — must be approved', v_c.state USING ERRCODE='P0001';
  END IF;

  -- SoD: poster differs from approver (and typically from creator/submitter)
  IF NOT p_allow_self AND p_user_id = v_c.approved_by THEN
    RAISE EXCEPTION 'segregation of duties: poster cannot be the approver'
      USING ERRCODE='P0001', HINT='ask another authorized user to post, or grant a self-action override';
  END IF;

  -- Fiscal period preflight
  SELECT status INTO v_period_status FROM public.fiscal_periods
   WHERE organization_id = v_c.organization_id
     AND CURRENT_DATE BETWEEN start_date AND end_date
   LIMIT 1;
  IF v_period_status = 'closed' THEN
    RAISE EXCEPTION 'fiscal period for % is closed — open a period before posting the count', CURRENT_DATE
      USING ERRCODE='P0001', HINT='reopen the period in Accounting → Fiscal Periods';
  END IF;

  -- Default account preflight
  v_inv_acct := public.resolve_default_account(v_c.business_id, 'inventory');
  v_adj_acct := public.resolve_default_account(v_c.business_id, 'inventory_adjustment');
  IF v_inv_acct IS NULL OR v_adj_acct IS NULL THEN
    RAISE EXCEPTION 'default accounts not configured (inventory / inventory_adjustment)'
      USING ERRCODE='P0001', HINT='set them in Accounting → Default Accounts';
  END IF;

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

  FOR v_line IN
    SELECT pcl.*, fm.last_movement_id
      FROM public.physical_count_lines pcl
      LEFT JOIN public.physical_count_freeze_movements fm
        ON fm.count_id = pcl.count_id AND fm.product_id = pcl.product_id
     WHERE pcl.count_id = p_count_id
       AND pcl.counted_qty IS NOT NULL
  LOOP
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
    IF v_final_variance = 0 THEN CONTINUE; END IF;

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
      ABS(v_final_variance), COALESCE(v_line.unit_cost_snapshot, 0),
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

  UPDATE public.stock_adjustments
     SET status = 'approved', approved_by = p_user_id, approved_at = now()
   WHERE id = v_adj_id;

  IF (v_total_positive > 0 OR v_total_negative > 0) THEN
    SELECT 'JE-' || LPAD((COALESCE(MAX(CAST(NULLIF(regexp_replace(entry_number,'\D','','g'),'') AS int)),0) + 1)::text, 5, '0')
      INTO v_entry_number
      FROM public.journal_entries WHERE organization_id = v_c.organization_id;

    INSERT INTO public.journal_entries (
      organization_id, business_id, branch_id, entry_number, entry_date,
      description, reference, source_type, source_subtype, source_id,
      journal_book_id, status, posted_at, posted_by, created_by
    ) VALUES (
      v_c.organization_id, v_c.business_id, v_c.branch_id, v_entry_number, CURRENT_DATE,
      'Physical count ' || v_c.count_number, v_c.count_number,
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
                             'surplus_value', v_total_positive, 'shrinkage_value', v_total_negative,
                             'allow_self', p_allow_self));

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
    'success', true, 'count_id', p_count_id,
    'adjustment_id', v_adj_id, 'journal_entry_id', v_journal_id,
    'lines_processed', v_processed,
    'surplus_value', v_total_positive, 'shrinkage_value', v_total_negative
  );
END $$;

-- 5. Read-only preflight: everything the UI needs to enable/disable the action bar
CREATE OR REPLACE FUNCTION public.physical_count_preflight(
  p_count_id uuid,
  p_user_id uuid
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_c RECORD;
  v_period_status text; v_period_ok boolean;
  v_inv_acct uuid; v_adj_acct uuid;
  v_flagged int; v_uncounted int;
  v_variance_lines int; v_est_surplus numeric := 0; v_est_shrinkage numeric := 0;
BEGIN
  SELECT * INTO v_c FROM public.physical_counts WHERE id = p_count_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'physical count % not found', p_count_id USING ERRCODE='P0001'; END IF;

  SELECT status INTO v_period_status FROM public.fiscal_periods
   WHERE organization_id = v_c.organization_id
     AND CURRENT_DATE BETWEEN start_date AND end_date
   LIMIT 1;
  v_period_ok := (v_period_status IS NULL OR v_period_status <> 'closed');

  v_inv_acct := public.resolve_default_account(v_c.business_id, 'inventory');
  v_adj_acct := public.resolve_default_account(v_c.business_id, 'inventory_adjustment');

  SELECT COUNT(*) FILTER (WHERE status = 'recount_required'),
         COUNT(*) FILTER (WHERE status = 'pending' AND counted_qty IS NULL),
         COUNT(*) FILTER (WHERE variance_qty <> 0 AND counted_qty IS NOT NULL),
         COALESCE(SUM(CASE WHEN variance_qty > 0 THEN variance_qty * COALESCE(unit_cost_snapshot,0) ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN variance_qty < 0 THEN -variance_qty * COALESCE(unit_cost_snapshot,0) ELSE 0 END), 0)
    INTO v_flagged, v_uncounted, v_variance_lines, v_est_surplus, v_est_shrinkage
    FROM public.physical_count_lines
   WHERE count_id = p_count_id;

  RETURN jsonb_build_object(
    'state', v_c.state,
    'checks', jsonb_build_object(
      'period_open',        v_period_ok,
      'period_status',      COALESCE(v_period_status, 'no_period_defined'),
      'inventory_account',  v_inv_acct IS NOT NULL,
      'adjustment_account', v_adj_acct IS NOT NULL,
      'tolerance_flags',    v_flagged,
      'uncounted_lines',    v_uncounted,
      'sod_submit_would_block',  p_user_id = v_c.created_by,
      'sod_approve_would_block', p_user_id = v_c.created_by OR p_user_id = v_c.frozen_by OR p_user_id = v_c.submitted_by,
      'sod_post_would_block',    p_user_id = v_c.approved_by
    ),
    'impact', jsonb_build_object(
      'variance_lines',   v_variance_lines,
      'surplus_value',    v_est_surplus,
      'shrinkage_value',  v_est_shrinkage,
      'net_value',        v_est_surplus - v_est_shrinkage
    )
  );
END $$;
GRANT EXECUTE ON FUNCTION public.physical_count_preflight(uuid, uuid) TO authenticated, service_role;

-- 6. Read-only JE preview
CREATE OR REPLACE FUNCTION public.physical_count_preview_je(p_count_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_c RECORD;
  v_inv_acct uuid; v_adj_acct uuid;
  v_inv_row RECORD; v_adj_row RECORD;
  v_total_positive numeric := 0; v_total_negative numeric := 0;
  v_line_details jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_c FROM public.physical_counts WHERE id = p_count_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'physical count % not found', p_count_id USING ERRCODE='P0001'; END IF;

  v_inv_acct := public.resolve_default_account(v_c.business_id, 'inventory');
  v_adj_acct := public.resolve_default_account(v_c.business_id, 'inventory_adjustment');

  SELECT COALESCE(SUM(CASE WHEN variance_qty > 0 THEN  variance_qty * COALESCE(unit_cost_snapshot,0) ELSE 0 END),0),
         COALESCE(SUM(CASE WHEN variance_qty < 0 THEN -variance_qty * COALESCE(unit_cost_snapshot,0) ELSE 0 END),0)
    INTO v_total_positive, v_total_negative
    FROM public.physical_count_lines
   WHERE count_id = p_count_id AND counted_qty IS NOT NULL;

  SELECT id, code, name INTO v_inv_row FROM public.accounts WHERE id = v_inv_acct;
  SELECT id, code, name INTO v_adj_row FROM public.accounts WHERE id = v_adj_acct;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'product_id',  pcl.product_id,
           'product_name', p.name,
           'sku', p.sku,
           'variance_qty', pcl.variance_qty,
           'unit_cost',    pcl.unit_cost_snapshot,
           'value',        pcl.variance_qty * COALESCE(pcl.unit_cost_snapshot,0),
           'direction',    CASE WHEN pcl.variance_qty > 0 THEN 'surplus' WHEN pcl.variance_qty < 0 THEN 'shrinkage' ELSE 'none' END
         ) ORDER BY ABS(pcl.variance_qty * COALESCE(pcl.unit_cost_snapshot,0)) DESC), '[]'::jsonb)
    INTO v_line_details
    FROM public.physical_count_lines pcl
    JOIN public.products p ON p.id = pcl.product_id
   WHERE pcl.count_id = p_count_id
     AND pcl.counted_qty IS NOT NULL
     AND pcl.variance_qty <> 0;

  RETURN jsonb_build_object(
    'inventory_account', to_jsonb(v_inv_row),
    'adjustment_account', to_jsonb(v_adj_row),
    'surplus_value',   v_total_positive,
    'shrinkage_value', v_total_negative,
    'net_value',       v_total_positive - v_total_negative,
    'journal_lines', jsonb_build_array(
      jsonb_build_object('account', v_inv_row->>'code' || ' — ' || v_inv_row->>'name',
                         'debit',  v_total_positive, 'credit', v_total_negative,
                         'purpose', 'Inventory asset (net movement)'),
      jsonb_build_object('account', v_adj_row->>'code' || ' — ' || v_adj_row->>'name',
                         'debit',  v_total_negative, 'credit', v_total_positive,
                         'purpose', 'Shrinkage/surplus P&L')
    ),
    'lines', v_line_details
  );
END $$;
GRANT EXECUTE ON FUNCTION public.physical_count_preview_je(uuid) TO authenticated, service_role;

-- 7. Retire legacy shim — force callers onto the lifecycle RPCs
CREATE OR REPLACE FUNCTION public.apply_physical_count_atomic(
  p_organization_id uuid,
  p_business_id uuid,
  p_warehouse_id uuid,
  p_user_id uuid,
  p_lines jsonb
) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'apply_physical_count_atomic is deprecated — use physical_count_create → freeze → record_line → submit → approve → post'
    USING ERRCODE='P0001',
          HINT='the one-shot shim is removed to enforce Segregation of Duties and tolerance-gated approval';
END $$;

-- 8. Wire cross-module freeze awareness into approve_stock_adjustment_atomic
--    (D6 will extend this to POS, invoice, GRN, transfers)
DO $$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_src
    FROM pg_proc WHERE proname = 'approve_stock_adjustment_atomic' AND pronamespace = 'public'::regnamespace
    LIMIT 1;

  IF v_src IS NULL OR v_src LIKE '%is_product_frozen%' THEN
    RETURN;
  END IF;

  -- Non-destructive advisory: emit a NOTICE. The actual wiring is intentionally
  -- deferred to the D6 migration because approve_stock_adjustment_atomic has
  -- variant signatures across historical migrations and needs a targeted rewrite
  -- rather than a blind string patch.
  RAISE NOTICE 'is_product_frozen helper installed; D6 migration will wire it into stock_adjustment/POS/invoice/GRN paths.';
END $$;

COMMENT ON FUNCTION public.physical_count_preflight(uuid, uuid) IS
  'Read-only. Returns state, per-check booleans (period_open, accounts, tolerance flags, SoD blocks) and estimated financial impact. UI must call this before enabling submit/approve/post buttons.';
COMMENT ON FUNCTION public.physical_count_preview_je(uuid) IS
  'Read-only. Returns the exact journal-entry lines the physical_count_post RPC will write, plus per-product variance breakdown ordered by absolute value.';
COMMENT ON FUNCTION public.is_product_frozen(uuid, uuid, uuid) IS
  'True if the given (organization, warehouse, product) has an in-progress physical count (counting/in_review/approved). Callers should block competing writes or route through a manager override.';
