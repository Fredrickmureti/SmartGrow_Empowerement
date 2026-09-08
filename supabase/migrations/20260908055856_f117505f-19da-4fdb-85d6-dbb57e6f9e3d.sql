CREATE OR REPLACE FUNCTION public.user_has_module_permission(_user_id uuid, _org_id uuid, _module text, _operation text)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _user_type text;
  _exists boolean;
  _group_grants boolean := false;
  _mod text := CASE
    WHEN _module = 'hr'         THEN 'employees'
    WHEN _module = 'timesheets' THEN 'attendance'
    ELSE _module
  END;
  _lending_mods constant text[] := ARRAY[
    'clients','loan_products','applications','loans','repayments','collections'
  ];
  _fin_mods constant text[] := ARRAY['accounting','treasury'];
BEGIN
  SELECT true, ur.user_type INTO _exists, _user_type
  FROM public.user_roles ur
  WHERE ur.user_id = _user_id
    AND ur.organization_id = _org_id
    AND ur.is_active = true
  LIMIT 1;

  IF _exists IS NOT TRUE THEN RETURN false; END IF;
  IF _user_type = 'portal' THEN RETURN false; END IF;

  -- Ownership, not a role label, is the only blanket authority.
  IF EXISTS (
    SELECT 1 FROM public.organizations o
     WHERE o.id = _org_id AND o.owner_user_id = _user_id
  ) THEN
    RETURN true;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.member_permission_groups mpg
    JOIN public.permission_group_rules pgr ON pgr.permission_group_id = mpg.permission_group_id
    WHERE mpg.user_id = _user_id
      AND mpg.organization_id = _org_id
      AND (
        pgr.module = _mod
        OR (pgr.module = 'lending'    AND _mod = ANY(_lending_mods))
        OR (pgr.module = 'financials' AND _mod = ANY(_fin_mods))
      )
      AND CASE _operation
        WHEN 'read'    THEN pgr.can_read
        WHEN 'create'  THEN pgr.can_create
        WHEN 'write'   THEN pgr.can_write
        WHEN 'delete'  THEN pgr.can_delete
        WHEN 'approve' THEN pgr.can_approve
        WHEN 'post'    THEN pgr.can_post
        WHEN 'pay'     THEN pgr.can_pay
        WHEN 'close'   THEN pgr.can_close
        WHEN 'reverse' THEN pgr.can_reverse
        WHEN 'export'  THEN pgr.can_export
        ELSE false
      END
  ) INTO _group_grants;

  RETURN _group_grants;
END;
$function$;