-- Analytic accounting — invariant contract (Phase 6 guard).
--
-- WHAT THIS PROVES
-- The analytic ledger is a projection of the general ledger, never a parallel
-- book. Everything asserted here is an invariant the domain must never lose:
--
--   1. `journal_entry_line_analytics` (JELA) is written only by the database
--      trigger — no client-facing INSERT/UPDATE/DELETE policy exists.
--   2. The materialising trigger fires on INSERT *and* on UPDATE of
--      `journal_entry_lines`, so a reversal (which mirrors lines) is attributed
--      too and cannot silently drop attribution.
--   3. `analytic_distributions` is a VIEW over JELA, so the old side table can
--      no longer drift from the ledger.
--   4. `analytic_balances` only counts entries that are actually in the ledger
--      (posted/reversed) — drafts and voided entries must not appear.
--   5. Tie-out: for every GL line carrying an analytic account, the JELA rows
--      net to that line's signed amount (debit - credit).
--   6. Cross-business integrity: a JELA row's analytic account belongs to the
--      same business as its journal entry.
--
-- This file is read-only: it inspects the catalog and existing rows only.

-- ---------------------------------------------------------------------------
-- 1) JELA is not client-writable.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename = 'journal_entry_line_analytics'
     AND cmd <> 'SELECT';
  IF v_bad > 0 THEN
    RAISE EXCEPTION
      'journal_entry_line_analytics has % non-SELECT policies — the analytic ledger must be trigger-written only', v_bad;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2) The materialising trigger covers INSERT and UPDATE.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  SELECT t.tgtype INTO r
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'journal_entry_lines'
     AND t.tgname = 'trg_jel_sync_analytics'
     AND NOT t.tgisinternal;

  IF r IS NULL THEN
    RAISE EXCEPTION 'trg_jel_sync_analytics is missing — nothing materialises the analytic ledger';
  END IF;

  -- pg_trigger.tgtype bitmask: 4 = INSERT, 16 = UPDATE.
  IF (r.tgtype & 4) = 0 THEN
    RAISE EXCEPTION 'trg_jel_sync_analytics does not fire on INSERT';
  END IF;
  IF (r.tgtype & 16) = 0 THEN
    RAISE EXCEPTION 'trg_jel_sync_analytics does not fire on UPDATE — reversals would lose attribution';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3) analytic_distributions is a view, not a second book.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_kind char;
BEGIN
  SELECT c.relkind INTO v_kind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'analytic_distributions';

  IF v_kind IS NULL THEN
    RETURN;  -- fully removed is also acceptable
  END IF;
  IF v_kind NOT IN ('v', 'm') THEN
    RAISE EXCEPTION
      'analytic_distributions is a table (relkind %) — it can drift from the ledger', v_kind;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4) analytic_balances counts ledger entries only.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'analytic_balances'
   LIMIT 1;

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'analytic_balances is missing — analytic reporting has no server-side source';
  END IF;
  IF v_src !~ 'posted' THEN
    RAISE EXCEPTION 'analytic_balances does not restrict to posted entries';
  END IF;
  IF v_src ~ '''void''[^e]' THEN
    RAISE EXCEPTION
      'analytic_balances compares status to ''void'' — the enum value is ''voided''; voided entries would be counted';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5) Tie-out: JELA nets to the signed GL line amount.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad
    FROM (
      SELECT jel.id,
             ROUND(COALESCE(jel.debit, 0) - COALESCE(jel.credit, 0), 2) AS gl_amount,
             ROUND(COALESCE(SUM(a.amount), 0), 2) AS analytic_amount
        FROM public.journal_entry_lines jel
        LEFT JOIN public.journal_entry_line_analytics a
               ON a.journal_entry_line_id = jel.id
       WHERE jel.analytic_account_id IS NOT NULL
       GROUP BY jel.id, jel.debit, jel.credit
    ) t
   WHERE ABS(t.gl_amount - t.analytic_amount) > 0.01;

  IF v_bad > 0 THEN
    RAISE EXCEPTION
      '% journal lines carry an analytic account whose analytic rows do not tie out to the GL amount', v_bad;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6) No analytic row crosses a company boundary.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad
    FROM public.journal_entry_line_analytics a
    JOIN public.journal_entry_lines jel ON jel.id = a.journal_entry_line_id
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.analytic_accounts aa ON aa.id = a.analytic_account_id
   WHERE aa.business_id IS DISTINCT FROM je.business_id;

  IF v_bad > 0 THEN
    RAISE EXCEPTION '% analytic rows reference an account from another company', v_bad;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 7) Phase 4 — every project is bound to exactly one analytic account, and no
--    analytic account is shared by two projects.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_unbound int; v_wrong_plan int; v_shared int;
BEGIN
  SELECT count(*) INTO v_unbound
    FROM public.projects p
   WHERE p.business_id IS NOT NULL
     AND COALESCE(p.is_template, false) = false
     AND p.analytic_account_id IS NULL;
  IF v_unbound > 0 THEN
    RAISE EXCEPTION '% project(s) have no analytic account — trg_projects_sync_analytic_account is not provisioning', v_unbound;
  END IF;

  SELECT count(*) INTO v_wrong_plan
    FROM public.projects p
    JOIN public.analytic_accounts aa ON aa.id = p.analytic_account_id
    JOIN public.analytic_plans ap ON ap.id = aa.plan_id
   WHERE ap.code <> 'project'
      OR aa.business_id IS DISTINCT FROM p.business_id;
  IF v_wrong_plan > 0 THEN
    RAISE EXCEPTION '% project analytic account(s) sit in the wrong plan or the wrong company', v_wrong_plan;
  END IF;

  SELECT count(*) INTO v_shared
    FROM (
      SELECT analytic_account_id
        FROM public.projects
       WHERE analytic_account_id IS NOT NULL
       GROUP BY analytic_account_id
      HAVING count(*) > 1
    ) t;
  IF v_shared > 0 THEN
    RAISE EXCEPTION '% analytic account(s) are shared by more than one project', v_shared;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 8) Phase 4 — a project tag on a producer line always carries analytic
--    attribution, so project cost reaches the GL analytic ledger.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_bad int;
BEGIN
  SELECT (SELECT count(*) FROM public.bill_items
           WHERE project_id IS NOT NULL AND analytic_account_id IS NULL)
       + (SELECT count(*) FROM public.invoice_items
           WHERE project_id IS NOT NULL AND analytic_account_id IS NULL)
       + (SELECT count(*) FROM public.expenses
           WHERE project_id IS NOT NULL AND analytic_account_id IS NULL)
    INTO v_bad;
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% producer row(s) are tagged with a project but carry no analytic account', v_bad;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 9) Phase 4 — the resolution triggers are installed on every producer.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(t.expected, ', ')
    INTO v_missing
    FROM (VALUES
      ('trg_projects_sync_analytic_account'),
      ('trg_bill_items_default_analytic'),
      ('trg_invoice_items_default_analytic'),
      ('trg_expenses_default_analytic')
    ) AS t(expected)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_trigger g WHERE NOT g.tgisinternal AND g.tgname = t.expected
   );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'missing analytic attribution trigger(s): %', v_missing;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 10) Phase 4 — the retired free-text project code is gone for good.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_col int; v_fn text;
BEGIN
  SELECT count(*) INTO v_col
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'projects'
     AND column_name = 'analytic_account_code';
  IF v_col > 0 THEN
    RAISE EXCEPTION 'projects.analytic_account_code is back — project attribution must resolve by foreign key, not by text';
  END IF;

  SELECT string_agg(p.proname, ', ') INTO v_fn
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND pg_get_functiondef(p.oid) LIKE '%analytic_account_code%';
  IF v_fn IS NOT NULL THEN
    RAISE EXCEPTION 'function(s) still resolve project analytics by text code: %', v_fn;
  END IF;
END $$;
