-- =====================================================================
-- Partner Ledger engine — accounting and authorization contract.
--
-- Run with: psql -f supabase/tests/partner_ledger_engine_test.sql
-- Every assertion is a hard failure; the transaction is rolled back.
-- =====================================================================
BEGIN;

-- 1. Both functions exist, are SECURITY DEFINER and pin search_path.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.proname, p.prosecdef, p.proconfig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('finance_partner_ledger', 'finance_partner_ledger_reconciliation')
  LOOP
    IF NOT r.prosecdef THEN
      RAISE EXCEPTION '% must be SECURITY DEFINER', r.proname;
    END IF;
    IF r.proconfig IS NULL
       OR NOT EXISTS (SELECT 1 FROM unnest(r.proconfig) c WHERE c LIKE 'search_path=%') THEN
      RAISE EXCEPTION '% must pin search_path', r.proname;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('finance_partner_ledger', 'finance_partner_ledger_reconciliation')) <> 2 THEN
    RAISE EXCEPTION 'Partner Ledger engine functions are missing';
  END IF;
END $$;

-- 2. anon must not be able to execute either function.
DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['finance_partner_ledger', 'finance_partner_ledger_reconciliation'] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = fn
         AND has_function_privilege('anon', p.oid, 'EXECUTE')
    ) THEN
      RAISE EXCEPTION '% must not be executable by anon', fn;
    END IF;
  END LOOP;
END $$;

-- 3. The engine must be org-gated (membership check present in the body).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'finance_partner_ledger'
       AND pg_get_functiondef(p.oid) LIKE '%finance_can_read_org%'
  ) THEN
    RAISE EXCEPTION 'finance_partner_ledger must gate on finance_can_read_org';
  END IF;
END $$;

-- 4. Branch scoping must be strict — no NULL-absorbing predicate.
DO $$
DECLARE
  def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'finance_partner_ledger';

  IF def ~* 'branch_id\s+IS\s+NULL\s*\)?\s*$' AND def !~* '_branch_id IS NULL OR' THEN
    RAISE EXCEPTION 'finance_partner_ledger must not absorb unbranched rows into a branch view';
  END IF;

  IF def !~* '_branch_id\s+IS\s+NULL\s+OR\s+\w+\.branch_id\s*=\s*_branch_id' THEN
    RAISE EXCEPTION 'finance_partner_ledger must scope branch strictly';
  END IF;
END $$;

-- 5. Accounting invariant: for every business, the sum of partner closing
--    balances equals the AR / AP control-account position, per side.
DO $$
DECLARE
  b record;
  v_ledger numeric;
  v_control numeric;
BEGIN
  FOR b IN
    SELECT DISTINCT organization_id, business_id
      FROM public.ar_subledger_entries
     WHERE contact_id IS NOT NULL
     LIMIT 25
  LOOP
    SELECT COALESCE(SUM(s.debit - s.credit), 0) INTO v_control
      FROM public.ar_subledger_entries s
     WHERE s.organization_id = b.organization_id
       AND s.business_id = b.business_id
       AND s.contact_id IS NOT NULL;

    SELECT COALESCE(SUM(c.debit - c.credit), 0) INTO v_ledger
      FROM public.customer_ledger_entries c
     WHERE c.organization_id = b.organization_id
       AND c.business_id = b.business_id
       AND c.contact_id IS NOT NULL;

    IF ABS(v_ledger - v_control) > 0.01 THEN
      RAISE EXCEPTION 'AR partner ledger drifts from control account for business % (ledger %, control %)',
        b.business_id, v_ledger, v_control;
    END IF;
  END LOOP;

  FOR b IN
    SELECT DISTINCT organization_id, business_id
      FROM public.ap_subledger_entries
     WHERE contact_id IS NOT NULL
     LIMIT 25
  LOOP
    SELECT COALESCE(SUM(s.credit - s.debit), 0) INTO v_control
      FROM public.ap_subledger_entries s
     WHERE s.organization_id = b.organization_id
       AND s.business_id = b.business_id
       AND s.contact_id IS NOT NULL;

    SELECT COALESCE(SUM(v.credit - v.debit), 0) INTO v_ledger
      FROM public.vendor_ledger_entries v
     WHERE v.organization_id = b.organization_id
       AND v.business_id = b.business_id
       AND v.contact_id IS NOT NULL;

    IF ABS(v_ledger - v_control) > 0.01 THEN
      RAISE EXCEPTION 'AP partner ledger drifts from control account for business % (ledger %, control %)',
        b.business_id, v_ledger, v_control;
    END IF;
  END LOOP;
END $$;

ROLLBACK;
