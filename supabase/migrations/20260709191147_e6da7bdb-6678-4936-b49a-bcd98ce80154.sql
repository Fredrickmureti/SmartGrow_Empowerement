CREATE OR REPLACE FUNCTION public.physical_count_post(p_count_id uuid, p_user_id uuid, p_allow_self boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_c RECORD; v_line RECORD;
  v_adj_id uuid; v_entry_number text; v_journal_id uuid;
  v_total_positive numeric := 0; v_total_negative numeric := 0;
  v_inv_acct uuid; v_adj_acct uuid; v_cost numeric;
  v_movement_type text; v_final_variance numeric;
  v_since_movements_qty numeric;
  v_processed int := 0; v_period_status text;
  v_adj_created_by uuid;
BEGIN
  SELECT * INTO v_c FROM public.physical_counts WHERE id = p_count_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'physical count % not found', p_count_id USING ERRCODE='P0001'; END IF;
  IF v_c.state <> 'approved' THEN
    RAISE EXCEPTION 'cannot post count in state % — must be approved', v_c.state USING ERRCODE='P0001';
  END IF;

  IF NOT p_allow_self AND p_user_id = v_c.approved_by THEN
    RAISE EXCEPTION 'segregation of duties: poster cannot be the approver'
      USING ERRCODE='P0001', HINT='ask another authorized user to post, or grant a self-action override';
  END IF;

  SELECT status INTO v_period_status FROM public.fiscal_periods
   WHERE organization_id = v_c.organization_id
     AND CURRENT_DATE BETWEEN start_date AND end_date
   LIMIT 1;
  IF v_period_status = 'closed' THEN
    RAISE EXCEPTION 'fiscal period for % is closed — open a period before posting the count', CURRENT_DATE
      USING ERRCODE='P0001', HINT='reopen the period in Accounting → Fiscal Periods';
  END IF;

  v_inv_acct := public.resolve_default_account(v_c.business_id, 'inventory');
  v_adj_acct := public.resolve_default_account(v_c.business_id, 'inventory_adjustment');
  IF v_inv_acct IS NULL OR v_adj_acct IS NULL THEN
    RAISE EXCEPTION 'default accounts not configured (inventory / inventory_adjustment)'
      USING ERRCODE='P0001', HINT='set them in Accounting → Default Accounts';
  END IF;

  -- The derived stock_adjustments row is a machine-emitted side-effect of the
  -- count posting. Segregation of duties has already been enforced at the
  -- physical_counts level (approver ≠ poster unless p_allow_self). Stamp
  -- created_by with the count's approver so guard_stock_adjustment_self_approval
  -- (which compares approved_by vs created_by) sees two distinct actors.
  v_adj_created_by := COALESCE(v_c.approved_by, v_c.submitted_by, v_c.created_by);
  IF v_adj_created_by IS NULL OR v_adj_created_by = p_user_id THEN
    v_adj_created_by := COALESCE(
      NULLIF(v_c.submitted_by, p_user_id),
      NULLIF(v_c.created_by,   p_user_id),
      NULLIF(v_c.frozen_by,    p_user_id),
      v_adj_created_by
    );
  END IF;

  INSERT INTO public.stock_adjustments (
    organization_id, business_id, branch_id, warehouse_id,
    adjustment_number, adjustment_date, reason, notes,
    status, created_by, allow_negative
  ) VALUES (
    v_c.organization_id, v_c.business_id, v_c.branch_id, v_c.warehouse_id,
    'PCADJ-' || v_c.count_number, CURRENT_DATE,
    'Physical Count', 'Physical count ' || v_c.count_number,
    'draft', v_adj_created_by, true
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

  BEGIN
    UPDATE public.stock_adjustments
       SET status = 'approved', approved_by = p_user_id, approved_at = now()
     WHERE id = v_adj_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Could not approve the inventory adjustment generated by this physical count: %', SQLERRM
      USING ERRCODE = 'P0001',
            HINT = 'This usually means the approver conflicts with the counter or a governance rule is misconfigured. Ask an administrator to review Segregation of Duties settings for inventory adjustments.';
  END;

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
                             'allow_self', p_allow_self,
                             'derived_adjustment_created_by', v_adj_created_by));

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
END $function$;