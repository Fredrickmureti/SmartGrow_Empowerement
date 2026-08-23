-- Phase 5: analytic consumers (server-side reports)

-- 1) Budget lines gain an analytic dimension (extends the existing budget engine,
--    it does NOT create a second budget book).
ALTER TABLE public.budget_items
  ADD COLUMN IF NOT EXISTS analytic_account_id uuid REFERENCES public.analytic_accounts(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_budget_items_analytic_account
  ON public.budget_items(analytic_account_id) WHERE analytic_account_id IS NOT NULL;

-- 2) Analytic Account Statement — line level, drillable to the journal entry.
CREATE OR REPLACE FUNCTION public.analytic_account_statement(
  p_business_id uuid,
  p_date_from date,
  p_date_to date,
  p_analytic_account_id uuid DEFAULT NULL,
  p_plan_id uuid DEFAULT NULL,
  p_branch_id uuid DEFAULT NULL
)
RETURNS TABLE(
  journal_entry_id uuid,
  journal_entry_line_id uuid,
  entry_number text,
  entry_date date,
  status text,
  source_type text,
  reference text,
  account_id uuid,
  account_code text,
  account_name text,
  account_type text,
  analytic_account_id uuid,
  analytic_code text,
  analytic_name text,
  plan_id uuid,
  plan_name text,
  branch_id uuid,
  description text,
  debit numeric,
  credit numeric,
  amount numeric,
  running_balance numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT je.id,
         a.journal_entry_line_id,
         je.entry_number,
         a.entry_date,
         je.status::text,
         je.source_type,
         je.reference,
         acc.id,
         acc.code,
         acc.name,
         acc.account_type::text,
         aa.id,
         aa.code,
         aa.name,
         ap.id,
         ap.name,
         a.branch_id,
         COALESCE(a.description, jel.description, je.description),
         GREATEST(a.amount, 0),
         GREATEST(-a.amount, 0),
         a.amount,
         SUM(a.amount) OVER (
           PARTITION BY aa.id
           ORDER BY a.entry_date, je.entry_number, a.journal_entry_line_id
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         )
    FROM public.journal_entry_line_analytics a
    JOIN public.analytic_accounts aa ON aa.id = a.analytic_account_id
    JOIN public.analytic_plans ap ON ap.id = aa.plan_id
    JOIN public.journal_entries je ON je.id = a.journal_entry_id
    LEFT JOIN public.journal_entry_lines jel ON jel.id = a.journal_entry_line_id
    LEFT JOIN public.accounts acc ON acc.id = jel.account_id
   WHERE a.business_id = p_business_id
     AND a.entry_date BETWEEN p_date_from AND p_date_to
     AND je.status IN ('posted', 'reversed')
     AND (p_analytic_account_id IS NULL OR a.analytic_account_id = p_analytic_account_id)
     AND (p_plan_id IS NULL OR aa.plan_id = p_plan_id)
     AND (p_branch_id IS NULL OR a.branch_id = p_branch_id)
     AND public.user_can_access_business(auth.uid(), p_business_id)
     AND public.user_has_module_permission(auth.uid(), aa.organization_id, aa.business_id, 'financials', 'read')
   ORDER BY aa.code NULLS LAST, aa.name, a.entry_date, je.entry_number, a.journal_entry_line_id;
$$;

-- 3) P&L by Analytic Account — income/expense only, aggregated server-side.
CREATE OR REPLACE FUNCTION public.analytic_profit_and_loss(
  p_business_id uuid,
  p_date_from date,
  p_date_to date,
  p_plan_id uuid DEFAULT NULL,
  p_branch_id uuid DEFAULT NULL
)
RETURNS TABLE(
  analytic_account_id uuid,
  analytic_code text,
  analytic_name text,
  plan_id uuid,
  plan_name text,
  account_id uuid,
  account_code text,
  account_name text,
  account_type text,
  amount numeric,
  income numeric,
  expense numeric,
  margin numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT aa.id,
         aa.code,
         aa.name,
         ap.id,
         ap.name,
         acc.id,
         acc.code,
         acc.name,
         acc.account_type::text,
         COALESCE(SUM(a.amount), 0),
         COALESCE(SUM(-a.amount) FILTER (WHERE acc.account_type = 'income'), 0),
         COALESCE(SUM(a.amount) FILTER (WHERE acc.account_type = 'expense'), 0),
         COALESCE(SUM(-a.amount), 0)
    FROM public.journal_entry_line_analytics a
    JOIN public.analytic_accounts aa ON aa.id = a.analytic_account_id
    JOIN public.analytic_plans ap ON ap.id = aa.plan_id
    JOIN public.journal_entries je ON je.id = a.journal_entry_id
    JOIN public.journal_entry_lines jel ON jel.id = a.journal_entry_line_id
    JOIN public.accounts acc ON acc.id = jel.account_id
   WHERE a.business_id = p_business_id
     AND a.entry_date BETWEEN p_date_from AND p_date_to
     AND je.status IN ('posted', 'reversed')
     AND acc.account_type IN ('income', 'expense')
     AND (p_plan_id IS NULL OR aa.plan_id = p_plan_id)
     AND (p_branch_id IS NULL OR a.branch_id = p_branch_id)
     AND public.user_can_access_business(auth.uid(), p_business_id)
     AND public.user_has_module_permission(auth.uid(), aa.organization_id, aa.business_id, 'financials', 'read')
   GROUP BY aa.id, aa.code, aa.name, ap.id, ap.name, acc.id, acc.code, acc.name, acc.account_type
   ORDER BY ap.name, aa.code NULLS LAST, aa.name, acc.code;
$$;

-- 4) Budget vs Actual by Analytic Account.
CREATE OR REPLACE FUNCTION public.analytic_budget_vs_actual(
  p_business_id uuid,
  p_date_from date,
  p_date_to date,
  p_budget_id uuid DEFAULT NULL,
  p_plan_id uuid DEFAULT NULL,
  p_branch_id uuid DEFAULT NULL
)
RETURNS TABLE(
  analytic_account_id uuid,
  analytic_code text,
  analytic_name text,
  plan_id uuid,
  plan_name text,
  account_id uuid,
  account_code text,
  account_name text,
  account_type text,
  budgeted numeric,
  actual numeric,
  variance numeric,
  variance_pct numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH authz AS (
    SELECT public.user_can_access_business(auth.uid(), p_business_id)
       AND EXISTS (
             SELECT 1 FROM public.businesses b
              WHERE b.id = p_business_id
                AND public.user_has_module_permission(auth.uid(), b.organization_id, b.id, 'financials', 'read')
           ) AS ok
  ),
  budget AS (
    SELECT bi.analytic_account_id, bi.account_id, SUM(bi.budgeted_amount) AS budgeted
      FROM public.budget_items bi
      JOIN public.budgets b ON b.id = bi.budget_id
     WHERE bi.business_id = p_business_id
       AND bi.analytic_account_id IS NOT NULL
       AND b.status IN ('active', 'closed')
       AND (p_budget_id IS NULL OR b.id = p_budget_id)
       AND (p_branch_id IS NULL OR b.branch_id IS NULL OR b.branch_id = p_branch_id)
       AND make_date(b.fiscal_year, COALESCE(bi.period_month, 1), 1)
             BETWEEN date_trunc('month', p_date_from)::date AND p_date_to
     GROUP BY bi.analytic_account_id, bi.account_id
  ),
  actual AS (
    SELECT a.analytic_account_id, jel.account_id, SUM(a.amount) AS actual
      FROM public.journal_entry_line_analytics a
      JOIN public.journal_entries je ON je.id = a.journal_entry_id
      JOIN public.journal_entry_lines jel ON jel.id = a.journal_entry_line_id
     WHERE a.business_id = p_business_id
       AND a.entry_date BETWEEN p_date_from AND p_date_to
       AND je.status IN ('posted', 'reversed')
       AND (p_branch_id IS NULL OR a.branch_id = p_branch_id)
     GROUP BY a.analytic_account_id, jel.account_id
  ),
  merged AS (
    SELECT COALESCE(b.analytic_account_id, ac.analytic_account_id) AS analytic_account_id,
           COALESCE(b.account_id, ac.account_id) AS account_id,
           COALESCE(b.budgeted, 0) AS budgeted,
           COALESCE(ac.actual, 0) AS actual
      FROM budget b
      FULL JOIN actual ac
        ON ac.analytic_account_id = b.analytic_account_id
       AND ac.account_id = b.account_id
  )
  SELECT aa.id,
         aa.code,
         aa.name,
         ap.id,
         ap.name,
         acc.id,
         acc.code,
         acc.name,
         acc.account_type::text,
         m.budgeted,
         CASE WHEN acc.account_type = 'income' THEN -m.actual ELSE m.actual END,
         CASE WHEN acc.account_type = 'income' THEN -m.actual ELSE m.actual END - m.budgeted,
         CASE WHEN m.budgeted = 0 THEN NULL
              ELSE ROUND(((CASE WHEN acc.account_type = 'income' THEN -m.actual ELSE m.actual END - m.budgeted) / ABS(m.budgeted)) * 100, 2)
         END
    FROM merged m
    JOIN public.analytic_accounts aa ON aa.id = m.analytic_account_id
    JOIN public.analytic_plans ap ON ap.id = aa.plan_id
    JOIN public.accounts acc ON acc.id = m.account_id
   CROSS JOIN authz
   WHERE authz.ok
     AND aa.business_id = p_business_id
     AND (p_plan_id IS NULL OR aa.plan_id = p_plan_id)
   ORDER BY ap.name, aa.code NULLS LAST, aa.name, acc.code;
$$;

REVOKE ALL ON FUNCTION public.analytic_account_statement(uuid, date, date, uuid, uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.analytic_profit_and_loss(uuid, date, date, uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.analytic_budget_vs_actual(uuid, date, date, uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.analytic_account_statement(uuid, date, date, uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.analytic_profit_and_loss(uuid, date, date, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.analytic_budget_vs_actual(uuid, date, date, uuid, uuid, uuid) TO authenticated;