CREATE OR REPLACE FUNCTION public._timesheet_assert_project_eligibility(
  _project_id uuid,
  _employee_id uuid
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_proj record;
  v_emp record;
BEGIN
  IF _project_id IS NULL THEN RETURN; END IF;

  SELECT id, organization_id, business_id, branch_id, status, is_active,
         allow_timesheets, allows_cross_branch_work, time_entry_open_to_org, manager_id
    INTO v_proj
    FROM public.projects WHERE id = _project_id;

  IF v_proj.id IS NULL THEN
    RAISE EXCEPTION 'That project does not exist' USING ERRCODE = 'P0002';
  END IF;

  SELECT id, user_id, organization_id, business_id, branch_id, is_active
    INTO v_emp
    FROM public.employees WHERE id = _employee_id;

  IF v_emp.id IS NULL THEN
    RAISE EXCEPTION 'That employee does not exist' USING ERRCODE = 'P0002';
  END IF;

  IF v_emp.organization_id <> v_proj.organization_id
     OR (v_proj.business_id IS NOT NULL AND v_emp.business_id IS DISTINCT FROM v_proj.business_id) THEN
    RAISE EXCEPTION 'That project belongs to another company' USING ERRCODE = '42501';
  END IF;

  IF v_proj.is_active IS DISTINCT FROM TRUE
     OR v_proj.status IN ('completed','cancelled') THEN
    RAISE EXCEPTION 'This project no longer accepts time entries' USING ERRCODE = '42501';
  END IF;

  IF v_proj.allow_timesheets IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Timesheets are disabled on this project' USING ERRCODE = '42501';
  END IF;

  IF v_proj.branch_id IS NOT NULL
     AND v_emp.branch_id IS NOT NULL
     AND v_emp.branch_id <> v_proj.branch_id
     AND v_proj.allows_cross_branch_work IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'This project belongs to another branch and does not allow cross-branch work'
      USING ERRCODE = '42501';
  END IF;

  IF v_proj.time_entry_open_to_org IS DISTINCT FROM TRUE THEN
    IF v_emp.user_id IS NULL
       OR NOT (
         public.is_project_member(v_proj.id, v_emp.user_id)
         OR public.project_is_governor(v_proj.id, v_emp.user_id)
       ) THEN
      RAISE EXCEPTION 'That employee is not on this project''s team' USING ERRCODE = '42501';
    END IF;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public._timesheet_assert_project_eligibility(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.trg_timesheets_project_eligibility()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.project_id IS NOT NULL
     AND (TG_OP = 'INSERT'
          OR NEW.project_id IS DISTINCT FROM OLD.project_id
          OR NEW.employee_id IS DISTINCT FROM OLD.employee_id) THEN
    PERFORM public._timesheet_assert_project_eligibility(NEW.project_id, NEW.employee_id);
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_timesheets_project_eligibility() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS timesheets_aa_project_eligibility ON public.timesheets;
CREATE TRIGGER timesheets_aa_project_eligibility
  BEFORE INSERT OR UPDATE ON public.timesheets
  FOR EACH ROW EXECUTE FUNCTION public.trg_timesheets_project_eligibility();