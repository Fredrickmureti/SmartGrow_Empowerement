-- Complete finance accounting engine hardening: FX revaluation and unreconcile lifecycle.

-- 1) Add explicit FX run accounting controls and audit links.
ALTER TABLE public.fx_revaluation_runs
  ADD COLUMN IF NOT EXISTS journal_book_id uuid REFERENCES public.journal_books(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS unrealized_gain_account_id uuid REFERENCES public.accounts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS unrealized_loss_account_id uuid REFERENCES public.accounts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS reversal_policy text NOT NULL DEFAULT 'next_period',
  ADD COLUMN IF NOT EXISTS reversal_journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fx_revaluation_runs_reversal_policy_check'
      AND conrelid = 'public.fx_revaluation_runs'::regclass
  ) THEN
    ALTER TABLE public.fx_revaluation_runs
      ADD CONSTRAINT fx_revaluation_runs_reversal_policy_check
      CHECK (reversal_policy IN ('none','next_period','next_run'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_fx_runs_journal_book ON public.fx_revaluation_runs(journal_book_id);
CREATE INDEX IF NOT EXISTS idx_fx_runs_gain_loss_accounts ON public.fx_revaluation_runs(unrealized_gain_account_id, unrealized_loss_account_id);

-- 2) Validate FX run scope against business-owned books/accounts.
CREATE OR REPLACE FUNCTION public.validate_fx_revaluation_run_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _book_business uuid;
  _gain_business uuid;
  _loss_business uuid;
  _reversal_business uuid;
BEGIN
  IF NEW.journal_book_id IS NOT NULL THEN
    SELECT business_id INTO _book_business FROM public.journal_books WHERE id = NEW.journal_book_id;
    IF _book_business IS DISTINCT FROM NEW.business_id THEN
      RAISE EXCEPTION 'FX revaluation journal book belongs to a different business';
    END IF;
  END IF;

  IF NEW.unrealized_gain_account_id IS NOT NULL THEN
    SELECT business_id INTO _gain_business FROM public.accounts WHERE id = NEW.unrealized_gain_account_id;
    IF _gain_business IS DISTINCT FROM NEW.business_id THEN
      RAISE EXCEPTION 'FX gain account belongs to a different business';
    END IF;
  END IF;

  IF NEW.unrealized_loss_account_id IS NOT NULL THEN
    SELECT business_id INTO _loss_business FROM public.accounts WHERE id = NEW.unrealized_loss_account_id;
    IF _loss_business IS DISTINCT FROM NEW.business_id THEN
      RAISE EXCEPTION 'FX loss account belongs to a different business';
    END IF;
  END IF;

  IF NEW.reversal_journal_entry_id IS NOT NULL THEN
    SELECT business_id INTO _reversal_business FROM public.journal_entries WHERE id = NEW.reversal_journal_entry_id;
    IF _reversal_business IS DISTINCT FROM NEW.business_id THEN
      RAISE EXCEPTION 'FX reversal journal entry belongs to a different business';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fx_revaluation_runs_validate_scope ON public.fx_revaluation_runs;
CREATE TRIGGER trg_fx_revaluation_runs_validate_scope
  BEFORE INSERT OR UPDATE ON public.fx_revaluation_runs
  FOR EACH ROW EXECUTE FUNCTION public.validate_fx_revaluation_run_scope();

-- 3) Missing FX revaluation RPC.
CREATE OR REPLACE FUNCTION public.revalue_fx_balances(
  _business_id uuid,
  _run_date date,
  _base_currency text,
  _unrealized_gain_account uuid,
  _unrealized_loss_account uuid,
  _user_id uuid DEFAULT NULL
)
RETURNS jsonb
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

  _je_number := 'FX-' || to_char(_run_date, 'YYYYMMDD') || '-' || upper(substr(gen_random_uuid()::text, 1, 6));

  INSERT INTO public.journal_entries (
    organization_id, business_id, entry_number, entry_date, description,
    status, source_type, source_id, posted_at, posted_by, created_by,
    is_adjusting, is_adjusting_entry, total_debit, total_credit, journal_book_id,
    currency, exchange_rate
  ) VALUES (
    _org_id, _business_id, _je_number, _run_date,
    'Unrealized FX revaluation as of ' || _run_date,
    'draft', 'fx_revaluation', _run_id, NULL, NULL, _user_id,
    true, true, 0, 0, _fx_book_id,
    upper(_base_currency), 1
  ) RETURNING id INTO _je_id;

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
      INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, business_id, branch_id, description, debit, credit, sort_order)
      VALUES (_je_id, _row.account_id, _business_id, _row.branch_id, 'FX revaluation ' || _row.currency || ' @ ' || _new_rate, _delta, 0, _line_seq);
      _line_seq := _line_seq + 1;
      INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, business_id, branch_id, description, debit, credit, sort_order)
      VALUES (_je_id, _unrealized_gain_account, _business_id, _row.branch_id, 'Unrealized FX gain ' || _row.currency, 0, _delta, _line_seq);
      _line_seq := _line_seq + 1;
      _total_gain := _total_gain + _delta;
    ELSE
      INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, business_id, branch_id, description, debit, credit, sort_order)
      VALUES (_je_id, _unrealized_loss_account, _business_id, _row.branch_id, 'Unrealized FX loss ' || _row.currency, ABS(_delta), 0, _line_seq);
      _line_seq := _line_seq + 1;
      INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, business_id, branch_id, description, debit, credit, sort_order)
      VALUES (_je_id, _row.account_id, _business_id, _row.branch_id, 'FX revaluation ' || _row.currency || ' @ ' || _new_rate, 0, ABS(_delta), _line_seq);
      _line_seq := _line_seq + 1;
      _total_loss := _total_loss + ABS(_delta);
    END IF;
    _net_delta := _net_delta + _delta;
  END LOOP;

  IF _line_seq = 0 THEN
    DELETE FROM public.journal_entries WHERE id = _je_id;
    UPDATE public.fx_revaluation_runs
       SET status = 'posted', total_unrealized_gain = 0, total_unrealized_loss = 0, journal_entry_id = NULL
     WHERE id = _run_id;
    RETURN jsonb_build_object('success', true, 'run_id', _run_id, 'lines', 0, 'message', 'No FX deltas to post');
  END IF;

  UPDATE public.journal_entries
     SET status = 'posted', posted_at = now(), posted_by = _user_id,
         total_debit = (SELECT COALESCE(SUM(debit),0) FROM public.journal_entry_lines WHERE journal_entry_id = _je_id),
         total_credit = (SELECT COALESCE(SUM(credit),0) FROM public.journal_entry_lines WHERE journal_entry_id = _je_id)
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

REVOKE ALL ON FUNCTION public.revalue_fx_balances(uuid, date, text, uuid, uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.revalue_fx_balances(uuid, date, text, uuid, uuid, uuid) TO authenticated;

-- 4) Durable unreconcile RPC: no destructive deletion of imported bank rows.
CREATE OR REPLACE FUNCTION public.unreconcile_bank_transaction(
  _bank_transaction_id uuid,
  _reason text DEFAULT NULL,
  _user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _txn record;
  _reversed_matches integer := 0;
  _reversed_writeoffs integer := 0;
BEGIN
  SELECT * INTO _txn FROM public.bank_transactions WHERE id = _bank_transaction_id FOR UPDATE;
  IF _txn.id IS NULL THEN
    RAISE EXCEPTION 'Bank transaction % not found', _bank_transaction_id;
  END IF;

  UPDATE public.bank_reconciliation_matches
     SET status = 'reversed', reversed_by = _user_id, reversed_at = now(),
         notes = trim(both from concat_ws(' | ', notes, 'Unreconciled: ' || COALESCE(_reason, 'No reason provided'))),
         updated_at = now()
   WHERE bank_transaction_id = _bank_transaction_id
     AND status IN ('suggested','to_check','confirmed')
   RETURNING 1 INTO _reversed_matches;

  GET DIAGNOSTICS _reversed_matches = ROW_COUNT;

  UPDATE public.bank_reconciliation_writeoffs w
     SET status = 'reversed', reversed_by = _user_id, reversed_at = now(), updated_at = now()
    FROM public.bank_reconciliation_matches m
   WHERE w.reconciliation_match_id = m.id
     AND m.bank_transaction_id = _bank_transaction_id
     AND w.status IN ('draft','posted')
   RETURNING 1 INTO _reversed_writeoffs;

  GET DIAGNOSTICS _reversed_writeoffs = ROW_COUNT;

  UPDATE public.bank_transactions
     SET is_reconciled = false,
         reconciled_type = NULL,
         reconciled_entity_id = NULL,
         reconciled_at = NULL,
         reconciled_by = NULL,
         journal_entry_id = NULL,
         reconciled_payment_id = NULL,
         match_confidence = NULL,
         match_source = 'unreconciled',
         lifecycle_status = 'unreconciled',
         updated_at = now()
   WHERE id = _bank_transaction_id;

  RETURN jsonb_build_object(
    'success', true,
    'bank_transaction_id', _bank_transaction_id,
    'reversed_matches', _reversed_matches,
    'reversed_writeoffs', _reversed_writeoffs,
    'reason', _reason
  );
END;
$$;

REVOKE ALL ON FUNCTION public.unreconcile_bank_transaction(uuid, text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.unreconcile_bank_transaction(uuid, text, uuid) TO authenticated;