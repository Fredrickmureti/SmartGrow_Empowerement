CREATE OR REPLACE FUNCTION public.is_org_administrator(_user_id uuid, _org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    _user_id IS NOT NULL
    AND _org_id IS NOT NULL
    AND (
      EXISTS (
        SELECT 1 FROM public.organizations o
         WHERE o.id = _org_id AND o.owner_user_id = _user_id
      )
      OR EXISTS (
        SELECT 1
          FROM public.user_roles ur
          JOIN public.member_permission_groups mpg
            ON mpg.user_id = ur.user_id AND mpg.organization_id = ur.organization_id
          JOIN public.permission_groups g
            ON g.id = mpg.permission_group_id
          JOIN public.permission_group_rules r
            ON r.permission_group_id = g.id
         WHERE ur.user_id = _user_id
           AND ur.organization_id = _org_id
           AND ur.is_active = true
           AND ur.user_type = 'internal'
           AND COALESCE(g.is_deprecated, false) = false
           AND r.module = 'team'
           AND r.can_write = true
           AND COALESCE(g.default_branch_scope, mpg.branch_scope) = 'all'::public.branch_scope_mode
      )
    );
$function$;

GRANT EXECUTE ON FUNCTION public.is_org_administrator(uuid, uuid) TO authenticated;