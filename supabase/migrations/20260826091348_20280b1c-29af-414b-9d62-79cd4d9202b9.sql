-- =========================================================
-- Wave 1: Timesheet business-event contract
-- =========================================================
INSERT INTO public.business_event_topics (topic_prefix, producer_domain, consumer_domains, description)
VALUES
  ('timesheet.', 'timesheets', ARRAY['payroll','projects','sales','finance','reporting','notifications'], 'Timesheet domain lifecycle events'),
  ('timesheet.submitted', 'timesheets', ARRAY['notifications','reporting'], 'A timesheet period was submitted for approval'),
  ('timesheet.approved', 'timesheets', ARRAY['payroll','projects','sales','finance','reporting','notifications'], 'A timesheet period was approved; approved time is authoritative'),
  ('timesheet.rejected', 'timesheets', ARRAY['notifications','reporting'], 'A submitted timesheet period was rejected'),
  ('timesheet.corrected', 'timesheets', ARRAY['payroll','projects','sales','finance','reporting'], 'An approved time entry was corrected or reversed'),
  ('timesheet.locked', 'timesheets', ARRAY['payroll','reporting'], 'Approved time was locked by a payroll period'),
  ('timesheet.unlocked', 'timesheets', ARRAY['payroll','reporting'], 'Approved time was unlocked from a payroll period'),
  ('timesheet.billable_ready', 'timesheets', ARRAY['sales','finance','reporting'], 'Approved billable time is available for billing')
ON CONFLICT (topic_prefix) DO NOTHING;

CREATE OR REPLACE FUNCTION public._timesheet_emit_event(
  _org_id uuid,
  _event_type text,
  _source_doc_type text,
  _source_doc_id uuid,
  _payload jsonb,
  _idempotency_key text,
  _branch_id uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO public.business_event_outbox (
    org_id, branch_id, event_type, source_doc_type, source_doc_id,
    payload, idempotency_key, actor_user_id, source)
  VALUES (
    _org_id, _branch_id, _event_type, _source_doc_type, _source_doc_id,
    COALESCE(_payload, '{}'::jsonb), _idempotency_key, auth.uid(), 'timesheets')
  ON CONFLICT (idempotency_key) DO NOTHING;
END $$;

-- =========================================================
-- Wave 3: correction lifecycle -- allow the 'superseded' terminal state
-- =========================================================
ALTER TABLE public.timesheets DROP CONSTRAINT IF EXISTS timesheets_status_check;
ALTER TABLE public.timesheets ADD CONSTRAINT timesheets_status_check
  CHECK (status = ANY (ARRAY['draft','submitted','approved','rejected','superseded']));

-- =========================================================
-- Emit events from the authoritative lifecycle RPCs
-- =========================================================
CREATE OR REPLACE FUNCTION public.submit_timesheet_period(_employee_id uuid, _period_start date, _period_end date, _notes text DEFAULT NULL::text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_emp record; v_uid uuid := auth.uid(); v_is_self boolean;
  v_total numeric := 0; v_billable numeric := 0; v_submission_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO v_emp FROM public.employees WHERE id = _employee_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Employee not found'; END IF;
  v_is_self := v_emp.user_id = v_uid;
  IF NOT v_is_self
     AND NOT public.has_role(v_uid, 'admin')
     AND NOT public.has_role(v_uid, 'hr_admin')
     AND NOT EXISTS (SELECT 1 FROM public.employees m WHERE m.user_id = v_uid AND m.id = v_emp.manager_id)
  THEN RAISE EXCEPTION 'Not allowed to submit for this employee'; END IF;

  -- Serialize concurrent submissions of the same employee period.
  PERFORM pg_advisory_xact_lock(hashtext('submit_timesheet_period_' || _employee_id::text || _period_start::text));

  IF EXISTS (
    SELECT 1 FROM public.timesheet_submissions
     WHERE employee_id = _employee_id
       AND period_start = _period_start AND period_end = _period_end
       AND status IN ('submitted','approved','locked')
  ) THEN
    RAISE EXCEPTION 'A submission for this period is already in progress or approved'
      USING ERRCODE = '55006';
  END IF;

  SELECT COALESCE(SUM(hours),0), COALESCE(SUM(CASE WHEN is_billable THEN hours ELSE 0 END),0)
    INTO v_total, v_billable
  FROM public.timesheets
  WHERE employee_id = _employee_id AND date BETWEEN _period_start AND _period_end AND status = 'draft';

  IF v_total = 0 THEN RAISE EXCEPTION 'No draft entries to submit'; END IF;

  INSERT INTO public.timesheet_submissions
    (organization_id, business_id, employee_id, period_start, period_end,
     total_hours, billable_hours, status, submitted_at, notes)
  VALUES
    (v_emp.organization_id, v_emp.business_id, _employee_id, _period_start, _period_end,
     v_total, v_billable, 'submitted', now(), _notes)
  RETURNING id INTO v_submission_id;

  UPDATE public.timesheets
     SET status='submitted', submitted_at=now(), submitted_by=v_uid
   WHERE employee_id=_employee_id AND date BETWEEN _period_start AND _period_end AND status='draft';

  PERFORM public._timesheet_emit_event(
    v_emp.organization_id, 'timesheet.submitted', 'timesheet_submission', v_submission_id,
    jsonb_build_object('business_id', v_emp.business_id, 'employee_id', _employee_id,
                       'period_start', _period_start, 'period_end', _period_end,
                       'total_hours', v_total, 'billable_hours', v_billable),
    'timesheet.submitted:' || v_submission_id::text);

  RETURN v_submission_id;
END $$;

CREATE OR REPLACE FUNCTION public.approve_timesheet_submission(_submission_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_uid uuid := auth.uid(); s record; allow_self boolean; v_billable numeric := 0;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO s FROM public.timesheet_submissions WHERE id = _submission_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Submission not found'; END IF;
  IF s.status <> 'submitted' THEN RAISE EXCEPTION 'Submission is not pending'; END IF;

  SELECT COALESCE(allow_self_approval,false) INTO allow_self
    FROM public.timesheet_settings WHERE organization_id = s.organization_id LIMIT 1;
  IF NOT public._timesheet_can_approve(v_uid, s.employee_id, COALESCE(allow_self,false)) THEN
    RAISE EXCEPTION 'Not allowed to approve this submission';
  END IF;

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
END $$;

CREATE OR REPLACE FUNCTION public.reject_timesheet_submission(_submission_id uuid, _reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_uid uuid := auth.uid(); s record; allow_self boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF _reason IS NULL OR length(trim(_reason)) = 0 THEN RAISE EXCEPTION 'Rejection reason is required'; END IF;
  SELECT * INTO s FROM public.timesheet_submissions WHERE id = _submission_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Submission not found'; END IF;
  IF s.status <> 'submitted' THEN RAISE EXCEPTION 'Submission is not pending'; END IF;

  SELECT COALESCE(allow_self_approval,false) INTO allow_self
    FROM public.timesheet_settings WHERE organization_id = s.organization_id LIMIT 1;
  IF NOT public._timesheet_can_approve(v_uid, s.employee_id, COALESCE(allow_self,false)) THEN
    RAISE EXCEPTION 'Not allowed to reject this submission';
  END IF;

  UPDATE public.timesheet_submissions
     SET status='rejected', rejected_by=v_uid, rejected_at=now(), rejection_reason=_reason
   WHERE id=_submission_id;

  UPDATE public.timesheets
     SET status='rejected', rejected_by=v_uid, rejected_at=now(), rejection_reason=_reason
   WHERE employee_id=s.employee_id AND date BETWEEN s.period_start AND s.period_end AND status='submitted';

  PERFORM public._timesheet_emit_event(
    s.organization_id, 'timesheet.rejected', 'timesheet_submission', _submission_id,
    jsonb_build_object('business_id', s.business_id, 'employee_id', s.employee_id,
                       'period_start', s.period_start, 'period_end', s.period_end,
                       'reason', _reason),
    'timesheet.rejected:' || _submission_id::text || ':' || extract(epoch from now())::bigint::text);
END $$;

CREATE OR REPLACE FUNCTION public.lock_timesheets_for_payroll(_payroll_period_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_uid uuid := auth.uid(); p record; v_count integer;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (public.has_role(v_uid,'admin') OR public.has_role(v_uid,'hr_admin') OR public.has_role(v_uid,'payroll_admin')) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;
  SELECT * INTO p FROM public.payroll_periods WHERE id = _payroll_period_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll period not found'; END IF;
  WITH upd AS (
    UPDATE public.timesheets
       SET payroll_period_id=_payroll_period_id, payroll_locked=true, payroll_locked_at=now()
     WHERE organization_id=p.organization_id
       AND (p.business_id IS NULL OR business_id=p.business_id)
       AND date BETWEEN p.start_date AND p.end_date
       AND status='approved' AND payroll_locked=false
    RETURNING 1
  ) SELECT count(*) INTO v_count FROM upd;

  IF v_count > 0 THEN
    PERFORM public._timesheet_emit_event(
      p.organization_id, 'timesheet.locked', 'payroll_period', _payroll_period_id,
      jsonb_build_object('business_id', p.business_id, 'entries_locked', v_count,
                         'period_start', p.start_date, 'period_end', p.end_date),
      'timesheet.locked:' || _payroll_period_id::text);
  END IF;
  RETURN v_count;
END $$;

-- =========================================================
-- Wave 3: correction and reversal RPCs
-- =========================================================
CREATE OR REPLACE FUNCTION public._timesheet_can_amend(_uid uuid, _employee_id uuid, _org_id uuid, _business_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF _uid IS NULL THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.employees e WHERE e.id = _employee_id AND e.user_id = _uid) THEN
    RETURN true;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.employees e
      JOIN public.employees m ON m.id = e.manager_id
     WHERE e.id = _employee_id AND m.user_id = _uid
  ) THEN
    RETURN true;
  END IF;
  IF _business_id IS NOT NULL
     AND public.user_can_access_business(_uid, _business_id)
     AND public.user_has_module_permission(_uid, _org_id, _business_id, 'timesheets', 'write') THEN
    RETURN true;
  END IF;
  RETURN false;
END $$;

CREATE OR REPLACE FUNCTION public.correct_timesheet_entry(
  _timesheet_id uuid,
  _reason text,
  _hours numeric DEFAULT NULL,
  _description text DEFAULT NULL,
  _is_billable boolean DEFAULT NULL,
  _project_id uuid DEFAULT NULL,
  _task_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_uid uuid := auth.uid(); t record; v_new_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF _reason IS NULL OR length(trim(_reason)) = 0 THEN
    RAISE EXCEPTION 'A correction reason is required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO t FROM public.timesheets WHERE id = _timesheet_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Time entry not found' USING ERRCODE = 'P0002'; END IF;

  IF NOT public._timesheet_can_amend(v_uid, t.employee_id, t.organization_id, t.business_id) THEN
    RAISE EXCEPTION 'Not allowed to correct this time entry' USING ERRCODE = '42501';
  END IF;

  IF t.status <> 'approved' THEN
    RAISE EXCEPTION 'Only approved time is corrected; draft or rejected time is edited directly'
      USING ERRCODE = '55006';
  END IF;
  IF COALESCE(t.is_invoiced,false) THEN
    RAISE EXCEPTION 'This time has been invoiced. Sales must credit the invoice before the time can be corrected.'
      USING ERRCODE = '55006';
  END IF;
  IF COALESCE(t.payroll_locked,false) THEN
    RAISE EXCEPTION 'This time is locked by a posted payroll run. Payroll must unlock the period first.'
      USING ERRCODE = '55006';
  END IF;
  IF EXISTS (SELECT 1 FROM public.timesheets c WHERE c.correction_of = t.id AND c.status <> 'rejected') THEN
    RAISE EXCEPTION 'A correction for this entry already exists' USING ERRCODE = '55006';
  END IF;

  INSERT INTO public.timesheets (
    organization_id, business_id, branch_id, employee_id, project_id, task_id,
    date, hours, description, is_billable, status, created_by, correction_of,
    start_time, end_time)
  VALUES (
    t.organization_id, t.business_id, t.branch_id, t.employee_id,
    COALESCE(_project_id, t.project_id), COALESCE(_task_id, t.task_id),
    t.date, COALESCE(_hours, t.hours),
    COALESCE(_description, t.description),
    COALESCE(_is_billable, t.is_billable),
    'draft', v_uid, t.id, t.start_time, t.end_time)
  RETURNING id INTO v_new_id;

  INSERT INTO public.timesheet_audit_log
    (timesheet_id, organization_id, business_id, action, from_status, to_status, actor_user_id, reason, metadata)
  VALUES (t.id, t.organization_id, t.business_id, 'correction_opened', t.status, t.status, v_uid, _reason,
          jsonb_build_object('correction_entry_id', v_new_id));

  PERFORM public._timesheet_emit_event(
    t.organization_id, 'timesheet.corrected', 'timesheet', t.id,
    jsonb_build_object('business_id', t.business_id, 'employee_id', t.employee_id,
                       'kind', 'correction_opened', 'correction_entry_id', v_new_id,
                       'original_hours', t.hours, 'corrected_hours', COALESCE(_hours, t.hours),
                       'date', t.date, 'reason', _reason),
    'timesheet.corrected:opened:' || v_new_id::text, t.branch_id);

  RETURN v_new_id;
END $$;

CREATE OR REPLACE FUNCTION public.reverse_timesheet_entry(_timesheet_id uuid, _reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_uid uuid := auth.uid(); t record;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF _reason IS NULL OR length(trim(_reason)) = 0 THEN
    RAISE EXCEPTION 'A reversal reason is required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO t FROM public.timesheets WHERE id = _timesheet_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Time entry not found' USING ERRCODE = 'P0002'; END IF;

  IF NOT public._timesheet_can_amend(v_uid, t.employee_id, t.organization_id, t.business_id) THEN
    RAISE EXCEPTION 'Not allowed to reverse this time entry' USING ERRCODE = '42501';
  END IF;
  IF t.status <> 'approved' THEN
    RAISE EXCEPTION 'Only approved time can be reversed' USING ERRCODE = '55006';
  END IF;
  IF COALESCE(t.is_invoiced,false) THEN
    RAISE EXCEPTION 'This time has been invoiced. Sales must credit the invoice before the time can be reversed.'
      USING ERRCODE = '55006';
  END IF;
  IF COALESCE(t.payroll_locked,false) THEN
    RAISE EXCEPTION 'This time is locked by a posted payroll run. Payroll must unlock the period first.'
      USING ERRCODE = '55006';
  END IF;

  UPDATE public.timesheets SET status = 'superseded', updated_by = v_uid WHERE id = t.id;

  INSERT INTO public.timesheet_audit_log
    (timesheet_id, organization_id, business_id, action, from_status, to_status, actor_user_id, reason)
  VALUES (t.id, t.organization_id, t.business_id, 'reversed', t.status, 'superseded', v_uid, _reason);

  PERFORM public._timesheet_emit_event(
    t.organization_id, 'timesheet.corrected', 'timesheet', t.id,
    jsonb_build_object('business_id', t.business_id, 'employee_id', t.employee_id,
                       'kind', 'reversed', 'hours', t.hours, 'date', t.date, 'reason', _reason),
    'timesheet.corrected:reversed:' || t.id::text, t.branch_id);
END $$;

-- When a correction entry is approved, the original approved entry is superseded
-- so downstream costing/payroll/billing consume exactly one authoritative fact.
CREATE OR REPLACE FUNCTION public.trg_timesheet_correction_supersede()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.correction_of IS NOT NULL
     AND NEW.status = 'approved'
     AND OLD.status IS DISTINCT FROM 'approved' THEN
    UPDATE public.timesheets
       SET status = 'superseded', updated_by = auth.uid()
     WHERE id = NEW.correction_of AND status = 'approved';

    INSERT INTO public.timesheet_audit_log
      (timesheet_id, organization_id, business_id, action, from_status, to_status, actor_user_id, metadata)
    VALUES (NEW.correction_of, NEW.organization_id, NEW.business_id, 'superseded_by_correction',
            'approved', 'superseded', auth.uid(),
            jsonb_build_object('correction_entry_id', NEW.id));

    PERFORM public._timesheet_emit_event(
      NEW.organization_id, 'timesheet.corrected', 'timesheet', NEW.correction_of,
      jsonb_build_object('business_id', NEW.business_id, 'employee_id', NEW.employee_id,
                         'kind', 'correction_approved', 'correction_entry_id', NEW.id,
                         'corrected_hours', NEW.hours, 'date', NEW.date),
      'timesheet.corrected:approved:' || NEW.id::text, NEW.branch_id);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS timesheets_correction_supersede ON public.timesheets;
CREATE TRIGGER timesheets_correction_supersede
  AFTER UPDATE ON public.timesheets
  FOR EACH ROW EXECUTE FUNCTION public.trg_timesheet_correction_supersede();

REVOKE ALL ON FUNCTION public._timesheet_emit_event(uuid, text, text, uuid, jsonb, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._timesheet_can_amend(uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.correct_timesheet_entry(uuid, text, numeric, text, boolean, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_timesheet_entry(uuid, text) TO authenticated;