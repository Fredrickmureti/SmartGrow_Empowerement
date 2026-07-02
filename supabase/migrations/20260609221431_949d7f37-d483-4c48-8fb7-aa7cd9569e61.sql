
-- 1) Fix overtime_request_submit: correct notifications schema; remove broken EXCEPTION swallow.
CREATE OR REPLACE FUNCTION public.overtime_request_submit(
  _employee_id uuid,
  _ot_date date,
  _hours numeric,
  _reason text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_emp record;
  v_user uuid := auth.uid();
  v_id uuid;
  v_full_name text;
  v_msg text;
BEGIN
  SELECT * INTO v_emp FROM public.employees WHERE id = _employee_id;
  IF v_emp.id IS NULL THEN RAISE EXCEPTION 'EMPLOYEE_NOT_FOUND'; END IF;
  IF v_emp.user_id IS DISTINCT FROM v_user
     AND NOT public.user_has_module_permission(v_user, v_emp.organization_id, 'attendance', 'write') THEN
    RAISE EXCEPTION 'PERMISSION_DENIED';
  END IF;

  INSERT INTO public.overtime_requests(
    organization_id, business_id, branch_id, employee_id, ot_date,
    requested_hours, reason, requested_by
  ) VALUES (
    v_emp.organization_id, v_emp.business_id, v_emp.branch_id, _employee_id, _ot_date,
    _hours, _reason, v_user
  ) RETURNING id INTO v_id;

  v_full_name := COALESCE(v_emp.first_name,'') || ' ' || COALESCE(v_emp.last_name,'');
  v_msg := format('%s requested %.2fh OT on %s', v_full_name, _hours, to_char(_ot_date, 'Mon DD, YYYY'));

  -- Notify managers in org (best-effort, schema-correct).
  INSERT INTO public.notifications (
    organization_id, business_id, user_id,
    type, category, title, message, link,
    entity_type, entity_id, priority
  )
  SELECT
    v_emp.organization_id, v_emp.business_id, ur.user_id,
    'in_app', 'attendance',
    'Overtime request submitted',
    v_msg,
    '/hr/attendance/approvals?tab=overtime',
    'overtime_request', v_id, 2
  FROM public.user_roles ur
  WHERE ur.organization_id = v_emp.organization_id
    AND ur.role IN ('super_admin','owner','admin','hr_officer','manager')
    AND ur.user_id IS NOT NULL;

  RETURN v_id;
END
$function$;

-- 2) overtime_request_decide: notify the requesting employee.
CREATE OR REPLACE FUNCTION public.overtime_request_decide(
  _id uuid,
  _decision text,
  _reason text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v record;
  v_user uuid := auth.uid();
  v_emp_user uuid;
  v_msg text;
BEGIN
  IF _decision NOT IN ('approved','rejected','cancelled') THEN
    RAISE EXCEPTION 'INVALID_DECISION';
  END IF;
  SELECT * INTO v FROM public.overtime_requests WHERE id = _id;
  IF v.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF NOT public.user_has_module_permission(v_user, v.organization_id, 'attendance', 'write') THEN
    RAISE EXCEPTION 'PERMISSION_DENIED';
  END IF;

  UPDATE public.overtime_requests
     SET status = _decision,
         approved_by = v_user,
         approved_at = now(),
         rejection_reason = CASE WHEN _decision='rejected' THEN _reason ELSE rejection_reason END,
         updated_at = now()
   WHERE id = _id;

  -- Notify the employee that submitted the request.
  SELECT user_id INTO v_emp_user FROM public.employees WHERE id = v.employee_id;
  IF v_emp_user IS NOT NULL THEN
    v_msg := format('Your %.2fh OT request for %s was %s%s',
                    v.requested_hours,
                    to_char(v.ot_date,'Mon DD, YYYY'),
                    _decision,
                    COALESCE(' — ' || _reason, ''));
    INSERT INTO public.notifications (
      organization_id, business_id, user_id,
      type, category, title, message, link,
      entity_type, entity_id, priority
    ) VALUES (
      v.organization_id, v.business_id, v_emp_user,
      'in_app', 'attendance',
      'Overtime ' || _decision,
      v_msg,
      '/me/attendance',
      'overtime_request', v.id, 2
    );
  END IF;

  RETURN _id;
END
$function$;

-- 3) attendance_generate_work_entries: cap overtime_hours by approved OT requests.
CREATE OR REPLACE FUNCTION public.attendance_generate_work_entries(_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_run record;
  v_total_emp int := 0;
  v_total_hours numeric := 0;
  v_total_ot numeric := 0;
  v_locked int := 0;
BEGIN
  SELECT * INTO v_run FROM public.payroll_runs WHERE id = _run_id;
  IF v_run.id IS NULL THEN RAISE EXCEPTION 'PAYROLL_RUN_NOT_FOUND'; END IF;

  IF v_user IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = v_user AND organization_id = v_run.organization_id
       AND role IN ('super_admin','owner','admin','accountant')
  ) THEN
    RAISE EXCEPTION 'PERMISSION_DENIED';
  END IF;

  IF v_run.status NOT IN ('draft','processing') THEN
    RAISE EXCEPTION 'RUN_NOT_EDITABLE';
  END IF;

  v_locked := public.attendance_lock_for_period(
    v_run.organization_id, v_run.pay_period_start, v_run.pay_period_end, _run_id, NULL
  );

  -- Approved OT cap per employee for the period.
  WITH approved_ot AS (
    SELECT employee_id, COALESCE(SUM(requested_hours), 0) AS approved_hours
      FROM public.overtime_requests
     WHERE organization_id = v_run.organization_id
       AND (v_run.business_id IS NULL OR business_id = v_run.business_id)
       AND status = 'approved'
       AND ot_date BETWEEN v_run.pay_period_start AND v_run.pay_period_end
     GROUP BY employee_id
  ),
  att AS (
    SELECT a.employee_id,
           COALESCE(SUM(a.worked_hours), 0) AS hours,
           COALESCE(SUM(a.overtime_hours), 0) AS raw_ot,
           COUNT(*) AS cnt
      FROM public.attendance a
     WHERE a.organization_id = v_run.organization_id
       AND (v_run.business_id IS NULL OR a.business_id = v_run.business_id)
       AND a.attendance_date BETWEEN v_run.pay_period_start AND v_run.pay_period_end
       AND a.clock_out IS NOT NULL
       AND COALESCE(a.correction_status,'none') <> 'pending'
       AND a.status NOT IN ('on_leave','holiday','absent')
     GROUP BY a.employee_id
  )
  INSERT INTO public.payroll_work_entries (
    organization_id, business_id, payroll_run_id, employee_id,
    work_date_start, work_date_end, hours, overtime_hours, source, attendance_count
  )
  SELECT
    v_run.organization_id, v_run.business_id, _run_id, att.employee_id,
    v_run.pay_period_start, v_run.pay_period_end,
    att.hours,
    LEAST(att.raw_ot, COALESCE(ao.approved_hours, 0)),
    'attendance',
    att.cnt
  FROM att
  LEFT JOIN approved_ot ao ON ao.employee_id = att.employee_id
  ON CONFLICT (payroll_run_id, employee_id, source, work_entry_type_id)
  DO UPDATE SET
    hours            = EXCLUDED.hours,
    overtime_hours   = EXCLUDED.overtime_hours,
    attendance_count = EXCLUDED.attendance_count,
    work_date_start  = EXCLUDED.work_date_start,
    work_date_end    = EXCLUDED.work_date_end;

  -- Aggregate approved leave days for the period.
  INSERT INTO public.payroll_work_entries (
    organization_id, business_id, payroll_run_id, employee_id,
    work_date_start, work_date_end, hours, overtime_hours, source, attendance_count
  )
  SELECT
    v_run.organization_id, v_run.business_id, _run_id, a.employee_id,
    v_run.pay_period_start, v_run.pay_period_end,
    COUNT(*) * 8, 0, 'leave', COUNT(*)
  FROM public.attendance a
  WHERE a.organization_id = v_run.organization_id
    AND (v_run.business_id IS NULL OR a.business_id = v_run.business_id)
    AND a.attendance_date BETWEEN v_run.pay_period_start AND v_run.pay_period_end
    AND a.status = 'on_leave'
  GROUP BY a.employee_id
  ON CONFLICT (payroll_run_id, employee_id, source, work_entry_type_id)
  DO UPDATE SET
    hours            = EXCLUDED.hours,
    attendance_count = EXCLUDED.attendance_count,
    work_date_start  = EXCLUDED.work_date_start,
    work_date_end    = EXCLUDED.work_date_end;

  DELETE FROM public.payroll_work_entries pwe
   WHERE pwe.payroll_run_id = _run_id
     AND pwe.source IN ('attendance','leave')
     AND NOT EXISTS (
       SELECT 1 FROM public.attendance a
        WHERE a.organization_id = v_run.organization_id
          AND (v_run.business_id IS NULL OR a.business_id = v_run.business_id)
          AND a.attendance_date BETWEEN v_run.pay_period_start AND v_run.pay_period_end
          AND a.employee_id = pwe.employee_id
          AND (
            (pwe.source = 'attendance' AND a.clock_out IS NOT NULL
              AND COALESCE(a.correction_status,'none') <> 'pending'
              AND a.status NOT IN ('on_leave','holiday','absent'))
            OR
            (pwe.source = 'leave' AND a.status = 'on_leave')
          )
     );

  SELECT COUNT(DISTINCT employee_id), COALESCE(SUM(hours),0), COALESCE(SUM(overtime_hours),0)
    INTO v_total_emp, v_total_hours, v_total_ot
   FROM public.payroll_work_entries
  WHERE payroll_run_id = _run_id;

  RETURN jsonb_build_object(
    'employees', v_total_emp,
    'hours', v_total_hours,
    'overtime_hours', v_total_ot,
    'locked_attendance_rows', v_locked
  );
END
$function$;

-- 4) Realtime: ensure overtime_requests + attendance_corrections are published with FULL replica identity.
ALTER TABLE public.overtime_requests REPLICA IDENTITY FULL;
ALTER TABLE public.attendance_corrections REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND tablename = 'overtime_requests'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.overtime_requests';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND tablename = 'attendance_corrections'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.attendance_corrections';
  END IF;
END$$;
