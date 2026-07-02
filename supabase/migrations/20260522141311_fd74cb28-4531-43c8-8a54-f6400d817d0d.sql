
-- Governance reset hardening: add missing has_role(uuid, text) overload and
-- bypass timesheet lock guard during privileged org reset.

-- 1) Overload: has_role(uuid, text)
--    Many helpers (trg_timesheets_lock_guard, lock_timesheets_for_payroll,
--    unlock_timesheets_for_payroll, submit_timesheet_period,
--    _timesheet_can_approve) call has_role with a plain text role and the
--    user id only. The existing 3-arg has_role(uuid, uuid, app_role)
--    cannot resolve those calls -> "function has_role(uuid, unknown) does
--    not exist", which blocks DELETE on timesheets during org reset.
--
--    This overload returns true when the user holds the named role on any
--    active membership, OR when the user is a super_admin / platform admin.
--    Unknown role strings (e.g. 'hr_admin', which is not in app_role)
--    return false instead of raising a cast error.
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_exists boolean := false;
BEGIN
  IF _user_id IS NULL OR _role IS NULL OR _role = '' THEN
    RETURN false;
  END IF;

  -- Platform admin shortcut.
  BEGIN
    IF public.is_platform_admin(_user_id) THEN
      RETURN true;
    END IF;
  EXCEPTION WHEN undefined_function THEN
    -- is_platform_admin may not exist in older environments; ignore.
    NULL;
  END;

  SELECT EXISTS (
    SELECT 1
      FROM public.user_roles ur
     WHERE ur.user_id = _user_id
       AND ur.is_active = true
       AND ur.role::text = _role
  ) INTO v_exists;

  RETURN v_exists;
END;
$$;

GRANT EXECUTE ON FUNCTION public.has_role(uuid, text) TO authenticated, anon, service_role;

-- 2) Teardown bypass on timesheets lock guard.
--    Without this, even owner/admin reset hits "Timesheet is locked
--    (invoiced or payroll-closed) and cannot be deleted" whenever any
--    timesheet row has is_invoiced or payroll_locked set.
CREATE OR REPLACE FUNCTION public.trg_timesheets_lock_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_is_admin boolean := false;
  v_org      uuid;
BEGIN
  v_org := COALESCE(NEW.organization_id, OLD.organization_id);

  -- Governance plane: privileged org reset is allowed to wipe locked rows.
  IF v_org IS NOT NULL AND public._is_teardown_for_org(v_org) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  SELECT public.has_role(auth.uid(), 'admin')
      OR public.has_role(auth.uid(), 'hr_admin')
      OR public.has_role(auth.uid(), 'owner')
    INTO v_is_admin;

  IF (TG_OP = 'UPDATE') THEN
    IF (OLD.is_invoiced OR OLD.payroll_locked) AND NOT v_is_admin THEN
      RAISE EXCEPTION 'Timesheet is locked (invoiced or payroll-closed) and cannot be edited';
    END IF;
  ELSIF (TG_OP = 'DELETE') THEN
    IF (OLD.is_invoiced OR OLD.payroll_locked) AND NOT v_is_admin THEN
      RAISE EXCEPTION 'Timesheet is locked (invoiced or payroll-closed) and cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;
