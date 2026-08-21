-- Unrealized FX revaluation behaviour (ADR 0123 / 0135 / 0136 / 0146, IAS 21).
--
-- The lifecycle suite proves *shape* from the catalog. This suite proves
-- *behaviour*: it seeds a real foreign-currency monetary balance, runs the
-- engine, and asserts the ledger truth, the refusals and the reversal.
--
--   1) A run posts a balanced journal; both legs hit the resolved unrealized
--      gain/loss accounts and carry branch_id NULL (entity-level, ADR 0136).
--   2) The delta equals foreign_balance x (new_rate - old_rate), to the cent.
--   3) A second run in the same fiscal period is refused with 23505.
--   4) A run into a non-open fiscal period is refused with 23514.
--   5) A currency with no rate on file aborts the run and marks it `failed`
--      with legible notes — never a 1:1 fallback.
--   6) reverse_fx_revaluation_run reverses a prior `next_period` run exactly
--      once and the pair nets to zero on the revalued account.
--   7) Non-monetary balances (inventory, fixed assets, deferred revenue) are
--      out of scope while AR / AP / bank in the same currency are in scope.
--
-- Everything runs inside a nested block that aborts on success, so no row the
-- fixture writes survives the run. Set the two fixture identifiers below for
-- the environment under test.
DO $outer$
DECLARE
  c_org  uuid := '8e682296-c634-44c8-ae00-bc48940ec28b';
  c_biz  uuid := 'bf392ca6-a743-435c-ae41-5bf25199470d';
  c_uid  uuid;
  c_base text;
  c_gain uuid;
  c_loss uuid;
  c_ar   uuid;
  c_inv  uuid;
  d_run  date := CURRENT_DATE;
  v_rate_old numeric := 100;
  v_rate_new numeric := 110;
  v_je uuid;
  v_run jsonb;
  v_run_id uuid;
  v_rev_je uuid;
  v_period uuid;
  v_expected numeric;
  v_gain_net numeric;
  v_ar_net numeric;
  v_branchy int;
  v_state text;
  v_notes text;
  v_lines int;
  v_report text := '';
  v_sqlstate text;
BEGIN
  SELECT upper(base_currency) INTO c_base FROM public.businesses WHERE id = c_biz;
  c_gain := public.resolve_fx_unrealized_account(c_biz, 'gain');
  c_loss := public.resolve_fx_unrealized_account(c_biz, 'loss');
  c_ar   := public._resolve_canonical_default_account('accounts_receivable', c_org, c_biz, NULL);
  SELECT id INTO c_inv FROM public.accounts
   WHERE business_id = c_biz AND account_type::text = 'asset'
     AND NOT public.fx_is_monetary_account(account_type::text, detail_type::text)
   LIMIT 1;

  -- Any user holding finance.manage_periods on this company can drive the engine.
  SELECT u.user_id INTO c_uid
    FROM (SELECT DISTINCT user_id FROM public.user_roles) u
   WHERE public.has_finance_permission(u.user_id, 'finance.manage_periods', c_biz)
   LIMIT 1;

  IF c_base IS NULL OR c_gain IS NULL OR c_loss IS NULL OR c_ar IS NULL OR c_uid IS NULL THEN
    RAISE NOTICE 'SKIP fx revaluation behaviour: fixture company is not configured in this environment';
    RETURN;
  END IF;

  BEGIN
    -- An open fiscal period covering the run date, if the company keeps periods.
    SELECT id INTO v_period FROM public.fiscal_periods
     WHERE business_id = c_biz AND d_run BETWEEN start_date AND end_date
     ORDER BY start_date DESC LIMIT 1;
    IF v_period IS NOT NULL THEN
      UPDATE public.fiscal_periods SET status = 'open' WHERE id = v_period;
      -- Any earlier posted run in this period would trip the one-run rule.
      UPDATE public.fx_revaluation_runs SET status = 'reversed'
       WHERE business_id = c_biz AND fiscal_period_id = v_period AND status = 'posted';
    END IF;

    -- A monetary AR balance of USD 1,000 booked at 100, plus an equal
    -- non-monetary balance that must stay out of scope.
    INSERT INTO public.exchange_rates
      (organization_id, business_id, from_currency, to_currency, rate, effective_date, source)
    VALUES (c_org, c_biz, 'USD', c_base, v_rate_new, d_run, 'override');

    INSERT INTO public.journal_entries
      (organization_id, business_id, entry_date, description, status, currency, exchange_rate, source_type)
    VALUES (c_org, c_biz, d_run - 5, 'FXREVAL fixture opening balance', 'posted', 'USD', v_rate_old, 'manual')
    RETURNING id INTO v_je;

    INSERT INTO public.journal_entry_lines
      (journal_entry_id, account_id, debit, credit, original_currency, original_debit, original_credit, description)
    VALUES
      (v_je, c_ar, 1000 * v_rate_old, 0, 'USD', 1000, 0, 'FXREVAL monetary AR'),
      (v_je, c_gain, 0, 1000 * v_rate_old, 'USD', 0, 1000, 'FXREVAL contra');

    IF c_inv IS NOT NULL THEN
      INSERT INTO public.journal_entry_lines
        (journal_entry_id, account_id, debit, credit, original_currency, original_debit, original_credit, description)
      VALUES
        (v_je, c_inv, 500 * v_rate_old, 0, 'USD', 500, 0, 'FXREVAL non-monetary'),
        (v_je, c_gain, 0, 500 * v_rate_old, 'USD', 0, 500, 'FXREVAL non-monetary contra');
    END IF;

    -- 5) No rate on file → the run aborts with 23514 and a legible reason,
    --    never a 1:1 fallback. Proven first, on a currency the rate book cannot
    --    possibly know. The failed attempt (including its rateless fixture and
    --    the `failed` run row it stamps) rolls back to this savepoint, which is
    --    also how the engine behaves for a real caller: the abort is total.
    BEGIN
      INSERT INTO public.journal_entries
        (organization_id, business_id, entry_date, description, status, currency, exchange_rate, source_type)
      VALUES (c_org, c_biz, d_run - 5, 'FXREVAL rateless fixture', 'posted', 'XTS', 1, 'manual')
      RETURNING id INTO v_rev_je;
      INSERT INTO public.journal_entry_lines
        (journal_entry_id, account_id, debit, credit, original_currency, original_debit, original_credit, description)
      VALUES (v_rev_je, c_ar, 100, 0, 'XTS', 100, 0, 'FXREVAL rateless'),
             (v_rev_je, c_gain, 0, 100, 'XTS', 0, 100, 'FXREVAL rateless contra');

      v_run := public.revalue_fx_balances(c_biz, d_run, NULL, NULL, NULL, c_uid);
      RAISE EXCEPTION 'FXREVAL_FAIL a currency with no rate on file did not abort the run';
    EXCEPTION WHEN sqlstate '23514' THEN
      IF SQLERRM !~* 'no exchange rate on file' THEN
        RAISE EXCEPTION 'FXREVAL_FAIL rateless run refused for the wrong reason: %', SQLERRM;
      END IF;
      v_report := v_report || 'rateless-aborts ';
    END;



    -- 1/2/7) The run itself.
    v_run := public.revalue_fx_balances(c_biz, d_run, NULL, NULL, NULL, c_uid);
    v_run_id := (v_run->>'run_id')::uuid;
    v_je := (v_run->>'journal_entry_id')::uuid;
    IF v_je IS NULL THEN
      RAISE EXCEPTION 'FXREVAL_FAIL the run posted no journal entry: %', v_run;
    END IF;

    v_expected := round(1000 * (v_rate_new - v_rate_old), 2);

    SELECT COALESCE(SUM(debit), 0) - COALESCE(SUM(credit), 0)
      INTO v_ar_net FROM public.journal_entry_lines
     WHERE journal_entry_id = v_je AND account_id = c_ar;
    SELECT COALESCE(SUM(credit), 0) - COALESCE(SUM(debit), 0)
      INTO v_gain_net FROM public.journal_entry_lines
     WHERE journal_entry_id = v_je AND account_id IN (c_gain, c_loss);
    SELECT count(*) INTO v_branchy FROM public.journal_entry_lines
     WHERE journal_entry_id = v_je AND branch_id IS NOT NULL;

    IF abs(v_ar_net - v_expected) > 0.01 THEN
      RAISE EXCEPTION 'FXREVAL_FAIL AR remeasured by % (expected %)', v_ar_net, v_expected;
    END IF;
    IF abs(v_gain_net - v_expected) > 0.01 THEN
      RAISE EXCEPTION 'FXREVAL_FAIL unrealized result recognised % (expected %)', v_gain_net, v_expected;
    END IF;
    IF v_branchy > 0 THEN
      RAISE EXCEPTION 'FXREVAL_FAIL % revaluation lines carry a branch — unrealized FX is entity-level', v_branchy;
    END IF;
    IF (SELECT COALESCE(SUM(debit), 0) - COALESCE(SUM(credit), 0)
          FROM public.journal_entry_lines WHERE journal_entry_id = v_je) <> 0 THEN
      RAISE EXCEPTION 'FXREVAL_FAIL the revaluation journal does not balance';
    END IF;
    IF c_inv IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.fx_revaluation_lines WHERE run_id = v_run_id AND account_id = c_inv
    ) THEN
      RAISE EXCEPTION 'FXREVAL_FAIL a non-monetary account was revalued (IAS 21)';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.fx_revaluation_lines WHERE run_id = v_run_id AND account_id = c_ar
    ) THEN
      RAISE EXCEPTION 'FXREVAL_FAIL the monetary AR balance was not revalued';
    END IF;
    v_report := v_report || 'posts-balanced-entity-level ';

    -- 3) One posted run per period.
    IF v_period IS NOT NULL THEN
      BEGIN
        PERFORM public.revalue_fx_balances(c_biz, d_run, NULL, NULL, NULL, c_uid);
        RAISE EXCEPTION 'FXREVAL_FAIL a second run in the same period was accepted';
      EXCEPTION WHEN sqlstate '23505' THEN
        v_report := v_report || 'second-run-refused ';
      END;

      -- 4) A closed period refuses the run.
      UPDATE public.fx_revaluation_runs SET status = 'reversed' WHERE id = v_run_id;
      UPDATE public.fiscal_periods SET status = 'closed' WHERE id = v_period;
      BEGIN
        PERFORM public.revalue_fx_balances(c_biz, d_run, NULL, NULL, NULL, c_uid);
        RAISE EXCEPTION 'FXREVAL_FAIL a closed fiscal period accepted a revaluation';
      EXCEPTION WHEN sqlstate '23514' THEN
        v_report := v_report || 'closed-period-refused ';
      END;
      UPDATE public.fiscal_periods SET status = 'open' WHERE id = v_period;
      UPDATE public.fx_revaluation_runs SET status = 'posted' WHERE id = v_run_id;
    END IF;

    -- 6) The reversal nets the remeasurement back out, exactly once.
    v_rev_je := public.reverse_fx_revaluation_run(v_run_id, d_run + 1, c_uid, NULL);
    IF v_rev_je IS NULL THEN
      RAISE EXCEPTION 'FXREVAL_FAIL the reversal produced no journal entry';
    END IF;
    SELECT COALESCE(SUM(debit), 0) - COALESCE(SUM(credit), 0) INTO v_ar_net
      FROM public.journal_entry_lines
     WHERE journal_entry_id IN (v_je, v_rev_je) AND account_id = c_ar;
    IF abs(v_ar_net) > 0.01 THEN
      RAISE EXCEPTION 'FXREVAL_FAIL run and reversal do not net to zero on the revalued account (%)', v_ar_net;
    END IF;
    SELECT count(*) INTO v_lines FROM public.journal_entries
     WHERE source_type = 'fx_revaluation_reversal' AND source_id = v_run_id;
    IF v_lines > 1 THEN
      RAISE EXCEPTION 'FXREVAL_FAIL run % was reversed % times', v_run_id, v_lines;
    END IF;
    v_report := v_report || 'reversal-nets-once ';

    RAISE EXCEPTION 'FXREVAL_OK %', v_report;
  EXCEPTION WHEN others THEN
    v_sqlstate := SQLSTATE;
    IF SQLERRM LIKE 'FXREVAL_OK%' THEN
      RAISE NOTICE 'PASS unrealized FX revaluation behaviour — %', SQLERRM;
    ELSE
      RAISE EXCEPTION 'unrealized FX revaluation behaviour failed [%] %', v_sqlstate, SQLERRM;
    END IF;
  END;
END $outer$;
