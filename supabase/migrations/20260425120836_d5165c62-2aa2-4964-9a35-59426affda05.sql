-- Split the legacy "HR & Payroll" platform app into five Odoo-aligned apps.
-- The legacy `hr` row is kept as a hidden alias (no orgs have installed it,
-- but client-side code still treats it as an alias to `employees`).

-- 1. Hide the legacy hr row from signup but leave it available for back-compat.
UPDATE public.platform_apps
SET is_visible_in_signup = false,
    is_available = false,
    name = 'HR & Payroll (legacy)',
    description = 'Deprecated bundle. Replaced by Employees + Time Off + Attendance + Payroll + Recruitment.'
WHERE id = 'hr';

-- 2. Insert the five new Odoo-aligned HR-domain apps.
--    All sit under the "operations" category, sort orders 80–84 to slot them
--    after CRM (sort 7) and before Projects/Studio.
INSERT INTO public.platform_apps
  (id, name, description, category, required_plan, is_available, is_core, is_visible_in_signup, sort_order)
VALUES
  ('employees',   'Employees',
   'Employee directory, departments, contracts, and people analytics. Foundation for Time Off, Attendance, Payroll, and Recruitment.',
   'operations', 'professional', true, false, true, 80),
  ('time-off',    'Time Off',
   'Leave types, allocations, public holidays, and approvals. Requires Employees.',
   'operations', 'professional', true, false, true, 81),
  ('attendance',  'Attendances',
   'Clock-in oversight, work schedules, and timesheet approvals. Requires Employees.',
   'operations', 'professional', true, false, true, 82),
  ('payroll',     'Payroll',
   'Salary structures, payroll runs, payslips, loans, and statutory remittances. Requires Employees and contracts.',
   'operations', 'professional', true, false, true, 83),
  ('recruitment', 'Recruitment',
   'Job posts, applicants, and hiring pipeline. Coming soon.',
   'operations', 'professional', false, false, true, 84)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  is_available = EXCLUDED.is_available,
  is_visible_in_signup = EXCLUDED.is_visible_in_signup,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- 3. Backfill organization_installed_apps for any org that had the legacy `hr`
--    bundle installed: give them Employees + Time Off + Attendance + Payroll
--    (skip Recruitment — coming soon). Idempotent.
INSERT INTO public.organization_installed_apps
  (organization_id, app_id, installed_at, installed_by, is_active, settings)
SELECT
  oia.organization_id,
  new_app_id,
  oia.installed_at,
  oia.installed_by,
  true,
  '{}'::jsonb
FROM public.organization_installed_apps oia
CROSS JOIN unnest(ARRAY['employees','time-off','attendance','payroll']) AS new_app_id
WHERE oia.app_id = 'hr' AND oia.is_active = true
ON CONFLICT (organization_id, app_id) DO NOTHING;