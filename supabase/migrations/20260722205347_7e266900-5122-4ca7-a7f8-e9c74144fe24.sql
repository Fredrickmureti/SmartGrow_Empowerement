
CREATE OR REPLACE FUNCTION public.payroll_employee_monthly_breakdown(
  p_year integer, p_employee_id uuid, p_rule_codes text[]
)
RETURNS TABLE(
  month_index integer, rule_code text, category text,
  employee_amount numeric, employer_amount numeric, taxable_amount numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH months AS (
    SELECT generate_series(1, 12)::int AS m
  ),
  base AS (
    SELECT
      EXTRACT(MONTH FROM pr.pay_period_end)::int AS month_index,
      pl.rule_code,
      pl.category::text AS category,
      pl.employee_amount,
      pl.employer_amount,
      CASE WHEN ps.taxable_income IS NOT NULL
           THEN ps.taxable_income / NULLIF(psc.cnt, 0)
           ELSE 0 END AS taxable_amount
    FROM public.payslip_lines pl
    JOIN public.payslips ps ON ps.id = pl.payslip_id
    JOIN public.payroll_runs pr ON pr.id = ps.payroll_run_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::numeric AS cnt
      FROM public.payslip_lines pl2
      WHERE pl2.payslip_id = ps.id
    ) psc ON TRUE
    WHERE ps.employee_id = p_employee_id
      AND EXTRACT(YEAR FROM pr.pay_period_end)::int = p_year
      AND pr.approved_at IS NOT NULL
      AND ps.status IN ('approved', 'posted', 'paid')
      AND (
        p_rule_codes IS NULL
        OR array_length(p_rule_codes, 1) IS NULL
        OR pl.rule_code = ANY(p_rule_codes)
      )
  ),
  agg AS (
    SELECT
      month_index, rule_code, category,
      SUM(employee_amount)::numeric AS employee_amount,
      SUM(employer_amount)::numeric AS employer_amount,
      SUM(taxable_amount)::numeric  AS taxable_amount
    FROM base
    GROUP BY 1, 2, 3
  ),
  -- Union of every (rule_code, category) pair we may emit:
  --   • one placeholder row per requested rule_code with NULL category,
  --     so callers always get a row per (month, rule_code) even when the
  --     employee had no payslip lines for that code that month;
  --   • every real (rule_code, category) pair actually observed in agg.
  effective AS (
    SELECT DISTINCT rc AS rule_code, NULL::text AS category
    FROM unnest(COALESCE(p_rule_codes, ARRAY[]::text[])) AS t(rc)
    UNION
    SELECT rule_code, category FROM agg
  ),
  grid AS (
    SELECT m.m AS month_index, e.rule_code, e.category
    FROM months m
    CROSS JOIN effective e
  )
  SELECT
    g.month_index,
    g.rule_code,
    g.category,
    COALESCE(a.employee_amount, 0)::numeric AS employee_amount,
    COALESCE(a.employer_amount, 0)::numeric AS employer_amount,
    COALESCE(a.taxable_amount,  0)::numeric AS taxable_amount
  FROM grid g
  LEFT JOIN agg a
    ON a.month_index = g.month_index
   AND a.rule_code   = g.rule_code
   AND a.category IS NOT DISTINCT FROM g.category
  -- Suppress the NULL-category placeholder for any (month, rule_code)
  -- that also has real, category-tagged rows — otherwise the JS pivot
  -- would double-count when it sums by rule_code.
  WHERE NOT (
    g.category IS NULL
    AND EXISTS (
      SELECT 1 FROM agg a2
      WHERE a2.month_index = g.month_index
        AND a2.rule_code   = g.rule_code
        AND a2.category IS NOT NULL
    )
  )
  ORDER BY g.month_index, g.rule_code, g.category NULLS LAST;
$function$;

GRANT EXECUTE ON FUNCTION public.payroll_employee_monthly_breakdown(integer, uuid, text[])
  TO authenticated, service_role, anon;
