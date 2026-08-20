-- Purchase analysis engine — contract test (Purchases & payables parity).
--
-- WHAT THIS PROVES
-- `finance_purchase_analysis` and `finance_purchase_expense_reconciliation`
-- take `_org_id` from the CALLER, so they must verify membership themselves.
-- They also define what "purchases" means for the whole ERP: ledger-posted,
-- non-void documents only, base currency, vendor credit notes subtracted, and
-- a closed set of dimensions.
--
-- This file is read-only: it inspects the catalog and calls the functions with
-- a foreign organization id. It writes nothing.

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
       AND p.proname IN ('finance_purchase_analysis',
                         'finance_purchase_expense_reconciliation')
     GROUP BY p.proname
  LOOP
    IF r.n <> 1 THEN
      RAISE EXCEPTION '% has % overloads — there must be exactly one', r.proname, r.n;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('finance_purchase_analysis',
                           'finance_purchase_expense_reconciliation')) <> 2 THEN
    RAISE EXCEPTION 'a purchase analysis function is missing';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2) Hardened: definer + pinned search_path + org guard + no anon execute,
--    and read-only (STABLE) so no reporting call can mutate the books.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, p.prosecdef, p.proconfig, p.prosrc, p.provolatile
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('finance_purchase_analysis',
                         'finance_purchase_expense_reconciliation')
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
    IF r.provolatile = 'v' THEN
      RAISE EXCEPTION '% is VOLATILE — a report must not be able to write', r.proname;
    END IF;
    IF r.prosrc ~* 'CREATE\s+(TEMP|TEMPORARY|GLOBAL|LOCAL)?\s*TABLE' THEN
      RAISE EXCEPTION '% creates a table — DDL is not allowed in a report engine', r.proname;
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
    v_res := public.finance_purchase_analysis(
      v_foreign_org, CURRENT_DATE - 31, CURRENT_DATE, NULL, NULL, 'supplier', NULL, 0);
    RAISE EXCEPTION 'finance_purchase_analysis answered for a foreign organization';
  EXCEPTION WHEN sqlstate '42501' THEN NULL;  -- expected
  END;

  BEGIN
    v_res := public.finance_purchase_expense_reconciliation(
      v_foreign_org, CURRENT_DATE - 31, CURRENT_DATE, NULL, NULL);
    RAISE EXCEPTION 'finance_purchase_expense_reconciliation answered for a foreign organization';
  EXCEPTION WHEN sqlstate '42501' THEN NULL;  -- expected
  END;
END $$;

-- ---------------------------------------------------------------------------
-- 4) Accounting semantics are encoded in the engine, not in the client.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'finance_purchase_analysis';

  -- closed dimension list
  IF v_src !~ 'unsupported purchase dimension' THEN
    RAISE EXCEPTION 'the purchase dimension list is not validated';
  END IF;
  -- posted, non-void documents only
  IF v_src !~ 'journal_entry_id IS NOT NULL' OR v_src !~ 'voided_at IS NULL' THEN
    RAISE EXCEPTION 'unposted or voided bills are not excluded';
  END IF;
  -- base currency normalisation on both document families
  IF v_src !~ 'currency_rate' OR v_src !~ 'exchange_rate' THEN
    RAISE EXCEPTION 'documents are not normalised to base currency';
  END IF;
  -- vendor credit notes are subtracted as returns
  IF v_src !~ 'vendor_credit_note_items' THEN
    RAISE EXCEPTION 'purchase returns are not subtracted';
  END IF;
  -- strict branch scoping: no widening escape hatch
  IF v_src ~* 'OR\s+b\.branch_id\s+IS\s+NULL' OR v_src ~* 'OR\s+c\.branch_id\s+IS\s+NULL' THEN
    RAISE EXCEPTION 'branch scope is widened with an IS NULL escape';
  END IF;
END $$;

DO $$ BEGIN RAISE NOTICE 'PASS: purchase analysis engine contract'; END $$;
