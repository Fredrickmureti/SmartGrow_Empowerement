-- 1. Unique index for product_identifiers (case-insensitive, per business+kind)
CREATE UNIQUE INDEX IF NOT EXISTS product_identifiers_business_code_kind_uidx
  ON public.product_identifiers (business_id, lower(code), kind);

-- 2. Trigger fn: auto-seed product_identifiers from products.sku
CREATE OR REPLACE FUNCTION public.sync_product_sku_to_identifiers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sku text := NULLIF(trim(NEW.sku), '');
  v_old_sku text := CASE WHEN TG_OP = 'UPDATE' THEN NULLIF(trim(OLD.sku), '') ELSE NULL END;
BEGIN
  -- Remove old auto-seeded SKU identifier if SKU changed/cleared
  IF TG_OP = 'UPDATE' AND v_old_sku IS NOT NULL AND (v_sku IS NULL OR lower(v_sku) <> lower(v_old_sku)) THEN
    DELETE FROM public.product_identifiers
    WHERE product_id = NEW.id
      AND kind = 'sku'
      AND lower(code) = lower(v_old_sku);
  END IF;

  -- Insert/ensure identifier row for current SKU
  IF v_sku IS NOT NULL THEN
    INSERT INTO public.product_identifiers (
      organization_id, business_id, product_id, code, kind, is_primary
    )
    VALUES (
      NEW.organization_id, NEW.business_id, NEW.id, v_sku, 'sku',
      NOT EXISTS (
        SELECT 1 FROM public.product_identifiers
        WHERE product_id = NEW.id AND is_primary = true
      )
    )
    ON CONFLICT (business_id, lower(code), kind) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_product_sku_to_identifiers ON public.products;
CREATE TRIGGER trg_sync_product_sku_to_identifiers
AFTER INSERT OR UPDATE OF sku ON public.products
FOR EACH ROW
EXECUTE FUNCTION public.sync_product_sku_to_identifiers();

-- 3. Backfill: existing products with SKU but no matching identifier row
INSERT INTO public.product_identifiers (organization_id, business_id, product_id, code, kind, is_primary)
SELECT
  p.organization_id, p.business_id, p.id, trim(p.sku), 'sku',
  NOT EXISTS (SELECT 1 FROM public.product_identifiers pi2 WHERE pi2.product_id = p.id AND pi2.is_primary = true)
FROM public.products p
WHERE p.sku IS NOT NULL
  AND trim(p.sku) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM public.product_identifiers pi
    WHERE pi.business_id = p.business_id
      AND lower(pi.code) = lower(trim(p.sku))
      AND pi.kind = 'sku'
  )
ON CONFLICT (business_id, lower(code), kind) DO NOTHING;

-- 4. Update pos_resolve_barcode with products.sku fallback
CREATE OR REPLACE FUNCTION public.pos_resolve_barcode(p_business_id uuid, p_branch_id uuid, p_code text)
 RETURNS TABLE(product_id uuid, name text, sku text, selling_price numeric, cost_price numeric, tax_rate numeric, tax_rate_id uuid, tax_rate_name text, etims_tax_code text, category_id uuid, category_name text, branch_on_hand numeric, matched_kind product_identifier_kind, matched_code text, matched_rule_kind pos_barcode_rule_kind, scan_quantity numeric, scan_weight numeric, embedded_price numeric, is_weighted boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- Defence-in-depth: fall back to products.sku directly
  IF v_pid IS NULL THEN
    SELECT p.id, 'sku'::public.product_identifier_kind, p.sku, NULL::numeric
    INTO v_pid, v_matched_kind, v_matched_code, v_pack_qty
    FROM public.products p
    WHERE p.business_id = p_business_id
      AND p.is_active = true
      AND p.sku IS NOT NULL
      AND lower(trim(p.sku)) = lower(v_code)
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
END $function$;