CREATE OR REPLACE FUNCTION public.payroll_employee_monthly_breakdown(p_year integer, p_employee_id uuid, p_rule_codes text[])
RETURNS TABLE(month_index integer, rule_code text, category text, employee_amount numeric, employer_amount numeric, taxable_amount numeric)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    EXTRACT(MONTH FROM pr.pay_period_end)::int AS month_index,
    pl.rule_code,
    MAX(pl.category) AS category,
    COALESCE(SUM(pl.employee_amount), 0)::numeric AS employee_amount,
    COALESCE(SUM(pl.employer_amount), 0)::numeric AS employer_amount,
    COALESCE(SUM(
      CASE WHEN ps.taxable_income IS NOT NULL
           THEN ps.taxable_income / NULLIF(ps_line_count.cnt, 0)
           ELSE 0 END
    ), 0)::numeric AS taxable_amount
  FROM public.payslip_lines pl
  JOIN public.payslips ps ON ps.id = pl.payslip_id
  JOIN public.payroll_runs pr ON pr.id = ps.payroll_run_id
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::numeric AS cnt
    FROM public.payslip_lines pl2
    WHERE pl2.payslip_id = ps.id
  ) ps_line_count ON true
  WHERE ps.employee_id = p_employee_id
    AND EXTRACT(YEAR FROM pr.pay_period_end)::int = p_year
    AND pr.approved_at IS NOT NULL
    AND ps.status IN ('approved', 'validated', 'posted', 'paid')
    AND (p_rule_codes IS NULL OR pl.rule_code = ANY(p_rule_codes))
  GROUP BY EXTRACT(MONTH FROM pr.pay_period_end), pl.rule_code
  ORDER BY month_index, rule_code;
$function$;

REVOKE ALL ON FUNCTION public.payroll_employee_monthly_breakdown(integer, uuid, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payroll_employee_monthly_breakdown(integer, uuid, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_employee_monthly_breakdown(integer, uuid, text[]) TO service_role;