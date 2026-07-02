
-- =============================================================
-- YTD self-healing: payroll_employee_ytd becomes a projection of
-- payslip_lines instead of an incremental aggregate. Eliminates
-- the drift class that caused the "9× monthly" YTD bug.
-- =============================================================

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
  v_emp_sum numeric := 0;
  v_er_sum  numeric := 0;
  v_tax_sum numeric := 0;
  v_distinct_count integer := 0;
  v_last_end date;
  v_last_payslip uuid;
  v_category text;
BEGIN
  IF p_run IS NULL OR p_employee IS NULL OR p_business IS NULL THEN
    RETURN;
  END IF;
  SELECT pay_period_end INTO v_period_end FROM payroll_runs WHERE id = p_run;
  IF v_period_end IS NULL THEN RETURN; END IF;
  v_year := EXTRACT(YEAR FROM v_period_end)::int;
  v_country := resolve_org_country_code(p_org, p_business);

  -- Authoritative recompute from payslip_lines (the source of truth).
  SELECT
    COALESCE(SUM(COALESCE(pl.employee_amount,0)), 0),
    COALESCE(SUM(COALESCE(pl.employer_amount,0)), 0),
    COALESCE(SUM(CASE WHEN pl.taxable THEN COALESCE(pl.employee_amount,0) ELSE 0 END), 0),
    COUNT(DISTINCT pl.payslip_id)::int,
    MAX(pr.pay_period_end),
    (ARRAY_AGG(pl.payslip_id ORDER BY pr.pay_period_end DESC NULLS LAST))[1],
    MAX(pl.category::text)
  INTO v_emp_sum, v_er_sum, v_tax_sum, v_distinct_count, v_last_end, v_last_payslip, v_category
  FROM payslip_lines pl
  JOIN payroll_runs  pr ON pr.id = pl.payroll_run_id
  WHERE pl.organization_id = p_org
    AND pl.business_id     = p_business
    AND pl.employee_id     = p_employee
    AND pl.rule_code       = p_rule_code
    AND EXTRACT(YEAR FROM pr.pay_period_end)::int = v_year;

  IF v_distinct_count = 0 THEN
    -- All payslip_lines for this (employee, year, rule) are gone — drop the row.
    DELETE FROM payroll_employee_ytd
     WHERE organization_id = p_org
       AND business_id     = p_business
       AND employee_id     = p_employee
       AND fiscal_year     = v_year
       AND rule_code       = p_rule_code;
    RETURN;
  END IF;

  INSERT INTO payroll_employee_ytd (
    organization_id, business_id, employee_id, fiscal_year, rule_code,
    country_code, category,
    employee_amount, employer_amount, taxable_amount,
    last_payslip_id, last_period_end, payslip_count, updated_at
  ) VALUES (
    p_org, p_business, p_employee, v_year, p_rule_code,
    v_country, COALESCE(v_category, p_category),
    v_emp_sum, v_er_sum, v_tax_sum,
    v_last_payslip, v_last_end, v_distinct_count, now()
  )
  ON CONFLICT (organization_id, business_id, employee_id, fiscal_year, rule_code)
  DO UPDATE SET
    employee_amount = EXCLUDED.employee_amount,
    employer_amount = EXCLUDED.employer_amount,
    taxable_amount  = EXCLUDED.taxable_amount,
    payslip_count   = EXCLUDED.payslip_count,
    last_payslip_id = EXCLUDED.last_payslip_id,
    last_period_end = EXCLUDED.last_period_end,
    category        = COALESCE(EXCLUDED.category, payroll_employee_ytd.category),
    country_code    = COALESCE(EXCLUDED.country_code, payroll_employee_ytd.country_code),
    updated_at      = now();
END;
$$;

-- =============================================================
-- One-shot heal of historical drift. Rebuilds ALL rows from
-- payslip_lines. Fixes Fredrick Mureti's 9× April YTD today.
-- =============================================================
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
  (ARRAY_AGG(pl.payslip_id ORDER BY pr.pay_period_end DESC NULLS LAST))[1],
  MAX(pr.pay_period_end),
  COUNT(DISTINCT pl.payslip_id)::int,
  now()
FROM payslip_lines pl
JOIN payroll_runs pr ON pr.id = pl.payroll_run_id
WHERE pl.business_id IS NOT NULL
  AND pl.employee_id IS NOT NULL
  AND pr.pay_period_end IS NOT NULL
GROUP BY pl.organization_id, pl.business_id, pl.employee_id,
         EXTRACT(YEAR FROM pr.pay_period_end), pl.rule_code;

-- =============================================================
-- Callable reconciler for ops + cron (defense in depth).
-- =============================================================
CREATE OR REPLACE FUNCTION public.payroll_employee_ytd_reconcile(
  p_org uuid DEFAULT NULL, p_year integer DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_rebuilt integer := 0;
BEGIN
  DELETE FROM payroll_employee_ytd
   WHERE (p_org  IS NULL OR organization_id = p_org)
     AND (p_year IS NULL OR fiscal_year     = p_year);

  WITH ins AS (
    INSERT INTO payroll_employee_ytd (
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
      (ARRAY_AGG(pl.payslip_id ORDER BY pr.pay_period_end DESC NULLS LAST))[1],
      MAX(pr.pay_period_end),
      COUNT(DISTINCT pl.payslip_id)::int,
      now()
    FROM payslip_lines pl
    JOIN payroll_runs pr ON pr.id = pl.payroll_run_id
    WHERE pl.business_id IS NOT NULL
      AND pl.employee_id IS NOT NULL
      AND pr.pay_period_end IS NOT NULL
      AND (p_org  IS NULL OR pl.organization_id = p_org)
      AND (p_year IS NULL OR EXTRACT(YEAR FROM pr.pay_period_end)::int = p_year)
    GROUP BY pl.organization_id, pl.business_id, pl.employee_id,
             EXTRACT(YEAR FROM pr.pay_period_end), pl.rule_code
    RETURNING 1
  )
  SELECT count(*)::int INTO v_rebuilt FROM ins;

  RETURN COALESCE(v_rebuilt, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.payroll_employee_ytd_reconcile(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payroll_employee_ytd_reconcile(uuid, integer) TO service_role;

-- =============================================================
-- payroll_periods edit guard: locks periods that already have
-- non-draft payroll runs (mirrors Odoo's locked-period behavior).
-- =============================================================
CREATE OR REPLACE FUNCTION public.payroll_periods_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_locked_count integer;
BEGIN
  SELECT count(*) INTO v_locked_count
    FROM payroll_runs pr
   WHERE pr.business_id = OLD.business_id
     AND pr.status IN ('posted','approved','paid','reversed')
     AND pr.pay_period_start <= OLD.end_date
     AND pr.pay_period_end   >= OLD.start_date;

  IF v_locked_count > 0 THEN
    RAISE EXCEPTION
      'PAYROLL_PERIOD_LOCKED: cannot % period % (% → %) — % posted/approved/paid payroll run(s) exist for this period',
      TG_OP, OLD.period_number, OLD.start_date, OLD.end_date, v_locked_count
      USING ERRCODE = '23P01';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payroll_periods_guard_upd ON public.payroll_periods;
CREATE TRIGGER trg_payroll_periods_guard_upd
BEFORE UPDATE ON public.payroll_periods
FOR EACH ROW EXECUTE FUNCTION public.payroll_periods_guard();

DROP TRIGGER IF EXISTS trg_payroll_periods_guard_del ON public.payroll_periods;
CREATE TRIGGER trg_payroll_periods_guard_del
BEFORE DELETE ON public.payroll_periods
FOR EACH ROW EXECUTE FUNCTION public.payroll_periods_guard();

COMMENT ON FUNCTION public.payroll_employee_ytd_apply_line IS
  'YTD self-healer: recomputes the matching payroll_employee_ytd row from payslip_lines on every trigger fire. p_sign is retained for signature compatibility but is no longer used — drift is impossible.';
COMMENT ON FUNCTION public.payroll_employee_ytd_reconcile IS
  'Ops reconciler: rebuilds payroll_employee_ytd from payslip_lines for a given org/year (NULL = all). Safe to run any time.';
COMMENT ON FUNCTION public.payroll_periods_guard IS
  'Blocks UPDATE/DELETE on payroll_periods that have any posted/approved/paid/reversed payroll_runs overlapping the period.';
