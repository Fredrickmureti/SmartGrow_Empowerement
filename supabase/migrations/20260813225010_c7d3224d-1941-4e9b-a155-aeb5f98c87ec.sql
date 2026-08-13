-- ============================================================
-- Phase 1 — Product physical attributes
-- Canonical physical characteristics for the Product domain.
-- Reuses the existing UoM engine (units_of_measure / convert_uom).
-- No new conversion engine is introduced.
-- ============================================================

-- 1. Teach uom_categories which physical dimension they measure.
ALTER TABLE public.uom_categories
  ADD COLUMN IF NOT EXISTS dimension text;

UPDATE public.uom_categories
   SET dimension = CASE
     WHEN lower(name) IN ('count', 'unit', 'units', 'quantity') THEN 'count'
     WHEN lower(name) IN ('weight', 'mass')                     THEN 'mass'
     WHEN lower(name) IN ('volume', 'capacity')                 THEN 'volume'
     WHEN lower(name) IN ('length', 'distance', 'dimension')    THEN 'length'
     WHEN lower(name) IN ('area', 'surface')                    THEN 'area'
     ELSE 'other'
   END
 WHERE dimension IS NULL;

ALTER TABLE public.uom_categories
  ALTER COLUMN dimension SET DEFAULT 'other';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'uom_categories_dimension_chk'
       AND conrelid = 'public.uom_categories'::regclass
  ) THEN
    ALTER TABLE public.uom_categories
      ADD CONSTRAINT uom_categories_dimension_chk
      CHECK (dimension IN ('count','mass','volume','length','area','other'));
  END IF;
END $$;

ALTER TABLE public.uom_categories
  ALTER COLUMN dimension SET NOT NULL;

COMMENT ON COLUMN public.uom_categories.dimension IS
  'Physical dimension this UoM category measures. Drives which units a physical attribute may use.';

-- 2. Extend the canonical seeder with Volume + Length families.
CREATE OR REPLACE FUNCTION public.seed_default_uom_for_business(p_business_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid;
  v_count_cat uuid;
  v_weight_cat uuid;
  v_volume_cat uuid;
  v_length_cat uuid;
  v_piece uuid;
  v_kg uuid;
  v_litre uuid;
  v_cm uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.businesses WHERE id = p_business_id;
  IF v_org IS NULL THEN RETURN; END IF;

  -- Count category ------------------------------------------------------
  INSERT INTO public.uom_categories (organization_id, business_id, name, dimension)
  VALUES (v_org, p_business_id, 'Count', 'count')
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

  -- Weight category -----------------------------------------------------
  INSERT INTO public.uom_categories (organization_id, business_id, name, dimension)
  VALUES (v_org, p_business_id, 'Weight', 'mass')
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

  -- Volume category -----------------------------------------------------
  INSERT INTO public.uom_categories (organization_id, business_id, name, dimension)
  VALUES (v_org, p_business_id, 'Volume', 'volume')
  ON CONFLICT (business_id, name) DO NOTHING
  RETURNING id INTO v_volume_cat;
  IF v_volume_cat IS NULL THEN
    SELECT id INTO v_volume_cat FROM public.uom_categories WHERE business_id=p_business_id AND name='Volume';
  END IF;
  UPDATE public.uom_categories SET dimension = 'volume' WHERE id = v_volume_cat;

  INSERT INTO public.units_of_measure (organization_id, business_id, category_id, code, name, factor_to_reference, rounding, uom_type)
  VALUES (v_org, p_business_id, v_volume_cat, 'L', 'Litre', 1, 0.0001, 'reference')
  ON CONFLICT (business_id, code) DO NOTHING
  RETURNING id INTO v_litre;
  IF v_litre IS NULL THEN
    SELECT id INTO v_litre FROM public.units_of_measure WHERE business_id=p_business_id AND code='L';
  END IF;
  UPDATE public.uom_categories SET reference_uom_id = v_litre WHERE id = v_volume_cat AND reference_uom_id IS NULL;

  INSERT INTO public.units_of_measure (organization_id, business_id, category_id, code, name, factor_to_reference, rounding, uom_type) VALUES
    (v_org, p_business_id, v_volume_cat, 'ML',  'Millilitre',  0.001, 0.0001, 'smaller'),
    (v_org, p_business_id, v_volume_cat, 'CM3', 'Cubic centimetre', 0.001, 0.0001, 'smaller'),
    (v_org, p_business_id, v_volume_cat, 'M3',  'Cubic metre', 1000,  0.0001, 'bigger')
  ON CONFLICT (business_id, code) DO NOTHING;

  -- Length category -----------------------------------------------------
  INSERT INTO public.uom_categories (organization_id, business_id, name, dimension)
  VALUES (v_org, p_business_id, 'Length', 'length')
  ON CONFLICT (business_id, name) DO NOTHING
  RETURNING id INTO v_length_cat;
  IF v_length_cat IS NULL THEN
    SELECT id INTO v_length_cat FROM public.uom_categories WHERE business_id=p_business_id AND name='Length';
  END IF;
  UPDATE public.uom_categories SET dimension = 'length' WHERE id = v_length_cat;

  INSERT INTO public.units_of_measure (organization_id, business_id, category_id, code, name, factor_to_reference, rounding, uom_type)
  VALUES (v_org, p_business_id, v_length_cat, 'CM', 'Centimetre', 1, 0.01, 'reference')
  ON CONFLICT (business_id, code) DO NOTHING
  RETURNING id INTO v_cm;
  IF v_cm IS NULL THEN
    SELECT id INTO v_cm FROM public.units_of_measure WHERE business_id=p_business_id AND code='CM';
  END IF;
  UPDATE public.uom_categories SET reference_uom_id = v_cm WHERE id = v_length_cat AND reference_uom_id IS NULL;

  INSERT INTO public.units_of_measure (organization_id, business_id, category_id, code, name, factor_to_reference, rounding, uom_type) VALUES
    (v_org, p_business_id, v_length_cat, 'MM', 'Millimetre', 0.1,  0.01, 'smaller'),
    (v_org, p_business_id, v_length_cat, 'M',  'Metre',      100,  0.01, 'bigger'),
    (v_org, p_business_id, v_length_cat, 'IN', 'Inch',       2.54, 0.01, 'smaller'),
    (v_org, p_business_id, v_length_cat, 'FT', 'Foot',       30.48, 0.01, 'bigger')
  ON CONFLICT (business_id, code) DO NOTHING;
END;
$function$;

-- Backfill Volume + Length for existing businesses that already have UoM data.
DO $$
DECLARE b uuid;
BEGIN
  FOR b IN SELECT DISTINCT business_id FROM public.uom_categories LOOP
    PERFORM public.seed_default_uom_for_business(b);
  END LOOP;
END $$;

-- 3. The physical attributes table -------------------------------------
CREATE TABLE IF NOT EXISTS public.product_physical_attributes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id        uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  product_id         uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  -- NULL packaging_id == the product's base unit of measure.
  packaging_id       uuid REFERENCES public.product_packaging(id) ON DELETE CASCADE,

  net_weight         numeric CHECK (net_weight   > 0),
  net_weight_uom_id  uuid REFERENCES public.units_of_measure(id),
  tare_weight        numeric CHECK (tare_weight  >= 0),
  tare_weight_uom_id uuid REFERENCES public.units_of_measure(id),
  gross_weight       numeric CHECK (gross_weight > 0),
  gross_weight_uom_id uuid REFERENCES public.units_of_measure(id),

  volume             numeric CHECK (volume > 0),
  volume_uom_id      uuid REFERENCES public.units_of_measure(id),

  length             numeric CHECK (length > 0),
  width              numeric CHECK (width  > 0),
  height             numeric CHECK (height > 0),
  dimension_uom_id   uuid REFERENCES public.units_of_measure(id),

  notes              text,
  created_by         uuid,
  updated_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.product_physical_attributes IS
  'Canonical physical characteristics of a product at a given packaging level (NULL packaging_id = base unit). Every measure carries its own UoM; conversion is always via convert_uom. Landed Cost, Warehouse and Logistics consume resolve_product_measure and never store their own copies.';

CREATE UNIQUE INDEX IF NOT EXISTS product_physical_attributes_base_uidx
  ON public.product_physical_attributes (product_id)
  WHERE packaging_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS product_physical_attributes_pack_uidx
  ON public.product_physical_attributes (product_id, packaging_id)
  WHERE packaging_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ppa_business_product
  ON public.product_physical_attributes (business_id, product_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_physical_attributes TO authenticated;
GRANT ALL ON public.product_physical_attributes TO service_role;

ALTER TABLE public.product_physical_attributes ENABLE ROW LEVEL SECURITY;

CREATE POLICY ppa_select_perm ON public.product_physical_attributes
  FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'products', 'read'));

CREATE POLICY ppa_insert_perm ON public.product_physical_attributes
  FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'products', 'create'));

CREATE POLICY ppa_update_perm ON public.product_physical_attributes
  FOR UPDATE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'products', 'write'))
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'products', 'write'));

CREATE POLICY ppa_delete_perm ON public.product_physical_attributes
  FOR DELETE TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'products', 'delete'));

CREATE TRIGGER update_ppa_updated_at
  BEFORE UPDATE ON public.product_physical_attributes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 4. Integrity guard ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_physical_attribute_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_prod_business uuid;
  v_prod_org uuid;
  v_pack_product uuid;
  v_gross_expected numeric;
  v_tol numeric;
BEGIN
  SELECT business_id, organization_id INTO v_prod_business, v_prod_org
    FROM public.products WHERE id = NEW.product_id;
  IF v_prod_business IS NULL AND v_prod_org IS NULL THEN
    RAISE EXCEPTION 'PHYSICAL_ATTR_INVALID: product % does not exist', NEW.product_id;
  END IF;
  IF v_prod_business IS NOT NULL AND NEW.business_id <> v_prod_business THEN
    RAISE EXCEPTION 'PHYSICAL_ATTR_TENANT_MISMATCH: business does not match the product';
  END IF;
  IF NEW.organization_id <> v_prod_org THEN
    RAISE EXCEPTION 'PHYSICAL_ATTR_TENANT_MISMATCH: organization does not match the product';
  END IF;

  IF NEW.packaging_id IS NOT NULL THEN
    SELECT product_id INTO v_pack_product
      FROM public.product_packaging WHERE id = NEW.packaging_id;
    IF v_pack_product IS DISTINCT FROM NEW.product_id THEN
      RAISE EXCEPTION 'PHYSICAL_ATTR_INVALID: packaging level does not belong to this product';
    END IF;
  END IF;

  -- Value and unit are inseparable.
  IF (NEW.net_weight   IS NULL) <> (NEW.net_weight_uom_id   IS NULL)
  OR (NEW.tare_weight  IS NULL) <> (NEW.tare_weight_uom_id  IS NULL)
  OR (NEW.gross_weight IS NULL) <> (NEW.gross_weight_uom_id IS NULL)
  OR (NEW.volume       IS NULL) <> (NEW.volume_uom_id       IS NULL) THEN
    RAISE EXCEPTION 'PHYSICAL_ATTR_UOM_REQUIRED: a measurement and its unit of measure must be provided together';
  END IF;

  IF (NEW.length IS NOT NULL OR NEW.width IS NOT NULL OR NEW.height IS NOT NULL)
     <> (NEW.dimension_uom_id IS NOT NULL) THEN
    RAISE EXCEPTION 'PHYSICAL_ATTR_UOM_REQUIRED: dimensions require a length unit of measure';
  END IF;

  -- Every unit must belong to this business and to the right dimension.
  PERFORM public.assert_uom_dimension(NEW.business_id, NEW.net_weight_uom_id,   'mass',   'net weight');
  PERFORM public.assert_uom_dimension(NEW.business_id, NEW.tare_weight_uom_id,  'mass',   'packaging (tare) weight');
  PERFORM public.assert_uom_dimension(NEW.business_id, NEW.gross_weight_uom_id, 'mass',   'gross weight');
  PERFORM public.assert_uom_dimension(NEW.business_id, NEW.volume_uom_id,       'volume', 'volume');
  PERFORM public.assert_uom_dimension(NEW.business_id, NEW.dimension_uom_id,    'length', 'dimensions');

  -- Gross weight is derived when absent, validated when supplied.
  IF NEW.net_weight IS NOT NULL THEN
    v_gross_expected := NEW.net_weight
      + COALESCE(public.convert_uom(NEW.tare_weight, NEW.tare_weight_uom_id, NEW.net_weight_uom_id), 0);

    IF NEW.gross_weight IS NULL THEN
      NEW.gross_weight        := v_gross_expected;
      NEW.gross_weight_uom_id := NEW.net_weight_uom_id;
    ELSE
      v_tol := GREATEST(v_gross_expected * 0.005, 0.0001);
      IF abs(public.convert_uom(NEW.gross_weight, NEW.gross_weight_uom_id, NEW.net_weight_uom_id)
             - v_gross_expected) > v_tol THEN
        RAISE EXCEPTION
          'PHYSICAL_ATTR_GROSS_MISMATCH: gross weight must equal net weight plus packaging weight (expected about % in the net weight unit)',
          round(v_gross_expected, 4);
      END IF;
    END IF;
  ELSIF NEW.gross_weight IS NOT NULL AND NEW.tare_weight IS NOT NULL THEN
    IF public.convert_uom(NEW.gross_weight, NEW.gross_weight_uom_id, NEW.tare_weight_uom_id) <= NEW.tare_weight THEN
      RAISE EXCEPTION 'PHYSICAL_ATTR_GROSS_MISMATCH: gross weight must exceed the packaging (tare) weight';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.assert_uom_dimension(
  p_business uuid,
  p_uom uuid,
  p_dimension text,
  p_label text
) RETURNS void
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_dim text;
  v_business uuid;
BEGIN
  IF p_uom IS NULL THEN RETURN; END IF;
  SELECT c.dimension, u.business_id INTO v_dim, v_business
    FROM public.units_of_measure u
    JOIN public.uom_categories c ON c.id = u.category_id
   WHERE u.id = p_uom;
  IF v_dim IS NULL THEN
    RAISE EXCEPTION 'PHYSICAL_ATTR_UOM_UNKNOWN: the unit of measure chosen for % does not exist', p_label;
  END IF;
  IF v_business IS DISTINCT FROM p_business THEN
    RAISE EXCEPTION 'PHYSICAL_ATTR_UOM_TENANT: the unit of measure chosen for % belongs to another business', p_label;
  END IF;
  IF v_dim <> p_dimension THEN
    RAISE EXCEPTION 'PHYSICAL_ATTR_UOM_DIMENSION: % must use a % unit of measure', p_label, p_dimension;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.assert_uom_dimension(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_uom_dimension(uuid, uuid, text, text) TO authenticated, service_role;

CREATE TRIGGER trg_enforce_physical_attribute_integrity
  BEFORE INSERT OR UPDATE ON public.product_physical_attributes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_physical_attribute_integrity();

-- 5. The single measurement read seam ---------------------------------
CREATE OR REPLACE FUNCTION public.resolve_product_measure(
  p_business   uuid,
  p_product    uuid,
  p_packaging  uuid,
  p_measure    text,
  p_target_uom uuid DEFAULT NULL
) RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_value numeric;
  v_uom   uuid;
  v_dim   text;
  v_target uuid := p_target_uom;
  v_pack_qty numeric;
BEGIN
  IF p_measure NOT IN ('net_weight','tare_weight','gross_weight','volume') THEN
    RAISE EXCEPTION 'resolve_product_measure: unsupported measure %', p_measure;
  END IF;

  v_dim := CASE WHEN p_measure = 'volume' THEN 'volume' ELSE 'mass' END;

  -- Exact level first.
  SELECT CASE p_measure
           WHEN 'net_weight'   THEN a.net_weight
           WHEN 'tare_weight'  THEN a.tare_weight
           WHEN 'gross_weight' THEN a.gross_weight
           ELSE a.volume
         END,
         CASE p_measure
           WHEN 'net_weight'   THEN a.net_weight_uom_id
           WHEN 'tare_weight'  THEN a.tare_weight_uom_id
           WHEN 'gross_weight' THEN a.gross_weight_uom_id
           ELSE a.volume_uom_id
         END
    INTO v_value, v_uom
    FROM public.product_physical_attributes a
   WHERE a.product_id = p_product
     AND a.packaging_id IS NOT DISTINCT FROM p_packaging;

  -- Fall back from a packaging level to base unit x pack size.
  IF v_value IS NULL AND p_packaging IS NOT NULL THEN
    SELECT qty_in_base_uom INTO v_pack_qty
      FROM public.product_packaging WHERE id = p_packaging;

    SELECT CASE p_measure
             WHEN 'net_weight'   THEN a.net_weight
             WHEN 'tare_weight'  THEN a.tare_weight
             WHEN 'gross_weight' THEN a.gross_weight
             ELSE a.volume
           END,
           CASE p_measure
             WHEN 'net_weight'   THEN a.net_weight_uom_id
             WHEN 'tare_weight'  THEN a.tare_weight_uom_id
             WHEN 'gross_weight' THEN a.gross_weight_uom_id
             ELSE a.volume_uom_id
           END
      INTO v_value, v_uom
      FROM public.product_physical_attributes a
     WHERE a.product_id = p_product AND a.packaging_id IS NULL;

    IF v_value IS NOT NULL AND COALESCE(v_pack_qty, 0) > 0 THEN
      v_value := v_value * v_pack_qty;
    END IF;
  END IF;

  IF v_value IS NULL OR v_uom IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_target IS NULL THEN
    SELECT c.reference_uom_id INTO v_target
      FROM public.uom_categories c
     WHERE c.business_id = p_business AND c.dimension = v_dim
     LIMIT 1;
  END IF;

  IF v_target IS NULL THEN
    RETURN v_value; -- no reference unit configured; return as captured
  END IF;

  RETURN public.convert_uom(v_value, v_uom, v_target);
END;
$function$;

COMMENT ON FUNCTION public.resolve_product_measure(uuid, uuid, uuid, text, uuid) IS
  'The ONLY way to read a product physical measure. Resolves packaging level -> base unit x pack size, then converts via convert_uom. Returns NULL when the fact is unknown so callers can fail closed.';

REVOKE ALL ON FUNCTION public.resolve_product_measure(uuid, uuid, uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_product_measure(uuid, uuid, uuid, text, uuid) TO authenticated, service_role;

-- 6. Migrate legacy POS scale weights into the canonical home.
DO $$
DECLARE r record; v_uom uuid;
BEGIN
  FOR r IN
    SELECT p.id, p.organization_id, p.business_id, p.tare_weight, p.weight_unit
      FROM public.products p
     WHERE p.tare_weight IS NOT NULL AND p.tare_weight > 0 AND p.business_id IS NOT NULL
  LOOP
    SELECT u.id INTO v_uom
      FROM public.units_of_measure u
      JOIN public.uom_categories c ON c.id = u.category_id
     WHERE u.business_id = r.business_id
       AND c.dimension = 'mass'
       AND (upper(u.code) = upper(COALESCE(r.weight_unit, 'KG')) OR u.uom_type = 'reference')
     ORDER BY (upper(u.code) = upper(COALESCE(r.weight_unit, 'KG'))) DESC
     LIMIT 1;

    IF v_uom IS NOT NULL THEN
      INSERT INTO public.product_physical_attributes
        (organization_id, business_id, product_id, packaging_id, tare_weight, tare_weight_uom_id, notes)
      VALUES (r.organization_id, r.business_id, r.id, NULL, r.tare_weight, v_uom,
              'Migrated from products.tare_weight / products.weight_unit')
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
END $$;

COMMENT ON COLUMN public.products.tare_weight IS
  'LEGACY (POS scale barcodes only). Canonical tare weight lives in product_physical_attributes; read it via resolve_product_measure.';
COMMENT ON COLUMN public.products.weight_unit IS
  'LEGACY free-text unit for POS scale barcodes. Do not use for logistics; product_physical_attributes carries UoM-referenced measures.';
