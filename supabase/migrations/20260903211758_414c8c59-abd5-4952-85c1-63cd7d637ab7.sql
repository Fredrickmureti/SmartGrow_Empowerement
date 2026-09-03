CREATE OR REPLACE VIEW public.v_employees_canonical
WITH (security_invoker = true) AS
SELECT
  e.id,
  e.organization_id,
  e.business_id,
  e.user_id,
  e.employee_number,
  e.first_name,
  e.last_name,
  (COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, '')) AS full_name,
  e.email,
  e.work_email,
  e.phone,
  e.avatar_url,
  e.department_id,
  e.manager_id,
  e.employment_type,
  e.hire_date,
  e.termination_date,
  e.lifecycle_status,
  e.is_active,
  e.user_access_status,
  (e.is_active AND e.termination_date IS NULL) AS is_operationally_active,
  COALESCE(
    (SELECT a.branch_id
       FROM public.employee_branch_assignments a
      WHERE a.employee_id = e.id AND a.is_primary
      ORDER BY a.created_at DESC
      LIMIT 1),
    e.branch_id
  ) AS primary_branch_id,
  COALESCE(
    (SELECT array_agg(DISTINCT a2.branch_id)
       FROM public.employee_branch_assignments a2
      WHERE a2.employee_id = e.id AND a2.branch_id IS NOT NULL),
    CASE WHEN e.branch_id IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[e.branch_id] END
  ) AS branch_ids,
  e.created_at,
  e.updated_at
FROM public.employees e;

GRANT SELECT ON public.v_employees_canonical TO authenticated;
GRANT SELECT ON public.v_employees_canonical TO service_role;

CREATE OR REPLACE VIEW public.v_employees_safe
WITH (security_invoker = true) AS
SELECT
  c.id,
  c.organization_id,
  c.business_id,
  c.user_id,
  c.employee_number,
  c.first_name,
  c.last_name,
  c.full_name,
  c.email,
  c.work_email,
  c.phone,
  c.avatar_url,
  c.department_id,
  c.manager_id,
  c.employment_type,
  c.hire_date,
  c.termination_date,
  c.lifecycle_status,
  c.is_active,
  c.user_access_status,
  c.is_operationally_active,
  c.primary_branch_id,
  c.branch_ids,
  c.created_at,
  c.updated_at
FROM public.v_employees_canonical c;

GRANT SELECT ON public.v_employees_safe TO authenticated;
GRANT SELECT ON public.v_employees_safe TO service_role;