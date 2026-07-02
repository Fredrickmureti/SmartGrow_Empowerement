
CREATE OR REPLACE VIEW public.v_hr_headcount_by_department
WITH (security_invoker = true) AS
SELECT e.organization_id, e.business_id, e.department_id,
       d.name AS department_name, COUNT(*)::int AS headcount
FROM public.employees e
LEFT JOIN public.departments d ON d.id = e.department_id
WHERE e.lifecycle_status = 'active'
GROUP BY e.organization_id, e.business_id, e.department_id, d.name;

CREATE OR REPLACE VIEW public.v_hr_workforce_growth_monthly
WITH (security_invoker = true) AS
WITH months AS (
  SELECT generate_series(date_trunc('month', now() - INTERVAL '23 months'),
                         date_trunc('month', now()),
                         INTERVAL '1 month')::date AS month_start
),
hires AS (
  SELECT organization_id, business_id, date_trunc('month', hire_date)::date AS m, COUNT(*)::int AS n
  FROM public.employees WHERE hire_date IS NOT NULL GROUP BY 1,2,3
),
exits AS (
  SELECT organization_id, business_id, date_trunc('month', occurred_at)::date AS m, COUNT(*)::int AS n
  FROM public.employee_lifecycle_events
  WHERE event_type IN ('terminated','offboarding_completed') GROUP BY 1,2,3
),
combos AS (SELECT DISTINCT organization_id, business_id FROM public.employees)
SELECT m.month_start, c.organization_id, c.business_id,
       COALESCE(h.n,0) AS hires, COALESCE(x.n,0) AS exits,
       (COALESCE(h.n,0) - COALESCE(x.n,0)) AS net_change
FROM months m
CROSS JOIN combos c
LEFT JOIN hires h ON h.m = m.month_start AND h.organization_id = c.organization_id AND h.business_id IS NOT DISTINCT FROM c.business_id
LEFT JOIN exits x ON x.m = m.month_start AND x.organization_id = c.organization_id AND x.business_id IS NOT DISTINCT FROM c.business_id;

CREATE OR REPLACE VIEW public.v_hr_turnover_monthly
WITH (security_invoker = true) AS
SELECT organization_id, business_id,
       date_trunc('month', occurred_at)::date AS month_start,
       COUNT(*) FILTER (WHERE payload->>'reason_kind' = 'voluntary')::int   AS voluntary_exits,
       COUNT(*) FILTER (WHERE payload->>'reason_kind' = 'involuntary')::int AS involuntary_exits,
       COUNT(*)::int AS total_exits
FROM public.employee_lifecycle_events
WHERE occurred_at >= now() - INTERVAL '24 months'
  AND event_type IN ('terminated','offboarding_completed')
GROUP BY organization_id, business_id, date_trunc('month', occurred_at);

CREATE OR REPLACE VIEW public.v_hr_contract_expiry_pipeline
WITH (security_invoker = true) AS
SELECT c.id AS contract_id, c.organization_id, c.business_id, c.employee_id,
       TRIM(BOTH FROM (COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,''))) AS employee_name,
       c.contract_reference, c.end_date,
       (c.end_date - CURRENT_DATE) AS days_to_expiry,
       CASE WHEN c.end_date - CURRENT_DATE <= 30 THEN '0-30'
            WHEN c.end_date - CURRENT_DATE <= 60 THEN '31-60'
            ELSE '61-90' END AS bucket
FROM public.employee_contracts c
JOIN public.employees e ON e.id = c.employee_id
WHERE c.status = 'running' AND c.end_date IS NOT NULL
  AND c.end_date >= CURRENT_DATE
  AND c.end_date <= CURRENT_DATE + INTERVAL '90 days';

CREATE OR REPLACE VIEW public.v_hr_payroll_distribution_by_department
WITH (security_invoker = true) AS
WITH latest_run AS (
  SELECT DISTINCT ON (organization_id, business_id)
    id, organization_id, business_id, pay_period_end
  FROM public.payroll_runs
  WHERE status IN ('paid','confirmed','posted')
  ORDER BY organization_id, business_id, pay_period_end DESC
)
SELECT lr.id AS payroll_run_id, lr.organization_id, lr.business_id, lr.pay_period_end,
       e.department_id, d.name AS department_name,
       COUNT(p.id)::int AS payslip_count,
       COALESCE(SUM(p.gross_pay), 0)::numeric AS total_gross,
       COALESCE(SUM(p.net_pay), 0)::numeric AS total_net
FROM latest_run lr
JOIN public.payslips p ON p.payroll_run_id = lr.id
JOIN public.employees e ON e.id = p.employee_id
LEFT JOIN public.departments d ON d.id = e.department_id
GROUP BY lr.id, lr.organization_id, lr.business_id, lr.pay_period_end, e.department_id, d.name;

CREATE OR REPLACE VIEW public.v_hr_org_change_history
WITH (security_invoker = true) AS
SELECT l.id, l.organization_id, l.business_id, l.entity_kind, l.entity_id,
       l.change_kind, l.occurred_at, l.actor_user_id, l.summary, l.payload,
       CASE l.entity_kind
         WHEN 'department' THEN d.name
         WHEN 'job_position' THEN jp.name
         WHEN 'work_location' THEN wl.name
       END AS entity_name
FROM public.org_change_log l
LEFT JOIN public.departments d ON l.entity_kind = 'department' AND d.id = l.entity_id
LEFT JOIN public.job_positions jp ON l.entity_kind = 'job_position' AND jp.id = l.entity_id
LEFT JOIN public.work_locations wl ON l.entity_kind = 'work_location' AND wl.id = l.entity_id;

GRANT SELECT ON public.v_hr_headcount_by_department,
                public.v_hr_workforce_growth_monthly,
                public.v_hr_turnover_monthly,
                public.v_hr_contract_expiry_pipeline,
                public.v_hr_payroll_distribution_by_department,
                public.v_hr_org_change_history
  TO authenticated, service_role;
