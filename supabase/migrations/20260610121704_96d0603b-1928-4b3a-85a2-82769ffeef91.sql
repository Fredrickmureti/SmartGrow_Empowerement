CREATE OR REPLACE FUNCTION public.overtime_request_decide(_id uuid, _decision text, _reason text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v record;
  v_user uuid := auth.uid();
  v_emp_user uuid;
  v_msg text;
BEGIN
  IF _decision NOT IN ('approved','rejected','cancelled') THEN
    RAISE EXCEPTION 'INVALID_DECISION';
  END IF;
  SELECT * INTO v FROM public.overtime_requests WHERE id = _id;
  IF v.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF NOT public.user_has_module_permission(v_user, v.organization_id, 'attendance', 'write') THEN
    RAISE EXCEPTION 'PERMISSION_DENIED';
  END IF;

  UPDATE public.overtime_requests
     SET status = _decision,
         approved_by = v_user,
         approved_at = now(),
         rejection_reason = CASE WHEN _decision='rejected' THEN _reason ELSE rejection_reason END,
         updated_at = now()
   WHERE id = _id;

  SELECT user_id INTO v_emp_user FROM public.employees WHERE id = v.employee_id;
  IF v_emp_user IS NOT NULL THEN
    v_msg := format('Your %sh OT request for %s was %s%s',
                    to_char(v.requested_hours, 'FM999990.00'),
                    to_char(v.ot_date,'Mon DD, YYYY'),
                    _decision,
                    COALESCE(' — ' || _reason, ''));
    INSERT INTO public.notifications (
      organization_id, business_id, user_id,
      type, category, title, message, link,
      entity_type, entity_id, priority
    ) VALUES (
      v.organization_id, v.business_id, v_emp_user,
      'in_app', 'attendance',
      'Overtime ' || _decision,
      v_msg,
      '/me/attendance',
      'overtime_request', v.id, 2
    );
  END IF;

  RETURN _id;
END
$function$;