-- Add inventory tracking columns to products
ALTER TABLE public.products
ADD COLUMN IF NOT EXISTS stock_quantity numeric DEFAULT 0,
ADD COLUMN IF NOT EXISTS reorder_level numeric DEFAULT 0,
ADD COLUMN IF NOT EXISTS reorder_quantity numeric DEFAULT 0,
ADD COLUMN IF NOT EXISTS track_inventory boolean DEFAULT false;

-- Create stock_movements table for tracking inventory changes
CREATE TABLE public.stock_movements (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('purchase', 'sale', 'adjustment', 'return_in', 'return_out', 'transfer', 'opening')),
  quantity numeric NOT NULL,
  unit_cost numeric,
  reference_type TEXT,
  reference_id UUID,
  notes TEXT,
  movement_date TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create stock_adjustments table for manual adjustments
CREATE TABLE public.stock_adjustments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  adjustment_number TEXT NOT NULL,
  adjustment_date TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  reason TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'cancelled')),
  approved_by UUID REFERENCES auth.users(id),
  approved_at TIMESTAMP WITH TIME ZONE,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create stock_adjustment_items table
CREATE TABLE public.stock_adjustment_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  adjustment_id UUID NOT NULL REFERENCES public.stock_adjustments(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  quantity_before numeric NOT NULL DEFAULT 0,
  quantity_adjustment numeric NOT NULL,
  quantity_after numeric NOT NULL DEFAULT 0,
  unit_cost numeric,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create journal_entries table
CREATE TABLE public.journal_entries (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  entry_number TEXT NOT NULL,
  entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
  description TEXT NOT NULL,
  reference TEXT,
  is_adjusting boolean DEFAULT false,
  is_closing boolean DEFAULT false,
  is_reversing boolean DEFAULT false,
  reversed_entry_id UUID REFERENCES public.journal_entries(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'voided')),
  posted_at TIMESTAMP WITH TIME ZONE,
  posted_by UUID REFERENCES auth.users(id),
  voided_at TIMESTAMP WITH TIME ZONE,
  voided_by UUID REFERENCES auth.users(id),
  void_reason TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(organization_id, entry_number)
);

-- Create journal_entry_lines table
CREATE TABLE public.journal_entry_lines (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  journal_entry_id UUID NOT NULL REFERENCES public.journal_entries(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  description TEXT,
  debit numeric NOT NULL DEFAULT 0,
  credit numeric NOT NULL DEFAULT 0,
  contact_id UUID REFERENCES public.contacts(id),
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT check_debit_or_credit CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0) OR (debit = 0 AND credit = 0))
);

-- Create payment_terms table
CREATE TABLE public.payment_terms (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  days INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  is_default boolean DEFAULT false,
  is_active boolean DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Add payment_term_id to invoices
ALTER TABLE public.invoices
ADD COLUMN IF NOT EXISTS payment_term_id UUID REFERENCES public.payment_terms(id);

-- Create customer_statements table for tracking sent statements
CREATE TABLE public.customer_statements (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  statement_date DATE NOT NULL DEFAULT CURRENT_DATE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  opening_balance numeric NOT NULL DEFAULT 0,
  total_invoiced numeric NOT NULL DEFAULT 0,
  total_payments numeric NOT NULL DEFAULT 0,
  closing_balance numeric NOT NULL DEFAULT 0,
  sent_at TIMESTAMP WITH TIME ZONE,
  sent_to TEXT,
  pdf_url TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create budgets table
CREATE TABLE public.budgets (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  fiscal_year INTEGER NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'closed')),
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create budget_items table
CREATE TABLE public.budget_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  budget_id UUID NOT NULL REFERENCES public.budgets(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  period_month INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  budgeted_amount numeric NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(budget_id, account_id, period_month)
);

-- Enable RLS on all new tables
ALTER TABLE public.stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_adjustment_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_entry_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budget_items ENABLE ROW LEVEL SECURITY;

-- RLS Policies for stock_movements
CREATE POLICY "Users can view stock movements in their organizations"
ON public.stock_movements FOR SELECT
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can create stock movements in their organizations"
ON public.stock_movements FOR INSERT
WITH CHECK (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can update stock movements in their organizations"
ON public.stock_movements FOR UPDATE
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can delete stock movements in their organizations"
ON public.stock_movements FOR DELETE
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

-- RLS Policies for stock_adjustments
CREATE POLICY "Users can view stock adjustments in their organizations"
ON public.stock_adjustments FOR SELECT
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can create stock adjustments in their organizations"
ON public.stock_adjustments FOR INSERT
WITH CHECK (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can update stock adjustments in their organizations"
ON public.stock_adjustments FOR UPDATE
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can delete stock adjustments in their organizations"
ON public.stock_adjustments FOR DELETE
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

-- RLS Policies for stock_adjustment_items (through adjustment)
CREATE POLICY "Users can view stock adjustment items"
ON public.stock_adjustment_items FOR SELECT
USING (adjustment_id IN (
  SELECT id FROM public.stock_adjustments 
  WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
));

CREATE POLICY "Users can create stock adjustment items"
ON public.stock_adjustment_items FOR INSERT
WITH CHECK (adjustment_id IN (
  SELECT id FROM public.stock_adjustments 
  WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
));

CREATE POLICY "Users can update stock adjustment items"
ON public.stock_adjustment_items FOR UPDATE
USING (adjustment_id IN (
  SELECT id FROM public.stock_adjustments 
  WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
));

CREATE POLICY "Users can delete stock adjustment items"
ON public.stock_adjustment_items FOR DELETE
USING (adjustment_id IN (
  SELECT id FROM public.stock_adjustments 
  WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
));

-- RLS Policies for journal_entries
CREATE POLICY "Users can view journal entries in their organizations"
ON public.journal_entries FOR SELECT
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can create journal entries in their organizations"
ON public.journal_entries FOR INSERT
WITH CHECK (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can update journal entries in their organizations"
ON public.journal_entries FOR UPDATE
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can delete journal entries in their organizations"
ON public.journal_entries FOR DELETE
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

-- RLS Policies for journal_entry_lines (through journal entry)
CREATE POLICY "Users can view journal entry lines"
ON public.journal_entry_lines FOR SELECT
USING (journal_entry_id IN (
  SELECT id FROM public.journal_entries 
  WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
));

CREATE POLICY "Users can create journal entry lines"
ON public.journal_entry_lines FOR INSERT
WITH CHECK (journal_entry_id IN (
  SELECT id FROM public.journal_entries 
  WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
));

CREATE POLICY "Users can update journal entry lines"
ON public.journal_entry_lines FOR UPDATE
USING (journal_entry_id IN (
  SELECT id FROM public.journal_entries 
  WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
));

CREATE POLICY "Users can delete journal entry lines"
ON public.journal_entry_lines FOR DELETE
USING (journal_entry_id IN (
  SELECT id FROM public.journal_entries 
  WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
));

-- RLS Policies for payment_terms
CREATE POLICY "Users can view payment terms in their organizations"
ON public.payment_terms FOR SELECT
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can create payment terms in their organizations"
ON public.payment_terms FOR INSERT
WITH CHECK (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can update payment terms in their organizations"
ON public.payment_terms FOR UPDATE
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can delete payment terms in their organizations"
ON public.payment_terms FOR DELETE
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

-- RLS Policies for customer_statements
CREATE POLICY "Users can view customer statements in their organizations"
ON public.customer_statements FOR SELECT
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can create customer statements in their organizations"
ON public.customer_statements FOR INSERT
WITH CHECK (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can update customer statements in their organizations"
ON public.customer_statements FOR UPDATE
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can delete customer statements in their organizations"
ON public.customer_statements FOR DELETE
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

-- RLS Policies for budgets
CREATE POLICY "Users can view budgets in their organizations"
ON public.budgets FOR SELECT
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can create budgets in their organizations"
ON public.budgets FOR INSERT
WITH CHECK (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can update budgets in their organizations"
ON public.budgets FOR UPDATE
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can delete budgets in their organizations"
ON public.budgets FOR DELETE
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

-- RLS Policies for budget_items (through budget)
CREATE POLICY "Users can view budget items"
ON public.budget_items FOR SELECT
USING (budget_id IN (
  SELECT id FROM public.budgets 
  WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
));

CREATE POLICY "Users can create budget items"
ON public.budget_items FOR INSERT
WITH CHECK (budget_id IN (
  SELECT id FROM public.budgets 
  WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
));

CREATE POLICY "Users can update budget items"
ON public.budget_items FOR UPDATE
USING (budget_id IN (
  SELECT id FROM public.budgets 
  WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
));

CREATE POLICY "Users can delete budget items"
ON public.budget_items FOR DELETE
USING (budget_id IN (
  SELECT id FROM public.budgets 
  WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
));

-- Create indexes for better performance
CREATE INDEX idx_stock_movements_product ON public.stock_movements(product_id);
CREATE INDEX idx_stock_movements_org ON public.stock_movements(organization_id);
CREATE INDEX idx_stock_movements_date ON public.stock_movements(movement_date);
CREATE INDEX idx_stock_adjustments_org ON public.stock_adjustments(organization_id);
CREATE INDEX idx_journal_entries_org ON public.journal_entries(organization_id);
CREATE INDEX idx_journal_entries_date ON public.journal_entries(entry_date);
CREATE INDEX idx_journal_entry_lines_account ON public.journal_entry_lines(account_id);
CREATE INDEX idx_payment_terms_org ON public.payment_terms(organization_id);
CREATE INDEX idx_customer_statements_contact ON public.customer_statements(contact_id);
CREATE INDEX idx_budgets_org ON public.budgets(organization_id);
CREATE INDEX idx_budget_items_account ON public.budget_items(account_id);

-- Create trigger for updating stock quantity
CREATE OR REPLACE FUNCTION update_product_stock()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.products 
    SET stock_quantity = COALESCE(stock_quantity, 0) + NEW.quantity
    WHERE id = NEW.product_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.products 
    SET stock_quantity = COALESCE(stock_quantity, 0) - OLD.quantity
    WHERE id = OLD.product_id;
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE public.products 
    SET stock_quantity = COALESCE(stock_quantity, 0) - OLD.quantity + NEW.quantity
    WHERE id = NEW.product_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trigger_update_product_stock
AFTER INSERT OR UPDATE OR DELETE ON public.stock_movements
FOR EACH ROW EXECUTE FUNCTION update_product_stock();

-- Insert default payment terms
INSERT INTO public.payment_terms (id, organization_id, name, days, description, is_default)
SELECT 
  gen_random_uuid(),
  id,
  'Net 30',
  30,
  'Payment due within 30 days',
  true
FROM public.organizations
ON CONFLICT DO NOTHING;