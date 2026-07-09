CREATE OR REPLACE FUNCTION public.physical_count_post(p_count_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_c RECORD;
  v_line RECORD;
  v_adj_id uuid;
  v_existing_adj_id uuid;
  v_journal_id uuid;
  v_wh_active boolean;
  v_period_id uuid;
  v_period_status text;
  v_reconciled numeric;
  v_final_variance numeric;
  v_last_mv_ts timestamptz;
  v_adj_number text;
  v_processed int := 0;
  v_lines_inserted int := 0;
  v_client_key uuid;
  v_approve_result jsonb;
  v_adj_created_by uuid;
  v_surplus numeric := 0;
  v_shrinkage numeric := 0;
  v_prev_override text;
BEGIN
  SELECT * INTO v_c FROM public.physical_counts WHERE id = p_count_id FOR UPDATE;
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
    RAISE EXCEPTION 'Only approved counts can be posted. Current state: %.', v_c.state USING ERRCODE = 'P0001';
  END IF;

  PERFORM public.governance_assert_not_self(
    p_user_id, v_c.approved_by, 'inventory.post_count',
    v_c.organization_id, 'physical_count', p_count_id
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

  v_client_key := ('00000000-0000-0000-0000-' || substr(replace(p_count_id::text, '-', ''), 1, 12))::uuid;

  SELECT id INTO v_existing_adj_id
    FROM public.stock_adjustments
   WHERE organization_id = v_c.organization_id
     AND business_id     = v_c.business_id
     AND client_request_id = v_client_key
   LIMIT 1;

  IF v_existing_adj_id IS NOT NULL THEN
    v_adj_id := v_existing_adj_id;
  ELSE
    v_adj_created_by := COALESCE(
      NULLIF(v_c.approved_by,  p_user_id),
      NULLIF(v_c.submitted_by, p_user_id),
      NULLIF(v_c.created_by,   p_user_id),
      NULLIF(v_c.frozen_by,    p_user_id),
      p_user_id
    );

    v_adj_number := 'PCADJ-' || v_c.count_number;

    INSERT INTO public.stock_adjustments (
      organization_id, business_id, branch_id, warehouse_id,
      adjustment_number, adjustment_date, reason, notes, status,
      created_by, allow_negative, client_request_id
    ) VALUES (
      v_c.organization_id, v_c.business_id, v_c.branch_id, v_c.warehouse_id,
      v_adj_number, CURRENT_DATE, 'count_variance',
      'Physical count ' || v_c.count_number, 'draft', v_adj_created_by, true,
      v_client_key
    ) RETURNING id INTO v_adj_id;
  END IF;

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
           END), 0),
           MAX(sm.created_at)
      INTO v_reconciled, v_last_mv_ts
      FROM public.stock_movements sm
     WHERE sm.warehouse_id = v_c.warehouse_id
       AND sm.product_id = v_line.product_id
       AND (v_line.last_movement_id IS NULL OR sm.id <> v_line.last_movement_id)
       AND (v_line.last_movement_id IS NULL OR sm.created_at > (
             SELECT created_at FROM public.stock_movements WHERE id = v_line.last_movement_id
           ));

    v_final_variance := COALESCE(v_line.recount_qty, v_line.counted_qty, 0)
                      - (v_line.system_qty_at_freeze + v_reconciled);

    INSERT INTO public.physical_count_post_reconciliations (
      count_id, line_id, organization_id, business_id,
      product_id, warehouse_id, reconciled_qty, final_variance_qty,
      movement_cutoff, posted_at, posted_by
    ) VALUES (
      p_count_id, v_line.id, v_c.organization_id, v_c.business_id,
      v_line.product_id, v_c.warehouse_id, v_reconciled, v_final_variance,
      v_last_mv_ts, now(), p_user_id
    )
    ON CONFLICT (count_id, line_id) DO UPDATE
       SET reconciled_qty     = EXCLUDED.reconciled_qty,
           final_variance_qty = EXCLUDED.final_variance_qty,
           movement_cutoff    = EXCLUDED.movement_cutoff,
           posted_at          = EXCLUDED.posted_at,
           posted_by          = EXCLUDED.posted_by;

    IF v_line.status <> 'approved' THEN
      UPDATE public.physical_count_lines SET status = 'approved', updated_at = now() WHERE id = v_line.id;
    END IF;

    v_processed := v_processed + 1;

    IF v_final_variance = 0 THEN CONTINUE; END IF;

    INSERT INTO public.stock_adjustment_items (
      adjustment_id, product_id, quantity_before, quantity_adjustment,
      quantity_after, unit_cost, warehouse_id, branch_id, notes
    ) VALUES (
      v_adj_id, v_line.product_id,
      v_line.system_qty_at_freeze + v_reconciled,
      v_final_variance,
      COALESCE(v_line.recount_qty, v_line.counted_qty, 0),
      COALESCE(v_line.unit_cost_snapshot, 0),
      v_c.warehouse_id, v_c.branch_id,
      'Physical count ' || v_c.count_number || ': system+recon=' ||
      (v_line.system_qty_at_freeze + v_reconciled)::text ||
      ' final=' || COALESCE(v_line.recount_qty, v_line.counted_qty, 0)::text
    );
    v_lines_inserted := v_lines_inserted + 1;

    IF v_final_variance > 0 THEN
      v_surplus := v_surplus + v_final_variance * COALESCE(v_line.unit_cost_snapshot, 0);
    ELSE
      v_shrinkage := v_shrinkage + (-v_final_variance) * COALESCE(v_line.unit_cost_snapshot, 0);
    END IF;
  END LOOP;

  IF v_lines_inserted > 0 THEN
    BEGIN
      v_prev_override := current_setting('app.physical_count_freeze_override', true);
    EXCEPTION WHEN OTHERS THEN
      v_prev_override := NULL;
    END;
    PERFORM set_config('app.physical_count_freeze_override', 'on', true);

    v_approve_result := public.approve_stock_adjustment_atomic(v_adj_id, p_user_id);

    PERFORM set_config('app.physical_count_freeze_override', COALESCE(v_prev_override, ''), true);

    IF NOT COALESCE((v_approve_result->>'success')::boolean, false) THEN
      RAISE EXCEPTION 'Physical count posting failed inside stock adjustment approval: %',
        COALESCE(v_approve_result->>'error', 'unknown error')
        USING ERRCODE = 'P0001';
    END IF;

    v_journal_id := NULLIF(v_approve_result->>'journal_entry_id','')::uuid;
  ELSE
    v_journal_id := NULL;
  END IF;

  UPDATE public.physical_counts
     SET state = 'posted',
         posted_at = now(),
         posted_by = p_user_id,
         posted_adjustment_ids = ARRAY[v_adj_id],
         posted_journal_entry_id = v_journal_id,
         updated_at = now()
   WHERE id = p_count_id;

  INSERT INTO public.physical_count_events (count_id, organization_id, event_type, actor_id, payload)
  VALUES (
    p_count_id, v_c.organization_id, 'posted', p_user_id,
    jsonb_build_object(
      'adjustment_id', v_adj_id,
      'journal_entry_id', v_journal_id,
      'lines_processed', v_processed,
      'lines_with_variance', v_lines_inserted,
      'surplus_value', v_surplus,
      'shrinkage_value', v_shrinkage,
      'delegated_to', 'approve_stock_adjustment_atomic'
    )
  );

  -- business_event_outbox has no business_id column; scope stays via org_id.
  INSERT INTO public.business_event_outbox (
    org_id, branch_id, warehouse_id, event_type,
    source_doc_type, source_doc_id, payload, status, source,
    actor_user_id, idempotency_key
  ) VALUES (
    v_c.organization_id, v_c.branch_id, v_c.warehouse_id,
    'inventory.physical_count.posted', 'physical_count', p_count_id,
    jsonb_build_object(
      'count_id', p_count_id,
      'business_id', v_c.business_id,
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
    'lines_processed', v_processed,
    'lines_with_variance', v_lines_inserted,
    'surplus_value', v_surplus,
    'shrinkage_value', v_shrinkage
  );
END;
$function$;