-- ============================================================================
-- Batch 1: HR domain RBAC granularity (Odoo-aligned)
-- ============================================================================
-- Splits the coarse `hr` permission module into per-app modules
-- (employees, attendance, recruitment) and adds three new system access groups:
-- HR Manager, Time Off Officer, Attendance Officer.
--
-- Legacy `hr` and `timesheets` rules continue to grant access via aliases
-- defined in src/lib/permissions.ts (MODULE_PERMISSION_MAP).
-- ============================================================================

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
  -- ---------------------------------------------------------------------------
  -- Portal User (self-service: leave requests, timesheets, profile)
  -- ---------------------------------------------------------------------------
  SELECT id INTO portal_group_id
  FROM public.permission_groups
  WHERE organization_id = p_org_id AND name = 'Portal User' AND is_system = true;
  IF portal_group_id IS NULL THEN
    INSERT INTO public.permission_groups (organization_id, name, description, is_system)
    VALUES (p_org_id, 'Portal User', 'Self-service access: view payslips, request leave, submit timesheets', true)
    RETURNING id INTO portal_group_id;
  END IF;
  -- Re-assert rule rows (idempotent via UNIQUE (permission_group_id, module))
  INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete) VALUES
    (portal_group_id, 'leave',      true, true, false, false),
    (portal_group_id, 'timesheets', true, true, false, false),
    (portal_group_id, 'attendance', true, true, false, false),
    (portal_group_id, 'projects',   true, false, false, false)
  ON CONFLICT (permission_group_id, module) DO NOTHING;

  -- ---------------------------------------------------------------------------
  -- Internal User (full baseline — everything internal staff can touch)
  -- ---------------------------------------------------------------------------
  SELECT id INTO internal_group_id
  FROM public.permission_groups
  WHERE organization_id = p_org_id AND name = 'Internal User' AND is_system = true;
  IF internal_group_id IS NULL THEN
    INSERT INTO public.permission_groups (organization_id, name, description, is_system)
    VALUES (p_org_id, 'Internal User', 'Default group for internal staff. Grants base role permissions.', true)
    RETURNING id INTO internal_group_id;
  END IF;
  INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete) VALUES
    (internal_group_id, 'contacts',    true, true, true, true),
    (internal_group_id, 'products',    true, true, true, true),
    (internal_group_id, 'sales',       true, true, true, true),
    (internal_group_id, 'purchases',   true, true, true, true),
    (internal_group_id, 'financials',  true, true, true, true),
    (internal_group_id, 'employees',   true, true, true, true),
    (internal_group_id, 'leave',       true, true, true, true),
    (internal_group_id, 'attendance',  true, true, true, true),
    (internal_group_id, 'recruitment', true, true, true, true),
    (internal_group_id, 'projects',    true, true, true, true),
    (internal_group_id, 'payroll',     true, true, true, true),
    (internal_group_id, 'pos',         true, true, true, true),
    (internal_group_id, 'settings',    true, true, true, true),
    (internal_group_id, 'team',        true, true, true, true)
  ON CONFLICT (permission_group_id, module) DO NOTHING;

  -- ---------------------------------------------------------------------------
  -- Payroll Admin (full payroll lifecycle, read employees/attendance)
  -- ---------------------------------------------------------------------------
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

  -- ---------------------------------------------------------------------------
  -- Payroll Officer (preview/draft only — no approve/post/reverse)
  -- ---------------------------------------------------------------------------
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

  -- ---------------------------------------------------------------------------
  -- Accountant (financials + read-only payroll for GL posting)
  -- ---------------------------------------------------------------------------
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

  -- ---------------------------------------------------------------------------
  -- HR Manager (NEW — Odoo `hr.group_hr_manager` equivalent)
  -- Full Employees + Time Off + Recruitment, read-only Payroll, approve timesheets.
  -- ---------------------------------------------------------------------------
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

  -- ---------------------------------------------------------------------------
  -- Time Off Officer (NEW — Odoo `hr_holidays.group_hr_holidays_manager` equivalent)
  -- ---------------------------------------------------------------------------
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

  -- ---------------------------------------------------------------------------
  -- Attendance Officer (NEW — Odoo `hr_attendance.group_hr_attendance_manager` equivalent)
  -- ---------------------------------------------------------------------------
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

-- ============================================================================
-- Backfill: re-run seeder for every existing organization so the three new
-- system groups (HR Manager / Time Off Officer / Attendance Officer) appear
-- and existing groups (Payroll Admin/Officer/Internal) gain the new module rows.
-- ============================================================================
DO $$
DECLARE
  org RECORD;
BEGIN
  FOR org IN SELECT id FROM public.organizations LOOP
    PERFORM public.seed_default_permission_groups(org.id);
  END LOOP;
END $$;
