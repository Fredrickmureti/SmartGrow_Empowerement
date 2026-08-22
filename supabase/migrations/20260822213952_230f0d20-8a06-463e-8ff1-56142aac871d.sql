-- Phase 4: authoritative, live Budget vs Actual reporting function.
-- Replaces the stored-actuals read with a live ledger computation, adds
-- account-nature-aware (favourable/unfavourable) variance and surfaces
-- unbudgeted P&L activity.

DROP FUNCTION IF EXISTS public.get_budget_variance_report(uuid);

CREATE OR REPLACE FUNCTION public.get_budget_variance_report(_budget_id uuid)
RETURNS TABLE(
  account_id uuid,
  account_code text,
  account_name text,
  account_type text,
  period_month integer,
  fiscal_period_id uuid,
  period_start date,
  period_end date,
  period_status text,
  budgeted_amount numeric,
  actual_amount numeric,
  variance_amount numeric,
  variance_percent numeric,
  is_favourable boolean,
  is_unbudgeted boolean
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  b public.budgets;
BEGIN
  b := public._budget_assert_read(_budget_id);

  RETURN QUERY
  WITH periods AS (
    -- The business's own monthly accounting calendar is the period authority.
    SELECT fp.id AS period_id,
           fp.start_date,
           fp.end_date,
           fp.status::text AS status,
           EXTRACT(MONTH FROM fp.start_date)::int AS period_month
    FROM public.fiscal_periods fp
    WHERE fp.business_id = b.business_id
      AND fp.period_type = 'month'
      AND EXTRACT(YEAR FROM fp.start_date)::int = b.fiscal_year
  ),
  ledger AS (
    SELECT jel.account_id,
           p.period_id,
           p.period_month,
           SUM(
             CASE
               WHEN a.account_type IN ('asset', 'expense')
                 THEN COALESCE(jel.debit, 0) - COALESCE(jel.credit, 0)
               ELSE COALESCE(jel.credit, 0) - COALESCE(jel.debit, 0)
             END
           ) AS actual_amount
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.accounts a ON a.id = jel.account_id
    JOIN periods p ON je.entry_date BETWEEN p.start_date AND p.end_date
    WHERE je.business_id = b.business_id
      AND je.status = 'posted'
      AND COALESCE(je.is_closing, false) = false
      AND COALESCE(je.is_closing_entry, false) = false
      AND COALESCE(je.is_opening_entry, false) = false
      AND COALESCE(je.is_sample_data, false) = false
      AND COALESCE(jel.is_sample_data, false) = false
      AND (b.branch_id IS NULL OR je.branch_id = b.branch_id)
    GROUP BY jel.account_id, p.period_id, p.period_month
  ),
  planned AS (
    SELECT bi.account_id,
           bi.period_month,
           COALESCE(bi.fiscal_period_id, p.period_id) AS period_id,
           SUM(bi.budgeted_amount) AS budgeted_amount
    FROM public.budget_items bi
    LEFT JOIN periods p ON p.period_month = bi.period_month
    WHERE bi.budget_id = _budget_id
    GROUP BY bi.account_id, bi.period_month, COALESCE(bi.fiscal_period_id, p.period_id)
  ),
  combined AS (
    SELECT COALESCE(pl.account_id, l.account_id) AS account_id,
           COALESCE(pl.period_month, l.period_month) AS period_month,
           COALESCE(pl.period_id, l.period_id) AS period_id,
           COALESCE(pl.budgeted_amount, 0) AS budgeted_amount,
           COALESCE(l.actual_amount, 0) AS actual_amount,
           pl.account_id IS NULL AS is_unbudgeted
    FROM planned pl
    FULL OUTER JOIN ledger l
      ON l.account_id = pl.account_id
     AND l.period_month = pl.period_month
  )
  SELECT c.account_id,
         a.code,
         a.name,
         a.account_type::text,
         c.period_month,
         c.period_id,
         p.start_date,
         p.end_date,
         p.status,
         c.budgeted_amount,
         c.actual_amount,
         -- Variance is expressed so that positive is always FAVOURABLE:
         -- spending less than planned on a cost account, or earning more
         -- than planned on a revenue account.
         CASE
           WHEN a.account_type IN ('asset', 'expense')
             THEN c.budgeted_amount - c.actual_amount
           ELSE c.actual_amount - c.budgeted_amount
         END AS variance_amount,
         CASE
           WHEN c.budgeted_amount = 0 THEN NULL
           ELSE ROUND(
             (CASE
                WHEN a.account_type IN ('asset', 'expense')
                  THEN c.budgeted_amount - c.actual_amount
                ELSE c.actual_amount - c.budgeted_amount
              END / ABS(c.budgeted_amount)) * 100, 2)
         END AS variance_percent,
         (CASE
            WHEN a.account_type IN ('asset', 'expense')
              THEN c.budgeted_amount - c.actual_amount
            ELSE c.actual_amount - c.budgeted_amount
          END) >= 0 AS is_favourable,
         c.is_unbudgeted
  FROM combined c
  JOIN public.accounts a ON a.id = c.account_id
  LEFT JOIN periods p ON p.period_id = c.period_id
  -- Unbudgeted noise is limited to operating performance accounts; a budget
  -- is a P&L plan, so balance-sheet movement is not reported as overspend.
  WHERE NOT c.is_unbudgeted
     OR (a.account_type IN ('income', 'expense') AND c.actual_amount <> 0)
  ORDER BY c.period_month, a.code;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_budget_variance_report(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_budget_variance_report(uuid) TO authenticated;