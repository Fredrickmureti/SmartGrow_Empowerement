-- ============================================================
-- Phase 3 — the resolver returns a DECISION, not just rows
-- ============================================================
DROP FUNCTION IF EXISTS public.resolve_product_identity(uuid, text, uuid);

CREATE FUNCTION public.resolve_product_identity(
  p_business_id uuid,
  p_code text,
  p_branch_id uuid DEFAULT NULL,
  p_allow_sku_fallback boolean DEFAULT false
)
RETURNS TABLE (
  status text,
  product_id uuid,
  product_name text,
  sku text,
  identifier_id uuid,
  matched_kind public.product_identifier_kind,
  matched_code text,
  packaging_id uuid,
  packaging_name text,
  qty_in_base_uom numeric,
  base_uom_id uuid,
  is_base_unit boolean,
  match_count integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_code text := btrim(coalesce(p_code, ''));
  v_norm text := upper(v_code);
  v_cands text[];
  v_gtin text;
  v_digits text;
  v_ident record;
  v_pid uuid;
  v_count int := 0;
  v_status text;
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL OR NOT public.user_can_access_business(v_user, p_business_id) THEN
    RETURN QUERY SELECT 'unauthorized'::text, NULL::uuid, NULL::text, NULL::text, NULL::uuid,
      NULL::public.product_identifier_kind, v_code, NULL::uuid, NULL::text,
      NULL::numeric, NULL::uuid, NULL::boolean, 0;
    RETURN;
  END IF;

  IF length(v_code) = 0 THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::text, NULL::uuid,
      NULL::public.product_identifier_kind, v_code, NULL::uuid, NULL::text,
      NULL::numeric, NULL::uuid, NULL::boolean, 0;
    RETURN;
  END IF;

  v_cands := ARRAY[v_norm];

  -- GS1 element string: leading AI (01) carries a 14-digit GTIN.
  IF v_norm ~ '^\(?01\)?[0-9]{14}' THEN
    v_gtin := substring(replace(replace(v_norm, '(', ''), ')', '') FROM 3 FOR 14);
    v_cands := v_cands || v_gtin;
  END IF;

  -- GTIN-8/12/13/14 are the same number with different zero padding.
  v_digits := CASE WHEN v_norm ~ '^[0-9]+$' THEN v_norm ELSE coalesce(v_gtin, '') END;
  IF v_digits ~ '^[0-9]{8,14}$' THEN
    v_cands := v_cands
      || ltrim(v_digits, '0')
      || lpad(ltrim(v_digits, '0'), 13, '0')
      || lpad(ltrim(v_digits, '0'), 14, '0');
  END IF;

  -- Live candidates only.
  SELECT count(*) INTO v_count
    FROM public.product_identifiers pi
   WHERE pi.business_id = p_business_id
     AND pi.code_norm = ANY(v_cands)
     AND pi.status = 'active'
     AND (pi.valid_from IS NULL OR pi.valid_from <= now())
     AND (pi.valid_to IS NULL OR pi.valid_to > now());

  SELECT pi.id, pi.product_id, pi.kind, pi.code, pi.packaging_id
    INTO v_ident
    FROM public.product_identifiers pi
   WHERE pi.business_id = p_business_id
     AND pi.code_norm = ANY(v_cands)
     AND pi.status = 'active'
     AND (pi.valid_from IS NULL OR pi.valid_from <= now())
     AND (pi.valid_to IS NULL OR pi.valid_to > now())
   ORDER BY (pi.code_norm = v_norm) DESC, pi.is_primary DESC, pi.created_at
   LIMIT 1;

  IF v_ident.product_id IS NOT NULL THEN
    v_pid := v_ident.product_id;
    v_status := CASE WHEN v_count > 1 THEN 'ambiguous' ELSE 'resolved' END;
  ELSE
    -- Nothing live. Explain WHY rather than reporting a blank "unknown".
    SELECT CASE
             WHEN pi.status = 'archived' THEN 'archived'
             WHEN pi.status = 'inactive' THEN 'inactive'
             ELSE 'expired'
           END
      INTO v_status
      FROM public.product_identifiers pi
     WHERE pi.business_id = p_business_id
       AND pi.code_norm = ANY(v_cands)
     ORDER BY pi.updated_at DESC
     LIMIT 1;

    IF v_status IS NULL AND p_allow_sku_fallback THEN
      SELECT p.id INTO v_pid
        FROM public.products p
       WHERE p.business_id = p_business_id
         AND p.is_active = true
         AND p.sku IS NOT NULL
         AND upper(btrim(p.sku)) = ANY(v_cands)
       LIMIT 1;
      IF v_pid IS NOT NULL THEN
        v_status := 'resolved';
        v_count := 1;
      END IF;
    END IF;

    IF v_pid IS NULL AND v_status IS NULL THEN
      -- Known to the platform, but owned by a different tenant. Say so without
      -- disclosing anything about the other organisation's catalogue.
      IF EXISTS (
        SELECT 1 FROM public.product_identifiers pi
         WHERE pi.code_norm = ANY(v_cands) AND pi.business_id <> p_business_id
      ) THEN
        v_status := 'foreign_tenant';
      ELSE
        v_status := 'not_found';
      END IF;
    END IF;
  END IF;

  IF v_pid IS NULL THEN
    RETURN QUERY SELECT v_status, NULL::uuid, NULL::text, NULL::text, NULL::uuid,
      NULL::public.product_identifier_kind, v_code, NULL::uuid, NULL::text,
      NULL::numeric, NULL::uuid, NULL::boolean, coalesce(v_count, 0);
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    v_status,
    p.id,
    p.name::text,
    p.sku::text,
    v_ident.id,
    COALESCE(v_ident.kind, 'sku'::public.product_identifier_kind),
    COALESCE(v_ident.code, p.sku)::text,
    pk.id,
    pk.name::text,
    COALESCE(pk.qty_in_base_uom, 1)::numeric,
    p.base_uom_id,
    (pk.id IS NULL),
    GREATEST(v_count, 1)
  FROM public.products p
  LEFT JOIN public.product_packaging pk ON pk.id = v_ident.packaging_id
  WHERE p.id = v_pid AND p.is_active = true;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::text, NULL::uuid,
      NULL::public.product_identifier_kind, v_code, NULL::uuid, NULL::text,
      NULL::numeric, NULL::uuid, NULL::boolean, 0;
  END IF;
END $fn$;

REVOKE ALL ON FUNCTION public.resolve_product_identity(uuid, text, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_product_identity(uuid, text, uuid, boolean) TO authenticated, service_role;

-- ------------------------------------------------------------
-- Delegating callers keep their existing shapes.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.resolve_barcode_v2(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.pos_resolve_barcode(uuid, uuid, text);

CREATE FUNCTION public.pos_resolve_barcode(
  p_business_id uuid, p_branch_id uuid, p_code text
)
RETURNS TABLE (
  product_id uuid, product_name text, sku text, unit_price numeric, cost_price numeric,
  tax_rate numeric, tax_rate_id uuid, tax_rate_name text, etims_tax_code text,
  category_id uuid, category_name text, on_hand numeric,
  matched_kind public.product_identifier_kind, matched_code text,
  rule_kind public.pos_barcode_rule_kind, scan_quantity numeric, scan_weight numeric,
  scan_price numeric, is_weighted boolean, packaging_id uuid, base_uom_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $pos$
DECLARE
  v_code text := trim(p_code);
  v_rule public.pos_barcode_rules%ROWTYPE;
  v_item_code text; v_embedded numeric;
  v_weight numeric := NULL; v_price numeric := NULL;
  v_rule_kind public.pos_barcode_rule_kind := NULL;
  v_id record;
BEGIN
  IF v_code IS NULL OR length(v_code) = 0 THEN RETURN; END IF;

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
      FROM public.resolve_product_identity(p_business_id, v_item_code, p_branch_id, true) LIMIT 1;
  END IF;

  IF v_id.product_id IS NULL THEN
    SELECT * INTO v_id
      FROM public.resolve_product_identity(p_business_id, v_code, p_branch_id, true) LIMIT 1;
  END IF;

  IF v_id.product_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT
    p.id, p.name::text, p.sku::text, p.unit_price, p.cost_price,
    COALESCE(tr.rate, p.tax_rate), COALESCE(tr.id, p.tax_rate_id),
    tr.name::text, tr.etims_tax_code::text,
    p.category_id, pc.name::text,
    COALESCE((SELECT ws.quantity FROM public.warehouse_stock ws
              WHERE ws.product_id = p.id AND ws.branch_id = p_branch_id LIMIT 1), 0)::numeric,
    v_id.matched_kind, v_id.matched_code::text, v_rule_kind,
    COALESCE(v_id.qty_in_base_uom, 1)::numeric, v_weight, v_price,
    COALESCE(p.is_weighted, false),
    v_id.packaging_id, p.base_uom_id
  FROM public.products p
  LEFT JOIN public.tax_rates tr ON tr.id = p.tax_rate_id
  LEFT JOIN public.product_categories pc ON pc.id = p.category_id
  WHERE p.id = v_id.product_id AND p.is_active = true;
END $pos$;

CREATE FUNCTION public.resolve_barcode_v2(
  p_business_id uuid, p_branch_id uuid, p_code text
)
RETURNS TABLE (
  product_id uuid, packaging_id uuid, qty_in_base_uom numeric,
  scan_weight numeric, match_source text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $v2$
BEGIN
  RETURN QUERY
  SELECT
    r.product_id,
    r.packaging_id,
    COALESCE(r.qty_in_base_uom, 1)::numeric,
    NULL::numeric,
    CASE WHEN r.packaging_id IS NOT NULL THEN 'packaging' ELSE 'identifier' END
  FROM public.resolve_product_identity(p_business_id, p_code, p_branch_id, true) AS r
  WHERE r.product_id IS NOT NULL
  LIMIT 1;

  IF FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    (r->>'product_id')::uuid,
    NULL::uuid,
    COALESCE((r->>'scan_quantity')::numeric, 1),
    NULLIF(r->>'scan_weight','')::numeric,
    COALESCE(r->>'match_source','pos_resolve_barcode')
  FROM public.pos_resolve_barcode(p_business_id, p_branch_id, p_code) AS r
  LIMIT 1;
END $v2$;

REVOKE ALL ON FUNCTION public.resolve_barcode_v2(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pos_resolve_barcode(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_barcode_v2(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pos_resolve_barcode(uuid, uuid, text) TO authenticated, service_role;