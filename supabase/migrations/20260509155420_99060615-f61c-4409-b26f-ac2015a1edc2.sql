
CREATE OR REPLACE VIEW public.project_portfolio_kpis
WITH (security_invoker = on) AS
WITH proj AS (
  SELECT id, organization_id, business_id, last_update_status, budget
  FROM public.projects
  WHERE is_active = true AND COALESCE(is_template, false) = false
    AND status NOT IN ('completed','cancelled')
),
costs AS (
  SELECT project_id, SUM(amount) AS total_cost
  FROM public.project_cost_entries
  GROUP BY project_id
),
at_risk AS (
  SELECT organization_id, business_id, COUNT(*)::int AS n
  FROM proj
  WHERE last_update_status IN ('at_risk','off_track')
  GROUP BY organization_id, business_id
),
over_budget AS (
  SELECT p.organization_id, p.business_id, COUNT(*)::int AS n
  FROM proj p
  JOIN costs c ON c.project_id = p.id
  WHERE p.budget IS NOT NULL AND p.budget > 0 AND c.total_cost > p.budget
  GROUP BY p.organization_id, p.business_id
),
ms AS (
  SELECT p.organization_id, p.business_id, COUNT(*)::int AS n
  FROM public.project_milestones m
  JOIN proj p ON p.id = m.project_id
  WHERE m.is_reached = false
    AND m.deadline IS NOT NULL
    AND m.deadline <= (CURRENT_DATE + INTERVAL '7 days')
  GROUP BY p.organization_id, p.business_id
),
ts AS (
  SELECT t.organization_id, t.business_id, COALESCE(SUM(t.hours), 0)::numeric AS hours
  FROM public.timesheets t
  JOIN proj p ON p.id = t.project_id
  WHERE t.is_billable = true
    AND COALESCE(t.is_invoiced, false) = false
    AND t.status = 'approved'
  GROUP BY t.organization_id, t.business_id
),
scope AS (
  SELECT DISTINCT organization_id, business_id FROM proj
)
SELECT
  s.organization_id,
  s.business_id,
  COALESCE(ar.n, 0)         AS at_risk_count,
  COALESCE(ob.n, 0)         AS over_budget_count,
  COALESCE(ms.n, 0)         AS overdue_milestones_week,
  COALESCE(ts.hours, 0)     AS unbilled_timesheet_hours
FROM scope s
LEFT JOIN at_risk     ar ON ar.organization_id = s.organization_id AND ar.business_id IS NOT DISTINCT FROM s.business_id
LEFT JOIN over_budget ob ON ob.organization_id = s.organization_id AND ob.business_id IS NOT DISTINCT FROM s.business_id
LEFT JOIN ms          ms ON ms.organization_id = s.organization_id AND ms.business_id IS NOT DISTINCT FROM s.business_id
LEFT JOIN ts          ts ON ts.organization_id = s.organization_id AND ts.business_id IS NOT DISTINCT FROM s.business_id;

GRANT SELECT ON public.project_portfolio_kpis TO authenticated;
