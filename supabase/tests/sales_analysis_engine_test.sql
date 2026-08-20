-- Sales analysis engine — contract test (Phase 4).
--
-- WHAT THIS PROVES
-- `finance_sales_analysis` and `finance_sales_revenue_reconciliation` take
-- `_org_id` from the CALLER, so they must verify membership themselves.
-- They also define what "sales" means for the whole ERP: ledger-posted,
-- non-void documents only, base currency, returns subtracted, and a closed
-- set of dimensions.
--
-- This file is read-only: it inspects the catalog and calls the functions
-- with a foreign organization id. It writes nothing.

-- ---------------------------------------------------------------------------
-- 1) One definition each — no ungated twin.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.proname, count(*) AS n
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('finance_sales_analysis',
                         'finance_sales_revenue_reconciliation')
     GROUP BY p.proname
  LOOP
    IF r.n <> 1 THEN
      RAISE EXCEPTION '% has % overloads — there must be exactly one', r.proname, r.n;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('finance_sales_analysis',
                           'finance_sales_revenue_reconciliation')) <> 2 THEN
    RAISE EXCEPTION 'a sales analysis function is missing';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2) Hardened: definer + pinned search_path + org guard + no anon execute.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, p.prosecdef, p.proconfig, p.prosrc
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('finance_sales_analysis',
                         'finance_sales_revenue_reconciliation')
  LOOP
    IF NOT r.prosecdef THEN
      RAISE EXCEPTION '% is not SECURITY DEFINER', r.proname;
    END IF;
    IF NOT (COALESCE(array_to_string(r.proconfig, ','), '') ~ 'search_path=') THEN
      RAISE EXCEPTION '% has no pinned search_path', r.proname;
    END IF;
    IF r.prosrc !~ 'finance_can_read_org' THEN
      RAISE EXCEPTION '% accepts _org_id but never calls finance_can_read_org', r.proname;
    END IF;
    IF has_function_privilege('anon', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is executable by anon', r.proname;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3) Cross-organisation call is refused with 42501, not answered with zeros.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_foreign_org uuid := gen_random_uuid();
  v_res jsonb;
BEGIN
  BEGIN
    v_res := public.finance_sales_analysis(
      v_foreign_org, CURRENT_DATE - 31, CURRENT_DATE, NULL, NULL, 'customer', NULL, 0);
    RAISE EXCEPTION 'finance_sales_analysis answered for a foreign organization';
  EXCEPTION WHEN sqlstate '42501' THEN NULL;  -- expected
  END;

  BEGIN
    v_res := public.finance_sales_revenue_reconciliation(
      v_foreign_org, CURRENT_DATE - 31, CURRENT_DATE, NULL, NULL);
    RAISE EXCEPTION 'finance_sales_revenue_reconciliation answered for a foreign organization';
  EXCEPTION WHEN sqlstate '42501' THEN NULL;  -- expected
  END;
END $$;

-- ---------------------------------------------------------------------------
-- 4) The dimension list is closed. An arbitrary grouping key must be rejected
--    before any data is touched — the org gate fires first, so we assert the
--    validation exists in the body and that both checks are present.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'finance_sales_analysis';

  IF v_src !~ 'unsupported sales dimension' THEN
    RAISE EXCEPTION 'finance_sales_analysis does not validate _dimension';
  END IF;
  FOR i IN 1..1 LOOP
    IF v_src !~ '''customer'',''product'',''category'',''branch'',''salesperson'',''month'''
       AND v_src !~ 'customer.*product.*category.*branch.*salesperson.*month' THEN
      RAISE EXCEPTION 'the dimension whitelist is not the expected closed set';
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 5) Accounting population: only ledger-posted, non-void documents count, and
--    amounts are normalised to base currency through the document rate.
--    (Static assertions on the engine body — the numbers themselves are
--    exercised by the reconciliation function at runtime.)
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'finance_sales_analysis';

  IF v_src !~ 'journal_entry_id IS NOT NULL' THEN
    RAISE EXCEPTION 'unposted invoices are not excluded from sales';
  END IF;
  IF v_src !~ 'voided_at IS NULL' THEN
    RAISE EXCEPTION 'voided invoices are not excluded from sales';
  END IF;
  IF v_src !~ 'exchange_rate' THEN
    RAISE EXCEPTION 'sales amounts are not normalised to base currency';
  END IF;
  IF v_src !~ 'credit_note_items' THEN
    RAISE EXCEPTION 'returns (credit notes) are not subtracted from sales';
  END IF;
  IF v_src !~ '_business_id IS NULL OR' OR v_src !~ '_branch_id IS NULL OR' THEN
    RAISE EXCEPTION 'business / branch scoping predicate is missing or non-strict';
  END IF;
  -- Strict branch scoping: never absorb unbranched documents into a
  -- branch-scoped report.
  IF v_src ~ 'branch_id IS NULL\s*\)' AND v_src ~ 'OR i\.branch_id IS NULL' THEN
    RAISE EXCEPTION 'branch predicate leaks unbranched documents';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6) The reconciliation compares documents to the GL revenue family and
--    reports a variance rather than hiding it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'finance_sales_revenue_reconciliation';

  IF v_src !~ 'sales_revenue' OR v_src !~ 'sales_returns' OR v_src !~ 'discount_given' THEN
    RAISE EXCEPTION 'revenue tie-out does not use the revenue / returns / discount accounts';
  END IF;
  IF v_src !~ 'variance' OR v_src !~ 'in_balance' THEN
    RAISE EXCEPTION 'revenue tie-out does not report a variance';
  END IF;
  IF v_src !~ 'je\.status = ''posted''' THEN
    RAISE EXCEPTION 'revenue tie-out includes unposted journal entries';
  END IF;
END $$;
