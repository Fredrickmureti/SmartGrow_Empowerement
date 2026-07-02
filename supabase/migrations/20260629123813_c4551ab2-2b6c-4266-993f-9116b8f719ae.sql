
CREATE OR REPLACE FUNCTION public.payroll_work_entries_project(_run_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_run  record;
  v_require_preapproval boolean := false;
  v_locked int := 0;
  v_types jsonb := '{}'::jsonb;
  v_employees int := 0;
  v_sources text[] := ARRAY[]::text[];
  v_id_work uuid; v_id_ot uuid; v_id_lp uuid; v_id_lu uuid; v_id_h uuid;
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

  PERFORM public.ensure_canonical_work_entry_types(v_run.organization_id);
  SELECT id INTO v_id_work FROM public.payroll_work_entry_types
    WHERE organization_id = v_run.organization_id AND code = 'WORK';
  SELECT id INTO v_id_ot   FROM public.payroll_work_entry_types
    WHERE organization_id = v_run.organization_id AND code = 'OT';
  SELECT id INTO v_id_lp   FROM public.payroll_work_entry_types
    WHERE organization_id = v_run.organization_id AND code = 'LEAVE_PAID';
  SELECT id INTO v_id_lu   FROM public.payroll_work_entry_types
    WHERE organization_id = v_run.organization_id AND code = 'LEAVE_UNPAID';
  SELECT id INTO v_id_h    FROM public.payroll_work_entry_types
    WHERE organization_id = v_run.organization_id AND code = 'HOLIDAY';

  v_locked := public.attendance_lock_for_period(
    v_run.organization_id, v_run.pay_period_start, v_run.pay_period_end, _run_id, NULL
  );

  SELECT COALESCE(BOOL_OR(require_ot_preapproval), false)
    INTO v_require_preapproval
    FROM public.attendance_settings
   WHERE organization_id = v_run.organization_id
     AND (v_run.business_id IS NULL OR business_id = v_run.business_id);

  DELETE FROM public.payroll_work_entries WHERE payroll_run_id = _run_id;

  -- 3a) Attendance — WORK + OT
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
           COALESCE(SUM(a.worked_hours), 0)   AS hours,
           COALESCE(SUM(a.overtime_hours), 0) AS derived_ot,
           COUNT(*) AS cnt
      FROM public.attendance a
      LEFT JOIN public.employee_contracts c
        ON c.employee_id = a.employee_id AND c.status = 'active'
     WHERE a.organization_id = v_run.organization_id
       AND (v_run.business_id IS NULL OR a.business_id = v_run.business_id)
       AND a.attendance_date BETWEEN v_run.pay_period_start AND v_run.pay_period_end
       AND a.clock_out IS NOT NULL
       AND COALESCE(a.correction_status,'none') <> 'pending'
       AND a.status NOT IN ('on_leave','holiday','absent')
       AND COALESCE(c.time_tracking_source,'attendance') <> 'timesheets'
     GROUP BY a.employee_id
  )
  INSERT INTO public.payroll_work_entries (
    organization_id, business_id, payroll_run_id, employee_id,
    work_date_start, work_date_end, hours, overtime_hours, source,
    attendance_count, work_entry_type_id
  )
  SELECT v_run.organization_id, v_run.business_id, _run_id, att.employee_id,
         v_run.pay_period_start, v_run.pay_period_end,
         GREATEST(att.hours - att.derived_ot, 0), 0, 'attendance', att.cnt, v_id_work
    FROM att
   WHERE att.hours > 0
  UNION ALL
  SELECT v_run.organization_id, v_run.business_id, _run_id, att.employee_id,
         v_run.pay_period_start, v_run.pay_period_end, 0,
         CASE WHEN v_require_preapproval
              THEN LEAST(att.derived_ot, COALESCE(ao.approved_hours, 0))
              ELSE att.derived_ot END,
         'attendance', att.cnt, v_id_ot
    FROM att LEFT JOIN approved_ot ao ON ao.employee_id = att.employee_id
   WHERE CASE WHEN v_require_preapproval
              THEN LEAST(att.derived_ot, COALESCE(ao.approved_hours, 0))
              ELSE att.derived_ot END > 0;

  IF EXISTS (SELECT 1 FROM public.payroll_work_entries WHERE payroll_run_id = _run_id AND source='attendance') THEN
    v_sources := v_sources || 'attendance';
  END IF;

  -- 3b) Timesheets
  BEGIN
    EXECUTE $sql$
      INSERT INTO public.payroll_work_entries (
        organization_id, business_id, payroll_run_id, employee_id,
        work_date_start, work_date_end, hours, overtime_hours, source,
        attendance_count, work_entry_type_id
      )
      SELECT $1, $2, $3, t.employee_id, $4, $5,
             COALESCE(t.total_hours, 0), 0, 'timesheet',
             COALESCE(t.day_count, 0), $6
        FROM public.v_timesheet_payroll_ready t
        JOIN public.employee_contracts c
          ON c.employee_id = t.employee_id AND c.status = 'active'
       WHERE t.organization_id = $1
         AND ($2::uuid IS NULL OR t.business_id = $2)
         AND t.pay_period_start = $4
         AND t.pay_period_end   = $5
         AND c.time_tracking_source = 'timesheets'
         AND COALESCE(t.total_hours,0) > 0
    $sql$ USING v_run.organization_id, v_run.business_id, _run_id,
                v_run.pay_period_start, v_run.pay_period_end, v_id_work;
    IF EXISTS (SELECT 1 FROM public.payroll_work_entries WHERE payroll_run_id = _run_id AND source='timesheet') THEN
      v_sources := v_sources || 'timesheet';
    END IF;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    NULL;
  END;

  -- 3c) Leave — schedule-aware hour expansion.
  --     Fallback when an employee has no schedule entry for a DOW:
  --       work_schedule.standard_hours_per_day → org default schedule.standard_hours_per_day → 0
  --     (No hardcoded 8h constant.)
  WITH org_default AS (
    SELECT COALESCE(MAX(standard_hours_per_day), 0)::numeric AS h
      FROM public.work_schedules
     WHERE organization_id = v_run.organization_id
       AND is_default = true
       AND is_active = true
  ),
  emp_sched AS (
    SELECT e.employee_id, ws.id AS schedule_id, ws.standard_hours_per_day
      FROM public.employments e
      LEFT JOIN public.work_schedules ws ON ws.id = e.work_schedule_id
     WHERE e.is_active = true
  ),
  leave_days AS (
    SELECT lr.employee_id,
           COALESCE(lt.is_paid, true) AS is_paid,
           gs::date AS leave_date
      FROM public.leave_requests lr
      LEFT JOIN public.leave_types lt ON lt.id = lr.leave_type_id
      CROSS JOIN LATERAL generate_series(
        GREATEST(lr.start_date, v_run.pay_period_start),
        LEAST(lr.end_date, v_run.pay_period_end),
        interval '1 day'
      ) AS gs
     WHERE lr.organization_id = v_run.organization_id
       AND (v_run.business_id IS NULL OR lr.business_id = v_run.business_id)
       AND lr.status = 'approved'
       AND lr.start_date <= v_run.pay_period_end
       AND lr.end_date   >= v_run.pay_period_start
  ),
  scheduled AS (
    SELECT ld.employee_id, ld.is_paid, ld.leave_date,
           COALESCE(
             (SELECT wsd.hours FROM public.work_schedule_days wsd
               WHERE wsd.work_schedule_id = es.schedule_id
                 AND wsd.day_of_week = EXTRACT(DOW FROM ld.leave_date)::int
               LIMIT 1),
             es.standard_hours_per_day,
             (SELECT h FROM org_default),
             0
           )::numeric AS hours
      FROM leave_days ld
      LEFT JOIN emp_sched es ON es.employee_id = ld.employee_id
  )
  INSERT INTO public.payroll_work_entries (
    organization_id, business_id, payroll_run_id, employee_id,
    work_date_start, work_date_end, hours, overtime_hours, source,
    attendance_count, work_entry_type_id
  )
  SELECT v_run.organization_id, v_run.business_id, _run_id, s.employee_id,
         v_run.pay_period_start, v_run.pay_period_end,
         COALESCE(SUM(s.hours), 0), 0, 'leave', COUNT(*),
         CASE WHEN s.is_paid THEN v_id_lp ELSE v_id_lu END
    FROM scheduled s
   GROUP BY s.employee_id, s.is_paid
  HAVING COALESCE(SUM(s.hours),0) > 0;

  IF EXISTS (SELECT 1 FROM public.payroll_work_entries WHERE payroll_run_id = _run_id AND source='leave') THEN
    v_sources := v_sources || 'leave';
  END IF;

  -- 3d) Public holidays — schedule-aware per employee (no flat 8h).
  WITH org_default AS (
    SELECT COALESCE(MAX(standard_hours_per_day), 0)::numeric AS h
      FROM public.work_schedules
     WHERE organization_id = v_run.organization_id
       AND is_default = true
       AND is_active = true
  ),
  emp_sched AS (
    SELECT e.employee_id, ws.id AS schedule_id, ws.standard_hours_per_day
      FROM public.employments e
      LEFT JOIN public.work_schedules ws ON ws.id = e.work_schedule_id
     WHERE e.is_active = true
  ),
  hol AS (
    SELECT ph.holiday_date
      FROM public.public_holidays ph
     WHERE ph.organization_id = v_run.organization_id
       AND ph.holiday_date BETWEEN v_run.pay_period_start AND v_run.pay_period_end
  ),
  emp AS (
    SELECT DISTINCT employee_id FROM public.payroll_work_entries WHERE payroll_run_id = _run_id
  ),
  emp_hol AS (
    SELECT e.employee_id, h.holiday_date,
           COALESCE(
             (SELECT wsd.hours FROM public.work_schedule_days wsd
               WHERE wsd.work_schedule_id = es.schedule_id
                 AND wsd.day_of_week = EXTRACT(DOW FROM h.holiday_date)::int
               LIMIT 1),
             es.standard_hours_per_day,
             (SELECT h FROM org_default),
             0
           )::numeric AS hours
      FROM emp e
      CROSS JOIN hol h
      LEFT JOIN emp_sched es ON es.employee_id = e.employee_id
  )
  INSERT INTO public.payroll_work_entries (
    organization_id, business_id, payroll_run_id, employee_id,
    work_date_start, work_date_end, hours, overtime_hours, source,
    attendance_count, work_entry_type_id
  )
  SELECT v_run.organization_id, v_run.business_id, _run_id, eh.employee_id,
         v_run.pay_period_start, v_run.pay_period_end,
         COALESCE(SUM(eh.hours), 0), 0, 'holiday', COUNT(*), v_id_h
    FROM emp_hol eh
   GROUP BY eh.employee_id
  HAVING COALESCE(SUM(eh.hours), 0) > 0;

  IF EXISTS (SELECT 1 FROM public.payroll_work_entries WHERE payroll_run_id = _run_id AND source='holiday') THEN
    v_sources := v_sources || 'holiday';
  END IF;

  -- 3e) Back-fill attendance.work_entry_id
  UPDATE public.attendance a
     SET work_entry_id = pwe.id
    FROM public.payroll_work_entries pwe
   WHERE pwe.payroll_run_id = _run_id
     AND pwe.source = 'attendance'
     AND pwe.work_entry_type_id = v_id_work
     AND a.employee_id = pwe.employee_id
     AND a.organization_id = v_run.organization_id
     AND a.attendance_date BETWEEN v_run.pay_period_start AND v_run.pay_period_end
     AND a.clock_out IS NOT NULL
     AND COALESCE(a.correction_status,'none') <> 'pending'
     AND a.status NOT IN ('on_leave','holiday','absent');

  SELECT jsonb_object_agg(t.code, sub.totals)
    INTO v_types
    FROM (
      SELECT work_entry_type_id,
             jsonb_build_object(
               'hours', ROUND(SUM(hours)::numeric, 2),
               'overtime_hours', ROUND(SUM(overtime_hours)::numeric, 2),
               'rows', COUNT(*)
             ) AS totals
        FROM public.payroll_work_entries
       WHERE payroll_run_id = _run_id
         AND work_entry_type_id IS NOT NULL
       GROUP BY work_entry_type_id
    ) sub
    JOIN public.payroll_work_entry_types t ON t.id = sub.work_entry_type_id;

  SELECT COUNT(DISTINCT employee_id) INTO v_employees
    FROM public.payroll_work_entries WHERE payroll_run_id = _run_id;

  RETURN jsonb_build_object(
    'employees', v_employees,
    'by_type', COALESCE(v_types, '{}'::jsonb),
    'sources_used', to_jsonb(v_sources),
    'locked_attendance_rows', v_locked,
    'preapproval_gate', v_require_preapproval
  );
END
$function$;
