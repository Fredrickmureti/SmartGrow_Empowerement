
-- ============================================================
-- Phase 1: Create SECURITY DEFINER function for module-level 
-- permission checks (Odoo ir.model.access equivalent)
-- ============================================================

-- This function checks if a user has permission to perform an operation
-- on a specific module within an organization, considering:
-- 1. Their base role from user_roles
-- 2. Their permission group assignments from member_permission_groups + permission_group_rules
-- 3. The additive/ceiling logic from resolveEffectivePermissions

CREATE OR REPLACE FUNCTION public.user_has_module_permission(
  _user_id uuid,
  _org_id uuid,
  _module text,
  _operation text  -- 'read', 'create', 'write', 'delete'
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
  _is_additive boolean := false;
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

  -- Super admin, owner, admin always have full access (they are ceiling roles, 
  -- and their base permissions grant everything)
  IF _role IN ('super_admin', 'owner', 'admin') THEN
    RETURN true;
  END IF;

  -- 2. Check if user has any permission group rules
  SELECT EXISTS (
    SELECT 1
    FROM public.member_permission_groups mpg
    JOIN public.permission_group_rules pgr ON pgr.permission_group_id = mpg.permission_group_id
    WHERE mpg.user_id = _user_id 
      AND mpg.organization_id = _org_id
      AND pgr.module = _module
  ) INTO _has_group_rules;

  -- 3. Check group-level permission for this module + operation
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
  END IF;

  -- 4. Check base role permission for this module + operation
  -- We map module+operation to the same permission keys used in the frontend
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
      WHEN _module = 'leave' AND _operation = 'read' THEN true  -- All roles can view own leave
      WHEN _module = 'leave' AND _operation IN ('create', 'write', 'delete') THEN false
      -- Timesheets
      WHEN _module = 'timesheets' AND _operation = 'read' THEN true  -- All roles can view own timesheets
      WHEN _module = 'timesheets' AND _operation IN ('create', 'write', 'delete') THEN false
      -- Projects
      WHEN _module = 'projects' AND _operation = 'read' THEN _role IN ('accountant', 'staff', 'viewer')
      WHEN _module = 'projects' AND _operation IN ('create', 'write', 'delete') THEN false
      -- Settings
      WHEN _module = 'settings' AND _operation = 'read' THEN false
      WHEN _module = 'settings' AND _operation IN ('create', 'write', 'delete') THEN false
      -- Team
      WHEN _module = 'team' AND _operation = 'read' THEN false
      WHEN _module = 'team' AND _operation IN ('create', 'write', 'delete') THEN false
      ELSE false
    END
  );

  -- 5. Determine additive vs ceiling logic
  -- Additive roles: viewer, staff, accountant, cashier, portal
  _is_additive := _role IN ('viewer', 'staff', 'accountant', 'cashier', 'portal');

  -- 6. Combine: 
  -- If user has group rules for this module, use additive/ceiling logic
  -- If no group rules at all, fall back to base role
  IF _has_group_rules THEN
    IF _is_additive THEN
      -- Additive: base OR group grants
      RETURN _base_grants OR _group_grants;
    ELSE
      -- Ceiling: group AND base (for non-additive roles, but admin/owner/super_admin already returned true above)
      RETURN _group_grants AND _base_grants;
    END IF;
  ELSE
    -- No group rules: pure base role
    RETURN _base_grants;
  END IF;
END;
$$;

-- ============================================================
-- Phase 1b: Update RLS policies on employees table
-- ============================================================

-- Drop existing overly-permissive policies
DROP POLICY IF EXISTS "org_employees_select" ON public.employees;
DROP POLICY IF EXISTS "org_employees_insert" ON public.employees;
DROP POLICY IF EXISTS "org_employees_update" ON public.employees;
DROP POLICY IF EXISTS "org_employees_delete" ON public.employees;

-- Create new permission-aware policies (TO authenticated, not public)
CREATE POLICY "employees_select_with_permission" ON public.employees
  FOR SELECT TO authenticated
  USING (
    public.user_has_module_permission(auth.uid(), organization_id, 'hr', 'read')
  );

CREATE POLICY "employees_insert_with_permission" ON public.employees
  FOR INSERT TO authenticated
  WITH CHECK (
    public.user_has_module_permission(auth.uid(), organization_id, 'hr', 'create')
  );

CREATE POLICY "employees_update_with_permission" ON public.employees
  FOR UPDATE TO authenticated
  USING (
    public.user_has_module_permission(auth.uid(), organization_id, 'hr', 'write')
  );

CREATE POLICY "employees_delete_with_permission" ON public.employees
  FOR DELETE TO authenticated
  USING (
    public.user_has_module_permission(auth.uid(), organization_id, 'hr', 'delete')
  );
