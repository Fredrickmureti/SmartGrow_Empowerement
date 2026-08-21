-- ADR 0136 / 0138 — FX tenant isolation ratchet.
--
-- The FX engine is a pile of SECURITY DEFINER functions: they bypass RLS by
-- construction, so their only boundary is the check they perform themselves.
-- Two rules, both enforced below:
--
--   A. A tenant-facing FX function (EXECUTE granted to `authenticated`) MUST
--      derive authorisation from the business it operates on —
--      `user_can_access_business` or `has_finance_permission`.
--   B. An engine-internal FX function (no membership check) MUST NOT be
--      reachable from the Data API — EXECUTE revoked from anon/authenticated.
--      Its in-database callers run as the owner and keep their rights.
--
-- Read-only catalogue assertions. Safe to run anywhere.

BEGIN;

DO $$
DECLARE
  v_offenders text;
BEGIN
  -- A. Every FX function exposed to signed-in users authorises per business.
  SELECT string_agg(proname, ', ' ORDER BY proname) INTO v_offenders
  FROM (
    SELECT p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND (p.proname LIKE 'fx\_%' OR p.proname LIKE '%exchange\_rate%' OR p.proname LIKE '%revaluation%')
      AND p.proname NOT LIKE '%inventory%'      -- inventory cost revaluation is a different engine
      AND p.prorettype <> 'trigger'::regtype    -- trigger bodies are not a callable surface
      AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
      AND pg_get_functiondef(p.oid) !~* '(user_can_access_business|has_finance_permission)'
  ) s;
  IF v_offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'FX isolation: these SECURITY DEFINER functions are callable by any signed-in user without a per-business check: %',
      v_offenders;
  END IF;

  -- B. The engine-internal resolvers stay off the Data API entirely.
  SELECT string_agg(fn, ', ' ORDER BY fn) INTO v_offenders
  FROM (
    SELECT fn FROM unnest(ARRAY[
      'public.resolve_exchange_rate(uuid, uuid, text, date)',
      'public.require_exchange_rate(uuid, uuid, text, date)',
      'public.resolve_sales_exchange_rate(uuid, uuid, text, date)',
      'public.fx_stamp_document(uuid, uuid, text, date)',
      'public.reverse_fx_revaluation_run(uuid, date, uuid, uuid)',
      'public._pick_exchange_rate_row(uuid, uuid, text, text, date)'
    ]) fn
    WHERE has_function_privilege('authenticated', fn, 'EXECUTE')
       OR has_function_privilege('anon', fn, 'EXECUTE')
  ) s;
  IF v_offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'FX isolation: these engine internals are reachable from the Data API: %', v_offenders;
  END IF;

  -- The tenant-facing rate lookup must remain available, or the UI loses its
  -- only honest way to explain a rate.
  IF NOT has_function_privilege('authenticated', 'public.describe_exchange_rate(uuid, uuid, text, date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FX isolation: describe_exchange_rate must stay callable by signed-in users';
  END IF;

  -- A reversal authorises against the run's own business, never an argument.
  IF pg_get_functiondef('public.reverse_fx_revaluation_run(uuid, date, uuid, uuid)'::regprocedure)
       !~* 'has_finance_permission\s*\(\s*_uid\s*,\s*''finance\.manage_periods''\s*,\s*_run\.business_id' THEN
    RAISE EXCEPTION
      'FX isolation: reverse_fx_revaluation_run must authorise against _run.business_id';
  END IF;

  -- The rate book and revaluation ledger keep RLS with policies behind them.
  SELECT string_agg(relname, ', ' ORDER BY relname) INTO v_offenders
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('exchange_rates', 'fx_revaluation_runs', 'fx_revaluation_lines')
    AND (NOT c.relrowsecurity OR (SELECT count(*) FROM pg_policy pp WHERE pp.polrelid = c.oid) = 0);
  IF v_offenders IS NOT NULL THEN
    RAISE EXCEPTION 'FX isolation: these FX tables lack RLS or policies: %', v_offenders;
  END IF;

  RAISE NOTICE 'fx_tenant_isolation_test: all contracts hold';
END $$;

ROLLBACK;
