
CREATE OR REPLACE FUNCTION public.leave_to_attendance_stamp(_leave_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_lr record; v_emp record; v_day date; v_count int := 0;
BEGIN
  SELECT * INTO v_lr FROM public.leave_requests WHERE id = _leave_id;
  IF v_lr.id IS NULL OR v_lr.status <> 'approved' THEN RETURN 0; END IF;
  SELECT * INTO v_emp FROM public.employees WHERE id = v_lr.employee_id;
  IF v_emp.id IS NULL THEN RETURN 0; END IF;
  v_day := v_lr.start_date;
  WHILE v_day <= v_lr.end_date LOOP
    IF NOT EXISTS (SELECT 1 FROM public.attendance WHERE employee_id = v_lr.employee_id AND attendance_date = v_day) THEN
      INSERT INTO public.attendance(organization_id, business_id, branch_id, employee_id, attendance_date, status, notes, is_locked, created_by)
      VALUES (v_lr.organization_id, v_lr.business_id, COALESCE(v_lr.branch_id, v_emp.branch_id), v_lr.employee_id, v_day, 'on_leave',
              'Auto-stamped from leave request ' || COALESCE(v_lr.request_number,_leave_id::text), false,
              COALESCE(v_lr.first_approver_id, v_lr.second_approver_id, v_lr.created_by));
      v_count := v_count + 1;
    END IF;
    v_day := v_day + 1;
  END LOOP;
  RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION public.trg_leave_stamp_on_approval()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'approved' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'approved') THEN
    PERFORM public.leave_to_attendance_stamp(NEW.id);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS leave_stamp_attendance ON public.leave_requests;
CREATE TRIGGER leave_stamp_attendance
AFTER INSERT OR UPDATE OF status ON public.leave_requests
FOR EACH ROW EXECUTE FUNCTION public.trg_leave_stamp_on_approval();

CREATE TABLE IF NOT EXISTS public.payroll_work_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  payroll_run_id uuid NOT NULL REFERENCES public.payroll_runs(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
  work_date_start date NOT NULL,
  work_date_end date NOT NULL,
  hours numeric(10,2) NOT NULL DEFAULT 0,
  overtime_hours numeric(10,2) NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'attendance' CHECK (source IN ('attendance','manual','leave')),
  attendance_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pwe_run ON public.payroll_work_entries(payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_pwe_emp ON public.payroll_work_entries(employee_id, work_date_start);
CREATE INDEX IF NOT EXISTS idx_pwe_org ON public.payroll_work_entries(organization_id);

ALTER TABLE public.payroll_work_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Read payroll work entries in org" ON public.payroll_work_entries;
CREATE POLICY "Read payroll work entries in org" ON public.payroll_work_entries FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = auth.uid() AND ur.organization_id = payroll_work_entries.organization_id));

CREATE OR REPLACE FUNCTION public.attendance_lock_for_period(
  _organization_id uuid, _from date, _to date,
  _payroll_run_id uuid DEFAULT NULL, _employee_ids uuid[] DEFAULT NULL
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid := auth.uid(); v_count int;
BEGIN
  IF v_user IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = v_user AND organization_id = _organization_id
      AND role IN ('super_admin','owner','admin','accountant')
  ) THEN RAISE EXCEPTION 'PERMISSION_DENIED'; END IF;
  UPDATE public.attendance
    SET is_locked = true,
        locked_by_payroll_run_id = COALESCE(_payroll_run_id, locked_by_payroll_run_id),
        updated_at = now()
   WHERE organization_id = _organization_id
     AND attendance_date BETWEEN _from AND _to
     AND clock_out IS NOT NULL
     AND is_locked = false
     AND (_employee_ids IS NULL OR employee_id = ANY(_employee_ids));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION public.attendance_pending_corrections_count(
  _organization_id uuid, _from date, _to date, _employee_ids uuid[] DEFAULT NULL
) RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*)::int FROM public.attendance
   WHERE organization_id = _organization_id
     AND attendance_date BETWEEN _from AND _to
     AND correction_status = 'pending'
     AND (_employee_ids IS NULL OR employee_id = ANY(_employee_ids));
$$;

CREATE OR REPLACE FUNCTION public.attendance_notify_correction_event(_correction_id uuid, _event text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_c record; v_title text; v_msg text;
BEGIN
  SELECT ac.*, e.first_name, e.last_name, e.user_id AS employee_user_id
    INTO v_c FROM public.attendance_corrections ac
    JOIN public.employees e ON e.id = ac.employee_id
   WHERE ac.id = _correction_id;
  IF v_c.id IS NULL THEN RETURN; END IF;

  IF _event = 'submitted' THEN
    v_title := 'Attendance correction submitted';
    v_msg := COALESCE(v_c.first_name,'') || ' ' || COALESCE(v_c.last_name,'') || ' requested a correction for ' || to_char(v_c.attendance_date,'Mon DD, YYYY');
    INSERT INTO public.notifications (organization_id, business_id, user_id, type, category, title, message, link, entity_type, entity_id, priority)
    SELECT v_c.organization_id, v_c.business_id, ur.user_id, 'in_app', 'attendance', v_title, v_msg, '/hr/attendance/corrections', 'attendance_correction', v_c.id, 'normal'
      FROM public.user_roles ur
     WHERE ur.organization_id = v_c.organization_id
       AND ur.role IN ('super_admin','owner','admin','hr_officer','manager');
  ELSIF _event IN ('approved','rejected') THEN
    v_title := 'Attendance correction ' || _event;
    v_msg := 'Your correction for ' || to_char(v_c.attendance_date,'Mon DD, YYYY') || ' was ' || _event ||
             COALESCE(' — ' || v_c.review_note, '');
    IF v_c.employee_user_id IS NOT NULL THEN
      INSERT INTO public.notifications (organization_id, business_id, user_id, type, category, title, message, link, entity_type, entity_id, priority)
      VALUES (v_c.organization_id, v_c.business_id, v_c.employee_user_id, 'in_app', 'attendance', v_title, v_msg, '/me/attendance', 'attendance_correction', v_c.id, 'normal');
    END IF;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.attendance_request_correction(
  _attendance_id uuid, _employee_id uuid, _date date,
  _proposed_clock_in timestamptz, _proposed_clock_out timestamptz,
  _proposed_status text, _reason text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid := auth.uid(); v_emp record; v_id uuid;
BEGIN
  SELECT * INTO v_emp FROM public.employees WHERE id = _employee_id;
  IF v_emp.id IS NULL THEN RAISE EXCEPTION 'EMPLOYEE_NOT_FOUND'; END IF;
  IF v_emp.user_id IS DISTINCT FROM v_user
     AND NOT public.user_has_module_permission(v_user, v_emp.organization_id, 'attendance', 'write') THEN
    RAISE EXCEPTION 'PERMISSION_DENIED';
  END IF;
  INSERT INTO public.attendance_corrections (
    organization_id, business_id, branch_id, attendance_id, employee_id,
    attendance_date, proposed_clock_in, proposed_clock_out, proposed_status,
    reason, status, requested_by, requested_at
  ) VALUES (
    v_emp.organization_id, v_emp.business_id, v_emp.branch_id, _attendance_id, _employee_id,
    _date, _proposed_clock_in, _proposed_clock_out, _proposed_status,
    _reason, 'pending', v_user, now()
  ) RETURNING id INTO v_id;
  IF _attendance_id IS NOT NULL THEN
    UPDATE public.attendance SET correction_status='pending', updated_at=now() WHERE id = _attendance_id;
  END IF;
  PERFORM public.attendance_notify_correction_event(v_id, 'submitted');
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.attendance_approve_correction(_correction_id uuid, _review_note text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid := auth.uid(); v_c record; v_att_id uuid;
BEGIN
  SELECT * INTO v_c FROM public.attendance_corrections WHERE id = _correction_id;
  IF v_c.id IS NULL THEN RAISE EXCEPTION 'CORRECTION_NOT_FOUND'; END IF;
  IF v_c.status <> 'pending' THEN RAISE EXCEPTION 'ALREADY_REVIEWED'; END IF;
  IF NOT public.user_has_module_permission(v_user, v_c.organization_id, 'attendance', 'manage') THEN
    RAISE EXCEPTION 'PERMISSION_DENIED';
  END IF;
  IF v_c.attendance_id IS NOT NULL THEN
    UPDATE public.attendance SET
      original_clock_in = COALESCE(original_clock_in, clock_in),
      original_clock_out = COALESCE(original_clock_out, clock_out),
      clock_in = COALESCE(v_c.proposed_clock_in, clock_in),
      clock_out = COALESCE(v_c.proposed_clock_out, clock_out),
      status = COALESCE(v_c.proposed_status, status),
      correction_status = 'approved', corrected_by = v_user, corrected_at = now(), updated_at = now()
    WHERE id = v_c.attendance_id;
    v_att_id := v_c.attendance_id;
  ELSE
    INSERT INTO public.attendance (
      organization_id, business_id, branch_id, employee_id, attendance_date,
      clock_in, clock_out, status, correction_status, corrected_by, corrected_at, created_by
    ) VALUES (
      v_c.organization_id, v_c.business_id, v_c.branch_id, v_c.employee_id, v_c.attendance_date,
      v_c.proposed_clock_in, v_c.proposed_clock_out, COALESCE(v_c.proposed_status,'present'),
      'approved', v_user, now(), v_user
    ) RETURNING id INTO v_att_id;
  END IF;
  UPDATE public.attendance_corrections
     SET status='approved', reviewed_by=v_user, reviewed_at=now(), review_note=_review_note
   WHERE id = _correction_id;
  PERFORM public.attendance_notify_correction_event(_correction_id, 'approved');
  RETURN v_att_id;
END $$;

CREATE OR REPLACE FUNCTION public.attendance_reject_correction(_correction_id uuid, _review_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid := auth.uid(); v_c record;
BEGIN
  SELECT * INTO v_c FROM public.attendance_corrections WHERE id = _correction_id;
  IF v_c.id IS NULL THEN RAISE EXCEPTION 'CORRECTION_NOT_FOUND'; END IF;
  IF v_c.status <> 'pending' THEN RAISE EXCEPTION 'ALREADY_REVIEWED'; END IF;
  IF NOT public.user_has_module_permission(v_user, v_c.organization_id, 'attendance', 'manage') THEN
    RAISE EXCEPTION 'PERMISSION_DENIED';
  END IF;
  UPDATE public.attendance_corrections
     SET status='rejected', reviewed_by=v_user, reviewed_at=now(), review_note=_review_note
   WHERE id = _correction_id;
  IF v_c.attendance_id IS NOT NULL THEN
    UPDATE public.attendance SET correction_status='rejected', updated_at=now() WHERE id = v_c.attendance_id;
  END IF;
  PERFORM public.attendance_notify_correction_event(_correction_id, 'rejected');
END $$;
