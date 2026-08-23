CREATE OR REPLACE FUNCTION public.get_budget_schedule(_budget_id uuid)
 RETURNS TABLE(
   account_id uuid,
   account_code text,
   account_name text,
   account_type text,
   section text,
   section_ordinal integer,
   fiscal_period_id uuid,
   period_month integer,
   period_ordinal integer,
   period_start date,
   period_end date,
   period_status text,
   budgeted_amount numeric
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
    SELECT m.period_id, m.start_date, m.end_date, m.status, m.period_month, m.period_ordinal
    FROM public.budget_fiscal_months(b.business_id, b.fiscal_year) m
  ),
  budget_accounts AS (
    SELECT DISTINCT a.id, a.code, a.name, a.account_type::text AS account_type
    FROM public.budget_items bi
    JOIN public.accounts a ON a.id = bi.account_id
    WHERE bi.budget_id = _budget_id
  ),
  planned AS (
    SELECT bi.account_id, bi.fiscal_period_id, SUM(bi.budgeted_amount) AS budgeted_amount
    FROM public.budget_items bi
    WHERE bi.budget_id = _budget_id
      AND bi.fiscal_period_id IS NOT NULL
    GROUP BY bi.account_id, bi.fiscal_period_id
  )
  -- Dense grid: an account budgeted in March must still show a zero in April,
  -- otherwise a spreadsheet column silently shifts.
  SELECT ba.id,
         ba.code,
         ba.name,
         ba.account_type,
         CASE ba.account_type
           WHEN 'income' THEN 'revenue'
           WHEN 'expense' THEN 'cost'
           ELSE 'other'
         END,
         CASE ba.account_type
           WHEN 'income' THEN 1
           WHEN 'expense' THEN 2
           ELSE 3
         END,
         p.period_id,
         p.period_month,
         p.period_ordinal,
         p.start_date,
         p.end_date,
         p.status,
         COALESCE(pl.budgeted_amount, 0)
  FROM budget_accounts ba
  CROSS JOIN periods p
  LEFT JOIN planned pl
    ON pl.account_id = ba.id AND pl.fiscal_period_id = p.period_id
  ORDER BY 6, ba.code, p.period_ordinal;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_budget_schedule(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_budget_schedule(uuid) TO authenticated, service_role;