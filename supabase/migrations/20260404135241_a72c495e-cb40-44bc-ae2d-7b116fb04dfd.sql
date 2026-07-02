-- Expand rls_check_org_can_write INSERT policies to remaining business tables

CREATE POLICY "Subscription active check for insert on purchase_orders"
  ON public.purchase_orders FOR INSERT TO authenticated
  WITH CHECK (public.rls_check_org_can_write(organization_id));

CREATE POLICY "Subscription active check for insert on sales_orders"
  ON public.sales_orders FOR INSERT TO authenticated
  WITH CHECK (public.rls_check_org_can_write(organization_id));

CREATE POLICY "Subscription active check for insert on delivery_notes"
  ON public.delivery_notes FOR INSERT TO authenticated
  WITH CHECK (public.rls_check_org_can_write(organization_id));

CREATE POLICY "Subscription active check for insert on credit_notes"
  ON public.credit_notes FOR INSERT TO authenticated
  WITH CHECK (public.rls_check_org_can_write(organization_id));

CREATE POLICY "Subscription active check for insert on estimates"
  ON public.estimates FOR INSERT TO authenticated
  WITH CHECK (public.rls_check_org_can_write(organization_id));

CREATE POLICY "Subscription active check for insert on proforma_invoices"
  ON public.proforma_invoices FOR INSERT TO authenticated
  WITH CHECK (public.rls_check_org_can_write(organization_id));

CREATE POLICY "Subscription active check for insert on recurring_invoices"
  ON public.recurring_invoices FOR INSERT TO authenticated
  WITH CHECK (public.rls_check_org_can_write(organization_id));

CREATE POLICY "Subscription active check for insert on pos_transactions"
  ON public.pos_transactions FOR INSERT TO authenticated
  WITH CHECK (public.rls_check_org_can_write(organization_id));

CREATE POLICY "Subscription active check for insert on pos_sessions"
  ON public.pos_sessions FOR INSERT TO authenticated
  WITH CHECK (public.rls_check_org_can_write(organization_id));

CREATE POLICY "Subscription active check for insert on payroll_runs"
  ON public.payroll_runs FOR INSERT TO authenticated
  WITH CHECK (public.rls_check_org_can_write(organization_id));

CREATE POLICY "Subscription active check for insert on payslips"
  ON public.payslips FOR INSERT TO authenticated
  WITH CHECK (public.rls_check_org_can_write(organization_id));

CREATE POLICY "Subscription active check for insert on employees"
  ON public.employees FOR INSERT TO authenticated
  WITH CHECK (public.rls_check_org_can_write(organization_id));

CREATE POLICY "Subscription active check for insert on leave_requests"
  ON public.leave_requests FOR INSERT TO authenticated
  WITH CHECK (public.rls_check_org_can_write(organization_id));

CREATE POLICY "Subscription active check for insert on leave_allocations"
  ON public.leave_allocations FOR INSERT TO authenticated
  WITH CHECK (public.rls_check_org_can_write(organization_id));

CREATE POLICY "Subscription active check for insert on fixed_assets"
  ON public.fixed_assets FOR INSERT TO authenticated
  WITH CHECK (public.rls_check_org_can_write(organization_id));

CREATE POLICY "Subscription active check for insert on bank_transactions"
  ON public.bank_transactions FOR INSERT TO authenticated
  WITH CHECK (public.rls_check_org_can_write(organization_id));

CREATE POLICY "Subscription active check for insert on documents"
  ON public.documents FOR INSERT TO authenticated
  WITH CHECK (public.rls_check_org_can_write(organization_id));

CREATE POLICY "Subscription active check for insert on sales_returns"
  ON public.sales_returns FOR INSERT TO authenticated
  WITH CHECK (public.rls_check_org_can_write(organization_id));

-- platform_feature_catalog table
CREATE TABLE IF NOT EXISTS public.platform_feature_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_key TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.platform_feature_catalog ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read feature catalog"
  ON public.platform_feature_catalog FOR SELECT TO authenticated USING (true);

INSERT INTO public.platform_feature_catalog (feature_key, label, category, sort_order) VALUES
  ('estimates', 'Estimates & Quotes', 'core', 1),
  ('credit_notes', 'Credit Notes', 'core', 2),
  ('recurring_invoices', 'Recurring Invoices', 'core', 3),
  ('purchase_orders', 'Purchase Orders', 'core', 4),
  ('inventory', 'Inventory Management', 'core', 5),
  ('pos', 'POS Access', 'pos', 1),
  ('reports_sales', 'Sales Reports', 'reports', 1),
  ('reports_financial', 'Financial Reports', 'reports', 2),
  ('reports_management', 'Management Reports', 'reports', 3),
  ('reports_tax', 'Tax Reports', 'reports', 4),
  ('reports_stock', 'Stock Reports', 'reports', 5),
  ('banking', 'Banking & Bank Feeds', 'advanced', 1),
  ('ai_assistant', 'AI Assistant', 'advanced', 2),
  ('multi_currency', 'Multi-Currency', 'advanced', 3),
  ('budgets', 'Budgets', 'advanced', 4),
  ('journal_entries', 'Journal Entries', 'advanced', 5),
  ('audit_logs', 'Audit Logs', 'advanced', 6),
  ('payroll', 'Payroll', 'operations', 1),
  ('employees', 'HR & Employees', 'operations', 2),
  ('fixed_assets', 'Fixed Assets', 'operations', 3),
  ('warehouses', 'Multi-Warehouse Management', 'operations', 4),
  ('sales_orders', 'Sales Orders', 'sales', 1),
  ('delivery_notes', 'Delivery Notes', 'sales', 2),
  ('proforma_invoices', 'Proforma Invoices', 'sales', 3),
  ('sales_returns', 'Sales Returns', 'sales', 4),
  ('bills', 'Bills & Payables', 'purchasing', 1),
  ('purchase_returns', 'Purchase Returns', 'purchasing', 2),
  ('business_intelligence', 'Business Intelligence', 'intelligence', 1),
  ('customer_statements', 'Customer Statements', 'intelligence', 2),
  ('max_organizations', 'Max Organizations per Account', 'limits', 1),
  ('max_invoices', 'Max Invoices/Month', 'limits', 2),
  ('max_users', 'Max Team Members', 'limits', 3),
  ('max_businesses', 'Max Businesses per Org', 'limits', 4),
  ('max_branches', 'Max Branches per Business', 'limits', 5),
  ('hr', 'HR App Access', 'erp', 1),
  ('crm', 'CRM & Sales Pipeline', 'erp', 2),
  ('projects', 'Project Management', 'erp', 3),
  ('timesheets', 'Timesheets', 'erp', 4),
  ('leave', 'Leave Management', 'erp', 5),
  ('team_management', 'Team Management', 'extras', 1),
  ('api_access', 'API Access', 'extras', 2),
  ('custom_branding', 'Custom Branding', 'extras', 3)
ON CONFLICT (feature_key) DO NOTHING;

-- platform_admin_alerts table
CREATE TABLE IF NOT EXISTS public.platform_admin_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  details JSONB,
  organization_id UUID REFERENCES public.organizations(id),
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.platform_admin_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read admin alerts"
  ON public.platform_admin_alerts FOR SELECT TO authenticated USING (true);