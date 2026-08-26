
REVOKE EXECUTE ON FUNCTION public._timesheet_can_approve(uuid, uuid) FROM authenticated;

CREATE OR REPLACE FUNCTION public.reject_timesheet_submission(_submission_id uuid, _reason text DEFAULT NULL::text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_uid uuid := auth.uid(); s record;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO s FROM public.timesheet_submissions WHERE id = _submission_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Submission not found'; END IF;
  IF s.status <> 'submitted' THEN RAISE EXCEPTION 'Submission is not pending'; END IF;

  IF NOT public._timesheet_can_approve(v_uid, _submission_id) THEN
    RAISE EXCEPTION 'Not allowed to reject this submission';
  END IF;

  UPDATE public.timesheet_submissions
     SET status='rejected', rejected_by=v_uid, rejected_at=now(), rejection_reason=_reason
   WHERE id = _submission_id;

  UPDATE public.timesheets
     SET status='rejected'
   WHERE employee_id=s.employee_id AND date BETWEEN s.period_start AND s.period_end AND status='submitted';

  PERFORM public._timesheet_emit_event(
    s.organization_id, 'timesheet.rejected', 'timesheet_submission', _submission_id,
    jsonb_build_object('business_id', s.business_id, 'employee_id', s.employee_id,
                       'period_start', s.period_start, 'period_end', s.period_end,
                       'reason', _reason),
    'timesheet.rejected:' || _submission_id::text);
END;
$$;

CREATE OR REPLACE FUNCTION public.timesheet_approval_capability(_submission_id uuid)
RETURNS TABLE(can_approve boolean, requires_override boolean, reason text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  s record;
  v_subject uuid;
  v_verdict text;
BEGIN
  IF v_uid IS NULL THEN RETURN QUERY SELECT false, false, 'not_authenticated'; RETURN; END IF;

  SELECT * INTO s FROM public.timesheet_submissions WHERE id = _submission_id;
  IF NOT FOUND THEN RETURN QUERY SELECT false, false, 'not_found'; RETURN; END IF;
  IF s.status <> 'submitted' THEN RETURN QUERY SELECT false, false, 'not_pending'; RETURN; END IF;
  IF NOT public._timesheet_can_approve(v_uid, _submission_id) THEN
    RETURN QUERY SELECT false, false, 'not_authorized'; RETURN;
  END IF;

  SELECT user_id INTO v_subject FROM public.employees WHERE id = s.employee_id;
  v_verdict := public.governance_self_action_verdict(
    v_uid, v_subject, 'timesheet.approve', s.organization_id, s.id);

  IF v_verdict IN ('not_self', 'allow', 'warn') THEN
    RETURN QUERY SELECT true, false, v_verdict; RETURN;
  ELSIF v_verdict = 'override_available' THEN
    RETURN QUERY SELECT true, true, v_verdict; RETURN;
  END IF;

  RETURN QUERY SELECT false, true, 'self_action_blocked';
END;
$$;
