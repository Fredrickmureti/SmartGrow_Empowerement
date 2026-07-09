CREATE OR REPLACE FUNCTION public._resolve_canonical_default_account(
  p_setting_key text,
  p_org_id uuid,
  p_business_id uuid,
  p_branch_id uuid DEFAULT NULL,
  p_as_of timestamptz DEFAULT now()
) RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_account_id uuid;
BEGIN
  v_account_id := public.resolve_default_account_binding(
    p_setting_key,
    p_org_id,
    p_business_id,
    p_branch_id,
    p_as_of
  );

  IF v_account_id IS NOT NULL THEN
    RETURN v_account_id;
  END IF;

  SELECT d.account_id
    INTO v_account_id
    FROM public.default_account_settings d
   WHERE d.organization_id = p_org_id
     AND d.business_id = p_business_id
     AND d.setting_key = p_setting_key
     AND (d.branch_id IS NOT DISTINCT FROM p_branch_id OR d.branch_id IS NULL)
   ORDER BY CASE WHEN d.branch_id IS NOT DISTINCT FROM p_branch_id THEN 0 ELSE 1 END,
            d.updated_at DESC NULLS LAST,
            d.created_at DESC NULLS LAST
   LIMIT 1;

  RETURN v_account_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public._resolve_canonical_default_account(text, uuid, uuid, uuid, timestamptz)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.physical_count_preflight(
  p_count_id uuid,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_c RECORD;
  v_period_status text;
  v_period_ok boolean;
  v_period_defined boolean;
  v_inv_acct uuid;
  v_adj_acct uuid;
  v_journal_book_id uuid;
  v_journal_book_ok boolean;
  v_warehouse_active boolean;
  v_warehouse_ok boolean;
  v_flagged int;
  v_uncounted int;
  v_variance_lines int;
  v_est_surplus numeric := 0;
  v_est_shrinkage numeric := 0;
BEGIN
  SELECT * INTO v_c FROM public.physical_counts WHERE id = p_count_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'physical count % not found', p_count_id USING ERRCODE='P0001';
  END IF;

  SELECT status INTO v_period_status
    FROM public.fiscal_periods
   WHERE organization_id = v_c.organization_id
     AND business_id = v_c.business_id
     AND CURRENT_DATE BETWEEN start_date AND end_date
   ORDER BY start_date DESC
   LIMIT 1;
  v_period_defined := FOUND;
  v_period_ok := v_period_defined AND (v_period_status IS NULL OR v_period_status <> 'closed');

  v_inv_acct := public._resolve_canonical_default_account(
    'inventory', v_c.organization_id, v_c.business_id, v_c.branch_id, now()
  );
  v_adj_acct := public._resolve_canonical_default_account(
    'inventory_adjustment', v_c.organization_id, v_c.business_id, v_c.branch_id, now()
  );

  v_journal_book_id := v_c.journal_book_id;
  IF v_journal_book_id IS NOT NULL THEN
    SELECT jb.id INTO v_journal_book_id
      FROM public.journal_books jb
     WHERE jb.id = v_journal_book_id
       AND jb.organization_id = v_c.organization_id
       AND jb.business_id = v_c.business_id
       AND jb.is_active = true;
  END IF;

  IF v_journal_book_id IS NULL THEN
    SELECT id INTO v_journal_book_id
      FROM public.journal_books
     WHERE organization_id = v_c.organization_id
       AND business_id = v_c.business_id
       AND is_active = true
       AND journal_type = 'general'
     ORDER BY is_system DESC, created_at ASC
     LIMIT 1;
  END IF;

  IF v_journal_book_id IS NULL THEN
    SELECT id INTO v_journal_book_id
      FROM public.journal_books
     WHERE organization_id = v_c.organization_id
       AND business_id = v_c.business_id
       AND is_active = true
     ORDER BY is_system DESC, created_at ASC
     LIMIT 1;
  END IF;
  v_journal_book_ok := v_journal_book_id IS NOT NULL;

  SELECT is_active INTO v_warehouse_active
    FROM public.warehouses
   WHERE id = v_c.warehouse_id
     AND organization_id = v_c.organization_id
     AND business_id = v_c.business_id;
  v_warehouse_ok := COALESCE(v_warehouse_active, false);

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
      'period_defined',     v_period_defined,
      'period_status',      COALESCE(v_period_status, 'no_period_defined'),
      'inventory_account',  v_inv_acct IS NOT NULL,
      'adjustment_account', v_adj_acct IS NOT NULL,
      'journal_book',       v_journal_book_ok,
      'warehouse_active',   v_warehouse_ok,
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
END;
$$;

GRANT EXECUTE ON FUNCTION public.physical_count_preflight(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.physical_count_preview_je(p_count_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_c RECORD;
  v_inv_acct uuid;
  v_adj_acct uuid;
  v_inv_row RECORD;
  v_adj_row RECORD;
  v_total_positive numeric := 0;
  v_total_negative numeric := 0;
  v_line_details jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_c FROM public.physical_counts WHERE id = p_count_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'physical count % not found', p_count_id USING ERRCODE='P0001';
  END IF;

  v_inv_acct := public._resolve_canonical_default_account(
    'inventory', v_c.organization_id, v_c.business_id, v_c.branch_id, now()
  );
  v_adj_acct := public._resolve_canonical_default_account(
    'inventory_adjustment', v_c.organization_id, v_c.business_id, v_c.branch_id, now()
  );

  SELECT COALESCE(SUM(CASE WHEN variance_qty > 0 THEN variance_qty * COALESCE(unit_cost_snapshot,0) ELSE 0 END),0),
         COALESCE(SUM(CASE WHEN variance_qty < 0 THEN -variance_qty * COALESCE(unit_cost_snapshot,0) ELSE 0 END),0)
    INTO v_total_positive, v_total_negative
    FROM public.physical_count_lines
   WHERE count_id = p_count_id
     AND counted_qty IS NOT NULL;

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
    'inventory_account', CASE WHEN v_inv_row.id IS NULL THEN NULL ELSE jsonb_build_object('id', v_inv_row.id, 'code', v_inv_row.code, 'name', v_inv_row.name) END,
    'adjustment_account', CASE WHEN v_adj_row.id IS NULL THEN NULL ELSE jsonb_build_object('id', v_adj_row.id, 'code', v_adj_row.code, 'name', v_adj_row.name) END,
    'surplus_value',   v_total_positive,
    'shrinkage_value', v_total_negative,
    'net_value',       v_total_positive - v_total_negative,
    'journal_lines', jsonb_build_array(
      jsonb_build_object('account', COALESCE(v_inv_row.code || ' — ' || v_inv_row.name, 'Inventory account not configured'),
                         'debit',  v_total_positive, 'credit', v_total_negative,
                         'purpose', 'Inventory asset (net movement)'),
      jsonb_build_object('account', COALESCE(v_adj_row.code || ' — ' || v_adj_row.name, 'Inventory adjustment account not configured'),
                         'debit',  v_total_negative, 'credit', v_total_positive,
                         'purpose', 'Shrinkage/surplus P&L')
    ),
    'lines', v_line_details
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.physical_count_preview_je(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.physical_count_post(p_count_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_c RECORD;
  v_line RECORD;
  v_adj_id uuid;
  v_entry_number text;
  v_journal_id uuid;
  v_journal_book_id uuid;
  v_inv_acct uuid;
  v_adj_acct uuid;
  v_total_positive numeric := 0;
  v_total_negative numeric := 0;
  v_cost numeric;
  v_final_variance numeric;
  v_since_movements_qty numeric;
  v_processed int := 0;
  v_period_id uuid;
  v_period_status text;
  v_wh_active boolean;
  v_adj_created_by uuid;
BEGIN
  SELECT * INTO v_c
    FROM public.physical_counts
   WHERE id = p_count_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Physical count not found.' USING ERRCODE = 'P0001';
  END IF;

  IF v_c.state = 'posted' THEN
    RETURN jsonb_build_object(
      'success', true,
      'count_id', p_count_id,
      'adjustment_id', CASE WHEN array_length(v_c.posted_adjustment_ids, 1) >= 1 THEN v_c.posted_adjustment_ids[1] ELSE NULL END,
      'journal_entry_id', v_c.posted_journal_entry_id,
      'lines_processed', 0,
      'already_posted', true
    );
  END IF;

  IF v_c.state <> 'approved' THEN
    RAISE EXCEPTION 'Only approved counts can be posted. Current state: %.', v_c.state
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM public.governance_assert_not_self(
    p_user_id,
    v_c.approved_by,
    'inventory.post_count',
    v_c.organization_id,
    'physical_count',
    p_count_id
  );

  SELECT is_active INTO v_wh_active
    FROM public.warehouses
   WHERE id = v_c.warehouse_id
     AND organization_id = v_c.organization_id
     AND business_id = v_c.business_id;
  IF COALESCE(v_wh_active, false) = false THEN
    RAISE EXCEPTION 'The warehouse for this count is inactive. Reactivate it before posting.'
      USING ERRCODE = 'P0001',
            HINT = 'Open Inventory → Warehouses and set the warehouse to active.';
  END IF;

  SELECT id, status INTO v_period_id, v_period_status
    FROM public.fiscal_periods
   WHERE organization_id = v_c.organization_id
     AND business_id = v_c.business_id
     AND CURRENT_DATE BETWEEN start_date AND end_date
   ORDER BY start_date DESC
   LIMIT 1;

  IF v_period_id IS NULL THEN
    RAISE EXCEPTION 'No fiscal period is defined for today (%). Open Accounting → Fiscal Periods and create a period.', CURRENT_DATE
      USING ERRCODE = 'P0001';
  END IF;

  IF v_period_status = 'closed' THEN
    RAISE EXCEPTION 'The fiscal period covering today is closed. Reopen it or wait for the next period.'
      USING ERRCODE = 'P0001';
  END IF;

  v_inv_acct := public._resolve_canonical_default_account(
    'inventory', v_c.organization_id, v_c.business_id, v_c.branch_id, now()
  );
  v_adj_acct := public._resolve_canonical_default_account(
    'inventory_adjustment', v_c.organization_id, v_c.business_id, v_c.branch_id, now()
  );

  IF v_inv_acct IS NULL OR v_adj_acct IS NULL THEN
    RAISE EXCEPTION 'Inventory or Inventory Adjustment default accounts are not configured.'
      USING ERRCODE = 'P0001',
            HINT = 'Open Accounting → Default Accounts and map Inventory and Inventory Adjustment.';
  END IF;

  v_journal_book_id := v_c.journal_book_id;
  IF v_journal_book_id IS NOT NULL THEN
    SELECT jb.id INTO v_journal_book_id
      FROM public.journal_books jb
     WHERE jb.id = v_journal_book_id
       AND jb.organization_id = v_c.organization_id
       AND jb.business_id = v_c.business_id
       AND jb.is_active = true;
  END IF;

  IF v_journal_book_id IS NULL THEN
    SELECT id INTO v_journal_book_id
      FROM public.journal_books
     WHERE organization_id = v_c.organization_id
       AND business_id = v_c.business_id
       AND is_active = true
       AND journal_type = 'general'
     ORDER BY is_system DESC, created_at ASC
     LIMIT 1;
  END IF;

  IF v_journal_book_id IS NULL THEN
    SELECT id INTO v_journal_book_id
      FROM public.journal_books
     WHERE organization_id = v_c.organization_id
       AND business_id = v_c.business_id
       AND is_active = true
     ORDER BY is_system DESC, created_at ASC
     LIMIT 1;
  END IF;

  IF v_journal_book_id IS NULL THEN
    RAISE EXCEPTION 'No active journal book is configured for this business.'
      USING ERRCODE = 'P0001',
            HINT = 'Open Accounting → Journal Books and activate a general journal.';
  END IF;

  v_adj_created_by := COALESCE(
    NULLIF(v_c.approved_by, p_user_id),
    NULLIF(v_c.submitted_by, p_user_id),
    NULLIF(v_c.created_by, p_user_id),
    NULLIF(v_c.frozen_by, p_user_id),
    p_user_id
  );

  INSERT INTO public.stock_adjustments (
    organization_id, business_id, branch_id, warehouse_id,
    adjustment_number, adjustment_date, reason, notes, status,
    created_by, allow_negative
  ) VALUES (
    v_c.organization_id, v_c.business_id, v_c.branch_id, v_c.warehouse_id,
    'PCADJ-' || v_c.count_number, CURRENT_DATE, 'Physical Count',
    'Physical count ' || v_c.count_number, 'draft', v_adj_created_by, true
  ) RETURNING id INTO v_adj_id;

  FOR v_line IN
    SELECT pcl.*, fm.last_movement_id
      FROM public.physical_count_lines pcl
      LEFT JOIN public.physical_count_freeze_movements fm
        ON fm.count_id = pcl.count_id
       AND fm.product_id = pcl.product_id
     WHERE pcl.count_id = p_count_id
       AND pcl.counted_qty IS NOT NULL
  LOOP
    SELECT COALESCE(SUM(CASE
             WHEN sm.movement_type IN ('receipt','purchase','transfer_in','opening','return_in') AND sm.quantity > 0 THEN sm.quantity
             WHEN sm.movement_type IN ('sale','delivery','pos_sale','transfer','scrap','return_out','pos_return') THEN -ABS(sm.quantity)
             ELSE sm.quantity
           END), 0)
      INTO v_since_movements_qty
      FROM public.stock_movements sm
     WHERE sm.warehouse_id = v_c.warehouse_id
       AND sm.product_id = v_line.product_id
       AND (v_line.last_movement_id IS NULL OR sm.id <> v_line.last_movement_id)
       AND (v_line.last_movement_id IS NULL OR sm.created_at > (
             SELECT created_at FROM public.stock_movements WHERE id = v_line.last_movement_id
           ));

    UPDATE public.physical_count_lines
       SET freeze_reconciliation_qty = v_since_movements_qty
     WHERE id = v_line.id;

    v_final_variance := v_line.counted_qty - (v_line.system_qty_at_freeze + v_since_movements_qty);

    IF v_final_variance = 0 THEN
      CONTINUE;
    END IF;

    INSERT INTO public.stock_adjustment_items (
      adjustment_id, product_id, quantity_before, quantity_adjustment,
      quantity_after, unit_cost, warehouse_id, branch_id, notes
    ) VALUES (
      v_adj_id, v_line.product_id,
      v_line.system_qty_at_freeze + v_since_movements_qty,
      v_final_variance, v_line.counted_qty,
      COALESCE(v_line.unit_cost_snapshot, 0),
      v_c.warehouse_id, v_c.branch_id,
      'Physical count ' || v_c.count_number || ': system+recon=' ||
      (v_line.system_qty_at_freeze + v_since_movements_qty)::text ||
      ' counted=' || v_line.counted_qty::text
    );

    INSERT INTO public.stock_movements (
      organization_id, business_id, branch_id, warehouse_id, product_id,
      movement_type, quantity, unit_cost, reference_type, reference_id,
      notes, created_by
    ) VALUES (
      v_c.organization_id, v_c.business_id, v_c.branch_id, v_c.warehouse_id,
      v_line.product_id, 'adjustment', v_final_variance,
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
       SET status = 'approved',
           variance_qty = v_final_variance,
           variance_value = v_final_variance * COALESCE(v_line.unit_cost_snapshot, 0)
     WHERE id = v_line.id;

    v_processed := v_processed + 1;
  END LOOP;

  UPDATE public.stock_adjustments
     SET status = 'approved', approved_by = p_user_id, approved_at = now(), updated_at = now()
   WHERE id = v_adj_id;

  IF (v_total_positive > 0 OR v_total_negative > 0) THEN
    v_entry_number := public.get_next_journal_entry_number(v_c.organization_id);

    PERFORM set_config('app.suppress_je_recompute', 'on', true);

    INSERT INTO public.journal_entries (
      organization_id, business_id, branch_id, entry_number, entry_date,
      description, reference, source_type, source_subtype, source_id,
      journal_book_id, fiscal_period_id, status, posted_at, posted_by,
      created_by, is_adjusting, is_adjusting_entry, total_debit, total_credit
    ) VALUES (
      v_c.organization_id, v_c.business_id, v_c.branch_id, v_entry_number, CURRENT_DATE,
      'Physical count adjustment ' || v_c.count_number, v_c.count_number,
      'inventory_adjustment', 'physical_count', p_count_id,
      v_journal_book_id, v_period_id, 'posted', now(), p_user_id,
      p_user_id, true, true,
      v_total_positive + v_total_negative,
      v_total_positive + v_total_negative
    ) RETURNING id INTO v_journal_id;

    IF v_total_positive > 0 THEN
      INSERT INTO public.journal_entry_lines (
        journal_entry_id, organization_id, business_id, branch_id,
        account_id, debit, credit, description
      ) VALUES
        (v_journal_id, v_c.organization_id, v_c.business_id, v_c.branch_id,
         v_inv_acct, v_total_positive, 0, 'Physical count — surplus (' || v_c.count_number || ')'),
        (v_journal_id, v_c.organization_id, v_c.business_id, v_c.branch_id,
         v_adj_acct, 0, v_total_positive, 'Physical count — surplus offset');
    END IF;

    IF v_total_negative > 0 THEN
      INSERT INTO public.journal_entry_lines (
        journal_entry_id, organization_id, business_id, branch_id,
        account_id, debit, credit, description
      ) VALUES
        (v_journal_id, v_c.organization_id, v_c.business_id, v_c.branch_id,
         v_adj_acct, v_total_negative, 0, 'Physical count — shrinkage (' || v_c.count_number || ')'),
        (v_journal_id, v_c.organization_id, v_c.business_id, v_c.branch_id,
         v_inv_acct, 0, v_total_negative, 'Physical count — shrinkage offset');
    END IF;
  END IF;

  UPDATE public.physical_counts
     SET state = 'posted',
         posted_at = now(),
         posted_by = p_user_id,
         posted_adjustment_ids = ARRAY[v_adj_id],
         posted_journal_entry_id = v_journal_id,
         journal_book_id = v_journal_book_id,
         updated_at = now()
   WHERE id = p_count_id;

  INSERT INTO public.physical_count_events (count_id, organization_id, event_type, actor_id, payload)
  VALUES (
    p_count_id, v_c.organization_id, 'posted', p_user_id,
    jsonb_build_object(
      'adjustment_id', v_adj_id,
      'journal_entry_id', v_journal_id,
      'journal_book_id', v_journal_book_id,
      'lines_processed', v_processed,
      'surplus_value', v_total_positive,
      'shrinkage_value', v_total_negative,
      'resolved_accounts', jsonb_build_object(
        'inventory', v_inv_acct,
        'inventory_adjustment', v_adj_acct
      ),
      'derived_adjustment_created_by', v_adj_created_by
    )
  );

  INSERT INTO public.business_event_outbox (
    org_id, business_id, branch_id, warehouse_id, event_type,
    source_doc_type, source_doc_id, payload, status, source,
    actor_user_id, idempotency_key
  ) VALUES (
    v_c.organization_id, v_c.business_id, v_c.branch_id, v_c.warehouse_id,
    'inventory.physical_count.posted', 'physical_count', p_count_id,
    jsonb_build_object(
      'count_id', p_count_id,
      'warehouse_id', v_c.warehouse_id,
      'adjustment_id', v_adj_id,
      'journal_entry_id', v_journal_id
    ),
    'pending'::public.business_event_status,
    'system', p_user_id,
    'inventory.physical_count.posted:' || p_count_id::text
  )
  ON CONFLICT (org_id, idempotency_key) DO NOTHING;

  RETURN jsonb_build_object(
    'success', true,
    'count_id', p_count_id,
    'adjustment_id', v_adj_id,
    'journal_entry_id', v_journal_id,
    'journal_book_id', v_journal_book_id,
    'lines_processed', v_processed,
    'surplus_value', v_total_positive,
    'shrinkage_value', v_total_negative
  );
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'Posting conflicted with an existing ledger document. No changes were made.'
      USING ERRCODE = 'P0001', HINT = SQLERRM;
  WHEN check_violation THEN
    RAISE EXCEPTION 'Posting failed a data integrity rule. No changes were made.'
      USING ERRCODE = 'P0001', HINT = SQLERRM;
  WHEN not_null_violation THEN
    RAISE EXCEPTION 'Posting failed because a required field was missing. No changes were made.'
      USING ERRCODE = 'P0001', HINT = SQLERRM;
  WHEN foreign_key_violation THEN
    RAISE EXCEPTION 'Posting failed because a linked record was missing (e.g. account, journal book, warehouse, or product). No changes were made.'
      USING ERRCODE = 'P0001', HINT = SQLERRM;
END;
$$;

GRANT EXECUTE ON FUNCTION public.physical_count_post(uuid, uuid) TO authenticated, service_role;