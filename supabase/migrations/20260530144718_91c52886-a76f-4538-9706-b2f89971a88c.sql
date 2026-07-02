
-- =========================================================
-- PHASE 3 — Multi-UoM pricing
-- =========================================================
CREATE TABLE public.product_pricing (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  packaging_id uuid REFERENCES public.product_packaging(id) ON DELETE CASCADE,
  price_list_name text NOT NULL DEFAULT 'default',
  currency_code text NOT NULL DEFAULT 'KES',
  price numeric(18,4) NOT NULL CHECK (price >= 0),
  min_quantity numeric(18,4) NOT NULL DEFAULT 1 CHECK (min_quantity > 0),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);

CREATE UNIQUE INDEX uq_product_pricing_pack
  ON public.product_pricing(business_id, product_id, packaging_id, price_list_name, effective_from)
  WHERE packaging_id IS NOT NULL;
CREATE UNIQUE INDEX uq_product_pricing_base
  ON public.product_pricing(business_id, product_id, price_list_name, effective_from)
  WHERE packaging_id IS NULL;
CREATE INDEX idx_product_pricing_lookup
  ON public.product_pricing(business_id, product_id, packaging_id, is_active);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_pricing TO authenticated;
GRANT ALL ON public.product_pricing TO service_role;
ALTER TABLE public.product_pricing ENABLE ROW LEVEL SECURITY;

CREATE POLICY "product_pricing_all" ON public.product_pricing FOR ALL TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id))
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));

CREATE TRIGGER set_updated_at_product_pricing
  BEFORE UPDATE ON public.product_pricing
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Backfills
INSERT INTO public.product_pricing (organization_id, business_id, product_id, packaging_id, price, price_list_name)
SELECT pp.organization_id, pp.business_id, pp.product_id, pp.id,
       COALESCE(p.unit_price, 0) * pp.qty_in_base_uom, 'default'
FROM public.product_packaging pp JOIN public.products p ON p.id = pp.product_id
ON CONFLICT DO NOTHING;

INSERT INTO public.product_pricing (organization_id, business_id, product_id, packaging_id, price, price_list_name)
SELECT p.organization_id, p.business_id, p.id, NULL, COALESCE(p.unit_price, 0), 'default'
FROM public.products p WHERE p.unit_price IS NOT NULL
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.resolve_product_price(
  p_business_id uuid, p_product_id uuid,
  p_packaging_id uuid DEFAULT NULL, p_quantity numeric DEFAULT 1,
  p_price_list text DEFAULT 'default'
) RETURNS numeric LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_price numeric;
BEGIN
  IF p_packaging_id IS NOT NULL THEN
    SELECT price INTO v_price FROM public.product_pricing
    WHERE business_id=p_business_id AND product_id=p_product_id
      AND packaging_id=p_packaging_id AND price_list_name=p_price_list
      AND is_active AND p_quantity >= min_quantity
      AND (effective_to IS NULL OR effective_to > now())
      AND effective_from <= now()
    ORDER BY min_quantity DESC, effective_from DESC LIMIT 1;
    IF v_price IS NOT NULL THEN RETURN v_price; END IF;
  END IF;
  SELECT price INTO v_price FROM public.product_pricing
  WHERE business_id=p_business_id AND product_id=p_product_id
    AND packaging_id IS NULL AND price_list_name=p_price_list AND is_active
    AND (effective_to IS NULL OR effective_to > now()) AND effective_from <= now()
  ORDER BY effective_from DESC LIMIT 1;
  IF v_price IS NOT NULL THEN
    IF p_packaging_id IS NOT NULL THEN
      RETURN v_price * COALESCE((SELECT qty_in_base_uom FROM public.product_packaging WHERE id=p_packaging_id),1);
    END IF;
    RETURN v_price;
  END IF;
  SELECT unit_price INTO v_price FROM public.products WHERE id=p_product_id;
  IF p_packaging_id IS NOT NULL THEN
    RETURN COALESCE(v_price,0) * COALESCE((SELECT qty_in_base_uom FROM public.product_packaging WHERE id=p_packaging_id),1);
  END IF;
  RETURN COALESCE(v_price,0);
END; $$;

-- =========================================================
-- PHASE 7 — Pharmacy-grade extras
-- =========================================================
CREATE TABLE public.product_recalls (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  recall_reference text NOT NULL,
  reason text NOT NULL,
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high','critical')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','quarantined','closed')),
  recall_date date NOT NULL DEFAULT CURRENT_DATE,
  closed_at timestamptz, initiated_by uuid, notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_recalls TO authenticated;
GRANT ALL ON public.product_recalls TO service_role;
ALTER TABLE public.product_recalls ENABLE ROW LEVEL SECURITY;
CREATE POLICY "product_recalls_all" ON public.product_recalls FOR ALL TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id))
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));
CREATE TRIGGER set_updated_at_product_recalls BEFORE UPDATE ON public.product_recalls
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.product_recall_items (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  recall_id uuid NOT NULL REFERENCES public.product_recalls(id) ON DELETE CASCADE,
  lot_id uuid REFERENCES public.stock_lots(id) ON DELETE SET NULL,
  warehouse_id uuid,
  quantity_quarantined numeric(18,4) NOT NULL DEFAULT 0,
  quantity_returned numeric(18,4) NOT NULL DEFAULT 0,
  quantity_destroyed numeric(18,4) NOT NULL DEFAULT 0,
  notes text, created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_recall_items TO authenticated;
GRANT ALL ON public.product_recall_items TO service_role;
ALTER TABLE public.product_recall_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "product_recall_items_all" ON public.product_recall_items FOR ALL TO authenticated
  USING (recall_id IN (SELECT id FROM public.product_recalls WHERE public.user_has_business_access(auth.uid(), business_id)))
  WITH CHECK (recall_id IN (SELECT id FROM public.product_recalls WHERE public.user_has_business_access(auth.uid(), business_id)));

CREATE TABLE public.controlled_substance_register (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  schedule_class text NOT NULL CHECK (schedule_class IN ('I','II','III','IV','V')),
  movement_type text NOT NULL CHECK (movement_type IN ('receipt','dispense','destruction','adjustment','transfer')),
  movement_date timestamptz NOT NULL DEFAULT now(),
  quantity numeric(18,4) NOT NULL,
  running_balance numeric(18,4) NOT NULL,
  source_document_type text, source_document_id uuid,
  patient_reference text, prescriber_name text, prescriber_license text,
  witness_user_id uuid, recorded_by uuid NOT NULL,
  notes text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_csr_lookup ON public.controlled_substance_register(business_id, product_id, movement_date DESC);
GRANT SELECT, INSERT ON public.controlled_substance_register TO authenticated;
GRANT ALL ON public.controlled_substance_register TO service_role;
ALTER TABLE public.controlled_substance_register ENABLE ROW LEVEL SECURITY;
CREATE POLICY "csr_select" ON public.controlled_substance_register FOR SELECT TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id));
CREATE POLICY "csr_insert" ON public.controlled_substance_register FOR INSERT TO authenticated
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));

CREATE TABLE public.prescriptions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  prescription_number text NOT NULL,
  patient_name text NOT NULL, patient_reference text,
  patient_phone text, patient_dob date,
  prescriber_name text NOT NULL, prescriber_license text, prescriber_phone text,
  product_id uuid REFERENCES public.products(id),
  drug_name text NOT NULL, dosage text, frequency text,
  quantity_prescribed numeric(18,4) NOT NULL,
  quantity_dispensed numeric(18,4) NOT NULL DEFAULT 0,
  refills_authorised integer NOT NULL DEFAULT 0,
  refills_used integer NOT NULL DEFAULT 0,
  issue_date date NOT NULL DEFAULT CURRENT_DATE,
  expiry_date date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','partially_filled','filled','expired','cancelled')),
  notes text, created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, prescription_number)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.prescriptions TO authenticated;
GRANT ALL ON public.prescriptions TO service_role;
ALTER TABLE public.prescriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "prescriptions_all" ON public.prescriptions FOR ALL TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id))
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));
CREATE TRIGGER set_updated_at_prescriptions BEFORE UPDATE ON public.prescriptions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.prescription_sale_links (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  prescription_id uuid NOT NULL REFERENCES public.prescriptions(id) ON DELETE RESTRICT,
  pos_transaction_id uuid, pos_transaction_item_id uuid, invoice_id uuid,
  quantity_dispensed numeric(18,4) NOT NULL,
  dispensed_by uuid NOT NULL,
  dispensed_at timestamptz NOT NULL DEFAULT now(),
  notes text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_psl_rx ON public.prescription_sale_links(prescription_id);
GRANT SELECT, INSERT ON public.prescription_sale_links TO authenticated;
GRANT ALL ON public.prescription_sale_links TO service_role;
ALTER TABLE public.prescription_sale_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY "psl_select" ON public.prescription_sale_links FOR SELECT TO authenticated
  USING (prescription_id IN (SELECT id FROM public.prescriptions WHERE public.user_has_business_access(auth.uid(), business_id)));
CREATE POLICY "psl_insert" ON public.prescription_sale_links FOR INSERT TO authenticated
  WITH CHECK (prescription_id IN (SELECT id FROM public.prescriptions WHERE public.user_has_business_access(auth.uid(), business_id)));

CREATE TABLE public.lot_quarantine (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid NOT NULL, business_id uuid NOT NULL,
  lot_id uuid NOT NULL REFERENCES public.stock_lots(id) ON DELETE CASCADE,
  warehouse_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','destroyed','returned_to_vendor')),
  reason text NOT NULL,
  quarantine_date timestamptz NOT NULL DEFAULT now(),
  released_date timestamptz,
  authorised_by uuid, released_by uuid,
  recall_id uuid REFERENCES public.product_recalls(id) ON DELETE SET NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_lot_quarantine_lot ON public.lot_quarantine(lot_id, status);
GRANT SELECT, INSERT, UPDATE ON public.lot_quarantine TO authenticated;
GRANT ALL ON public.lot_quarantine TO service_role;
ALTER TABLE public.lot_quarantine ENABLE ROW LEVEL SECURITY;
CREATE POLICY "lot_quarantine_all" ON public.lot_quarantine FOR ALL TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id))
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));
CREATE TRIGGER set_updated_at_lot_quarantine BEFORE UPDATE ON public.lot_quarantine
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Cost-model cutover RPC (read-only summary)
CREATE OR REPLACE FUNCTION public.recost_movements_since(
  p_business_id uuid, p_since timestamptz, p_product_id uuid DEFAULT NULL
) RETURNS TABLE(product_id uuid, movements_recosted bigint, total_delta numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH affected AS (
    SELECT sm.product_id, sm.id, sm.quantity, sm.unit_cost AS recorded_cost,
           public.compute_unit_cost(sm.business_id, sm.product_id, sm.warehouse_id) AS new_cost
    FROM public.stock_movements sm
    WHERE sm.business_id = p_business_id
      AND sm.created_at >= p_since
      AND sm.quantity < 0
      AND (p_product_id IS NULL OR sm.product_id = p_product_id)
  )
  SELECT a.product_id, COUNT(*)::bigint,
         SUM((a.new_cost - COALESCE(a.recorded_cost,0)) * ABS(a.quantity))::numeric
  FROM affected a GROUP BY a.product_id;
END; $$;

GRANT EXECUTE ON FUNCTION public.resolve_product_price TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recost_movements_since TO authenticated, service_role;
