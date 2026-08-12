
-- Step A + B: AP stampers converge on fx_stamp_document; no silent 1:1 fallback.

CREATE OR REPLACE FUNCTION public._tg_stamp_bill_currency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE s record;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.currency IS DISTINCT FROM OLD.currency
          OR NEW.currency_rate IS DISTINCT FROM OLD.currency_rate)
     AND public._fx_document_is_posted('bill', OLD.id) THEN
    RAISE EXCEPTION 'Currency and rate of a posted bill are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT'
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.bill_date IS DISTINCT FROM OLD.bill_date
     OR NEW.currency_rate IS NULL
     OR NEW.currency_rate = 0 THEN
    SELECT * INTO s FROM public.fx_stamp_document(
      NEW.organization_id, NEW.business_id, NEW.currency, NEW.bill_date);
    NEW.currency := s.currency;
    NEW.currency_rate := s.rate;
  END IF;

  NEW.company_currency_total := ROUND(COALESCE(NEW.total, 0) * NEW.currency_rate, 2);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public._tg_stamp_vcn_currency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s record;
  v_date date;
BEGIN
  v_date := COALESCE(NEW.exchange_rate_date, NEW.credit_note_date, CURRENT_DATE);

  IF TG_OP = 'UPDATE'
     AND (NEW.currency IS DISTINCT FROM OLD.currency
          OR NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate)
     AND public._fx_document_is_posted('vendor_credit_note', OLD.id) THEN
    RAISE EXCEPTION 'Currency and rate of a posted vendor credit note are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT'
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR v_date IS DISTINCT FROM COALESCE(OLD.exchange_rate_date, OLD.credit_note_date)
     OR NEW.exchange_rate IS NULL
     OR NEW.exchange_rate = 0 THEN
    SELECT * INTO s FROM public.fx_stamp_document(
      NEW.organization_id, NEW.business_id, NEW.currency, v_date);
    NEW.currency := s.currency;
    NEW.exchange_rate := s.rate;
    NEW.exchange_rate_date := v_date;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public._tg_stamp_purchase_return_currency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE s record;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.currency IS DISTINCT FROM OLD.currency
          OR NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate)
     AND public._fx_document_is_posted('purchase_return', OLD.id) THEN
    RAISE EXCEPTION 'Currency and rate of a posted purchase return are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT'
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.return_date IS DISTINCT FROM OLD.return_date
     OR NEW.exchange_rate IS NULL
     OR NEW.exchange_rate = 0 THEN
    SELECT * INTO s FROM public.fx_stamp_document(
      NEW.organization_id, NEW.business_id, NEW.currency, NEW.return_date);
    NEW.currency := s.currency;
    NEW.exchange_rate := s.rate;
  END IF;

  RETURN NEW;
END;
$$;

-- Purchase orders: also re-stamp when the order date moves.
CREATE OR REPLACE FUNCTION public._tg_stamp_po_currency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE s record;
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.order_date IS DISTINCT FROM OLD.order_date
     OR NEW.exchange_rate IS NULL
     OR NEW.exchange_rate = 0 THEN
    SELECT * INTO s FROM public.fx_stamp_document(
      NEW.organization_id, NEW.business_id, NEW.currency, NEW.order_date);
    NEW.currency := s.currency;
    NEW.exchange_rate := s.rate;
  END IF;
  RETURN NEW;
END;
$$;

-- Step C: revaluation resolves through the one resolver and never skips silently.

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
SET search_path = public
AS $$
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
    -- One resolver: override > manual > provider (ADR 0136). A missing rate is
    -- an explicit failure, never a silently skipped balance.
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
$$;
