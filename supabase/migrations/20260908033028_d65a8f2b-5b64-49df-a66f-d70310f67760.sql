ALTER TABLE public.permission_groups
  ADD COLUMN IF NOT EXISTS default_branch_scope public.branch_scope_mode;

UPDATE public.permission_groups SET default_branch_scope = 'all'
  WHERE is_system = true AND name IN ('Institution Admin','Accountant','Auditor');
UPDATE public.permission_groups SET default_branch_scope = 'assigned'
  WHERE is_system = true AND name IN ('Branch Manager','Credit Analyst');
UPDATE public.permission_groups SET default_branch_scope = 'own_portfolio'
  WHERE is_system = true AND name IN ('Loan Officer','Cashier / Teller');

DELETE FROM public.member_permission_groups a
 USING public.member_permission_groups b
 WHERE a.user_id = b.user_id
   AND a.organization_id = b.organization_id
   AND a.ctid > b.ctid;

CREATE UNIQUE INDEX IF NOT EXISTS member_permission_groups_one_per_org
  ON public.member_permission_groups (user_id, organization_id);

CREATE OR REPLACE FUNCTION public.user_branch_scope(_user_id uuid, _org_id uuid)
 RETURNS public.branch_scope_mode
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _role public.app_role;
  _scope public.branch_scope_mode;
BEGIN
  SELECT ur.role INTO _role
  FROM public.user_roles ur
  WHERE ur.user_id = _user_id AND ur.organization_id = _org_id AND ur.is_active = true
  LIMIT 1;

  IF _role IN ('super_admin','owner','admin') THEN
    RETURN 'all'::public.branch_scope_mode;
  END IF;

  SELECT COALESCE(pg.default_branch_scope, mpg.branch_scope)
    INTO _scope
  FROM public.member_permission_groups mpg
  JOIN public.permission_groups pg ON pg.id = mpg.permission_group_id
  WHERE mpg.user_id = _user_id AND mpg.organization_id = _org_id
  LIMIT 1;

  RETURN COALESCE(_scope, 'own_portfolio'::public.branch_scope_mode);
END;
$function$;