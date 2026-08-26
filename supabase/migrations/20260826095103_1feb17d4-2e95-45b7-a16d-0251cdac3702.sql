
-- ─────────────────────────────────────────────────────────────
-- Wave 5/6/7 — history protection, project-manager visibility,
-- attendance vs timesheet reconciliation.
-- ─────────────────────────────────────────────────────────────

-- 1. Historical time attribution must never be silently detached.
CREATE OR REPLACE FUNCTION public._timesheet_block_referenced_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_count integer;
BEGIN
  IF TG_TABLE_NAME = 'projects' THEN
    SELECT count(*) INTO v_count FROM public.timesheets
     WHERE project_id = OLD.id AND status <> 'draft';
    IF v_count > 0 THEN
      RAISE EXCEPTION 'Cannot delete project: % timesheet entries are attributed to it. Archive/deactivate the project instead.', v_count
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'project_tasks' THEN
    SELECT count(*) INTO v_count FROM public.timesheets
     WHERE task_id = OLD.id AND status <> 'draft';
    IF v_count > 0 THEN
      RAISE EXCEPTION 'Cannot delete task: % timesheet entries are attributed to it. Close or archive the task instead.', v_count
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'employees' THEN
    SELECT count(*) INTO v_count FROM public.timesheets
     WHERE employee_id = OLD.id AND status <> 'draft';
    IF v_count > 0 THEN
      RAISE EXCEPTION 'Cannot delete employee: % timesheet entries exist. Deactivate/offboard the employee instead.', v_count
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_projects_timesheet_delete_guard ON public.projects;
CREATE TRIGGER trg_projects_timesheet_delete_guard
BEFORE DELETE ON public.projects
FOR EACH ROW EXECUTE FUNCTION public._timesheet_block_referenced_delete();

DROP TRIGGER IF EXISTS trg_project_tasks_timesheet_delete_guard ON public.project_tasks;
CREATE TRIGGER trg_project_tasks_timesheet_delete_guard
BEFORE DELETE ON public.project_tasks
FOR EACH ROW EXECUTE FUNCTION public._timesheet_block_referenced_delete();

DROP TRIGGER IF EXISTS trg_employees_timesheet_delete_guard ON public.employees;
CREATE TRIGGER trg_employees_timesheet_delete_guard
BEFORE DELETE ON public.employees
FOR EACH ROW EXECUTE FUNCTION public._timesheet_block_referenced_delete();

-- 2. Project-manager visibility (read-only) over time booked to their projects.
CREATE OR REPLACE FUNCTION public._timesheet_is_project_manager(_user_id uuid, _project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.projects p
      LEFT JOIN public.employees e ON e.id = p.manager_id
     WHERE p.id = _project_id
       AND (p.manager_id = _user_id OR e.user_id = _user_id)
  );
$$;

REVOKE ALL ON FUNCTION public._timesheet_is_project_manager(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._timesheet_is_project_manager(uuid, uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS timesheets_select_project_manager ON public.timesheets;
CREATE POLICY timesheets_select_project_manager
ON public.timesheets
FOR SELECT
TO authenticated
USING (
  project_id IS NOT NULL
  AND public._timesheet_is_project_manager(auth.uid(), project_id)
);

-- 3. Attendance owns presence; Timesheet owns worked/attributed time.
--    This view compares them — it never becomes a second clock.
CREATE OR REPLACE VIEW public.v_timesheet_attendance_reconciliation
WITH (security_invoker = true) AS
WITH ts AS (
  SELECT organization_id, business_id, employee_id, date AS day,
         sum(hours) AS recorded_hours,
         sum(CASE WHEN status = 'approved' THEN hours ELSE 0 END) AS approved_hours
    FROM public.timesheets
   WHERE status IS DISTINCT FROM 'superseded'
   GROUP BY organization_id, business_id, employee_id, date
), att AS (
  SELECT organization_id, business_id, employee_id, attendance_date AS day,
         sum(COALESCE(worked_hours, 0)) AS attended_hours
    FROM public.attendance
   GROUP BY organization_id, business_id, employee_id, attendance_date
)
SELECT
  COALESCE(ts.organization_id, att.organization_id) AS organization_id,
  COALESCE(ts.business_id, att.business_id)         AS business_id,
  COALESCE(ts.employee_id, att.employee_id)         AS employee_id,
  COALESCE(ts.day, att.day)                         AS day,
  COALESCE(att.attended_hours, 0)                   AS attended_hours,
  COALESCE(ts.recorded_hours, 0)                    AS recorded_hours,
  COALESCE(ts.approved_hours, 0)                    AS approved_hours,
  COALESCE(ts.recorded_hours, 0) - COALESCE(att.attended_hours, 0) AS variance_hours
FROM ts
FULL OUTER JOIN att
  ON  att.employee_id = ts.employee_id
  AND att.day         = ts.day
  AND att.organization_id = ts.organization_id
  AND att.business_id IS NOT DISTINCT FROM ts.business_id;

GRANT SELECT ON public.v_timesheet_attendance_reconciliation TO authenticated, service_role;
