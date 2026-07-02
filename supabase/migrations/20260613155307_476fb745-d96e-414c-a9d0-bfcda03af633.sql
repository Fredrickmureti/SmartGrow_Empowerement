
-- Fix: payslip_count must reflect distinct payslips per rule, not number
-- of payslip_lines rows. Rules with both an employee side and an employer
-- side (e.g. NSSF, Housing Levy) were being double-counted.

CREATE OR REPLACE FUNCTION public.payroll_employee_ytd_apply_line(
  p_org uuid, p_business uuid, p_employee uuid,
  p_payslip uuid, p_run uuid, p_rule_code text, p_category text,
  p_emp numeric, p_er numeric, p_taxable_flag boolean, p_taxable_amt numeric,
  p_sign integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_period_end date;
  v_year integer;
  v_country text;
  v_distinct_count integer;
BEGIN
  IF p_run IS NULL OR p_employee IS NULL OR p_business IS NULL THEN
    RETURN;
  END IF;
  SELECT pay_period_end INTO v_period_end FROM payroll_runs WHERE id = p_run;
  IF v_period_end IS NULL THEN RETURN; END IF;
  v_year := EXTRACT(YEAR FROM v_period_end)::int;
  v_country := resolve_org_country_code(p_org, p_business);

  INSERT INTO payroll_employee_ytd (
    organization_id, business_id, employee_id, fiscal_year, rule_code,
    country_code, category,
    employee_amount, employer_amount, taxable_amount,
    last_payslip_id, last_period_end, payslip_count, updated_at
  ) VALUES (
    p_org, p_business, p_employee, v_year, p_rule_code,
    v_country, p_category,
    COALESCE(p_emp,0) * p_sign,
    COALESCE(p_er,0)  * p_sign,
    CASE WHEN p_taxable_flag THEN COALESCE(p_taxable_amt,0) * p_sign ELSE 0 END,
    p_payslip, v_period_end, 0, now()
  )
  ON CONFLICT (organization_id, business_id, employee_id, fiscal_year, rule_code)
  DO UPDATE SET
    employee_amount  = payroll_employee_ytd.employee_amount  + EXCLUDED.employee_amount,
    employer_amount  = payroll_employee_ytd.employer_amount  + EXCLUDED.employer_amount,
    taxable_amount   = payroll_employee_ytd.taxable_amount   + EXCLUDED.taxable_amount,
    last_payslip_id  = CASE WHEN p_sign > 0 THEN EXCLUDED.last_payslip_id ELSE payroll_employee_ytd.last_payslip_id END,
    last_period_end  = CASE WHEN p_sign > 0 AND (payroll_employee_ytd.last_period_end IS NULL OR EXCLUDED.last_period_end > payroll_employee_ytd.last_period_end)
                            THEN EXCLUDED.last_period_end ELSE payroll_employee_ytd.last_period_end END,
    category         = COALESCE(EXCLUDED.category, payroll_employee_ytd.category),
    country_code     = COALESCE(EXCLUDED.country_code, payroll_employee_ytd.country_code),
    updated_at       = now();

  -- Recompute payslip_count as the count of DISTINCT payslips that have a
  -- payslip_line for this (employee, fiscal_year, rule_code). This makes
  -- the count correct regardless of how many sides (employee/employer) a
  -- single rule produces per payslip.
  SELECT COUNT(DISTINCT pl.payslip_id)::int
    INTO v_distinct_count
    FROM payslip_lines pl
    JOIN payroll_runs pr ON pr.id = pl.payroll_run_id
   WHERE pl.employee_id = p_employee
     AND pl.rule_code   = p_rule_code
     AND EXTRACT(YEAR FROM pr.pay_period_end)::int = v_year;

  UPDATE payroll_employee_ytd
     SET payslip_count = COALESCE(v_distinct_count, 0)
   WHERE organization_id = p_org
     AND business_id     = p_business
     AND employee_id     = p_employee
     AND fiscal_year     = v_year
     AND rule_code       = p_rule_code;
END;
$$;

-- Backfill: rebuild payslip_count for all existing rows using the same
-- COUNT(DISTINCT payslip_id) rule so historical records like Fredrick
-- Mureti's NSSF / Housing Levy "10 periods" are corrected to 5.
UPDATE public.payroll_employee_ytd y
   SET payslip_count = COALESCE(s.distinct_payslips, 0),
       updated_at    = now()
  FROM (
    SELECT pl.employee_id,
           pl.rule_code,
           EXTRACT(YEAR FROM pr.pay_period_end)::int AS fiscal_year,
           COUNT(DISTINCT pl.payslip_id)::int       AS distinct_payslips
      FROM payslip_lines pl
      JOIN payroll_runs pr ON pr.id = pl.payroll_run_id
     WHERE pr.pay_period_end IS NOT NULL
     GROUP BY pl.employee_id, pl.rule_code, EXTRACT(YEAR FROM pr.pay_period_end)
  ) s
 WHERE y.employee_id = s.employee_id
   AND y.rule_code   = s.rule_code
   AND y.fiscal_year = s.fiscal_year;
