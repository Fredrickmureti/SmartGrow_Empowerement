-- Receivables & Partners reporting — isolation matrix (Phase 5.1).
--
-- WHAT THIS PROVES
-- The four report families in this domain (AR aging, AP aging, Partner
-- Ledger, Sales Analysis) are all `SECURITY DEFINER` functions that take
-- `_org_id` from the CALLER. That design is only safe if EVERY one of them,
-- without exception:
--   1. exists exactly once (no ungated twin / stale overload),
--   2. is definer + pinned `search_path`,
--   3. calls `finance_can_read_org` before reading anything,
--   4. is NOT executable by `anon`,
--   5. refuses a foreign organization with SQLSTATE 42501 instead of
--      answering with an empty (but truthful-looking) report,
--   6. does not widen branch scope with an `OR branch_id IS NULL` escape.
--
-- One missing row in this matrix is a cross-tenant data leak, so the whole
-- family is asserted together rather than per-report.
--
-- This file is read-only: it inspects the catalog and calls each function
-- with a random organization id. It writes nothing.

-- ---------------------------------------------------------------------------
-- 0) The matrix. Adding a report to this domain means adding it here.
-- ---------------------------------------------------------------------------
-- Kept for the whole session (not ON COMMIT DROP) so the file can be run
-- statement-by-statement as well as inside one transaction.
DROP TABLE IF EXISTS _reporting_matrix;
CREATE TEMP TABLE _reporting_matrix(proname text PRIMARY KEY, family text);
INSERT INTO _reporting_matrix(proname, family) VALUES
  ('get_ar_ap_aging_from_ledger',            'aging'),
  ('get_ar_summary',                         'aging'),
  ('get_ap_summary',                         'aging'),
  ('get_control_account_reconciliation',     'aging'),
  ('finance_ar_open_items_as_of',            'receivables'),
  ('finance_ar_customer_credit_as_of',       'receivables'),
  ('finance_ar_aging_reconciliation',        'receivables'),
  ('finance_partner_ledger',                 'partner_ledger'),
  ('finance_partner_ledger_reconciliation',  'partner_ledger'),
  ('finance_sales_analysis',                 'sales'),
  ('finance_sales_revenue_reconciliation',   'sales'),
  ('finance_purchase_analysis',              'purchases'),
  ('finance_purchase_expense_reconciliation','purchases'),
  -- General-ledger engines behind Cash Flow, Bank/Cash dashboards, Trial
  -- Balance and Year-End closing. Same definer + caller-org contract.
  ('get_account_movements',                  'general_ledger'),
  ('get_account_balances',                   'general_ledger'),
  ('get_general_ledger',                     'general_ledger'),
  ('get_gl_transactions',                    'general_ledger'),
  ('check_balance_integrity',                'general_ledger');

-- ---------------------------------------------------------------------------
-- 1) Every matrix entry exists exactly once.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT m.proname,
                  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = m.proname) AS n
             FROM _reporting_matrix m
  LOOP
    IF r.n = 0 THEN
      RAISE EXCEPTION 'reporting function % is missing', r.proname;
    ELSIF r.n > 1 THEN
      RAISE EXCEPTION 'reporting function % has % overloads — exactly one definition is allowed', r.proname, r.n;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2) Hardening matrix: definer + pinned search_path + org gate + no anon.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, p.prosecdef, p.proconfig, p.prosrc
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN _reporting_matrix m ON m.proname = p.proname
     WHERE n.nspname = 'public'
  LOOP
    IF NOT r.prosecdef THEN
      RAISE EXCEPTION '% is not SECURITY DEFINER', r.proname;
    END IF;
    IF COALESCE(array_to_string(r.proconfig, ','), '') !~ 'search_path=' THEN
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
-- 3) Every function takes `_org_id` as its FIRST argument. The org gate is
--    only meaningful if the tenant key cannot be defaulted away.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN _reporting_matrix m ON m.proname = p.proname
     WHERE n.nspname = 'public'
  LOOP
    IF r.args !~ '^_org_id uuid' THEN
      RAISE EXCEPTION '% does not take _org_id uuid as its first argument (got: %)', r.proname, r.args;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4) Branch scoping is strict: no `OR branch_id IS NULL` widening.
--    (A NULL `_branch_id` argument means "all branches"; a NULL row
--     `branch_id` must never slip past a branch filter.)
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.proname, p.prosrc
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN _reporting_matrix m ON m.proname = p.proname
     WHERE n.nspname = 'public'
  LOOP
    IF r.prosrc ~* 'or\s+[a-z_.]*branch_id\s+is\s+null' THEN
      RAISE EXCEPTION '% widens branch scope with an "OR branch_id IS NULL" escape', r.proname;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 5) Cross-organisation calls are REFUSED (42501) — not answered with zeros.
--    Each signature is called explicitly so the test breaks loudly if a
--    signature changes rather than silently skipping a report.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_org uuid := gen_random_uuid();  -- an organization the caller cannot read
  v_from date := CURRENT_DATE - 31;
  v_to   date := CURRENT_DATE;
BEGIN
  -- aging family
  BEGIN
    PERFORM public.get_ar_ap_aging_from_ledger(v_org, NULL, 'receivable', v_to, NULL);
    RAISE EXCEPTION 'get_ar_ap_aging_from_ledger answered for a foreign organization';
  EXCEPTION WHEN sqlstate '42501' THEN NULL; END;

  BEGIN
    PERFORM public.get_ar_summary(v_org, NULL, NULL, v_to);
    RAISE EXCEPTION 'get_ar_summary answered for a foreign organization';
  EXCEPTION WHEN sqlstate '42501' THEN NULL; END;

  BEGIN
    PERFORM public.get_ap_summary(v_org, NULL, NULL, v_to);
    RAISE EXCEPTION 'get_ap_summary answered for a foreign organization';
  EXCEPTION WHEN sqlstate '42501' THEN NULL; END;

  BEGIN
    PERFORM public.get_control_account_reconciliation(v_org, NULL, 'receivable', NULL);
    RAISE EXCEPTION 'get_control_account_reconciliation answered for a foreign organization';
  EXCEPTION WHEN sqlstate '42501' THEN NULL; END;

  -- receivables point-in-time family
  BEGIN
    PERFORM public.finance_ar_open_items_as_of(v_org, NULL, NULL, v_to);
    RAISE EXCEPTION 'finance_ar_open_items_as_of answered for a foreign organization';
  EXCEPTION WHEN sqlstate '42501' THEN NULL; END;

  BEGIN
    PERFORM public.finance_ar_customer_credit_as_of(v_org, NULL, NULL, v_to);
    RAISE EXCEPTION 'finance_ar_customer_credit_as_of answered for a foreign organization';
  EXCEPTION WHEN sqlstate '42501' THEN NULL; END;

  BEGIN
    PERFORM public.finance_ar_aging_reconciliation(v_org, NULL, NULL, v_to);
    RAISE EXCEPTION 'finance_ar_aging_reconciliation answered for a foreign organization';
  EXCEPTION WHEN sqlstate '42501' THEN NULL; END;

  -- partner ledger family
  BEGIN
    PERFORM public.finance_partner_ledger(v_org, NULL, NULL, 'receivable', v_from, v_to, NULL, NULL, 50, 0);
    RAISE EXCEPTION 'finance_partner_ledger answered for a foreign organization';
  EXCEPTION WHEN sqlstate '42501' THEN NULL; END;

  BEGIN
    PERFORM public.finance_partner_ledger_reconciliation(v_org, NULL, NULL, 'receivable', v_to);
    RAISE EXCEPTION 'finance_partner_ledger_reconciliation answered for a foreign organization';
  EXCEPTION WHEN sqlstate '42501' THEN NULL; END;

  -- sales family
  BEGIN
    PERFORM public.finance_sales_analysis(v_org, v_from, v_to, NULL, NULL, 'customer', NULL, 0);
    RAISE EXCEPTION 'finance_sales_analysis answered for a foreign organization';
  EXCEPTION WHEN sqlstate '42501' THEN NULL; END;

  BEGIN
    PERFORM public.finance_sales_revenue_reconciliation(v_org, v_from, v_to, NULL, NULL);
    RAISE EXCEPTION 'finance_sales_revenue_reconciliation answered for a foreign organization';
  EXCEPTION WHEN sqlstate '42501' THEN NULL; END;

  -- purchases family
  BEGIN
    PERFORM public.finance_purchase_analysis(v_org, v_from, v_to, NULL, NULL, 'supplier', NULL, 0);
    RAISE EXCEPTION 'finance_purchase_analysis answered for a foreign organization';
  EXCEPTION WHEN sqlstate '42501' THEN NULL; END;

  BEGIN
    PERFORM public.finance_purchase_expense_reconciliation(v_org, v_from, v_to, NULL, NULL);
    RAISE EXCEPTION 'finance_purchase_expense_reconciliation answered for a foreign organization';
  EXCEPTION WHEN sqlstate '42501' THEN NULL; END;

  -- general-ledger family (Cash Flow, Bank/Cash dashboards, Trial Balance,
  -- Year-End closing all read through these).
  BEGIN
    PERFORM public.get_account_movements(v_org, v_from, v_to, NULL, NULL);
    RAISE EXCEPTION 'get_account_movements answered for a foreign organization';
  EXCEPTION WHEN sqlstate '42501' THEN NULL; END;

  BEGIN
    PERFORM public.get_account_balances(v_org, NULL, NULL);
    RAISE EXCEPTION 'get_account_balances answered for a foreign organization';
  EXCEPTION WHEN sqlstate '42501' THEN NULL; END;

  BEGIN
    PERFORM public.get_general_ledger(v_org, v_from, v_to, NULL, NULL, false, NULL);
    RAISE EXCEPTION 'get_general_ledger answered for a foreign organization';
  EXCEPTION WHEN sqlstate '42501' THEN NULL; END;

  BEGIN
    PERFORM public.get_gl_transactions(v_org, v_from, v_to, NULL, NULL);
    RAISE EXCEPTION 'get_gl_transactions answered for a foreign organization';
  EXCEPTION WHEN sqlstate '42501' THEN NULL; END;

  BEGIN
    PERFORM public.check_balance_integrity(v_org, NULL);
    RAISE EXCEPTION 'check_balance_integrity answered for a foreign organization';
  EXCEPTION WHEN sqlstate '42501' THEN NULL; END;
END $$;

-- ---------------------------------------------------------------------------
-- 5b) `get_account_balance_at_date` is account-scoped rather than org-scoped,
--     so it sits outside the matrix (its first argument is an account id).
--     It must still resolve the account's owning organisation and gate on it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  SELECT p.oid, p.prosrc, p.prosecdef, p.proconfig INTO r
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_account_balance_at_date';
  IF r IS NULL THEN
    RAISE EXCEPTION 'get_account_balance_at_date is missing';
  END IF;
  IF NOT r.prosecdef THEN
    RAISE EXCEPTION 'get_account_balance_at_date is not SECURITY DEFINER';
  END IF;
  IF COALESCE(array_to_string(r.proconfig, ','), '') !~ 'search_path=' THEN
    RAISE EXCEPTION 'get_account_balance_at_date has no pinned search_path';
  END IF;
  IF r.prosrc !~ 'finance_can_read_org' THEN
    RAISE EXCEPTION 'get_account_balance_at_date never calls finance_can_read_org';
  END IF;
  IF has_function_privilege('anon', r.oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'get_account_balance_at_date is executable by anon';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6) The drill-down surface reads base tables through RLS, so the tables the
--    partner drill-down touches must have RLS enabled.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.relname, c.relrowsecurity
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname IN ('invoices', 'bills')
  LOOP
    IF NOT r.relrowsecurity THEN
      RAISE EXCEPTION 'table %.% has RLS disabled — drill-down would leak across tenants', 'public', r.relname;
    END IF;
  END LOOP;
END $$;

DROP TABLE IF EXISTS _reporting_matrix;
