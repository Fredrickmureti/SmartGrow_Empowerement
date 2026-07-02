-- Lifecycle architecture reinforcement.
--
-- Principle: draft employees are NOT operational employees. Every operational
-- HR consumer should automatically see only employees that have reached an
-- operational lifecycle stage. The hole today is that `v_employees_safe` —
-- the canonical PII-safe reader used by 22+ consumers (directory, payroll
-- readiness, leave, talent, projects, "my team", etc.) — does not filter on
-- `lifecycle_status`, so drafts leak everywhere unless each caller remembers
-- to filter client-side. We fix this at the view boundary so the class of
-- defect becomes impossible.
--
-- Changes:
--   1. `v_employees_safe` excludes drafts at the view level, and exposes
--      `lifecycle_status` as a column so callers can drop the secondary
--      lookup the old code paths needed.
--   2. New `v_employee_drafts` view is the *only* supported read source for
--      the Employees "Drafts" tab and for stale-draft maintenance. RLS on
--      `employees` (the restrictive `employees_draft_visibility` policy)
--      continues to limit visibility to the draft owner + HR.
--
-- CREATE OR REPLACE VIEW is used for v_employees_safe so existing column
-- order/types are preserved (lifecycle_status appended at the end). The
-- previous column list is reproduced verbatim.

CREATE OR REPLACE VIEW public.v_employees_safe AS
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
  WHERE c.status = ANY (ARRAY['active'::text, 'running'::text, 'new'::text])
  ORDER BY c.employee_id, c.start_date DESC NULLS LAST, c.created_at DESC
),
contract_insurance AS (
  SELECT ac_1.employee_id,
         COALESCE(sum(ccc.amount), 0::numeric) AS amount
  FROM active_contract ac_1
  LEFT JOIN public.contract_compensation_components ccc
    ON ccc.contract_id = ac_1.contract_id
   AND ccc.component_code = 'insurance_premium'::text
   AND (ccc.effective_from IS NULL OR ccc.effective_from <= CURRENT_DATE)
   AND (ccc.effective_to   IS NULL OR ccc.effective_to   >= CURRENT_DATE)
  GROUP BY ac_1.employee_id
)
SELECT
  e.id,
  e.organization_id,
  e.business_id,
  e.branch_id,
  e.user_id,
  e.manager_id,
  e.department_id,
  d.name AS department,
  e.job_position_id,
  jp.name AS "position",
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
  COALESCE(ac.contract_wage, 0::numeric)                 AS basic_salary,
  COALESCE(ac.contract_housing_allowance, 0::numeric)    AS housing_allowance,
  COALESCE(ac.contract_transport_allowance, 0::numeric)  AS transport_allowance,
  e.other_allowances,
  COALESCE(ci.amount, 0::numeric)                        AS insurance_premium,
  e.cost_rate_override,
  e.labor_burden_pct,
  e.sms_consent,
  e.sms_consent_recorded_at,
  e.created_at,
  e.updated_at,
  e.created_by,
  d.name  AS department_name,
  jp.name AS position_title,
  ac.contract_id                          AS active_contract_id,
  ac.contract_wage                        AS active_contract_wage,
  ac.contract_housing_allowance           AS active_contract_housing_allowance,
  ac.contract_transport_allowance         AS active_contract_transport_allowance,
  ac.contract_other_allowances            AS active_contract_other_allowances,
  ac.contract_start_date                  AS active_contract_start_date,
  ac.contract_end_date                    AS active_contract_end_date,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.national_id                    ELSE NULL::text END AS national_id,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.date_of_birth                  ELSE NULL::date END AS date_of_birth,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.personal_phone                 ELSE NULL::text END AS personal_phone,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.gender                         ELSE NULL::text END AS gender,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.marital_status                 ELSE NULL::text END AS marital_status,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.address_line1                  ELSE NULL::text END AS address_line1,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.address_line2                  ELSE NULL::text END AS address_line2,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.city                           ELSE NULL::text END AS city,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.county                         ELSE NULL::text END AS county,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.postal_code                    ELSE NULL::text END AS postal_code,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.country                        ELSE NULL::text END AS country,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.emergency_contact_name         ELSE NULL::text END AS emergency_contact_name,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.emergency_contact_phone        ELSE NULL::text END AS emergency_contact_phone,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id) THEN e.emergency_contact_relationship ELSE NULL::text END AS emergency_contact_relationship,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_payroll(auth.uid(), e.organization_id) THEN e.bank_name                      ELSE NULL::text END AS bank_name,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_payroll(auth.uid(), e.organization_id) THEN e.bank_branch                    ELSE NULL::text END AS bank_branch,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_payroll(auth.uid(), e.organization_id) THEN e.bank_account_number            ELSE NULL::text END AS bank_account_number,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_payroll(auth.uid(), e.organization_id) THEN e.bank_code                      ELSE NULL::text END AS bank_code,
  -- NEW: lifecycle_status appended so consumers don't need a secondary lookup.
  e.lifecycle_status::text AS lifecycle_status
FROM public.employees e
LEFT JOIN active_contract     ac ON ac.employee_id = e.id
LEFT JOIN contract_insurance  ci ON ci.employee_id = e.id
LEFT JOIN public.departments  d  ON d.id = e.department_id
LEFT JOIN public.job_positions jp ON jp.id = e.job_position_id
WHERE e.lifecycle_status <> 'draft'::public.employee_lifecycle_status;

COMMENT ON VIEW public.v_employees_safe IS
  'PII-masked employees view; excludes lifecycle_status=draft so drafts never leak into operational reads (directory default, payroll, leave, talent, projects, my-team, attendance, reports). For the Drafts tab and stale-draft maintenance use v_employee_drafts.';

-- Drafts surface for the Employees "Drafts" tab and maintenance UI.
-- Underlying base table RLS (employees_draft_visibility, RESTRICTIVE) keeps
-- this scoped to the draft owner, the linked user, and HR write users.
CREATE OR REPLACE VIEW public.v_employee_drafts AS
SELECT
  e.id,
  e.organization_id,
  e.business_id,
  e.branch_id,
  e.employee_number,
  e.first_name,
  e.last_name,
  e.email,
  e.hire_date,
  e.draft_owner_id,
  e.user_id,
  e.manager_id,
  e.department_id,
  e.created_at,
  e.updated_at,
  e.lifecycle_status::text AS lifecycle_status
FROM public.employees e
WHERE e.lifecycle_status = 'draft'::public.employee_lifecycle_status;

GRANT SELECT ON public.v_employee_drafts TO authenticated;
GRANT ALL    ON public.v_employee_drafts TO service_role;

COMMENT ON VIEW public.v_employee_drafts IS
  'Work-in-progress employee records (lifecycle_status=draft). The only supported read source for the Employees Drafts tab and abandoned-draft maintenance — never join from operational workflows.';