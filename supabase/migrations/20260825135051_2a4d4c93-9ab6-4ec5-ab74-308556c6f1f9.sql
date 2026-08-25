CREATE OR REPLACE FUNCTION public.project_add_member(
  _project_id uuid,
  _user_id uuid,
  _role text DEFAULT 'member',
  _billable_rate numeric DEFAULT NULL,
  _can_write boolean DEFAULT NULL,
  _is_billable_participant boolean DEFAULT true
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_proj record;
  v_emp record;
  v_role text;
  v_write boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT id, organization_id, business_id, branch_id, allows_cross_branch_work
    INTO v_proj
    FROM public.projects WHERE id = _project_id;
  IF v_proj.id IS NULL THEN
    RAISE EXCEPTION 'project_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.project_is_governor(_project_id, v_uid) THEN
    RAISE EXCEPTION 'Only an administrator or the project manager can manage the project team'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_can_access_branch(v_uid, v_proj.branch_id) THEN
    RAISE EXCEPTION 'You are not authorized for this project''s branch'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_org_member(_user_id, v_proj.organization_id) THEN
    RAISE EXCEPTION 'That user is not a member of this organization' USING ERRCODE = '42501';
  END IF;

  SELECT e.id, e.branch_id, e.business_id, e.is_active, e.lifecycle_status
    INTO v_emp
    FROM public.employees e
   WHERE e.user_id = _user_id
     AND e.organization_id = v_proj.organization_id
     AND (v_proj.business_id IS NULL OR e.business_id = v_proj.business_id)
   ORDER BY (e.is_active IS TRUE) DESC
   LIMIT 1;

  IF v_emp.id IS NOT NULL THEN
    IF v_emp.is_active IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'That employee is not active in this company' USING ERRCODE = '42501';
    END IF;
    IF v_proj.branch_id IS NOT NULL
       AND v_emp.branch_id IS NOT NULL
       AND v_emp.branch_id <> v_proj.branch_id
       AND v_proj.allows_cross_branch_work IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'That person works in another branch. Enable cross-branch work on this project first.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  v_role := lower(coalesce(NULLIF(btrim(_role), ''), 'member'));
  IF v_role IN ('project_manager','owner') THEN v_role := 'manager'; END IF;
  IF v_role IN ('team_lead') THEN v_role := 'lead'; END IF;
  IF v_role NOT IN ('manager','lead','member') THEN
    RAISE EXCEPTION 'Unknown project role: %', _role USING ERRCODE = '22023';
  END IF;

  v_write := coalesce(_can_write, v_role IN ('manager','lead'));

  INSERT INTO public.project_members (
    project_id, user_id, role, project_role, can_write, is_billable_participant, billable_rate
  )
  VALUES (
    _project_id, _user_id, v_role, v_role, v_write,
    coalesce(_is_billable_participant, true), _billable_rate
  )
  ON CONFLICT (project_id, user_id)
  DO UPDATE SET
    role = EXCLUDED.role,
    project_role = EXCLUDED.project_role,
    can_write = EXCLUDED.can_write,
    is_billable_participant = EXCLUDED.is_billable_participant,
    billable_rate = EXCLUDED.billable_rate;
END;
$function$;