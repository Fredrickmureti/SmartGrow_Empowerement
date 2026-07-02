
-- E1: Column-level guard for employee self-update.
-- The employees_self_update RLS policy permits a linked user to UPDATE their
-- own row but does NOT scope which columns may change. A linked user could
-- therefore mutate business_id, manager_id, employment_type, etc. The
-- frontend SELF_SERVICE_FIELDS allowlist is cosmetic. This trigger enforces
-- the whitelist server-side; HR/manager users with module write permission
-- pass through unchanged.

CREATE OR REPLACE FUNCTION public.enforce_employee_self_update_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_is_self boolean;
  v_has_write boolean;
BEGIN
  -- Service role / superuser / triggers w/o JWT: skip.
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  v_is_self := (OLD.user_id IS NOT NULL AND OLD.user_id = v_uid);

  IF NOT v_is_self THEN
    RETURN NEW;
  END IF;

  -- HR writers bypass the whitelist even when editing themselves.
  BEGIN
    v_has_write := public.user_has_module_permission(
      v_uid, OLD.organization_id, OLD.business_id, 'hr', 'write'
    );
  EXCEPTION WHEN undefined_function THEN
    v_has_write := public.user_has_module_permission(
      v_uid, OLD.organization_id, 'hr', 'write'
    );
  END;

  IF v_has_write THEN
    RETURN NEW;
  END IF;

  -- Whitelist of self-editable columns. Anything else must be identical.
  IF (NEW.first_name IS DISTINCT FROM OLD.first_name) THEN NULL; END IF;
  IF (NEW.last_name IS DISTINCT FROM OLD.last_name) THEN NULL; END IF;

  -- Reject any change outside the whitelist.
  IF
       NEW.email                          IS DISTINCT FROM OLD.email
    OR NEW.work_email                     IS DISTINCT FROM OLD.work_email
    OR NEW.national_id                    IS DISTINCT FROM OLD.national_id
    OR NEW.hire_date                      IS DISTINCT FROM OLD.hire_date
    OR NEW.job_position_id                IS DISTINCT FROM OLD.job_position_id
    OR NEW.work_location_id               IS DISTINCT FROM OLD.work_location_id
    OR NEW.employment_type                IS DISTINCT FROM OLD.employment_type
    OR NEW.bank_name                      IS DISTINCT FROM OLD.bank_name
    OR NEW.bank_branch                    IS DISTINCT FROM OLD.bank_branch
    OR NEW.bank_account_number            IS DISTINCT FROM OLD.bank_account_number
    OR NEW.bank_code                      IS DISTINCT FROM OLD.bank_code
    OR NEW.user_id                        IS DISTINCT FROM OLD.user_id
    OR NEW.manager_id                     IS DISTINCT FROM OLD.manager_id
    OR NEW.department_id                  IS DISTINCT FROM OLD.department_id
    OR NEW.business_id                    IS DISTINCT FROM OLD.business_id
    OR NEW.branch_id                      IS DISTINCT FROM OLD.branch_id
    OR NEW.organization_id                IS DISTINCT FROM OLD.organization_id
    OR NEW.is_active                      IS DISTINCT FROM OLD.is_active
    OR NEW.termination_date               IS DISTINCT FROM OLD.termination_date
  THEN
    RAISE EXCEPTION 'self-update restricted: only profile fields may be edited by the employee themselves'
      USING ERRCODE = '42501',
            HINT = 'Ask an HR manager to change employment, org, or banking fields.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_employee_self_update_columns ON public.employees;
CREATE TRIGGER trg_enforce_employee_self_update_columns
BEFORE UPDATE ON public.employees
FOR EACH ROW
EXECUTE FUNCTION public.enforce_employee_self_update_columns();

COMMENT ON FUNCTION public.enforce_employee_self_update_columns() IS
  'E1: server-side column whitelist for employee self-updates. Companion to the employees_self_update RLS policy. HR writers bypass.';
