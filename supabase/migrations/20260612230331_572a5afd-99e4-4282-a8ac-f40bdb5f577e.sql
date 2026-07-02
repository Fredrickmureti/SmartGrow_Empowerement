
-- v_manager_team_rollup
CREATE OR REPLACE VIEW public.v_manager_team_rollup
WITH (security_invoker = on) AS
WITH active_cycle AS (
  SELECT id, organization_id FROM public.performance_cycles WHERE phase <> 'closed'
),
team AS (
  SELECT e.manager_id AS manager_employee_id, e.organization_id, e.id AS employee_id
  FROM public.employees e
  WHERE e.is_active = true AND e.manager_id IS NOT NULL
),
team_goals AS (
  SELECT t.manager_employee_id, t.organization_id,
    COUNT(g.*) FILTER (WHERE g.status IN ('not_started','in_progress','at_risk')) AS active_goals,
    COUNT(g.*) FILTER (WHERE g.status = 'at_risk') AS at_risk_goals,
    COUNT(g.*) FILTER (
      WHERE g.next_check_in_due_at IS NOT NULL AND g.next_check_in_due_at < now()
        AND g.status IN ('not_started','in_progress','at_risk')
    ) AS overdue_check_ins
  FROM team t
  LEFT JOIN public.performance_goals g ON g.employee_id = t.employee_id
  GROUP BY t.manager_employee_id, t.organization_id
),
team_reviews AS (
  SELECT t.manager_employee_id, t.organization_id,
    COUNT(DISTINCT t.employee_id) AS team_size,
    COUNT(r.*) FILTER (WHERE r.signed_off_at IS NOT NULL OR r.status::text = 'acknowledged') AS reviews_done,
    COUNT(r.*) AS reviews_total
  FROM team t
  LEFT JOIN active_cycle ac ON ac.organization_id = t.organization_id
  LEFT JOIN public.performance_reviews r ON r.cycle_id = ac.id AND r.employee_id = t.employee_id
  GROUP BY t.manager_employee_id, t.organization_id
),
team_devplans AS (
  SELECT t.manager_employee_id,
    COUNT(DISTINCT t.employee_id) FILTER (WHERE dp.id IS NOT NULL) AS employees_with_devplan
  FROM team t
  LEFT JOIN public.development_plans dp
    ON dp.employee_id = t.employee_id AND dp.status::text IN ('draft','active','approved','in_progress')
  GROUP BY t.manager_employee_id
),
team_kudos AS (
  SELECT t.manager_employee_id, COUNT(k.*) AS kudos_last_30d
  FROM team t
  LEFT JOIN public.kudos k ON k.to_employee_id = t.employee_id AND k.created_at >= now() - INTERVAL '30 days'
  GROUP BY t.manager_employee_id
)
SELECT
  tr.manager_employee_id, tr.organization_id, tr.team_size,
  COALESCE(tg.active_goals, 0) AS active_goals,
  COALESCE(tg.at_risk_goals, 0) AS at_risk_goals,
  COALESCE(tg.overdue_check_ins, 0) AS overdue_check_ins,
  tr.reviews_done, tr.reviews_total,
  CASE WHEN tr.reviews_total > 0 THEN ROUND((tr.reviews_done::numeric / tr.reviews_total) * 100, 1) ELSE NULL END AS review_completion_pct,
  COALESCE(td.employees_with_devplan, 0) AS employees_with_devplan,
  CASE WHEN tr.team_size > 0 THEN ROUND((COALESCE(td.employees_with_devplan,0)::numeric / tr.team_size) * 100, 1) ELSE 0 END AS devplan_coverage_pct,
  COALESCE(tk.kudos_last_30d, 0) AS kudos_last_30d
FROM team_reviews tr
LEFT JOIN team_goals    tg ON tg.manager_employee_id = tr.manager_employee_id
LEFT JOIN team_devplans td ON td.manager_employee_id = tr.manager_employee_id
LEFT JOIN team_kudos    tk ON tk.manager_employee_id = tr.manager_employee_id;

GRANT SELECT ON public.v_manager_team_rollup TO authenticated;

-- v_exec_talent_rollup
CREATE OR REPLACE VIEW public.v_exec_talent_rollup
WITH (security_invoker = on) AS
WITH active_cycle AS (
  SELECT id, organization_id FROM public.performance_cycles WHERE phase <> 'closed'
),
dept_emp AS (
  SELECT e.organization_id, e.department_id, e.id AS employee_id
  FROM public.employees e WHERE e.is_active = true
),
rev_base AS (
  SELECT de.organization_id, de.department_id, de.employee_id,
         r.final_rating, r.signed_off_at, r.status::text AS rstatus, (r.id IS NOT NULL) AS has_review
  FROM dept_emp de
  LEFT JOIN active_cycle ac ON ac.organization_id = de.organization_id
  LEFT JOIN public.performance_reviews r ON r.cycle_id = ac.id AND r.employee_id = de.employee_id
),
rev AS (
  SELECT organization_id, department_id,
    COUNT(DISTINCT employee_id) AS headcount,
    COUNT(*) FILTER (WHERE has_review AND (signed_off_at IS NOT NULL OR rstatus = 'acknowledged')) AS reviews_done,
    COUNT(*) FILTER (WHERE has_review) AS reviews_total,
    AVG(final_rating) FILTER (WHERE final_rating IS NOT NULL) AS avg_rating
  FROM rev_base
  GROUP BY organization_id, department_id
),
rating_dist AS (
  SELECT organization_id, department_id,
    jsonb_object_agg(bucket, n) AS rating_distribution
  FROM (
    SELECT organization_id, department_id, floor(final_rating)::text AS bucket, COUNT(*) AS n
    FROM rev_base
    WHERE final_rating IS NOT NULL
    GROUP BY organization_id, department_id, floor(final_rating)
  ) x
  GROUP BY organization_id, department_id
),
bench AS (
  SELECT sp.organization_id, e.department_id,
    COUNT(DISTINCT sp.id) FILTER (WHERE sp.is_active) AS key_roles,
    COUNT(s.*) FILTER (WHERE s.readiness = 'ready_now') AS ready_now,
    COUNT(s.*) FILTER (WHERE s.readiness IN ('1-2_years','1_2_years','1-2y')) AS ready_1_2y,
    COUNT(s.*) FILTER (WHERE s.readiness IN ('3-5_years','3_5_years','3-5y')) AS ready_3_5y
  FROM public.succession_plans sp
  LEFT JOIN public.employees e ON e.id = sp.incumbent_employee_id
  LEFT JOIN public.successors s ON s.plan_id = sp.id
  GROUP BY sp.organization_id, e.department_id
),
learn AS (
  SELECT de.organization_id, de.department_id,
    COUNT(te.*) AS learning_assigned,
    COUNT(te.*) FILTER (WHERE te.status::text = 'completed') AS learning_completed
  FROM dept_emp de
  LEFT JOIN public.training_enrollments te ON te.employee_id = de.employee_id
  GROUP BY de.organization_id, de.department_id
)
SELECT
  rev.organization_id, rev.department_id, rev.headcount,
  rev.reviews_done, rev.reviews_total,
  CASE WHEN rev.reviews_total > 0 THEN ROUND((rev.reviews_done::numeric / rev.reviews_total) * 100, 1) ELSE NULL END AS review_completion_pct,
  ROUND(rev.avg_rating::numeric, 2) AS avg_rating,
  rd.rating_distribution,
  COALESCE(b.key_roles, 0)  AS succession_key_roles,
  COALESCE(b.ready_now, 0)  AS successors_ready_now,
  COALESCE(b.ready_1_2y, 0) AS successors_ready_1_2y,
  COALESCE(b.ready_3_5y, 0) AS successors_ready_3_5y,
  COALESCE(l.learning_assigned, 0)  AS learning_assigned,
  COALESCE(l.learning_completed, 0) AS learning_completed,
  CASE WHEN COALESCE(l.learning_assigned,0) > 0
       THEN ROUND((l.learning_completed::numeric / l.learning_assigned) * 100, 1) ELSE NULL END AS learning_compliance_pct
FROM rev
LEFT JOIN rating_dist rd ON rd.organization_id = rev.organization_id AND rd.department_id IS NOT DISTINCT FROM rev.department_id
LEFT JOIN bench       b  ON b.organization_id  = rev.organization_id AND b.department_id  IS NOT DISTINCT FROM rev.department_id
LEFT JOIN learn       l  ON l.organization_id  = rev.organization_id AND l.department_id  IS NOT DISTINCT FROM rev.department_id;

GRANT SELECT ON public.v_exec_talent_rollup TO authenticated;

-- v_competency_gap_heatmap
CREATE OR REPLACE VIEW public.v_competency_gap_heatmap
WITH (security_invoker = on) AS
WITH dept_emp AS (
  SELECT e.organization_id, e.department_id, e.id AS employee_id, e.job_position_id
  FROM public.employees e WHERE e.is_active = true
),
required AS (
  SELECT crr.organization_id, crr.job_position_id, crr.department_id, crr.competency_id, crr.required_level
  FROM public.competency_role_requirements crr
),
joined AS (
  SELECT de.organization_id, de.department_id, r.competency_id, r.required_level,
         ec.level AS current_level
  FROM dept_emp de
  JOIN required r
    ON (r.job_position_id IS NOT NULL AND r.job_position_id = de.job_position_id)
    OR (r.department_id   IS NOT NULL AND r.department_id   = de.department_id)
  LEFT JOIN public.employee_competencies ec
    ON ec.employee_id = de.employee_id AND ec.competency_id = r.competency_id
)
SELECT
  organization_id, department_id, competency_id,
  AVG(required_level)::numeric(4,2) AS avg_required_level,
  AVG(COALESCE(current_level,0))::numeric(4,2) AS avg_current_level,
  (AVG(required_level) - AVG(COALESCE(current_level,0)))::numeric(4,2) AS gap,
  COUNT(*) AS employees_evaluated,
  COUNT(*) FILTER (WHERE COALESCE(current_level,0) < required_level) AS employees_below
FROM joined
GROUP BY organization_id, department_id, competency_id;

GRANT SELECT ON public.v_competency_gap_heatmap TO authenticated;
