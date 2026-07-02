
-- Platform Apps catalog: admin-controlled app availability
CREATE TABLE public.platform_apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'core',
  required_plan TEXT NOT NULL DEFAULT 'starter',
  is_available BOOLEAN NOT NULL DEFAULT true,
  is_free_trial BOOLEAN NOT NULL DEFAULT false,
  trial_days INTEGER DEFAULT 14,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_core BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.platform_apps ENABLE ROW LEVEL SECURITY;

-- Everyone can read available apps (needed during signup)
CREATE POLICY "Anyone can view available apps"
  ON public.platform_apps FOR SELECT
  USING (true);

-- Only super_admins can manage apps (platform-level admin)
CREATE POLICY "Platform admins can manage apps"
  ON public.platform_apps FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
        AND role = 'super_admin'
        AND is_active = true
    )
  );

-- Seed with all current apps from the registry
INSERT INTO public.platform_apps (id, name, description, category, required_plan, is_available, is_core, sort_order) VALUES
  ('finance', 'Finance', 'Accounting, banking, and financial reports', 'core', 'starter', true, true, 1),
  ('sales', 'Sales', 'Invoicing, quotes, orders, and customer payments', 'core', 'starter', true, true, 2),
  ('contacts', 'Contacts', 'Manage customers, suppliers, and all contacts', 'core', 'starter', true, false, 3),
  ('purchases', 'Purchases', 'Bills, expenses, and supplier management', 'core', 'starter', true, true, 4),
  ('inventory', 'Inventory', 'Products, stock levels, and warehouse management', 'operations', 'starter', true, false, 5),
  ('pos', 'Point of Sale', 'Retail sales, terminal operations, and cash management', 'operations', 'professional', true, false, 6),
  ('crm', 'CRM', 'Pipeline, leads, and customer activities', 'operations', 'professional', true, false, 7),
  ('hr', 'HR & Payroll', 'Employees, leave management, and payroll', 'operations', 'professional', true, false, 8),
  ('projects', 'Projects', 'Project management, tasks, and time tracking', 'operations', 'professional', true, false, 9),
  ('studio', 'Studio', 'Customize fields, forms, automations, and report scheduling', 'operations', 'starter', true, false, 15),
  ('documents', 'Documents', 'Create and manage documents', 'productivity', 'starter', true, false, 11),
  ('sign', 'Sign', 'Create and manage signature requests', 'productivity', 'starter', true, false, 12),
  ('spreadsheets', 'Spreadsheets', 'Create and manage spreadsheets', 'productivity', 'starter', true, false, 13),
  ('sms', 'Twilio SMS', 'SMS notifications via Twilio (Bring Your Own Account)', 'integrations', 'starter', true, false, 20),
  ('platform', 'Settings', 'Organization settings, team management, and configuration', 'platform', 'starter', true, true, 100),
  ('reports', 'Reports', 'Financial reports, analytics, and business intelligence', 'analytics', 'starter', true, false, 10);

-- Timestamp trigger
CREATE TRIGGER update_platform_apps_updated_at
  BEFORE UPDATE ON public.platform_apps
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
