
-- Phase 3: RFQ Module

-- RFQ status enum
DO $$ BEGIN
  CREATE TYPE rfq_status AS ENUM ('draft', 'sent', 'received', 'closed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Main RFQ table
CREATE TABLE public.rfqs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  rfq_number text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  deadline date,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.rfqs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rfqs_select" ON public.rfqs
  FOR SELECT USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()));
CREATE POLICY "rfqs_insert" ON public.rfqs
  FOR INSERT WITH CHECK (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()));
CREATE POLICY "rfqs_update" ON public.rfqs
  FOR UPDATE USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()));
CREATE POLICY "rfqs_delete" ON public.rfqs
  FOR DELETE USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()));

CREATE TRIGGER update_rfqs_updated_at BEFORE UPDATE ON public.rfqs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_rfqs_org ON public.rfqs(organization_id);
CREATE INDEX idx_rfqs_status ON public.rfqs(status);

-- RFQ line items (what products are being quoted)
CREATE TABLE public.rfq_items (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  rfq_id uuid NOT NULL REFERENCES public.rfqs(id) ON DELETE CASCADE,
  product_id uuid REFERENCES public.products(id) ON DELETE SET NULL,
  description text NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  target_price numeric,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.rfq_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rfq_items_select" ON public.rfq_items
  FOR SELECT USING (rfq_id IN (SELECT id FROM public.rfqs WHERE organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())));
CREATE POLICY "rfq_items_insert" ON public.rfq_items
  FOR INSERT WITH CHECK (rfq_id IN (SELECT id FROM public.rfqs WHERE organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())));
CREATE POLICY "rfq_items_update" ON public.rfq_items
  FOR UPDATE USING (rfq_id IN (SELECT id FROM public.rfqs WHERE organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())));
CREATE POLICY "rfq_items_delete" ON public.rfq_items
  FOR DELETE USING (rfq_id IN (SELECT id FROM public.rfqs WHERE organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())));

CREATE INDEX idx_rfq_items_rfq ON public.rfq_items(rfq_id);

-- RFQ vendors (which vendors receive this RFQ)
CREATE TABLE public.rfq_vendors (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  rfq_id uuid NOT NULL REFERENCES public.rfqs(id) ON DELETE CASCADE,
  vendor_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  quoted_total numeric,
  lead_time_days integer,
  notes text,
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.rfq_vendors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rfq_vendors_select" ON public.rfq_vendors
  FOR SELECT USING (rfq_id IN (SELECT id FROM public.rfqs WHERE organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())));
CREATE POLICY "rfq_vendors_insert" ON public.rfq_vendors
  FOR INSERT WITH CHECK (rfq_id IN (SELECT id FROM public.rfqs WHERE organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())));
CREATE POLICY "rfq_vendors_update" ON public.rfq_vendors
  FOR UPDATE USING (rfq_id IN (SELECT id FROM public.rfqs WHERE organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())));
CREATE POLICY "rfq_vendors_delete" ON public.rfq_vendors
  FOR DELETE USING (rfq_id IN (SELECT id FROM public.rfqs WHERE organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())));

CREATE INDEX idx_rfq_vendors_rfq ON public.rfq_vendors(rfq_id);
CREATE INDEX idx_rfq_vendors_vendor ON public.rfq_vendors(vendor_id);

-- RFQ vendor item responses (per-item pricing from each vendor)
CREATE TABLE public.rfq_vendor_items (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  rfq_vendor_id uuid NOT NULL REFERENCES public.rfq_vendors(id) ON DELETE CASCADE,
  rfq_item_id uuid NOT NULL REFERENCES public.rfq_items(id) ON DELETE CASCADE,
  unit_price numeric,
  available_qty integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.rfq_vendor_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rfq_vendor_items_select" ON public.rfq_vendor_items
  FOR SELECT USING (rfq_vendor_id IN (
    SELECT rv.id FROM public.rfq_vendors rv
    JOIN public.rfqs r ON r.id = rv.rfq_id
    WHERE r.organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())
  ));
CREATE POLICY "rfq_vendor_items_insert" ON public.rfq_vendor_items
  FOR INSERT WITH CHECK (rfq_vendor_id IN (
    SELECT rv.id FROM public.rfq_vendors rv
    JOIN public.rfqs r ON r.id = rv.rfq_id
    WHERE r.organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())
  ));
CREATE POLICY "rfq_vendor_items_update" ON public.rfq_vendor_items
  FOR UPDATE USING (rfq_vendor_id IN (
    SELECT rv.id FROM public.rfq_vendors rv
    JOIN public.rfqs r ON r.id = rv.rfq_id
    WHERE r.organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())
  ));
CREATE POLICY "rfq_vendor_items_delete" ON public.rfq_vendor_items
  FOR DELETE USING (rfq_vendor_id IN (
    SELECT rv.id FROM public.rfq_vendors rv
    JOIN public.rfqs r ON r.id = rv.rfq_id
    WHERE r.organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())
  ));

CREATE INDEX idx_rfq_vendor_items_vendor ON public.rfq_vendor_items(rfq_vendor_id);
CREATE INDEX idx_rfq_vendor_items_item ON public.rfq_vendor_items(rfq_item_id);

-- Get next RFQ number function
CREATE OR REPLACE FUNCTION public.get_next_rfq_number(_org_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  next_num integer;
BEGIN
  SELECT COALESCE(MAX(
    CASE WHEN rfq_number ~ '^RFQ-[0-9]+$'
    THEN CAST(SUBSTRING(rfq_number FROM 5) AS integer)
    ELSE 0 END
  ), 0) + 1
  INTO next_num
  FROM rfqs
  WHERE organization_id = _org_id;

  RETURN 'RFQ-' || LPAD(next_num::text, 4, '0');
END;
$$;
