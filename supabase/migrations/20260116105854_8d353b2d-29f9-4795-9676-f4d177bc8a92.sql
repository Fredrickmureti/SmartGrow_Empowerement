-- =====================================================
-- HELPER FUNCTION FIRST
-- =====================================================
CREATE OR REPLACE FUNCTION public.get_user_organization_ids()
RETURNS UUID[] AS $$
  SELECT ARRAY_AGG(organization_id) 
  FROM public.user_roles 
  WHERE user_id = auth.uid() AND is_active = true
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- =====================================================
-- PAYROLL MODULE SCHEMA
-- =====================================================

-- Employees table
CREATE TABLE public.employees (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_number TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  national_id TEXT,
  tax_pin TEXT,
  nssf_number TEXT,
  nhif_number TEXT,
  hire_date DATE NOT NULL,
  termination_date DATE,
  department TEXT,
  position TEXT,
  employment_type TEXT DEFAULT 'full_time',
  bank_name TEXT,
  bank_branch TEXT,
  bank_account_number TEXT,
  bank_code TEXT,
  basic_salary NUMERIC(15,2) DEFAULT 0,
  housing_allowance NUMERIC(15,2) DEFAULT 0,
  transport_allowance NUMERIC(15,2) DEFAULT 0,
  other_allowances JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_by UUID REFERENCES auth.users(id),
  UNIQUE(organization_id, employee_number)
);

-- Payroll runs
CREATE TABLE public.payroll_runs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  payroll_number TEXT NOT NULL,
  pay_period_start DATE NOT NULL,
  pay_period_end DATE NOT NULL,
  payment_date DATE,
  status TEXT DEFAULT 'draft',
  total_gross NUMERIC(15,2) DEFAULT 0,
  total_paye NUMERIC(15,2) DEFAULT 0,
  total_nssf NUMERIC(15,2) DEFAULT 0,
  total_nhif NUMERIC(15,2) DEFAULT 0,
  total_other_deductions NUMERIC(15,2) DEFAULT 0,
  total_net NUMERIC(15,2) DEFAULT 0,
  employee_count INTEGER DEFAULT 0,
  notes TEXT,
  approved_by UUID REFERENCES auth.users(id),
  approved_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_by UUID REFERENCES auth.users(id),
  UNIQUE(organization_id, payroll_number)
);

-- Payslips
CREATE TABLE public.payslips (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  payroll_run_id UUID NOT NULL REFERENCES public.payroll_runs(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  basic_salary NUMERIC(15,2) DEFAULT 0,
  housing_allowance NUMERIC(15,2) DEFAULT 0,
  transport_allowance NUMERIC(15,2) DEFAULT 0,
  overtime_pay NUMERIC(15,2) DEFAULT 0,
  bonus NUMERIC(15,2) DEFAULT 0,
  other_earnings JSONB DEFAULT '{}',
  gross_pay NUMERIC(15,2) DEFAULT 0,
  paye NUMERIC(15,2) DEFAULT 0,
  nssf_employee NUMERIC(15,2) DEFAULT 0,
  nssf_employer NUMERIC(15,2) DEFAULT 0,
  nhif NUMERIC(15,2) DEFAULT 0,
  housing_levy NUMERIC(15,2) DEFAULT 0,
  other_deductions JSONB DEFAULT '{}',
  total_deductions NUMERIC(15,2) DEFAULT 0,
  net_pay NUMERIC(15,2) DEFAULT 0,
  taxable_income NUMERIC(15,2) DEFAULT 0,
  personal_relief NUMERIC(15,2) DEFAULT 2400,
  insurance_relief NUMERIC(15,2) DEFAULT 0,
  status TEXT DEFAULT 'pending',
  paid_at TIMESTAMP WITH TIME ZONE,
  payment_reference TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Statutory rates
CREATE TABLE public.payroll_statutory_rates (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  country_code TEXT DEFAULT 'KE',
  effective_date DATE NOT NULL,
  paye_brackets JSONB DEFAULT '[{"min":0,"max":24000,"rate":10},{"min":24001,"max":32333,"rate":25},{"min":32334,"max":500000,"rate":30},{"min":500001,"max":800000,"rate":32.5},{"min":800001,"max":null,"rate":35}]',
  nssf_tier1_limit NUMERIC(15,2) DEFAULT 7000,
  nssf_tier2_limit NUMERIC(15,2) DEFAULT 36000,
  nssf_rate NUMERIC(5,2) DEFAULT 6,
  nhif_rates JSONB DEFAULT '[{"min":0,"max":5999,"amount":150},{"min":6000,"max":7999,"amount":300},{"min":8000,"max":11999,"amount":400},{"min":12000,"max":14999,"amount":500},{"min":15000,"max":19999,"amount":600},{"min":20000,"max":24999,"amount":750},{"min":25000,"max":29999,"amount":850},{"min":30000,"max":34999,"amount":900},{"min":35000,"max":39999,"amount":950},{"min":40000,"max":44999,"amount":1000},{"min":45000,"max":49999,"amount":1100},{"min":50000,"max":59999,"amount":1200},{"min":60000,"max":69999,"amount":1300},{"min":70000,"max":79999,"amount":1400},{"min":80000,"max":89999,"amount":1500},{"min":90000,"max":99999,"amount":1600},{"min":100000,"max":null,"amount":1700}]',
  housing_levy_rate NUMERIC(5,2) DEFAULT 1.5,
  personal_relief NUMERIC(15,2) DEFAULT 2400,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Asset categories
CREATE TABLE public.asset_categories (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  depreciation_method TEXT DEFAULT 'straight_line',
  useful_life_years INTEGER DEFAULT 5,
  depreciation_rate NUMERIC(5,2),
  asset_account_id UUID REFERENCES public.accounts(id),
  depreciation_account_id UUID REFERENCES public.accounts(id),
  accumulated_depreciation_account_id UUID REFERENCES public.accounts(id),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Fixed assets
CREATE TABLE public.fixed_assets (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  category_id UUID REFERENCES public.asset_categories(id),
  asset_number TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  purchase_date DATE NOT NULL,
  purchase_price NUMERIC(15,2) NOT NULL,
  vendor_id UUID REFERENCES public.contacts(id),
  invoice_reference TEXT,
  branch_id UUID REFERENCES public.branches(id),
  location TEXT,
  assigned_to UUID REFERENCES public.employees(id),
  depreciation_method TEXT DEFAULT 'straight_line',
  useful_life_years INTEGER DEFAULT 5,
  residual_value NUMERIC(15,2) DEFAULT 0,
  depreciation_start_date DATE,
  accumulated_depreciation NUMERIC(15,2) DEFAULT 0,
  book_value NUMERIC(15,2),
  status TEXT DEFAULT 'active',
  disposal_date DATE,
  disposal_price NUMERIC(15,2),
  disposal_reason TEXT,
  serial_number TEXT,
  barcode TEXT,
  insurance_value NUMERIC(15,2),
  insurance_policy TEXT,
  insurance_expiry DATE,
  warranty_expiry DATE,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_by UUID REFERENCES auth.users(id),
  UNIQUE(organization_id, asset_number)
);

-- Depreciation entries
CREATE TABLE public.depreciation_entries (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  asset_id UUID NOT NULL REFERENCES public.fixed_assets(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  depreciation_amount NUMERIC(15,2) NOT NULL,
  accumulated_depreciation NUMERIC(15,2) NOT NULL,
  book_value NUMERIC(15,2) NOT NULL,
  journal_entry_id UUID REFERENCES public.journal_entries(id),
  is_posted BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Asset maintenance
CREATE TABLE public.asset_maintenance (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  asset_id UUID NOT NULL REFERENCES public.fixed_assets(id) ON DELETE CASCADE,
  maintenance_date DATE NOT NULL,
  maintenance_type TEXT,
  description TEXT,
  cost NUMERIC(15,2) DEFAULT 0,
  vendor_id UUID REFERENCES public.contacts(id),
  next_maintenance_date DATE,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_by UUID REFERENCES auth.users(id)
);

-- Warehouses
CREATE TABLE public.warehouses (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES public.branches(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT,
  city TEXT,
  country TEXT,
  manager_name TEXT,
  manager_email TEXT,
  manager_phone TEXT,
  is_default BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(organization_id, code)
);

-- Warehouse stock
CREATE TABLE public.warehouse_stock (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  quantity NUMERIC(15,3) DEFAULT 0,
  reserved_quantity NUMERIC(15,3) DEFAULT 0,
  reorder_level NUMERIC(15,3),
  reorder_quantity NUMERIC(15,3),
  bin_location TEXT,
  last_counted_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(warehouse_id, product_id)
);

-- Stock transfers
CREATE TABLE public.stock_transfers (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  transfer_number TEXT NOT NULL,
  from_warehouse_id UUID NOT NULL REFERENCES public.warehouses(id),
  to_warehouse_id UUID NOT NULL REFERENCES public.warehouses(id),
  status TEXT DEFAULT 'draft',
  transfer_date DATE NOT NULL,
  expected_arrival_date DATE,
  actual_arrival_date DATE,
  notes TEXT,
  requested_by UUID REFERENCES auth.users(id),
  approved_by UUID REFERENCES auth.users(id),
  approved_at TIMESTAMP WITH TIME ZONE,
  completed_by UUID REFERENCES auth.users(id),
  completed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(organization_id, transfer_number)
);

-- Stock transfer items
CREATE TABLE public.stock_transfer_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  transfer_id UUID NOT NULL REFERENCES public.stock_transfers(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id),
  quantity_requested NUMERIC(15,3) NOT NULL,
  quantity_sent NUMERIC(15,3),
  quantity_received NUMERIC(15,3),
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Approval workflows
CREATE TABLE public.approval_workflows (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  conditions JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Approval workflow steps
CREATE TABLE public.approval_workflow_steps (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workflow_id UUID NOT NULL REFERENCES public.approval_workflows(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  role TEXT,
  approver_id UUID REFERENCES auth.users(id),
  is_required BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Approval requests
CREATE TABLE public.approval_requests (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  workflow_id UUID REFERENCES public.approval_workflows(id),
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  entity_reference TEXT,
  current_step INTEGER DEFAULT 1,
  status TEXT DEFAULT 'pending',
  requested_by UUID REFERENCES auth.users(id),
  requested_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  completed_at TIMESTAMP WITH TIME ZONE,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Approval history
CREATE TABLE public.approval_history (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES public.approval_requests(id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,
  action TEXT NOT NULL,
  approved_by UUID REFERENCES auth.users(id),
  approved_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  comments TEXT
);

-- Enable RLS
ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payslips ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_statutory_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fixed_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.depreciation_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_maintenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warehouses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warehouse_stock ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_transfer_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_workflow_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_history ENABLE ROW LEVEL SECURITY;

-- RLS Policies for all tables
CREATE POLICY "org_employees_select" ON public.employees FOR SELECT USING (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_employees_insert" ON public.employees FOR INSERT WITH CHECK (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_employees_update" ON public.employees FOR UPDATE USING (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_employees_delete" ON public.employees FOR DELETE USING (organization_id = ANY(get_user_organization_ids()));

CREATE POLICY "org_payroll_runs_select" ON public.payroll_runs FOR SELECT USING (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_payroll_runs_insert" ON public.payroll_runs FOR INSERT WITH CHECK (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_payroll_runs_update" ON public.payroll_runs FOR UPDATE USING (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_payroll_runs_delete" ON public.payroll_runs FOR DELETE USING (organization_id = ANY(get_user_organization_ids()));

CREATE POLICY "org_payslips_select" ON public.payslips FOR SELECT USING (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_payslips_insert" ON public.payslips FOR INSERT WITH CHECK (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_payslips_update" ON public.payslips FOR UPDATE USING (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_payslips_delete" ON public.payslips FOR DELETE USING (organization_id = ANY(get_user_organization_ids()));

CREATE POLICY "org_statutory_rates_select" ON public.payroll_statutory_rates FOR SELECT USING (organization_id IS NULL OR organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_statutory_rates_insert" ON public.payroll_statutory_rates FOR INSERT WITH CHECK (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_statutory_rates_update" ON public.payroll_statutory_rates FOR UPDATE USING (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_statutory_rates_delete" ON public.payroll_statutory_rates FOR DELETE USING (organization_id = ANY(get_user_organization_ids()));

CREATE POLICY "org_asset_categories_select" ON public.asset_categories FOR SELECT USING (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_asset_categories_insert" ON public.asset_categories FOR INSERT WITH CHECK (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_asset_categories_update" ON public.asset_categories FOR UPDATE USING (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_asset_categories_delete" ON public.asset_categories FOR DELETE USING (organization_id = ANY(get_user_organization_ids()));

CREATE POLICY "org_fixed_assets_select" ON public.fixed_assets FOR SELECT USING (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_fixed_assets_insert" ON public.fixed_assets FOR INSERT WITH CHECK (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_fixed_assets_update" ON public.fixed_assets FOR UPDATE USING (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_fixed_assets_delete" ON public.fixed_assets FOR DELETE USING (organization_id = ANY(get_user_organization_ids()));

CREATE POLICY "org_depreciation_entries_select" ON public.depreciation_entries FOR SELECT USING (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_depreciation_entries_insert" ON public.depreciation_entries FOR INSERT WITH CHECK (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_depreciation_entries_update" ON public.depreciation_entries FOR UPDATE USING (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_depreciation_entries_delete" ON public.depreciation_entries FOR DELETE USING (organization_id = ANY(get_user_organization_ids()));

CREATE POLICY "org_asset_maintenance_select" ON public.asset_maintenance FOR SELECT USING (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_asset_maintenance_insert" ON public.asset_maintenance FOR INSERT WITH CHECK (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_asset_maintenance_update" ON public.asset_maintenance FOR UPDATE USING (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_asset_maintenance_delete" ON public.asset_maintenance FOR DELETE USING (organization_id = ANY(get_user_organization_ids()));

CREATE POLICY "org_warehouses_select" ON public.warehouses FOR SELECT USING (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_warehouses_insert" ON public.warehouses FOR INSERT WITH CHECK (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_warehouses_update" ON public.warehouses FOR UPDATE USING (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_warehouses_delete" ON public.warehouses FOR DELETE USING (organization_id = ANY(get_user_organization_ids()));

CREATE POLICY "org_warehouse_stock_select" ON public.warehouse_stock FOR SELECT USING (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_warehouse_stock_insert" ON public.warehouse_stock FOR INSERT WITH CHECK (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_warehouse_stock_update" ON public.warehouse_stock FOR UPDATE USING (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_warehouse_stock_delete" ON public.warehouse_stock FOR DELETE USING (organization_id = ANY(get_user_organization_ids()));

CREATE POLICY "org_stock_transfers_select" ON public.stock_transfers FOR SELECT USING (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_stock_transfers_insert" ON public.stock_transfers FOR INSERT WITH CHECK (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_stock_transfers_update" ON public.stock_transfers FOR UPDATE USING (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_stock_transfers_delete" ON public.stock_transfers FOR DELETE USING (organization_id = ANY(get_user_organization_ids()));

CREATE POLICY "org_stock_transfer_items_select" ON public.stock_transfer_items FOR SELECT USING (EXISTS (SELECT 1 FROM public.stock_transfers t WHERE t.id = transfer_id AND t.organization_id = ANY(get_user_organization_ids())));
CREATE POLICY "org_stock_transfer_items_insert" ON public.stock_transfer_items FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM public.stock_transfers t WHERE t.id = transfer_id AND t.organization_id = ANY(get_user_organization_ids())));
CREATE POLICY "org_stock_transfer_items_update" ON public.stock_transfer_items FOR UPDATE USING (EXISTS (SELECT 1 FROM public.stock_transfers t WHERE t.id = transfer_id AND t.organization_id = ANY(get_user_organization_ids())));
CREATE POLICY "org_stock_transfer_items_delete" ON public.stock_transfer_items FOR DELETE USING (EXISTS (SELECT 1 FROM public.stock_transfers t WHERE t.id = transfer_id AND t.organization_id = ANY(get_user_organization_ids())));

CREATE POLICY "org_approval_workflows_select" ON public.approval_workflows FOR SELECT USING (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_approval_workflows_insert" ON public.approval_workflows FOR INSERT WITH CHECK (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_approval_workflows_update" ON public.approval_workflows FOR UPDATE USING (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_approval_workflows_delete" ON public.approval_workflows FOR DELETE USING (organization_id = ANY(get_user_organization_ids()));

CREATE POLICY "org_approval_workflow_steps_select" ON public.approval_workflow_steps FOR SELECT USING (EXISTS (SELECT 1 FROM public.approval_workflows w WHERE w.id = workflow_id AND w.organization_id = ANY(get_user_organization_ids())));
CREATE POLICY "org_approval_workflow_steps_insert" ON public.approval_workflow_steps FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM public.approval_workflows w WHERE w.id = workflow_id AND w.organization_id = ANY(get_user_organization_ids())));
CREATE POLICY "org_approval_workflow_steps_update" ON public.approval_workflow_steps FOR UPDATE USING (EXISTS (SELECT 1 FROM public.approval_workflows w WHERE w.id = workflow_id AND w.organization_id = ANY(get_user_organization_ids())));
CREATE POLICY "org_approval_workflow_steps_delete" ON public.approval_workflow_steps FOR DELETE USING (EXISTS (SELECT 1 FROM public.approval_workflows w WHERE w.id = workflow_id AND w.organization_id = ANY(get_user_organization_ids())));

CREATE POLICY "org_approval_requests_select" ON public.approval_requests FOR SELECT USING (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_approval_requests_insert" ON public.approval_requests FOR INSERT WITH CHECK (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_approval_requests_update" ON public.approval_requests FOR UPDATE USING (organization_id = ANY(get_user_organization_ids()));
CREATE POLICY "org_approval_requests_delete" ON public.approval_requests FOR DELETE USING (organization_id = ANY(get_user_organization_ids()));

CREATE POLICY "org_approval_history_select" ON public.approval_history FOR SELECT USING (EXISTS (SELECT 1 FROM public.approval_requests r WHERE r.id = request_id AND r.organization_id = ANY(get_user_organization_ids())));
CREATE POLICY "org_approval_history_insert" ON public.approval_history FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM public.approval_requests r WHERE r.id = request_id AND r.organization_id = ANY(get_user_organization_ids())));

-- Helper functions
CREATE OR REPLACE FUNCTION public.get_next_payroll_number(_org_id UUID) RETURNS TEXT AS $$
DECLARE next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(CAST(SUBSTRING(payroll_number FROM '[0-9]+$') AS INTEGER)), 0) + 1 INTO next_num FROM public.payroll_runs WHERE organization_id = _org_id;
  RETURN 'PAY-' || LPAD(next_num::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.get_next_employee_number(_org_id UUID) RETURNS TEXT AS $$
DECLARE next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(CAST(SUBSTRING(employee_number FROM '[0-9]+$') AS INTEGER)), 0) + 1 INTO next_num FROM public.employees WHERE organization_id = _org_id;
  RETURN 'EMP-' || LPAD(next_num::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.get_next_asset_number(_org_id UUID) RETURNS TEXT AS $$
DECLARE next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(CAST(SUBSTRING(asset_number FROM '[0-9]+$') AS INTEGER)), 0) + 1 INTO next_num FROM public.fixed_assets WHERE organization_id = _org_id;
  RETURN 'AST-' || LPAD(next_num::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.get_next_transfer_number(_org_id UUID) RETURNS TEXT AS $$
DECLARE next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(CAST(SUBSTRING(transfer_number FROM '[0-9]+$') AS INTEGER)), 0) + 1 INTO next_num FROM public.stock_transfers WHERE organization_id = _org_id;
  RETURN 'TRF-' || LPAD(next_num::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Kenya statutory calculation functions
CREATE OR REPLACE FUNCTION public.calculate_kenya_paye(_gross_income NUMERIC, _personal_relief NUMERIC DEFAULT 2400, _insurance_relief NUMERIC DEFAULT 0) RETURNS NUMERIC AS $$
DECLARE paye NUMERIC := 0; remaining NUMERIC;
BEGIN
  remaining := _gross_income;
  IF remaining > 0 THEN IF remaining <= 24000 THEN paye := paye + (remaining * 0.10); remaining := 0; ELSE paye := paye + (24000 * 0.10); remaining := remaining - 24000; END IF; END IF;
  IF remaining > 0 THEN IF remaining <= 8333 THEN paye := paye + (remaining * 0.25); remaining := 0; ELSE paye := paye + (8333 * 0.25); remaining := remaining - 8333; END IF; END IF;
  IF remaining > 0 THEN IF remaining <= 467667 THEN paye := paye + (remaining * 0.30); remaining := 0; ELSE paye := paye + (467667 * 0.30); remaining := remaining - 467667; END IF; END IF;
  IF remaining > 0 THEN IF remaining <= 300000 THEN paye := paye + (remaining * 0.325); remaining := 0; ELSE paye := paye + (300000 * 0.325); remaining := remaining - 300000; END IF; END IF;
  IF remaining > 0 THEN paye := paye + (remaining * 0.35); END IF;
  paye := paye - _personal_relief - _insurance_relief;
  IF paye < 0 THEN paye := 0; END IF;
  RETURN ROUND(paye, 2);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.calculate_kenya_nhif(_gross_income NUMERIC) RETURNS NUMERIC AS $$
BEGIN
  RETURN CASE
    WHEN _gross_income <= 5999 THEN 150 WHEN _gross_income <= 7999 THEN 300 WHEN _gross_income <= 11999 THEN 400 WHEN _gross_income <= 14999 THEN 500
    WHEN _gross_income <= 19999 THEN 600 WHEN _gross_income <= 24999 THEN 750 WHEN _gross_income <= 29999 THEN 850 WHEN _gross_income <= 34999 THEN 900
    WHEN _gross_income <= 39999 THEN 950 WHEN _gross_income <= 44999 THEN 1000 WHEN _gross_income <= 49999 THEN 1100 WHEN _gross_income <= 59999 THEN 1200
    WHEN _gross_income <= 69999 THEN 1300 WHEN _gross_income <= 79999 THEN 1400 WHEN _gross_income <= 89999 THEN 1500 WHEN _gross_income <= 99999 THEN 1600
    ELSE 1700
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.calculate_kenya_nssf(_gross_income NUMERIC) RETURNS TABLE(employee_contribution NUMERIC, employer_contribution NUMERIC) AS $$
DECLARE tier1_limit NUMERIC := 7000; tier2_limit NUMERIC := 36000; nssf_rate NUMERIC := 0.06; tier1_amount NUMERIC; tier2_amount NUMERIC; total_contribution NUMERIC;
BEGIN
  tier1_amount := LEAST(_gross_income, tier1_limit) * nssf_rate;
  IF _gross_income > tier1_limit THEN tier2_amount := (LEAST(_gross_income, tier2_limit) - tier1_limit) * nssf_rate; ELSE tier2_amount := 0; END IF;
  total_contribution := tier1_amount + tier2_amount;
  employee_contribution := ROUND(total_contribution, 2); employer_contribution := ROUND(total_contribution, 2);
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Insert default Kenya statutory rates
INSERT INTO public.payroll_statutory_rates (organization_id, country_code, effective_date, is_active) VALUES (NULL, 'KE', '2024-01-01', true);

-- Triggers for updated_at
CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER update_employees_updated_at BEFORE UPDATE ON public.employees FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_payroll_runs_updated_at BEFORE UPDATE ON public.payroll_runs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_payslips_updated_at BEFORE UPDATE ON public.payslips FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_asset_categories_updated_at BEFORE UPDATE ON public.asset_categories FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_fixed_assets_updated_at BEFORE UPDATE ON public.fixed_assets FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_warehouses_updated_at BEFORE UPDATE ON public.warehouses FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_warehouse_stock_updated_at BEFORE UPDATE ON public.warehouse_stock FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_stock_transfers_updated_at BEFORE UPDATE ON public.stock_transfers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_approval_workflows_updated_at BEFORE UPDATE ON public.approval_workflows FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();