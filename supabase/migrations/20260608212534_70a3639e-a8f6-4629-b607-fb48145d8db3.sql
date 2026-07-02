-- v_employee_setup_health: directory-level readiness for the Employees page.
-- SECURITY INVOKER (default): underlying RLS on employees, employments,
-- employee_contracts, and payroll_readiness_findings is respected.
CREATE OR REPLACE VIEW public.v_employee_setup_health AS
WITH active_emp AS (
  SELECT DISTINCT employee_id
  FROM public.employments
  WHERE end_date IS NULL
),
active_contract AS (
  SELECT DISTINCT employee_id
  FROM public.employee_contracts
  WHERE status IN ('running', 'new')
    AND (end_date IS NULL OR end_date >= CURRENT_DATE)
    AND start_date <= CURRENT_DATE
),
blocking_findings AS (
  SELECT f.subject_id AS employee_id, COUNT(*)::int AS open_blocking
  FROM public.payroll_readiness_findings f
  JOIN public.payroll_readiness_rules r ON r.id = f.rule_id
  WHERE f.subject_type = 'employee'
    AND f.status = 'fail'
    AND r.severity = 'block'
  GROUP BY f.subject_id
),
warn_findings AS (
  SELECT f.subject_id AS employee_id, COUNT(*)::int AS open_warn
  FROM public.payroll_readiness_findings f
  JOIN public.payroll_readiness_rules r ON r.id = f.rule_id
  WHERE f.subject_type = 'employee'
    AND f.status IN ('fail', 'warn')
    AND r.severity = 'warn'
  GROUP BY f.subject_id
)
SELECT
  e.id                                          AS employee_id,
  e.organization_id,
  e.business_id,
  (ae.employee_id IS NOT NULL)                  AS has_active_employment,
  (ac.employee_id IS NOT NULL)                  AS has_active_contract,
  COALESCE(bf.open_blocking, 0)                 AS open_blocking_findings,
  COALESCE(wf.open_warn, 0)                     AS open_warn_findings,
  CASE
    WHEN e.is_active = false                              THEN 'inactive'
    WHEN COALESCE(bf.open_blocking, 0) > 0                THEN 'blocked'
    WHEN ae.employee_id IS NULL                           THEN 'blocked'
    WHEN ac.employee_id IS NULL
      OR COALESCE(wf.open_warn, 0) > 0                    THEN 'incomplete'
    ELSE                                                       'ready'
  END                                           AS verdict
FROM public.employees e
LEFT JOIN active_emp        ae ON ae.employee_id = e.id
LEFT JOIN active_contract   ac ON ac.employee_id = e.id
LEFT JOIN blocking_findings bf ON bf.employee_id = e.id
LEFT JOIN warn_findings     wf ON wf.employee_id = e.id;

GRANT SELECT ON public.v_employee_setup_health TO authenticated;
GRANT SELECT ON public.v_employee_setup_health TO service_role;

COMMENT ON VIEW public.v_employee_setup_health IS
  'Per-employee directory readiness for Wave G F2. Verdict: ready/incomplete/blocked/inactive. Joins active employment + active contract + open payroll readiness findings. Security invoker — underlying RLS applies.';