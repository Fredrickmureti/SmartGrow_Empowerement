-- Projects domain: recompute spent hours for the projects touched by one timesheet row
CREATE OR REPLACE FUNCTION public.projects_recompute_spent_hours_for_timesheet(_timesheet_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE t record; v_count int := 0;
BEGIN
  SELECT * INTO t FROM public.timesheets WHERE id = _timesheet_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'timesheet_not_found'); END IF;

  WITH affected AS (
    SELECT DISTINCT p.id
      FROM public.projects p
     WHERE p.id IN (t.project_id, (SELECT c.project_id FROM public.timesheets c WHERE c.correction_of = t.id LIMIT 1))
  ), upd AS (
    UPDATE public.projects p
       SET spent_hours = COALESCE((
             SELECT sum(ts.hours) FROM public.timesheets ts
              WHERE ts.project_id = p.id AND ts.status = 'approved'), 0),
           updated_at = now()
      FROM affected a
     WHERE p.id = a.id
    RETURNING p.id
  )
  SELECT count(*) INTO v_count FROM upd;

  RETURN jsonb_build_object('ok', true, 'projects_recomputed', v_count);
END $$;

REVOKE ALL ON FUNCTION public.projects_recompute_spent_hours_for_timesheet(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.projects_recompute_spent_hours_for_timesheet(uuid) TO service_role;

-- Payroll domain: flag draft runs / audit finalized runs affected by one timesheet row
CREATE OR REPLACE FUNCTION public.payroll_flag_runs_for_timesheet(_timesheet_id uuid, _actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE t record; v_reason text; v_drafts int := 0;
BEGIN
  SELECT * INTO t FROM public.timesheets WHERE id = _timesheet_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'timesheet_not_found'); END IF;

  v_reason := 'timesheet_entry_' || COALESCE(t.status, 'changed') || '_' || t.id::text;

  WITH touched AS (
    UPDATE public.payroll_runs pr
       SET needs_recompute_reason = v_reason, updated_at = now()
     WHERE pr.organization_id = t.organization_id
       AND (t.business_id IS NULL OR pr.business_id = t.business_id)
       AND pr.status IN ('draft', 'pending_approval')
       AND pr.pay_period_start <= t.date
       AND pr.pay_period_end >= t.date
       AND EXISTS (SELECT 1 FROM public.payslips p
                    WHERE p.payroll_run_id = pr.id AND p.employee_id = t.employee_id)
    RETURNING pr.id
  )
  SELECT count(*) INTO v_drafts FROM touched;

  INSERT INTO public.audit_logs (
    organization_id, business_id, user_id, action, entity_type, entity_id,
    entity_name, new_values, changes_summary
  )
  SELECT pr.organization_id, pr.business_id, _actor,
         'payroll.timesheet.affects_finalized_run', 'payroll_run', pr.id,
         pr.payroll_number,
         jsonb_build_object('timesheet_id', t.id, 'employee_id', t.employee_id,
                            'entry_status', t.status, 'entry_date', t.date, 'run_status', pr.status),
         format('Time entry on %s was %s after this run was finalized; file a correction run if it should apply.',
                t.date, COALESCE(t.status, 'changed'))
    FROM public.payroll_runs pr
   WHERE pr.organization_id = t.organization_id
     AND (t.business_id IS NULL OR pr.business_id = t.business_id)
     AND pr.status IN ('approved', 'posted', 'paid', 'reversed')
     AND pr.pay_period_start <= t.date
     AND pr.pay_period_end >= t.date
     AND EXISTS (SELECT 1 FROM public.payslips p
                  WHERE p.payroll_run_id = pr.id AND p.employee_id = t.employee_id);

  RETURN jsonb_build_object('ok', true, 'runs_flagged', v_drafts);
END $$;

REVOKE ALL ON FUNCTION public.payroll_flag_runs_for_timesheet(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_flag_runs_for_timesheet(uuid, uuid) TO service_role;

-- Register the consumers for the timesheet-scoped topics
INSERT INTO public.business_event_subscriptions
  (event_type, subscriber_name, handler_function, consumer_domain, is_active)
VALUES
  ('timesheet.corrected', 'projects.spent_hours_recompute_entry',
   'public.projects_recompute_spent_hours_for_timesheet(uuid)', 'projects', true),
  ('timesheet.corrected', 'payroll.timesheet_entry_recompute_flag',
   'public.payroll_flag_runs_for_timesheet(uuid,uuid)', 'payroll', true),
  ('timesheet.locked', 'payroll.timesheet_entry_recompute_flag',
   'public.payroll_flag_runs_for_timesheet(uuid,uuid)', 'payroll', true),
  ('timesheet.unlocked', 'payroll.timesheet_entry_recompute_flag',
   'public.payroll_flag_runs_for_timesheet(uuid,uuid)', 'payroll', true),
  ('timesheet.unlocked', 'projects.spent_hours_recompute_entry',
   'public.projects_recompute_spent_hours_for_timesheet(uuid)', 'projects', true)
ON CONFLICT DO NOTHING;

-- Dispatcher: handle both submission-scoped and timesheet-scoped timesheet events
CREATE OR REPLACE FUNCTION public.tg_business_event_outbox_react_timesheet()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.event_type IS NULL OR NEW.event_type NOT LIKE 'timesheet.%' THEN RETURN NEW; END IF;
  IF NEW.source_doc_id IS NULL THEN RETURN NEW; END IF;

  IF NEW.source_doc_type = 'timesheet_submission'
     AND NEW.event_type IN ('timesheet.approved', 'timesheet.rejected') THEN
    IF EXISTS (SELECT 1 FROM public.business_event_subscriptions
                WHERE event_type = NEW.event_type
                  AND subscriber_name = 'projects.spent_hours_recompute' AND is_active) THEN
      PERFORM public.projects_recompute_spent_hours_for_submission(NEW.source_doc_id);
    END IF;
    IF EXISTS (SELECT 1 FROM public.business_event_subscriptions
                WHERE event_type = NEW.event_type
                  AND subscriber_name = 'payroll.timesheet_recompute_flag' AND is_active) THEN
      PERFORM public.payroll_flag_runs_for_timesheet_submission(NEW.source_doc_id, NEW.actor_user_id);
    END IF;

  ELSIF NEW.source_doc_type = 'timesheet'
     AND NEW.event_type IN ('timesheet.corrected', 'timesheet.locked', 'timesheet.unlocked') THEN
    IF EXISTS (SELECT 1 FROM public.business_event_subscriptions
                WHERE event_type = NEW.event_type
                  AND subscriber_name = 'projects.spent_hours_recompute_entry' AND is_active) THEN
      PERFORM public.projects_recompute_spent_hours_for_timesheet(NEW.source_doc_id);
    END IF;
    IF EXISTS (SELECT 1 FROM public.business_event_subscriptions
                WHERE event_type = NEW.event_type
                  AND subscriber_name = 'payroll.timesheet_entry_recompute_flag' AND is_active) THEN
      PERFORM public.payroll_flag_runs_for_timesheet(NEW.source_doc_id, NEW.actor_user_id);
    END IF;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never break the outbox writer; the event stays durably enqueued.
  RAISE WARNING '[tg_business_event_outbox_react_timesheet] % (%): %', SQLERRM, SQLSTATE, NEW.event_type;
  RETURN NEW;
END $$;

-- Record the two intentionally pull-consumed topics so "no subscriber" is a decision, not a gap
UPDATE public.business_event_topics
   SET description = 'Time period submitted for approval. Pull-consumed: approver notification is delivered by trg_timesheet_submission_notify; reporting reads the outbox. No push subscriber by design.',
       updated_at = now()
 WHERE topic_prefix = 'timesheet.submitted';

UPDATE public.business_event_topics
   SET description = 'Approved billable time is ready to invoice. Pull-consumed: Sales decides when to bill via sales_invoice_project_timesheets; Finance/reporting read the outbox. No push subscriber by design.',
       updated_at = now()
 WHERE topic_prefix = 'timesheet.billable_ready';