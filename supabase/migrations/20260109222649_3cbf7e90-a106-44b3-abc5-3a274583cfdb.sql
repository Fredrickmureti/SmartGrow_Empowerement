-- =============================================
-- PHASE 4: BILLS / ACCOUNTS PAYABLE
-- =============================================

-- Create bill status enum
DO $$ BEGIN
  CREATE TYPE bill_status AS ENUM ('draft', 'received', 'partial', 'paid', 'overdue', 'void');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE public.bills (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  vendor_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL,
  
  bill_number TEXT NOT NULL,
  vendor_invoice_number TEXT, -- Original invoice # from vendor
  status bill_status NOT NULL DEFAULT 'draft',
  
  bill_date DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date DATE NOT NULL,
  
  subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(12, 2) DEFAULT 0,
  total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  amount_paid NUMERIC(12, 2) DEFAULT 0,
  
  currency TEXT DEFAULT 'USD',
  notes TEXT,
  attachment_url TEXT,
  
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.bill_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  bill_id UUID NOT NULL REFERENCES public.bills(id) ON DELETE CASCADE,
  account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL,
  product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
  
  description TEXT NOT NULL,
  quantity NUMERIC(10, 2) NOT NULL DEFAULT 1,
  unit_price NUMERIC(12, 2) NOT NULL,
  tax_rate NUMERIC(5, 2) DEFAULT 0,
  tax_amount NUMERIC(12, 2) DEFAULT 0,
  line_total NUMERIC(12, 2) NOT NULL,
  
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bill payments tracking
CREATE TABLE public.bill_payments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  bill_id UUID NOT NULL REFERENCES public.bills(id) ON DELETE CASCADE,
  bank_account_id UUID REFERENCES public.bank_accounts(id) ON DELETE SET NULL,
  
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  amount NUMERIC(12, 2) NOT NULL,
  payment_method TEXT DEFAULT 'bank_transfer',
  reference TEXT,
  notes TEXT,
  
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Function to get next bill number
CREATE OR REPLACE FUNCTION public.get_next_bill_number(_org_id uuid)
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
    
    SELECT COALESCE(bill_prefix, 'BILL') INTO prefix
    FROM public.organizations WHERE id = _org_id;
    
    SELECT COALESCE(MAX(
        CAST(NULLIF(regexp_replace(bill_number, '[^0-9]', '', 'g'), '') AS INTEGER)
    ), 0) + 1
    INTO next_num
    FROM public.bills
    WHERE organization_id = _org_id
    AND bill_number LIKE prefix || '-' || year_prefix || '-%';
    
    RETURN prefix || '-' || year_prefix || '-' || LPAD(next_num::TEXT, 4, '0');
END;
$$;

-- Enable RLS
ALTER TABLE public.bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bill_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bill_payments ENABLE ROW LEVEL SECURITY;

-- RLS Policies for bills
CREATE POLICY "Users can view bills in their orgs" ON public.bills
  FOR SELECT USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can create bills in their orgs" ON public.bills
  FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can update bills in their orgs" ON public.bills
  FOR UPDATE USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can delete draft bills" ON public.bills
  FOR DELETE USING (organization_id IN (SELECT get_user_organizations(auth.uid())) AND status = 'draft');

-- RLS Policies for bill_items
CREATE POLICY "Users can view bill items" ON public.bill_items
  FOR SELECT USING (bill_id IN (
    SELECT id FROM public.bills WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
  ));

CREATE POLICY "Users can manage bill items" ON public.bill_items
  FOR ALL USING (bill_id IN (
    SELECT id FROM public.bills WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
  ));

-- RLS Policies for bill_payments
CREATE POLICY "Users can view bill payments in their orgs" ON public.bill_payments
  FOR SELECT USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can create bill payments in their orgs" ON public.bill_payments
  FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can update bill payments in their orgs" ON public.bill_payments
  FOR UPDATE USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

-- Trigger for updated_at
CREATE TRIGGER update_bills_updated_at
  BEFORE UPDATE ON public.bills
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();