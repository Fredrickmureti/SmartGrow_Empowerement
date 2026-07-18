
CREATE TABLE public.supplier_item_terms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  product_id UUID NOT NULL,
  supplier_id UUID NOT NULL,
  preferred_rank INTEGER NOT NULL DEFAULT 100,
  lead_time_days INTEGER NOT NULL DEFAULT 0,
  min_order_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  price_break_tiers JSONB NOT NULL DEFAULT '[]'::jsonb,
  currency_code TEXT NOT NULL DEFAULT 'USD',
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to DATE,
  notes TEXT,
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX supplier_item_terms_unique_window
  ON public.supplier_item_terms(business_id, product_id, supplier_id, effective_from);
CREATE INDEX supplier_item_terms_business_product_idx
  ON public.supplier_item_terms(business_id, product_id);
CREATE INDEX supplier_item_terms_supplier_idx
  ON public.supplier_item_terms(supplier_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.supplier_item_terms TO authenticated;
GRANT ALL ON public.supplier_item_terms TO service_role;

ALTER TABLE public.supplier_item_terms ENABLE ROW LEVEL SECURITY;

CREATE POLICY "supplier_item_terms_read"
  ON public.supplier_item_terms FOR SELECT TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id));
CREATE POLICY "supplier_item_terms_insert"
  ON public.supplier_item_terms FOR INSERT TO authenticated
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));
CREATE POLICY "supplier_item_terms_update"
  ON public.supplier_item_terms FOR UPDATE TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id))
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));
CREATE POLICY "supplier_item_terms_delete"
  ON public.supplier_item_terms FOR DELETE TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id));

CREATE OR REPLACE FUNCTION public._validate_supplier_item_terms()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_tier JSONB; v_prev_qty NUMERIC := -1; v_qty NUMERIC; v_price NUMERIC;
BEGIN
  IF NEW.effective_to IS NOT NULL AND NEW.effective_to <= NEW.effective_from THEN
    RAISE EXCEPTION 'supplier_item_terms: effective_to (%) must be greater than effective_from (%)', NEW.effective_to, NEW.effective_from;
  END IF;
  IF NEW.preferred_rank < 0 THEN RAISE EXCEPTION 'supplier_item_terms: preferred_rank must be non-negative'; END IF;
  IF NEW.lead_time_days < 0 THEN RAISE EXCEPTION 'supplier_item_terms: lead_time_days must be non-negative'; END IF;
  IF NEW.min_order_qty < 0 THEN RAISE EXCEPTION 'supplier_item_terms: min_order_qty must be non-negative'; END IF;
  IF jsonb_typeof(NEW.price_break_tiers) <> 'array' THEN
    RAISE EXCEPTION 'supplier_item_terms: price_break_tiers must be a JSON array';
  END IF;
  FOR v_tier IN SELECT * FROM jsonb_array_elements(NEW.price_break_tiers) LOOP
    v_qty := (v_tier->>'min_qty')::NUMERIC;
    v_price := (v_tier->>'unit_price')::NUMERIC;
    IF v_qty IS NULL OR v_price IS NULL THEN
      RAISE EXCEPTION 'supplier_item_terms: each tier must have min_qty and unit_price';
    END IF;
    IF v_qty < 0 OR v_price < 0 THEN
      RAISE EXCEPTION 'supplier_item_terms: tier min_qty and unit_price must be non-negative';
    END IF;
    IF v_qty <= v_prev_qty THEN
      RAISE EXCEPTION 'supplier_item_terms: price_break_tiers must be strictly increasing by min_qty (got % after %)', v_qty, v_prev_qty;
    END IF;
    v_prev_qty := v_qty;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM public.supplier_item_terms t
    WHERE t.business_id = NEW.business_id
      AND t.product_id  = NEW.product_id
      AND t.supplier_id = NEW.supplier_id
      AND t.id <> NEW.id
      AND daterange(t.effective_from, COALESCE(t.effective_to, 'infinity'::date), '[)')
          && daterange(NEW.effective_from, COALESCE(NEW.effective_to, 'infinity'::date), '[)')
  ) THEN
    RAISE EXCEPTION 'supplier_item_terms: effective window overlaps an existing row for this product/supplier';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_supplier_item_terms
  BEFORE INSERT OR UPDATE ON public.supplier_item_terms
  FOR EACH ROW EXECUTE FUNCTION public._validate_supplier_item_terms();

INSERT INTO public.governance_duties (duty_code, label, description, domain)
VALUES ('supplier_terms.manage', 'Manage supplier terms',
        'Set preferred rank, lead time and price breaks for a supplier/product',
        'procurement')
ON CONFLICT (duty_code) DO NOTHING;

INSERT INTO public.governance_sod_conflicts (duty_a, duty_b, rationale)
VALUES ('po.approve', 'supplier_terms.manage',
        'A buyer who sets preferred supplier ranks and prices must not approve the resulting PO')
ON CONFLICT DO NOTHING;
