
-- =====================================================
-- RBAC HARDENING: project_members table + permission ceiling fix
-- =====================================================

-- STEP 1: Create project_members table for record-level scoping
CREATE TABLE IF NOT EXISTS public.project_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'manager', 'viewer')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, user_id)
);

-- Enable RLS
ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;

-- RLS policies for project_members
CREATE POLICY "project_members_select"
  ON public.project_members FOR SELECT
  USING (
    user_has_module_permission(auth.uid(), (
      SELECT p.organization_id FROM public.projects p WHERE p.id = project_id
    ), 'projects', 'read')
  );

CREATE POLICY "project_members_insert"
  ON public.project_members FOR INSERT
  WITH CHECK (
    user_has_module_permission(auth.uid(), (
      SELECT p.organization_id FROM public.projects p WHERE p.id = project_id
    ), 'projects', 'create')
  );

CREATE POLICY "project_members_update"
  ON public.project_members FOR UPDATE
  USING (
    user_has_module_permission(auth.uid(), (
      SELECT p.organization_id FROM public.projects p WHERE p.id = project_id
    ), 'projects', 'write')
  );

CREATE POLICY "project_members_delete"
  ON public.project_members FOR DELETE
  USING (
    user_has_module_permission(auth.uid(), (
      SELECT p.organization_id FROM public.projects p WHERE p.id = project_id
    ), 'projects', 'delete')
  );

-- Create indexes for performance
CREATE INDEX idx_project_members_project ON public.project_members(project_id);
CREATE INDEX idx_project_members_user ON public.project_members(user_id);
CREATE INDEX idx_project_members_project_user ON public.project_members(project_id, user_id);

-- STEP 2: Backfill existing projects - add manager_id and created_by as members
INSERT INTO public.project_members (project_id, user_id, role)
SELECT id, manager_id, 'manager'
FROM public.projects
WHERE manager_id IS NOT NULL AND is_active = true
ON CONFLICT (project_id, user_id) DO NOTHING;

INSERT INTO public.project_members (project_id, user_id, role)
SELECT id, created_by, 'member'
FROM public.projects
WHERE created_by IS NOT NULL AND is_active = true
ON CONFLICT (project_id, user_id) DO NOTHING;

-- STEP 3: Create helper function for record-level project access checks
CREATE OR REPLACE FUNCTION public.user_is_project_member(_user_id uuid, _project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.project_members
    WHERE project_id = _project_id AND user_id = _user_id
  );
$$;

-- STEP 4: Fix user_has_module_permission - enforce ceiling (INTERSECTION mode)
-- Group grants can NEVER exceed what the base role allows
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

  -- 2. Check if user has any permission group rules for this module
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

  -- 5. FIXED: Always use INTERSECTION mode (ceiling enforcement)
  -- Group grants can NEVER exceed base role permissions.
  -- This prevents privilege escalation where a viewer given can_create via a group
  -- could bypass their base role ceiling.
  IF _has_group_rules THEN
    RETURN _base_grants AND _group_grants;
  END IF;

  RETURN _base_grants;
END;
$$;

-- STEP 5: Update Projects SELECT RLS to incorporate record-level scoping
-- Users can see projects they are members of, OR public projects, OR all if they have manageProjects
DROP POLICY IF EXISTS projects_select_perm ON public.projects;

CREATE POLICY "projects_select_perm"
  ON public.projects FOR SELECT
  USING (
    -- Must have base read permission for projects module
    user_has_module_permission(auth.uid(), organization_id, 'projects', 'read')
    AND (
      -- Admins/owners/super_admins always pass (handled in user_has_module_permission)
      -- Managers can see all projects in their org
      EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = auth.uid()
          AND ur.organization_id = projects.organization_id
          AND ur.is_active = true
          AND ur.role IN ('super_admin', 'owner', 'admin')
      )
      -- Project is public
      OR privacy = 'public'
      -- User is a member of this project
      OR user_is_project_member(auth.uid(), id)
      -- User is the manager
      OR manager_id = auth.uid()
      -- User is the creator
      OR created_by = auth.uid()
    )
  );

-- STEP 6: Insert preinstalled system permission groups for Projects
-- These are org-independent templates. Each org gets them via a trigger or manual setup.
-- For now, we create a function that orgs can call to seed their groups.
CREATE OR REPLACE FUNCTION public.seed_project_permission_groups(_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _group_user_id uuid;
  _group_manager_id uuid;
  _group_admin_id uuid;
BEGIN
  -- Project User group
  INSERT INTO public.permission_groups (organization_id, name, description, is_system, is_additive)
  VALUES (_org_id, 'Project User', 'Can view assigned projects and log time. Cannot create or manage projects.', true, false)
  ON CONFLICT DO NOTHING
  RETURNING id INTO _group_user_id;

  IF _group_user_id IS NOT NULL THEN
    INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
    VALUES (_group_user_id, 'projects', true, false, false, false);
  END IF;

  -- Project Manager group
  INSERT INTO public.permission_groups (organization_id, name, description, is_system, is_additive)
  VALUES (_org_id, 'Project Manager', 'Can create and manage projects, assign team members, manage tasks.', true, false)
  ON CONFLICT DO NOTHING
  RETURNING id INTO _group_manager_id;

  IF _group_manager_id IS NOT NULL THEN
    INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
    VALUES (_group_manager_id, 'projects', true, true, true, false);
  END IF;

  -- Project Admin group
  INSERT INTO public.permission_groups (organization_id, name, description, is_system, is_additive)
  VALUES (_org_id, 'Project Admin', 'Full control over all projects including deletion and settings.', true, false)
  ON CONFLICT DO NOTHING
  RETURNING id INTO _group_admin_id;

  IF _group_admin_id IS NOT NULL THEN
    INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
    VALUES (_group_admin_id, 'projects', true, true, true, true);
  END IF;
END;
$$;
