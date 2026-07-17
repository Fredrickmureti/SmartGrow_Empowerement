CREATE OR REPLACE FUNCTION public.prevent_employee_self_privilege_escalation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_is_admin boolean;
BEGIN
  IF v_caller IS NULL OR OLD.user_id IS NULL OR OLD.user_id <> v_caller THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE organization_id = OLD.organization_id
       AND user_id = v_caller AND is_active = true
       AND role IN ('owner','admin','super_admin')
  ) INTO v_is_admin;

  IF v_is_admin THEN RETURN NEW; END IF;

  -- NOTE: `basic_salary` and `position` columns were removed from
  -- public.employees (compensation lives on employee_contracts, role lives
  -- on job_position_id). Referencing them here caused
  -- "record 'new' has no field 'basic_salary'" on any self-update.
  IF NEW.is_active        IS DISTINCT FROM OLD.is_active        OR
     NEW.user_id          IS DISTINCT FROM OLD.user_id          OR
     NEW.organization_id  IS DISTINCT FROM OLD.organization_id  OR
     NEW.business_id      IS DISTINCT FROM OLD.business_id      OR
     NEW.employment_type  IS DISTINCT FROM OLD.employment_type  OR
     NEW.job_position_id  IS DISTINCT FROM OLD.job_position_id  OR
     NEW.employee_number  IS DISTINCT FROM OLD.employee_number  OR
     NEW.hire_date        IS DISTINCT FROM OLD.hire_date THEN
    RAISE EXCEPTION 'You can only edit your profile details. Contact an HR admin to change employment fields.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$function$;