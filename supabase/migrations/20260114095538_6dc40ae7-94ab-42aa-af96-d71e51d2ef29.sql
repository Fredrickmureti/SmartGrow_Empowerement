-- =============================================
-- PHASE 2: SALES CATEGORY EXPANSION
-- =============================================

-- 1. PROFORMA INVOICES
CREATE TABLE public.proforma_invoices (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.contacts(id),
  proforma_number TEXT NOT NULL,
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  expiry_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'rejected', 'expired', 'converted')),
  currency TEXT DEFAULT 'KES',
  subtotal NUMERIC(15,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(15,2) DEFAULT 0,
  total NUMERIC(15,2) NOT NULL DEFAULT 0,
  notes TEXT,
  terms TEXT,
  converted_invoice_id UUID REFERENCES public.invoices(id),
  converted_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.proforma_invoice_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  proforma_invoice_id UUID NOT NULL REFERENCES public.proforma_invoices(id) ON DELETE CASCADE,
  product_id UUID REFERENCES public.products(id),
  description TEXT NOT NULL,
  quantity NUMERIC(15,2) NOT NULL DEFAULT 1,
  unit_price NUMERIC(15,2) NOT NULL,
  tax_rate NUMERIC(5,2),
  tax_amount NUMERIC(15,2),
  discount_percent NUMERIC(5,2),
  line_total NUMERIC(15,2) NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. SALES ORDERS
CREATE TABLE public.sales_orders (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.contacts(id),
  so_number TEXT NOT NULL,
  order_date DATE NOT NULL DEFAULT CURRENT_DATE,
  expected_date DATE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'processing', 'partial', 'fulfilled', 'cancelled')),
  currency TEXT DEFAULT 'KES',
  subtotal NUMERIC(15,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(15,2) DEFAULT 0,
  shipping_amount NUMERIC(15,2) DEFAULT 0,
  total NUMERIC(15,2) NOT NULL DEFAULT 0,
  shipping_address TEXT,
  notes TEXT,
  converted_invoice_id UUID REFERENCES public.invoices(id),
  converted_at TIMESTAMPTZ,
  source_estimate_id UUID REFERENCES public.estimates(id),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.sales_order_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  sales_order_id UUID NOT NULL REFERENCES public.sales_orders(id) ON DELETE CASCADE,
  product_id UUID REFERENCES public.products(id),
  description TEXT NOT NULL,
  quantity NUMERIC(15,2) NOT NULL DEFAULT 1,
  quantity_fulfilled NUMERIC(15,2) DEFAULT 0,
  unit_price NUMERIC(15,2) NOT NULL,
  tax_rate NUMERIC(5,2),
  tax_amount NUMERIC(15,2),
  discount_percent NUMERIC(5,2),
  line_total NUMERIC(15,2) NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. DELIVERY NOTES
CREATE TABLE public.delivery_notes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.contacts(id),
  delivery_number TEXT NOT NULL,
  delivery_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_transit', 'delivered', 'partial', 'cancelled')),
  sales_order_id UUID REFERENCES public.sales_orders(id),
  shipping_address TEXT,
  driver_name TEXT,
  vehicle_number TEXT,
  notes TEXT,
  delivered_at TIMESTAMPTZ,
  received_by TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.delivery_note_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  delivery_note_id UUID NOT NULL REFERENCES public.delivery_notes(id) ON DELETE CASCADE,
  product_id UUID REFERENCES public.products(id),
  sales_order_item_id UUID REFERENCES public.sales_order_items(id),
  description TEXT NOT NULL,
  quantity_ordered NUMERIC(15,2) NOT NULL DEFAULT 0,
  quantity_delivered NUMERIC(15,2) NOT NULL DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. SALES RETURNS
CREATE TABLE public.sales_returns (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.contacts(id),
  return_number TEXT NOT NULL,
  return_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'received', 'refunded', 'rejected')),
  invoice_id UUID REFERENCES public.invoices(id),
  reason TEXT NOT NULL,
  currency TEXT DEFAULT 'KES',
  subtotal NUMERIC(15,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  total NUMERIC(15,2) NOT NULL DEFAULT 0,
  refund_method TEXT CHECK (refund_method IN ('credit_note', 'refund', 'replacement')),
  credit_note_id UUID REFERENCES public.credit_notes(id),
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.sales_return_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  sales_return_id UUID NOT NULL REFERENCES public.sales_returns(id) ON DELETE CASCADE,
  product_id UUID REFERENCES public.products(id),
  invoice_item_id UUID REFERENCES public.invoice_items(id),
  description TEXT NOT NULL,
  quantity NUMERIC(15,2) NOT NULL DEFAULT 1,
  unit_price NUMERIC(15,2) NOT NULL,
  tax_rate NUMERIC(5,2),
  tax_amount NUMERIC(15,2),
  line_total NUMERIC(15,2) NOT NULL,
  return_reason TEXT,
  condition TEXT CHECK (condition IN ('good', 'damaged', 'defective')),
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. PURCHASE RETURNS
CREATE TABLE public.purchase_returns (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  vendor_id UUID REFERENCES public.contacts(id),
  return_number TEXT NOT NULL,
  return_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'shipped', 'refunded', 'rejected')),
  bill_id UUID REFERENCES public.bills(id),
  reason TEXT NOT NULL,
  currency TEXT DEFAULT 'KES',
  subtotal NUMERIC(15,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  total NUMERIC(15,2) NOT NULL DEFAULT 0,
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.purchase_return_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  purchase_return_id UUID NOT NULL REFERENCES public.purchase_returns(id) ON DELETE CASCADE,
  product_id UUID REFERENCES public.products(id),
  bill_item_id UUID REFERENCES public.bill_items(id),
  description TEXT NOT NULL,
  quantity NUMERIC(15,2) NOT NULL DEFAULT 1,
  unit_price NUMERIC(15,2) NOT NULL,
  tax_rate NUMERIC(5,2),
  tax_amount NUMERIC(15,2),
  line_total NUMERIC(15,2) NOT NULL,
  return_reason TEXT,
  condition TEXT CHECK (condition IN ('good', 'damaged', 'defective')),
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS on all new tables
ALTER TABLE public.proforma_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proforma_invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_note_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_return_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_return_items ENABLE ROW LEVEL SECURITY;

-- RLS Policies for proforma_invoices
CREATE POLICY "Users can view proforma invoices in their organizations"
  ON public.proforma_invoices FOR SELECT
  USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

CREATE POLICY "Users can create proforma invoices in their organizations"
  ON public.proforma_invoices FOR INSERT
  WITH CHECK (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

CREATE POLICY "Users can update proforma invoices in their organizations"
  ON public.proforma_invoices FOR UPDATE
  USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

CREATE POLICY "Users can delete proforma invoices in their organizations"
  ON public.proforma_invoices FOR DELETE
  USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

-- RLS Policies for proforma_invoice_items
CREATE POLICY "Users can manage proforma invoice items"
  ON public.proforma_invoice_items FOR ALL
  USING (proforma_invoice_id IN (
    SELECT id FROM public.proforma_invoices 
    WHERE organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  ));

-- RLS Policies for sales_orders
CREATE POLICY "Users can view sales orders in their organizations"
  ON public.sales_orders FOR SELECT
  USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

CREATE POLICY "Users can create sales orders in their organizations"
  ON public.sales_orders FOR INSERT
  WITH CHECK (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

CREATE POLICY "Users can update sales orders in their organizations"
  ON public.sales_orders FOR UPDATE
  USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

CREATE POLICY "Users can delete sales orders in their organizations"
  ON public.sales_orders FOR DELETE
  USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

-- RLS Policies for sales_order_items
CREATE POLICY "Users can manage sales order items"
  ON public.sales_order_items FOR ALL
  USING (sales_order_id IN (
    SELECT id FROM public.sales_orders 
    WHERE organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  ));

-- RLS Policies for delivery_notes
CREATE POLICY "Users can view delivery notes in their organizations"
  ON public.delivery_notes FOR SELECT
  USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

CREATE POLICY "Users can create delivery notes in their organizations"
  ON public.delivery_notes FOR INSERT
  WITH CHECK (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

CREATE POLICY "Users can update delivery notes in their organizations"
  ON public.delivery_notes FOR UPDATE
  USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

CREATE POLICY "Users can delete delivery notes in their organizations"
  ON public.delivery_notes FOR DELETE
  USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

-- RLS Policies for delivery_note_items
CREATE POLICY "Users can manage delivery note items"
  ON public.delivery_note_items FOR ALL
  USING (delivery_note_id IN (
    SELECT id FROM public.delivery_notes 
    WHERE organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  ));

-- RLS Policies for sales_returns
CREATE POLICY "Users can view sales returns in their organizations"
  ON public.sales_returns FOR SELECT
  USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

CREATE POLICY "Users can create sales returns in their organizations"
  ON public.sales_returns FOR INSERT
  WITH CHECK (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

CREATE POLICY "Users can update sales returns in their organizations"
  ON public.sales_returns FOR UPDATE
  USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

CREATE POLICY "Users can delete sales returns in their organizations"
  ON public.sales_returns FOR DELETE
  USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

-- RLS Policies for sales_return_items
CREATE POLICY "Users can manage sales return items"
  ON public.sales_return_items FOR ALL
  USING (sales_return_id IN (
    SELECT id FROM public.sales_returns 
    WHERE organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  ));

-- RLS Policies for purchase_returns
CREATE POLICY "Users can view purchase returns in their organizations"
  ON public.purchase_returns FOR SELECT
  USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

CREATE POLICY "Users can create purchase returns in their organizations"
  ON public.purchase_returns FOR INSERT
  WITH CHECK (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

CREATE POLICY "Users can update purchase returns in their organizations"
  ON public.purchase_returns FOR UPDATE
  USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

CREATE POLICY "Users can delete purchase returns in their organizations"
  ON public.purchase_returns FOR DELETE
  USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

-- RLS Policies for purchase_return_items
CREATE POLICY "Users can manage purchase return items"
  ON public.purchase_return_items FOR ALL
  USING (purchase_return_id IN (
    SELECT id FROM public.purchase_returns 
    WHERE organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  ));

-- Create indexes for better performance
CREATE INDEX idx_proforma_invoices_org ON public.proforma_invoices(organization_id);
CREATE INDEX idx_proforma_invoices_contact ON public.proforma_invoices(contact_id);
CREATE INDEX idx_proforma_invoices_status ON public.proforma_invoices(status);

CREATE INDEX idx_sales_orders_org ON public.sales_orders(organization_id);
CREATE INDEX idx_sales_orders_contact ON public.sales_orders(contact_id);
CREATE INDEX idx_sales_orders_status ON public.sales_orders(status);

CREATE INDEX idx_delivery_notes_org ON public.delivery_notes(organization_id);
CREATE INDEX idx_delivery_notes_sales_order ON public.delivery_notes(sales_order_id);
CREATE INDEX idx_delivery_notes_status ON public.delivery_notes(status);

CREATE INDEX idx_sales_returns_org ON public.sales_returns(organization_id);
CREATE INDEX idx_sales_returns_invoice ON public.sales_returns(invoice_id);
CREATE INDEX idx_sales_returns_status ON public.sales_returns(status);

CREATE INDEX idx_purchase_returns_org ON public.purchase_returns(organization_id);
CREATE INDEX idx_purchase_returns_bill ON public.purchase_returns(bill_id);
CREATE INDEX idx_purchase_returns_status ON public.purchase_returns(status);

-- Helper functions for generating numbers
CREATE OR REPLACE FUNCTION public.get_next_proforma_number(_org_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    next_num INTEGER;
    year_prefix TEXT;
BEGIN
    year_prefix := to_char(CURRENT_DATE, 'YYYY');
    
    SELECT COALESCE(MAX(
        CAST(NULLIF(regexp_replace(proforma_number, '[^0-9]', '', 'g'), '') AS INTEGER)
    ), 0) + 1
    INTO next_num
    FROM public.proforma_invoices
    WHERE organization_id = _org_id
    AND proforma_number LIKE 'PI-' || year_prefix || '-%';
    
    RETURN 'PI-' || year_prefix || '-' || LPAD(next_num::TEXT, 4, '0');
END;
$$;

CREATE OR REPLACE FUNCTION public.get_next_so_number(_org_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    next_num INTEGER;
    year_prefix TEXT;
BEGIN
    year_prefix := to_char(CURRENT_DATE, 'YYYY');
    
    SELECT COALESCE(MAX(
        CAST(NULLIF(regexp_replace(so_number, '[^0-9]', '', 'g'), '') AS INTEGER)
    ), 0) + 1
    INTO next_num
    FROM public.sales_orders
    WHERE organization_id = _org_id
    AND so_number LIKE 'SO-' || year_prefix || '-%';
    
    RETURN 'SO-' || year_prefix || '-' || LPAD(next_num::TEXT, 4, '0');
END;
$$;

CREATE OR REPLACE FUNCTION public.get_next_delivery_number(_org_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    next_num INTEGER;
    year_prefix TEXT;
BEGIN
    year_prefix := to_char(CURRENT_DATE, 'YYYY');
    
    SELECT COALESCE(MAX(
        CAST(NULLIF(regexp_replace(delivery_number, '[^0-9]', '', 'g'), '') AS INTEGER)
    ), 0) + 1
    INTO next_num
    FROM public.delivery_notes
    WHERE organization_id = _org_id
    AND delivery_number LIKE 'DN-' || year_prefix || '-%';
    
    RETURN 'DN-' || year_prefix || '-' || LPAD(next_num::TEXT, 4, '0');
END;
$$;

CREATE OR REPLACE FUNCTION public.get_next_sales_return_number(_org_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    next_num INTEGER;
    year_prefix TEXT;
BEGIN
    year_prefix := to_char(CURRENT_DATE, 'YYYY');
    
    SELECT COALESCE(MAX(
        CAST(NULLIF(regexp_replace(return_number, '[^0-9]', '', 'g'), '') AS INTEGER)
    ), 0) + 1
    INTO next_num
    FROM public.sales_returns
    WHERE organization_id = _org_id
    AND return_number LIKE 'SR-' || year_prefix || '-%';
    
    RETURN 'SR-' || year_prefix || '-' || LPAD(next_num::TEXT, 4, '0');
END;
$$;

CREATE OR REPLACE FUNCTION public.get_next_purchase_return_number(_org_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    next_num INTEGER;
    year_prefix TEXT;
BEGIN
    year_prefix := to_char(CURRENT_DATE, 'YYYY');
    
    SELECT COALESCE(MAX(
        CAST(NULLIF(regexp_replace(return_number, '[^0-9]', '', 'g'), '') AS INTEGER)
    ), 0) + 1
    INTO next_num
    FROM public.purchase_returns
    WHERE organization_id = _org_id
    AND return_number LIKE 'PR-' || year_prefix || '-%';
    
    RETURN 'PR-' || year_prefix || '-' || LPAD(next_num::TEXT, 4, '0');
END;
$$;

-- Triggers for updated_at
CREATE TRIGGER update_proforma_invoices_updated_at
  BEFORE UPDATE ON public.proforma_invoices
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_sales_orders_updated_at
  BEFORE UPDATE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_delivery_notes_updated_at
  BEFORE UPDATE ON public.delivery_notes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_sales_returns_updated_at
  BEFORE UPDATE ON public.sales_returns
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_purchase_returns_updated_at
  BEFORE UPDATE ON public.purchase_returns
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();