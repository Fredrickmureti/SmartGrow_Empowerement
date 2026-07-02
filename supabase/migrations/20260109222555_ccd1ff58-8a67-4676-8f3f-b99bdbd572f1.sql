-- =============================================
-- PHASE 2: RECURRING INVOICES
-- =============================================

CREATE TABLE public.recurring_invoices (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  
  -- Template data
  template_name TEXT NOT NULL,
  notes TEXT,
  terms TEXT,
  currency TEXT DEFAULT 'USD',
  
  -- Schedule
  frequency TEXT NOT NULL CHECK (frequency IN ('weekly', 'biweekly', 'monthly', 'quarterly', 'yearly')),
  start_date DATE NOT NULL,
  end_date DATE,
  next_run_date DATE NOT NULL,
  last_run_date DATE,
  
  -- Settings
  is_active BOOLEAN DEFAULT true,
  auto_send BOOLEAN DEFAULT false,
  days_before_due INTEGER DEFAULT 30,
  
  -- Metadata
  invoices_generated INTEGER DEFAULT 0,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Recurring invoice items (template)
CREATE TABLE public.recurring_invoice_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  recurring_invoice_id UUID NOT NULL REFERENCES public.recurring_invoices(id) ON DELETE CASCADE,
  product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  quantity NUMERIC(10, 2) NOT NULL DEFAULT 1,
  unit_price NUMERIC(12, 2) NOT NULL,
  tax_rate NUMERIC(5, 2) DEFAULT 0,
  discount_percent NUMERIC(5, 2) DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.recurring_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recurring_invoice_items ENABLE ROW LEVEL SECURITY;

-- RLS Policies for recurring_invoices
CREATE POLICY "Users can view recurring invoices in their orgs" ON public.recurring_invoices
  FOR SELECT USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can create recurring invoices in their orgs" ON public.recurring_invoices
  FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can update recurring invoices in their orgs" ON public.recurring_invoices
  FOR UPDATE USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can delete recurring invoices in their orgs" ON public.recurring_invoices
  FOR DELETE USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

-- RLS Policies for recurring_invoice_items
CREATE POLICY "Users can view recurring invoice items" ON public.recurring_invoice_items
  FOR SELECT USING (recurring_invoice_id IN (
    SELECT id FROM public.recurring_invoices WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
  ));

CREATE POLICY "Users can manage recurring invoice items" ON public.recurring_invoice_items
  FOR ALL USING (recurring_invoice_id IN (
    SELECT id FROM public.recurring_invoices WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
  ));

-- Trigger for updated_at
CREATE TRIGGER update_recurring_invoices_updated_at
  BEFORE UPDATE ON public.recurring_invoices
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();