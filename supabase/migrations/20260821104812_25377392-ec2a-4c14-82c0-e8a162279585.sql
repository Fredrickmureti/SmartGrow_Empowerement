CREATE OR REPLACE FUNCTION public.reverse_fx_revaluation_run(_run_id uuid, _reversal_date date, _user_id uuid DEFAULT NULL::uuid, _next_run_id uuid DEFAULT NULL::uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  _run public.fx_revaluation_runs;
  _lines jsonb := '[]'::jsonb;
  _l record;
  _je_id uuid;
BEGIN
  SELECT * INTO _run FROM public.fx_revaluation_runs WHERE id = _run_id;
  IF _run.id IS NULL THEN
    RAISE EXCEPTION 'FX revaluation run % not found', _run_id USING ERRCODE = 'P0002';
  END IF;
  IF _run.status <> 'posted' THEN
    RAISE EXCEPTION 'Only a posted FX revaluation run can be reversed' USING ERRCODE = '23514';
  END IF;
  IF _run.reversal_journal_entry_id IS NOT NULL THEN
    RETURN _run.reversal_journal_entry_id;
  END IF;

  IF _run.journal_entry_id IS NULL THEN
    UPDATE public.fx_revaluation_runs
       SET status = 'reversed', reversed_at = now(), reversed_by_run_id = _next_run_id
     WHERE id = _run_id;
    RETURN NULL;
  END IF;

  FOR _l IN
    SELECT account_id, business_id, branch_id, description, debit, credit
      FROM public.journal_entry_lines
     WHERE journal_entry_id = _run.journal_entry_id
     ORDER BY id
  LOOP
    _lines := _lines || jsonb_build_object(
      'account_id', _l.account_id,
      'business_id', _l.business_id,
      'branch_id', _l.branch_id,
      'description', 'Reversal — ' || COALESCE(_l.description, 'FX revaluation'),
      'debit', COALESCE(_l.credit, 0),
      'credit', COALESCE(_l.debit, 0)
    );
  END LOOP;

  IF jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'FX revaluation journal entry % has no lines to reverse', _run.journal_entry_id
      USING ERRCODE = '23514';
  END IF;

  -- ADR-0146: the posting engine is the only journal numberer.
  _je_id := public.post_journal_entry_atomic(
    _run.organization_id, _run.business_id, NULL, _reversal_date,
    NULL,
    'Reversal of unrealized FX revaluation dated ' || _run.run_date,
    'fx_revaluation_reversal', _run.id, _user_id, false, true,
    _lines, _run.base_currency, 1, NULL, NULL
  );

  UPDATE public.journal_entries
     SET journal_book_id = COALESCE(journal_book_id, _run.journal_book_id)
   WHERE id = _je_id;

  UPDATE public.fx_revaluation_runs
     SET status = 'reversed',
         reversal_journal_entry_id = _je_id,
         reversed_at = now(),
         reversed_by_run_id = _next_run_id
   WHERE id = _run_id;

  RETURN _je_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.revalue_fx_balances(_business_id uuid, _run_date date, _base_currency text, _unrealized_gain_account uuid, _unrealized_loss_account uuid, _user_id uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  _org_id uuid;
  _run_id uuid;
  _je_id uuid;
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
  _period public.fiscal_periods;
  _prior public.fx_revaluation_runs;
  _reversal_je uuid;
  _uid uuid := COALESCE(auth.uid(), _user_id);
BEGIN
  SELECT organization_id INTO _org_id FROM public.businesses WHERE id = _business_id;
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'Business % not found', _business_id USING ERRCODE = 'P0002';
  END IF;

  IF _uid IS NULL OR NOT public.has_finance_permission(_uid, 'finance.manage_periods', _business_id) THEN
    RAISE EXCEPTION 'You do not have permission to run FX revaluation for this business'
      USING ERRCODE = '42501';
  END IF;

  SELECT business_id INTO _gain_business FROM public.accounts WHERE id = _unrealized_gain_account;
  SELECT business_id INTO _loss_business FROM public.accounts WHERE id = _unrealized_loss_account;
  IF _gain_business IS DISTINCT FROM _business_id OR _loss_business IS DISTINCT FROM _business_id THEN
    RAISE EXCEPTION 'FX gain/loss accounts must belong to the selected business' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO _period
    FROM public.fiscal_periods
   WHERE business_id = _business_id
     AND _run_date BETWEEN start_date AND end_date
   ORDER BY start_date DESC LIMIT 1;

  IF _period.id IS NOT NULL AND _period.status <> 'open' THEN
    RAISE EXCEPTION 'Fiscal period % is % — FX revaluation cannot post into it', _period.name, _period.status
      USING ERRCODE = '23514';
  END IF;

  IF _period.id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.fx_revaluation_runs
     WHERE business_id = _business_id AND fiscal_period_id = _period.id AND status = 'posted'
  ) THEN
    RAISE EXCEPTION 'A posted FX revaluation already exists for period %. Reverse it before running again.', _period.name
      USING ERRCODE = '23505';
  END IF;

  SELECT public.default_journal_book_for_source(_business_id, 'fx_revaluation') INTO _fx_book_id;

  INSERT INTO public.fx_revaluation_runs (
    organization_id, business_id, run_date, base_currency, status, created_by,
    reversal_policy, journal_book_id, unrealized_gain_account_id, unrealized_loss_account_id,
    fiscal_period_id
  ) VALUES (
    _org_id, _business_id, _run_date, upper(_base_currency), 'draft', _uid,
    'next_period', _fx_book_id, _unrealized_gain_account, _unrealized_loss_account,
    _period.id
  ) RETURNING id INTO _run_id;

  SELECT * INTO _prior
    FROM public.fx_revaluation_runs
   WHERE business_id = _business_id
     AND status = 'posted'
     AND reversal_policy = 'next_period'
     AND run_date < _run_date
   ORDER BY run_date DESC LIMIT 1;

  IF _prior.id IS NOT NULL THEN
    _reversal_je := public.reverse_fx_revaluation_run(_prior.id, _run_date, _uid, _run_id);
  END IF;

  FOR _row IN
    SELECT
      jel.account_id,
      upper(je.currency) AS currency,
      SUM(COALESCE(jel.original_debit, jel.debit, 0) - COALESCE(jel.original_credit, jel.credit, 0)) AS foreign_balance,
      SUM(COALESCE(jel.debit,0) - COALESCE(jel.credit,0)) AS base_balance_old
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
    _new_rate := public.resolve_exchange_rate(_org_id, _business_id, _row.currency, _run_date);

    IF _new_rate IS NULL OR _new_rate <= 0 THEN
      UPDATE public.fx_revaluation_runs
         SET status = 'failed',
             notes = 'No exchange rate on file for ' || _row.currency || ' → '
                     || upper(_base_currency) || ' as of ' || _run_date
       WHERE id = _run_id;
      RAISE EXCEPTION 'FX revaluation aborted: no exchange rate on file for % → % as of %',
        _row.currency, upper(_base_currency), _run_date
        USING ERRCODE = '23514';
    END IF;

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

    -- Unrealized FX belongs to the legal entity, never to a branch.
    IF _delta > 0 THEN
      _lines := _lines
        || jsonb_build_object('account_id', _row.account_id, 'business_id', _business_id, 'branch_id', NULL,
             'description', 'FX revaluation ' || _row.currency || ' @ ' || _new_rate, 'debit', _delta, 'credit', 0)
        || jsonb_build_object('account_id', _unrealized_gain_account, 'business_id', _business_id, 'branch_id', NULL,
             'description', 'Unrealized FX gain ' || _row.currency, 'debit', 0, 'credit', _delta);
      _line_seq := _line_seq + 2;
      _total_gain := _total_gain + _delta;
    ELSE
      _lines := _lines
        || jsonb_build_object('account_id', _unrealized_loss_account, 'business_id', _business_id, 'branch_id', NULL,
             'description', 'Unrealized FX loss ' || _row.currency, 'debit', ABS(_delta), 'credit', 0)
        || jsonb_build_object('account_id', _row.account_id, 'business_id', _business_id, 'branch_id', NULL,
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
    RETURN jsonb_build_object('success', true, 'run_id', _run_id, 'lines', 0,
      'fiscal_period_id', _period.id, 'reversal_journal_entry_id', _reversal_je,
      'message', 'No FX deltas to post');
  END IF;

  -- ADR-0146: the posting engine is the only journal numberer.
  _je_id := public.post_journal_entry_atomic(
    _org_id, _business_id, NULL, _run_date,
    NULL,
    'Unrealized FX revaluation as of ' || _run_date,
    'fx_revaluation', _run_id, _uid, false, true,
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
    'fiscal_period_id', _period.id,
    'reversed_run_id', _prior.id,
    'reversal_journal_entry_id', _reversal_je,
    'lines', _line_seq,
    'unrealized_gain', _total_gain,
    'unrealized_loss', _total_loss,
    'net_delta', _net_delta,
    'reversal_policy', 'next_period'
  );
END;
$fn$;