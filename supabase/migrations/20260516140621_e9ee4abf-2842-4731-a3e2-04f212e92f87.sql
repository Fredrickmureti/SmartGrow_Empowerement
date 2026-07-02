
-- =========================================================================
-- Step 1: Product identifier model + scanner resolution RPC
-- =========================================================================

DO $$ BEGIN
  CREATE TYPE public.product_identifier_kind AS ENUM (
    'gtin', 'sku', 'pack', 'supplier', 'internal', 'plu', 'alias'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.pos_barcode_rule_kind AS ENUM (
    'weighted_price', 'weighted_qty', 'plu'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- product_identifiers ----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.product_identifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  code text NOT NULL,
  kind public.product_identifier_kind NOT NULL DEFAULT 'gtin',
  is_primary boolean NOT NULL DEFAULT false,
  pack_quantity numeric NULL,
  notes text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS product_identifiers_business_code_uidx
  ON public.product_identifiers (business_id, lower(code));
CREATE INDEX IF NOT EXISTS product_identifiers_product_idx
  ON public.product_identifiers (product_id);
CREATE INDEX IF NOT EXISTS product_identifiers_org_idx
  ON public.product_identifiers (organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS product_identifiers_one_primary_per_product_uidx
  ON public.product_identifiers (product_id) WHERE is_primary = true;

ALTER TABLE public.product_identifiers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "product_identifiers_select" ON public.product_identifiers;
CREATE POLICY "product_identifiers_select"
ON public.product_identifiers FOR SELECT TO authenticated
USING (public.is_org_member(auth.uid(), organization_id));

DROP POLICY IF EXISTS "product_identifiers_insert" ON public.product_identifiers;
CREATE POLICY "product_identifiers_insert"
ON public.product_identifiers FOR INSERT TO authenticated
WITH CHECK (public.is_org_member(auth.uid(), organization_id));

DROP POLICY IF EXISTS "product_identifiers_update" ON public.product_identifiers;
CREATE POLICY "product_identifiers_update"
ON public.product_identifiers FOR UPDATE TO authenticated
USING (public.is_org_member(auth.uid(), organization_id))
WITH CHECK (public.is_org_member(auth.uid(), organization_id));

DROP POLICY IF EXISTS "product_identifiers_delete" ON public.product_identifiers;
CREATE POLICY "product_identifiers_delete"
ON public.product_identifiers FOR DELETE TO authenticated
USING (public.is_org_member(auth.uid(), organization_id));

DROP TRIGGER IF EXISTS trg_product_identifiers_updated_at ON public.product_identifiers;
CREATE TRIGGER trg_product_identifiers_updated_at
BEFORE UPDATE ON public.product_identifiers
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- pos_barcode_rules ------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pos_barcode_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  name text NOT NULL,
  prefix text NOT NULL,
  kind public.pos_barcode_rule_kind NOT NULL,
  item_code_start int NOT NULL DEFAULT 2,
  item_code_length int NOT NULL DEFAULT 5,
  embedded_value_start int NULL,
  embedded_value_length int NULL,
  embedded_value_divisor numeric NOT NULL DEFAULT 100,
  total_length int NOT NULL DEFAULT 13,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS pos_barcode_rules_business_prefix_uidx
  ON public.pos_barcode_rules (business_id, prefix) WHERE is_active = true;

ALTER TABLE public.pos_barcode_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pos_barcode_rules_select" ON public.pos_barcode_rules;
CREATE POLICY "pos_barcode_rules_select"
ON public.pos_barcode_rules FOR SELECT TO authenticated
USING (public.is_org_member(auth.uid(), organization_id));

DROP POLICY IF EXISTS "pos_barcode_rules_write" ON public.pos_barcode_rules;
CREATE POLICY "pos_barcode_rules_write"
ON public.pos_barcode_rules FOR ALL TO authenticated
USING (public.is_org_member(auth.uid(), organization_id))
WITH CHECK (public.is_org_member(auth.uid(), organization_id));

DROP TRIGGER IF EXISTS trg_pos_barcode_rules_updated_at ON public.pos_barcode_rules;
CREATE TRIGGER trg_pos_barcode_rules_updated_at
BEFORE UPDATE ON public.pos_barcode_rules
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Backfill ---------------------------------------------------------------
INSERT INTO public.product_identifiers (organization_id, business_id, product_id, code, kind, is_primary)
SELECT p.organization_id, p.business_id, p.id, p.sku, 'sku', true
FROM public.products p
WHERE p.sku IS NOT NULL AND length(trim(p.sku)) > 0
ON CONFLICT (business_id, lower(code)) DO NOTHING;

INSERT INTO public.product_identifiers (organization_id, business_id, product_id, code, kind, is_primary)
SELECT p.organization_id, p.business_id, p.id, p.plu_code, 'plu',
       NOT EXISTS (SELECT 1 FROM public.product_identifiers pi WHERE pi.product_id = p.id AND pi.is_primary)
FROM public.products p
WHERE p.plu_code IS NOT NULL AND length(trim(p.plu_code)) > 0
ON CONFLICT (business_id, lower(code)) DO NOTHING;

-- Sync trigger -----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_product_identifiers_from_product()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.sku IS NOT NULL AND length(trim(NEW.sku)) > 0 THEN
    INSERT INTO public.product_identifiers (organization_id, business_id, product_id, code, kind, is_primary)
    VALUES (NEW.organization_id, NEW.business_id, NEW.id, NEW.sku, 'sku',
            NOT EXISTS (SELECT 1 FROM public.product_identifiers WHERE product_id = NEW.id AND is_primary))
    ON CONFLICT (business_id, lower(code)) DO NOTHING;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.sku IS DISTINCT FROM NEW.sku AND OLD.sku IS NOT NULL THEN
    DELETE FROM public.product_identifiers
    WHERE product_id = NEW.id AND kind = 'sku' AND lower(code) = lower(OLD.sku)
      AND (NEW.sku IS NULL OR lower(NEW.sku) <> lower(OLD.sku));
  END IF;

  IF NEW.plu_code IS NOT NULL AND length(trim(NEW.plu_code)) > 0 THEN
    INSERT INTO public.product_identifiers (organization_id, business_id, product_id, code, kind, is_primary)
    VALUES (NEW.organization_id, NEW.business_id, NEW.id, NEW.plu_code, 'plu', false)
    ON CONFLICT (business_id, lower(code)) DO NOTHING;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.plu_code IS DISTINCT FROM NEW.plu_code AND OLD.plu_code IS NOT NULL THEN
    DELETE FROM public.product_identifiers
    WHERE product_id = NEW.id AND kind = 'plu' AND lower(code) = lower(OLD.plu_code)
      AND (NEW.plu_code IS NULL OR lower(NEW.plu_code) <> lower(OLD.plu_code));
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_sync_product_identifiers ON public.products;
CREATE TRIGGER trg_sync_product_identifiers
AFTER INSERT OR UPDATE OF sku, plu_code ON public.products
FOR EACH ROW EXECUTE FUNCTION public.sync_product_identifiers_from_product();

-- pos_resolve_barcode RPC ------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_resolve_barcode(
  p_business_id uuid,
  p_branch_id uuid,
  p_code text
)
RETURNS TABLE (
  product_id uuid,
  name text,
  sku text,
  selling_price numeric,
  cost_price numeric,
  tax_rate numeric,
  tax_rate_id uuid,
  tax_rate_name text,
  etims_tax_code text,
  category_id uuid,
  category_name text,
  branch_on_hand numeric,
  matched_kind public.product_identifier_kind,
  matched_code text,
  matched_rule_kind public.pos_barcode_rule_kind,
  scan_quantity numeric,
  scan_weight numeric,
  embedded_price numeric,
  is_weighted boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_code text := trim(p_code);
  v_rule public.pos_barcode_rules%ROWTYPE;
  v_item_code text;
  v_embedded numeric;
  v_qty numeric := 1;
  v_weight numeric := NULL;
  v_price numeric := NULL;
  v_rule_kind public.pos_barcode_rule_kind := NULL;
  v_pid uuid;
  v_matched_kind public.product_identifier_kind;
  v_matched_code text;
  v_pack_qty numeric;
BEGIN
  IF v_code IS NULL OR length(v_code) = 0 THEN RETURN; END IF;

  SELECT * INTO v_rule
  FROM public.pos_barcode_rules r
  WHERE r.business_id = p_business_id
    AND r.is_active = true
    AND length(v_code) = r.total_length
    AND substring(v_code FROM 1 FOR length(r.prefix)) = r.prefix
  ORDER BY length(r.prefix) DESC
  LIMIT 1;

  IF FOUND THEN
    v_rule_kind := v_rule.kind;
    v_item_code := substring(v_code FROM v_rule.item_code_start FOR v_rule.item_code_length);

    IF v_rule.embedded_value_start IS NOT NULL AND v_rule.embedded_value_length IS NOT NULL THEN
      BEGIN
        v_embedded := substring(v_code FROM v_rule.embedded_value_start FOR v_rule.embedded_value_length)::numeric
                      / NULLIF(v_rule.embedded_value_divisor, 0);
      EXCEPTION WHEN OTHERS THEN v_embedded := NULL; END;

      IF v_rule.kind = 'weighted_price' THEN v_price := v_embedded;
      ELSIF v_rule.kind = 'weighted_qty' THEN v_weight := v_embedded;
      END IF;
    END IF;

    SELECT pi.product_id, pi.kind, pi.code, pi.pack_quantity
    INTO v_pid, v_matched_kind, v_matched_code, v_pack_qty
    FROM public.product_identifiers pi
    WHERE pi.business_id = p_business_id
      AND lower(pi.code) = lower(v_item_code)
    LIMIT 1;
  END IF;

  IF v_pid IS NULL THEN
    SELECT pi.product_id, pi.kind, pi.code, pi.pack_quantity
    INTO v_pid, v_matched_kind, v_matched_code, v_pack_qty
    FROM public.product_identifiers pi
    WHERE pi.business_id = p_business_id
      AND lower(pi.code) = lower(v_code)
    LIMIT 1;
  END IF;

  IF v_pid IS NULL THEN RETURN; END IF;

  IF v_matched_kind = 'pack' AND v_pack_qty IS NOT NULL AND v_pack_qty > 0 THEN
    v_qty := v_pack_qty;
  END IF;

  RETURN QUERY
  SELECT
    p.id, p.name, p.sku, p.unit_price, p.cost_price,
    COALESCE(tr.rate, p.tax_rate),
    COALESCE(tr.id, p.tax_rate_id),
    tr.name, tr.etims_tax_code,
    p.category_id, pc.name,
    COALESCE(
      (SELECT ws.quantity FROM public.warehouse_stock ws
        WHERE ws.product_id = p.id AND ws.branch_id = p_branch_id LIMIT 1), 0
    )::numeric,
    v_matched_kind, v_matched_code, v_rule_kind,
    v_qty, v_weight, v_price,
    COALESCE(p.is_weighted, false)
  FROM public.products p
  LEFT JOIN public.tax_rates tr ON tr.id = p.tax_rate_id
  LEFT JOIN public.product_categories pc ON pc.id = p.category_id
  WHERE p.id = v_pid AND p.is_active = true;
END $$;

GRANT EXECUTE ON FUNCTION public.pos_resolve_barcode(uuid, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.pos_resolve_barcode IS
  'POS scanner resolution. Returns the product matching a scanned barcode for the given business+branch, applying any per-business prefix rule for weighted/PLU labels. Empty result = unknown code.';
