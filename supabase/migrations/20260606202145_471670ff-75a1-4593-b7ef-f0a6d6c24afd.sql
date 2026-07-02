-- =====================================================================
-- HR Wave 1 — PREPARE phase for C-HR-5/6 + close C-HR-AC
--
-- 1) C-HR-AC: collapse duplicate `attendance_lock_for_period` signatures
--    by dropping the 3-arg overload. The 5-arg version's last two params
--    have DEFAULTs so the original call shape keeps working.
--
-- 2) C-HR-5/6 PREPARE:
--    a. Backfill `employees.department_id` from text `department` via
--       case-insensitive match on `departments.name`.
--    b. Backfill `employees.job_position_id` from text `position` via
--       case-insensitive match on `job_positions.name`.
--    c. For each employee carrying legacy compensation but no active
--       contract, synthesise a single "auto-backfill" active contract so
--       payroll readers can transition to the contract path safely.
--    d. Rebuild `v_employees_safe` to expose new joined fields
--       (`position_title`, `active_contract_*`) alongside the legacy
--       columns so the code cutover can proceed incrementally.
--
--    The actual DROP COLUMN of the legacy fields ships in a follow-up
--    migration once every reader is cut over (ADR-style guard).
-- =====================================================================

-- ---------- 1) C-HR-AC ----------
DROP FUNCTION IF EXISTS public.attendance_lock_for_period(uuid, date, date);

-- ---------- 2a) Department text -> id backfill ----------
UPDATE public.employees e
   SET department_id = d.id
  FROM public.departments d
 WHERE e.department_id IS NULL
   AND e.department IS NOT NULL
   AND length(btrim(e.department)) > 0
   AND d.organization_id = e.organization_id
   AND lower(btrim(d.name)) = lower(btrim(e.department));

-- ---------- 2b) Position text -> id backfill ----------
UPDATE public.employees e
   SET job_position_id = jp.id
  FROM public.job_positions jp
 WHERE e.job_position_id IS NULL
   AND e."position" IS NOT NULL
   AND length(btrim(e."position")) > 0
   AND jp.organization_id = e.organization_id
   AND lower(btrim(jp.name)) = lower(btrim(e."position"));

-- ---------- 2c) Synthesise active contracts for legacy compensation ----------
INSERT INTO public.employee_contracts (
  organization_id, business_id, employee_id, name, start_date, status,
  wage, housing_allowance, transport_allowance, other_allowances,
  working_schedule, notes, created_by, created_at, updated_at
)
SELECT
  e.organization_id,
  e.business_id,
  e.id,
  'Auto-backfill from legacy compensation (HR Wave 1)',
  COALESCE(e.hire_date, CURRENT_DATE),
  'active',
  COALESCE(e.basic_salary, 0),
  COALESCE(e.housing_allowance, 0),
  COALESCE(e.transport_allowance, 0),
  COALESCE(e.other_allowances, '{}'::jsonb),
  'full_time',
  'Auto-created during HR Wave 1 backfill — replace with a proper contract.',
  e.created_by,
  now(),
  now()
FROM public.employees e
WHERE (COALESCE(e.basic_salary, 0) > 0
       OR COALESCE(e.housing_allowance, 0) > 0
       OR COALESCE(e.transport_allowance, 0) > 0
       OR COALESCE(e.insurance_premium, 0) > 0)
  AND NOT EXISTS (
    SELECT 1 FROM public.employee_contracts c
     WHERE c.employee_id = e.id AND c.status IN ('active','draft')
  );

-- ---------- 2d) Rebuild v_employees_safe with new fields ----------
DROP VIEW IF EXISTS public.v_employees_safe;

CREATE VIEW public.v_employees_safe
WITH (security_invoker = true)
AS
WITH active_contract AS (
  SELECT DISTINCT ON (c.employee_id)
    c.employee_id,
    c.wage                 AS contract_wage,
    c.housing_allowance    AS contract_housing_allowance,
    c.transport_allowance  AS contract_transport_allowance,
    c.other_allowances     AS contract_other_allowances,
    c.start_date           AS contract_start_date,
    c.end_date             AS contract_end_date,
    c.id                   AS contract_id
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
  e.basic_salary,
  e.housing_allowance,
  e.transport_allowance,
  e.other_allowances,
  e.insurance_premium,
  e.cost_rate_override,
  e.labor_burden_pct,
  e.sms_consent,
  e.sms_consent_recorded_at,
  e.created_at,
  e.updated_at,
  e.created_by,
  d.name AS department_name,
  jp.name AS position_title,
  ac.contract_id                   AS active_contract_id,
  ac.contract_wage                 AS active_contract_wage,
  ac.contract_housing_allowance    AS active_contract_housing_allowance,
  ac.contract_transport_allowance  AS active_contract_transport_allowance,
  ac.contract_other_allowances     AS active_contract_other_allowances,
  ac.contract_start_date           AS active_contract_start_date,
  ac.contract_end_date             AS active_contract_end_date,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.national_id ELSE NULL END                          AS national_id,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.date_of_birth ELSE NULL END                        AS date_of_birth,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.personal_phone ELSE NULL END                       AS personal_phone,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.gender ELSE NULL END                               AS gender,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.marital_status ELSE NULL END                       AS marital_status,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.address_line1 ELSE NULL END                        AS address_line1,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.address_line2 ELSE NULL END                        AS address_line2,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.city ELSE NULL END                                 AS city,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.county ELSE NULL END                               AS county,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.postal_code ELSE NULL END                          AS postal_code,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.country ELSE NULL END                              AS country,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.emergency_contact_name ELSE NULL END               AS emergency_contact_name,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.emergency_contact_phone ELSE NULL END              AS emergency_contact_phone,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.emergency_contact_relationship ELSE NULL END       AS emergency_contact_relationship,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_payroll(auth.uid(), e.organization_id) THEN e.bank_name ELSE NULL END                            AS bank_name,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_payroll(auth.uid(), e.organization_id) THEN e.bank_branch ELSE NULL END                          AS bank_branch,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_payroll(auth.uid(), e.organization_id) THEN e.bank_account_number ELSE NULL END                  AS bank_account_number,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_payroll(auth.uid(), e.organization_id) THEN e.bank_code ELSE NULL END                            AS bank_code
FROM public.employees e
LEFT JOIN public.departments  d  ON d.id  = e.department_id
LEFT JOIN public.job_positions jp ON jp.id = e.job_position_id
LEFT JOIN active_contract     ac ON ac.employee_id = e.id;

GRANT SELECT ON public.v_employees_safe TO authenticated;
GRANT ALL    ON public.v_employees_safe TO service_role;