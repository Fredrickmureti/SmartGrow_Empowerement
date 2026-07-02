
-- Guard v_day field access with an explicit flag (plpgsql can't introspect
-- an unassigned record).
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
  v_day_id uuid;
  v_day_is_work boolean;
  v_day_start time;
  v_day_end time;
  v_day_break_min integer;
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
  IF NEW.clock_in IS NULL THEN RETURN NEW; END IF;

  SELECT * INTO v_settings FROM public.attendance_settings
   WHERE business_id = NEW.business_id LIMIT 1;
  v_grace := COALESCE(v_settings.late_grace_minutes, 0);
  v_threshold := v_settings.overtime_threshold_hours;

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

  SELECT EXISTS (
    SELECT 1 FROM public.public_holidays h
     WHERE h.organization_id = NEW.organization_id
       AND h.date = NEW.attendance_date
       AND COALESCE(h.is_active, true)
  ) INTO v_is_holiday;

  SELECT e.work_schedule_id INTO v_schedule_id
    FROM public.employees e WHERE e.id = NEW.employee_id;

  v_day_name := initcap(trim(to_char(v_local_in, 'Day')));

  IF v_schedule_id IS NOT NULL THEN
    SELECT wsd.id, wsd.is_work_day, wsd.start_time, wsd.end_time, wsd.break_minutes
      INTO v_day_id, v_day_is_work, v_day_start, v_day_end, v_day_break_min
      FROM public.work_schedule_days wsd
     WHERE wsd.schedule_id = v_schedule_id
       AND wsd.day_of_week = v_day_name
     LIMIT 1;

    IF v_day_id IS NOT NULL THEN
      v_is_rest := NOT COALESCE(v_day_is_work, true);
      IF v_day_is_work AND v_day_start IS NOT NULL AND v_day_end IS NOT NULL THEN
        v_expected := GREATEST(
          EXTRACT(EPOCH FROM (v_day_end - v_day_start))/3600.0
            - COALESCE(v_day_break_min, 0)/60.0,
          0
        );
      END IF;
    ELSE
      SELECT COALESCE(ws.standard_hours_per_day, 8.0) INTO v_expected
        FROM public.work_schedules ws WHERE ws.id = v_schedule_id;
    END IF;
  END IF;

  IF NOT v_is_rest AND NOT v_is_holiday AND v_day_start IS NOT NULL THEN
    v_late_min := GREATEST(
      0,
      EXTRACT(EPOCH FROM (v_local_in::time - v_day_start))/60.0 - v_grace
    )::integer;
  END IF;

  IF NEW.clock_out IS NOT NULL THEN
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
      v_overtime := v_worked;
    ELSE
      v_overtime := GREATEST(
        v_worked - COALESCE(v_threshold, v_expected),
        0
      );
    END IF;

    IF NOT v_is_rest AND NOT v_is_holiday AND v_day_end IS NOT NULL THEN
      v_early_min := GREATEST(
        0,
        EXTRACT(EPOCH FROM (v_day_end - v_local_out::time))/60.0
      )::integer;
    END IF;

    NEW.worked_hours        := v_worked;
    NEW.overtime_hours      := ROUND(v_overtime, 2);
    NEW.early_leave_minutes := v_early_min;

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
    NEW.worked_hours   := COALESCE(NEW.worked_hours, 0);
    NEW.overtime_hours := COALESCE(NEW.overtime_hours, 0);
  END IF;

  NEW.expected_hours := ROUND(v_expected, 2);
  NEW.late_minutes   := v_late_min;

  RETURN NEW;
END;
$function$;

UPDATE public.attendance
   SET status = status
 WHERE clock_in IS NOT NULL
   AND COALESCE(is_locked, false) = false;
