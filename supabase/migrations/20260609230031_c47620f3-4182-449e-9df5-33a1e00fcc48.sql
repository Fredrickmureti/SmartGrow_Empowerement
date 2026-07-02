-- Fix: Postgres format() only supports %s/%I/%L. The previous version used
-- a C-style "%.2f" specifier which raised
--   ERROR: unrecognized format() type specifier "."
-- and caused every overtime request submission to 400.
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