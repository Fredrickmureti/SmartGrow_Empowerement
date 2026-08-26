
-- 5.1 — one authority for approval competence.
-- Permission-driven (configurable per org) + the two structural relationships:
-- direct manager, and project manager of a project touched by the submission.

DROP FUNCTION IF EXISTS public._timesheet_can_approve(uuid, uuid);

CREATE OR REPLACE FUNCTION public._timesheet_can_approve(_uid uuid, _submission_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE s record; v_emp record;
BEGIN
  IF _uid IS NULL THEN RETURN false; END IF;

  SELECT * INTO s FROM public.timesheet_submissions WHERE id = _submission_id;
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT * INTO v_emp FROM public.employees WHERE id = s.employee_id;
  IF NOT FOUND THEN RETURN false; END IF;

  -- 1. Configurable module permission (org-defined; admin/HR groups carry it by default).
  IF public.user_has_module_permission(_uid, s.organization_id, s.business_id, 'timesheets', 'approve')
     OR public.user_has_module_permission(_uid, s.organization_id, s.business_id, 'timesheets', 'write') THEN
    RETURN true;
  END IF;

  -- 2. Direct manager of the employee.
  IF EXISTS (SELECT 1 FROM public.employees m
              WHERE m.user_id = _uid AND m.id = v_emp.manager_id) THEN
    RETURN true;
  END IF;

  -- 3. Project manager of any project the submitted period touches.
  IF EXISTS (
    SELECT 1
      FROM public.timesheets t
     WHERE t.employee_id = s.employee_id
       AND t.date BETWEEN s.period_start AND s.period_end
       AND t.project_id IS NOT NULL
       AND public._timesheet_is_project_manager(_uid, t.project_id)
  ) THEN
    RETURN true;
  END IF;

  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public._timesheet_can_approve(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public._timesheet_can_approve(uuid, uuid) TO authenticated, service_role;

-- Repoint the three callers onto the submission-scoped authority.
CREATE OR REPLACE FUNCTION public.approve_timesheet_submission(_submission_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_uid uuid := auth.uid(); s record; v_billable numeric := 0;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO s FROM public.timesheet_submissions WHERE id = _submission_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Submission not found'; END IF;
  IF s.status <> 'submitted' THEN RAISE EXCEPTION 'Submission is not pending'; END IF;

  IF NOT public._timesheet_can_approve(v_uid, _submission_id) THEN
    RAISE EXCEPTION 'Not allowed to approve this submission';
  END IF;

  -- Self-approval verdict is enforced by sod_timesheet_submissions_guard
  -- (Governance). Do not duplicate that decision here.
  UPDATE public.timesheet_submissions
     SET status='approved', approved_by=v_uid, approved_at=now()
   WHERE id = _submission_id;

  UPDATE public.timesheets
     SET status='approved', approved_by=v_uid, approved_at=now()
   WHERE employee_id=s.employee_id AND date BETWEEN s.period_start AND s.period_end AND status='submitted';

  SELECT COALESCE(SUM(hours),0) INTO v_billable
    FROM public.timesheets
   WHERE employee_id=s.employee_id AND date BETWEEN s.period_start AND s.period_end
     AND status='approved' AND is_billable;

  PERFORM public._timesheet_emit_event(
    s.organization_id, 'timesheet.approved', 'timesheet_submission', _submission_id,
    jsonb_build_object('business_id', s.business_id, 'employee_id', s.employee_id,
                       'period_start', s.period_start, 'period_end', s.period_end,
                       'total_hours', s.total_hours, 'billable_hours', v_billable),
    'timesheet.approved:' || _submission_id::text);

  IF v_billable > 0 THEN
    PERFORM public._timesheet_emit_event(
      s.organization_id, 'timesheet.billable_ready', 'timesheet_submission', _submission_id,
      jsonb_build_object('business_id', s.business_id, 'employee_id', s.employee_id,
                         'period_start', s.period_start, 'period_end', s.period_end,
                         'billable_hours', v_billable),
      'timesheet.billable_ready:' || _submission_id::text);
  END IF;
END;
$$;
