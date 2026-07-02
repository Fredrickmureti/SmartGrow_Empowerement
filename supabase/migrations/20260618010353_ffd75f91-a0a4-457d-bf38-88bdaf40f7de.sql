-- Wave B2.1 — widen attendance_devices.status to include 'disabled'.
-- The previous attempt failed because the existing function returns uuid, not
-- void. This revision preserves the exact existing signature/return type and
-- permission model (user_has_module_permission(...,'attendance','write')) so
-- callers in src/hooks/hr/useAttendanceDevices.ts are unaffected; only the
-- allowed status domain widens.

-- (1) Drop and re-add the CHECK constraint with the widened domain.
DO $$
DECLARE
  v_conname text;
BEGIN
  SELECT conname INTO v_conname
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'attendance_devices'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%status%';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.attendance_devices DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;

ALTER TABLE public.attendance_devices
  ADD CONSTRAINT attendance_devices_status_check
  CHECK (status IN ('active','disabled','suspended','revoked'));

-- (2) Update the status-setter RPC: same signature, same return type, same
-- auth check, just an expanded status whitelist. CREATE OR REPLACE works
-- because we are not changing the return type.
CREATE OR REPLACE FUNCTION public.attendance_device_set_status(_id uuid, _status text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v record;
  v_user uuid := auth.uid();
BEGIN
  IF _status NOT IN ('active','disabled','suspended','revoked') THEN
    RAISE EXCEPTION 'INVALID_STATUS' USING DETAIL = format('status=%L', _status);
  END IF;
  SELECT * INTO v FROM public.attendance_devices WHERE id = _id;
  IF v.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF NOT public.user_has_module_permission(v_user, v.organization_id, 'attendance', 'write') THEN
    RAISE EXCEPTION 'PERMISSION_DENIED';
  END IF;
  UPDATE public.attendance_devices SET status = _status, updated_at = now() WHERE id = _id;
  RETURN _id;
END
$$;

COMMENT ON FUNCTION public.attendance_device_set_status(uuid, text) IS
  'Wave B2.1: validates and applies a status transition for an attendance device. '
  'Accepts active|disabled|suspended|revoked. Permission: attendance.write on the device''s organisation.';
