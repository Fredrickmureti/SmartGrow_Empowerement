
-- =====================================================================
-- Enterprise attendance recompute + derived overtime + per-day payroll
-- entries. Replaces the naive 8h-threshold trigger and the manual-OT-only
-- payroll generator so attendance.overtime_hours is the source of truth.
-- =====================================================================

-- 1) Schedule-aware hours/overtime/late/early/status recompute --------
CREATE OR REPLACE FUNCTION public.calculate_attendance_hours()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_settings record;
  v_schedule_id uuid;
  v_day_name text;
  v_day record;
  v_tz text := 'UTC';
  v_local_in timestamp;
  v_local_out timestamp;
  v_expected numeric := 8.0;
  v_threshold numeric;
  v_total_minutes numeric;
  v_worked numeric;
  v_overtime numeric;
  v_is_rest boolean := false;
  v_is_holiday boolean := false;
  v_late_min integer := 0;
  v_early_min integer := 0;
  v_grace integer := 0;
BEGIN
  -- Only meaningful when at least clock_in is present.
  IF NEW.clock_in IS NULL THEN RETURN NEW; END IF;

  -- Settings for the business (grace, threshold, etc.)
  SELECT * INTO v_settings FROM public.attendance_settings
   WHERE business_id = NEW.business_id LIMIT 1;
  v_grace := COALESCE(v_settings.late_grace_minutes, 0);
  v_threshold := v_settings.overtime_threshold_hours;

  -- Resolve business timezone for local time math.
  SELECT COALESCE(NULLIF(b.timezone, ''), 'UTC') INTO v_tz
    FROM public.businesses b WHERE b.id = NEW.business_id;

  BEGIN
    v_local_in := (NEW.clock_in AT TIME ZONE v_tz);
    v_local_out := CASE WHEN NEW.clock_out IS NOT NULL
                        THEN (NEW.clock_out AT TIME ZONE v_tz) END;
  EXCEPTION WHEN OTHERS THEN
    v_local_in := (NEW.clock_in AT TIME ZONE 'UTC');
    v_local_out := CASE WHEN NEW.clock_out IS NOT NULL
                        THEN (NEW.clock_out AT TIME ZONE 'UTC') END;
  END;

  -- Public holiday detection (org-scoped).
  SELECT EXISTS (
    SELECT 1 FROM public.public_holidays h
     WHERE h.organization_id = NEW.organization_id
       AND h.holiday_date = NEW.attendance_date
  ) INTO v_is_holiday;

  -- Employee schedule for the day.
  SELECT e.work_schedule_id INTO v_schedule_id
    FROM public.employees e WHERE e.id = NEW.employee_id;

  v_day_name := initcap(trim(to_char(v_local_in, 'Day')));

  IF v_schedule_id IS NOT NULL THEN
    SELECT wsd.* INTO v_day
      FROM public.work_schedule_days wsd
     WHERE wsd.schedule_id = v_schedule_id
       AND wsd.day_of_week = v_day_name;

    IF v_day.id IS NOT NULL THEN
      v_is_rest := NOT COALESCE(v_day.is_work_day, true);
      IF v_day.is_work_day AND v_day.start_time IS NOT NULL AND v_day.end_time IS NOT NULL THEN
        v_expected := GREATEST(
          EXTRACT(EPOCH FROM (v_day.end_time - v_day.start_time))/3600.0
            - COALESCE(v_day.break_minutes, 0)/60.0,
          0
        );
      END IF;
    ELSE
      -- Fallback to schedule-level standard hours.
      SELECT COALESCE(ws.standard_hours_per_day, 8.0) INTO v_expected
        FROM public.work_schedules ws WHERE ws.id = v_schedule_id;
    END IF;
  END IF;

  -- Late minutes (only when we know the scheduled start).
  IF NOT v_is_rest AND NOT v_is_holiday AND v_day.start_time IS NOT NULL THEN
    v_late_min := GREATEST(
      0,
      EXTRACT(EPOCH FROM (v_local_in::time - v_day.start_time))/60.0 - v_grace
    )::integer;
  END IF;

  -- Derive worked + overtime when the session is closed.
  IF NEW.clock_out IS NOT NULL THEN
    -- Recompute aggregated break minutes from the breaks ledger if any rows
    -- exist (otherwise keep the denormalised value the row already carries).
    SELECT COALESCE(SUM(
      CASE
        WHEN b.ended_at IS NOT NULL
          THEN EXTRACT(EPOCH FROM (b.ended_at - b.started_at))/60.0
        ELSE COALESCE(b.duration_minutes, 0)
      END
    ), NEW.break_duration_minutes, 0)
      INTO NEW.break_duration_minutes
      FROM public.attendance_breaks b
     WHERE b.attendance_id = NEW.id;

    v_total_minutes := GREATEST(
      EXTRACT(EPOCH FROM (NEW.clock_out - NEW.clock_in))/60.0
        - COALESCE(NEW.break_duration_minutes, 0),
      0
    );
    v_worked := ROUND(v_total_minutes / 60.0, 2);

    IF v_is_rest OR v_is_holiday THEN
      -- All hours on rest days / public holidays are overtime.
      v_overtime := v_worked;
    ELSE
      -- Prefer settings threshold; fall back to schedule expected.
      v_overtime := GREATEST(
        v_worked - COALESCE(v_threshold, v_expected),
        0
      );
    END IF;

    -- Early leave (only on scheduled work days with a known end time).
    IF NOT v_is_rest AND NOT v_is_holiday AND v_day.end_time IS NOT NULL THEN
      v_early_min := GREATEST(
        0,
        EXTRACT(EPOCH FROM (v_day.end_time - v_local_out::time))/60.0
      )::integer;
    END IF;

    NEW.worked_hours        := v_worked;
    NEW.overtime_hours      := ROUND(v_overtime, 2);
    NEW.early_leave_minutes := v_early_min;

    -- Status state machine. Never override admin-set absent / on_leave / holiday.
    IF NEW.status NOT IN ('absent','on_leave','holiday') THEN
      IF v_is_holiday THEN
        NEW.status := 'holiday';
      ELSIF v_expected > 0 AND v_worked < (v_expected / 2.0) THEN
        NEW.status := 'half_day';
      ELSIF v_late_min > 0 THEN
        NEW.status := 'late';
      ELSE
        NEW.status := 'present';
      END IF;
    END IF;
  ELSE
    -- Open session: just stamp expected + late so dashboards are accurate.
    NEW.worked_hours   := COALESCE(NEW.worked_hours, 0);
    NEW.overtime_hours := COALESCE(NEW.overtime_hours, 0);
  END IF;

  NEW.expected_hours := ROUND(v_expected, 2);
  NEW.late_minutes   := v_late_min;

  RETURN NEW;
END;
$function$;

-- Re-attach trigger so it fires on clock_in/out/break/status changes.
DROP TRIGGER IF EXISTS trg_calculate_attendance_hours ON public.attendance;
CREATE TRIGGER trg_calculate_attendance_hours
  BEFORE INSERT OR UPDATE OF clock_in, clock_out, break_duration_minutes, status
  ON public.attendance
  FOR EACH ROW
  EXECUTE FUNCTION public.calculate_attendance_hours();

-- 2) Payroll work-entries generator — derive OT from attendance --------
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
  v_require_preapproval boolean := false;
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

  SELECT COALESCE(BOOL_OR(require_ot_preapproval), false)
    INTO v_require_preapproval
    FROM public.attendance_settings
   WHERE organization_id = v_run.organization_id
     AND (v_run.business_id IS NULL OR business_id = v_run.business_id);

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
           COALESCE(SUM(a.overtime_hours), 0) AS derived_ot,
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
    -- Derived OT is the floor; if pre-approval is required, cap by approved.
    CASE
      WHEN v_require_preapproval
        THEN LEAST(att.derived_ot, COALESCE(ao.approved_hours, 0))
      ELSE att.derived_ot
    END,
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

  -- Leave aggregation (unchanged).
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
    'locked_attendance_rows', v_locked,
    'preapproval_gate', v_require_preapproval
  );
END
$function$;

-- 3) Backfill: refire recompute on all closed rows so historical
--    overtime_hours / late_minutes / early_leave_minutes / expected_hours
--    reflect the new logic. Skips locked rows.
DO $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN
    SELECT id FROM public.attendance
     WHERE clock_in IS NOT NULL AND COALESCE(is_locked, false) = false
  LOOP
    BEGIN
      UPDATE public.attendance SET updated_at = now() WHERE id = r.id;
      n := n + 1;
    EXCEPTION WHEN OTHERS THEN
      -- swallow per-row failures so backfill never blocks the migration
      NULL;
    END;
  END LOOP;
  RAISE NOTICE 'attendance recompute backfill touched % rows', n;
END $$;
