
-- 1. Extend user_has_module_permission to support 'pay' op.
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

  IF _operation IN ('read','create','write','delete') THEN
    _base_grants := (
      CASE
        WHEN _mod = 'contacts' AND _operation = 'read' THEN _role IN ('accountant','staff','viewer','cashier','internal')
        WHEN _mod = 'contacts' AND _operation IN ('create','write','delete') THEN _role IN ('accountant','staff','internal')
        WHEN _mod = 'products' AND _operation = 'read' THEN _role IN ('accountant','staff','viewer','cashier','internal')
        WHEN _mod = 'products' AND _operation IN ('create','write','delete') THEN _role IN ('staff','internal')
        WHEN _mod = 'sales' AND _operation = 'read' THEN _role IN ('accountant','staff','viewer','internal')
        WHEN _mod = 'sales' AND _operation IN ('create','write','delete') THEN _role IN ('accountant','staff','internal')
        WHEN _mod = 'purchases' AND _operation = 'read' THEN _role IN ('accountant','staff','viewer','internal')
        WHEN _mod = 'purchases' AND _operation IN ('create','write','delete') THEN _role IN ('accountant','staff','internal')
        WHEN _mod = 'financials' AND _operation IN ('read','create','write','delete') THEN _role IN ('accountant','internal')
        WHEN _mod = 'employees' AND _operation IN ('read','create','write','delete') THEN _role IN ('internal')
        WHEN _mod = 'recruitment' AND _operation IN ('read','create','write','delete') THEN _role IN ('internal')
        WHEN _mod = 'pos' AND _operation = 'read' THEN _role IN ('accountant','staff','cashier','internal')
        WHEN _mod = 'pos' AND _operation IN ('create','write') THEN _role IN ('staff','cashier','internal')
        WHEN _mod = 'pos' AND _operation = 'delete' THEN _role IN ('internal')
        WHEN _mod = 'projects' AND _operation = 'read' THEN _role IN ('internal','accountant','staff','viewer')
        WHEN _mod = 'projects' AND _operation IN ('create','write','delete') THEN _role IN ('internal','accountant','staff')
        WHEN _mod = 'settings' AND _operation = 'read' THEN _role IN ('internal','accountant')
        WHEN _mod = 'team' AND _operation = 'read' THEN _role IN ('internal','accountant')
        ELSE false
      END
    );
    IF _user_type = 'portal' THEN _base_grants := false; END IF;
  END IF;

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
        WHEN 'export'  THEN pgr.can_export
        ELSE false
      END
  ) INTO _group_grants;

  RETURN _base_grants OR _group_grants;
END;
$function$;

-- 2. Rewrite user_can_post_payroll to use module-permission model + full SoD.
CREATE OR REPLACE FUNCTION public.user_can_post_payroll(_user_id uuid, _org_id uuid, _run_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_created_by  uuid;
  v_approved_by uuid;
  v_override    boolean;
BEGIN
  IF NOT public.user_has_module_permission(_user_id, _org_id, 'payroll', 'post') THEN
    RETURN false;
  END IF;

  SELECT created_by, approved_by INTO v_created_by, v_approved_by
  FROM public.payroll_runs
  WHERE id = _run_id;

  -- Admin override (owner / super_admin / admin / can_admin_override) can bypass SoD.
  IF v_created_by = _user_id OR v_approved_by = _user_id THEN
    v_override := public.user_has_payroll_admin_override(_user_id, _org_id);
    IF NOT v_override THEN
      RETURN false;
    END IF;
  END IF;

  RETURN true;
END;
$function$;

-- 3. New SoD helper for pay.
CREATE OR REPLACE FUNCTION public.user_can_pay_payroll(_user_id uuid, _org_id uuid, _run_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_created_by  uuid;
  v_approved_by uuid;
  v_posted_by   uuid;
  v_override    boolean;
BEGIN
  IF NOT public.user_has_module_permission(_user_id, _org_id, 'payroll', 'pay') THEN
    RETURN false;
  END IF;

  SELECT created_by, approved_by, posted_by INTO v_created_by, v_approved_by, v_posted_by
  FROM public.payroll_runs
  WHERE id = _run_id;

  IF v_created_by = _user_id OR v_approved_by = _user_id OR v_posted_by = _user_id THEN
    v_override := public.user_has_payroll_admin_override(_user_id, _org_id);
    IF NOT v_override THEN
      RETURN false;
    END IF;
  END IF;

  RETURN true;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.user_can_post_payroll(uuid, uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.user_can_pay_payroll(uuid, uuid, uuid) TO authenticated, service_role;
