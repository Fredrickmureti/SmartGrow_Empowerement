CREATE OR REPLACE FUNCTION public.user_branch_scope(_user_id uuid, _org_id uuid)
RETURNS branch_scope_mode
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _scope public.branch_scope_mode;
BEGIN
  IF _user_id IS NULL OR _org_id IS NULL THEN
    RETURN 'own_portfolio'::public.branch_scope_mode;
  END IF;

  -- The organization owner is the only identity whose reach is not decided by
  -- an access group. Role labels no longer grant organization-wide reach.
  IF EXISTS (
    SELECT 1 FROM public.organizations o
     WHERE o.id = _org_id AND o.owner_user_id = _user_id
  ) THEN
    RETURN 'all'::public.branch_scope_mode;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = _user_id AND ur.organization_id = _org_id AND ur.is_active = true
  ) THEN
    RETURN 'own_portfolio'::public.branch_scope_mode;
  END IF;

  SELECT COALESCE(pg.default_branch_scope, mpg.branch_scope)
    INTO _scope
    FROM public.member_permission_groups mpg
    JOIN public.permission_groups pg ON pg.id = mpg.permission_group_id
   WHERE mpg.user_id = _user_id AND mpg.organization_id = _org_id
   ORDER BY (COALESCE(pg.default_branch_scope, mpg.branch_scope) = 'all'::public.branch_scope_mode) DESC
   LIMIT 1;

  RETURN COALESCE(_scope, 'own_portfolio'::public.branch_scope_mode);
END;
$function$;