
CREATE TABLE IF NOT EXISTS public.payroll_employee_ytd (
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  fiscal_year integer NOT NULL,
  rule_code text NOT NULL,
  country_code text,
  category text,
  employee_amount numeric(18,4) NOT NULL DEFAULT 0,
  employer_amount numeric(18,4) NOT NULL DEFAULT 0,
  taxable_amount  numeric(18,4) NOT NULL DEFAULT 0,
  last_payslip_id uuid,
  last_period_end date,
  payslip_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, business_id, employee_id, fiscal_year, rule_code)
);

CREATE INDEX IF NOT EXISTS payroll_employee_ytd_lookup_idx
  ON public.payroll_employee_ytd (organization_id, business_id, fiscal_year, employee_id);

ALTER TABLE public.payroll_employee_ytd ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payroll_employee_ytd_select ON public.payroll_employee_ytd;
CREATE POLICY payroll_employee_ytd_select ON public.payroll_employee_ytd
  FOR SELECT USING (
    business_id IS NOT NULL
    AND user_can_access_business(auth.uid(), business_id)
    AND user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'read')
  );

DROP POLICY IF EXISTS payroll_employee_ytd_write ON public.payroll_employee_ytd;
CREATE POLICY payroll_employee_ytd_write ON public.payroll_employee_ytd
  FOR ALL USING (
    business_id IS NOT NULL
    AND user_can_access_business(auth.uid(), business_id)
    AND user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write')
  ) WITH CHECK (
    business_id IS NOT NULL
    AND user_can_access_business(auth.uid(), business_id)
    AND user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write')
  );

CREATE OR REPLACE FUNCTION public.resolve_org_country_code(p_org uuid, p_business uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT lp.country_code
       FROM installed_localization_packs ilp
       JOIN localization_packs lp ON lp.id = ilp.pack_id
      WHERE ilp.organization_id = p_org
        AND (ilp.business_id IS NULL OR ilp.business_id = p_business)
        AND ilp.status = 'installed'
      ORDER BY ilp.business_id NULLS LAST
      LIMIT 1),
    (SELECT country FROM businesses WHERE id = p_business)
  );
$$;

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
    p_payslip, v_period_end, p_sign, now()
  )
  ON CONFLICT (organization_id, business_id, employee_id, fiscal_year, rule_code)
  DO UPDATE SET
    employee_amount  = payroll_employee_ytd.employee_amount  + EXCLUDED.employee_amount,
    employer_amount  = payroll_employee_ytd.employer_amount  + EXCLUDED.employer_amount,
    taxable_amount   = payroll_employee_ytd.taxable_amount   + EXCLUDED.taxable_amount,
    payslip_count    = payroll_employee_ytd.payslip_count    + p_sign,
    last_payslip_id  = CASE WHEN p_sign > 0 THEN EXCLUDED.last_payslip_id ELSE payroll_employee_ytd.last_payslip_id END,
    last_period_end  = CASE WHEN p_sign > 0 AND (payroll_employee_ytd.last_period_end IS NULL OR EXCLUDED.last_period_end > payroll_employee_ytd.last_period_end)
                            THEN EXCLUDED.last_period_end ELSE payroll_employee_ytd.last_period_end END,
    category         = COALESCE(EXCLUDED.category, payroll_employee_ytd.category),
    country_code     = COALESCE(EXCLUDED.country_code, payroll_employee_ytd.country_code),
    updated_at       = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_payslip_lines_ytd()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM payroll_employee_ytd_apply_line(
      NEW.organization_id, NEW.business_id, NEW.employee_id,
      NEW.payslip_id, NEW.payroll_run_id, NEW.rule_code, NEW.category::text,
      NEW.employee_amount, NEW.employer_amount, NEW.taxable, NEW.employee_amount, 1);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM payroll_employee_ytd_apply_line(
      OLD.organization_id, OLD.business_id, OLD.employee_id,
      OLD.payslip_id, OLD.payroll_run_id, OLD.rule_code, OLD.category::text,
      OLD.employee_amount, OLD.employer_amount, OLD.taxable, OLD.employee_amount, -1);
  ELSIF TG_OP = 'UPDATE' THEN
    PERFORM payroll_employee_ytd_apply_line(
      OLD.organization_id, OLD.business_id, OLD.employee_id,
      OLD.payslip_id, OLD.payroll_run_id, OLD.rule_code, OLD.category::text,
      OLD.employee_amount, OLD.employer_amount, OLD.taxable, OLD.employee_amount, -1);
    PERFORM payroll_employee_ytd_apply_line(
      NEW.organization_id, NEW.business_id, NEW.employee_id,
      NEW.payslip_id, NEW.payroll_run_id, NEW.rule_code, NEW.category::text,
      NEW.employee_amount, NEW.employer_amount, NEW.taxable, NEW.employee_amount, 1);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS payslip_lines_ytd_aiud ON public.payslip_lines;
CREATE TRIGGER payslip_lines_ytd_aiud
AFTER INSERT OR UPDATE OR DELETE ON public.payslip_lines
FOR EACH ROW EXECUTE FUNCTION public.trg_payslip_lines_ytd();

CREATE OR REPLACE FUNCTION public.payroll_employee_ytd_rollup(
  p_year integer, p_employee_id uuid
)
RETURNS TABLE (
  rule_code text, category text, country_code text,
  employee_amount numeric, employer_amount numeric, taxable_amount numeric,
  payslip_count integer, last_period_end date
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT rule_code, category, country_code,
         employee_amount, employer_amount, taxable_amount,
         payslip_count, last_period_end
  FROM payroll_employee_ytd
  WHERE employee_id = p_employee_id
    AND fiscal_year = p_year
  ORDER BY category NULLS LAST, rule_code;
$$;

TRUNCATE public.payroll_employee_ytd;

INSERT INTO public.payroll_employee_ytd (
  organization_id, business_id, employee_id, fiscal_year, rule_code,
  country_code, category,
  employee_amount, employer_amount, taxable_amount,
  last_payslip_id, last_period_end, payslip_count, updated_at
)
SELECT
  pl.organization_id, pl.business_id, pl.employee_id,
  EXTRACT(YEAR FROM pr.pay_period_end)::int,
  pl.rule_code,
  resolve_org_country_code(pl.organization_id, pl.business_id),
  MAX(pl.category::text),
  SUM(COALESCE(pl.employee_amount,0)),
  SUM(COALESCE(pl.employer_amount,0)),
  SUM(CASE WHEN pl.taxable THEN COALESCE(pl.employee_amount,0) ELSE 0 END),
  (ARRAY_AGG(pl.payslip_id ORDER BY pr.pay_period_end DESC))[1],
  MAX(pr.pay_period_end),
  COUNT(*)::int,
  now()
FROM payslip_lines pl
JOIN payroll_runs pr ON pr.id = pl.payroll_run_id
WHERE pl.business_id IS NOT NULL
  AND pl.employee_id IS NOT NULL
  AND pr.pay_period_end IS NOT NULL
GROUP BY pl.organization_id, pl.business_id, pl.employee_id,
         EXTRACT(YEAR FROM pr.pay_period_end), pl.rule_code;

COMMENT ON TABLE public.payroll_employee_ytd IS
  'Per-employee per-fiscal-year per-rule running totals. Maintained by trigger on payslip_lines. Source of truth for tax certificates and annual statutory returns.';
