
-- =====================================================================
-- Attendance Overhaul — Phase 1: Data Model Fixes
-- =====================================================================

-- 1. Drop the one-per-day unique constraint (allows multiple sessions/day)
ALTER TABLE public.attendance
  DROP CONSTRAINT IF EXISTS attendance_organization_id_employee_id_attendance_date_key;

-- 2. Remove the duplicate calculate_worked_hours trigger (keep calculate_attendance_hours)
DROP TRIGGER IF EXISTS trg_calculate_worked_hours ON public.attendance;
DROP FUNCTION IF EXISTS public.calculate_worked_hours();

-- 3. Add correction tracking columns
ALTER TABLE public.attendance
  ADD COLUMN IF NOT EXISTS correction_status text NOT NULL DEFAULT 'none'
    CHECK (correction_status IN ('none','pending','approved','rejected')),
  ADD COLUMN IF NOT EXISTS correction_reason text,
  ADD COLUMN IF NOT EXISTS corrected_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS corrected_at timestamptz,
  ADD COLUMN IF NOT EXISTS original_clock_in timestamptz,
  ADD COLUMN IF NOT EXISTS original_clock_out timestamptz;

-- 4. Add payroll lock columns
ALTER TABLE public.attendance
  ADD COLUMN IF NOT EXISTS is_locked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS locked_by_payroll_run_id uuid REFERENCES payroll_runs(id) ON DELETE SET NULL;

-- 5. Index for finding open sessions quickly
CREATE INDEX IF NOT EXISTS idx_attendance_open_sessions
  ON public.attendance (organization_id, employee_id)
  WHERE clock_out IS NULL;

-- 6. Prevent duplicate open sessions trigger
CREATE OR REPLACE FUNCTION public.prevent_duplicate_open_session()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.clock_out IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM attendance
      WHERE organization_id = NEW.organization_id
        AND employee_id = NEW.employee_id
        AND clock_out IS NULL
        AND id IS DISTINCT FROM NEW.id
    ) THEN
      RAISE EXCEPTION 'Employee already has an open attendance session. Clock out first.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_prevent_duplicate_open_session
  BEFORE INSERT ON public.attendance
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_duplicate_open_session();

-- 7. Prevent edits to locked attendance records
CREATE OR REPLACE FUNCTION public.prevent_locked_attendance_edit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Allow service_role to bypass (for payroll locking itself)
  IF current_setting('role', true) = 'service_role' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.is_locked THEN
      RAISE EXCEPTION 'Cannot delete attendance record locked by payroll run.';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE
  IF OLD.is_locked AND NOT (
    -- Only allow unlocking by service_role (handled above)
    NEW.is_locked = OLD.is_locked
  ) THEN
    RAISE EXCEPTION 'Cannot modify attendance record locked by payroll run.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_prevent_locked_attendance_edit
  BEFORE UPDATE OR DELETE ON public.attendance
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_locked_attendance_edit();

-- 8. Fix calculate_attendance_hours to read from work_schedule instead of hardcoded 8h
CREATE OR REPLACE FUNCTION public.calculate_attendance_hours()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_standard_hours NUMERIC := 8.0;
  v_total_minutes NUMERIC;
  v_worked_hours NUMERIC;
  v_overtime NUMERIC;
  v_schedule_id uuid;
BEGIN
  -- Only compute when both clock_in and clock_out are present
  IF NEW.clock_in IS NOT NULL AND NEW.clock_out IS NOT NULL THEN
    -- Try to read standard hours from employee's assigned work schedule
    SELECT e.work_schedule_id INTO v_schedule_id
    FROM employees e WHERE e.id = NEW.employee_id;

    IF v_schedule_id IS NOT NULL THEN
      SELECT COALESCE(ws.standard_hours_per_day, 8.0) INTO v_standard_hours
      FROM work_schedules ws WHERE ws.id = v_schedule_id AND ws.is_active = true;
    END IF;

    -- Calculate total minutes between clock_in and clock_out
    v_total_minutes := EXTRACT(EPOCH FROM (NEW.clock_out::timestamptz - NEW.clock_in::timestamptz)) / 60.0;

    -- Subtract break duration
    v_total_minutes := v_total_minutes - COALESCE(NEW.break_duration_minutes, 0);

    -- Ensure non-negative
    v_total_minutes := GREATEST(v_total_minutes, 0);

    -- Convert to hours (2 decimal places)
    v_worked_hours := ROUND(v_total_minutes / 60.0, 2);

    -- Calculate overtime (anything beyond standard hours)
    v_overtime := GREATEST(v_worked_hours - v_standard_hours, 0);

    NEW.worked_hours := v_worked_hours;
    NEW.overtime_hours := v_overtime;
  END IF;

  RETURN NEW;
END;
$$;

-- 9. Auto-detect late status on clock-in based on work schedule
CREATE OR REPLACE FUNCTION public.auto_detect_late_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_schedule_id uuid;
  v_day_name text;
  v_start_time time;
  v_tolerance_minutes int := 15;
  v_clock_in_time time;
BEGIN
  -- Only run on INSERT or when clock_in changes
  IF NEW.clock_in IS NULL THEN
    RETURN NEW;
  END IF;

  -- Only auto-set if status is still 'present' (don't override manual statuses)
  IF NEW.status != 'present' THEN
    RETURN NEW;
  END IF;

  -- Get employee's work schedule
  SELECT e.work_schedule_id INTO v_schedule_id
  FROM employees e WHERE e.id = NEW.employee_id;

  IF v_schedule_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Get the day of week name from clock_in
  v_day_name := initcap(trim(to_char(NEW.clock_in, 'Day')));
  v_clock_in_time := (NEW.clock_in AT TIME ZONE 'UTC')::time;

  -- Look up scheduled start time for this day
  SELECT wsd.start_time INTO v_start_time
  FROM work_schedule_days wsd
  WHERE wsd.schedule_id = v_schedule_id
    AND wsd.day_of_week = v_day_name
    AND wsd.is_work_day = true;

  IF v_start_time IS NOT NULL THEN
    -- If clock_in is more than tolerance minutes after schedule start, mark late
    IF v_clock_in_time > (v_start_time + (v_tolerance_minutes || ' minutes')::interval) THEN
      NEW.status := 'late';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_auto_detect_late_status
  BEFORE INSERT ON public.attendance
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_detect_late_status();
