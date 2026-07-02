
-- =====================================================================
-- INVENTORY UoM ARCHITECTURE — Phases 0+1+2+3 (server primitives)
-- Foundation overhaul. DB has 0 products / 0 movements, so backfills
-- are trivial and the migration is safe to ship as one unit.
-- =====================================================================

-- ============= PHASE 0: STABILIZE =============

-- 0.1 Stock movement ledger immutability
CREATE OR REPLACE FUNCTION public.enforce_stock_movement_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_setting('app.allow_movement_mutation', true) = 'true' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'stock_movements is an immutable ledger (op=%, id=%). Post a compensating movement instead.',
    TG_OP, COALESCE(NEW.id, OLD.id)
    USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_stock_movement_immutability ON public.stock_movements;
CREATE TRIGGER trg_enforce_stock_movement_immutability
  BEFORE UPDATE OR DELETE ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.enforce_stock_movement_immutability();

-- 0.2 Mark legacy reservation primitives deprecated (do not drop — still wired in code)
COMMENT ON FUNCTION public.reserve_stock(uuid, uuid, uuid, numeric, text, uuid)
  IS 'DEPRECATED: use create_stock_reservation. Mutates warehouse_stock.reserved_quantity without inserting a stock_reservations row — corrupts unified ledger when mixed.';
COMMENT ON FUNCTION public.release_stock(uuid, uuid, uuid, numeric)
  IS 'DEPRECATED: use release_stock_reservation(p_organization_id, p_reservation_id).';

-- ============= PHASE 1: UoM DOMAIN (dormant) =============

CREATE TABLE public.uom_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  reference_uom_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, name)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.uom_categories TO authenticated;
GRANT ALL ON public.uom_categories TO service_role;
ALTER TABLE public.uom_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY uom_categories_select ON public.uom_categories FOR SELECT TO authenticated USING (is_org_member(auth.uid(), organization_id));
CREATE POLICY uom_categories_insert ON public.uom_categories FOR INSERT TO authenticated WITH CHECK (is_org_member(auth.uid(), organization_id));
CREATE POLICY uom_categories_update ON public.uom_categories FOR UPDATE TO authenticated USING (is_org_member(auth.uid(), organization_id)) WITH CHECK (is_org_member(auth.uid(), organization_id));
CREATE POLICY uom_categories_delete ON public.uom_categories FOR DELETE TO authenticated USING (is_org_member(auth.uid(), organization_id));

CREATE TABLE public.units_of_measure (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES public.uom_categories(id) ON DELETE RESTRICT,
  code text NOT NULL,
  name text NOT NULL,
  factor_to_reference numeric NOT NULL CHECK (factor_to_reference > 0),
  rounding numeric NOT NULL DEFAULT 1 CHECK (rounding > 0),
  uom_type text NOT NULL CHECK (uom_type IN ('reference','bigger','smaller')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, code)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.units_of_measure TO authenticated;
GRANT ALL ON public.units_of_measure TO service_role;
ALTER TABLE public.units_of_measure ENABLE ROW LEVEL SECURITY;
CREATE POLICY uom_select ON public.units_of_measure FOR SELECT TO authenticated USING (is_org_member(auth.uid(), organization_id));
CREATE POLICY uom_insert ON public.units_of_measure FOR INSERT TO authenticated WITH CHECK (is_org_member(auth.uid(), organization_id));
CREATE POLICY uom_update ON public.units_of_measure FOR UPDATE TO authenticated USING (is_org_member(auth.uid(), organization_id)) WITH CHECK (is_org_member(auth.uid(), organization_id));
CREATE POLICY uom_delete ON public.units_of_measure FOR DELETE TO authenticated USING (is_org_member(auth.uid(), organization_id));

ALTER TABLE public.uom_categories
  ADD CONSTRAINT uom_categories_reference_uom_fk
  FOREIGN KEY (reference_uom_id) REFERENCES public.units_of_measure(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.product_packaging (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  name text NOT NULL,
  qty_in_base_uom numeric NOT NULL CHECK (qty_in_base_uom > 0),
  barcode_id uuid REFERENCES public.product_identifiers(id) ON DELETE SET NULL,
  is_purchase_default boolean NOT NULL DEFAULT false,
  is_sales_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, name)
);
CREATE INDEX idx_product_packaging_product ON public.product_packaging(product_id);
CREATE INDEX idx_product_packaging_barcode ON public.product_packaging(barcode_id) WHERE barcode_id IS NOT NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_packaging TO authenticated;
GRANT ALL ON public.product_packaging TO service_role;
ALTER TABLE public.product_packaging ENABLE ROW LEVEL SECURITY;
CREATE POLICY pkg_select ON public.product_packaging FOR SELECT TO authenticated USING (is_org_member(auth.uid(), organization_id));
CREATE POLICY pkg_insert ON public.product_packaging FOR INSERT TO authenticated WITH CHECK (is_org_member(auth.uid(), organization_id));
CREATE POLICY pkg_update ON public.product_packaging FOR UPDATE TO authenticated USING (is_org_member(auth.uid(), organization_id)) WITH CHECK (is_org_member(auth.uid(), organization_id));
CREATE POLICY pkg_delete ON public.product_packaging FOR DELETE TO authenticated USING (is_org_member(auth.uid(), organization_id));

-- updated_at triggers
CREATE TRIGGER trg_uom_categories_updated_at BEFORE UPDATE ON public.uom_categories
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_units_of_measure_updated_at BEFORE UPDATE ON public.units_of_measure
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_product_packaging_updated_at BEFORE UPDATE ON public.product_packaging
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Seed per-business defaults (Count + Weight categories, base + common UoMs)
CREATE OR REPLACE FUNCTION public.seed_default_uom_for_business(p_business_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_count_cat uuid;
  v_weight_cat uuid;
  v_piece uuid;
  v_kg uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.businesses WHERE id = p_business_id;
  IF v_org IS NULL THEN RETURN; END IF;

  -- Count category
  INSERT INTO public.uom_categories (organization_id, business_id, name)
  VALUES (v_org, p_business_id, 'Count')
  ON CONFLICT (business_id, name) DO NOTHING
  RETURNING id INTO v_count_cat;
  IF v_count_cat IS NULL THEN
    SELECT id INTO v_count_cat FROM public.uom_categories WHERE business_id=p_business_id AND name='Count';
  END IF;

  INSERT INTO public.units_of_measure (organization_id, business_id, category_id, code, name, factor_to_reference, rounding, uom_type)
  VALUES (v_org, p_business_id, v_count_cat, 'PCE', 'Piece', 1, 1, 'reference')
  ON CONFLICT (business_id, code) DO NOTHING
  RETURNING id INTO v_piece;
  IF v_piece IS NULL THEN
    SELECT id INTO v_piece FROM public.units_of_measure WHERE business_id=p_business_id AND code='PCE';
  END IF;

  UPDATE public.uom_categories SET reference_uom_id = v_piece WHERE id = v_count_cat AND reference_uom_id IS NULL;

  INSERT INTO public.units_of_measure (organization_id, business_id, category_id, code, name, factor_to_reference, rounding, uom_type) VALUES
    (v_org, p_business_id, v_count_cat, 'DOZ',   'Dozen',   12,  1, 'bigger'),
    (v_org, p_business_id, v_count_cat, 'PACK',  'Pack',     6,  1, 'bigger'),
    (v_org, p_business_id, v_count_cat, 'CTN',   'Carton',  24,  1, 'bigger'),
    (v_org, p_business_id, v_count_cat, 'BOX',   'Box',     10,  1, 'bigger')
  ON CONFLICT (business_id, code) DO NOTHING;

  -- Weight category
  INSERT INTO public.uom_categories (organization_id, business_id, name)
  VALUES (v_org, p_business_id, 'Weight')
  ON CONFLICT (business_id, name) DO NOTHING
  RETURNING id INTO v_weight_cat;
  IF v_weight_cat IS NULL THEN
    SELECT id INTO v_weight_cat FROM public.uom_categories WHERE business_id=p_business_id AND name='Weight';
  END IF;

  INSERT INTO public.units_of_measure (organization_id, business_id, category_id, code, name, factor_to_reference, rounding, uom_type)
  VALUES (v_org, p_business_id, v_weight_cat, 'KG', 'Kilogram', 1, 0.001, 'reference')
  ON CONFLICT (business_id, code) DO NOTHING
  RETURNING id INTO v_kg;
  IF v_kg IS NULL THEN
    SELECT id INTO v_kg FROM public.units_of_measure WHERE business_id=p_business_id AND code='KG';
  END IF;

  UPDATE public.uom_categories SET reference_uom_id = v_kg WHERE id = v_weight_cat AND reference_uom_id IS NULL;

  INSERT INTO public.units_of_measure (organization_id, business_id, category_id, code, name, factor_to_reference, rounding, uom_type) VALUES
    (v_org, p_business_id, v_weight_cat, 'G',  'Gram',     0.001, 0.001, 'smaller'),
    (v_org, p_business_id, v_weight_cat, 'LB', 'Pound',    0.45359237, 0.001, 'smaller'),
    (v_org, p_business_id, v_weight_cat, 'TON','Tonne',    1000, 0.001, 'bigger')
  ON CONFLICT (business_id, code) DO NOTHING;
END;
$$;

-- Seed existing businesses
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM public.businesses LOOP
    PERFORM public.seed_default_uom_for_business(r.id);
  END LOOP;
END $$;

-- Auto-seed new businesses
CREATE OR REPLACE FUNCTION public.tg_seed_uom_on_business_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.seed_default_uom_for_business(NEW.id);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_seed_uom_on_business_insert ON public.businesses;
CREATE TRIGGER trg_seed_uom_on_business_insert
  AFTER INSERT ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION public.tg_seed_uom_on_business_insert();

-- Products: UoM columns
ALTER TABLE public.products
  ADD COLUMN base_uom_id     uuid REFERENCES public.units_of_measure(id),
  ADD COLUMN sales_uom_id    uuid REFERENCES public.units_of_measure(id),
  ADD COLUMN purchase_uom_id uuid REFERENCES public.units_of_measure(id);
CREATE INDEX idx_products_base_uom ON public.products(base_uom_id) WHERE base_uom_id IS NOT NULL;

-- Default product UoM trigger: when null on insert, pick the business's
-- reference UoM (PCE for normal products, KG for is_weighted)
CREATE OR REPLACE FUNCTION public.tg_default_product_uom()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uom uuid; v_code text;
BEGIN
  IF NEW.base_uom_id IS NOT NULL THEN RETURN NEW; END IF;
  v_code := CASE WHEN NEW.is_weighted THEN 'KG' ELSE 'PCE' END;
  SELECT id INTO v_uom FROM public.units_of_measure
    WHERE business_id = NEW.business_id AND code = v_code LIMIT 1;
  IF v_uom IS NULL THEN
    PERFORM public.seed_default_uom_for_business(NEW.business_id);
    SELECT id INTO v_uom FROM public.units_of_measure
      WHERE business_id = NEW.business_id AND code = v_code LIMIT 1;
  END IF;
  NEW.base_uom_id := v_uom;
  IF NEW.sales_uom_id IS NULL THEN NEW.sales_uom_id := v_uom; END IF;
  IF NEW.purchase_uom_id IS NULL THEN NEW.purchase_uom_id := v_uom; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_default_product_uom ON public.products;
CREATE TRIGGER trg_default_product_uom
  BEFORE INSERT ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.tg_default_product_uom();

-- ============= PHASE 2: LINE TABLE NORMALIZATION =============

-- Add display_uom_id + display_quantity + packaging_id to every line table.
-- Existing `quantity` columns remain canonical (in base_uom).
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'invoice_items','sales_order_items','purchase_order_items',
    'goods_receipt_items','pos_transaction_items',
    'stock_adjustment_items','stock_transfer_items'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE public.%I
      ADD COLUMN IF NOT EXISTS display_uom_id uuid REFERENCES public.units_of_measure(id),
      ADD COLUMN IF NOT EXISTS display_quantity numeric,
      ADD COLUMN IF NOT EXISTS packaging_id uuid REFERENCES public.product_packaging(id)', t);
  END LOOP;
END $$;

-- Audit-trail on the ledger itself (which packaging row produced a movement)
ALTER TABLE public.stock_movements
  ADD COLUMN IF NOT EXISTS source_packaging_id uuid REFERENCES public.product_packaging(id),
  ADD COLUMN IF NOT EXISTS source_uom_id       uuid REFERENCES public.units_of_measure(id);

-- ============= PHASE 3: SERVER PRIMITIVES =============

-- convert_uom: convert qty across UoMs sharing the same category.
CREATE OR REPLACE FUNCTION public.convert_uom(
  p_qty numeric, p_from_uom uuid, p_to_uom uuid
) RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  f_factor numeric; t_factor numeric;
  f_cat uuid; t_cat uuid; t_round numeric;
BEGIN
  IF p_from_uom = p_to_uom THEN RETURN p_qty; END IF;
  SELECT factor_to_reference, category_id INTO f_factor, f_cat
    FROM public.units_of_measure WHERE id = p_from_uom;
  SELECT factor_to_reference, category_id, rounding INTO t_factor, t_cat, t_round
    FROM public.units_of_measure WHERE id = p_to_uom;
  IF f_factor IS NULL OR t_factor IS NULL THEN
    RAISE EXCEPTION 'convert_uom: unknown UoM (from=%, to=%)', p_from_uom, p_to_uom;
  END IF;
  IF f_cat <> t_cat THEN
    RAISE EXCEPTION 'convert_uom: incompatible UoM categories';
  END IF;
  RETURN round((p_qty * f_factor / t_factor) / t_round) * t_round;
END $$;

-- resolve_barcode_v2: pack-aware barcode resolution unified across modules.
-- Returns product_id, the matched packaging row (if any), qty in base UoM,
-- and (for weighted-EAN scans) the embedded weight.
CREATE OR REPLACE FUNCTION public.resolve_barcode_v2(
  p_business_id uuid, p_branch_id uuid, p_code text
) RETURNS TABLE (
  product_id uuid,
  packaging_id uuid,
  qty_in_base_uom numeric,
  scan_weight numeric,
  match_source text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ident record;
  v_pkg record;
BEGIN
  -- 1) Direct packaging barcode hit
  SELECT pp.id AS pkg_id, pp.product_id, pp.qty_in_base_uom
    INTO v_pkg
    FROM public.product_packaging pp
    JOIN public.product_identifiers pi ON pi.id = pp.barcode_id
   WHERE pp.business_id = p_business_id
     AND (pi.code = p_code OR pi.code_norm = upper(regexp_replace(p_code,'\s','','g')))
   LIMIT 1;
  IF v_pkg.pkg_id IS NOT NULL THEN
    RETURN QUERY SELECT v_pkg.product_id, v_pkg.pkg_id, v_pkg.qty_in_base_uom, NULL::numeric, 'packaging'::text;
    RETURN;
  END IF;

  -- 2) Existing pos_resolve_barcode (handles weighted-EAN + pack_quantity + sku/gtin)
  RETURN QUERY
  SELECT
    (r->>'product_id')::uuid,
    NULL::uuid,
    COALESCE((r->>'scan_quantity')::numeric, 1),
    NULLIF(r->>'scan_weight','')::numeric,
    COALESCE(r->>'match_source','pos_resolve_barcode')
  FROM public.pos_resolve_barcode(p_business_id, p_branch_id, p_code) AS r
  LIMIT 1;
END $$;

GRANT EXECUTE ON FUNCTION public.convert_uom(numeric, uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_barcode_v2(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.seed_default_uom_for_business(uuid) TO service_role;
