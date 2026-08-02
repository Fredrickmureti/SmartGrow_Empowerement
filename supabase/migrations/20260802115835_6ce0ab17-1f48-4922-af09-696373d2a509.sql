-- Permission checks across the WMS/inventory RLS policies pass `business_id`
-- into `user_has_module_permission`, whose second argument is the
-- ORGANIZATION id. `user_roles` is keyed by organization, so the lookup never
-- matched and every write (license plates, tasks, quants, locations,
-- shipments, waves...) was rejected with 403.
--
-- Rather than rewrite 20+ policies, the function now resolves a business id to
-- its owning organization when the argument is not an organization. Access is
-- unchanged: an active `user_roles` row in the owning organization is still
-- required.
CREATE OR REPLACE FUNCTION public.user_has_module_permission(
  _user_id uuid,
  _org_id uuid,
  _module text,
  _operation text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _role public.app_role;
  _user_type text;
  _group_grants boolean := false;
  _base_grants boolean := false;
  _scope_id uuid := _org_id;
BEGIN
  SELECT ur.role, ur.user_type INTO _role, _user_type
  FROM public.user_roles ur
  WHERE ur.user_id = _user_id
    AND ur.organization_id = _scope_id
    AND ur.is_active = true
  LIMIT 1;

  -- Callers (notably the WMS/inventory RLS policies) pass a business id here.
  -- Resolve it to the owning organization and retry once.
  IF _role IS NULL THEN
    SELECT b.organization_id INTO _scope_id
    FROM public.businesses b
    WHERE b.id = _org_id;

    IF _scope_id IS NULL OR _scope_id = _org_id THEN
      RETURN false;
    END IF;

    SELECT ur.role, ur.user_type INTO _role, _user_type
    FROM public.user_roles ur
    WHERE ur.user_id = _user_id
      AND ur.organization_id = _scope_id
      AND ur.is_active = true
    LIMIT 1;
  END IF;

  IF _role IS NULL THEN
    RETURN false;
  END IF;

  IF _role IN ('super_admin', 'owner', 'admin') THEN
    RETURN true;
  END IF;

  _base_grants := (
    CASE
      WHEN _module = 'contacts'  AND _operation = 'read' THEN _role IN ('accountant','staff','viewer','cashier','internal')
      WHEN _module = 'contacts'  AND _operation IN ('create','write','delete') THEN _role IN ('accountant','staff','internal')
      WHEN _module = 'products'  AND _operation = 'read' THEN _role IN ('accountant','staff','viewer','cashier','internal')
      WHEN _module = 'products'  AND _operation IN ('create','write','delete') THEN _role IN ('staff','internal')
      WHEN _module = 'sales'     AND _operation = 'read' THEN _role IN ('accountant','staff','viewer','internal')
      WHEN _module = 'sales'     AND _operation IN ('create','write','delete') THEN _role IN ('accountant','staff','internal')
      WHEN _module = 'purchases' AND _operation = 'read' THEN _role IN ('accountant','staff','viewer','internal')
      WHEN _module = 'purchases' AND _operation IN ('create','write','delete') THEN _role IN ('accountant','staff','internal')
      WHEN _module = 'financials'AND _operation = 'read' THEN _role IN ('accountant','internal')
      WHEN _module = 'financials'AND _operation IN ('create','write','delete') THEN _role IN ('accountant','internal')
      WHEN _module = 'hr'        AND _operation = 'read' THEN _role IN ('accountant','internal')
      WHEN _module = 'hr'        AND _operation IN ('create','write','delete') THEN _role IN ('internal')
      WHEN _module = 'payroll'   AND _operation = 'read' THEN _role IN ('accountant','internal')
      WHEN _module = 'payroll'   AND _operation IN ('create','write','delete') THEN _role IN ('accountant','internal')
      WHEN _module = 'pos'       AND _operation = 'read' THEN _role IN ('accountant','staff','cashier','internal')
      WHEN _module = 'pos'       AND _operation IN ('create','write') THEN _role IN ('staff','cashier','internal')
      WHEN _module = 'pos'       AND _operation = 'delete' THEN _role IN ('internal')
      WHEN _module = 'inventory' AND _operation = 'read' THEN _role IN ('accountant','staff','viewer','internal')
      WHEN _module = 'inventory' AND _operation IN ('create','write') THEN _role IN ('staff','internal')
      WHEN _module = 'inventory' AND _operation = 'delete' THEN _role IN ('internal')
      WHEN _module = 'leave'     AND _operation = 'read' THEN true
      WHEN _module = 'leave'     AND _operation IN ('create','write','delete') THEN _role IN ('internal','accountant')
      WHEN _module = 'timesheets'AND _operation = 'read' THEN true
      WHEN _module = 'timesheets'AND _operation IN ('create','write','delete') THEN _role IN ('internal','accountant','staff')
      WHEN _module = 'projects'  AND _operation = 'read' THEN _role IN ('internal','accountant','staff','viewer')
      WHEN _module = 'projects'  AND _operation IN ('create','write','delete') THEN _role IN ('internal','accountant','staff')
      WHEN _module = 'settings'  AND _operation = 'read' THEN _role IN ('internal','accountant')
      WHEN _module = 'settings'  AND _operation IN ('create','write','delete') THEN false
      WHEN _module = 'team'      AND _operation = 'read' THEN _role IN ('internal','accountant')
      WHEN _module = 'team'      AND _operation IN ('create','write','delete') THEN false
      ELSE false
    END
  );

  IF _user_type = 'portal' THEN
    IF _module NOT IN ('leave','timesheets','projects') THEN
      RETURN false;
    END IF;
    _base_grants := false;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.member_permission_groups mpg
    JOIN public.permission_group_rules pgr ON pgr.permission_group_id = mpg.permission_group_id
    WHERE mpg.user_id = _user_id
      AND mpg.organization_id = _scope_id
      AND pgr.module = _module
      AND (
        (_operation = 'read'    AND pgr.can_read    = true) OR
        (_operation = 'create'  AND pgr.can_create  = true) OR
        (_operation = 'write'   AND pgr.can_write   = true) OR
        (_operation = 'delete'  AND pgr.can_delete  = true) OR
        (_operation = 'approve' AND pgr.can_approve = true) OR
        (_operation = 'post'    AND pgr.can_post    = true) OR
        (_operation = 'pay'     AND pgr.can_pay     = true) OR
        (_operation = 'close'   AND pgr.can_close   = true) OR
        (_operation = 'reverse' AND pgr.can_reverse = true) OR
        (_operation = 'export'  AND pgr.can_export  = true)
      )
  ) INTO _group_grants;

  RETURN _base_grants OR _group_grants;
END;
$function$;