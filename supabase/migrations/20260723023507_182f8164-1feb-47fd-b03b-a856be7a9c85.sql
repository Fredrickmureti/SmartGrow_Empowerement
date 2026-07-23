CREATE OR REPLACE FUNCTION public.payroll_employee_ytd_rollup(
  p_year integer,
  p_employee_id uuid
)
RETURNS TABLE (
  rule_code text,
  category text,
  country_code text,
  employee_amount numeric,
  employer_amount numeric,
  taxable_amount numeric,
  payslip_count integer,
  last_period_end date
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH base AS (
    SELECT
      pl.rule_code,
      pl.category::text AS category,
      public.resolve_org_country_code(pl.organization_id, pl.business_id) AS country_code,
      COALESCE(pl.employee_amount, 0)::numeric AS employee_amount,
      COALESCE(pl.employer_amount, 0)::numeric AS employer_amount,
      CASE
        WHEN ps.taxable_income IS NOT NULL
          THEN (ps.taxable_income / NULLIF(psc.cnt, 0))::numeric
        ELSE 0::numeric
      END AS taxable_amount,
      ps.id AS payslip_id,
      pr.pay_period_end
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
  )
  SELECT
    b.rule_code,
    b.category,
    b.country_code,
    SUM(b.employee_amount)::numeric AS employee_amount,
    SUM(b.employer_amount)::numeric AS employer_amount,
    SUM(b.taxable_amount)::numeric AS taxable_amount,
    COUNT(DISTINCT b.payslip_id)::int AS payslip_count,
    MAX(b.pay_period_end)::date AS last_period_end
  FROM base b
  GROUP BY b.rule_code, b.category, b.country_code
  ORDER BY b.category NULLS LAST, b.rule_code;
$function$;

GRANT EXECUTE ON FUNCTION public.payroll_employee_ytd_rollup(integer, uuid) TO authenticated, service_role, anon;

COMMENT ON FUNCTION public.payroll_employee_ytd_rollup(integer, uuid) IS
  'Canonical payroll-engine YTD projection for one employee and fiscal year. Computes from approved payroll history at read time so certificates and annual earnings statements cannot render stale accumulator values.';