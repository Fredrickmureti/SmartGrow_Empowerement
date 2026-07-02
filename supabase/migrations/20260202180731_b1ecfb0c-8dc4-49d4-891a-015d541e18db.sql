-- ============================================
-- PHASE 1: FINANCE MODULE ENHANCEMENTS
-- ============================================

-- 1. ANALYTIC ACCOUNTING (Cost Centers/Projects)
-- ============================================

-- Create analytic account groups table
CREATE TABLE public.analytic_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create analytic accounts table
CREATE TABLE public.analytic_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  group_id UUID REFERENCES public.analytic_groups(id) ON DELETE SET NULL,
  code VARCHAR(20),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  analytic_type VARCHAR(20) DEFAULT 'cost_center' CHECK (analytic_type IN ('cost_center', 'project', 'department', 'product_line', 'other')),
  is_active BOOLEAN DEFAULT true,
  balance DECIMAL(15,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(organization_id, code)
);

-- Create analytic distributions table (links transactions to analytic accounts)
CREATE TABLE public.analytic_distributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  analytic_account_id UUID NOT NULL REFERENCES public.analytic_accounts(id) ON DELETE CASCADE,
  source_type VARCHAR(50) NOT NULL,
  source_id UUID NOT NULL,
  amount DECIMAL(15,2) NOT NULL,
  percentage DECIMAL(5,2),
  date DATE NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_analytic_distributions_source ON public.analytic_distributions(source_type, source_id);
CREATE INDEX idx_analytic_distributions_account ON public.analytic_distributions(analytic_account_id);
CREATE INDEX idx_analytic_distributions_date ON public.analytic_distributions(date);

-- 2. AUTO DEPRECIATION POSTING
-- ============================================

-- Add GL integration fields to asset categories
ALTER TABLE public.asset_categories 
  ADD COLUMN IF NOT EXISTS gain_loss_account_id UUID REFERENCES public.accounts(id);

-- Create depreciation schedule table for projected depreciation
CREATE TABLE public.depreciation_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  asset_id UUID NOT NULL REFERENCES public.fixed_assets(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  depreciation_amount DECIMAL(15,2) NOT NULL,
  accumulated_depreciation DECIMAL(15,2) NOT NULL,
  book_value DECIMAL(15,2) NOT NULL,
  journal_entry_id UUID REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  is_posted BOOLEAN DEFAULT false,
  posted_at TIMESTAMPTZ,
  posted_by UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(asset_id, period_start)
);

CREATE INDEX idx_depreciation_schedules_asset ON public.depreciation_schedules(asset_id);
CREATE INDEX idx_depreciation_schedules_period ON public.depreciation_schedules(period_start);

-- 3. BUDGET VS ACTUAL TRACKING
-- ============================================

CREATE TABLE public.budget_actuals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  budget_id UUID NOT NULL REFERENCES public.budgets(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  period_month INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  fiscal_year INTEGER NOT NULL,
  actual_amount DECIMAL(15,2) DEFAULT 0,
  calculated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(budget_id, account_id, period_month)
);

CREATE INDEX idx_budget_actuals_budget ON public.budget_actuals(budget_id);

-- 4. REPORT DRILL-DOWN SUPPORT
-- ============================================

ALTER TABLE public.journal_entries 
  ADD COLUMN IF NOT EXISTS drill_down_data JSONB;

ALTER TABLE public.journal_entry_lines 
  ADD COLUMN IF NOT EXISTS analytic_account_id UUID REFERENCES public.analytic_accounts(id);

-- 5. RLS POLICIES
-- ============================================

-- Analytic Groups
ALTER TABLE public.analytic_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "analytic_groups_select" ON public.analytic_groups
  FOR SELECT USING (
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())
  );

CREATE POLICY "analytic_groups_insert" ON public.analytic_groups
  FOR INSERT WITH CHECK (
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())
  );

CREATE POLICY "analytic_groups_update" ON public.analytic_groups
  FOR UPDATE USING (
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())
  );

CREATE POLICY "analytic_groups_delete" ON public.analytic_groups
  FOR DELETE USING (
    organization_id IN (
      SELECT organization_id FROM public.user_roles 
      WHERE user_id = auth.uid() AND role IN ('super_admin', 'owner', 'admin')
    )
  );

-- Analytic Accounts
ALTER TABLE public.analytic_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "analytic_accounts_select" ON public.analytic_accounts
  FOR SELECT USING (
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())
  );

CREATE POLICY "analytic_accounts_insert" ON public.analytic_accounts
  FOR INSERT WITH CHECK (
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())
  );

CREATE POLICY "analytic_accounts_update" ON public.analytic_accounts
  FOR UPDATE USING (
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())
  );

CREATE POLICY "analytic_accounts_delete" ON public.analytic_accounts
  FOR DELETE USING (
    organization_id IN (
      SELECT organization_id FROM public.user_roles 
      WHERE user_id = auth.uid() AND role IN ('super_admin', 'owner', 'admin')
    )
  );

-- Analytic Distributions
ALTER TABLE public.analytic_distributions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "analytic_distributions_select" ON public.analytic_distributions
  FOR SELECT USING (
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())
  );

CREATE POLICY "analytic_distributions_insert" ON public.analytic_distributions
  FOR INSERT WITH CHECK (
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())
  );

CREATE POLICY "analytic_distributions_update" ON public.analytic_distributions
  FOR UPDATE USING (
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())
  );

CREATE POLICY "analytic_distributions_delete" ON public.analytic_distributions
  FOR DELETE USING (
    organization_id IN (
      SELECT organization_id FROM public.user_roles 
      WHERE user_id = auth.uid() AND role IN ('super_admin', 'owner', 'admin')
    )
  );

-- Depreciation Schedules
ALTER TABLE public.depreciation_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "depreciation_schedules_select" ON public.depreciation_schedules
  FOR SELECT USING (
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())
  );

CREATE POLICY "depreciation_schedules_insert" ON public.depreciation_schedules
  FOR INSERT WITH CHECK (
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())
  );

CREATE POLICY "depreciation_schedules_update" ON public.depreciation_schedules
  FOR UPDATE USING (
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())
  );

CREATE POLICY "depreciation_schedules_delete" ON public.depreciation_schedules
  FOR DELETE USING (
    organization_id IN (
      SELECT organization_id FROM public.user_roles 
      WHERE user_id = auth.uid() AND role IN ('super_admin', 'owner', 'admin')
    )
  );

-- Budget Actuals
ALTER TABLE public.budget_actuals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "budget_actuals_select" ON public.budget_actuals
  FOR SELECT USING (
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())
  );

CREATE POLICY "budget_actuals_insert" ON public.budget_actuals
  FOR INSERT WITH CHECK (
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())
  );

CREATE POLICY "budget_actuals_update" ON public.budget_actuals
  FOR UPDATE USING (
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())
  );

CREATE POLICY "budget_actuals_delete" ON public.budget_actuals
  FOR DELETE USING (
    organization_id IN (
      SELECT organization_id FROM public.user_roles 
      WHERE user_id = auth.uid() AND role IN ('super_admin', 'owner', 'admin')
    )
  );

-- 6. UPDATE TRIGGERS
-- ============================================

CREATE OR REPLACE FUNCTION public.update_analytic_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_analytic_groups_timestamp
  BEFORE UPDATE ON public.analytic_groups
  FOR EACH ROW EXECUTE FUNCTION public.update_analytic_timestamp();

CREATE TRIGGER update_analytic_accounts_timestamp
  BEFORE UPDATE ON public.analytic_accounts
  FOR EACH ROW EXECUTE FUNCTION public.update_analytic_timestamp();