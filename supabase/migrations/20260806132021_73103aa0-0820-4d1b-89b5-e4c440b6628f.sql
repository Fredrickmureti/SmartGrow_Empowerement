CREATE OR REPLACE FUNCTION public.payroll_generate_reclassification_je(p_run_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user           uuid := auth.uid();
  v_run            public.payroll_runs%ROWTYPE;
  v_orig_je        public.journal_entries%ROWTYPE;
  v_target_acct    uuid;
  v_new_je_id      uuid;
  v_bad_count      integer;
  v_bad_total      numeric(18,2);
  v_bad_codes      text[];
  v_branch_id      uuid;
  v_lines          jsonb;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_run FROM public.payroll_runs WHERE id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payroll_run % not found', p_run_id USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = v_user
      AND ur.organization_id = v_run.organization_id
      AND ur.is_active = true
  ) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  IF v_run.reclassification_journal_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'payroll_run % has already been reclassified (JE %)',
      p_run_id, v_run.reclassification_journal_entry_id USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_orig_je
  FROM public.journal_entries
  WHERE source_type = 'payroll'
    AND source_id = p_run_id
    AND organization_id = v_run.organization_id
    AND status = 'posted'
  ORDER BY posted_at DESC NULLS LAST
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No posted payroll JE found for run %', p_run_id USING ERRCODE = '22023';
  END IF;

  SELECT account_id INTO v_target_acct
  FROM public.default_account_settings
  WHERE organization_id = v_run.organization_id
    AND setting_key = 'salary_expense'
    AND (business_id = v_run.business_id OR (business_id IS NULL AND v_run.business_id IS NULL))
  LIMIT 1;

  IF v_target_acct IS NULL THEN
    SELECT account_id INTO v_target_acct
    FROM public.default_account_settings
    WHERE organization_id = v_run.organization_id
      AND setting_key = 'salary_expense'
      AND business_id IS NULL
    LIMIT 1;
  END IF;

  IF v_target_acct IS NULL THEN
    RAISE EXCEPTION 'Cannot reclassify: no salary_expense mapping configured. Set a compliant Payroll Expense account first.'
      USING ERRCODE = '22023';
  END IF;

  PERFORM public._payroll_assert_mapping_role('salary_expense', v_target_acct);

  CREATE TEMP TABLE _bad_lines ON COMMIT DROP AS
  SELECT jel.id,
         jel.account_id AS bad_account_id,
         a.code         AS bad_account_code,
         jel.debit,
         jel.description,
         jel.contact_id,
         jel.branch_id,
         jel.business_id
  FROM public.journal_entry_lines jel
  JOIN public.accounts a ON a.id = jel.account_id
  WHERE jel.journal_entry_id = v_orig_je.id
    AND jel.debit > 0
    AND public._payroll_is_cogs_account(jel.account_id);

  SELECT COUNT(*), COALESCE(SUM(debit), 0), ARRAY_AGG(DISTINCT bad_account_code)
    INTO v_bad_count, v_bad_total, v_bad_codes
  FROM _bad_lines;

  IF v_bad_count = 0 THEN
    RAISE EXCEPTION 'No role-violating lines found on JE %; nothing to reclassify', v_orig_je.id
      USING ERRCODE = '22023';
  END IF;

  v_branch_id := COALESCE(v_run.branch_id, v_orig_je.branch_id);

  -- Build both legs in memory, then hand off to the single posting engine.
  SELECT jsonb_agg(l ORDER BY (l->>'sort_order')::int)
    INTO v_lines
  FROM (
    SELECT jsonb_build_object(
             'account_id', v_target_acct, 'debit', b.debit, 'credit', 0,
             'description', 'Reclass DR (was on ' || b.bad_account_code || '): ' || b.description,
             'contact_id', b.contact_id, 'branch_id', b.branch_id, 'business_id', b.business_id,
             'sort_order', (row_number() OVER (ORDER BY b.id)) * 2 - 1
           ) AS l
      FROM _bad_lines b
    UNION ALL
    SELECT jsonb_build_object(
             'account_id', b.bad_account_id, 'debit', 0, 'credit', b.debit,
             'description', 'Reclass CR (clearing ' || b.bad_account_code || '): ' || b.description,
             'contact_id', b.contact_id, 'branch_id', b.branch_id, 'business_id', b.business_id,
             'sort_order', (row_number() OVER (ORDER BY b.id)) * 2
           ) AS l
      FROM _bad_lines b
  ) s;

  v_new_je_id := public.post_journal_entry_atomic(
    v_run.organization_id, v_run.business_id,
    public.generate_next_je_number(v_run.organization_id, v_run.business_id),
    CURRENT_DATE,
    v_orig_je.entry_number,
    'Payroll reclassification — correcting role-violating mappings on ' || v_orig_je.entry_number ||
      ' (run ' || v_run.payroll_number || '). See payroll_reclassification_audit.',
    'payroll_reclassification', p_run_id, v_user, false, true,
    v_lines, NULL, NULL, 'role_violation_fix', v_branch_id
  );

  UPDATE public.payroll_runs
     SET reclassification_journal_entry_id = v_new_je_id,
         updated_at = now()
   WHERE id = p_run_id;

  INSERT INTO public.payroll_reclassification_audit (
    organization_id, business_id, payroll_run_id,
    original_journal_entry_id, reclassification_journal_entry_id,
    lines_corrected, amount_corrected, from_account_codes, to_account_id,
    performed_by, reason
  ) VALUES (
    v_run.organization_id, v_run.business_id, p_run_id,
    v_orig_je.id, v_new_je_id,
    v_bad_count, v_bad_total, v_bad_codes, v_target_acct,
    v_user,
    'Auto-reclass: salary_expense / employer-expense debits routed to a Cost of Goods Sold account. Corrected to currently mapped salary_expense.'
  );

  RETURN v_new_je_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.revalue_fx_balances(_business_id uuid, _run_date date, _base_currency text, _unrealized_gain_account uuid, _unrealized_loss_account uuid, _user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org_id uuid;
  _run_id uuid;
  _je_id uuid;
  _je_number text;
  _fx_book_id uuid;
  _row record;
  _new_rate numeric;
  _line_seq integer := 0;
  _total_gain numeric := 0;
  _total_loss numeric := 0;
  _net_delta numeric := 0;
  _base_new numeric;
  _delta numeric;
  _old_rate numeric;
  _gain_business uuid;
  _loss_business uuid;
  _lines jsonb := '[]'::jsonb;
BEGIN
  SELECT organization_id INTO _org_id FROM public.businesses WHERE id = _business_id;
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'Business % not found', _business_id;
  END IF;

  SELECT business_id INTO _gain_business FROM public.accounts WHERE id = _unrealized_gain_account;
  SELECT business_id INTO _loss_business FROM public.accounts WHERE id = _unrealized_loss_account;
  IF _gain_business IS DISTINCT FROM _business_id OR _loss_business IS DISTINCT FROM _business_id THEN
    RAISE EXCEPTION 'FX gain/loss accounts must belong to the selected business';
  END IF;

  SELECT public.default_journal_book_for_source(_business_id, 'fx_revaluation') INTO _fx_book_id;

  INSERT INTO public.fx_revaluation_runs (
    organization_id, business_id, run_date, base_currency, status, created_by,
    reversal_policy, journal_book_id, unrealized_gain_account_id, unrealized_loss_account_id
  ) VALUES (
    _org_id, _business_id, _run_date, upper(_base_currency), 'draft', _user_id,
    'next_period', _fx_book_id, _unrealized_gain_account, _unrealized_loss_account
  ) RETURNING id INTO _run_id;

  FOR _row IN
    SELECT
      jel.account_id,
      upper(je.currency) AS currency,
      SUM(COALESCE(jel.original_debit, jel.debit, 0) - COALESCE(jel.original_credit, jel.credit, 0)) AS foreign_balance,
      SUM(COALESCE(jel.debit,0) - COALESCE(jel.credit,0)) AS base_balance_old,
      MIN(jel.branch_id) AS branch_id
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.accounts a ON a.id = jel.account_id
    WHERE je.business_id = _business_id
      AND je.status = 'posted'
      AND je.entry_date <= _run_date
      AND je.currency IS NOT NULL
      AND upper(je.currency) <> upper(_base_currency)
      AND a.account_type IN ('asset','liability')
    GROUP BY jel.account_id, upper(je.currency)
    HAVING ABS(SUM(COALESCE(jel.original_debit, jel.debit, 0) - COALESCE(jel.original_credit, jel.credit, 0))) > 0.01
  LOOP
    SELECT rate INTO _new_rate
    FROM public.exchange_rates
    WHERE business_id = _business_id
      AND upper(from_currency) = _row.currency
      AND upper(to_currency) = upper(_base_currency)
      AND effective_date <= _run_date
    ORDER BY effective_date DESC
    LIMIT 1;

    CONTINUE WHEN _new_rate IS NULL;

    _base_new := _row.foreign_balance * _new_rate;
    _delta := round(_base_new - _row.base_balance_old, 2);
    _old_rate := CASE WHEN _row.foreign_balance = 0 THEN _new_rate ELSE _row.base_balance_old / _row.foreign_balance END;

    INSERT INTO public.fx_revaluation_lines (
      run_id, account_id, currency, foreign_balance,
      old_rate, new_rate, base_balance_old, base_balance_new, delta
    ) VALUES (
      _run_id, _row.account_id, _row.currency, _row.foreign_balance,
      _old_rate, _new_rate, _row.base_balance_old, _base_new, _delta
    );

    CONTINUE WHEN ABS(_delta) < 0.01;

    IF _delta > 0 THEN
      _lines := _lines
        || jsonb_build_object('account_id', _row.account_id, 'business_id', _business_id, 'branch_id', _row.branch_id,
             'description', 'FX revaluation ' || _row.currency || ' @ ' || _new_rate, 'debit', _delta, 'credit', 0)
        || jsonb_build_object('account_id', _unrealized_gain_account, 'business_id', _business_id, 'branch_id', _row.branch_id,
             'description', 'Unrealized FX gain ' || _row.currency, 'debit', 0, 'credit', _delta);
      _line_seq := _line_seq + 2;
      _total_gain := _total_gain + _delta;
    ELSE
      _lines := _lines
        || jsonb_build_object('account_id', _unrealized_loss_account, 'business_id', _business_id, 'branch_id', _row.branch_id,
             'description', 'Unrealized FX loss ' || _row.currency, 'debit', ABS(_delta), 'credit', 0)
        || jsonb_build_object('account_id', _row.account_id, 'business_id', _business_id, 'branch_id', _row.branch_id,
             'description', 'FX revaluation ' || _row.currency || ' @ ' || _new_rate, 'debit', 0, 'credit', ABS(_delta));
      _line_seq := _line_seq + 2;
      _total_loss := _total_loss + ABS(_delta);
    END IF;
    _net_delta := _net_delta + _delta;
  END LOOP;

  IF _line_seq = 0 THEN
    UPDATE public.fx_revaluation_runs
       SET status = 'posted', total_unrealized_gain = 0, total_unrealized_loss = 0, journal_entry_id = NULL
     WHERE id = _run_id;
    RETURN jsonb_build_object('success', true, 'run_id', _run_id, 'lines', 0, 'message', 'No FX deltas to post');
  END IF;

  _je_number := 'FX-' || to_char(_run_date, 'YYYYMMDD') || '-' || upper(substr(gen_random_uuid()::text, 1, 6));

  _je_id := public.post_journal_entry_atomic(
    _org_id, _business_id, _je_number, _run_date,
    NULL,
    'Unrealized FX revaluation as of ' || _run_date,
    'fx_revaluation', _run_id, _user_id, false, true,
    _lines, upper(_base_currency), 1, NULL, NULL
  );

  UPDATE public.journal_entries
     SET journal_book_id = COALESCE(journal_book_id, _fx_book_id)
   WHERE id = _je_id;

  UPDATE public.fx_revaluation_runs
     SET status = 'posted', total_unrealized_gain = _total_gain, total_unrealized_loss = _total_loss, journal_entry_id = _je_id
   WHERE id = _run_id;

  RETURN jsonb_build_object(
    'success', true,
    'run_id', _run_id,
    'journal_entry_id', _je_id,
    'lines', _line_seq,
    'unrealized_gain', _total_gain,
    'unrealized_loss', _total_loss,
    'net_delta', _net_delta,
    'reversal_policy', 'next_period'
  );
END;
$function$;