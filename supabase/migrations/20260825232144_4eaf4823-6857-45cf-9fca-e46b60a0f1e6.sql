CREATE OR REPLACE FUNCTION public.invoice_project_timesheets(
  _project_id uuid,
  _period_from date DEFAULT NULL,
  _period_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_project public.projects%ROWTYPE;
  v_invoice_id uuid;
  v_invoice_number text;
  v_subtotal numeric := 0;
  v_lines integer := 0;
  v_hours numeric := 0;
  v_marked integer := 0;
  v_ids uuid[];
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_project FROM public.projects WHERE id = _project_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'project_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Authorization: must be able to read the project (tenant + branch + membership)
  -- and be allowed to create sales documents in the owning organization.
  IF NOT public.project_can_read(_project_id, v_uid) THEN
    RAISE EXCEPTION 'not_authorized_for_project' USING ERRCODE = '42501';
  END IF;
  IF NOT public.user_has_module_permission(v_uid, v_project.organization_id, 'sales', 'create') THEN
    RAISE EXCEPTION 'not_authorized_to_invoice' USING ERRCODE = '42501';
  END IF;

  IF v_project.customer_id IS NULL THEN
    RAISE EXCEPTION 'project_has_no_customer' USING ERRCODE = '22023';
  END IF;

  -- Serialize concurrent billing runs for this project.
  PERFORM pg_advisory_xact_lock(hashtext('invoice_project_timesheets_' || _project_id::text));

  -- Claim the source rows under lock so a concurrent run cannot pick them up.
  CREATE TEMP TABLE _claimed_ts ON COMMIT DROP AS
  SELECT t.id,
         t.employee_id,
         t.task_id,
         COALESCE(t.hours, 0)::numeric AS hours,
         t.billing_rate,
         t.billing_amount
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

  -- Effective rate: timesheet rate (owned by the canonical billing-rate engine),
  -- then the member override, then the project default. No client input.
  CREATE TEMP TABLE _groups ON COMMIT DROP AS
  WITH resolved AS (
    SELECT c.id,
           c.employee_id,
           c.task_id,
           c.hours,
           COALESCE(c.billing_rate, pm.billable_rate, v_project.default_billable_rate, 0)::numeric AS rate
    FROM _claimed_ts c
    LEFT JOIN public.employees e ON e.id = c.employee_id
    LEFT JOIN public.project_members pm
      ON pm.project_id = _project_id AND pm.user_id = e.user_id
  )
  SELECT r.employee_id,
         r.task_id,
         r.rate,
         SUM(r.hours) AS hours,
         SUM(COALESCE(c.billing_amount, r.hours * r.rate)) AS amount
  FROM resolved r
  JOIN _claimed_ts c ON c.id = r.id
  GROUP BY r.employee_id, r.task_id, r.rate;

  SELECT COALESCE(SUM(amount), 0), COALESCE(SUM(hours), 0), count(*)
    INTO v_subtotal, v_hours, v_lines
  FROM _groups;

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
  SELECT v_invoice_id,
         v_project.business_id,
         'Timesheet hours' || COALESCE(' — ' || tk.title, ''),
         g.hours,
         g.rate,
         0, 0,
         g.amount,
         (row_number() OVER (ORDER BY g.employee_id, g.task_id, g.rate))::int - 1,
         _project_id,
         g.task_id
  FROM _groups g
  LEFT JOIN public.project_tasks tk ON tk.id = g.task_id;

  SELECT array_agg(id) INTO v_ids FROM _claimed_ts;

  UPDATE public.timesheets
     SET is_invoiced = true, invoice_id = v_invoice_id
   WHERE id = ANY(v_ids)
     AND COALESCE(is_invoiced, false) = false;
  GET DIAGNOSTICS v_marked = ROW_COUNT;

  IF v_marked <> array_length(v_ids, 1) THEN
    RAISE EXCEPTION 'timesheet_claim_conflict: % of % rows marked', v_marked, array_length(v_ids, 1)
      USING ERRCODE = '40001';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'invoice_id', v_invoice_id,
    'invoice_number', v_invoice_number,
    'lines', v_lines,
    'hours', v_hours,
    'subtotal', v_subtotal,
    'currency', v_project.currency
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.invoice_project_timesheets(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invoice_project_timesheets(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_project_timesheets(uuid, date, date) TO service_role;