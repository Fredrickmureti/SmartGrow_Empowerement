-- FX revaluation lifecycle contract (ADR 0123 / 0136 / 0146).
--
-- Phase 1 of the Currency & Forex investigation. Contract assertions read the
-- catalog only, so the file is safe in any environment.

-- 1) Every identifier the reversal routine references must actually resolve.
--    The historical defect: `_org_id` was neither a parameter nor a declared
--    variable, and `reversal_of_run_id` is not a column of fx_revaluation_runs,
--    so EVERY reversal raised at runtime — which in turn made the second and
--    every later revaluation run fail.
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'reverse_fx_revaluation_run';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'reverse_fx_revaluation_run is missing';
  END IF;

  IF v_src ~ 'reversal_of_run_id' THEN
    RAISE EXCEPTION 'reverse_fx_revaluation_run references a non-existent column reversal_of_run_id';
  END IF;

  -- The organisation must be derived from the run row, never from an
  -- undeclared variable.
  IF v_src ~ '_org_id' AND v_src !~ 'DECLARE[\s\S]*_org_id' THEN
    RAISE EXCEPTION 'reverse_fx_revaluation_run uses an undeclared _org_id';
  END IF;

  IF v_src !~ '_run\.organization_id' THEN
    RAISE EXCEPTION 'reverse_fx_revaluation_run does not scope the reversal to the run organisation';
  END IF;
END $$;

-- 2) ADR-0146: the posting engine is the only journal numberer. Neither FX
--    function may compose its own entry number.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.proname, p.prosrc
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('revalue_fx_balances', 'reverse_fx_revaluation_run')
  LOOP
    IF r.prosrc ~ 'FXREV' THEN
      RAISE EXCEPTION '% hand-builds a journal number; the posting engine must number it', r.proname;
    END IF;
  END LOOP;
END $$;

-- 3) Unrealized FX belongs to the legal entity: no branch may be guessed onto
--    the revaluation journal lines.
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'revalue_fx_balances';

  IF v_src ~* 'MIN\(jel\.branch_id\)' THEN
    RAISE EXCEPTION 'revalue_fx_balances attributes unrealized FX to an arbitrary branch';
  END IF;
END $$;

-- 4) Idempotency + period gates must stay in place.
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'revalue_fx_balances';

  IF v_src !~* 'A posted FX revaluation already exists for period' THEN
    RAISE EXCEPTION 'revalue_fx_balances lost its one-posted-run-per-period guard';
  END IF;
  IF v_src !~* 'FX revaluation cannot post into it' THEN
    RAISE EXCEPTION 'revalue_fx_balances lost its closed-period guard';
  END IF;
  IF v_src !~* 'has_finance_permission' THEN
    RAISE EXCEPTION 'revalue_fx_balances lost its permission gate';
  END IF;
  IF v_src !~* 'post_journal_entry_atomic' THEN
    RAISE EXCEPTION 'revalue_fx_balances must post only through post_journal_entry_atomic';
  END IF;
  -- A missing rate is an absence, never a silent 1:1 (ADR 0136).
  IF v_src !~* 'no exchange rate on file' THEN
    RAISE EXCEPTION 'revalue_fx_balances no longer fails loudly on a missing rate';
  END IF;
END $$;

-- 5) The FX read surfaces stay server-scoped to an authorised business.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.proname, p.prosrc, p.prosecdef,
           coalesce(array_to_string(p.proacl, ','), '') AS acl
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('fx_exposure_by_currency', 'fx_exposure_open_items', 'fx_revaluation_readiness')
  LOOP
    IF NOT r.prosecdef THEN
      RAISE EXCEPTION '% must be SECURITY DEFINER', r.proname;
    END IF;
    IF r.prosrc !~ 'user_can_access_business' THEN
      RAISE EXCEPTION '% does not gate on user_can_access_business', r.proname;
    END IF;
    IF r.acl ~ 'anon=' THEN
      RAISE EXCEPTION '% is executable by anon', r.proname;
    END IF;
  END LOOP;
END $$;

-- 6) Monetary eligibility (IAS 21): only monetary balances are revalued, and
--    exposure is measured on the currency of the LINE, not of the header.
DO $$
DECLARE r record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fx_is_monetary_account'
  ) THEN
    RAISE EXCEPTION 'the FX monetary classifier fx_is_monetary_account is missing';
  END IF;

  -- Non-monetary items must never be revalued; monetary ones must be.
  IF public.fx_is_monetary_account('asset','inventory')
     OR public.fx_is_monetary_account('asset','fixed_asset_software')
     OR public.fx_is_monetary_account('asset','prepaid_expenses')
     OR public.fx_is_monetary_account('liability','deferred_revenue')
     OR public.fx_is_monetary_account('income','sales_income') THEN
    RAISE EXCEPTION 'fx_is_monetary_account treats a non-monetary account as monetary';
  END IF;
  IF NOT (public.fx_is_monetary_account('asset','accounts_receivable')
      AND public.fx_is_monetary_account('liability','accounts_payable')
      AND public.fx_is_monetary_account('asset','checking')
      AND public.fx_is_monetary_account('asset', NULL)) THEN
    RAISE EXCEPTION 'fx_is_monetary_account drops a monetary account from FX scope';
  END IF;

  FOR r IN
    SELECT p.proname, p.prosrc
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('revalue_fx_balances','fx_exposure_by_currency','fx_exposure_open_items')
  LOOP
    IF r.prosrc ~ 'a\.account_type IN \(''asset'',''liability''\)' THEN
      RAISE EXCEPTION '% still uses the asset-or-liability rule instead of the monetary classifier', r.proname;
    END IF;
    IF r.prosrc !~ 'fx_is_monetary_account' THEN
      RAISE EXCEPTION '% does not restrict FX scope to monetary accounts', r.proname;
    END IF;
    IF r.prosrc !~ 'jel\.original_currency' THEN
      RAISE EXCEPTION '% measures exposure on the header currency instead of the line currency', r.proname;
    END IF;
  END LOOP;
END $$;


-- 7) Readiness is a projection of the revaluation engine, not a second opinion.
--    The historical defect: readiness read a non-existent
--    `businesses.default_currency` (so every period-close check raised) and
--    scoped on the raw asset/liability rule, so it warned about balances the
--    engine would never revalue (and stayed silent on ones it would).
DO $$
DECLARE v_ready text; v_reval text;
BEGIN
  SELECT p.prosrc INTO v_ready FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fx_revaluation_readiness';
  SELECT p.prosrc INTO v_reval FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'revalue_fx_balances';

  IF v_ready IS NULL THEN
    RAISE EXCEPTION 'fx_revaluation_readiness is missing';
  END IF;

  IF v_ready ~ 'default_currency' THEN
    RAISE EXCEPTION 'fx_revaluation_readiness references businesses.default_currency, which does not exist';
  END IF;
  IF v_ready !~ 'base_currency' THEN
    RAISE EXCEPTION 'fx_revaluation_readiness does not derive the reporting currency from businesses.base_currency';
  END IF;

  -- Same eligibility rule, same currency source, same open-balance threshold
  -- as the engine, so the warning can never disagree with the run.
  IF v_ready !~ 'fx_is_monetary_account' THEN
    RAISE EXCEPTION 'fx_revaluation_readiness does not restrict scope to monetary accounts';
  END IF;
  IF v_ready ~ 'a\.account_type IN \(''asset'',''liability''\)' THEN
    RAISE EXCEPTION 'fx_revaluation_readiness still uses the asset-or-liability rule';
  END IF;
  IF v_ready !~ 'jel\.original_currency' THEN
    RAISE EXCEPTION 'fx_revaluation_readiness measures exposure on the header currency instead of the line currency';
  END IF;
  IF v_ready !~ 'resolve_exchange_rate' THEN
    RAISE EXCEPTION 'fx_revaluation_readiness resolves rates outside the single resolver';
  END IF;
  IF v_ready !~ 'jel\.account_id' OR v_ready !~ 'GROUP BY jel\.account_id' THEN
    RAISE EXCEPTION 'fx_revaluation_readiness does not measure balances per account like the engine does';
  END IF;
  IF (v_ready ~ '0\.01') IS DISTINCT FROM (v_reval ~ '0\.01') THEN
    RAISE EXCEPTION 'fx_revaluation_readiness and revalue_fx_balances disagree on the open-balance threshold';
  END IF;
END $$;

-- 8) No FX-facing routine may reference a column the schema does not have.
--    `businesses` carries `base_currency` only; a stale `default_currency`
--    reference is a runtime landmine that only fires at period close.
DO $$
DECLARE r record;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'businesses' AND column_name = 'default_currency'
  ) THEN
    RAISE EXCEPTION 'businesses.default_currency exists again — the FX currency source must stay single';
  END IF;

  FOR r IN
    SELECT p.proname, p.prosrc
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND (p.proname LIKE 'fx_%' OR p.proname LIKE '%_fx_%' OR p.proname LIKE '%exchange_rate%')
       AND p.prosrc ~ 'public\.businesses'
  LOOP
    IF r.prosrc ~ 'default_currency' THEN
      RAISE EXCEPTION '% reads businesses.default_currency, which does not exist', r.proname;
    END IF;
  END LOOP;
END $$;

-- 9) ADR 0136 parity ratchet, swept across EVERY public routine: no engine may
--    value a foreign document at 1:1 because its rate is absent. The sweep
--    strips `--` comments first, so a comment that *documents* the absence of a
--    fallback (e.g. "no COALESCE(rate, 1) here") does not trip the ratchet.
DO $$
DECLARE r record; v_src text; v_bad text[] := '{}';
BEGIN
  FOR r IN
    SELECT p.proname, p.prosrc
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
  LOOP
    v_src := regexp_replace(r.prosrc, '--[^\n]*', '', 'g');
    IF v_src ~* 'COALESCE\s*\(\s*(NULLIF\s*\(\s*)?[a-z_."]*(exchange_rate|currency_rate|fx_rate|_rate|\mrate\M)[^)]*\)?\s*,\s*1(\.0+)?\s*\)' THEN
      v_bad := v_bad || r.proname;
    END IF;
  END LOOP;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION '% fall(s) back to a 1:1 exchange rate (ADR 0136)', array_to_string(v_bad, ', ');
  END IF;
END $$;


-- 10) The expense posting path refuses, loudly, when no rate is on file.
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'post_expense_gl';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'post_expense_gl is missing';
  END IF;
  IF v_src !~* 'no exchange rate on file' THEN
    RAISE EXCEPTION 'post_expense_gl does not refuse an expense with no exchange rate';
  END IF;
  IF v_src !~ 'post_journal_entry_atomic' THEN
    RAISE EXCEPTION 'post_expense_gl must post only through post_journal_entry_atomic (ADR 0123)';
  END IF;
END $$;
