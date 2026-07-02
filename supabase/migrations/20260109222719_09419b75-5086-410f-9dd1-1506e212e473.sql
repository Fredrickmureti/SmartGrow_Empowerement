-- =============================================
-- PHASE 5: RECEIPT STORAGE & PURCHASE ORDERS
-- =============================================

-- Create storage bucket for receipts/attachments
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'receipts', 
  'receipts', 
  false, 
  10485760, -- 10MB limit
  ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']
) ON CONFLICT (id) DO NOTHING;

-- Storage policies for receipts bucket
CREATE POLICY "Users can upload receipts to their org folder" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'receipts' 
    AND auth.uid() IS NOT NULL
  );

CREATE POLICY "Users can view receipts in their org folder" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'receipts'
    AND auth.uid() IS NOT NULL
  );

CREATE POLICY "Users can update their own receipts" ON storage.objects
  FOR UPDATE USING (
    bucket_id = 'receipts'
    AND auth.uid() IS NOT NULL
  );

CREATE POLICY "Users can delete their own receipts" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'receipts'
    AND auth.uid() IS NOT NULL
  );

-- Purchase orders
DO $$ BEGIN
  CREATE TYPE po_status AS ENUM ('draft', 'sent', 'partial_received', 'received', 'cancelled');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE public.purchase_orders (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  vendor_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  
  po_number TEXT NOT NULL,
  status po_status NOT NULL DEFAULT 'draft',
  
  order_date DATE NOT NULL DEFAULT CURRENT_DATE,
  expected_date DATE,
  
  subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(12, 2) DEFAULT 0,
  total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  
  currency TEXT DEFAULT 'USD',
  shipping_address TEXT,
  notes TEXT,
  
  -- Conversion to bill
  converted_bill_id UUID REFERENCES public.bills(id) ON DELETE SET NULL,
  converted_at TIMESTAMPTZ,
  
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.purchase_order_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  purchase_order_id UUID NOT NULL REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
  
  description TEXT NOT NULL,
  quantity NUMERIC(10, 2) NOT NULL DEFAULT 1,
  quantity_received NUMERIC(10, 2) DEFAULT 0,
  unit_price NUMERIC(12, 2) NOT NULL,
  tax_rate NUMERIC(5, 2) DEFAULT 0,
  tax_amount NUMERIC(12, 2) DEFAULT 0,
  line_total NUMERIC(12, 2) NOT NULL,
  
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Function to get next PO number
CREATE OR REPLACE FUNCTION public.get_next_po_number(_org_id uuid)
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
        CAST(NULLIF(regexp_replace(po_number, '[^0-9]', '', 'g'), '') AS INTEGER)
    ), 0) + 1
    INTO next_num
    FROM public.purchase_orders
    WHERE organization_id = _org_id
    AND po_number LIKE 'PO-' || year_prefix || '-%';
    
    RETURN 'PO-' || year_prefix || '-' || LPAD(next_num::TEXT, 4, '0');
END;
$$;

-- Enable RLS
ALTER TABLE public.purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_order_items ENABLE ROW LEVEL SECURITY;

-- RLS Policies for purchase_orders
CREATE POLICY "Users can view POs in their orgs" ON public.purchase_orders
  FOR SELECT USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can create POs in their orgs" ON public.purchase_orders
  FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can update POs in their orgs" ON public.purchase_orders
  FOR UPDATE USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can delete draft POs" ON public.purchase_orders
  FOR DELETE USING (organization_id IN (SELECT get_user_organizations(auth.uid())) AND status = 'draft');

-- RLS Policies for purchase_order_items
CREATE POLICY "Users can view PO items" ON public.purchase_order_items
  FOR SELECT USING (purchase_order_id IN (
    SELECT id FROM public.purchase_orders WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
  ));

CREATE POLICY "Users can manage PO items" ON public.purchase_order_items
  FOR ALL USING (purchase_order_id IN (
    SELECT id FROM public.purchase_orders WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
  ));

-- Trigger for updated_at
CREATE TRIGGER update_purchase_orders_updated_at
  BEFORE UPDATE ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();