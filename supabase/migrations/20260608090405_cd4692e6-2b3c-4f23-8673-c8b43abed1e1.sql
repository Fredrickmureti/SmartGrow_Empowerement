-- Admin RPC: force-close a stale (open) attendance session, with audit trail.
CREATE OR REPLACE FUNCTION public.attendance_admin_close_session(
  _attendance_id uuid,
  _clock_out timestamptz DEFAULT NULL,
  _reason text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_rec record;
  v_org uuid;
  v_close timestamptz;
  v_settings_hours int;
BEGIN
  SELECT a.*, e.organization_id AS emp_org INTO v_rec
  FROM public.attendance a
  JOIN public.employees e ON e.id = a.employee_id
  WHERE a.id = _attendance_id;

  IF v_rec.id IS NULL THEN RAISE EXCEPTION 'ATTENDANCE_NOT_FOUND'; END IF;
  IF v_rec.clock_out IS NOT NULL THEN RAISE EXCEPTION 'ALREADY_CLOSED'; END IF;

  v_org := v_rec.emp_org;
  IF NOT public.user_has_module_permission(v_user, v_org, 'attendance', 'write')
     AND NOT public.user_has_module_permission(v_user, v_org, 'hr', 'write') THEN
    RAISE EXCEPTION 'PERMISSION_DENIED';
  END IF;

  -- Default close time = clock_in + auto_checkout_after_hours (fallback 16h)
  SELECT COALESCE(auto_checkout_after_hours, 16) INTO v_settings_hours
  FROM public.attendance_settings WHERE business_id = v_rec.business_id LIMIT 1;
  v_close := COALESCE(_clock_out, v_rec.clock_in + make_interval(hours => COALESCE(v_settings_hours, 16)));

  -- Guard: clock_out must be after clock_in
  IF v_close <= v_rec.clock_in THEN
    RAISE EXCEPTION 'INVALID_CLOCK_OUT';
  END IF;

  UPDATE public.attendance
  SET clock_out = v_close,
      notes = COALESCE(notes, '') ||
              ' [admin-closed' || COALESCE(': ' || _reason, '') || ']',
      updated_at = now()
  WHERE id = _attendance_id;

  PERFORM public.attendance_log_event(
    v_org, v_rec.business_id, v_rec.branch_id, v_rec.employee_id,
    _attendance_id, 'admin_close', 'manual', 'allow',
    COALESCE(_reason, 'admin force-close stale session'),
    NULL, NULL, NULL, NULL, NULL, NULL,
    jsonb_build_object('closed_at', v_close, 'by', v_user)
  );

  RETURN _attendance_id;
END $$;

GRANT EXECUTE ON FUNCTION public.attendance_admin_close_session(uuid, timestamptz, text) TO authenticated;