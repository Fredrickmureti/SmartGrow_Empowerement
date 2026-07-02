
-- TURN A — WAVE 1.1: drop legacy employee compensation/org columns
-- Backfill insurance_premium into contract_compensation_components, then drop
-- employees.{department, position, insurance_premium} and regenerate
-- v_employees_safe so it derives those values from the canonical sources
-- (departments, job_positions, employee_contracts, contract_compensation_components).

-- 1. Backfill: any non-zero insurance_premium becomes a recurring contract component
INSERT INTO public.contract_compensation_components
  (organization_id, business_id, contract_id, component_code, label, amount, recurrence, taxable, effective_from)
SELECT DISTINCT ON (c.id)
  c.organization_id,
  c.business_id,
  c.id,
  'insurance_premium',
  'Insurance premium',
  e.insurance_premium,
  'monthly',
  false,
  COALESCE(c.start_date, CURRENT_DATE)
FROM public.employees e
JOIN public.employee_contracts c
  ON c.employee_id = e.id
 AND c.status IN ('active','running','new')
WHERE e.insurance_premium IS NOT NULL
  AND e.insurance_premium > 0
  AND NOT EXISTS (
    SELECT 1 FROM public.contract_compensation_components ccc
    WHERE ccc.contract_id = c.id
      AND ccc.component_code = 'insurance_premium'
  )
ORDER BY c.id, c.start_date DESC NULLS LAST, c.created_at DESC;

-- 2. Drop the dependent view first; recreate after the column drop
DROP VIEW IF EXISTS public.v_employees_safe CASCADE;

-- 3. Drop the legacy columns
ALTER TABLE public.employees
  DROP COLUMN IF EXISTS department,
  DROP COLUMN IF EXISTS "position",
  DROP COLUMN IF EXISTS insurance_premium;

-- 4. Recreate v_employees_safe with derivations from canonical sources.
--    Backward-compat aliases: `department` ← departments.name,
--    `position` ← job_positions.name, `insurance_premium` ← sum of active
--    `contract_compensation_components` rows with code 'insurance_premium'.
CREATE VIEW public.v_employees_safe
WITH (security_invoker = true) AS
WITH active_contract AS (
  SELECT DISTINCT ON (c.employee_id)
    c.employee_id,
    c.wage                  AS contract_wage,
    c.housing_allowance     AS contract_housing_allowance,
    c.transport_allowance   AS contract_transport_allowance,
    c.other_allowances      AS contract_other_allowances,
    c.start_date            AS contract_start_date,
    c.end_date              AS contract_end_date,
    c.id                    AS contract_id
  FROM public.employee_contracts c
  WHERE c.status IN ('active','running','new')
  ORDER BY c.employee_id, c.start_date DESC NULLS LAST, c.created_at DESC
),
contract_insurance AS (
  SELECT ac.employee_id, COALESCE(SUM(ccc.amount), 0)::numeric AS amount
  FROM active_contract ac
  LEFT JOIN public.contract_compensation_components ccc
    ON ccc.contract_id = ac.contract_id
   AND ccc.component_code = 'insurance_premium'
   AND (ccc.effective_from IS NULL OR ccc.effective_from <= CURRENT_DATE)
   AND (ccc.effective_to   IS NULL OR ccc.effective_to   >= CURRENT_DATE)
  GROUP BY ac.employee_id
)
SELECT
  e.id,
  e.organization_id,
  e.business_id,
  e.branch_id,
  e.user_id,
  e.manager_id,
  e.department_id,
  d.name                              AS department,          -- alias, was legacy text col
  e.job_position_id,
  jp.name                             AS "position",          -- alias, was legacy text col
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
  COALESCE(ac.contract_wage, 0::numeric)                AS basic_salary,
  COALESCE(ac.contract_housing_allowance, 0::numeric)   AS housing_allowance,
  COALESCE(ac.contract_transport_allowance, 0::numeric) AS transport_allowance,
  e.other_allowances,
  COALESCE(ci.amount, 0::numeric)                       AS insurance_premium,
  e.cost_rate_override,
  e.labor_burden_pct,
  e.sms_consent,
  e.sms_consent_recorded_at,
  e.created_at,
  e.updated_at,
  e.created_by,
  d.name                              AS department_name,
  jp.name                             AS position_title,
  ac.contract_id                      AS active_contract_id,
  ac.contract_wage                    AS active_contract_wage,
  ac.contract_housing_allowance       AS active_contract_housing_allowance,
  ac.contract_transport_allowance     AS active_contract_transport_allowance,
  ac.contract_other_allowances        AS active_contract_other_allowances,
  ac.contract_start_date              AS active_contract_start_date,
  ac.contract_end_date                AS active_contract_end_date,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.national_id     ELSE NULL::text END AS national_id,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.date_of_birth   ELSE NULL::date END AS date_of_birth,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.personal_phone  ELSE NULL::text END AS personal_phone,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.gender          ELSE NULL::text END AS gender,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.marital_status  ELSE NULL::text END AS marital_status,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.address_line1   ELSE NULL::text END AS address_line1,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.address_line2   ELSE NULL::text END AS address_line2,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.city            ELSE NULL::text END AS city,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.county          ELSE NULL::text END AS county,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.postal_code     ELSE NULL::text END AS postal_code,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.country         ELSE NULL::text END AS country,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.emergency_contact_name         ELSE NULL::text END AS emergency_contact_name,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.emergency_contact_phone        ELSE NULL::text END AS emergency_contact_phone,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.emergency_contact_relationship ELSE NULL::text END AS emergency_contact_relationship,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_payroll(auth.uid(), e.organization_id) THEN e.bank_name           ELSE NULL::text END AS bank_name,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_payroll(auth.uid(), e.organization_id) THEN e.bank_branch         ELSE NULL::text END AS bank_branch,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_payroll(auth.uid(), e.organization_id) THEN e.bank_account_number ELSE NULL::text END AS bank_account_number,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_payroll(auth.uid(), e.organization_id) THEN e.bank_code           ELSE NULL::text END AS bank_code
FROM public.employees e
LEFT JOIN active_contract  ac ON ac.employee_id = e.id
LEFT JOIN contract_insurance ci ON ci.employee_id = e.id
LEFT JOIN public.departments  d  ON d.id  = e.department_id
LEFT JOIN public.job_positions jp ON jp.id = e.job_position_id;

GRANT SELECT ON public.v_employees_safe TO authenticated, anon, service_role;

COMMENT ON VIEW public.v_employees_safe IS
  'PII/payroll-masked employee read view. department/position/insurance_premium are derived from canonical sources (departments, job_positions, contract_compensation_components) after the legacy text columns were dropped in Wave 1.1.';
