
-- =============================================================
-- Fix 1: Update base role permissions for projects module
-- Allow staff to create/write/delete projects (matching sales/contacts pattern)
-- =============================================================
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

  -- Super admin, owner, admin always have full access
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
      -- Projects (FIXED: staff can now create/write/delete)
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

  -- 5. Determine final access
  -- Check if the group mode is additive or override
  IF _has_group_rules THEN
    SELECT COALESCE(pg.is_additive, false) INTO _is_additive
    FROM public.member_permission_groups mpg
    JOIN public.permission_groups pg ON pg.id = mpg.permission_group_id
    WHERE mpg.user_id = _user_id 
      AND mpg.organization_id = _org_id
    LIMIT 1;

    IF _is_additive THEN
      RETURN _base_grants OR _group_grants;
    ELSE
      RETURN _group_grants;
    END IF;
  END IF;

  RETURN _base_grants;
END;
$$;

-- =============================================================
-- Fix 2: Upgrade child table RLS to use user_has_module_permission
-- =============================================================

-- PROJECT_STAGES: Drop weak policies, add proper RBAC
DROP POLICY IF EXISTS "Users can view project stages" ON public.project_stages;
DROP POLICY IF EXISTS "Users can manage project stages" ON public.project_stages;

CREATE POLICY "project_stages_select_perm" ON public.project_stages
  FOR SELECT TO authenticated
  USING (
    project_id IN (
      SELECT id FROM public.projects p
      WHERE user_has_module_permission(auth.uid(), p.organization_id, 'projects', 'read')
    )
  );

CREATE POLICY "project_stages_insert_perm" ON public.project_stages
  FOR INSERT TO authenticated
  WITH CHECK (
    project_id IN (
      SELECT id FROM public.projects p
      WHERE user_has_module_permission(auth.uid(), p.organization_id, 'projects', 'create')
    )
  );

CREATE POLICY "project_stages_update_perm" ON public.project_stages
  FOR UPDATE TO authenticated
  USING (
    project_id IN (
      SELECT id FROM public.projects p
      WHERE user_has_module_permission(auth.uid(), p.organization_id, 'projects', 'write')
    )
  );

CREATE POLICY "project_stages_delete_perm" ON public.project_stages
  FOR DELETE TO authenticated
  USING (
    project_id IN (
      SELECT id FROM public.projects p
      WHERE user_has_module_permission(auth.uid(), p.organization_id, 'projects', 'delete')
    )
  );

-- PROJECT_MILESTONES: Drop weak policies, add proper RBAC
DROP POLICY IF EXISTS "Users can view project milestones" ON public.project_milestones;
DROP POLICY IF EXISTS "Users can manage project milestones" ON public.project_milestones;

CREATE POLICY "project_milestones_select_perm" ON public.project_milestones
  FOR SELECT TO authenticated
  USING (
    project_id IN (
      SELECT id FROM public.projects p
      WHERE user_has_module_permission(auth.uid(), p.organization_id, 'projects', 'read')
    )
  );

CREATE POLICY "project_milestones_insert_perm" ON public.project_milestones
  FOR INSERT TO authenticated
  WITH CHECK (
    project_id IN (
      SELECT id FROM public.projects p
      WHERE user_has_module_permission(auth.uid(), p.organization_id, 'projects', 'create')
    )
  );

CREATE POLICY "project_milestones_update_perm" ON public.project_milestones
  FOR UPDATE TO authenticated
  USING (
    project_id IN (
      SELECT id FROM public.projects p
      WHERE user_has_module_permission(auth.uid(), p.organization_id, 'projects', 'write')
    )
  );

CREATE POLICY "project_milestones_delete_perm" ON public.project_milestones
  FOR DELETE TO authenticated
  USING (
    project_id IN (
      SELECT id FROM public.projects p
      WHERE user_has_module_permission(auth.uid(), p.organization_id, 'projects', 'delete')
    )
  );

-- PROJECT_TASK_ACTIVITIES: Drop weak policies, add proper RBAC
DROP POLICY IF EXISTS "Users can view project task activities" ON public.project_task_activities;
DROP POLICY IF EXISTS "Users can manage project task activities" ON public.project_task_activities;

CREATE POLICY "project_task_activities_select_perm" ON public.project_task_activities
  FOR SELECT TO authenticated
  USING (
    task_id IN (
      SELECT pt.id FROM public.project_tasks pt
      WHERE user_has_module_permission(auth.uid(), pt.organization_id, 'projects', 'read')
    )
  );

CREATE POLICY "project_task_activities_insert_perm" ON public.project_task_activities
  FOR INSERT TO authenticated
  WITH CHECK (
    task_id IN (
      SELECT pt.id FROM public.project_tasks pt
      WHERE user_has_module_permission(auth.uid(), pt.organization_id, 'projects', 'create')
    )
  );

CREATE POLICY "project_task_activities_update_perm" ON public.project_task_activities
  FOR UPDATE TO authenticated
  USING (
    task_id IN (
      SELECT pt.id FROM public.project_tasks pt
      WHERE user_has_module_permission(auth.uid(), pt.organization_id, 'projects', 'write')
    )
  );

CREATE POLICY "project_task_activities_delete_perm" ON public.project_task_activities
  FOR DELETE TO authenticated
  USING (
    task_id IN (
      SELECT pt.id FROM public.project_tasks pt
      WHERE user_has_module_permission(auth.uid(), pt.organization_id, 'projects', 'delete')
    )
  );
