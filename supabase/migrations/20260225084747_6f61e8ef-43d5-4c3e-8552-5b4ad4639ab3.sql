
-- ═══════════════════════════════════════════════════════════════════════
-- 1. Attendance: Auto-calculate worked_hours and overtime_hours from
--    clock_in/clock_out timestamps against an 8-hour standard workday.
-- ═══════════════════════════════════════════════════════════════════════

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
BEGIN
  -- Only compute when both clock_in and clock_out are present
  IF NEW.clock_in IS NOT NULL AND NEW.clock_out IS NOT NULL THEN
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

-- Drop existing trigger if present, then create
DROP TRIGGER IF EXISTS trg_calculate_attendance_hours ON public.attendance;
CREATE TRIGGER trg_calculate_attendance_hours
  BEFORE INSERT OR UPDATE OF clock_in, clock_out, break_duration_minutes
  ON public.attendance
  FOR EACH ROW
  EXECUTE FUNCTION public.calculate_attendance_hours();


-- ═══════════════════════════════════════════════════════════════════════
-- 2. Leave: Sync days_used on leave_allocations when leave_requests 
--    status changes to/from 'approved'.
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.sync_leave_allocation_days_used()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_allocation_id UUID;
  v_total_used NUMERIC;
BEGIN
  -- Only react when status changes involving 'approved'
  IF TG_OP = 'UPDATE' AND OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  -- Find the matching allocation for this employee + leave type + period
  SELECT id INTO v_allocation_id
  FROM leave_allocations
  WHERE employee_id = NEW.employee_id
    AND leave_type_id = NEW.leave_type_id
    AND organization_id = NEW.organization_id
    -- The leave request should fall within the allocation period
    AND allocation_date <= NEW.start_date
    AND (expiry_date IS NULL OR expiry_date >= NEW.start_date)
  ORDER BY allocation_date DESC
  LIMIT 1;

  IF v_allocation_id IS NOT NULL THEN
    -- Recalculate total days used from all approved requests for this allocation
    SELECT COALESCE(SUM(
      CASE 
        WHEN lr.half_day = true THEN 0.5
        ELSE (lr.end_date::date - lr.start_date::date + 1)
      END
    ), 0)
    INTO v_total_used
    FROM leave_requests lr
    WHERE lr.employee_id = NEW.employee_id
      AND lr.leave_type_id = NEW.leave_type_id
      AND lr.organization_id = NEW.organization_id
      AND lr.status = 'approved'
      AND lr.start_date >= (SELECT allocation_date FROM leave_allocations WHERE id = v_allocation_id)
      AND (
        (SELECT expiry_date FROM leave_allocations WHERE id = v_allocation_id) IS NULL
        OR lr.start_date <= (SELECT expiry_date FROM leave_allocations WHERE id = v_allocation_id)
      );

    -- Update the allocation's days_used
    UPDATE leave_allocations
    SET days_used = v_total_used,
        updated_at = NOW()
    WHERE id = v_allocation_id;
  END IF;

  RETURN NEW;
END;
$$;

-- Drop existing trigger if present, then create
DROP TRIGGER IF EXISTS trg_sync_leave_days_used ON public.leave_requests;
CREATE TRIGGER trg_sync_leave_days_used
  AFTER INSERT OR UPDATE OF status
  ON public.leave_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_leave_allocation_days_used();
