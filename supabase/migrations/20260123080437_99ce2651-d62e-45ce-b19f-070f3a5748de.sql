-- =====================================================
-- PHASE 1: BOOKKEEPING FOUNDATION - GL ARCHITECTURE
-- =====================================================

-- 1. Fiscal Period Management Table
CREATE TABLE public.fiscal_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  period_type TEXT NOT NULL CHECK (period_type IN ('month', 'quarter', 'year')),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closing', 'closed')),
  locked_at TIMESTAMPTZ,
  locked_by UUID REFERENCES public.profiles(id),
  closing_entry_id UUID,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(organization_id, business_id, start_date, end_date)
);

-- 2. GL Transaction Type Mappings
CREATE TABLE public.gl_transaction_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE CASCADE,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN (
    'invoice', 'invoice_payment', 'bill', 'bill_payment', 
    'expense', 'pos_sale', 'pos_return', 'payroll', 
    'inventory_adjustment', 'depreciation', 'credit_note', 'debit_note'
  )),
  debit_account_id UUID REFERENCES public.accounts(id),
  credit_account_id UUID REFERENCES public.accounts(id),
  description_template TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(organization_id, business_id, transaction_type)
);

-- 3. Add source document tracking to journal entries
ALTER TABLE public.journal_entries 
  ADD COLUMN IF NOT EXISTS source_type TEXT,
  ADD COLUMN IF NOT EXISTS source_id UUID,
  ADD COLUMN IF NOT EXISTS fiscal_period_id UUID REFERENCES public.fiscal_periods(id),
  ADD COLUMN IF NOT EXISTS is_closing_entry BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_opening_entry BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS reversal_of_id UUID,
  ADD COLUMN IF NOT EXISTS reversed_by_id UUID;

-- 4. Enable RLS on new tables
ALTER TABLE public.fiscal_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gl_transaction_mappings ENABLE ROW LEVEL SECURITY;

-- 5. RLS Policies for fiscal_periods (using user_roles table)
CREATE POLICY "Users can view fiscal periods in their organization"
  ON public.fiscal_periods FOR SELECT
  USING (organization_id IN (
    SELECT organization_id FROM public.user_roles 
    WHERE user_id = auth.uid() AND is_active = true
  ));

CREATE POLICY "Users can create fiscal periods in their organization"
  ON public.fiscal_periods FOR INSERT
  WITH CHECK (organization_id IN (
    SELECT organization_id FROM public.user_roles 
    WHERE user_id = auth.uid() AND is_active = true
  ));

CREATE POLICY "Users can update fiscal periods in their organization"
  ON public.fiscal_periods FOR UPDATE
  USING (organization_id IN (
    SELECT organization_id FROM public.user_roles 
    WHERE user_id = auth.uid() AND is_active = true
  ));

CREATE POLICY "Users can delete fiscal periods in their organization"
  ON public.fiscal_periods FOR DELETE
  USING (organization_id IN (
    SELECT organization_id FROM public.user_roles 
    WHERE user_id = auth.uid() AND is_active = true
  ));

-- 6. RLS Policies for gl_transaction_mappings
CREATE POLICY "Users can view GL mappings in their organization"
  ON public.gl_transaction_mappings FOR SELECT
  USING (organization_id IN (
    SELECT organization_id FROM public.user_roles 
    WHERE user_id = auth.uid() AND is_active = true
  ));

CREATE POLICY "Users can manage GL mappings in their organization"
  ON public.gl_transaction_mappings FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM public.user_roles 
    WHERE user_id = auth.uid() AND is_active = true
  ));

-- 7. Indexes for performance
CREATE INDEX idx_fiscal_periods_org ON public.fiscal_periods(organization_id);
CREATE INDEX idx_fiscal_periods_dates ON public.fiscal_periods(start_date, end_date);
CREATE INDEX idx_fiscal_periods_status ON public.fiscal_periods(status);
CREATE INDEX idx_gl_mappings_org_type ON public.gl_transaction_mappings(organization_id, transaction_type);
CREATE INDEX idx_journal_entries_source ON public.journal_entries(source_type, source_id);
CREATE INDEX idx_journal_entries_fiscal_period ON public.journal_entries(fiscal_period_id);

-- 8. Update timestamp triggers
CREATE TRIGGER update_fiscal_periods_updated_at
  BEFORE UPDATE ON public.fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_gl_transaction_mappings_updated_at
  BEFORE UPDATE ON public.gl_transaction_mappings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();