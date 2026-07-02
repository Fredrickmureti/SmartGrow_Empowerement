-- =====================================================================
-- STAGE 1 — Extend the seeder with the three missing app-aligned groups
-- =====================================================================
CREATE OR REPLACE FUNCTION public.seed_default_permission_groups(p_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  portal_group_id UUID;
  internal_group_id UUID;
  payroll_admin_id UUID;
  payroll_officer_id UUID;
  accountant_id UUID;
  hr_manager_id UUID;
  time_off_officer_id UUID;
  attendance_officer_id UUID;
  sign_user_id UUID;
  recruiter_id UUID;
  project_manager_id UUID;
BEGIN
  -- Portal User
  SELECT id INTO portal_group_id FROM public.permission_groups
  WHERE organization_id = p_org_id AND name = 'Portal User' AND is_system = true;
  IF portal_group_id IS NULL THEN
    INSERT INTO public.permission_groups (organization_id, name, description, is_system)
    VALUES (p_org_id, 'Portal User', 'Self-service access: view payslips, request leave, submit timesheets', true)
    RETURNING id INTO portal_group_id;
  END IF;
  INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete) VALUES
    (portal_group_id, 'leave',      true, true, false, false),
    (portal_group_id, 'attendance', true, true, false, false),
    (portal_group_id, 'projects',   true, false, false, false)
  ON CONFLICT (permission_group_id, module) DO NOTHING;

  -- Internal User (least-privilege baseline)
  SELECT id INTO internal_group_id FROM public.permission_groups
  WHERE organization_id = p_org_id AND name = 'Internal User' AND is_system = true;
  IF internal_group_id IS NULL THEN
    INSERT INTO public.permission_groups (organization_id, name, description, is_system)
    VALUES (p_org_id, 'Internal User', 'Default group for internal staff. Read-only access to payroll and financials — assign Payroll Admin / Officer / Accountant for write access.', true)
    RETURNING id INTO internal_group_id;
  END IF;
  INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete) VALUES
    (internal_group_id, 'contacts',    true, true, true, true),
    (internal_group_id, 'products',    true, true, true, true),
    (internal_group_id, 'sales',       true, true, true, true),
    (internal_group_id, 'purchases',   true, true, true, true),
    (internal_group_id, 'financials',  true, false, false, false),
    (internal_group_id, 'employees',   true, true, true, true),
    (internal_group_id, 'leave',       true, true, true, true),
    (internal_group_id, 'attendance',  true, true, true, true),
    (internal_group_id, 'recruitment', true, true, true, true),
    (internal_group_id, 'projects',    true, true, true, true),
    (internal_group_id, 'payroll',     false, false, false, false),
    (internal_group_id, 'pos',         true, true, true, true),
    (internal_group_id, 'settings',    true, false, false, false),
    (internal_group_id, 'team',        true, false, false, false)
  ON CONFLICT (permission_group_id, module) DO NOTHING;

  -- Payroll Admin (full lifecycle including approve/post/export)
  SELECT id INTO payroll_admin_id FROM public.permission_groups
  WHERE organization_id = p_org_id AND name = 'Payroll Admin' AND is_system = true;
  IF payroll_admin_id IS NULL THEN
    INSERT INTO public.permission_groups (organization_id, name, description, is_system)
    VALUES (p_org_id, 'Payroll Admin', 'Full payroll lifecycle: prepare, approve, post to GL, export. Read access to employees, time off, attendance.', true)
    RETURNING id INTO payroll_admin_id;
  END IF;
  INSERT INTO public.permission_group_rules
    (permission_group_id, module, can_read, can_create, can_write, can_delete, can_approve, can_post, can_export) VALUES
    (payroll_admin_id, 'payroll',    true, true, true, true, true, true, true),
    (payroll_admin_id, 'employees',  true, false, false, false, false, false, false),
    (payroll_admin_id, 'leave',      true, false, false, false, false, false, false),
    (payroll_admin_id, 'attendance', true, false, false, false, false, false, false)
  ON CONFLICT (permission_group_id, module) DO UPDATE
    SET can_approve = EXCLUDED.can_approve,
        can_post    = EXCLUDED.can_post,
        can_export  = EXCLUDED.can_export;

  -- Payroll Officer (prepare-only, NO approve/post/export)
  SELECT id INTO payroll_officer_id FROM public.permission_groups
  WHERE organization_id = p_org_id AND name = 'Payroll Officer' AND is_system = true;
  IF payroll_officer_id IS NULL THEN
    INSERT INTO public.permission_groups (organization_id, name, description, is_system)
    VALUES (p_org_id, 'Payroll Officer', 'Prepare payroll: preview and create draft runs. Cannot approve, post, or export.', true)
    RETURNING id INTO payroll_officer_id;
  END IF;
  INSERT INTO public.permission_group_rules
    (permission_group_id, module, can_read, can_create, can_write, can_delete, can_approve, can_post, can_export) VALUES
    (payroll_officer_id, 'payroll',    true, true, true, false, false, false, false),
    (payroll_officer_id, 'employees',  true, false, false, false, false, false, false),
    (payroll_officer_id, 'leave',      true, false, false, false, false, false, false),
    (payroll_officer_id, 'attendance', true, false, false, false, false, false, false)
  ON CONFLICT (permission_group_id, module) DO NOTHING;

  -- Accountant (financials + post JEs + export)
  SELECT id INTO accountant_id FROM public.permission_groups
  WHERE organization_id = p_org_id AND name = 'Accountant' AND is_system = true;
  IF accountant_id IS NULL THEN
    INSERT INTO public.permission_groups (organization_id, name, description, is_system)
    VALUES (p_org_id, 'Accountant', 'Books: chart of accounts, journals, taxes. Can post journal entries and export reports.', true)
    RETURNING id INTO accountant_id;
  END IF;
  INSERT INTO public.permission_group_rules
    (permission_group_id, module, can_read, can_create, can_write, can_delete, can_approve, can_post, can_export) VALUES
    (accountant_id, 'financials', true, true, true, false, true, true, true),
    (accountant_id, 'sales',      true, false, false, false, false, false, true),
    (accountant_id, 'purchases',  true, false, false, false, false, false, true),
    (accountant_id, 'contacts',   true, true, true, false, false, false, false)
  ON CONFLICT (permission_group_id, module) DO UPDATE
    SET can_approve = EXCLUDED.can_approve,
        can_post    = EXCLUDED.can_post,
        can_export  = EXCLUDED.can_export;

  -- HR Manager
  SELECT id INTO hr_manager_id FROM public.permission_groups
  WHERE organization_id = p_org_id AND name = 'HR Manager' AND is_system = true;
  IF hr_manager_id IS NULL THEN
    INSERT INTO public.permission_groups (organization_id, name, description, is_system)
    VALUES (p_org_id, 'HR Manager', 'Manage employees, departments, leave types, recruitment.', true)
    RETURNING id INTO hr_manager_id;
  END IF;
  INSERT INTO public.permission_group_rules
    (permission_group_id, module, can_read, can_create, can_write, can_delete, can_approve, can_post, can_export) VALUES
    (hr_manager_id, 'employees',   true, true, true, true, false, false, true),
    (hr_manager_id, 'leave',       true, true, true, true, true, false, false),
    (hr_manager_id, 'attendance',  true, true, true, true, true, false, false),
    (hr_manager_id, 'recruitment', true, true, true, true, false, false, false)
  ON CONFLICT (permission_group_id, module) DO UPDATE
    SET can_approve = EXCLUDED.can_approve,
        can_export  = EXCLUDED.can_export;

  -- Time Off Officer
  SELECT id INTO time_off_officer_id FROM public.permission_groups
  WHERE organization_id = p_org_id AND name = 'Time Off Officer' AND is_system = true;
  IF time_off_officer_id IS NULL THEN
    INSERT INTO public.permission_groups (organization_id, name, description, is_system)
    VALUES (p_org_id, 'Time Off Officer', 'Approve and manage leave requests, leave types, balances.', true)
    RETURNING id INTO time_off_officer_id;
  END IF;
  INSERT INTO public.permission_group_rules
    (permission_group_id, module, can_read, can_create, can_write, can_delete, can_approve, can_post, can_export) VALUES
    (time_off_officer_id, 'leave',     true, true, true, true, true, false, false),
    (time_off_officer_id, 'employees', true, false, false, false, false, false, false)
  ON CONFLICT (permission_group_id, module) DO UPDATE
    SET can_approve = EXCLUDED.can_approve;

  -- Attendance Officer
  SELECT id INTO attendance_officer_id FROM public.permission_groups
  WHERE organization_id = p_org_id AND name = 'Attendance Officer' AND is_system = true;
  IF attendance_officer_id IS NULL THEN
    INSERT INTO public.permission_groups (organization_id, name, description, is_system)
    VALUES (p_org_id, 'Attendance Officer', 'Manage attendance records, work schedules, approve timesheets.', true)
    RETURNING id INTO attendance_officer_id;
  END IF;
  INSERT INTO public.permission_group_rules
    (permission_group_id, module, can_read, can_create, can_write, can_delete, can_approve, can_post, can_export) VALUES
    (attendance_officer_id, 'attendance', true, true, true, true, true, false, false),
    (attendance_officer_id, 'employees',  true, false, false, false, false, false, false)
  ON CONFLICT (permission_group_id, module) DO UPDATE
    SET can_approve = EXCLUDED.can_approve;

  -- Sign User
  SELECT id INTO sign_user_id FROM public.permission_groups
  WHERE organization_id = p_org_id AND name = 'Sign User' AND is_system = true;
  IF sign_user_id IS NULL THEN
    INSERT INTO public.permission_groups (organization_id, name, description, is_system)
    VALUES (p_org_id, 'Sign User', 'Send and manage electronic signature requests. Cannot delete signed documents.', true)
    RETURNING id INTO sign_user_id;
  END IF;
  INSERT INTO public.permission_group_rules
    (permission_group_id, module, can_read, can_create, can_write, can_delete) VALUES
    (sign_user_id, 'sign', true, true, true, false)
  ON CONFLICT (permission_group_id, module) DO NOTHING;

  -- Recruiter
  SELECT id INTO recruiter_id FROM public.permission_groups
  WHERE organization_id = p_org_id AND name = 'Recruiter' AND is_system = true;
  IF recruiter_id IS NULL THEN
    INSERT INTO public.permission_groups (organization_id, name, description, is_system)
    VALUES (p_org_id, 'Recruiter', 'Manage job postings, applicants, and the hiring pipeline.', true)
    RETURNING id INTO recruiter_id;
  END IF;
  INSERT INTO public.permission_group_rules
    (permission_group_id, module, can_read, can_create, can_write, can_delete) VALUES
    (recruiter_id, 'recruitment', true, true, true, true),
    (recruiter_id, 'employees',   true, true, false, false)
  ON CONFLICT (permission_group_id, module) DO NOTHING;

  -- Project Manager
  SELECT id INTO project_manager_id FROM public.permission_groups
  WHERE organization_id = p_org_id AND name = 'Project Manager' AND is_system = true;
  IF project_manager_id IS NULL THEN
    INSERT INTO public.permission_groups (organization_id, name, description, is_system)
    VALUES (p_org_id, 'Project Manager', 'Create and manage projects, tasks, and assign team members.', true)
    RETURNING id INTO project_manager_id;
  END IF;
  INSERT INTO public.permission_group_rules
    (permission_group_id, module, can_read, can_create, can_write, can_delete, can_approve) VALUES
    (project_manager_id, 'projects', true, true, true, true, true)
  ON CONFLICT (permission_group_id, module) DO UPDATE
    SET can_approve = EXCLUDED.can_approve;
END;
$function$;

-- =====================================================================
-- STAGE 1 — Backfill every existing workspace
-- =====================================================================
DO $$
DECLARE
  v_org_id uuid;
BEGIN
  FOR v_org_id IN SELECT id FROM public.organizations LOOP
    PERFORM public.seed_default_permission_groups(v_org_id);
  END LOOP;
END$$;

-- =====================================================================
-- STAGE 1 — Replace the auto-seed trigger so it ALWAYS fires
-- =====================================================================
CREATE OR REPLACE FUNCTION public.trg_seed_permission_groups_on_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.seed_default_permission_groups(NEW.id);
  RETURN NEW;
END;
$function$;

-- Recreate trigger to be sure it's bound and AFTER INSERT
DROP TRIGGER IF EXISTS trg_org_seed_permission_groups ON public.organizations;
CREATE TRIGGER trg_org_seed_permission_groups
AFTER INSERT ON public.organizations
FOR EACH ROW
EXECUTE FUNCTION public.trg_seed_permission_groups_on_org();

-- =====================================================================
-- STAGE 2 — Workspace-scope cleanup (Odoo res.groups behaviour)
-- =====================================================================
UPDATE public.permission_groups SET business_id = NULL WHERE business_id IS NOT NULL;
UPDATE public.member_permission_groups SET business_id = NULL WHERE business_id IS NOT NULL;

-- Keep the columns for now (Stage in a later PR will drop them) but neutralise
-- the per-business RLS predicate so it can never silently filter rows again.
DROP POLICY IF EXISTS permission_groups_business_scope ON public.permission_groups;
DROP POLICY IF EXISTS member_permission_groups_business_scope ON public.member_permission_groups;

-- =====================================================================
-- STAGE 3 — Rewrite deprecated module aliases ('hr', 'timesheets')
-- =====================================================================
-- Step A: collapse 'hr' → 'employees' (delete dups first)
DELETE FROM public.permission_group_rules a
USING public.permission_group_rules b
WHERE a.permission_group_id = b.permission_group_id
  AND a.module = 'hr'
  AND b.module = 'employees'
  AND a.id <> b.id;
UPDATE public.permission_group_rules SET module = 'employees' WHERE module = 'hr';

-- Step B: collapse 'timesheets' → 'attendance'
DELETE FROM public.permission_group_rules a
USING public.permission_group_rules b
WHERE a.permission_group_id = b.permission_group_id
  AND a.module = 'timesheets'
  AND b.module = 'attendance'
  AND a.id <> b.id;
UPDATE public.permission_group_rules SET module = 'attendance' WHERE module = 'timesheets';

-- =====================================================================
-- STAGE 4 — Wire approve / post / export into the resolver
-- =====================================================================
CREATE OR REPLACE FUNCTION public.user_has_module_permission(
  _user_id uuid, _org_id uuid, _module text, _operation text
)
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

  -- Base role grants only cover the four CRUD ops.
  -- Approve/post/export are GROUP-ONLY by design (SOX-style separation).
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
        WHEN 'export'  THEN pgr.can_export
        ELSE false
      END
  ) INTO _group_grants;

  RETURN _base_grants OR _group_grants;
END;
$function$;

-- =====================================================================
-- STAGE 6 — Audit trail on RBAC mutations
-- =====================================================================
CREATE OR REPLACE FUNCTION public.audit_permission_group_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid;
  v_event text;
  v_payload jsonb;
BEGIN
  v_event := TG_OP || ':' || TG_TABLE_NAME;
  IF TG_TABLE_NAME = 'permission_groups' THEN
    v_org := COALESCE(NEW.organization_id, OLD.organization_id);
    v_payload := jsonb_build_object(
      'group_id',   COALESCE(NEW.id, OLD.id),
      'group_name', COALESCE(NEW.name, OLD.name),
      'is_system',  COALESCE(NEW.is_system, OLD.is_system),
      'before',     to_jsonb(OLD),
      'after',      to_jsonb(NEW)
    );
  ELSIF TG_TABLE_NAME = 'permission_group_rules' THEN
    SELECT pg.organization_id INTO v_org
    FROM public.permission_groups pg
    WHERE pg.id = COALESCE(NEW.permission_group_id, OLD.permission_group_id);
    v_payload := jsonb_build_object(
      'group_id',  COALESCE(NEW.permission_group_id, OLD.permission_group_id),
      'module',    COALESCE(NEW.module, OLD.module),
      'before',    to_jsonb(OLD),
      'after',     to_jsonb(NEW)
    );
  ELSIF TG_TABLE_NAME = 'member_permission_groups' THEN
    v_org := COALESCE(NEW.organization_id, OLD.organization_id);
    v_payload := jsonb_build_object(
      'user_id',  COALESCE(NEW.user_id, OLD.user_id),
      'group_id', COALESCE(NEW.permission_group_id, OLD.permission_group_id),
      'before',   to_jsonb(OLD),
      'after',    to_jsonb(NEW)
    );
  END IF;

  IF v_org IS NOT NULL THEN
    INSERT INTO public.settings_audit_log (organization_id, actor_user_id, event, payload)
    VALUES (v_org, auth.uid(), v_event, v_payload);
  END IF;

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  -- Never block a write because of an audit failure.
  RETURN COALESCE(NEW, OLD);
END;
$function$;

-- Only attach the audit trigger if the settings_audit_log table exists.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='settings_audit_log'
  ) THEN
    DROP TRIGGER IF EXISTS trg_audit_permission_groups ON public.permission_groups;
    CREATE TRIGGER trg_audit_permission_groups
      AFTER INSERT OR UPDATE OR DELETE ON public.permission_groups
      FOR EACH ROW EXECUTE FUNCTION public.audit_permission_group_change();

    DROP TRIGGER IF EXISTS trg_audit_permission_group_rules ON public.permission_group_rules;
    CREATE TRIGGER trg_audit_permission_group_rules
      AFTER INSERT OR UPDATE OR DELETE ON public.permission_group_rules
      FOR EACH ROW EXECUTE FUNCTION public.audit_permission_group_change();

    DROP TRIGGER IF EXISTS trg_audit_member_permission_groups ON public.member_permission_groups;
    CREATE TRIGGER trg_audit_member_permission_groups
      AFTER INSERT OR UPDATE OR DELETE ON public.member_permission_groups
      FOR EACH ROW EXECUTE FUNCTION public.audit_permission_group_change();
  END IF;
END$$;