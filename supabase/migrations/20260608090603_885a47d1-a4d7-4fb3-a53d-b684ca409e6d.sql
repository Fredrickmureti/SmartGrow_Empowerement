CREATE OR REPLACE FUNCTION public.attendance_admin_mark_absent(
  _attendance_id uuid,
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
BEGIN
  SELECT a.*, e.organization_id AS emp_org INTO v_rec
  FROM public.attendance a
  JOIN public.employees e ON e.id = a.employee_id
  WHERE a.id = _attendance_id;

  IF v_rec.id IS NULL THEN RAISE EXCEPTION 'ATTENDANCE_NOT_FOUND'; END IF;
  IF v_rec.is_locked THEN RAISE EXCEPTION 'RECORD_LOCKED'; END IF;
  IF v_rec.clock_in IS NOT NULL THEN RAISE EXCEPTION 'ALREADY_CLOCKED_IN'; END IF;

  v_org := v_rec.emp_org;
  IF NOT public.user_has_module_permission(v_user, v_org, 'attendance', 'write')
     AND NOT public.user_has_module_permission(v_user, v_org, 'hr', 'write') THEN
    RAISE EXCEPTION 'PERMISSION_DENIED';
  END IF;

  UPDATE public.attendance
  SET status = 'absent',
      notes = COALESCE(notes, '') ||
              ' [admin-mark-absent' || COALESCE(': ' || _reason, '') || ']',
      updated_at = now()
  WHERE id = _attendance_id;

  PERFORM public.attendance_log_event(
    v_org, v_rec.business_id, v_rec.branch_id, v_rec.employee_id,
    _attendance_id, 'admin_mark_absent', 'manual', 'allow',
    COALESCE(_reason, 'admin marked absent'),
    NULL, NULL, NULL, NULL, NULL, NULL,
    jsonb_build_object('by', v_user)
  );

  RETURN _attendance_id;
END $$;

GRANT EXECUTE ON FUNCTION public.attendance_admin_mark_absent(uuid, text) TO authenticated;