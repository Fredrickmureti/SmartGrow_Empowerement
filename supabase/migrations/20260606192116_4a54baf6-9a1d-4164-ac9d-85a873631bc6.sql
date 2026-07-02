
DROP VIEW IF EXISTS public.v_employees_safe;
CREATE VIEW public.v_employees_safe
WITH (security_invoker = true)
AS
SELECT
  e.id, e.organization_id, e.business_id, e.branch_id, e.user_id, e.manager_id,
  e.department_id, e.department, e.position, e.job_position_id, e.work_location_id,
  e.employee_number, e.first_name, e.last_name, e.email, e.work_email, e.phone,
  e.hire_date, e.termination_date, e.employment_type, e.is_active,
  e.user_access_status, e.avatar_url, e.work_schedule_id, e.statutory_country_code,
  e.basic_salary, e.housing_allowance, e.transport_allowance, e.other_allowances,
  e.insurance_premium, e.cost_rate_override, e.labor_burden_pct,
  e.sms_consent, e.sms_consent_recorded_at,
  e.created_at, e.updated_at, e.created_by,
  d.name AS department_name,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id)
       THEN e.national_id ELSE NULL END AS national_id,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id)
       THEN e.date_of_birth ELSE NULL END AS date_of_birth,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id)
       THEN e.personal_phone ELSE NULL END AS personal_phone,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id)
       THEN e.gender ELSE NULL END AS gender,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id)
       THEN e.marital_status ELSE NULL END AS marital_status,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id)
       THEN e.address_line1 ELSE NULL END AS address_line1,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id)
       THEN e.address_line2 ELSE NULL END AS address_line2,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id)
       THEN e.city ELSE NULL END AS city,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id)
       THEN e.county ELSE NULL END AS county,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id)
       THEN e.postal_code ELSE NULL END AS postal_code,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id)
       THEN e.country ELSE NULL END AS country,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id)
       THEN e.emergency_contact_name ELSE NULL END AS emergency_contact_name,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id)
       THEN e.emergency_contact_phone ELSE NULL END AS emergency_contact_phone,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id)
       THEN e.emergency_contact_relationship ELSE NULL END AS emergency_contact_relationship,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_payroll(auth.uid(), e.organization_id)
       THEN e.bank_name ELSE NULL END AS bank_name,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_payroll(auth.uid(), e.organization_id)
       THEN e.bank_branch ELSE NULL END AS bank_branch,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_payroll(auth.uid(), e.organization_id)
       THEN e.bank_account_number ELSE NULL END AS bank_account_number,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_payroll(auth.uid(), e.organization_id)
       THEN e.bank_code ELSE NULL END AS bank_code
FROM public.employees e
LEFT JOIN public.departments d ON d.id = e.department_id;

GRANT SELECT ON public.v_employees_safe TO authenticated;
