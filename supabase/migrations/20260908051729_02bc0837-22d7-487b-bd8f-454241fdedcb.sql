CREATE OR REPLACE FUNCTION public.has_dashboard_permission(_user_id uuid, _perm text, _business_id uuid DEFAULT NULL::uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid;
  v_is_admin boolean := false;
  v_is_member boolean := false;
  v_all_branches boolean := false;
BEGIN
  IF _business_id IS NOT NULL THEN
    SELECT organization_id INTO v_org FROM public.businesses WHERE id = _business_id;
  END IF;

  SELECT
    bool_or(ur.role IN ('super_admin','owner','admin')),
    true
    INTO v_is_admin, v_is_member
  FROM public.user_roles ur
  WHERE ur.user_id = _user_id
    AND ur.is_active = true
    AND (v_org IS NULL OR ur.organization_id = v_org);

  v_is_admin  := COALESCE(v_is_admin, false);
  v_is_member := COALESCE(v_is_member, false);

  IF NOT v_is_member THEN
    RETURN false;
  END IF;

  -- Branch reach is decided by the access group, never by a role label.
  IF v_org IS NOT NULL THEN
    v_all_branches := public.user_branch_scope(_user_id, v_org) = 'all'::public.branch_scope_mode;
  ELSE
    v_all_branches := v_is_admin;
  END IF;

  RETURN CASE _perm
    WHEN 'dashboard.view_branch'       THEN true
    WHEN 'dashboard.view_hq'           THEN v_all_branches
    WHEN 'dashboard.view_consolidated' THEN v_all_branches
    WHEN 'dashboard.view_executive'    THEN v_is_admin
    ELSE false
  END;
END;
$function$;