-- Fix user_has_module_permission: Odoo-aligned ADDITIVE mode for internal users
-- Groups define permissions directly — no ceiling from base role.
-- Only portal users have restricted group behavior.
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
AS $$
DECLARE
  _role public.app_role;
  _user_type text;
  _has_group_rules boolean := false;
  _group_grants boolean := false;
  _base_grants boolean := false;
BEGIN
  -- 1. Get user's role and type in this org
  SELECT ur.role, ur.user_type INTO _role, _user_type
  FROM public.user_roles ur
  WHERE ur.user_id = _user_id 
    AND ur.organization_id = _org_id 
    AND ur.is_active = true
  LIMIT 1;

  -- No role found = no access
  IF _role IS NULL THEN
    RETURN false;
  END IF;

  -- Super admin, owner, admin always have full access
  IF _role IN ('super_admin', 'owner', 'admin') THEN
    RETURN true;
  END IF;

  -- 2. Check if user has ANY permission group assignments in this org
  SELECT EXISTS (
    SELECT 1
    FROM public.member_permission_groups mpg
    WHERE mpg.user_id = _user_id 
      AND mpg.organization_id = _org_id
  ) INTO _has_group_rules;

  -- 3. If user has group assignments, check group-level permission for this module + operation
  IF _has_group_rules THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.member_permission_groups mpg
      JOIN public.permission_group_rules pgr ON pgr.permission_group_id = mpg.permission_group_id
      WHERE mpg.user_id = _user_id 
        AND mpg.organization_id = _org_id
        AND pgr.module = _module
        AND (
          (_operation = 'read' AND pgr.can_read = true) OR
          (_operation = 'create' AND pgr.can_create = true) OR
          (_operation = 'write' AND pgr.can_write = true) OR
          (_operation = 'delete' AND pgr.can_delete = true)
        )
    ) INTO _group_grants;

    -- ADDITIVE mode (Odoo-aligned): For internal users (non-portal),
    -- groups DEFINE permissions directly. No ceiling from base role.
    -- If the group grants it, the user gets it.
    IF _user_type != 'portal' THEN
      RETURN _group_grants;
    END IF;

    -- Portal users: only allow leave/timesheets modules via groups
    IF _user_type = 'portal' THEN
      IF _module IN ('leave', 'timesheets') THEN
        RETURN _group_grants;
      ELSE
        RETURN false;
      END IF;
    END IF;
  END IF;

  -- 4. No groups assigned — fall back to base role permissions
  _base_grants := (
    CASE 
      -- Contacts
      WHEN _module = 'contacts' AND _operation = 'read' THEN _role IN ('accountant', 'staff', 'viewer', 'cashier')
      WHEN _module = 'contacts' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('accountant', 'staff')
      -- Products
      WHEN _module = 'products' AND _operation = 'read' THEN _role IN ('accountant', 'staff', 'viewer', 'cashier')
      WHEN _module = 'products' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('staff')
      -- Sales
      WHEN _module = 'sales' AND _operation = 'read' THEN _role IN ('accountant', 'staff', 'viewer')
      WHEN _module = 'sales' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('accountant', 'staff')
      -- Purchases
      WHEN _module = 'purchases' AND _operation = 'read' THEN _role IN ('accountant', 'staff', 'viewer')
      WHEN _module = 'purchases' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('accountant', 'staff')
      -- Financials
      WHEN _module = 'financials' AND _operation = 'read' THEN _role IN ('accountant')
      WHEN _module = 'financials' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('accountant')
      -- HR
      WHEN _module = 'hr' AND _operation = 'read' THEN _role IN ('accountant')
      WHEN _module = 'hr' AND _operation IN ('create', 'write', 'delete') THEN false
      -- Payroll
      WHEN _module = 'payroll' AND _operation = 'read' THEN _role IN ('accountant')
      WHEN _module = 'payroll' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('accountant')
      -- POS
      WHEN _module = 'pos' AND _operation = 'read' THEN _role IN ('accountant', 'staff', 'cashier')
      WHEN _module = 'pos' AND _operation IN ('create', 'write') THEN _role IN ('staff', 'cashier')
      WHEN _module = 'pos' AND _operation = 'delete' THEN false
      -- Leave
      WHEN _module = 'leave' AND _operation = 'read' THEN true
      WHEN _module = 'leave' AND _operation IN ('create', 'write', 'delete') THEN false
      -- Timesheets
      WHEN _module = 'timesheets' AND _operation = 'read' THEN true
      WHEN _module = 'timesheets' AND _operation IN ('create', 'write', 'delete') THEN false
      -- Projects
      WHEN _module = 'projects' AND _operation = 'read' THEN _role IN ('accountant', 'staff', 'viewer')
      WHEN _module = 'projects' AND _operation IN ('create', 'write') THEN _role IN ('staff')
      WHEN _module = 'projects' AND _operation = 'delete' THEN false
      -- Settings
      WHEN _module = 'settings' AND _operation = 'read' THEN false
      WHEN _module = 'settings' AND _operation IN ('create', 'write', 'delete') THEN false
      -- CRM
      WHEN _module = 'crm' AND _operation = 'read' THEN _role IN ('staff', 'viewer')
      WHEN _module = 'crm' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('staff')
      -- Inventory
      WHEN _module = 'inventory' AND _operation = 'read' THEN _role IN ('accountant', 'staff', 'viewer')
      WHEN _module = 'inventory' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('staff')
      ELSE false
    END
  );

  RETURN _base_grants;
END;
$$;