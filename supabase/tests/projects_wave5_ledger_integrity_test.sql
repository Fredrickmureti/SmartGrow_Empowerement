-- Projects Wave 5.4 — project ledger integrity (actual vs commitment, FX, grain).
--
-- WHAT THIS PROVES
--   1. Both ledger tables carry the Wave 5.1 columns: entry_nature, amount_base,
--      fx_rate, base_currency.
--   2. Uniqueness is grained per project (and per task / milestone), not per source
--      document, so one bill or invoice tagged to two projects saves two rows (D3).
--   3. Commitment feeders (purchase_order, sales_order) write entry_nature =
--      'commitment'; document feeders (vendor_bill, invoice, milestone, timesheet,
--      expense) write 'actual'. A PO that is later billed therefore contributes to
--      actual cost exactly once (D1).
--   4. FX is resolved through resolve_exchange_rate. A document currency with no
--      rate on file leaves amount_base NULL and fx_rate NULL — never a fabricated
--      1.0 (D2) — and compute_project_profitability reports it as unconverted
--      instead of silently understating cost.
--   5. compute_project_profitability sums amount_base for actuals only, and reports
--      committed cost / forecast revenue separately.
--   6. Budget comes from the canonical budgets domain when a budget exists for the
--      project's analytic account; the projects.budget scalar is only a fallback
--      (D4).
--   7. The manual-journal feeder goes through the two canonical writers rather than
--      inserting into the ledger tables directly (5.1e).
--
-- SAFETY: the behavioural block seeds its own fixtures and ends with
-- `RAISE EXCEPTION 'rollback: ...'`, so nothing is left behind.

-- 1) Schema + wiring contract ---------------------------------------------------
DO $$
DECLARE
  v_cols text[];
  v_def  text;
BEGIN
  FOREACH v_def IN ARRAY ARRAY['project_cost_entries','project_revenue_entries'] LOOP
    SELECT array_agg(column_name) INTO v_cols
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = v_def;
    IF NOT (v_cols @> ARRAY['entry_nature','amount_base','fx_rate','base_currency']) THEN
      RAISE EXCEPTION '% is missing the Wave 5.1 ledger columns (has: %)', v_def, v_cols;
    END IF;
  END LOOP;

  -- Uniqueness must be re-grained to project level. The old source-only index
  -- made a multi-project document unsaveable.
  IF EXISTS (
    SELECT 1 FROM pg_class WHERE relname IN ('uq_project_cost_source','uq_project_revenue_source')
  ) THEN
    RAISE EXCEPTION 'the old source-grain unique indexes are still present';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'project_cost_entries'
       AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%project_id%'
       AND indexdef LIKE '%source_id%' AND indexdef LIKE '%task_id%'
  ) THEN
    RAISE EXCEPTION 'project_cost_entries has no project+task grain unique index';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'project_revenue_entries'
       AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%project_id%'
       AND indexdef LIKE '%source_id%' AND indexdef LIKE '%milestone_id%'
  ) THEN
    RAISE EXCEPTION 'project_revenue_entries has no project+milestone grain unique index';
  END IF;

  -- The writers own FX; they must consult the canonical resolver.
  FOREACH v_def IN ARRAY ARRAY['upsert_project_cost','upsert_project_revenue'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = v_def
         AND pg_get_functiondef(p.oid) LIKE '%resolve_exchange_rate%'
    ) THEN
      RAISE EXCEPTION '% does not resolve FX through resolve_exchange_rate', v_def;
    END IF;
    -- Exactly one signature: the pre-Wave-5 overload must be gone, not shadowed.
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = v_def) <> 1 THEN
      RAISE EXCEPTION 'expected exactly one % signature', v_def;
    END IF;
  END LOOP;

  -- Commitment vs actual classification lives in the feeders.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'trg_purchase_order_to_cost';
  IF v_def IS NULL OR v_def NOT LIKE '%commitment%' THEN
    RAISE EXCEPTION 'purchase order feed is not classified as a commitment';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'trg_sales_order_to_revenue';
  IF v_def IS NULL OR v_def NOT LIKE '%commitment%' THEN
    RAISE EXCEPTION 'sales order feed is not classified as a commitment';
  END IF;

  -- 5.1e: the manual-journal feeder must not bypass the writers.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'trg_je_line_to_project_ledger';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'trg_je_line_to_project_ledger is missing';
  END IF;
  IF v_def LIKE '%INSERT INTO public.project_cost_entries%'
     OR v_def LIKE '%INSERT INTO public.project_revenue_entries%' THEN
    RAISE EXCEPTION 'trg_je_line_to_project_ledger still writes the ledger directly';
  END IF;
  IF v_def NOT LIKE '%upsert_project_cost%' OR v_def NOT LIKE '%upsert_project_revenue%' THEN
    RAISE EXCEPTION 'trg_je_line_to_project_ledger does not use the canonical writers';
  END IF;

  -- Budget authority: profitability must read the budgets domain, not only the scalar.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'compute_project_profitability' AND p.pronargs = 2;
  IF v_def NOT LIKE '%budget_items%' OR v_def NOT LIKE '%budget_source%' THEN
    RAISE EXCEPTION 'compute_project_profitability does not source budget from the budgets domain';
  END IF;
END $$;

-- 2) Behavioural ----------------------------------------------------------------
DO $$
DECLARE
  v_org      uuid := gen_random_uuid();
  v_biz      uuid := gen_random_uuid();
  v_admin    uuid := gen_random_uuid();
  v_proj_a   uuid := gen_random_uuid();
  v_proj_b   uuid := gen_random_uuid();
  v_task     uuid := gen_random_uuid();
  v_bill     uuid := gen_random_uuid();
  v_po       uuid := gen_random_uuid();
  v_inv      uuid := gen_random_uuid();
  v_so       uuid := gen_random_uuid();
  v_aa       uuid := gen_random_uuid();
  v_budget   uuid := gen_random_uuid();
  v_plan     uuid := gen_random_uuid();
  v_coa      uuid := gen_random_uuid();
  v_fin      jsonb;
  v_n        bigint;
  v_base     numeric;
  v_rate     numeric;
BEGIN
  -- ===== Seed =================================================================
  INSERT INTO auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  VALUES (v_admin, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'pj54-' || replace(v_admin::text, '-', '') || '@example.test', now(), now());

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'PJ54 Org', 'pj54-' || replace(v_org::text, '-', ''));

  INSERT INTO public.user_roles (user_id, organization_id, role, is_active)
  VALUES (v_admin, v_org, 'admin', true);

  INSERT INTO public.businesses (id, organization_id, name, country, base_currency, fiscal_year_start)
  VALUES (v_biz, v_org, 'PJ54 Ltd', 'KE', 'KES', 1);

  INSERT INTO public.organization_installed_apps (organization_id, app_id, is_active, installed_by)
  VALUES (v_org, 'projects', true, v_admin);

  INSERT INTO public.projects (id, organization_id, business_id, manager_id,
                              project_number, name, status, currency, budget)
  VALUES (v_proj_a, v_org, v_biz, v_admin, 'PJ-54A', 'Ledger A', 'active', 'KES', 100000),
         (v_proj_b, v_org, v_biz, v_admin, 'PJ-54B', 'Ledger B', 'active', 'KES', NULL);

  INSERT INTO public.project_tasks (id, organization_id, business_id, project_id, title, created_by)
  VALUES (v_task, v_org, v_biz, v_proj_a, 'T1', v_admin);

  -- ===== A) grain: one document, two projects (D3) =============================
  PERFORM public.upsert_project_cost(v_proj_a, v_org, v_biz, NULL, 'vendor_bill', v_bill,
            NULL, NULL, 4000, 'KES', now(), 'bill line for A', 'actual');
  PERFORM public.upsert_project_cost(v_proj_b, v_org, v_biz, NULL, 'vendor_bill', v_bill,
            NULL, NULL, 6000, 'KES', now(), 'bill line for B', 'actual');

  SELECT count(*) INTO v_n FROM public.project_cost_entries WHERE source_id = v_bill;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'a bill tagged to two projects must store 2 cost rows, stored %', v_n;
  END IF;

  -- Same document, same project, different task => still distinct rows.
  PERFORM public.upsert_project_cost(v_proj_a, v_org, v_biz, v_task, 'vendor_bill', v_bill,
            NULL, NULL, 1000, 'KES', now(), 'bill line tagged to a task', 'actual');
  SELECT count(*) INTO v_n FROM public.project_cost_entries
   WHERE source_id = v_bill AND project_id = v_proj_a;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'task grain not honoured on the cost ledger (rows: %)', v_n;
  END IF;

  -- Re-sending the same grain updates in place instead of duplicating.
  PERFORM public.upsert_project_cost(v_proj_a, v_org, v_biz, NULL, 'vendor_bill', v_bill,
            NULL, NULL, 4500, 'KES', now(), 'bill line for A (revised)', 'actual');
  SELECT count(*) INTO v_n FROM public.project_cost_entries
   WHERE source_id = v_bill AND project_id = v_proj_a AND task_id IS NULL;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the cost writer duplicated an existing grain (rows: %)', v_n;
  END IF;

  -- ===== B) commitment never counts as actual (D1) =============================
  PERFORM public.upsert_project_cost(v_proj_a, v_org, v_biz, NULL, 'purchase_order', v_po,
            NULL, NULL, 4500, 'KES', now(), 'PO for the same goods', 'commitment');

  PERFORM public.upsert_project_revenue(v_proj_a, v_org, v_biz, 'sales_order', v_so,
            NULL, 20000, 'KES', now(), 'order booked', 'commitment');
  PERFORM public.upsert_project_revenue(v_proj_a, v_org, v_biz, 'invoice', v_inv,
            NULL, 20000, 'KES', now(), 'order invoiced', 'actual');

  v_fin := public.compute_project_profitability(v_proj_a, v_biz);

  IF (v_fin->>'cost_total')::numeric <> 5500 THEN
    RAISE EXCEPTION 'actual cost should be 4500 + 1000 = 5500, got % (commitment leaked in?)',
      v_fin->>'cost_total';
  END IF;
  IF (v_fin->>'committed_cost_total')::numeric <> 4500 THEN
    RAISE EXCEPTION 'committed cost should be 4500, got %', v_fin->>'committed_cost_total';
  END IF;
  IF (v_fin->>'revenue_total')::numeric <> 20000 THEN
    RAISE EXCEPTION 'actual revenue should be the invoice only (20000), got %',
      v_fin->>'revenue_total';
  END IF;
  IF (v_fin->>'committed_revenue_total')::numeric <> 20000 THEN
    RAISE EXCEPTION 'forecast revenue should be the sales order (20000), got %',
      v_fin->>'committed_revenue_total';
  END IF;
  IF (v_fin->>'has_unconverted_entries')::boolean THEN
    RAISE EXCEPTION 'base-currency-only entries must not be flagged unconverted';
  END IF;

  -- ===== C) missing FX rate: NULL base, flagged, never fabricated (D2) =========
  PERFORM public.upsert_project_cost(v_proj_a, v_org, v_biz, NULL, 'expense',
            gen_random_uuid(), NULL, NULL, 300, 'JPY', now(), 'foreign expense, no rate', 'actual');

  SELECT amount_base, fx_rate INTO v_base, v_rate
    FROM public.project_cost_entries
   WHERE project_id = v_proj_a AND currency = 'JPY';
  IF v_base IS NOT NULL OR v_rate IS NOT NULL THEN
    RAISE EXCEPTION 'a currency with no rate on file must leave amount_base/fx_rate NULL (got %, %)',
      v_base, v_rate;
  END IF;

  v_fin := public.compute_project_profitability(v_proj_a, v_biz);
  IF NOT (v_fin->>'has_unconverted_entries')::boolean THEN
    RAISE EXCEPTION 'an unconvertible entry must raise has_unconverted_entries';
  END IF;
  IF (v_fin->>'unconverted_cost_count')::bigint <> 1 THEN
    RAISE EXCEPTION 'expected 1 unconverted cost row, got %', v_fin->>'unconverted_cost_count';
  END IF;
  IF (v_fin->>'cost_total')::numeric <> 5500 THEN
    RAISE EXCEPTION 'an unconvertible row must not change the base-currency total (got %)',
      v_fin->>'cost_total';
  END IF;

  -- With a rate on file the same currency converts through the canonical resolver.
  INSERT INTO public.exchange_rates (organization_id, business_id, from_currency, to_currency,
                                     rate, effective_date, source)
  VALUES (v_org, v_biz, 'JPY', 'KES', 0.9, CURRENT_DATE - 1, 'manual');

  PERFORM public.upsert_project_cost(v_proj_a, v_org, v_biz, NULL, 'expense',
            gen_random_uuid(), NULL, NULL, 100, 'JPY', now(), 'foreign expense, rate on file', 'actual');
  SELECT amount_base, fx_rate INTO v_base, v_rate
    FROM public.project_cost_entries
   WHERE project_id = v_proj_a AND currency = 'JPY' AND description LIKE '%rate on file%';
  IF v_rate <> 0.9 OR v_base <> 90 THEN
    RAISE EXCEPTION 'FX conversion wrong: rate %, base %', v_rate, v_base;
  END IF;

  -- ===== D) budget authority is the budgets domain (D4) ========================
  v_fin := public.compute_project_profitability(v_proj_a, v_biz);
  IF v_fin->>'budget_source' <> 'project_scalar' OR (v_fin->>'budget')::numeric <> 100000 THEN
    RAISE EXCEPTION 'with no budgets record the scalar is the informational fallback (got %/%)',
      v_fin->>'budget_source', v_fin->>'budget';
  END IF;

  SELECT id INTO v_coa FROM public.accounts
   WHERE organization_id = v_org LIMIT 1;

  INSERT INTO public.analytic_accounts (id, organization_id, business_id, name, code)
  VALUES (v_aa, v_org, v_biz, 'Project Ledger A', 'PJ-54A');
  UPDATE public.projects SET analytic_account_id = v_aa WHERE id = v_proj_a;

  INSERT INTO public.budgets (id, organization_id, business_id, name, fiscal_year, status, currency_code, created_by)
  VALUES (v_budget, v_org, v_biz, 'PJ54 budget', 2026, 'active', 'KES', v_admin);

  INSERT INTO public.budget_items (budget_id, business_id, analytic_account_id, account_id,
                                   period_month, budgeted_amount)
  VALUES (v_budget, v_biz, v_aa, v_coa, 1, 30000),
         (v_budget, v_biz, v_aa, v_coa, 2, 20000);

  v_fin := public.compute_project_profitability(v_proj_a, v_biz);
  IF v_fin->>'budget_source' <> 'budgets_domain' THEN
    RAISE EXCEPTION 'an active budget on the project analytic account must win, got %',
      v_fin->>'budget_source';
  END IF;
  IF (v_fin->>'budget')::numeric <> 50000 THEN
    RAISE EXCEPTION 'budget should be the sum of the budget lines (50000), got %', v_fin->>'budget';
  END IF;
  IF (v_fin->>'budget_used_pct')::numeric <> round((5500 / 50000::numeric) * 100, 2) THEN
    RAISE EXCEPTION 'budget consumption must compare actual base cost to the domain budget, got %',
      v_fin->>'budget_used_pct';
  END IF;

  RAISE EXCEPTION 'rollback: projects wave 5.4 ledger integrity test passed';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLERRM LIKE 'rollback:%' THEN
      RAISE NOTICE '%', SQLERRM;
    ELSE
      RAISE;
    END IF;
END $$;
