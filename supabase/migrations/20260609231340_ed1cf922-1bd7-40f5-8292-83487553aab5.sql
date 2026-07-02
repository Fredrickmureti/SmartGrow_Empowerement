-- v_attendance_day_presence
-- Odoo-parity view: one row per (business_id, attendance_date, employee_id).
-- Consumers (dashboards, payroll readiness, reports) read presence from here
-- so the definition stays in one place. Security is inherited from the
-- underlying public.attendance table (RLS still applies).
CREATE OR REPLACE VIEW public.v_attendance_day_presence AS
SELECT
  a.organization_id,
  a.business_id,
  a.branch_id,
  a.attendance_date,
  a.employee_id,
  -- Considered present iff at least one attendance line exists for the day
  -- whose status is not absent/on_leave/holiday and that has a clock_in.
  bool_or(a.clock_in IS NOT NULL
          AND a.status NOT IN ('absent','on_leave','holiday')) AS is_present,
  bool_or((a.late_minutes IS NOT NULL AND a.late_minutes > 0)
          OR a.status = 'late')                                AS is_late,
  bool_or(a.clock_in IS NOT NULL AND a.clock_out IS NULL)      AS has_open_session,
  COALESCE(MAX(a.late_minutes), 0)                             AS late_minutes,
  COALESCE(SUM(a.worked_hours), 0)                             AS worked_hours,
  COALESCE(SUM(a.overtime_hours), 0)                           AS overtime_hours
FROM public.attendance a
GROUP BY
  a.organization_id, a.business_id, a.branch_id,
  a.attendance_date, a.employee_id;

GRANT SELECT ON public.v_attendance_day_presence TO authenticated;
GRANT SELECT ON public.v_attendance_day_presence TO service_role;

COMMENT ON VIEW public.v_attendance_day_presence IS
  'Odoo-style attendance presence per employee per business day. Derived from public.attendance; RLS inherited.';