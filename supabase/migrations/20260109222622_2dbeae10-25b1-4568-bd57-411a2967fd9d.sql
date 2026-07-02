-- =============================================
-- PHASE 3: ESTIMATES/QUOTES MODULE
-- =============================================

-- Create estimate status enum
DO $$ BEGIN
  CREATE TYPE estimate_status AS ENUM ('draft', 'sent', 'viewed', 'accepted', 'rejected', 'expired', 'converted');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE public.estimates (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  
  estimate_number TEXT NOT NULL,
  status estimate_status NOT NULL DEFAULT 'draft',
  
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  expiry_date DATE NOT NULL,
  
  subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(12, 2) DEFAULT 0,
  total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  
  currency TEXT DEFAULT 'USD',
  notes TEXT,
  terms TEXT,
  
  -- Conversion tracking
  converted_invoice_id UUID REFERENCES public.invoices(id) ON DELETE SET NULL,
  converted_at TIMESTAMPTZ,
  
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.estimate_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  estimate_id UUID NOT NULL REFERENCES public.estimates(id) ON DELETE CASCADE,
  product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
  
  description TEXT NOT NULL,
  quantity NUMERIC(10, 2) NOT NULL DEFAULT 1,
  unit_price NUMERIC(12, 2) NOT NULL,
  tax_rate NUMERIC(5, 2) DEFAULT 0,
  tax_amount NUMERIC(12, 2) DEFAULT 0,
  discount_percent NUMERIC(5, 2) DEFAULT 0,
  line_total NUMERIC(12, 2) NOT NULL,
  
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Function to get next estimate number
CREATE OR REPLACE FUNCTION public.get_next_estimate_number(_org_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    next_num INTEGER;
    year_prefix TEXT;
    prefix TEXT;
BEGIN
    year_prefix := to_char(CURRENT_DATE, 'YYYY');
    
    SELECT COALESCE(estimate_prefix, 'EST') INTO prefix
    FROM public.organizations WHERE id = _org_id;
    
    SELECT COALESCE(MAX(
        CAST(NULLIF(regexp_replace(estimate_number, '[^0-9]', '', 'g'), '') AS INTEGER)
    ), 0) + 1
    INTO next_num
    FROM public.estimates
    WHERE organization_id = _org_id
    AND estimate_number LIKE prefix || '-' || year_prefix || '-%';
    
    RETURN prefix || '-' || year_prefix || '-' || LPAD(next_num::TEXT, 4, '0');
END;
$$;

-- Enable RLS
ALTER TABLE public.estimates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.estimate_items ENABLE ROW LEVEL SECURITY;

-- RLS Policies for estimates
CREATE POLICY "Users can view estimates in their orgs" ON public.estimates
  FOR SELECT USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can create estimates in their orgs" ON public.estimates
  FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can update estimates in their orgs" ON public.estimates
  FOR UPDATE USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can delete draft estimates" ON public.estimates
  FOR DELETE USING (organization_id IN (SELECT get_user_organizations(auth.uid())) AND status = 'draft');

-- RLS Policies for estimate_items
CREATE POLICY "Users can view estimate items" ON public.estimate_items
  FOR SELECT USING (estimate_id IN (
    SELECT id FROM public.estimates WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
  ));

CREATE POLICY "Users can create estimate items" ON public.estimate_items
  FOR INSERT WITH CHECK (estimate_id IN (
    SELECT id FROM public.estimates WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
  ));

CREATE POLICY "Users can update estimate items" ON public.estimate_items
  FOR UPDATE USING (estimate_id IN (
    SELECT id FROM public.estimates WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
  ));

CREATE POLICY "Users can delete estimate items" ON public.estimate_items
  FOR DELETE USING (estimate_id IN (
    SELECT id FROM public.estimates WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
  ));

-- Trigger for updated_at
CREATE TRIGGER update_estimates_updated_at
  BEFORE UPDATE ON public.estimates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();