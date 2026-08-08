CREATE OR REPLACE FUNCTION public.pos_resolve_scan(p_business_id uuid, p_branch_id uuid, p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_code text := btrim(coalesce(p_code, ''));
  v_rule public.pos_barcode_rules%ROWTYPE;
  v_item_code text; v_embedded numeric;
  v_weight numeric := NULL; v_price numeric := NULL;
  v_rule_kind public.pos_barcode_rule_kind := NULL;
  v_id record;
  v_have_id boolean := false;   -- v_id may never be assigned; reading an
                                -- unassigned record raises 55000.
  v_status text;
  v_product jsonb;
BEGIN
  IF length(v_code) = 0 THEN
    RETURN jsonb_build_object('status','not_found','code',v_code,'match_count',0);
  END IF;

  SELECT * INTO v_rule
  FROM public.pos_barcode_rules r
  WHERE r.business_id = p_business_id AND r.is_active = true
    AND length(v_code) = r.total_length
    AND substring(v_code FROM 1 FOR length(r.prefix)) = r.prefix
  ORDER BY length(r.prefix) DESC LIMIT 1;

  IF FOUND THEN
    v_rule_kind := v_rule.kind;
    v_item_code := substring(v_code FROM v_rule.item_code_start FOR v_rule.item_code_length);
    IF v_rule.embedded_value_start IS NOT NULL AND v_rule.embedded_value_length IS NOT NULL THEN
      BEGIN
        v_embedded := substring(v_code FROM v_rule.embedded_value_start FOR v_rule.embedded_value_length)::numeric
                      / NULLIF(v_rule.embedded_value_divisor, 0);
      EXCEPTION WHEN OTHERS THEN v_embedded := NULL; END;
      IF v_rule.kind = 'weighted_price' THEN v_price := v_embedded;
      ELSIF v_rule.kind = 'weighted_qty' THEN v_weight := v_embedded; END IF;
    END IF;

    SELECT * INTO v_id
      FROM public.resolve_product_identity(p_business_id, v_item_code, p_branch_id, false) LIMIT 1;
    v_have_id := FOUND;
  END IF;

  IF NOT v_have_id OR coalesce(v_id.status,'not_found') <> 'resolved' THEN
    SELECT * INTO v_id
      FROM public.resolve_product_identity(p_business_id, v_code, p_branch_id, false) LIMIT 1;
    v_have_id := FOUND;
    IF v_have_id THEN
      v_rule_kind := CASE WHEN coalesce(v_id.status,'not_found') = 'resolved' AND v_item_code IS NOT NULL
                          THEN NULL ELSE v_rule_kind END;
      IF coalesce(v_id.status,'not_found') = 'resolved' THEN
        v_weight := NULL; v_price := NULL;
      END IF;
    END IF;
  END IF;

  IF NOT v_have_id THEN
    RETURN jsonb_build_object('status','not_found','code',v_code,'match_count',0);
  END IF;

  v_status := coalesce(v_id.status, 'not_found');

  IF v_status <> 'resolved' THEN
    RETURN jsonb_build_object(
      'status', v_status,
      'code', v_code,
      'match_count', coalesce(v_id.match_count, 0),
      'product_name', v_id.product_name
    );
  END IF;

  SELECT jsonb_build_object(
      'product_id', p.id,
      'name', p.name::text,
      'sku', p.sku::text,
      'selling_price', p.unit_price,
      'cost_price', p.cost_price,
      'tax_rate', COALESCE(tr.rate, p.tax_rate),
      'tax_rate_id', COALESCE(tr.id, p.tax_rate_id),
      'tax_rate_name', tr.name::text,
      'etims_tax_code', tr.etims_tax_code::text,
      'category_id', p.category_id,
      'category_name', pc.name::text,
      'branch_on_hand', COALESCE((SELECT ws.quantity FROM public.warehouse_stock ws
                WHERE ws.product_id = p.id AND ws.branch_id = p_branch_id LIMIT 1), 0)::numeric,
      'is_weighted', COALESCE(p.is_weighted, false),
      'base_uom_id', p.base_uom_id
    ) INTO v_product
  FROM public.products p
  LEFT JOIN public.tax_rates tr ON tr.id = p.tax_rate_id
  LEFT JOIN public.product_categories pc ON pc.id = p.category_id
  WHERE p.id = v_id.product_id AND p.is_active = true;

  IF v_product IS NULL THEN
    RETURN jsonb_build_object(
      'status', 'inactive',
      'code', v_code,
      'match_count', coalesce(v_id.match_count, 0),
      'product_name', v_id.product_name
    );
  END IF;

  RETURN v_product
    || jsonb_build_object(
      'status', 'resolved',
      'code', v_code,
      'match_count', coalesce(v_id.match_count, 1),
      'identifier_id', v_id.identifier_id,
      'matched_kind', v_id.matched_kind,
      'matched_code', v_id.matched_code::text,
      'matched_rule_kind', v_rule_kind,
      'scan_quantity', COALESCE(v_id.qty_in_base_uom, 1)::numeric,
      'scan_weight', v_weight,
      'embedded_price', v_price,
      'packaging_id', v_id.packaging_id
    );
END $function$;