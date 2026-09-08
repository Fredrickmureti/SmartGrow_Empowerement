CREATE OR REPLACE FUNCTION public.can_access_branch(_user_id uuid, _branch_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org_id UUID;
  v_scope public.branch_scope_mode;
BEGIN
  SELECT b.organization_id INTO v_org_id
  FROM public.branches b
  WHERE b.id = _branch_id;

  IF v_org_id IS NULL THEN
    RETURN FALSE;
  END IF;

  v_scope := public.user_branch_scope(_user_id, v_org_id);

  IF v_scope = 'all' THEN
    RETURN TRUE;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.user_assigned_branch_ids(_user_id, v_org_id) ab
    WHERE ab.branch_id = _branch_id
  );
END;
$function$;