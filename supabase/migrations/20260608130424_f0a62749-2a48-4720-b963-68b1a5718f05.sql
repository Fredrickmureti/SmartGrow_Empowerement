-- B7.3: late-reason capture
ALTER TABLE public.attendance
  ADD COLUMN IF NOT EXISTS late_reason text;

ALTER TABLE public.attendance_settings
  ADD COLUMN IF NOT EXISTS require_late_reason boolean NOT NULL DEFAULT true;

-- B7.7: one-shot period close that wraps attendance_lock_for_period and
-- returns a pre/post summary HR can show in a confirmation dialog.
CREATE OR REPLACE FUNCTION public.attendance_close_period(
  _from date,
  _to date,
  _branch_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id uuid;
  v_employee_ids uuid[];
  v_unresolved_corrections int := 0;
  v_missing_checkouts int := 0;
  v_locked_count int := 0;
BEGIN
  IF _from IS NULL OR _to IS NULL OR _from > _to THEN
    RAISE EXCEPTION 'invalid date range';
  END IF;

  -- Resolve org from the caller's active employee record. Mirrors the
  -- scoping used by other attendance_* RPCs.
  SELECT organization_id INTO v_org_id
    FROM public.employees
   WHERE auth_user_id = auth.uid()
   LIMIT 1;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'no organization context';
  END IF;

  -- Branch restriction → narrow the affected employees; otherwise NULL
  -- lets attendance_lock_for_period operate on all org employees.
  IF _branch_id IS NOT NULL THEN
    SELECT array_agg(id) INTO v_employee_ids
      FROM public.employees
     WHERE organization_id = v_org_id
       AND branch_id = _branch_id;
  END IF;

  -- Pre-flight read-only counters for the confirmation UI.
  SELECT count(*) INTO v_unresolved_corrections
    FROM public.attendance_corrections
   WHERE organization_id = v_org_id
     AND status = 'pending'
     AND attendance_date BETWEEN _from AND _to
     AND (_branch_id IS NULL OR branch_id = _branch_id);

  SELECT count(*) INTO v_missing_checkouts
    FROM public.attendance
   WHERE organization_id = v_org_id
     AND attendance_date BETWEEN _from AND _to
     AND clock_in IS NOT NULL
     AND clock_out IS NULL
     AND (_branch_id IS NULL OR branch_id = _branch_id);

  -- Delegate to the existing locker. It enforces its own permission rules.
  v_locked_count := COALESCE(
    public.attendance_lock_for_period(
      v_org_id,
      _from,
      _to,
      NULL,
      v_employee_ids
    ),
    0
  );

  RETURN jsonb_build_object(
    'locked_count', v_locked_count,
    'unresolved_corrections', v_unresolved_corrections,
    'missing_checkouts', v_missing_checkouts,
    'from', _from,
    'to', _to,
    'branch_id', _branch_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_close_period(date, date, uuid) TO authenticated;