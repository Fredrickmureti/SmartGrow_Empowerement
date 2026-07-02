
-- WAVE 3.3 — payroll work-entry idempotency
CREATE UNIQUE INDEX IF NOT EXISTS payroll_work_entries_dedupe_idx
  ON public.payroll_work_entries (payroll_run_id, employee_id, source, work_entry_type_id)
  NULLS NOT DISTINCT;

CREATE OR REPLACE FUNCTION public.attendance_generate_work_entries(_run_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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

  -- Aggregate approved attendance, upserting by (run, employee, source, type).
  INSERT INTO public.payroll_work_entries (
    organization_id, business_id, payroll_run_id, employee_id,
    work_date_start, work_date_end, hours, overtime_hours, source, attendance_count
  )
  SELECT
    v_run.organization_id, v_run.business_id, _run_id, a.employee_id,
    v_run.pay_period_start, v_run.pay_period_end,
    COALESCE(SUM(a.worked_hours),0),
    COALESCE(SUM(a.overtime_hours),0),
    'attendance',
    COUNT(*)
  FROM public.attendance a
  WHERE a.organization_id = v_run.organization_id
    AND (v_run.business_id IS NULL OR a.business_id = v_run.business_id)
    AND a.attendance_date BETWEEN v_run.pay_period_start AND v_run.pay_period_end
    AND a.clock_out IS NOT NULL
    AND COALESCE(a.correction_status,'none') <> 'pending'
    AND a.status NOT IN ('on_leave','holiday','absent')
  GROUP BY a.employee_id
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

  -- Garbage-collect any prior rows for employees no longer represented.
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
