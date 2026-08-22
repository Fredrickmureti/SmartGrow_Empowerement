-- ---------- Read authorization helper ----------
CREATE OR REPLACE FUNCTION public._budget_assert_read(_budget_id uuid)
RETURNS public.budgets
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  b public.budgets;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO b FROM public.budgets WHERE id = _budget_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Budget not found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.user_can_access_business(auth.uid(), b.business_id)
     OR NOT public.user_has_module_permission(auth.uid(), b.organization_id, b.business_id, 'financials', 'read') THEN
    RAISE EXCEPTION 'You do not have permission to view budgets for this business'
      USING ERRCODE = '42501';
  END IF;

  IF b.branch_id IS NOT NULL
     AND NOT public.user_can_access_branch(auth.uid(), b.branch_id)
     AND NOT public.has_finance_permission(auth.uid(), 'finance.view_consolidated', b.business_id) THEN
    RAISE EXCEPTION 'You do not have permission to view budgets for this branch'
      USING ERRCODE = '42501';
  END IF;

  RETURN b;
END;
$$;

REVOKE ALL ON FUNCTION public._budget_assert_read(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._budget_assert_read(uuid) TO authenticated;

-- ---------- Stored actuals gain period identity ----------
ALTER TABLE public.budget_actuals
  ADD COLUMN IF NOT EXISTS fiscal_period_id uuid,
  ADD COLUMN IF NOT EXISTS calculated_by uuid;

ALTER TABLE public.budget_actuals
  DROP CONSTRAINT IF EXISTS budget_actuals_fiscal_period_id_fkey,
  ADD CONSTRAINT budget_actuals_fiscal_period_id_fkey
    FOREIGN KEY (fiscal_period_id) REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT;

-- ============================================================
-- Authoritative actuals computation
-- ============================================================
CREATE OR REPLACE FUNCTION public.recalculate_budget_actuals(_budget_id uuid)
RETURNS TABLE (
  account_id uuid,
  period_month integer,
  fiscal_period_id uuid,
  actual_amount numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  b public.budgets;
BEGIN
  b := public._budget_assert_read(_budget_id);

  DELETE FROM public.budget_actuals WHERE budget_id = _budget_id;

  WITH periods AS (
    -- The business's own monthly accounting calendar is the authority for
    -- which dates belong to which budget period.
    SELECT fp.id AS period_id,
           fp.start_date,
           fp.end_date,
           EXTRACT(MONTH FROM fp.start_date)::int AS period_month
    FROM public.fiscal_periods fp
    WHERE fp.business_id = b.business_id
      AND fp.period_type = 'month'
      AND EXTRACT(YEAR FROM fp.start_date)::int = b.fiscal_year
  ),
  lines AS (
    SELECT jel.account_id,
           p.period_id,
           p.period_month,
           -- Normal accounting direction: debit-normal accounts (asset,
           -- expense) are debit minus credit; credit-normal accounts
           -- (income, liability, equity) are credit minus debit. Both then
           -- read positive for normal activity.
           CASE
             WHEN a.account_type IN ('asset', 'expense')
               THEN COALESCE(jel.debit, 0) - COALESCE(jel.credit, 0)
             ELSE COALESCE(jel.credit, 0) - COALESCE(jel.debit, 0)
           END AS signed_amount
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.accounts a ON a.id = jel.account_id
    JOIN periods p ON je.entry_date BETWEEN p.start_date AND p.end_date
    WHERE je.business_id = b.business_id
      AND je.status = 'posted'
      -- Bookkeeping mechanics are not operating performance
      AND COALESCE(je.is_closing, false) = false
      AND COALESCE(je.is_closing_entry, false) = false
      AND COALESCE(je.is_opening_entry, false) = false
      -- Demo rows must never be reported as real spend
      AND COALESCE(je.is_sample_data, false) = false
      AND COALESCE(jel.is_sample_data, false) = false
      AND (b.branch_id IS NULL OR je.branch_id = b.branch_id)
      AND jel.account_id IN (
        SELECT bi.account_id FROM public.budget_items bi WHERE bi.budget_id = _budget_id
      )
  ),
  aggregated AS (
    SELECT l.account_id, l.period_month, l.period_id, SUM(l.signed_amount) AS actual_amount
    FROM lines l
    GROUP BY l.account_id, l.period_month, l.period_id
  )
  INSERT INTO public.budget_actuals (
    organization_id, business_id, budget_id, account_id, period_month,
    fiscal_period_id, fiscal_year, actual_amount, calculated_at, calculated_by
  )
  SELECT b.organization_id, b.business_id, _budget_id, ag.account_id, ag.period_month,
         ag.period_id, b.fiscal_year, ag.actual_amount, now(), auth.uid()
  FROM aggregated ag;

  RETURN QUERY
  SELECT ba.account_id, ba.period_month, ba.fiscal_period_id, ba.actual_amount
  FROM public.budget_actuals ba
  WHERE ba.budget_id = _budget_id
  ORDER BY ba.period_month, ba.account_id;
END;
$$;

REVOKE ALL ON FUNCTION public.recalculate_budget_actuals(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.recalculate_budget_actuals(uuid) TO authenticated;

-- ============================================================
-- Variance report: plan + actuals in one authorized read
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_budget_variance_report(_budget_id uuid)
RETURNS TABLE (
  account_id uuid,
  account_code text,
  account_name text,
  account_type text,
  period_month integer,
  fiscal_period_id uuid,
  period_status text,
  budgeted_amount numeric,
  actual_amount numeric,
  variance_amount numeric,
  variance_percent numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  b public.budgets;
BEGIN
  b := public._budget_assert_read(_budget_id);

  RETURN QUERY
  SELECT bi.account_id,
         a.code,
         a.name,
         a.account_type::text,
         bi.period_month,
         bi.fiscal_period_id,
         fp.status,
         bi.budgeted_amount,
         COALESCE(ba.actual_amount, 0),
         bi.budgeted_amount - COALESCE(ba.actual_amount, 0),
         CASE
           WHEN bi.budgeted_amount = 0 THEN NULL
           ELSE ROUND(((bi.budgeted_amount - COALESCE(ba.actual_amount, 0)) / bi.budgeted_amount) * 100, 2)
         END
  FROM public.budget_items bi
  JOIN public.accounts a ON a.id = bi.account_id
  LEFT JOIN public.fiscal_periods fp ON fp.id = bi.fiscal_period_id
  LEFT JOIN public.budget_actuals ba
    ON ba.budget_id = bi.budget_id
   AND ba.account_id = bi.account_id
   AND ba.period_month = bi.period_month
  WHERE bi.budget_id = _budget_id
  ORDER BY bi.period_month, a.code;
END;
$$;

REVOKE ALL ON FUNCTION public.get_budget_variance_report(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_budget_variance_report(uuid) TO authenticated;