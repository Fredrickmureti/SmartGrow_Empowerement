-- Receivables & Partners reporting — authorization contract (Phase 1).
--
-- WHAT THIS PROVES
-- Every read RPC behind the Aged Receivables / Aged Payables / Control
-- Account Reconciliation surfaces takes `_org_id` from the CALLER. That is
-- only safe if the function itself verifies membership. Historically
-- `get_control_account_reconciliation` and `get_ar_summary` did not: any
-- signed-in user could pass another tenant's UUID and read that tenant's
-- AR/AP control balance, sub-ledger total and drift.
--
-- The contract asserted here, for the whole family:
--   1. exactly one overload per function (no ungated twin);
--   2. SECURITY DEFINER with a pinned search_path;
--   3. the body calls `public.finance_can_read_org(_org_id)`;
--   4. anon cannot EXECUTE it.
--
-- This file is read-only: it inspects the catalog and writes nothing.

-- ---------------------------------------------------------------------------
-- 1) One definition each.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.proname, count(*) AS n
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('get_ar_ap_aging_from_ledger',
                         'get_control_account_reconciliation',
                         'get_ar_summary')
     GROUP BY p.proname
  LOOP
    IF r.n <> 1 THEN
      RAISE EXCEPTION '% has % overloads — there must be exactly one', r.proname, r.n;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2) Hardened: definer + pinned search_path + org guard + no anon execute.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, p.prosecdef, p.proconfig, p.prosrc, p.proacl
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('get_ar_ap_aging_from_ledger',
                         'get_control_account_reconciliation',
                         'get_ar_summary')
  LOOP
    IF NOT r.prosecdef THEN
      RAISE EXCEPTION '% is not SECURITY DEFINER', r.proname;
    END IF;

    IF NOT (COALESCE(array_to_string(r.proconfig, ','), '') ~ 'search_path=') THEN
      RAISE EXCEPTION '% has no pinned search_path', r.proname;
    END IF;

    IF r.prosrc !~ 'finance_can_read_org' THEN
      RAISE EXCEPTION
        '% accepts _org_id but never calls finance_can_read_org — cross-tenant read', r.proname;
    END IF;

    IF has_function_privilege('anon', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is executable by anon', r.proname;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3) Cross-organisation call is refused with 42501, not answered with zeros.
--    A random org UUID can never be one the caller belongs to.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_foreign_org uuid := gen_random_uuid();
  v_rec record;
BEGIN
  BEGIN
    SELECT * INTO v_rec
      FROM public.get_control_account_reconciliation(v_foreign_org, NULL, 'ar', NULL);
    RAISE EXCEPTION
      'get_control_account_reconciliation answered for a foreign organization';
  EXCEPTION
    WHEN sqlstate '42501' THEN NULL;  -- expected
  END;

  BEGIN
    SELECT * INTO v_rec FROM public.get_ar_summary(v_foreign_org, NULL, NULL, CURRENT_DATE);
    RAISE EXCEPTION 'get_ar_summary answered for a foreign organization';
  EXCEPTION
    WHEN sqlstate '42501' THEN NULL;  -- expected
  END;

  BEGIN
    SELECT * INTO v_rec
      FROM public.get_ar_ap_aging_from_ledger(v_foreign_org, gen_random_uuid(), 'ar', CURRENT_DATE, NULL);
    RAISE EXCEPTION 'get_ar_ap_aging_from_ledger answered for a foreign organization';
  EXCEPTION
    WHEN sqlstate '42501' THEN NULL;  -- expected
  END;
END $$;

-- ---------------------------------------------------------------------------
-- 4) Partner Ledger reads two views directly from the browser. That is only
--    acceptable while they are invoker views, so base-table RLS applies to
--    the caller. An owner-run (definer) view here would bypass RLS entirely.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname, c.reloptions
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN ('customer_ledger_entries', 'vendor_ledger_entries',
                         'ar_subledger_entries', 'ap_subledger_entries')
  LOOP
    IF NOT (COALESCE(array_to_string(r.reloptions, ','), '') ~ 'security_invoker=(on|true)') THEN
      RAISE EXCEPTION
        'view % is owner-run — client reads would bypass journal RLS', r.relname;
    END IF;
  END LOOP;
END $$;
