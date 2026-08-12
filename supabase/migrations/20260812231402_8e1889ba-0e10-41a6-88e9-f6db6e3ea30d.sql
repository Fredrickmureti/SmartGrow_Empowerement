-- Step F: bind revaluation runs to fiscal periods, auto-reverse prior period,
-- guard period close. ADR 0136 (one FX engine, no silent 1:1).

ALTER TABLE public.fx_revaluation_runs
  ADD COLUMN IF NOT EXISTS fiscal_period_id uuid REFERENCES public.fiscal_periods(id),
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by_run_id uuid REFERENCES public.fx_revaluation_runs(id);

CREATE UNIQUE INDEX IF NOT EXISTS fx_revaluation_runs_one_open_per_period
  ON public.fx_revaluation_runs (business_id, fiscal_period_id)
  WHERE status = 'posted' AND fiscal_period_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS fx_revaluation_runs_business_date_idx
  ON public.fx_revaluation_runs (business_id, run_date DESC);

-- ---------------------------------------------------------------------------
-- Readiness: which foreign monetary balances still need revaluing as of a date
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fx_revaluation_readiness(
  _business_id uuid,
  _as_of date
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org_id uuid;
  _base text;
  _period public.fiscal_periods;
  _balances jsonb := '[]'::jsonb;
  _missing jsonb := '[]'::jsonb;
  _row record;
  _rate numeric;
  _run public.fx_revaluation_runs;
BEGIN
  SELECT organization_id, upper(COALESCE(base_currency, default_currency))
    INTO _org_id, _base
    FROM public.businesses WHERE id = _business_id;
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'Business % not found', _business_id USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.user_can_access_business(auth.uid(), _business_id) THEN
    RAISE EXCEPTION 'Not authorized for this business' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _period
    FROM public.fiscal_periods
   WHERE business_id = _business_id
     AND _as_of BETWEEN start_date AND end_date
   ORDER BY start_date DESC LIMIT 1;

  IF _period.id IS NOT NULL THEN
    SELECT * INTO _run
      FROM public.fx_revaluation_runs
     WHERE business_id = _business_id
       AND fiscal_period_id = _period.id
       AND status = 'posted'
     ORDER BY run_date DESC LIMIT 1;
  END IF;

  FOR _row IN
    SELECT upper(je.currency) AS currency,
           SUM(COALESCE(jel.original_debit, jel.debit, 0) - COALESCE(jel.original_credit, jel.credit, 0)) AS foreign_balance,
           COUNT(DISTINCT jel.account_id) AS account_count
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      JOIN public.accounts a ON a.id = jel.account_id
     WHERE je.business_id = _business_id
       AND je.status = 'posted'
       AND je.entry_date <= _as_of
       AND je.currency IS NOT NULL
       AND upper(je.currency) <> _base
       AND a.account_type IN ('asset','liability')
     GROUP BY upper(je.currency)
    HAVING ABS(SUM(COALESCE(jel.original_debit, jel.debit, 0) - COALESCE(jel.original_credit, jel.credit, 0))) > 0.01
  LOOP
    _rate := public.resolve_exchange_rate(_org_id, _business_id, _row.currency, _as_of);
    _balances := _balances || jsonb_build_object(
      'currency', _row.currency,
      'foreign_balance', _row.foreign_balance,
      'account_count', _row.account_count,
      'rate', _rate
    );
    IF _rate IS NULL OR _rate <= 0 THEN
      _missing := _missing || to_jsonb(_row.currency);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'base_currency', _base,
    'as_of', _as_of,
    'fiscal_period_id', _period.id,
    'fiscal_period_name', _period.name,
    'fiscal_period_status', _period.status,
    'foreign_balances', _balances,
    'missing_rates', _missing,
    'needs_revaluation', (jsonb_array_length(_balances) > 0 AND _run.id IS NULL),
    'last_run_id', _run.id,
    'last_run_date', _run.run_date
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fx_revaluation_readiness(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fx_revaluation_readiness(uuid, date) TO authenticated;

-- ---------------------------------------------------------------------------
-- Reverse a posted revaluation run's journal entry (exact mirror of its lines)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reverse_fx_revaluation_run(
  _run_id uuid,
  _reversal_date date,
  _user_id uuid DEFAULT NULL,
  _next_run_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _run public.fx_revaluation_runs;
  _lines jsonb := '[]'::jsonb;
  _l record;
  _je_id uuid;
  _je_number text;
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
    -- nil run (no deltas): nothing to reverse, just close it out
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

  _je_number := 'FXR-' || to_char(_reversal_date, 'YYYYMMDD') || '-' || upper(substr(gen_random_uuid()::text, 1, 6));

  _je_id := public.post_journal_entry_atomic(
    _run.organization_id, _run.business_id, _je_number, _reversal_date,
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
$function$;

REVOKE ALL ON FUNCTION public.reverse_fx_revaluation_run(uuid, date, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_fx_revaluation_run(uuid, date, uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Revaluation engine: permissioned, period-bound, self-reversing
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revalue_fx_balances(
  _business_id uuid,
  _run_date date,
  _base_currency text,
  _unrealized_gain_account uuid,
  _unrealized_loss_account uuid,
  _user_id uuid DEFAULT NULL::uuid
) RETURNS jsonb
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

  -- Period binding: a run belongs to exactly one open fiscal period.
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

  -- Unrealized amounts never accumulate: the prior posted run is reversed as of
  -- this run date before the new valuation is posted.
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
    RETURN jsonb_build_object('success', true, 'run_id', _run_id, 'lines', 0,
      'fiscal_period_id', _period.id, 'reversal_journal_entry_id', _reversal_je,
      'message', 'No FX deltas to post');
  END IF;

  _je_number := 'FX-' || to_char(_run_date, 'YYYYMMDD') || '-' || upper(substr(gen_random_uuid()::text, 1, 6));

  _je_id := public.post_journal_entry_atomic(
    _org_id, _business_id, _je_number, _run_date,
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
$function$;

-- ---------------------------------------------------------------------------
-- Period close: refuse while foreign balances are unrevalued
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.close_fiscal_period(_period_id uuid, _notes text DEFAULT NULL::text)
RETURNS fiscal_periods
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_period public.fiscal_periods;
  v_uid    uuid := auth.uid();
  v_readiness jsonb;
BEGIN
  SELECT * INTO v_period FROM public.fiscal_periods WHERE id = _period_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fiscal period not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.has_finance_permission(v_uid, 'finance.manage_periods', v_period.business_id) THEN
    RAISE EXCEPTION 'You do not have permission to close fiscal periods for this business'
      USING ERRCODE = '42501';
  END IF;

  -- ADR 0136: a period cannot close with unvalued foreign monetary balances.
  v_readiness := public.fx_revaluation_readiness(v_period.business_id, v_period.end_date);
  IF COALESCE((v_readiness->>'needs_revaluation')::boolean, false) THEN
    RAISE EXCEPTION 'Period % has foreign-currency balances that have not been revalued. Run FX revaluation as of % first.',
      v_period.name, v_period.end_date
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.fiscal_periods
     SET status     = 'closed',
         locked_at  = now(),
         locked_by  = v_uid,
         notes      = COALESCE(_notes, notes)
   WHERE id = _period_id
   RETURNING * INTO v_period;

  RETURN v_period;
END;
$function$;