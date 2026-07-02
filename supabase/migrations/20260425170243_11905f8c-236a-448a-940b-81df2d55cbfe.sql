
-- ===========================================================================
-- Step 1 — Fix the time_off vs time-off trigger arg drift on leave_requests.
-- The trigger was created with arg 'time_off' (underscore) but the registry
-- and platform_apps.id is 'time-off' (hyphen). Once any tenant installs
-- Time Off, the trigger would block every leave INSERT/UPDATE/DELETE.
-- ===========================================================================

DROP TRIGGER IF EXISTS trg_leave_requests_app_installed ON public.leave_requests;

CREATE TRIGGER trg_leave_requests_app_installed
BEFORE INSERT OR UPDATE OR DELETE ON public.leave_requests
FOR EACH ROW EXECUTE FUNCTION public.assert_app_installed_for_write('time-off');

-- ===========================================================================
-- Sister fix — leave_allocations should also be gated by Time Off install.
-- Currently has no trigger; add one so the gate is consistent.
-- (No-op if you don't have a leave_allocations table.)
-- ===========================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='leave_allocations') THEN
    DROP TRIGGER IF EXISTS trg_leave_allocations_app_installed ON public.leave_allocations;
    CREATE TRIGGER trg_leave_allocations_app_installed
    BEFORE INSERT OR UPDATE OR DELETE ON public.leave_allocations
    FOR EACH ROW EXECUTE FUNCTION public.assert_app_installed_for_write('time-off');
  END IF;
END $$;

-- ===========================================================================
-- Step 10 — Tighten Internal User permission group seed (least privilege).
-- The previous seed gave Internal User full payroll + financials, defeating
-- the explicit Payroll Admin / Payroll Officer / Accountant separation.
-- New baseline: read-only payroll, read-only financials. Explicit roles
-- must be assigned for write access to those modules.
--
-- IMPORTANT: this is a SEED change — it only affects ORGS WHERE the seed
-- runs again (new orgs). Existing orgs are NOT mutated by this migration
-- to avoid silently revoking access. We do NOT touch existing rows.
-- ===========================================================================

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
BEGIN
  -- Portal User (self-service: leave, timesheets, profile)
  SELECT id INTO portal_group_id
  FROM public.permission_groups
  WHERE organization_id = p_org_id AND name = 'Portal User' AND is_system = true;
  IF portal_group_id IS NULL THEN
    INSERT INTO public.permission_groups (organization_id, name, description, is_system)
    VALUES (p_org_id, 'Portal User', 'Self-service access: view payslips, request leave, submit timesheets', true)
    RETURNING id INTO portal_group_id;
  END IF;
  INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete) VALUES
    (portal_group_id, 'leave',      true, true, false, false),
    (portal_group_id, 'timesheets', true, true, false, false),
    (portal_group_id, 'attendance', true, true, false, false),
    (portal_group_id, 'projects',   true, false, false, false)
  ON CONFLICT (permission_group_id, module) DO NOTHING;

  -- Internal User (LEAST-PRIVILEGE baseline — payroll & financials READ-ONLY)
  SELECT id INTO internal_group_id
  FROM public.permission_groups
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
    (internal_group_id, 'financials',  true, false, false, false),  -- read-only (was full)
    (internal_group_id, 'employees',   true, true, true, true),
    (internal_group_id, 'leave',       true, true, true, true),
    (internal_group_id, 'attendance',  true, true, true, true),
    (internal_group_id, 'recruitment', true, true, true, true),
    (internal_group_id, 'projects',    true, true, true, true),
    (internal_group_id, 'payroll',     false, false, false, false), -- denied (was full)
    (internal_group_id, 'pos',         true, true, true, true),
    (internal_group_id, 'settings',    true, false, false, false),  -- read-only (was full)
    (internal_group_id, 'team',        true, false, false, false)   -- read-only (was full)
  ON CONFLICT (permission_group_id, module) DO NOTHING;

  -- Payroll Admin
  SELECT id INTO payroll_admin_id
  FROM public.permission_groups
  WHERE organization_id = p_org_id AND name = 'Payroll Admin' AND is_system = true;
  IF payroll_admin_id IS NULL THEN
    INSERT INTO public.permission_groups (organization_id, name, description, is_system)
    VALUES (p_org_id, 'Payroll Admin', 'Full payroll lifecycle: preview, create, approve, post, reverse. Read access to employees, time off, and attendance.', true)
    RETURNING id INTO payroll_admin_id;
  END IF;
  INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete) VALUES
    (payroll_admin_id, 'payroll',    true, true, true, true),
    (payroll_admin_id, 'employees',  true, false, false, false),
    (payroll_admin_id, 'leave',      true, false, false, false),
    (payroll_admin_id, 'attendance', true, false, false, false)
  ON CONFLICT (permission_group_id, module) DO NOTHING;

  -- Payroll Officer
  SELECT id INTO payroll_officer_id
  FROM public.permission_groups
  WHERE organization_id = p_org_id AND name = 'Payroll Officer' AND is_system = true;
  IF payroll_officer_id IS NULL THEN
    INSERT INTO public.permission_groups (organization_id, name, description, is_system)
    VALUES (p_org_id, 'Payroll Officer', 'Prepare payroll: preview and create draft runs. Cannot approve, post, or reverse.', true)
    RETURNING id INTO payroll_officer_id;
  END IF;
  INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete) VALUES
    (payroll_officer_id, 'payroll',    true, true, false, false),
    (payroll_officer_id, 'employees',  true, false, false, false),
    (payroll_officer_id, 'attendance', true, false, false, false)
  ON CONFLICT (permission_group_id, module) DO NOTHING;

  -- Accountant
  SELECT id INTO accountant_id
  FROM public.permission_groups
  WHERE organization_id = p_org_id AND name = 'Accountant' AND is_system = true;
  IF accountant_id IS NULL THEN
    INSERT INTO public.permission_groups (organization_id, name, description, is_system)
    VALUES (p_org_id, 'Accountant', 'Financials, sales, purchases, contacts, and read-only payroll for posting to GL.', true)
    RETURNING id INTO accountant_id;
  END IF;
  INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete) VALUES
    (accountant_id, 'financials', true, true, true, true),
    (accountant_id, 'sales',      true, true, true, false),
    (accountant_id, 'purchases',  true, true, true, false),
    (accountant_id, 'contacts',   true, true, true, false),
    (accountant_id, 'payroll',    true, false, false, false)
  ON CONFLICT (permission_group_id, module) DO NOTHING;

  -- HR Manager
  SELECT id INTO hr_manager_id
  FROM public.permission_groups
  WHERE organization_id = p_org_id AND name = 'HR Manager' AND is_system = true;
  IF hr_manager_id IS NULL THEN
    INSERT INTO public.permission_groups (organization_id, name, description, is_system)
    VALUES (p_org_id, 'HR Manager', 'Manage employees, departments, contracts, time off, attendance, and recruitment. Read-only payroll.', true)
    RETURNING id INTO hr_manager_id;
  END IF;
  INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete) VALUES
    (hr_manager_id, 'employees',   true, true, true, true),
    (hr_manager_id, 'leave',       true, true, true, true),
    (hr_manager_id, 'attendance',  true, true, true, false),
    (hr_manager_id, 'recruitment', true, true, true, true),
    (hr_manager_id, 'payroll',     true, false, false, false)
  ON CONFLICT (permission_group_id, module) DO NOTHING;

  -- Time Off Officer
  SELECT id INTO time_off_officer_id
  FROM public.permission_groups
  WHERE organization_id = p_org_id AND name = 'Time Off Officer' AND is_system = true;
  IF time_off_officer_id IS NULL THEN
    INSERT INTO public.permission_groups (organization_id, name, description, is_system)
    VALUES (p_org_id, 'Time Off Officer', 'Manage leave types, allocations, and approvals. Read-only employee directory.', true)
    RETURNING id INTO time_off_officer_id;
  END IF;
  INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete) VALUES
    (time_off_officer_id, 'employees', true, false, false, false),
    (time_off_officer_id, 'leave',     true, true, true, true)
  ON CONFLICT (permission_group_id, module) DO NOTHING;

  -- Attendance Officer
  SELECT id INTO attendance_officer_id
  FROM public.permission_groups
  WHERE organization_id = p_org_id AND name = 'Attendance Officer' AND is_system = true;
  IF attendance_officer_id IS NULL THEN
    INSERT INTO public.permission_groups (organization_id, name, description, is_system)
    VALUES (p_org_id, 'Attendance Officer', 'Manage attendance records, work schedules, and timesheet approvals. Read-only employee directory.', true)
    RETURNING id INTO attendance_officer_id;
  END IF;
  INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete) VALUES
    (attendance_officer_id, 'employees',  true, false, false, false),
    (attendance_officer_id, 'attendance', true, true, true, true)
  ON CONFLICT (permission_group_id, module) DO NOTHING;
END;
$function$;

-- ===========================================================================
-- New RPC: request_app_notification
-- Used by the "Notify me" button on Coming Soon app tiles. Writes a request
-- row so platform admins can see demand and notify users at launch.
-- No new edge function — pure SQL.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.app_launch_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id UUID,
  app_id TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at TIMESTAMPTZ,
  UNIQUE (user_id, app_id)
);

ALTER TABLE public.app_launch_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage their own notification requests" ON public.app_launch_notifications;
CREATE POLICY "Users manage their own notification requests"
ON public.app_launch_notifications
FOR ALL
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.request_app_notification(p_app_id text, p_org_id uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _row_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE='42501';
  END IF;
  INSERT INTO public.app_launch_notifications (user_id, organization_id, app_id)
  VALUES (auth.uid(), p_org_id, p_app_id)
  ON CONFLICT (user_id, app_id) DO UPDATE SET requested_at = now()
  RETURNING id INTO _row_id;
  RETURN _row_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.request_app_notification(text, uuid) TO authenticated;
