
-- Fix: replace non-existent app_role literals ('hr_officer','manager') in
-- three SECURITY DEFINER notification helpers with the canonical
-- user_has_module_permission(...) check so the RPCs stop crashing with
-- "invalid input value for enum app_role".

CREATE OR REPLACE FUNCTION public.overtime_request_submit(_employee_id uuid, _ot_date date, _hours numeric, _reason text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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
  v_msg := format(
    '%s requested %sh OT on %s',
    v_full_name,
    to_char(_hours, 'FM999990.00'),
    to_char(_ot_date, 'Mon DD, YYYY')
  );

  INSERT INTO public.notifications (
    organization_id, business_id, user_id,
    type, category, title, message, link,
    entity_type, entity_id, priority
  )
  SELECT
    v_emp.organization_id, v_emp.business_id, t.user_id,
    'in_app', 'attendance',
    'Overtime request submitted',
    v_msg,
    '/hr/attendance/approvals?tab=overtime',
    'overtime_request', v_id, 2
  FROM (
    SELECT DISTINCT ur.user_id
      FROM public.user_roles ur
     WHERE ur.organization_id = v_emp.organization_id
       AND ur.user_id IS NOT NULL
       AND public.user_has_module_permission(ur.user_id, v_emp.organization_id, 'attendance', 'write')
  ) t;

  RETURN v_id;
END
$function$;


CREATE OR REPLACE FUNCTION public.attendance_notify_correction_event(_correction_id uuid, _event text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    SELECT v_c.organization_id, v_c.business_id, t.user_id, 'in_app', 'attendance', v_title, v_msg, '/hr/attendance/corrections', 'attendance_correction', v_c.id, 'normal'
      FROM (
        SELECT DISTINCT ur.user_id
          FROM public.user_roles ur
         WHERE ur.organization_id = v_c.organization_id
           AND ur.user_id IS NOT NULL
           AND public.user_has_module_permission(ur.user_id, v_c.organization_id, 'attendance', 'write')
      ) t;
  ELSIF _event IN ('approved','rejected') THEN
    v_title := 'Attendance correction ' || _event;
    v_msg := 'Your correction for ' || to_char(v_c.attendance_date,'Mon DD, YYYY') || ' was ' || _event ||
             COALESCE(' — ' || v_c.review_note, '');
    IF v_c.employee_user_id IS NOT NULL THEN
      INSERT INTO public.notifications (organization_id, business_id, user_id, type, category, title, message, link, entity_type, entity_id, priority)
      VALUES (v_c.organization_id, v_c.business_id, v_c.employee_user_id, 'in_app', 'attendance', v_title, v_msg, '/me/attendance', 'attendance_correction', v_c.id, 'normal');
    END IF;
  END IF;
END $function$;


CREATE OR REPLACE FUNCTION public.attendance_notify_late_arrival(_attendance_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    UPDATE public.attendance SET late_notified_at = now() WHERE id = _attendance_id;
    RETURN;
  END IF;

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
         AND ur.user_id IS NOT NULL
         AND public.user_has_module_permission(ur.user_id, v_a.organization_id, 'attendance', 'write')
    ) u
    WHERE u.user_id IS NOT NULL
  ) target;

  UPDATE public.attendance SET late_notified_at = now() WHERE id = _attendance_id;
END
$function$;
