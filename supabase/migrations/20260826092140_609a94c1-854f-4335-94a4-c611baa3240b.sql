-- =========================================================
-- Wave 4: canonical timesheet metrics
-- =========================================================

-- Effective settings resolver (business override wins over org-level row)
CREATE OR REPLACE FUNCTION public.timesheet_effective_settings(
  p_organization_id uuid,
  p_business_id uuid
)
RETURNS TABLE (
  overtime_threshold_daily numeric,
  overtime_threshold_weekly numeric,
  week_start_day integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH pick AS (
    SELECT s.*
    FROM public.timesheet_settings s
    WHERE s.organization_id = p_organization_id
      AND (s.business_id = p_business_id OR s.business_id IS NULL)
    ORDER BY (s.business_id IS NOT NULL) DESC
    LIMIT 1
  )
  SELECT
    COALESCE((SELECT p.overtime_threshold_daily FROM pick p), 8)::numeric,
    COALESCE((SELECT p.overtime_threshold_weekly FROM pick p), 40)::numeric,
    COALESCE((SELECT p.week_start_day FROM pick p), 1)::integer;
$$;

GRANT EXECUTE ON FUNCTION public.timesheet_effective_settings(uuid, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------
-- Canonical entry-grain view (superseded corrections excluded)
-- ---------------------------------------------------------
DROP VIEW IF EXISTS public.v_timesheet_weekly_metrics;
DROP VIEW IF EXISTS public.v_timesheet_daily_metrics;
DROP VIEW IF EXISTS public.v_timesheet_entry_canonical;

CREATE VIEW public.v_timesheet_entry_canonical
WITH (security_invoker = true) AS
SELECT
  t.id,
  t.organization_id,
  t.business_id,
  t.branch_id,
  t.employee_id,
  t.project_id,
  t.task_id,
  t.date,
  COALESCE(t.hours, 0)::numeric                                                   AS hours,
  t.status,
  COALESCE(t.is_billable, false)                                                  AS is_billable,
  COALESCE(t.is_invoiced, false)                                                  AS is_invoiced,
  COALESCE(t.payroll_locked, false)                                               AS payroll_locked,
  t.correction_of,
  (t.correction_of IS NOT NULL)                                                   AS is_correction,
  t.billing_amount,
  CASE WHEN COALESCE(t.is_billable, false) THEN COALESCE(t.hours, 0) ELSE 0 END::numeric AS billable_hours,
  CASE WHEN COALESCE(t.is_billable, false) THEN 0 ELSE COALESCE(t.hours, 0) END::numeric AS non_billable_hours,
  CASE WHEN t.status = 'approved' THEN COALESCE(t.hours, 0) ELSE 0 END::numeric    AS approved_hours,
  CASE WHEN COALESCE(t.is_invoiced, false) THEN COALESCE(t.hours, 0) ELSE 0 END::numeric AS invoiced_hours,
  CASE WHEN t.status = 'approved' AND COALESCE(t.payroll_locked, false)
       THEN COALESCE(t.hours, 0) ELSE 0 END::numeric                              AS payroll_locked_hours,
  CASE WHEN t.status = 'approved'
        AND COALESCE(t.is_billable, false)
        AND NOT COALESCE(t.is_invoiced, false)
       THEN COALESCE(t.hours, 0) ELSE 0 END::numeric                              AS uninvoiced_billable_hours
FROM public.timesheets t
WHERE t.status IS DISTINCT FROM 'superseded';

GRANT SELECT ON public.v_timesheet_entry_canonical TO authenticated, service_role;

COMMENT ON VIEW public.v_timesheet_entry_canonical IS
  'Wave 4: canonical timesheet entry grain. Excludes superseded (corrected) entries. Single source for all timesheet hour classifications.';

-- ---------------------------------------------------------
-- Daily grain with canonical daily overtime
-- ---------------------------------------------------------
CREATE VIEW public.v_timesheet_daily_metrics
WITH (security_invoker = true) AS
SELECT
  e.organization_id,
  e.business_id,
  e.employee_id,
  e.date,
  SUM(e.hours)                       AS total_hours,
  SUM(e.billable_hours)              AS billable_hours,
  SUM(e.non_billable_hours)          AS non_billable_hours,
  SUM(e.approved_hours)              AS approved_hours,
  SUM(e.invoiced_hours)              AS invoiced_hours,
  SUM(e.payroll_locked_hours)        AS payroll_locked_hours,
  SUM(e.uninvoiced_billable_hours)   AS uninvoiced_billable_hours,
  s.overtime_threshold_daily,
  s.week_start_day,
  LEAST(SUM(e.hours), s.overtime_threshold_daily)                    AS regular_hours,
  GREATEST(SUM(e.hours) - s.overtime_threshold_daily, 0)             AS daily_overtime_hours
FROM public.v_timesheet_entry_canonical e
CROSS JOIN LATERAL public.timesheet_effective_settings(e.organization_id, e.business_id) s
GROUP BY e.organization_id, e.business_id, e.employee_id, e.date,
         s.overtime_threshold_daily, s.week_start_day;

GRANT SELECT ON public.v_timesheet_daily_metrics TO authenticated, service_role;

COMMENT ON VIEW public.v_timesheet_daily_metrics IS
  'Wave 4: canonical per-employee-per-day timesheet metrics. Daily overtime derived from timesheet_settings.overtime_threshold_daily.';

-- ---------------------------------------------------------
-- Weekly grain with canonical weekly overtime
-- ---------------------------------------------------------
CREATE VIEW public.v_timesheet_weekly_metrics
WITH (security_invoker = true) AS
SELECT
  d.organization_id,
  d.business_id,
  d.employee_id,
  (d.date - (((EXTRACT(ISODOW FROM d.date)::int % 7) - (d.week_start_day % 7) + 7) % 7))::date AS week_start,
  SUM(d.total_hours)               AS total_hours,
  SUM(d.billable_hours)            AS billable_hours,
  SUM(d.non_billable_hours)        AS non_billable_hours,
  SUM(d.approved_hours)            AS approved_hours,
  SUM(d.payroll_locked_hours)      AS payroll_locked_hours,
  SUM(d.daily_overtime_hours)      AS daily_overtime_hours,
  GREATEST(SUM(d.regular_hours) - s.overtime_threshold_weekly, 0) AS weekly_overtime_hours,
  SUM(d.daily_overtime_hours)
    + GREATEST(SUM(d.regular_hours) - s.overtime_threshold_weekly, 0) AS overtime_hours
FROM public.v_timesheet_daily_metrics d
CROSS JOIN LATERAL public.timesheet_effective_settings(d.organization_id, d.business_id) s
GROUP BY d.organization_id, d.business_id, d.employee_id,
         (d.date - (((EXTRACT(ISODOW FROM d.date)::int % 7) - (d.week_start_day % 7) + 7) % 7))::date,
         s.overtime_threshold_weekly;

GRANT SELECT ON public.v_timesheet_weekly_metrics TO authenticated, service_role;

COMMENT ON VIEW public.v_timesheet_weekly_metrics IS
  'Wave 4: canonical per-employee-per-week timesheet metrics. overtime_hours = daily excess + weekly excess of regular hours.';

-- ---------------------------------------------------------
-- Report functions (single definition of every reported metric)
-- ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_timesheet_employee_metrics(
  p_organization_id uuid,
  p_business_id uuid,
  p_from date,
  p_to date
)
RETURNS TABLE (
  employee_id uuid,
  employee_name text,
  employee_number text,
  total_hours numeric,
  approved_hours numeric,
  billable_hours numeric,
  non_billable_hours numeric,
  overtime_hours numeric,
  payroll_locked_hours numeric,
  uninvoiced_billable_hours numeric,
  utilization_pct numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH base AS (
    SELECT d.*
    FROM public.v_timesheet_daily_metrics d
    WHERE d.organization_id = p_organization_id
      AND (p_business_id IS NULL OR d.business_id = p_business_id)
      AND d.date BETWEEN p_from AND p_to
  ),
  weeks AS (
    SELECT
      b.employee_id,
      (b.date - (((EXTRACT(ISODOW FROM b.date)::int % 7) - (b.week_start_day % 7) + 7) % 7))::date AS week_start,
      SUM(b.regular_hours) AS regular_hours,
      SUM(b.daily_overtime_hours) AS daily_overtime_hours,
      MAX(s.overtime_threshold_weekly) AS weekly_threshold
    FROM base b
    CROSS JOIN LATERAL public.timesheet_effective_settings(b.organization_id, b.business_id) s
    GROUP BY b.employee_id,
             (b.date - (((EXTRACT(ISODOW FROM b.date)::int % 7) - (b.week_start_day % 7) + 7) % 7))::date
  ),
  ot AS (
    SELECT w.employee_id,
           SUM(w.daily_overtime_hours + GREATEST(w.regular_hours - w.weekly_threshold, 0)) AS overtime_hours
    FROM weeks w
    GROUP BY w.employee_id
  ),
  agg AS (
    SELECT b.employee_id,
           SUM(b.total_hours) AS total_hours,
           SUM(b.approved_hours) AS approved_hours,
           SUM(b.billable_hours) AS billable_hours,
           SUM(b.non_billable_hours) AS non_billable_hours,
           SUM(b.payroll_locked_hours) AS payroll_locked_hours,
           SUM(b.uninvoiced_billable_hours) AS uninvoiced_billable_hours
    FROM base b
    GROUP BY b.employee_id
  )
  SELECT
    a.employee_id,
    TRIM(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, '')) AS employee_name,
    e.employee_number,
    a.total_hours,
    a.approved_hours,
    a.billable_hours,
    a.non_billable_hours,
    COALESCE(o.overtime_hours, 0) AS overtime_hours,
    a.payroll_locked_hours,
    a.uninvoiced_billable_hours,
    CASE WHEN a.total_hours > 0
         THEN ROUND((a.billable_hours / a.total_hours) * 100, 2)
         ELSE 0 END AS utilization_pct
  FROM agg a
  LEFT JOIN public.employees e ON e.id = a.employee_id
  LEFT JOIN ot o ON o.employee_id = a.employee_id
  ORDER BY a.total_hours DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_timesheet_employee_metrics(uuid, uuid, date, date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_timesheet_project_metrics(
  p_organization_id uuid,
  p_business_id uuid,
  p_from date,
  p_to date
)
RETURNS TABLE (
  project_id uuid,
  project_name text,
  project_number text,
  customer_id uuid,
  project_is_billable boolean,
  total_hours numeric,
  approved_hours numeric,
  billable_hours numeric,
  non_billable_hours numeric,
  invoiced_hours numeric,
  uninvoiced_billable_hours numeric,
  utilization_pct numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH agg AS (
    SELECT
      e.project_id,
      SUM(e.hours) AS total_hours,
      SUM(e.approved_hours) AS approved_hours,
      SUM(e.billable_hours) AS billable_hours,
      SUM(e.non_billable_hours) AS non_billable_hours,
      SUM(e.invoiced_hours) AS invoiced_hours,
      SUM(e.uninvoiced_billable_hours) AS uninvoiced_billable_hours
    FROM public.v_timesheet_entry_canonical e
    WHERE e.organization_id = p_organization_id
      AND (p_business_id IS NULL OR e.business_id = p_business_id)
      AND e.date BETWEEN p_from AND p_to
    GROUP BY e.project_id
  )
  SELECT
    a.project_id,
    COALESCE(p.name, 'No project') AS project_name,
    p.project_number,
    p.customer_id,
    p.is_billable,
    a.total_hours,
    a.approved_hours,
    a.billable_hours,
    a.non_billable_hours,
    a.invoiced_hours,
    a.uninvoiced_billable_hours,
    CASE WHEN a.total_hours > 0
         THEN ROUND((a.billable_hours / a.total_hours) * 100, 2)
         ELSE 0 END AS utilization_pct
  FROM agg a
  LEFT JOIN public.projects p ON p.id = a.project_id
  ORDER BY a.total_hours DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_timesheet_project_metrics(uuid, uuid, date, date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_timesheet_summary(
  p_organization_id uuid,
  p_business_id uuid,
  p_from date,
  p_to date
)
RETURNS TABLE (
  total_hours numeric,
  approved_hours numeric,
  billable_hours numeric,
  non_billable_hours numeric,
  overtime_hours numeric,
  payroll_locked_hours numeric,
  uninvoiced_billable_hours numeric,
  utilization_pct numeric,
  employee_count integer
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    COALESCE(SUM(m.total_hours), 0),
    COALESCE(SUM(m.approved_hours), 0),
    COALESCE(SUM(m.billable_hours), 0),
    COALESCE(SUM(m.non_billable_hours), 0),
    COALESCE(SUM(m.overtime_hours), 0),
    COALESCE(SUM(m.payroll_locked_hours), 0),
    COALESCE(SUM(m.uninvoiced_billable_hours), 0),
    CASE WHEN COALESCE(SUM(m.total_hours), 0) > 0
         THEN ROUND((SUM(m.billable_hours) / SUM(m.total_hours)) * 100, 2)
         ELSE 0 END,
    COUNT(*)::integer
  FROM public.get_timesheet_employee_metrics(p_organization_id, p_business_id, p_from, p_to) m;
$$;

GRANT EXECUTE ON FUNCTION public.get_timesheet_summary(uuid, uuid, date, date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_timesheet_uninvoiced_billable(
  p_organization_id uuid,
  p_business_id uuid,
  p_from date,
  p_to date
)
RETURNS TABLE (
  timesheet_id uuid,
  date date,
  employee_id uuid,
  employee_name text,
  project_id uuid,
  project_name text,
  hours numeric,
  billing_amount numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    e.id,
    e.date,
    e.employee_id,
    TRIM(COALESCE(emp.first_name, '') || ' ' || COALESCE(emp.last_name, '')) AS employee_name,
    e.project_id,
    COALESCE(p.name, 'No project') AS project_name,
    e.hours,
    e.billing_amount
  FROM public.v_timesheet_entry_canonical e
  LEFT JOIN public.employees emp ON emp.id = e.employee_id
  LEFT JOIN public.projects p ON p.id = e.project_id
  WHERE e.organization_id = p_organization_id
    AND (p_business_id IS NULL OR e.business_id = p_business_id)
    AND e.date BETWEEN p_from AND p_to
    AND e.uninvoiced_billable_hours > 0
  ORDER BY e.date DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_timesheet_uninvoiced_billable(uuid, uuid, date, date) TO authenticated, service_role;
