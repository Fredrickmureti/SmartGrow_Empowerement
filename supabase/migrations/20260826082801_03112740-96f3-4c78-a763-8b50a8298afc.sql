-- =====================================================================
-- Phase 9.1 — revaluation concurrency (D15)
-- =====================================================================

CREATE OR REPLACE FUNCTION public._fx_reval_lock_key(_business_id uuid, _scope text)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT hashtextextended('fx_reval:' || _business_id::text || ':' || COALESCE(_scope, '-'), 0);
$$;

COMMENT ON FUNCTION public._fx_reval_lock_key(uuid, text) IS
  'Advisory-lock key for FX revaluation. Scope is the fiscal period id, or the run date when the company has no period for that date.';

-- One posted run per (business, run_date) when no fiscal period exists.
CREATE UNIQUE INDEX IF NOT EXISTS fx_revaluation_runs_one_posted_per_date
  ON public.fx_revaluation_runs (business_id, run_date)
  WHERE status = 'posted' AND fiscal_period_id IS NULL;

CREATE OR REPLACE FUNCTION public.revalue_fx_balances(_business_id uuid, _run_date date, _base_currency text DEFAULT NULL::text, _unrealized_gain_account uuid DEFAULT NULL::uuid, _unrealized_loss_account uuid DEFAULT NULL::uuid, _user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  _entity_base text;
  _resolved_gain uuid;
  _resolved_loss uuid;
BEGIN
  SELECT organization_id INTO _org_id FROM public.businesses WHERE id = _business_id;
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'Business % not found', _business_id USING ERRCODE = 'P0002';
  END IF;

  IF _uid IS NULL OR NOT public.has_finance_permission(_uid, 'finance.manage_periods', _business_id) THEN
    RAISE EXCEPTION 'You do not have permission to run FX revaluation for this business'
      USING ERRCODE = '42501';
  END IF;

  -- The reporting currency is a property of the legal entity, never of the caller.
  SELECT upper(base_currency) INTO _entity_base FROM public.businesses WHERE id = _business_id;
  IF _entity_base IS NULL THEN
    RAISE EXCEPTION 'Business % has no base currency configured', _business_id USING ERRCODE = '23514';
  END IF;
  IF _base_currency IS NOT NULL AND upper(_base_currency) <> _entity_base THEN
    RAISE EXCEPTION 'Base currency % does not match this company''s books (%)', upper(_base_currency), _entity_base
      USING ERRCODE = '23514';
  END IF;
  _base_currency := _entity_base;

  -- FX result accounts come from the central mapping, not from the caller.
  _resolved_gain := public.resolve_fx_unrealized_account(_business_id, 'gain');
  _resolved_loss := public.resolve_fx_unrealized_account(_business_id, 'loss');
  IF _unrealized_gain_account IS NOT NULL AND _unrealized_gain_account <> _resolved_gain THEN
    RAISE EXCEPTION 'Unrealized FX gain account is set in Default Accounts and cannot be overridden per run'
      USING ERRCODE = '23514';
  END IF;
  IF _unrealized_loss_account IS NOT NULL AND _unrealized_loss_account <> _resolved_loss THEN
    RAISE EXCEPTION 'Unrealized FX loss account is set in Default Accounts and cannot be overridden per run'
      USING ERRCODE = '23514';
  END IF;
  _unrealized_gain_account := _resolved_gain;
  _unrealized_loss_account := _resolved_loss;

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

  -- D15: a run and a reversal must never interleave. Locks are transaction
  -- scoped and taken in a fixed order (company, then period/date scope) so
  -- concurrent callers cannot deadlock. Contention is refused, never queued.
  IF NOT pg_try_advisory_xact_lock(public._fx_reval_lock_key(_business_id, NULL)) THEN
    RAISE EXCEPTION 'A revaluation is already running for this company. Wait for it to finish before starting another.'
      USING ERRCODE = '55P03';
  END IF;
  IF NOT pg_try_advisory_xact_lock(
        public._fx_reval_lock_key(_business_id, COALESCE(_period.id::text, _run_date::text))) THEN
    RAISE EXCEPTION 'A revaluation is already running for this company and period. Wait for it to finish before starting another.'
      USING ERRCODE = '55P03';
  END IF;

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

  -- Period-less runs get the same guard, keyed on the run date.
  IF _period.id IS NULL AND EXISTS (
    SELECT 1 FROM public.fx_revaluation_runs
     WHERE business_id = _business_id AND fiscal_period_id IS NULL
       AND run_date = _run_date AND status = 'posted'
  ) THEN
    RAISE EXCEPTION 'A posted FX revaluation already exists for %. Reverse it before running again.', _run_date
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
      upper(COALESCE(jel.original_currency, je.currency)) AS currency,
      SUM(COALESCE(jel.original_debit, jel.debit, 0) - COALESCE(jel.original_credit, jel.credit, 0)) AS foreign_balance,
      SUM(COALESCE(jel.debit,0) - COALESCE(jel.credit,0)) AS base_balance_old
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.accounts a ON a.id = jel.account_id
    WHERE je.business_id = _business_id
      AND je.status = 'posted'
      AND je.entry_date <= _run_date
      AND COALESCE(jel.original_currency, je.currency) IS NOT NULL
      AND upper(COALESCE(jel.original_currency, je.currency)) <> upper(_base_currency)
      AND public.fx_is_monetary_account(a.account_type::text, a.detail_type::text)
    GROUP BY jel.account_id, upper(COALESCE(jel.original_currency, je.currency))
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
$function$;

CREATE OR REPLACE FUNCTION public.reverse_fx_revaluation_run(_run_id uuid, _reversal_date date, _user_id uuid DEFAULT NULL::uuid, _next_run_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _run public.fx_revaluation_runs;
  _lines jsonb := '[]'::jsonb;
  _l record;
  _je_id uuid;
  _uid uuid := COALESCE(auth.uid(), _user_id);
BEGIN
  SELECT * INTO _run FROM public.fx_revaluation_runs WHERE id = _run_id;
  IF _run.id IS NULL THEN
    RAISE EXCEPTION 'FX revaluation run % not found', _run_id USING ERRCODE = 'P0002';
  END IF;

  -- Authorisation is derived from the run's own business, not from any argument.
  IF auth.uid() IS NOT NULL
     AND NOT public.has_finance_permission(_uid, 'finance.manage_periods', _run.business_id) THEN
    RAISE EXCEPTION 'You do not have permission to reverse FX revaluation for this business'
      USING ERRCODE = '42501';
  END IF;

  -- D15: same lock keys, same order as revalue_fx_balances. Re-acquiring is a
  -- no-op when this reversal is nested inside a run in the same transaction.
  IF NOT pg_try_advisory_xact_lock(public._fx_reval_lock_key(_run.business_id, NULL)) THEN
    RAISE EXCEPTION 'A revaluation is already running for this company. Wait for it to finish before reversing.'
      USING ERRCODE = '55P03';
  END IF;
  IF NOT pg_try_advisory_xact_lock(
        public._fx_reval_lock_key(_run.business_id, COALESCE(_run.fiscal_period_id::text, _run.run_date::text))) THEN
    RAISE EXCEPTION 'A revaluation is already running for this company and period. Wait for it to finish before reversing.'
      USING ERRCODE = '55P03';
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
$function$;

-- =====================================================================
-- Phase 9.2 — organization-scoped rate visibility (S2)
-- Read only. Writes stay finance-manager gated by exchange_rates_insert.
-- =====================================================================

DROP POLICY IF EXISTS exchange_rates_select ON public.exchange_rates;
CREATE POLICY exchange_rates_select ON public.exchange_rates
  FOR SELECT TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    OR (business_id IS NULL AND public.is_org_member(auth.uid(), organization_id))
  );

-- =====================================================================
-- Phase 9.3 — the four unstamped tables
-- =====================================================================

-- expenses: a foreign-currency accounting event. The rate is already stamped
-- server-side by _expenses_derive_base_amount (require_exchange_rate, no
-- parity fallback); what was missing is posted-immutability.
CREATE OR REPLACE FUNCTION public._tg_expenses_fx_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF OLD.status IN ('approved','paid')
     AND (NEW.currency IS DISTINCT FROM OLD.currency
          OR NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate
          OR NEW.expense_date IS DISTINCT FROM OLD.expense_date
          OR NEW.amount IS DISTINCT FROM OLD.amount) THEN
    RAISE EXCEPTION 'Currency, rate, date and amount of an approved or paid expense are immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

-- Name sorts before trg_expenses_base_amount so the guard sees the values the
-- caller actually sent, not the re-derived ones.
DROP TRIGGER IF EXISTS trg_expenses_a_fx_immutable ON public.expenses;
CREATE TRIGGER trg_expenses_a_fx_immutable
  BEFORE UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public._tg_expenses_fx_immutable();

-- pos_payment_sessions: the rate is resolved by pos_payment_session_open and
-- is documented as immutable for the life of the session. Enforce it.
CREATE OR REPLACE FUNCTION public._tg_pos_session_fx_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.settlement_currency IS DISTINCT FROM OLD.settlement_currency
     OR NEW.fx_rate IS DISTINCT FROM OLD.fx_rate THEN
    RAISE EXCEPTION 'Currency, settlement currency and rate of a payment session are immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_pos_sessions_a_fx_immutable ON public.pos_payment_sessions;
CREATE TRIGGER trg_pos_sessions_a_fx_immutable
  BEFORE UPDATE ON public.pos_payment_sessions
  FOR EACH ROW EXECUTE FUNCTION public._tg_pos_session_fx_immutable();

-- project cost / revenue entries: directly writable by project financial
-- managers, so the rate must be server-owned on every write path, not only
-- inside upsert_project_cost/upsert_project_revenue. A missing rate stays an
-- absence (fx_rate and amount_base both NULL) — never parity.
CREATE OR REPLACE FUNCTION public._tg_stamp_project_entry_currency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_base text;
  v_rate numeric;
  v_on_date date;
BEGIN
  SELECT upper(b.base_currency) INTO v_base FROM public.businesses b WHERE b.id = NEW.business_id;
  NEW.currency := COALESCE(public.normalize_currency_code(NEW.currency), v_base);
  NEW.base_currency := v_base;
  v_on_date := COALESCE(NEW.posted_at, now())::date;

  IF v_base IS NULL THEN
    v_rate := NULL;
  ELSIF NEW.currency = v_base THEN
    v_rate := 1;
  ELSE
    v_rate := public.resolve_exchange_rate(
      NEW.organization_id, NEW.business_id, NEW.currency, v_on_date);
  END IF;

  IF v_rate IS NOT NULL AND v_rate <= 0 THEN
    v_rate := NULL;
  END IF;

  NEW.fx_rate := v_rate;
  NEW.amount_base := CASE WHEN v_rate IS NULL THEN NULL
                          ELSE ROUND(COALESCE(NEW.amount, 0) * v_rate, 2) END;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_project_cost_entries_stamp_currency ON public.project_cost_entries;
CREATE TRIGGER trg_project_cost_entries_stamp_currency
  BEFORE INSERT OR UPDATE ON public.project_cost_entries
  FOR EACH ROW EXECUTE FUNCTION public._tg_stamp_project_entry_currency();

DROP TRIGGER IF EXISTS trg_project_revenue_entries_stamp_currency ON public.project_revenue_entries;
CREATE TRIGGER trg_project_revenue_entries_stamp_currency
  BEFORE INSERT OR UPDATE ON public.project_revenue_entries
  FOR EACH ROW EXECUTE FUNCTION public._tg_stamp_project_entry_currency();

ALTER TABLE public.project_cost_entries
  DROP CONSTRAINT IF EXISTS project_cost_entries_rate_absence_ck;
ALTER TABLE public.project_cost_entries
  ADD CONSTRAINT project_cost_entries_rate_absence_ck
  CHECK ((fx_rate IS NULL) = (amount_base IS NULL) AND (fx_rate IS NULL OR fx_rate > 0)) NOT VALID;

ALTER TABLE public.project_revenue_entries
  DROP CONSTRAINT IF EXISTS project_revenue_entries_rate_absence_ck;
ALTER TABLE public.project_revenue_entries
  ADD CONSTRAINT project_revenue_entries_rate_absence_ck
  CHECK ((fx_rate IS NULL) = (amount_base IS NULL) AND (fx_rate IS NULL OR fx_rate > 0)) NOT VALID;

-- =====================================================================
-- Phase 9.4 — currency-disable guard (deactivation only, never deletion)
-- =====================================================================

CREATE OR REPLACE FUNCTION public.set_business_active_currency(p_business_id uuid, p_currency text, p_enabled boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid;
  v_base text;
  v_code text;
  v_blocker text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.user_can_access_business(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'Not authorised for this company' USING ERRCODE = '42501';
  END IF;

  SELECT organization_id, upper(base_currency) INTO v_org, v_base
    FROM public.businesses WHERE id = p_business_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Business % not found', p_business_id;
  END IF;

  v_code := public.normalize_currency_code(p_currency);
  IF v_code IS NULL OR NOT EXISTS (SELECT 1 FROM public.currencies WHERE code = v_code AND is_active) THEN
    RAISE EXCEPTION 'Unknown or inactive currency code' USING ERRCODE = '22023';
  END IF;

  IF v_code = v_base AND NOT p_enabled THEN
    RAISE EXCEPTION 'The base currency of a company cannot be disabled' USING ERRCODE = '22023';
  END IF;

  -- A currency still carrying live financial state cannot be deactivated:
  -- reports, revaluation and settlement all depend on it remaining available.
  IF NOT p_enabled THEN
    IF EXISTS (
      SELECT 1 FROM public.invoices i
       WHERE i.business_id = p_business_id
         AND upper(i.currency) = v_code
         AND i.status IN ('sent','viewed','partial','overdue','confirmed')
    ) THEN
      v_blocker := 'open customer invoices';
    ELSIF EXISTS (
      SELECT 1 FROM public.bills b
       WHERE b.business_id = p_business_id
         AND upper(b.currency) = v_code
         AND b.status IN ('received','partial','overdue','submitted','approved')
    ) THEN
      v_blocker := 'open supplier bills';
    ELSIF EXISTS (
      SELECT 1 FROM public.bank_accounts ba
       WHERE ba.business_id = p_business_id
         AND upper(ba.currency) = v_code
    ) THEN
      v_blocker := 'a bank account';
    ELSIF EXISTS (
      SELECT 1 FROM public.invoices i
       WHERE i.business_id = p_business_id
         AND upper(i.currency) = v_code AND i.status = 'draft'
    ) OR EXISTS (
      SELECT 1 FROM public.bills b
       WHERE b.business_id = p_business_id
         AND upper(b.currency) = v_code AND b.status = 'draft'
    ) THEN
      v_blocker := 'unposted drafts';
    END IF;

    IF v_blocker IS NOT NULL THEN
      RAISE EXCEPTION '% still has % in this company. Settle or reassign them before switching % off.',
        v_code, v_blocker, v_code
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- The base currency is always present and enabled, so enabling a first
  -- foreign currency can never lock the company out of its own base currency.
  IF v_base IS NOT NULL THEN
    INSERT INTO public.business_active_currencies (organization_id, business_id, currency_code, is_enabled, created_by)
    VALUES (v_org, p_business_id, v_base, true, auth.uid())
    ON CONFLICT (business_id, currency_code) DO UPDATE SET is_enabled = true;
  END IF;

  INSERT INTO public.business_active_currencies (organization_id, business_id, currency_code, is_enabled, created_by)
  VALUES (v_org, p_business_id, v_code, p_enabled, auth.uid())
  ON CONFLICT (business_id, currency_code) DO UPDATE SET is_enabled = EXCLUDED.is_enabled;
END;
$function$;