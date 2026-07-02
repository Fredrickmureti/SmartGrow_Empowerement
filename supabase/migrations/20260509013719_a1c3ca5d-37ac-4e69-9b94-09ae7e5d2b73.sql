-- Stage 8: payroll_diagnostics view — surfaces every payroll_run_issues row
-- joined with employee + run context so the Run Details dialog can render
-- per-employee blocker reasons (timesheets not approved, missing contract, etc.)
-- without each consumer re-implementing the joins.
CREATE OR REPLACE VIEW public.payroll_diagnostics
WITH (security_invoker = true)
AS
SELECT
  i.id,
  i.organization_id,
  i.business_id,
  i.payroll_run_id,
  i.employee_id,
  i.code,
  i.severity,
  i.message,
  i.details,
  i.created_at,
  i.resolved_at,
  i.resolved_by,
  r.payroll_number,
  r.pay_period_start,
  r.pay_period_end,
  r.status            AS run_status,
  e.first_name        AS employee_first_name,
  e.last_name         AS employee_last_name,
  e.employee_number   AS employee_number
FROM public.payroll_run_issues i
LEFT JOIN public.payroll_runs r ON r.id = i.payroll_run_id
LEFT JOIN public.employees    e ON e.id = i.employee_id;

COMMENT ON VIEW public.payroll_diagnostics IS
  'Stage 8: read-only view joining payroll_run_issues with run + employee context for Diagnostics tab.';

GRANT SELECT ON public.payroll_diagnostics TO authenticated;
