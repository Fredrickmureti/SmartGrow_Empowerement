CREATE OR REPLACE FUNCTION public.user_has_module_permission(_user_id uuid, _org_id uuid, _module text, _operation text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _role public.app_role;
  _user_type text;
  _group_grants boolean := false;
  _base_grants boolean := false;
BEGIN
  SELECT ur.role, ur.user_type INTO _role, _user_type
  FROM public.user_roles ur
  WHERE ur.user_id = _user_id
    AND ur.organization_id = _org_id
    AND ur.is_active = true
  LIMIT 1;

  IF _role IS NULL THEN
    RETURN false;
  END IF;

  IF _role IN ('super_admin', 'owner', 'admin') THEN
    RETURN true;
  END IF;

  _base_grants := (
    CASE
      -- Client / member master (contacts kept as a legacy alias of clients)
      WHEN _module IN ('clients','contacts') AND _operation = 'read' THEN _role IN ('accountant','staff','viewer','cashier','internal')
      WHEN _module IN ('clients','contacts') AND _operation IN ('create','write','delete') THEN _role IN ('accountant','staff','internal')
      -- Lending: origination, assessment, loan book
      WHEN _module = 'lending' AND _operation = 'read' THEN _role IN ('accountant','staff','viewer','internal')
      WHEN _module = 'lending' AND _operation IN ('create','write') THEN _role IN ('staff','accountant','internal')
      WHEN _module = 'lending' AND _operation IN ('delete','approve','post','reverse') THEN _role IN ('internal')
      -- Collections: field follow-up on arrears
      WHEN _module = 'collections' AND _operation = 'read' THEN _role IN ('accountant','staff','viewer','cashier','internal')
      WHEN _module = 'collections' AND _operation IN ('create','write') THEN _role IN ('staff','cashier','accountant','internal')
      WHEN _module = 'collections' AND _operation IN ('delete','approve','reverse') THEN _role IN ('internal')
      -- Payments: repayments, receipts, till
      WHEN _module = 'payments' AND _operation = 'read' THEN _role IN ('accountant','cashier','staff','internal')
      WHEN _module = 'payments' AND _operation IN ('create','write','pay') THEN _role IN ('cashier','accountant','internal')
      WHEN _module = 'payments' AND _operation IN ('delete','approve','post','reverse','close') THEN _role IN ('accountant','internal')
      -- Finance / ledger (financials kept as a legacy alias)
      WHEN _module IN ('finance','financials') AND _operation = 'read' THEN _role IN ('accountant','internal')
      WHEN _module IN ('finance','financials') AND _operation IN ('create','write','delete','post','reverse','close') THEN _role IN ('accountant','internal')
      -- Reporting
      WHEN _module = 'reports' AND _operation IN ('read','export') THEN _role IN ('accountant','staff','viewer','internal')
      WHEN _module = 'reports' AND _operation IN ('create','write','delete') THEN false
      -- Staff records (retained; no payroll)
      WHEN _module = 'employees' AND _operation = 'read' THEN _role IN ('accountant','internal')
      WHEN _module = 'employees' AND _operation IN ('create','write','delete') THEN _role IN ('internal')
      -- Administration
      WHEN _module = 'settings' AND _operation = 'read' THEN _role IN ('internal','accountant')
      WHEN _module = 'settings' AND _operation IN ('create','write','delete') THEN false
      WHEN _module = 'team' AND _operation = 'read' THEN _role IN ('internal','accountant')
      WHEN _module = 'team' AND _operation IN ('create','write','delete') THEN false
      ELSE false
    END
  );

  -- Portal identities have no institutional module access; a borrower-facing
  -- portal is explicitly out of scope, so nothing is granted by base role.
  IF _user_type = 'portal' THEN
    RETURN false;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.member_permission_groups mpg
    JOIN public.permission_group_rules pgr ON pgr.permission_group_id = mpg.permission_group_id
    WHERE mpg.user_id = _user_id
      AND mpg.organization_id = _org_id
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

REVOKE EXECUTE ON FUNCTION public.user_has_module_permission(uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.user_has_module_permission(uuid, uuid, text, text) TO authenticated, service_role;