CREATE OR REPLACE FUNCTION public.post_stock_adjustment_gl(p_adjustment_id uuid, p_mode text DEFAULT 'opening'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid; v_business uuid; v_branch uuid; v_date date; v_number text;
  v_inv_account uuid; v_counter_account uuid; v_existing uuid; v_je_id uuid;
  v_total_value numeric := 0; v_amt numeric := 0; v_lines jsonb;
BEGIN
  IF p_mode NOT IN ('opening','revaluation') THEN
    RAISE EXCEPTION 'Invalid mode %', p_mode;
  END IF;

  SELECT organization_id, business_id, branch_id, adjustment_date, adjustment_number
    INTO v_org, v_business, v_branch, v_date, v_number
  FROM public.stock_adjustments WHERE id = p_adjustment_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Adjustment % not found', p_adjustment_id; END IF;

  PERFORM public._assert_org_member(v_org);

  SELECT id INTO v_existing FROM public.journal_entries
    WHERE organization_id = v_org AND source_type = 'stock_adjustment' AND source_id = p_adjustment_id
    LIMIT 1;
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  SELECT account_id INTO v_inv_account FROM public.default_account_settings
    WHERE organization_id = v_org AND setting_key = 'inventory' LIMIT 1;
  IF v_inv_account IS NULL THEN
    RAISE EXCEPTION 'Inventory default account is not configured';
  END IF;

  IF p_mode = 'opening' THEN
    SELECT account_id INTO v_counter_account FROM public.default_account_settings
      WHERE organization_id = v_org AND setting_key = 'opening_balance_equity' LIMIT 1;
    IF v_counter_account IS NULL THEN
      RAISE EXCEPTION 'Opening Balance Equity default account is not configured';
    END IF;
  ELSE
    SELECT account_id INTO v_counter_account FROM public.default_account_settings
      WHERE organization_id = v_org AND setting_key IN ('inventory_adjustment','cogs')
      ORDER BY CASE setting_key WHEN 'inventory_adjustment' THEN 0 ELSE 1 END LIMIT 1;
    IF v_counter_account IS NULL THEN
      RAISE EXCEPTION 'Inventory Adjustment / COGS default account is not configured';
    END IF;
  END IF;

  SELECT COALESCE(SUM(
           sai.quantity_adjustment *
           COALESCE(
             NULLIF(sai.unit_cost, 0),
             NULLIF(public.compute_unit_cost(v_business, sai.product_id, sai.warehouse_id), 0),
             p.cost_price,
             0
           )
         ), 0)
    INTO v_total_value
  FROM public.stock_adjustment_items sai
  JOIN public.products p ON p.id = sai.product_id
  WHERE sai.adjustment_id = p_adjustment_id;

  IF v_total_value = 0 THEN
    RAISE EXCEPTION 'Stock adjustment has zero value — refusing to post empty journal';
  END IF;

  v_amt := abs(v_total_value);

  IF v_total_value > 0 THEN
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id', v_inv_account, 'debit', v_amt, 'credit', 0,
        'description', 'Inventory increase', 'business_id', v_business, 'branch_id', v_branch),
      jsonb_build_object('account_id', v_counter_account, 'debit', 0, 'credit', v_amt,
        'description', CASE WHEN p_mode='opening' THEN 'Opening Balance Equity' ELSE 'Inventory Adjustment' END,
        'business_id', v_business, 'branch_id', v_branch)
    );
  ELSE
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id', v_counter_account, 'debit', v_amt, 'credit', 0,
        'description', CASE WHEN p_mode='opening' THEN 'Opening Balance Equity' ELSE 'Inventory Adjustment' END,
        'business_id', v_business, 'branch_id', v_branch),
      jsonb_build_object('account_id', v_inv_account, 'debit', 0, 'credit', v_amt,
        'description', 'Inventory decrease', 'business_id', v_business, 'branch_id', v_branch)
    );
  END IF;

  v_je_id := public.post_journal_entry_atomic(
    v_org, v_business,
    public.generate_next_je_number(v_org, v_business),
    v_date,
    v_number,
    CASE WHEN p_mode='opening' THEN 'Opening Inventory — ' ELSE 'Inventory Revaluation — ' END || COALESCE(v_number,''),
    'stock_adjustment', p_adjustment_id, auth.uid(), false, false,
    v_lines, NULL, NULL, p_mode, v_branch
  );

  IF p_mode = 'opening' THEN
    UPDATE public.journal_entries SET is_opening_entry = true WHERE id = v_je_id;
  END IF;

  RETURN v_je_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.physical_count_supersede(p_source_count_id uuid, p_user_id uuid, p_reason text DEFAULT 'Reversal'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_src RECORD; v_orig_adj_id uuid; v_new_adj_id uuid;
  v_orig_je uuid; v_new_je uuid;
  v_orig_line RECORD; v_lines jsonb;
BEGIN
  SELECT * INTO v_src FROM public.physical_counts WHERE id = p_source_count_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'physical count % not found', p_source_count_id USING ERRCODE='P0001'; END IF;
  IF v_src.state <> 'posted' THEN
    RAISE EXCEPTION 'cannot supersede count in state % — only posted counts can be reversed', v_src.state
      USING ERRCODE='P0001';
  END IF;

  v_orig_adj_id := (v_src.posted_adjustment_ids)[1];
  v_orig_je := v_src.posted_journal_entry_id;

  INSERT INTO public.stock_adjustments (
    organization_id, business_id, branch_id, warehouse_id,
    adjustment_number, adjustment_date, reason, notes,
    status, created_by, approved_by, approved_at, allow_negative
  ) VALUES (
    v_src.organization_id, v_src.business_id, v_src.branch_id, v_src.warehouse_id,
    'PCADJ-REV-' || v_src.count_number, CURRENT_DATE,
    'Physical Count Reversal',
    'Reversal of ' || v_src.count_number || ' — ' || p_reason,
    'approved', p_user_id, p_user_id, now(), true
  ) RETURNING id INTO v_new_adj_id;

  FOR v_orig_line IN
    SELECT * FROM public.stock_adjustment_items WHERE adjustment_id = v_orig_adj_id
  LOOP
    INSERT INTO public.stock_adjustment_items (
      adjustment_id, product_id,
      quantity_before, quantity_adjustment, quantity_after,
      unit_cost, warehouse_id, branch_id, notes
    ) VALUES (
      v_new_adj_id, v_orig_line.product_id,
      v_orig_line.quantity_after,
      -v_orig_line.quantity_adjustment,
      v_orig_line.quantity_before,
      v_orig_line.unit_cost, v_src.warehouse_id, v_src.branch_id,
      'Reversal of physical count ' || v_src.count_number
    );

    INSERT INTO public.stock_movements (
      organization_id, business_id, branch_id, warehouse_id,
      product_id, movement_type, quantity, unit_cost,
      reference_type, reference_id, notes, created_by
    ) VALUES (
      v_src.organization_id, v_src.business_id, v_src.branch_id, v_src.warehouse_id,
      v_orig_line.product_id,
      CASE WHEN v_orig_line.quantity_adjustment > 0 THEN 'adjustment_out' ELSE 'adjustment_in' END,
      ABS(v_orig_line.quantity_adjustment), v_orig_line.unit_cost,
      'physical_count_reversal', p_source_count_id,
      'Reversal of physical count ' || v_src.count_number, p_user_id
    );
  END LOOP;

  IF v_orig_je IS NOT NULL THEN
    SELECT jsonb_agg(
             jsonb_build_object(
               'account_id', jel.account_id,
               'debit', jel.credit,
               'credit', jel.debit,
               'description', 'Reversal: ' || COALESCE(jel.description,''),
               'business_id', jel.business_id,
               'branch_id', jel.branch_id
             ) ORDER BY jel.sort_order NULLS LAST, jel.id
           )
      INTO v_lines
      FROM public.journal_entry_lines jel
     WHERE jel.journal_entry_id = v_orig_je;

    IF v_lines IS NOT NULL AND jsonb_array_length(v_lines) > 0 THEN
      v_new_je := public.post_journal_entry_atomic(
        v_src.organization_id, v_src.business_id,
        public.generate_next_je_number(v_src.organization_id, v_src.business_id),
        CURRENT_DATE,
        v_src.count_number,
        'Reversal of physical count ' || v_src.count_number,
        'inventory_adjustment', p_source_count_id, p_user_id, false, false,
        v_lines, NULL, NULL, 'physical_count_reversal', v_src.branch_id
      );

      UPDATE public.journal_entries
         SET is_reversal = true, reversal_of_id = v_orig_je,
             journal_book_id = COALESCE(journal_book_id, v_src.journal_book_id)
       WHERE id = v_new_je;
    END IF;
  END IF;

  UPDATE public.physical_counts
     SET state = 'superseded', cancelled_at = now(),
         cancelled_by = p_user_id, cancellation_reason = p_reason
   WHERE id = p_source_count_id;

  INSERT INTO public.physical_count_events (count_id, organization_id, event_type, actor_id, payload)
  VALUES (p_source_count_id, v_src.organization_id, 'superseded', p_user_id,
          jsonb_build_object('reversal_adjustment_id', v_new_adj_id,
                             'reversal_journal_entry_id', v_new_je, 'reason', p_reason));

  RETURN jsonb_build_object('success', true,
    'reversal_adjustment_id', v_new_adj_id,
    'reversal_journal_entry_id', v_new_je);
END
$function$;

CREATE OR REPLACE FUNCTION public.migrate_opening_balances_to_je(_org_id uuid, _business_id uuid DEFAULT NULL::uuid, _entry_date date DEFAULT '2024-01-01'::date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _je_id uuid;
  _acct record;
  _debit numeric;
  _credit numeric;
  _total_debit numeric := 0;
  _total_credit numeric := 0;
  _lines jsonb := '[]'::jsonb;
  _suspense_account_id uuid;
  _diff numeric;
  _ids uuid[] := '{}';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM accounts
    WHERE organization_id = _org_id
      AND is_active = true
      AND opening_balance != 0
      AND (_business_id IS NULL OR business_id = _business_id OR business_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'No opening balances to migrate';
  END IF;

  FOR _acct IN
    SELECT id, account_type, opening_balance
    FROM accounts
    WHERE organization_id = _org_id
      AND is_active = true
      AND opening_balance != 0
      AND (_business_id IS NULL OR business_id = _business_id OR business_id IS NULL)
    ORDER BY code
  LOOP
    IF _acct.account_type IN ('asset', 'expense') THEN
      IF _acct.opening_balance >= 0 THEN
        _debit := _acct.opening_balance; _credit := 0;
      ELSE
        _debit := 0; _credit := ABS(_acct.opening_balance);
      END IF;
    ELSE
      IF _acct.opening_balance >= 0 THEN
        _debit := 0; _credit := _acct.opening_balance;
      ELSE
        _debit := ABS(_acct.opening_balance); _credit := 0;
      END IF;
    END IF;

    _total_debit := _total_debit + _debit;
    _total_credit := _total_credit + _credit;

    _lines := _lines || jsonb_build_object(
      'account_id', _acct.id, 'debit', _debit, 'credit', _credit,
      'description', 'Opening balance'
    );
    _ids := _ids || _acct.id;
  END LOOP;

  IF _total_debit <> _total_credit THEN
    _diff := _total_debit - _total_credit;

    SELECT id INTO _suspense_account_id
    FROM accounts
    WHERE organization_id = _org_id
      AND account_type = 'equity'
      AND is_active = true
    ORDER BY code
    LIMIT 1;

    IF _suspense_account_id IS NULL THEN
      RAISE EXCEPTION 'No equity account found to absorb opening balance difference of %', _diff;
    END IF;

    _lines := _lines || jsonb_build_object(
      'account_id', _suspense_account_id,
      'debit', CASE WHEN _diff > 0 THEN 0 ELSE ABS(_diff) END,
      'credit', CASE WHEN _diff > 0 THEN _diff ELSE 0 END,
      'description', 'Opening balance adjustment (auto-balancing)'
    );
  END IF;

  _je_id := public.post_journal_entry_atomic(
    _org_id, _business_id,
    (SELECT COALESCE('OB-' || LPAD((COALESCE(MAX(CAST(NULLIF(SUBSTRING(entry_number FROM 'OB-(\d+)'), '') AS int)), 0) + 1)::text, 4, '0'), 'OB-0001')
       FROM journal_entries WHERE organization_id = _org_id AND entry_number LIKE 'OB-%'),
    _entry_date,
    NULL,
    'Opening Balance Migration (auto-generated from account opening balances)',
    'opening_balance', NULL, auth.uid(), false, false,
    _lines, NULL, NULL, NULL, NULL
  );

  UPDATE journal_entries SET is_opening_entry = true WHERE id = _je_id;
  UPDATE accounts SET opening_balance = 0, updated_at = now() WHERE id = ANY(_ids);

  RETURN _je_id;
END;
$function$;