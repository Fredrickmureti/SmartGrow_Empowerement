-- Attendance: payroll work-entry generation + late-arrival notifications

-- 1. Add late_notified_at to attendance to make notifications idempotent
ALTER TABLE public.attendance
  ADD COLUMN IF NOT EXISTS late_notified_at timestamptz;

-- 2. Late-arrival notification function
CREATE OR REPLACE FUNCTION public.attendance_notify_late_arrival(_attendance_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_a record;
  v_emp record;
  v_settings record;
  v_threshold int;
BEGIN
  SELECT * INTO v_a FROM public.attendance WHERE id = _attendance_id;
  IF v_a.id IS NULL OR v_a.late_notified_at IS NOT NULL THEN RETURN; END IF;
  IF v_a.status <> 'late' AND COALESCE(v_a.late_minutes, 0) <= 0 THEN RETURN; END IF;

  SELECT * INTO v_emp FROM public.employees WHERE id = v_a.employee_id;
  IF v_emp.id IS NULL THEN RETURN; END IF;

  SELECT * INTO v_settings
    FROM public.attendance_settings
   WHERE organization_id = v_a.organization_id
     AND (business_id = v_a.business_id OR business_id IS NULL)
   ORDER BY business_id NULLS LAST
   LIMIT 1;
  v_threshold := COALESCE(v_settings.late_grace_minutes, 0);
  IF COALESCE(v_a.late_minutes, 0) <= v_threshold THEN
    -- Within grace; mark notified to skip future evaluations.
    UPDATE public.attendance SET late_notified_at = now() WHERE id = _attendance_id;
    RETURN;
  END IF;

  -- Notify the employee's manager (if any) plus org HR/admins.
  INSERT INTO public.notifications (
    organization_id, business_id, user_id, type, category, title, message, link,
    entity_type, entity_id, priority
  )
  SELECT
    v_a.organization_id,
    v_a.business_id,
    target.user_id,
    'in_app',
    'attendance',
    'Late arrival',
    COALESCE(v_emp.first_name,'') || ' ' || COALESCE(v_emp.last_name,'')
      || ' clocked in ' || COALESCE(v_a.late_minutes,0)::text || ' min late on '
      || to_char(v_a.attendance_date,'Mon DD, YYYY'),
    '/hr/attendance?employeeId=' || v_a.employee_id::text || '&date=' || v_a.attendance_date::text,
    'attendance',
    v_a.id,
    'normal'
  FROM (
    SELECT DISTINCT user_id FROM (
      SELECT mgr.user_id
        FROM public.employees mgr
       WHERE mgr.id = v_emp.manager_id AND mgr.user_id IS NOT NULL
      UNION
      SELECT ur.user_id
        FROM public.user_roles ur
       WHERE ur.organization_id = v_a.organization_id
         AND ur.role IN ('super_admin','owner','admin','hr_officer')
    ) u
    WHERE u.user_id IS NOT NULL
  ) target;

  UPDATE public.attendance SET late_notified_at = now() WHERE id = _attendance_id;
END
$$;

-- 3. Trigger
CREATE OR REPLACE FUNCTION public.trg_attendance_late_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'late' AND COALESCE(NEW.late_minutes,0) > 0
     AND NEW.late_notified_at IS NULL THEN
    PERFORM public.attendance_notify_late_arrival(NEW.id);
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS attendance_late_notify ON public.attendance;
CREATE TRIGGER attendance_late_notify
AFTER INSERT OR UPDATE OF status, clock_in, late_minutes ON public.attendance
FOR EACH ROW EXECUTE FUNCTION public.trg_attendance_late_notify();

-- 4. Generate payroll work entries from approved attendance + leave
CREATE OR REPLACE FUNCTION public.attendance_generate_work_entries(_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  -- Lock attendance for the period (no-op if already locked)
  v_locked := public.attendance_lock_for_period(
    v_run.organization_id, v_run.pay_period_start, v_run.pay_period_end, _run_id, NULL
  );

  -- Refresh: clear previous entries for this run before regenerating
  DELETE FROM public.payroll_work_entries WHERE payroll_run_id = _run_id;

  -- Aggregate approved attendance into per-employee work entries
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
  GROUP BY a.employee_id;

  -- Aggregate approved leave days for the period
  INSERT INTO public.payroll_work_entries (
    organization_id, business_id, payroll_run_id, employee_id,
    work_date_start, work_date_end, hours, overtime_hours, source, attendance_count
  )
  SELECT
    v_run.organization_id, v_run.business_id, _run_id, a.employee_id,
    v_run.pay_period_start, v_run.pay_period_end,
    COUNT(*) * 8,           -- 8h/day default; payroll can refine via schedule
    0, 'leave', COUNT(*)
  FROM public.attendance a
  WHERE a.organization_id = v_run.organization_id
    AND (v_run.business_id IS NULL OR a.business_id = v_run.business_id)
    AND a.attendance_date BETWEEN v_run.pay_period_start AND v_run.pay_period_end
    AND a.status = 'on_leave'
  GROUP BY a.employee_id;

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
$$;

-- 5. Manage RLS for payroll_work_entries (read policy already exists)
DROP POLICY IF EXISTS "Manage payroll work entries" ON public.payroll_work_entries;
CREATE POLICY "Manage payroll work entries" ON public.payroll_work_entries
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = auth.uid()
       AND ur.organization_id = payroll_work_entries.organization_id
       AND ur.role IN ('super_admin','owner','admin','accountant')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = auth.uid()
       AND ur.organization_id = payroll_work_entries.organization_id
       AND ur.role IN ('super_admin','owner','admin','accountant')
  ));