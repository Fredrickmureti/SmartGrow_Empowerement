-- =====================================================================
-- Ledgers & Journals reporting engine — accounting and authorization
-- contract for `get_account_movements`, `get_general_ledger` and
-- `get_journal_report`.
--
-- Run with: psql -f supabase/tests/ledger_reports_engine_test.sql
-- Every assertion is a hard failure; the transaction is rolled back, so
-- the fixture organization never survives the run.
--
-- WHAT THIS PROVES
--   A. Catalog contract: definer, pinned search_path, org gate, no anon.
--   B. Visibility contract: drafts are invisible, a reversal PAIR is fully
--      visible (original + reversing entry), and the pair nets to zero.
--   C. Branch scoping is strict: an unbranched entry is NOT absorbed into
--      a branch-scoped run.
--   D. Balance algebra: opening + movement = closing, derived independently
--      from `journal_entry_lines` and compared to the RPC.
--   E. Pagination completeness: paging `get_journal_report` returns every
--      entry exactly once and `total_entries` matches the unpaged count.
--   F. Tenant isolation: an org-A call never returns an org-B entry.
-- =====================================================================
BEGIN;

-- The ledger RPCs gate on `finance_can_read_org`, which accepts the
-- service role. Tests run without a Supabase JWT, so claim it explicitly.
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---------------------------------------------------------------------
-- A. Catalog contract
-- ---------------------------------------------------------------------
DO $$
DECLARE
  fn   text;
  p    pg_proc%ROWTYPE;
  def  text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['get_account_movements','get_general_ledger','get_journal_report'] LOOP
    SELECT pp.* INTO p
      FROM pg_proc pp JOIN pg_namespace n ON n.oid = pp.pronamespace
     WHERE n.nspname = 'public' AND pp.proname = fn;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ledger RPC % is missing', fn;
    END IF;
    IF (SELECT count(*) FROM pg_proc pp JOIN pg_namespace n ON n.oid = pp.pronamespace
         WHERE n.nspname = 'public' AND pp.proname = fn) <> 1 THEN
      RAISE EXCEPTION '% must exist exactly once (no ungated overload)', fn;
    END IF;
    IF NOT p.prosecdef THEN
      RAISE EXCEPTION '% must be SECURITY DEFINER', fn;
    END IF;
    IF p.proconfig IS NULL
       OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%') THEN
      RAISE EXCEPTION '% must pin search_path', fn;
    END IF;
    IF has_function_privilege('anon', p.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% must not be executable by anon', fn;
    END IF;

    def := pg_get_functiondef(p.oid);
    IF def NOT LIKE '%finance_can_read_org%' THEN
      RAISE EXCEPTION '% must gate on finance_can_read_org', fn;
    END IF;
    IF def NOT LIKE '%ledger_visible_journal_statuses%' THEN
      RAISE EXCEPTION '% must derive visibility from ledger_visible_journal_statuses()', fn;
    END IF;
    IF def !~* '_branch_id\s+IS\s+NULL\s+OR\s+\w+\.branch_id\s*=\s*_branch_id' THEN
      RAISE EXCEPTION '% must scope branch strictly', fn;
    END IF;
  END LOOP;
END $$;

-- Draft entries are never ledger-visible; reversed originals always are.
DO $$
DECLARE v text[];
BEGIN
  SELECT public.ledger_visible_journal_statuses() INTO v;
  IF 'draft' = ANY (v) THEN
    RAISE EXCEPTION 'draft entries must not be ledger-visible';
  END IF;
  IF NOT ('posted' = ANY (v)) OR NOT ('reversed' = ANY (v)) THEN
    RAISE EXCEPTION 'ledger visibility must include posted and reversed';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- Fixture: two organizations, one company each, one branch in org A.
-- ---------------------------------------------------------------------
CREATE TEMP TABLE _lrx(k text PRIMARY KEY, v uuid) ON COMMIT DROP;

DO $$
DECLARE
  org_a uuid := gen_random_uuid();
  org_b uuid := gen_random_uuid();
  biz_a uuid := gen_random_uuid();
  biz_b uuid := gen_random_uuid();
  brx   uuid := gen_random_uuid();
  cash  uuid := gen_random_uuid();
  sales uuid := gen_random_uuid();
  cash_b uuid := gen_random_uuid();
  sales_b uuid := gen_random_uuid();
  e_branch uuid := gen_random_uuid();
  e_unbranched uuid := gen_random_uuid();
  e_orig uuid := gen_random_uuid();
  e_rev  uuid := gen_random_uuid();
  e_draft uuid := gen_random_uuid();
  e_b uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.organizations(id, name, slug)
  VALUES (org_a, 'LRX Org A', 'lrx-org-a-' || left(org_a::text, 8)),
         (org_b, 'LRX Org B', 'lrx-org-b-' || left(org_b::text, 8));

  INSERT INTO public.businesses(id, organization_id, name, country)
  VALUES (biz_a, org_a, 'LRX Company A', 'KE'),
         (biz_b, org_b, 'LRX Company B', 'KE');

  INSERT INTO public.branches(id, organization_id, business_id, name)
  VALUES (brx, org_a, biz_a, 'LRX Branch X');

  INSERT INTO public.accounts(id, organization_id, business_id, code, name, account_type)
  VALUES (cash,    org_a, biz_a, 'LRX1000', 'LRX Cash',  'asset'),
         (sales,   org_a, biz_a, 'LRX4000', 'LRX Sales', 'income'),
         (cash_b,  org_b, biz_b, 'LRX1000', 'LRX Cash B',  'asset'),
         (sales_b, org_b, biz_b, 'LRX4000', 'LRX Sales B', 'income');

  -- Entry 1 — branch X, prior period (January).
  INSERT INTO public.journal_entries(id, organization_id, business_id, branch_id, entry_number,
                                     entry_date, description, status, total_debit, total_credit)
  VALUES (e_branch, org_a, biz_a, brx, 'LRX-JE-0001', DATE '2200-01-15',
          'LRX branch entry', 'posted', 100, 100);
  INSERT INTO public.journal_entry_lines(journal_entry_id, organization_id, business_id, account_id, debit, credit)
  VALUES (e_branch, org_a, biz_a, cash, 100, 0),
         (e_branch, org_a, biz_a, sales, 0, 100);

  -- Entry 2 — unbranched, prior period. Must NOT appear in a branch-scoped run.
  INSERT INTO public.journal_entries(id, organization_id, business_id, entry_number,
                                     entry_date, description, status, total_debit, total_credit)
  VALUES (e_unbranched, org_a, biz_a, 'LRX-JE-0002', DATE '2200-01-20',
          'LRX unbranched entry', 'posted', 50, 50);
  INSERT INTO public.journal_entry_lines(journal_entry_id, organization_id, business_id, account_id, debit, credit)
  VALUES (e_unbranched, org_a, biz_a, cash, 50, 0),
         (e_unbranched, org_a, biz_a, sales, 0, 50);

  -- Entries 3 & 4 — a reversal pair inside the reporting period (February).
  INSERT INTO public.journal_entries(id, organization_id, business_id, entry_number,
                                     entry_date, description, status, total_debit, total_credit)
  VALUES (e_orig, org_a, biz_a, 'LRX-JE-0003', DATE '2200-02-05',
          'LRX original entry', 'reversed', 200, 200);
  INSERT INTO public.journal_entry_lines(journal_entry_id, organization_id, business_id, account_id, debit, credit)
  VALUES (e_orig, org_a, biz_a, cash, 200, 0),
         (e_orig, org_a, biz_a, sales, 0, 200);

  INSERT INTO public.journal_entries(id, organization_id, business_id, entry_number,
                                     entry_date, description, status, is_reversal, reversal_of_id,
                                     total_debit, total_credit)
  VALUES (e_rev, org_a, biz_a, 'LRX-JE-0004', DATE '2200-02-06',
          'LRX reversing entry', 'posted', true, e_orig, 200, 200);
  INSERT INTO public.journal_entry_lines(journal_entry_id, organization_id, business_id, account_id, debit, credit)
  VALUES (e_rev, org_a, biz_a, cash, 0, 200),
         (e_rev, org_a, biz_a, sales, 200, 0);

  -- Entry 5 — draft. Must be invisible everywhere.
  INSERT INTO public.journal_entries(id, organization_id, business_id, entry_number,
                                     entry_date, description, status, total_debit, total_credit)
  VALUES (e_draft, org_a, biz_a, 'LRX-JE-0005', DATE '2200-02-10',
          'LRX draft entry', 'draft', 999, 999);
  INSERT INTO public.journal_entry_lines(journal_entry_id, organization_id, business_id, account_id, debit, credit)
  VALUES (e_draft, org_a, biz_a, cash, 999, 0),
         (e_draft, org_a, biz_a, sales, 0, 999);

  -- Entry 6 — org B. Must never surface in an org-A call.
  INSERT INTO public.journal_entries(id, organization_id, business_id, entry_number,
                                     entry_date, description, status, total_debit, total_credit)
  VALUES (e_b, org_b, biz_b, 'LRX-JE-B001', DATE '2200-02-12',
          'LRX org B entry', 'posted', 777, 777);
  INSERT INTO public.journal_entry_lines(journal_entry_id, organization_id, business_id, account_id, debit, credit)
  VALUES (e_b, org_b, biz_b, cash_b, 777, 0),
         (e_b, org_b, biz_b, sales_b, 0, 777);

  INSERT INTO _lrx(k, v) VALUES
    ('org_a', org_a), ('org_b', org_b), ('biz_a', biz_a), ('biz_b', biz_b),
    ('branch_x', brx), ('cash', cash), ('sales', sales),
    ('e_orig', e_orig), ('e_rev', e_rev), ('e_draft', e_draft), ('e_b', e_b),
    ('e_branch', e_branch), ('e_unbranched', e_unbranched);
END $$;

-- ---------------------------------------------------------------------
-- B/D. Balance algebra and visibility via get_account_movements
-- ---------------------------------------------------------------------
DO $$
DECLARE
  org_a  uuid := (SELECT v FROM _lrx WHERE k = 'org_a');
  biz_a  uuid := (SELECT v FROM _lrx WHERE k = 'biz_a');
  cash   uuid := (SELECT v FROM _lrx WHERE k = 'cash');
  brx    uuid := (SELECT v FROM _lrx WHERE k = 'branch_x');
  opening numeric;
  movement numeric;
  closing  numeric;
  expected numeric;
BEGIN
  -- Opening (everything before Feb): 100 (branch) + 50 (unbranched) = 150 DR.
  SELECT COALESCE(sum(total_debit - total_credit), 0) INTO opening
    FROM public.get_account_movements(org_a, DATE '1900-01-01', DATE '2200-01-31', biz_a, NULL) m
   WHERE m.account_id = cash;
  IF opening <> 150 THEN
    RAISE EXCEPTION 'opening balance expected 150, got %', opening;
  END IF;

  -- February movement: the reversal pair nets to zero, the draft is invisible.
  SELECT COALESCE(sum(total_debit - total_credit), 0) INTO movement
    FROM public.get_account_movements(org_a, DATE '2200-02-01', DATE '2200-02-28', biz_a, NULL) m
   WHERE m.account_id = cash;
  IF movement <> 0 THEN
    RAISE EXCEPTION 'reversal pair must net to zero (draft excluded); got %', movement;
  END IF;

  -- Closing = opening + movement, derived independently from the lines.
  SELECT COALESCE(sum(total_debit - total_credit), 0) INTO closing
    FROM public.get_account_movements(org_a, DATE '1900-01-01', DATE '2200-02-28', biz_a, NULL) m
   WHERE m.account_id = cash;
  IF closing <> opening + movement THEN
    RAISE EXCEPTION 'opening + movement (%) <> closing (%)', opening + movement, closing;
  END IF;

  SELECT COALESCE(sum(l.debit - l.credit), 0) INTO expected
    FROM public.journal_entry_lines l
    JOIN public.journal_entries e ON e.id = l.journal_entry_id
   WHERE l.account_id = cash
     AND e.status = ANY (public.ledger_visible_journal_statuses())
     AND e.entry_date <= DATE '2200-02-28';
  IF closing <> expected THEN
    RAISE EXCEPTION 'RPC closing (%) disagrees with the journal lines (%)', closing, expected;
  END IF;

  -- C. Branch scoping is strict: only the 100 branch entry, not the 50.
  SELECT COALESCE(sum(total_debit - total_credit), 0) INTO movement
    FROM public.get_account_movements(org_a, DATE '1900-01-01', DATE '2200-01-31', biz_a, brx) m
   WHERE m.account_id = cash;
  IF movement <> 100 THEN
    RAISE EXCEPTION 'branch-scoped run must exclude unbranched entries; expected 100, got %', movement;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- B. General Ledger shows both halves of a reversal pair, no drafts
-- ---------------------------------------------------------------------
DO $$
DECLARE
  org_a uuid := (SELECT v FROM _lrx WHERE k = 'org_a');
  biz_a uuid := (SELECT v FROM _lrx WHERE k = 'biz_a');
  cash  uuid := (SELECT v FROM _lrx WHERE k = 'cash');
  n_orig int;
  n_rev  int;
  n_draft int;
BEGIN
  SELECT
    count(*) FILTER (WHERE g.entry_number = 'LRX-JE-0003'),
    count(*) FILTER (WHERE g.entry_number = 'LRX-JE-0004'),
    count(*) FILTER (WHERE g.entry_number = 'LRX-JE-0005')
    INTO n_orig, n_rev, n_draft
  FROM public.get_general_ledger(org_a, DATE '2200-02-01', DATE '2200-02-28', biz_a,
                                 ARRAY[cash]::uuid[], false, NULL) g;

  IF n_orig < 1 THEN RAISE EXCEPTION 'reversed original vanished from the general ledger'; END IF;
  IF n_rev  < 1 THEN RAISE EXCEPTION 'reversing entry missing from the general ledger'; END IF;
  IF n_draft > 0 THEN RAISE EXCEPTION 'draft entry leaked into the general ledger'; END IF;
END $$;

-- ---------------------------------------------------------------------
-- E/F. Journal Report — pagination completeness and tenant isolation
-- ---------------------------------------------------------------------
DO $$
DECLARE
  org_a uuid := (SELECT v FROM _lrx WHERE k = 'org_a');
  biz_a uuid := (SELECT v FROM _lrx WHERE k = 'biz_a');
  brx   uuid := (SELECT v FROM _lrx WHERE k = 'branch_x');
  declared bigint;
  seen bigint;
  page_count bigint;
  off int := 0;
  ids uuid[] := ARRAY[]::uuid[];
BEGIN
  SELECT DISTINCT total_entries INTO declared
    FROM public.get_journal_report(org_a, DATE '2200-01-01', DATE '2200-12-31', biz_a, NULL, NULL, 500, 0);

  -- 4 visible entries in org A (2 January, the reversal pair in February);
  -- the draft is excluded.
  IF declared <> 4 THEN
    RAISE EXCEPTION 'journal report total_entries expected 4, got %', declared;
  END IF;

  -- Page at 1 entry per page: every entry exactly once, no duplicates.
  LOOP
    SELECT count(DISTINCT entry_id) INTO page_count
      FROM public.get_journal_report(org_a, DATE '2200-01-01', DATE '2200-12-31', biz_a, NULL, NULL, 1, off);
    EXIT WHEN page_count = 0;

    SELECT ids || array_agg(DISTINCT entry_id) INTO ids
      FROM public.get_journal_report(org_a, DATE '2200-01-01', DATE '2200-12-31', biz_a, NULL, NULL, 1, off);
    off := off + 1;
    EXIT WHEN off > 50; -- runaway guard
  END LOOP;

  seen := array_length(ids, 1);
  IF seen IS DISTINCT FROM declared THEN
    RAISE EXCEPTION 'paging returned % entries, total_entries declared %', seen, declared;
  END IF;
  IF seen <> (SELECT count(DISTINCT x) FROM unnest(ids) x) THEN
    RAISE EXCEPTION 'paging returned duplicate entries';
  END IF;

  -- Draft never appears.
  IF EXISTS (
    SELECT 1 FROM public.get_journal_report(org_a, DATE '2200-01-01', DATE '2200-12-31', biz_a, NULL, NULL, 500, 0)
     WHERE entry_number = 'LRX-JE-0005'
  ) THEN
    RAISE EXCEPTION 'draft entry leaked into the journal report';
  END IF;

  -- Tenant isolation: org B's entry is never visible from an org-A call.
  IF EXISTS (
    SELECT 1 FROM public.get_journal_report(org_a, DATE '2200-01-01', DATE '2200-12-31', NULL, NULL, NULL, 500, 0)
     WHERE entry_number = 'LRX-JE-B001'
  ) THEN
    RAISE EXCEPTION 'CRITICAL: org B entry visible from an org A journal report call';
  END IF;

  -- Branch-scoped journal report excludes unbranched entries.
  IF EXISTS (
    SELECT 1 FROM public.get_journal_report(org_a, DATE '2200-01-01', DATE '2200-12-31', biz_a, brx, NULL, 500, 0)
     WHERE entry_number = 'LRX-JE-0002'
  ) THEN
    RAISE EXCEPTION 'unbranched entry absorbed into a branch-scoped journal report';
  END IF;

  -- A branch that belongs to another organization must be rejected, not
  -- silently answered with an empty report.
  BEGIN
    PERFORM * FROM public.get_journal_report(
      (SELECT v FROM _lrx WHERE k = 'org_b'), DATE '2200-01-01', DATE '2200-12-31',
      (SELECT v FROM _lrx WHERE k = 'biz_b'), brx, NULL, 500, 0);
    RAISE EXCEPTION 'foreign branch was accepted by get_journal_report';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'foreign branch was accepted%' THEN RAISE; END IF;
  END;
END $$;

-- ---------------------------------------------------------------------
-- Trial balance identity over the whole fixture: debits = credits.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  org_a uuid := (SELECT v FROM _lrx WHERE k = 'org_a');
  biz_a uuid := (SELECT v FROM _lrx WHERE k = 'biz_a');
  dr numeric;
  cr numeric;
BEGIN
  SELECT COALESCE(sum(total_debit), 0), COALESCE(sum(total_credit), 0) INTO dr, cr
    FROM public.get_account_movements(org_a, DATE '1900-01-01', DATE '2200-12-31', biz_a, NULL);
  IF dr <> cr THEN
    RAISE EXCEPTION 'trial balance does not balance: debits % vs credits %', dr, cr;
  END IF;
END $$;

ROLLBACK;
