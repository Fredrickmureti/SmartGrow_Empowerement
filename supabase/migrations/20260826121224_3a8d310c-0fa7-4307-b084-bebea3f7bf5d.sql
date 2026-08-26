-- ============================================================
-- Wave 3: reconnect the timesheet event boundary
-- ============================================================

-- Projects domain: owns projects.spent_hours.
CREATE OR REPLACE FUNCTION public.projects_recompute_spent_hours_for_submission(
  _submission_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE s record; v_count int := 0;
BEGIN
  SELECT * INTO s FROM public.timesheet_submissions WHERE id = _submission_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'submission_not_found'); END IF;

  WITH affected AS (
    SELECT DISTINCT t.project_id
      FROM public.timesheets t
     WHERE t.employee_id = s.employee_id
       AND t.date BETWEEN s.period_start AND s.period_end
       AND t.project_id IS NOT NULL
  ), recomputed AS (
    UPDATE public.projects p
       SET spent_hours = COALESCE((
             SELECT SUM(t2.hours) FROM public.timesheets t2
              WHERE t2.project_id = p.id AND t2.status = 'approved'
           ), 0),
           updated_at = now()
     WHERE p.id IN (SELECT project_id FROM affected)
    RETURNING p.id
  )
  SELECT count(*) INTO v_count FROM recomputed;

  RETURN jsonb_build_object('ok', true, 'projects_updated', v_count);
END $$;

REVOKE ALL ON FUNCTION public.projects_recompute_spent_hours_for_submission(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.projects_recompute_spent_hours_for_submission(uuid) TO authenticated, service_role;

-- Payroll domain: owns payroll_runs recompute flags.
CREATE OR REPLACE FUNCTION public.payroll_flag_runs_for_timesheet_submission(
  _submission_id uuid, _actor uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE s record; v_reason text; v_drafts int := 0;
BEGIN
  SELECT * INTO s FROM public.timesheet_submissions WHERE id = _submission_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'submission_not_found'); END IF;

  v_reason := 'timesheet_' || s.status || '_' || s.id::text;

  WITH touched AS (
    UPDATE public.payroll_runs pr
       SET needs_recompute_reason = v_reason, updated_at = now()
     WHERE pr.organization_id = s.organization_id
       AND (s.business_id IS NULL OR pr.business_id = s.business_id)
       AND pr.status IN ('draft', 'pending_approval')
       AND pr.pay_period_end >= s.period_start
       AND pr.pay_period_start <= s.period_end
       AND EXISTS (SELECT 1 FROM public.payslips p
                    WHERE p.payroll_run_id = pr.id AND p.employee_id = s.employee_id)
    RETURNING pr.id
  )
  SELECT count(*) INTO v_drafts FROM touched;

  -- Finalized runs are immutable: advise a correction run instead of mutating.
  INSERT INTO public.audit_logs (
    organization_id, business_id, user_id, action, entity_type, entity_id,
    entity_name, new_values, changes_summary
  )
  SELECT pr.organization_id, pr.business_id, _actor,
         'payroll.timesheet.affects_finalized_run', 'payroll_run', pr.id,
         pr.payroll_number,
         jsonb_build_object('timesheet_submission_id', s.id, 'employee_id', s.employee_id,
                            'submission_status', s.status, 'run_status', pr.status,
                            'period_start', s.period_start, 'period_end', s.period_end),
         format('Timesheet period %s → %s was %s after this run was finalized; file a correction run if it should apply.',
                s.period_start, s.period_end, s.status)
    FROM public.payroll_runs pr
   WHERE pr.organization_id = s.organization_id
     AND (s.business_id IS NULL OR pr.business_id = s.business_id)
     AND pr.status IN ('approved', 'posted', 'paid', 'reversed')
     AND pr.pay_period_end >= s.period_start
     AND pr.pay_period_start <= s.period_end
     AND EXISTS (SELECT 1 FROM public.payslips p
                  WHERE p.payroll_run_id = pr.id AND p.employee_id = s.employee_id);

  RETURN jsonb_build_object('ok', true, 'runs_flagged', v_drafts);
END $$;

REVOKE ALL ON FUNCTION public.payroll_flag_runs_for_timesheet_submission(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.payroll_flag_runs_for_timesheet_submission(uuid, uuid) TO authenticated, service_role;

-- Outbox reactor: dispatches timesheet.* to the registered domain handlers.
CREATE OR REPLACE FUNCTION public.tg_business_event_outbox_react_timesheet()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.event_type IS NULL OR NEW.event_type NOT LIKE 'timesheet.%' THEN RETURN NEW; END IF;
  IF NEW.source_doc_type <> 'timesheet_submission' OR NEW.source_doc_id IS NULL THEN RETURN NEW; END IF;

  IF NEW.event_type IN ('timesheet.approved', 'timesheet.rejected') THEN
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
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never break the outbox writer; the event stays durably enqueued.
  RAISE WARNING '[tg_business_event_outbox_react_timesheet] % (%): %', SQLERRM, SQLSTATE, NEW.event_type;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_business_event_outbox_react_timesheet ON public.business_event_outbox;
CREATE TRIGGER trg_business_event_outbox_react_timesheet
  AFTER INSERT ON public.business_event_outbox
  FOR EACH ROW EXECUTE FUNCTION public.tg_business_event_outbox_react_timesheet();

INSERT INTO public.business_event_subscriptions
  (event_type, subscriber_name, handler_function, consumer_domain)
VALUES
  ('timesheet.approved', 'projects.spent_hours_recompute',
   'public.projects_recompute_spent_hours_for_submission(uuid)', 'projects'),
  ('timesheet.rejected', 'projects.spent_hours_recompute',
   'public.projects_recompute_spent_hours_for_submission(uuid)', 'projects'),
  ('timesheet.approved', 'payroll.timesheet_recompute_flag',
   'public.payroll_flag_runs_for_timesheet_submission(uuid,uuid)', 'payroll'),
  ('timesheet.rejected', 'payroll.timesheet_recompute_flag',
   'public.payroll_flag_runs_for_timesheet_submission(uuid,uuid)', 'payroll')
ON CONFLICT (event_type, subscriber_name) DO UPDATE
  SET handler_function = EXCLUDED.handler_function,
      consumer_domain  = EXCLUDED.consumer_domain,
      is_active        = true;

-- ============================================================
-- Wave 4: Sales owns invoice creation; Timesheets owns its own flags
-- ============================================================

-- Timesheets-owned write: stamp claimed hours as invoiced.
CREATE OR REPLACE FUNCTION public.timesheets_mark_invoiced(_ids uuid[], _invoice_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_marked int := 0;
BEGIN
  IF _ids IS NULL OR array_length(_ids, 1) IS NULL THEN RETURN 0; END IF;
  UPDATE public.timesheets
     SET is_invoiced = true, invoice_id = _invoice_id
   WHERE id = ANY(_ids) AND COALESCE(is_invoiced, false) = false;
  GET DIAGNOSTICS v_marked = ROW_COUNT;
  IF v_marked <> array_length(_ids, 1) THEN
    RAISE EXCEPTION 'timesheet_claim_conflict: % of % rows marked', v_marked, array_length(_ids, 1)
      USING ERRCODE = '40001';
  END IF;
  RETURN v_marked;
END $$;

REVOKE ALL ON FUNCTION public.timesheets_mark_invoiced(uuid[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.timesheets_mark_invoiced(uuid[], uuid) TO authenticated, service_role;

-- Sales-owned billing run.
CREATE OR REPLACE FUNCTION public.sales_invoice_project_timesheets(
  _project_id uuid, _period_from date DEFAULT NULL, _period_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_project public.projects%ROWTYPE;
  v_invoice_id uuid;
  v_invoice_number text;
  v_subtotal numeric := 0;
  v_lines integer := 0;
  v_hours numeric := 0;
  v_ids uuid[];
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;

  SELECT * INTO v_project FROM public.projects WHERE id = _project_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'project_not_found' USING ERRCODE = 'P0002'; END IF;

  IF NOT public.project_can_read(_project_id, v_uid) THEN
    RAISE EXCEPTION 'not_authorized_for_project' USING ERRCODE = '42501';
  END IF;
  IF NOT public.user_has_module_permission(v_uid, v_project.organization_id, 'sales', 'create') THEN
    RAISE EXCEPTION 'not_authorized_to_invoice' USING ERRCODE = '42501';
  END IF;
  IF v_project.customer_id IS NULL THEN
    RAISE EXCEPTION 'project_has_no_customer' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('invoice_project_timesheets_' || _project_id::text));

  CREATE TEMP TABLE _claimed_ts ON COMMIT DROP AS
  SELECT t.id, t.employee_id, t.task_id, COALESCE(t.hours, 0)::numeric AS hours,
         t.billing_rate, t.billing_amount
    FROM public.timesheets t
   WHERE t.project_id = _project_id
     AND t.is_billable = true
     AND t.status = 'approved'
     AND COALESCE(t.is_invoiced, false) = false
     AND (_period_from IS NULL OR t.date >= _period_from)
     AND (_period_to IS NULL OR t.date <= _period_to)
   FOR UPDATE OF t;

  IF (SELECT count(*) FROM _claimed_ts) = 0 THEN
    RETURN jsonb_build_object('ok', true, 'invoice_id', NULL, 'lines', 0, 'hours', 0,
                              'subtotal', 0, 'message', 'no_billable_timesheets');
  END IF;

  CREATE TEMP TABLE _groups ON COMMIT DROP AS
  WITH resolved AS (
    SELECT c.id, c.employee_id, c.task_id, c.hours,
           COALESCE(c.billing_rate, pm.billable_rate, v_project.default_billable_rate, 0)::numeric AS rate
      FROM _claimed_ts c
      LEFT JOIN public.employees e ON e.id = c.employee_id
      LEFT JOIN public.project_members pm
        ON pm.project_id = _project_id AND pm.user_id = e.user_id
  )
  SELECT r.employee_id, r.task_id, r.rate,
         SUM(r.hours) AS hours,
         SUM(COALESCE(c.billing_amount, r.hours * r.rate)) AS amount
    FROM resolved r
    JOIN _claimed_ts c ON c.id = r.id
   GROUP BY r.employee_id, r.task_id, r.rate;

  SELECT COALESCE(SUM(amount), 0), COALESCE(SUM(hours), 0), count(*)
    INTO v_subtotal, v_hours, v_lines FROM _groups;

  v_invoice_number := public.get_next_invoice_number(v_project.organization_id, v_project.business_id);

  INSERT INTO public.invoices (
    organization_id, business_id, branch_id, contact_id, project_id,
    invoice_number, status, issue_date, due_date,
    subtotal, tax_amount, total, currency, notes, created_by
  ) VALUES (
    v_project.organization_id, v_project.business_id, v_project.branch_id,
    v_project.customer_id, v_project.id,
    v_invoice_number, 'draft', CURRENT_DATE, CURRENT_DATE + 30,
    v_subtotal, 0, v_subtotal, v_project.currency,
    'Timesheet billing for project ' || v_project.name
      || CASE WHEN _period_from IS NOT NULL OR _period_to IS NOT NULL
              THEN ' (' || COALESCE(_period_from::text, '…') || ' → ' || COALESCE(_period_to::text, '…') || ')'
              ELSE '' END,
    v_uid
  ) RETURNING id INTO v_invoice_id;

  INSERT INTO public.invoice_items (
    invoice_id, business_id, description, quantity, unit_price,
    tax_rate, discount_percent, line_total, sort_order, project_id, task_id
  )
  SELECT v_invoice_id, v_project.business_id,
         'Timesheet hours' || COALESCE(' — ' || tk.title, ''),
         g.hours, g.rate, 0, 0, g.amount,
         (row_number() OVER (ORDER BY g.employee_id, g.task_id, g.rate))::int - 1,
         _project_id, g.task_id
    FROM _groups g
    LEFT JOIN public.project_tasks tk ON tk.id = g.task_id;

  SELECT array_agg(id) INTO v_ids FROM _claimed_ts;

  -- Timesheets owns its own columns: ask that domain to stamp the claim.
  PERFORM public.timesheets_mark_invoiced(v_ids, v_invoice_id);

  RETURN jsonb_build_object('ok', true, 'invoice_id', v_invoice_id,
    'invoice_number', v_invoice_number, 'lines', v_lines, 'hours', v_hours,
    'subtotal', v_subtotal, 'currency', v_project.currency);
END $$;

REVOKE ALL ON FUNCTION public.sales_invoice_project_timesheets(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sales_invoice_project_timesheets(uuid, date, date) TO authenticated, service_role;

-- Legacy entry point keeps working, but no longer owns invoice authorship.
CREATE OR REPLACE FUNCTION public.invoice_project_timesheets(
  _project_id uuid, _period_from date DEFAULT NULL, _period_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  SELECT public.sales_invoice_project_timesheets(_project_id, _period_from, _period_to);
$$;

REVOKE ALL ON FUNCTION public.invoice_project_timesheets(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invoice_project_timesheets(uuid, date, date) TO authenticated, service_role;