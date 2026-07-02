-- Fix: pos_resolve_barcode threw "Returned type character varying(1) does not
-- match expected type text in column 9" on EVERY call because tax_rates.etims_tax_code
-- is varchar(1) while the function declares the column as text. The POS frontend
-- caught the error and rendered it to the cashier as "invalid barcode", masking
-- the real failure for every scanned product.

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
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
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

  -- 1) Try per-business prefix rules (weighted / PLU labels)
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

  -- 2) Direct identifier match
  IF v_pid IS NULL THEN
    SELECT pi.product_id, pi.kind, pi.code, pi.pack_quantity
    INTO v_pid, v_matched_kind, v_matched_code, v_pack_qty
    FROM public.product_identifiers pi
    WHERE pi.business_id = p_business_id
      AND lower(pi.code) = lower(v_code)
    LIMIT 1;
  END IF;

  -- 3) Defence-in-depth: fall back to products.sku directly
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
    p.id,
    p.name::text,
    p.sku::text,
    p.unit_price,
    p.cost_price,
    COALESCE(tr.rate, p.tax_rate),
    COALESCE(tr.id, p.tax_rate_id),
    tr.name::text,
    tr.etims_tax_code::text,             -- explicit cast — root cause fix
    p.category_id,
    pc.name::text,
    COALESCE(
      (SELECT ws.quantity FROM public.warehouse_stock ws
        WHERE ws.product_id = p.id AND ws.branch_id = p_branch_id LIMIT 1), 0
    )::numeric,
    v_matched_kind,
    v_matched_code::text,
    v_rule_kind,
    v_qty,
    v_weight,
    v_price,
    COALESCE(p.is_weighted, false)
  FROM public.products p
  LEFT JOIN public.tax_rates tr ON tr.id = p.tax_rate_id
  LEFT JOIN public.product_categories pc ON pc.id = p.category_id
  WHERE p.id = v_pid AND p.is_active = true;
END
$function$;

GRANT EXECUTE ON FUNCTION public.pos_resolve_barcode(uuid, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.pos_resolve_barcode IS
  'POS scanner resolution. Returns the product matching a scanned barcode for the given business+branch, applying any per-business prefix rule for weighted/PLU labels. Empty result = unknown code. All returned text columns are explicitly cast to text so the function does not abort on varchar(N) source columns (e.g. tax_rates.etims_tax_code).';