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
