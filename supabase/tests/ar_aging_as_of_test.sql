-- Aged Receivables — point-in-time engine contract (Phase 2).
--
-- WHAT THIS PROVES
-- Receivables now have the same engine shape as payables:
-- `finance_ar_open_items_as_of` is the single AR projection, and every AR
-- surface (`get_ar_summary`, `get_ar_ap_aging_from_ledger`,
-- `finance_ar_aging_reconciliation`) reads it rather than re-deriving open
-- items. A receivable figure is only trustworthy if it is a function of
-- (org, business, branch, as-of date) and NOTHING else — not the server clock,
-- not `invoices.status`, not `invoices.amount_paid`.
--
-- This file is read-only: it inspects the catalog and writes nothing.

-- ---------------------------------------------------------------------------
-- 1) Exactly one definition of each AR engine function.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.proname, count(*) AS n
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('finance_ar_open_items_as_of','finance_ar_customer_credit_as_of',
                         'finance_ar_aging_reconciliation','get_ar_summary')
     GROUP BY p.proname
  LOOP
    IF r.n <> 1 THEN
      RAISE EXCEPTION 'an AR aging function has % overloads — there must be exactly one', r.proname;
    END IF;
  END LOOP;

  FOR r IN
    SELECT unnest(ARRAY['finance_ar_open_items_as_of','finance_ar_customer_credit_as_of',
                        'finance_ar_aging_reconciliation']) AS proname
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = r.proname
    ) THEN
      RAISE EXCEPTION 'AR engine function % is missing', r.proname;
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
    SELECT p.oid, p.proname, p.prosecdef, p.proconfig, p.prosrc
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('finance_ar_open_items_as_of','finance_ar_customer_credit_as_of',
                         'finance_ar_aging_reconciliation','get_ar_summary',
                         'get_ar_ap_aging_from_ledger')
  LOOP
    IF NOT r.prosecdef THEN
      RAISE EXCEPTION '% is not SECURITY DEFINER', r.proname;
    END IF;
    IF NOT (COALESCE(array_to_string(r.proconfig, ','), '') ~ 'search_path=') THEN
      RAISE EXCEPTION '% has no pinned search_path', r.proname;
    END IF;
    IF r.prosrc !~ 'finance_can_read_org' THEN
      RAISE EXCEPTION '% has no organization guard', r.proname;
    END IF;
    IF has_function_privilege('anon', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is executable by anon', r.proname;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3) One engine: the AR consumers must call it, not re-derive open items.
--    `get_ar_ap_aging_from_ledger` in particular must no longer read the
--    always-today `finance_ar_open_items` view on its AR branch.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.proname, p.prosrc
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('get_ar_summary','get_ar_ap_aging_from_ledger',
                         'finance_ar_aging_reconciliation')
  LOOP
    IF r.prosrc !~ 'finance_ar_open_items_as_of' THEN
      RAISE EXCEPTION '% does not read the AR point-in-time engine', r.proname;
    END IF;
    IF r.prosrc ~ 'finance_ar_open_items(?!_as_of)' THEN
      RAISE EXCEPTION
        '% still reads the always-today finance_ar_open_items view', r.proname;
    END IF;
    IF r.prosrc ~ 'finance_ar_customer_credit(?!_as_of)' THEN
      RAISE EXCEPTION
        '% still reads the always-today finance_ar_customer_credit view', r.proname;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4) The engine is genuinely as-of driven: `_as_of` must bound the posting
--    date, the receipts and the credit notes — not just the aging buckets.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'finance_ar_open_items_as_of';

  IF v_src !~ 's\.entry_date <= _as_of' THEN
    RAISE EXCEPTION 'AR engine does not bound the control-account posting date by _as_of';
  END IF;
  IF v_src !~ 'p\.payment_date <= _as_of' THEN
    RAISE EXCEPTION 'AR engine counts receipts that had not happened by _as_of';
  END IF;
  IF v_src !~ 'cn\.issue_date\) <= _as_of' THEN
    RAISE EXCEPTION 'AR engine counts credit notes that had not been applied by _as_of';
  END IF;
  -- An invoice settled AFTER the as-of date was still open on it, so status
  -- must not be used to exclude paid documents.
  IF v_src ~ E'NOT IN \\(''draft'',''void'',''voided'',''cancelled'',''paid''\\)' THEN
    RAISE EXCEPTION 'AR engine excludes currently-paid invoices — breaks historical as-of';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5) Cross-organisation calls are refused, not answered with zeros.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_foreign_org uuid := gen_random_uuid();
  v_rec record;
BEGIN
  BEGIN
    SELECT * INTO v_rec
      FROM public.finance_ar_open_items_as_of(v_foreign_org, NULL, NULL, CURRENT_DATE);
    RAISE EXCEPTION 'finance_ar_open_items_as_of answered for a foreign organization';
  EXCEPTION WHEN sqlstate '42501' THEN NULL;
  END;

  BEGIN
    SELECT * INTO v_rec
      FROM public.finance_ar_customer_credit_as_of(v_foreign_org, NULL, NULL, CURRENT_DATE);
    RAISE EXCEPTION 'finance_ar_customer_credit_as_of answered for a foreign organization';
  EXCEPTION WHEN sqlstate '42501' THEN NULL;
  END;

  BEGIN
    SELECT * INTO v_rec
      FROM public.finance_ar_aging_reconciliation(v_foreign_org, NULL, NULL, CURRENT_DATE);
    RAISE EXCEPTION 'finance_ar_aging_reconciliation answered for a foreign organization';
  EXCEPTION WHEN sqlstate '42501' THEN NULL;
  END;
END $$;
