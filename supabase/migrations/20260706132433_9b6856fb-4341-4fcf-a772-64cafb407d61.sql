-- payroll_employee_monthly_breakdown: dense 12-row grid per rule_code.
--
-- Previous shape returned one row per (month, rule_code) that actually had a
-- posted payslip, so a fiscal year with only one posted payslip produced
-- gaps that then rendered as blank rows on the P9. Certificates need a
-- canonical 12-row grid whether or not a given month has activity.
--
-- Data source stays `payslip_lines` (the only place with a month dimension);
-- `payroll_employee_ytd` is used for TOTALS only. Status filter tightened to
-- the canonical posted set (drop 'validated', which is pre-posting).

CREATE OR REPLACE FUNCTION public.payroll_employee_monthly_breakdown(
  p_year integer,
  p_employee_id uuid,
  p_rule_codes text[]
)
RETURNS TABLE(
  month_index integer,
  rule_code text,
  category text,
  employee_amount numeric,
  employer_amount numeric,
  taxable_amount numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH months AS (
    SELECT generate_series(1, 12)::int AS m
  ),
  requested_codes AS (
    SELECT DISTINCT rc
    FROM unnest(COALESCE(p_rule_codes, ARRAY[]::text[])) AS t(rc)
  ),
  observed_codes AS (
    SELECT DISTINCT pl.rule_code AS rc
    FROM public.payslip_lines pl
    JOIN public.payslips ps ON ps.id = pl.payslip_id
    JOIN public.payroll_runs pr ON pr.id = ps.payroll_run_id
    WHERE ps.employee_id = p_employee_id
      AND EXTRACT(YEAR FROM pr.pay_period_end)::int = p_year
      AND pr.approved_at IS NOT NULL
      AND ps.status IN ('approved', 'posted', 'paid')
  ),
  -- When caller passes explicit rule codes, use those. Otherwise fall back
  -- to whatever codes actually appear in the year so output is not empty.
  effective_codes AS (
    SELECT rc FROM requested_codes
    UNION
    SELECT rc FROM observed_codes
    WHERE NOT EXISTS (SELECT 1 FROM requested_codes)
  ),
  grid AS (
    SELECT m.m AS month_index, ec.rc AS rule_code
    FROM months m
    CROSS JOIN effective_codes ec
  ),
  agg AS (
    SELECT
      EXTRACT(MONTH FROM pr.pay_period_end)::int AS month_index,
      pl.rule_code,
      MAX(pl.category) AS category,
      COALESCE(SUM(pl.employee_amount), 0)::numeric AS employee_amount,
      COALESCE(SUM(pl.employer_amount), 0)::numeric AS employer_amount,
      COALESCE(SUM(
        CASE WHEN ps.taxable_income IS NOT NULL
             THEN ps.taxable_income / NULLIF(psc.cnt, 0)
             ELSE 0 END
      ), 0)::numeric AS taxable_amount
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
      AND (p_rule_codes IS NULL
           OR array_length(p_rule_codes, 1) IS NULL
           OR pl.rule_code = ANY(p_rule_codes))
    GROUP BY EXTRACT(MONTH FROM pr.pay_period_end), pl.rule_code
  )
  SELECT
    g.month_index,
    g.rule_code,
    a.category,
    COALESCE(a.employee_amount, 0)::numeric AS employee_amount,
    COALESCE(a.employer_amount, 0)::numeric AS employer_amount,
    COALESCE(a.taxable_amount,  0)::numeric AS taxable_amount
  FROM grid g
  LEFT JOIN agg a
    ON a.month_index = g.month_index
   AND a.rule_code   = g.rule_code
  ORDER BY g.month_index, g.rule_code;
$function$;

REVOKE ALL ON FUNCTION public.payroll_employee_monthly_breakdown(integer, uuid, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payroll_employee_monthly_breakdown(integer, uuid, text[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.payroll_employee_monthly_breakdown(integer, uuid, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_employee_monthly_breakdown(integer, uuid, text[]) TO service_role;

COMMENT ON FUNCTION public.payroll_employee_monthly_breakdown(integer, uuid, text[]) IS
  'Dense 12-row monthly grid per requested rule_code for a given employee and fiscal year. '
  'Months with no posted payslip activity return zeros rather than being omitted, so the P9 '
  'renderer always draws a full 12-row PAYE grid.';