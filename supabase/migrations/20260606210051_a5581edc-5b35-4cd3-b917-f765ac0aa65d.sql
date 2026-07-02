
-- 1) Retire the legacy compensation-change logger (fired on the columns we're dropping).
DROP TRIGGER IF EXISTS trg_log_employee_compensation_change ON public.employees;
DROP FUNCTION IF EXISTS public.log_employee_compensation_change();

-- 2) Drop the existing view (it references the columns we're dropping).
DROP VIEW IF EXISTS public.v_employees_safe;

-- 3) Drop the three strictly-redundant compensation columns.
ALTER TABLE public.employees DROP COLUMN IF EXISTS basic_salary;
ALTER TABLE public.employees DROP COLUMN IF EXISTS housing_allowance;
ALTER TABLE public.employees DROP COLUMN IF EXISTS transport_allowance;

-- 4) New compensation-history logger — fires on employee_contracts instead.
CREATE OR REPLACE FUNCTION public.log_contract_compensation_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_changed boolean := false;
  v_alw jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_changed := COALESCE(NEW.wage, 0) > 0
              OR COALESCE(NEW.housing_allowance, 0) > 0
              OR COALESCE(NEW.transport_allowance, 0) > 0
              OR (NEW.other_allowances IS NOT NULL AND NEW.other_allowances::text <> '{}'::text);
  ELSE
    v_changed := COALESCE(NEW.wage, 0)               IS DISTINCT FROM COALESCE(OLD.wage, 0)
              OR COALESCE(NEW.housing_allowance, 0)  IS DISTINCT FROM COALESCE(OLD.housing_allowance, 0)
              OR COALESCE(NEW.transport_allowance, 0) IS DISTINCT FROM COALESCE(OLD.transport_allowance, 0)
              OR COALESCE(NEW.other_allowances::text, '{}') IS DISTINCT FROM COALESCE(OLD.other_allowances::text, '{}');
  END IF;

  IF NOT v_changed THEN
    RETURN NEW;
  END IF;

  v_alw := jsonb_build_object(
    'housing_allowance',   COALESCE(NEW.housing_allowance, 0),
    'transport_allowance', COALESCE(NEW.transport_allowance, 0),
    'other_allowances',    COALESCE(NEW.other_allowances, '{}'::jsonb)
  );

  INSERT INTO public.employee_compensation_history(
    organization_id, business_id, employee_id, effective_date,
    basic_salary, allowances_json, change_type, reason, created_by
  ) VALUES (
    NEW.organization_id,
    NEW.business_id,
    NEW.employee_id,
    COALESCE(NEW.start_date, CURRENT_DATE),
    COALESCE(NEW.wage, 0),
    v_alw,
    CASE WHEN TG_OP = 'INSERT' THEN 'initial' ELSE 'adjustment' END,
    CASE WHEN TG_OP = 'INSERT' THEN 'Contract created' ELSE 'Contract compensation change' END,
    auth.uid()
  );

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_log_contract_compensation_change ON public.employee_contracts;
CREATE TRIGGER trg_log_contract_compensation_change
AFTER INSERT OR UPDATE OF wage, housing_allowance, transport_allowance, other_allowances
ON public.employee_contracts
FOR EACH ROW
EXECUTE FUNCTION public.log_contract_compensation_change();

-- 5) Recreate v_employees_safe. Legacy column names preserved; values now
-- sourced from the employee's active contract via the active_contract CTE.
CREATE VIEW public.v_employees_safe
WITH (security_invoker = true) AS
WITH active_contract AS (
  SELECT DISTINCT ON (c.employee_id)
    c.employee_id,
    c.wage                       AS contract_wage,
    c.housing_allowance          AS contract_housing_allowance,
    c.transport_allowance        AS contract_transport_allowance,
    c.other_allowances           AS contract_other_allowances,
    c.start_date                 AS contract_start_date,
    c.end_date                   AS contract_end_date,
    c.id                         AS contract_id
  FROM public.employee_contracts c
  WHERE c.status = 'active'
  ORDER BY c.employee_id, c.start_date DESC NULLS LAST, c.created_at DESC
)
SELECT
  e.id,
  e.organization_id,
  e.business_id,
  e.branch_id,
  e.user_id,
  e.manager_id,
  e.department_id,
  e.department,
  e."position",
  e.job_position_id,
  e.work_location_id,
  e.employee_number,
  e.first_name,
  e.last_name,
  e.email,
  e.work_email,
  e.phone,
  e.hire_date,
  e.termination_date,
  e.employment_type,
  e.is_active,
  e.user_access_status,
  e.avatar_url,
  e.work_schedule_id,
  e.statutory_country_code,
  COALESCE(ac.contract_wage, 0)::numeric              AS basic_salary,
  COALESCE(ac.contract_housing_allowance, 0)::numeric AS housing_allowance,
  COALESCE(ac.contract_transport_allowance, 0)::numeric AS transport_allowance,
  e.other_allowances,
  e.insurance_premium,
  e.cost_rate_override,
  e.labor_burden_pct,
  e.sms_consent,
  e.sms_consent_recorded_at,
  e.created_at,
  e.updated_at,
  e.created_by,
  d.name  AS department_name,
  jp.name AS position_title,
  ac.contract_id                       AS active_contract_id,
  ac.contract_wage                     AS active_contract_wage,
  ac.contract_housing_allowance        AS active_contract_housing_allowance,
  ac.contract_transport_allowance      AS active_contract_transport_allowance,
  ac.contract_other_allowances         AS active_contract_other_allowances,
  ac.contract_start_date               AS active_contract_start_date,
  ac.contract_end_date                 AS active_contract_end_date,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.national_id           ELSE NULL END AS national_id,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.date_of_birth         ELSE NULL END AS date_of_birth,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.personal_phone        ELSE NULL END AS personal_phone,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.gender                ELSE NULL END AS gender,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.marital_status        ELSE NULL END AS marital_status,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.address_line1         ELSE NULL END AS address_line1,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.address_line2         ELSE NULL END AS address_line2,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.city                  ELSE NULL END AS city,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.county                ELSE NULL END AS county,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.postal_code           ELSE NULL END AS postal_code,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.country               ELSE NULL END AS country,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.emergency_contact_name         ELSE NULL END AS emergency_contact_name,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.emergency_contact_phone        ELSE NULL END AS emergency_contact_phone,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.emergency_contact_relationship ELSE NULL END AS emergency_contact_relationship,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_payroll(auth.uid(), e.organization_id) THEN e.bank_name             ELSE NULL END AS bank_name,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_payroll(auth.uid(), e.organization_id) THEN e.bank_branch           ELSE NULL END AS bank_branch,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_payroll(auth.uid(), e.organization_id) THEN e.bank_account_number   ELSE NULL END AS bank_account_number,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_payroll(auth.uid(), e.organization_id) THEN e.bank_code             ELSE NULL END AS bank_code
FROM public.employees e
LEFT JOIN active_contract        ac ON ac.employee_id = e.id
LEFT JOIN public.departments     d  ON d.id  = e.department_id
LEFT JOIN public.job_positions   jp ON jp.id = e.job_position_id;

GRANT SELECT ON public.v_employees_safe TO authenticated;
GRANT SELECT ON public.v_employees_safe TO service_role;

COMMENT ON VIEW public.v_employees_safe IS
  'Safe employee read view: PII masked by user_can_view_employee_private / _payroll. '
  'Legacy compensation columns (basic_salary, housing_allowance, transport_allowance) '
  'were dropped from the employees table in Wave 1.1 Phase A; the view re-exposes '
  'them under the same names sourced from the active employee_contracts row.';
