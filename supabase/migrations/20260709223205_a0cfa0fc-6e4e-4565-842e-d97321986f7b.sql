CREATE OR REPLACE FUNCTION public.physical_count_post(p_count_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_c            public.physical_counts%ROWTYPE;
  v_adj_id       uuid;
  v_journal_id   uuid;
  v_inv_acct     uuid;
  v_adj_acct     uuid;
  v_total_positive numeric := 0;
  v_total_negative numeric := 0;
  v_line_count   int := 0;
  v_period_id    uuid;
  v_period_status text;
  v_wh_active    boolean;
  v_journal_book uuid;
BEGIN
  SELECT * INTO v_c FROM public.physical_counts WHERE id = p_count_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Physical count not found.' USING ERRCODE = 'P0001';
  END IF;

  IF v_c.state <> 'approved' THEN
    RAISE EXCEPTION 'Only approved counts can be posted. Current state: %.', v_c.state
      USING ERRCODE = 'P0001';
  END IF;

  -- Warehouse must be active
  SELECT is_active INTO v_wh_active FROM public.warehouses WHERE id = v_c.warehouse_id;
  IF v_wh_active IS NULL OR v_wh_active = false THEN
    RAISE EXCEPTION 'The warehouse for this count is inactive. Reactivate it before posting.'
      USING ERRCODE = 'P0001',
            HINT   = 'Open Inventory → Warehouses and set the warehouse to active.';
  END IF;

  -- Fiscal period must exist and be open for today
  SELECT id, status INTO v_period_id, v_period_status
    FROM public.fiscal_periods
   WHERE business_id = v_c.business_id
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

  -- Resolve GL accounts
  BEGIN
    v_inv_acct := public.resolve_default_account(v_c.business_id, 'inventory_asset');
    v_adj_acct := public.resolve_default_account(v_c.business_id, 'inventory_adjustment');
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Inventory or Inventory Adjustment default accounts are not configured.'
      USING ERRCODE = 'P0001',
            HINT   = 'Open Accounting → Default Accounts and map Inventory Asset and Inventory Adjustment.';
  END;

  IF v_inv_acct IS NULL OR v_adj_acct IS NULL THEN
    RAISE EXCEPTION 'Inventory or Inventory Adjustment default accounts are not configured.'
      USING ERRCODE = 'P0001',
            HINT   = 'Open Accounting → Default Accounts and map Inventory Asset and Inventory Adjustment.';
  END IF;

  -- Resolve journal book
  v_journal_book := v_c.journal_book_id;
  IF v_journal_book IS NULL THEN
    SELECT id INTO v_journal_book
      FROM public.journal_books
     WHERE business_id = v_c.business_id
       AND is_active = true
     ORDER BY (book_type = 'general') DESC
     LIMIT 1;
  END IF;

  IF v_journal_book IS NULL THEN
    RAISE EXCEPTION 'No active journal book is configured for this business.'
      USING ERRCODE = 'P0001',
            HINT   = 'Open Accounting → Journal Books and activate a general journal.';
  END IF;

  BEGIN
    -- Create adjustment record
    INSERT INTO public.stock_adjustments (
      business_id, branch_id, warehouse_id, adjustment_date, reason,
      status, created_by, source_physical_count_id
    ) VALUES (
      v_c.business_id, v_c.branch_id, v_c.warehouse_id, CURRENT_DATE,
      'Physical count ' || v_c.count_number,
      'posted', p_user_id, v_c.id
    ) RETURNING id INTO v_adj_id;

    -- Aggregate variances
    SELECT
      COALESCE(SUM(CASE WHEN variance_value > 0 THEN variance_value ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN variance_value < 0 THEN -variance_value ELSE 0 END), 0),
      COUNT(*)
    INTO v_total_positive, v_total_negative, v_line_count
    FROM public.physical_count_lines
    WHERE physical_count_id = v_c.id
      AND COALESCE(variance_value, 0) <> 0;

    IF v_line_count > 0 THEN
      -- Journal entry
      INSERT INTO public.journal_entries (
        business_id, branch_id, journal_book_id, entry_date, reference,
        description, status, created_by, fiscal_period_id, source_type, source_id
      ) VALUES (
        v_c.business_id, v_c.branch_id, v_journal_book, CURRENT_DATE,
        v_c.count_number,
        'Physical count adjustment ' || v_c.count_number,
        'posted', p_user_id, v_period_id, 'physical_count', v_c.id
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
  EXCEPTION
    WHEN check_violation THEN
      RAISE EXCEPTION 'Posting failed a data integrity rule. No changes were made.'
        USING ERRCODE = 'P0001',
              HINT   = SQLERRM;
    WHEN not_null_violation THEN
      RAISE EXCEPTION 'Posting failed because a required field was missing. No changes were made.'
        USING ERRCODE = 'P0001',
              HINT   = SQLERRM;
    WHEN foreign_key_violation THEN
      RAISE EXCEPTION 'Posting failed because a linked record was missing (e.g. account, journal book, or product). No changes were made.'
        USING ERRCODE = 'P0001',
              HINT   = SQLERRM;
    WHEN exclusion_violation THEN
      RAISE EXCEPTION 'Posting conflicted with another concurrent posting. No changes were made — please retry.'
        USING ERRCODE = 'P0001',
              HINT   = SQLERRM;
  END;

  UPDATE public.physical_counts
     SET state = 'posted',
         posted_at = now(),
         posted_by = p_user_id,
         posted_adjustment_ids = ARRAY[v_adj_id],
         posted_journal_entry_id = v_journal_id,
         updated_at = now()
   WHERE id = p_count_id;

  RETURN jsonb_build_object(
    'ok', true,
    'adjustment_id', v_adj_id,
    'journal_entry_id', v_journal_id,
    'lines', v_line_count
  );
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.physical_count_post(uuid, uuid) TO authenticated, service_role;