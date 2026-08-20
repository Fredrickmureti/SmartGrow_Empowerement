-- ADR-0149 — un-matching a posted bank line is a refusable, pre-announced act.
--
-- These assertions are about the shape of the seam, not about any one tenant's
-- data: a pre-flight that is not read-only, not definer-pinned, or callable by
-- `anon` would be a new way to learn about (or touch) another org's books.

BEGIN;

-- 1. The pre-flight exists, is SECURITY DEFINER with a pinned search_path,
--    and is STABLE (it may not write).
DO $$
DECLARE r record;
BEGIN
  SELECT p.prosecdef, p.provolatile, p.proconfig
    INTO r
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'bank_unmatch_preflight';

  IF r IS NULL THEN
    RAISE EXCEPTION 'bank_unmatch_preflight is missing';
  END IF;
  IF NOT r.prosecdef THEN
    RAISE EXCEPTION 'bank_unmatch_preflight must be SECURITY DEFINER';
  END IF;
  IF r.provolatile <> 's' THEN
    RAISE EXCEPTION 'bank_unmatch_preflight must be STABLE (read-only)';
  END IF;
  IF NOT ('search_path=public' = ANY(COALESCE(r.proconfig, ARRAY[]::text[]))) THEN
    RAISE EXCEPTION 'bank_unmatch_preflight must pin search_path=public';
  END IF;
END $$;

-- 2. It is not reachable without signing in.
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.bank_unmatch_preflight(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not execute bank_unmatch_preflight';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.bank_unmatch_preflight(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must be able to execute bank_unmatch_preflight';
  END IF;
END $$;

-- 3. It checks the same finance permission the mutating RPC checks, so it can
--    never report "allowed" to someone who may not reconcile.
DO $$
DECLARE src text;
BEGIN
  SELECT prosrc INTO src FROM pg_proc WHERE proname = 'bank_unmatch_preflight';
  IF src NOT LIKE '%finance.reconcile_bank%' THEN
    RAISE EXCEPTION 'pre-flight must check finance.reconcile_bank';
  END IF;
  IF src NOT LIKE '%is_period_open%' THEN
    RAISE EXCEPTION 'pre-flight must check the period lock';
  END IF;
END $$;

-- 4. An unknown bank line is refused rather than defaulted to allowed.
DO $$
DECLARE res jsonb;
BEGIN
  res := public.bank_unmatch_preflight('00000000-0000-0000-0000-000000000000'::uuid);
  IF (res->>'allowed')::boolean THEN
    RAISE EXCEPTION 'pre-flight must refuse an unknown bank transaction';
  END IF;
  IF res->>'code' <> 'BANK_TRANSACTION_NOT_FOUND' THEN
    RAISE EXCEPTION 'unexpected code for unknown line: %', res->>'code';
  END IF;
END $$;

-- 5. The opening balance may only be posted once per bank account.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_guard_duplicate_opening_balance'
       AND tgrelid = 'public.bank_reconciliation_matches'::regclass
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'duplicate opening-balance guard is missing';
  END IF;
END $$;

ROLLBACK;
