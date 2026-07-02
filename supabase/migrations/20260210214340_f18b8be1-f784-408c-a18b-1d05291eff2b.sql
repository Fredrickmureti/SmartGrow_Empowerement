
CREATE TABLE public.vendor_pricelists (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  vendor_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  unit_price numeric NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  min_order_qty integer NOT NULL DEFAULT 1,
  lead_time_days integer NOT NULL DEFAULT 0,
  is_preferred boolean NOT NULL DEFAULT false,
  valid_from date,
  valid_until date,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, vendor_id, product_id)
);

ALTER TABLE public.vendor_pricelists ENABLE ROW LEVEL SECURITY;

CREATE POLICY "vendor_pricelists_select" ON public.vendor_pricelists
  FOR SELECT USING (
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())
  );

CREATE POLICY "vendor_pricelists_insert" ON public.vendor_pricelists
  FOR INSERT WITH CHECK (
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())
  );

CREATE POLICY "vendor_pricelists_update" ON public.vendor_pricelists
  FOR UPDATE USING (
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())
  );

CREATE POLICY "vendor_pricelists_delete" ON public.vendor_pricelists
  FOR DELETE USING (
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())
  );

CREATE TRIGGER update_vendor_pricelists_updated_at
  BEFORE UPDATE ON public.vendor_pricelists
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_vendor_pricelists_org ON public.vendor_pricelists(organization_id);
CREATE INDEX idx_vendor_pricelists_vendor ON public.vendor_pricelists(vendor_id);
CREATE INDEX idx_vendor_pricelists_product ON public.vendor_pricelists(product_id);
CREATE INDEX idx_vendor_pricelists_preferred ON public.vendor_pricelists(product_id, is_preferred) WHERE is_preferred = true AND is_active = true;
