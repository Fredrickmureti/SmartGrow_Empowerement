-- Bring attendance-kiosk PIN functions in line with the cashier/manager
-- pattern: SET search_path TO 'public', 'extensions' so pgcrypto helpers
-- (crypt, gen_salt) resolve correctly under SECURITY DEFINER.
-- Bodies are reproduced verbatim from the original migrations — only the
-- search_path clause changes.

CREATE OR REPLACE FUNCTION public.set_employee_kiosk_pin(_employee_id uuid, _pin text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  UPDATE public.employees
  SET kiosk_pin_hash = crypt(_pin, gen_salt('bf'))
  WHERE id = _employee_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.attendance_kiosk_clock(
  _organization_id uuid, _branch_id uuid, _employee_number text, _pin text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_employee record;
  v_open_session record;
  v_result jsonb;
BEGIN
  SELECT * INTO v_employee
  FROM public.employees
  WHERE organization_id = _organization_id
    AND employee_number = _employee_number
    AND is_active = true;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'employee_not_found');
  END IF;

  IF v_employee.kiosk_pin_hash IS NULL
     OR v_employee.kiosk_pin_hash <> crypt(_pin, v_employee.kiosk_pin_hash) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_pin');
  END IF;

  SELECT * INTO v_open_session
  FROM public.attendance_sessions
  WHERE employee_id = v_employee.id
    AND clock_out_at IS NULL
  ORDER BY clock_in_at DESC
  LIMIT 1;

  IF FOUND THEN
    UPDATE public.attendance_sessions
       SET clock_out_at = now(), clock_out_source = 'kiosk'
     WHERE id = v_open_session.id;
    v_result := jsonb_build_object('ok', true, 'action', 'clock_out', 'session_id', v_open_session.id);
  ELSE
    INSERT INTO public.attendance_sessions(
      organization_id, branch_id, employee_id, clock_in_at, clock_in_source
    ) VALUES (
      _organization_id, _branch_id, v_employee.id, now(), 'kiosk'
    ) RETURNING jsonb_build_object('ok', true, 'action', 'clock_in', 'session_id', id) INTO v_result;
  END IF;

  RETURN v_result;
END;
$function$;