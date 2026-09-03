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
  _mod text := CASE
    WHEN _module = 'hr'         THEN 'employees'
    WHEN _module = 'timesheets' THEN 'attendance'
    ELSE _module
  END;
BEGIN
  SELECT ur.role, ur.user_type INTO _role, _user_type
  FROM public.user_roles ur
  WHERE ur.user_id = _user_id
    AND ur.organization_id = _org_id
    AND ur.is_active = true
  LIMIT 1;

  IF _role IS NULL THEN RETURN false; END IF;
  IF _role IN ('super_admin', 'owner', 'admin') THEN RETURN true; END IF;

  -- Base-role grants. Mirrors LENDING_ROLE_PERMISSIONS in src/lib/permissions.ts
  -- so DB enforcement agrees with the UI matrix without per-org seed data.
  _base_grants := (
    CASE
      WHEN _mod = 'contacts' AND _operation = 'read' THEN _role IN ('accountant','staff','viewer','cashier','internal')
      WHEN _mod = 'contacts' AND _operation IN ('create','write','delete') THEN _role IN ('accountant','staff','internal')
      WHEN _mod = 'financials' AND _operation IN ('read','create','write','delete') THEN _role IN ('accountant','internal')
      WHEN _mod = 'settings' AND _operation = 'read' THEN _role IN ('internal','accountant','branch_manager','credit_officer','loan_officer','collections_officer','auditor')
      WHEN _mod = 'team' AND _operation = 'read' THEN _role IN ('internal','accountant')
      WHEN _mod = 'lending' THEN (
        CASE _operation
          WHEN 'read'    THEN _role IN ('branch_manager','credit_officer','loan_officer','collections_officer','auditor')
          WHEN 'export'  THEN _role IN ('branch_manager','credit_officer','loan_officer','collections_officer','auditor')
          WHEN 'create'  THEN _role IN ('branch_manager','credit_officer','loan_officer')
          WHEN 'write'   THEN _role IN ('branch_manager','credit_officer','loan_officer','collections_officer')
          WHEN 'approve' THEN _role IN ('branch_manager','credit_officer')
          WHEN 'pay'     THEN _role IN ('branch_manager','loan_officer','collections_officer')
          WHEN 'close'   THEN _role IN ('branch_manager')
          ELSE false
        END
      )
      ELSE false
    END
  );
  IF _user_type = 'portal' THEN _base_grants := false; END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.member_permission_groups mpg
    JOIN public.permission_group_rules pgr ON pgr.permission_group_id = mpg.permission_group_id
    WHERE mpg.user_id = _user_id
      AND mpg.organization_id = _org_id
      AND pgr.module = _mod
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

  RETURN _base_grants OR _group_grants;
END;
$function$;