-- ============================================================
-- Product Identification Architecture — Step 1 (additive)
-- ============================================================

-- 1. Identifier → packaging level (NULL = base unit)
ALTER TABLE public.product_identifiers
  ADD COLUMN IF NOT EXISTS packaging_id uuid NULL
    REFERENCES public.product_packaging(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS product_identifiers_packaging_idx
  ON public.product_identifiers (packaging_id);

-- Integrity: packaging level must belong to the same product + business.
CREATE OR REPLACE FUNCTION public._product_identifier_packaging_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_product uuid;
  v_business uuid;
BEGIN
  IF NEW.packaging_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT product_id, business_id INTO v_product, v_business
    FROM public.product_packaging WHERE id = NEW.packaging_id;
  IF v_product IS NULL THEN
    RAISE EXCEPTION 'packaging level % not found', NEW.packaging_id;
  END IF;
  IF v_product <> NEW.product_id OR v_business <> NEW.business_id THEN
    RAISE EXCEPTION 'packaging level % does not belong to product % / business %',
      NEW.packaging_id, NEW.product_id, NEW.business_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_product_identifier_packaging_guard ON public.product_identifiers;
CREATE TRIGGER trg_product_identifier_packaging_guard
  BEFORE INSERT OR UPDATE OF packaging_id, product_id, business_id
  ON public.product_identifiers
  FOR EACH ROW EXECUTE FUNCTION public._product_identifier_packaging_guard();

-- 2. Backfill from the legacy inverse link product_packaging.barcode_id
UPDATE public.product_identifiers pi
   SET packaging_id = pk.id
  FROM public.product_packaging pk
 WHERE pk.barcode_id = pi.id
   AND pk.product_id = pi.product_id
   AND pi.packaging_id IS NULL;

-- 3. Backfill from the loose pack_quantity where it matches exactly one level
UPDATE public.product_identifiers pi
   SET packaging_id = m.pkg_id
  FROM (
    SELECT pi2.id AS ident_id, (array_agg(pk.id))[1] AS pkg_id
      FROM public.product_identifiers pi2
      JOIN public.product_packaging pk
        ON pk.product_id = pi2.product_id
       AND pk.qty_in_base_uom = pi2.pack_quantity
     WHERE pi2.packaging_id IS NULL
       AND pi2.pack_quantity IS NOT NULL
       AND pi2.pack_quantity > 1
     GROUP BY pi2.id
    HAVING count(*) = 1
  ) m
 WHERE pi.id = m.ident_id;

-- 4. Any remaining loose pack_quantity gets a real packaging level
DO $$
DECLARE
  r record;
  v_new uuid;
BEGIN
  FOR r IN
    SELECT id, organization_id, business_id, product_id, pack_quantity
      FROM public.product_identifiers
     WHERE packaging_id IS NULL
       AND pack_quantity IS NOT NULL
       AND pack_quantity > 1
  LOOP
    INSERT INTO public.product_packaging
      (organization_id, business_id, product_id, name, qty_in_base_uom,
       is_purchase_default, is_sales_default)
    VALUES
      (r.organization_id, r.business_id, r.product_id,
       'Pack of ' || trim(to_char(r.pack_quantity, 'FM999999990.999')),
       r.pack_quantity, false, false)
    RETURNING id INTO v_new;

    UPDATE public.product_identifiers SET packaging_id = v_new WHERE id = r.id;
  END LOOP;
END $$;

-- 5. Deliberate "this level carries no code" decisions
CREATE TABLE IF NOT EXISTS public.product_identification_waivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  packaging_id uuid NULL REFERENCES public.product_packaging(id) ON DELETE CASCADE,
  reason text NULL,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_identification_waivers TO authenticated;
GRANT ALL ON public.product_identification_waivers TO service_role;

ALTER TABLE public.product_identification_waivers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS piw_select ON public.product_identification_waivers;
CREATE POLICY piw_select ON public.product_identification_waivers
  FOR SELECT TO authenticated USING (public.is_org_member(auth.uid(), organization_id));
DROP POLICY IF EXISTS piw_insert ON public.product_identification_waivers;
CREATE POLICY piw_insert ON public.product_identification_waivers
  FOR INSERT TO authenticated WITH CHECK (public.is_org_member(auth.uid(), organization_id));
DROP POLICY IF EXISTS piw_update ON public.product_identification_waivers;
CREATE POLICY piw_update ON public.product_identification_waivers
  FOR UPDATE TO authenticated USING (public.is_org_member(auth.uid(), organization_id))
  WITH CHECK (public.is_org_member(auth.uid(), organization_id));
DROP POLICY IF EXISTS piw_delete ON public.product_identification_waivers;
CREATE POLICY piw_delete ON public.product_identification_waivers
  FOR DELETE TO authenticated USING (public.is_org_member(auth.uid(), organization_id));

CREATE UNIQUE INDEX IF NOT EXISTS piw_unique_level
  ON public.product_identification_waivers (business_id, product_id, coalesce(packaging_id, '00000000-0000-0000-0000-000000000000'::uuid));

DROP TRIGGER IF EXISTS trg_piw_updated_at ON public.product_identification_waivers;
CREATE TRIGGER trg_piw_updated_at
  BEFORE UPDATE ON public.product_identification_waivers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 6. Canonical item resolver — one lookup for POS, WMS, purchasing, labels.
CREATE OR REPLACE FUNCTION public.resolve_product_identity(
  p_business_id uuid,
  p_code text
)
RETURNS TABLE(
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
  is_base_unit boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code text := btrim(coalesce(p_code, ''));
  v_norm text := upper(v_code);
  v_ident record;
  v_pid uuid;
BEGIN
  IF length(v_code) = 0 THEN RETURN; END IF;

  SELECT pi.id, pi.product_id, pi.kind, pi.code, pi.packaging_id
    INTO v_ident
    FROM public.product_identifiers pi
   WHERE pi.business_id = p_business_id
     AND pi.code_norm = v_norm
   ORDER BY pi.is_primary DESC
   LIMIT 1;

  IF v_ident.product_id IS NULL THEN
    -- SKU fallback: the product's own code is a legitimate base-unit identifier.
    SELECT p.id INTO v_pid
      FROM public.products p
     WHERE p.business_id = p_business_id
       AND p.is_active = true
       AND p.sku IS NOT NULL
       AND upper(btrim(p.sku)) = v_norm
     LIMIT 1;
    IF v_pid IS NULL THEN RETURN; END IF;
  ELSE
    v_pid := v_ident.product_id;
  END IF;

  RETURN QUERY
  SELECT
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
    (pk.id IS NULL)
  FROM public.products p
  LEFT JOIN public.product_packaging pk ON pk.id = v_ident.packaging_id
  WHERE p.id = v_pid AND p.is_active = true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_product_identity(uuid, text) TO authenticated, anon, service_role;

-- 7. Identification completeness projection for the enrollment workspace.
CREATE OR REPLACE FUNCTION public.product_identification_status(
  p_business_id uuid,
  p_product_ids uuid[]
)
RETURNS TABLE(
  product_id uuid,
  packaging_id uuid,
  level_name text,
  qty_in_base_uom numeric,
  sort_qty numeric,
  identifier_count integer,
  primary_code text,
  is_waived boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH levels AS (
    -- base unit
    SELECT p.id AS product_id, NULL::uuid AS packaging_id,
           'Base unit'::text AS level_name, 1::numeric AS qty_in_base_uom,
           1::numeric AS sort_qty
      FROM public.products p
     WHERE p.business_id = p_business_id
       AND p.id = ANY(p_product_ids)
    UNION ALL
    SELECT pk.product_id, pk.id, pk.name::text, pk.qty_in_base_uom, pk.qty_in_base_uom
      FROM public.product_packaging pk
     WHERE pk.business_id = p_business_id
       AND pk.product_id = ANY(p_product_ids)
  )
  SELECT
    l.product_id,
    l.packaging_id,
    l.level_name,
    l.qty_in_base_uom,
    l.sort_qty,
    COALESCE(i.cnt, 0)::int,
    i.code,
    EXISTS (
      SELECT 1 FROM public.product_identification_waivers w
       WHERE w.business_id = p_business_id
         AND w.product_id = l.product_id
         AND w.packaging_id IS NOT DISTINCT FROM l.packaging_id
    )
  FROM levels l
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS cnt,
           (array_agg(pi.code ORDER BY pi.is_primary DESC, pi.created_at))[1] AS code
      FROM public.product_identifiers pi
     WHERE pi.business_id = p_business_id
       AND pi.product_id = l.product_id
       AND pi.packaging_id IS NOT DISTINCT FROM l.packaging_id
       AND pi.kind IN ('gtin','pack','supplier','alias','plu','internal')
  ) i ON true;
$$;

GRANT EXECUTE ON FUNCTION public.product_identification_status(uuid, uuid[]) TO authenticated, service_role;

-- 8. Enrollment can now target a packaging level.
CREATE OR REPLACE FUNCTION public.enroll_product_barcode(
  p_business_id uuid,
  p_product_id uuid,
  p_code text,
  p_kind public.product_identifier_kind DEFAULT 'gtin'::public.product_identifier_kind,
  p_packaging_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user        uuid := auth.uid();
  v_norm        text;
  v_org         uuid;
  v_conflict    record;
  v_existing    uuid;
  v_has_primary boolean;
  v_new_id      uuid;
  v_pkg_product uuid;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('status','invalid','reason','unauthenticated');
  END IF;

  IF NOT public.user_can_access_business(v_user, p_business_id) THEN
    RETURN jsonb_build_object('status','invalid','reason','forbidden');
  END IF;

  v_norm := upper(btrim(coalesce(p_code, '')));
  IF length(v_norm) = 0 THEN
    RETURN jsonb_build_object('status','invalid','reason','empty_code');
  END IF;
  IF length(v_norm) > 64 THEN
    RETURN jsonb_build_object('status','invalid','reason','code_too_long');
  END IF;

  SELECT organization_id INTO v_org
    FROM public.products
   WHERE id = p_product_id AND business_id = p_business_id;
  IF v_org IS NULL THEN
    RETURN jsonb_build_object('status','invalid','reason','product_not_found');
  END IF;

  IF p_packaging_id IS NOT NULL THEN
    SELECT product_id INTO v_pkg_product
      FROM public.product_packaging
     WHERE id = p_packaging_id AND business_id = p_business_id;
    IF v_pkg_product IS DISTINCT FROM p_product_id THEN
      RETURN jsonb_build_object('status','invalid','reason','packaging_mismatch');
    END IF;
  END IF;

  SELECT id INTO v_existing
    FROM public.product_identifiers
   WHERE business_id = p_business_id
     AND product_id  = p_product_id
     AND code_norm   = v_norm
     AND kind        = p_kind
   LIMIT 1;
  IF v_existing IS NOT NULL THEN
    UPDATE public.product_identifiers
       SET packaging_id = COALESCE(p_packaging_id, packaging_id)
     WHERE id = v_existing;
    RETURN jsonb_build_object('status','ok','identifier_id',v_existing,'idempotent',true);
  END IF;

  SELECT pi.product_id, p.name
    INTO v_conflict
    FROM public.product_identifiers pi
    JOIN public.products p ON p.id = pi.product_id
   WHERE pi.business_id = p_business_id
     AND pi.code_norm   = v_norm
     AND pi.kind        = p_kind
   LIMIT 1;

  IF v_conflict.product_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status','duplicate',
      'conflict_product_id', v_conflict.product_id,
      'conflict_product_name', v_conflict.name
    );
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.product_identifiers
     WHERE product_id = p_product_id AND is_primary = true
  ) INTO v_has_primary;

  INSERT INTO public.product_identifiers
    (organization_id, business_id, product_id, code, kind, is_primary, created_by, packaging_id)
  VALUES
    (v_org, p_business_id, p_product_id, btrim(p_code), p_kind,
     NOT v_has_primary AND p_packaging_id IS NULL, v_user, p_packaging_id)
  RETURNING id INTO v_new_id;

  -- Enrolling a level clears any waiver that said it would never be coded.
  DELETE FROM public.product_identification_waivers
   WHERE business_id = p_business_id
     AND product_id = p_product_id
     AND packaging_id IS NOT DISTINCT FROM p_packaging_id;

  RETURN jsonb_build_object('status','ok','identifier_id',v_new_id,'idempotent',false);

EXCEPTION
  WHEN unique_violation THEN
    SELECT pi.product_id, p.name
      INTO v_conflict
      FROM public.product_identifiers pi
      JOIN public.products p ON p.id = pi.product_id
     WHERE pi.business_id = p_business_id
       AND pi.code_norm   = v_norm
       AND pi.kind        = p_kind
     LIMIT 1;
    RETURN jsonb_build_object(
      'status','duplicate',
      'conflict_product_id', v_conflict.product_id,
      'conflict_product_name', v_conflict.name
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.enroll_product_barcode(uuid, uuid, text, public.product_identifier_kind, uuid) TO authenticated, service_role;

-- 9. Record / clear a deliberate "no code at this level" decision.
CREATE OR REPLACE FUNCTION public.waive_product_identification(
  p_business_id uuid,
  p_product_id uuid,
  p_packaging_id uuid DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_waive boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org  uuid;
BEGIN
  IF v_user IS NULL OR NOT public.user_can_access_business(v_user, p_business_id) THEN
    RETURN jsonb_build_object('status','forbidden');
  END IF;

  SELECT organization_id INTO v_org
    FROM public.products WHERE id = p_product_id AND business_id = p_business_id;
  IF v_org IS NULL THEN
    RETURN jsonb_build_object('status','invalid','reason','product_not_found');
  END IF;

  IF NOT p_waive THEN
    DELETE FROM public.product_identification_waivers
     WHERE business_id = p_business_id
       AND product_id = p_product_id
       AND packaging_id IS NOT DISTINCT FROM p_packaging_id;
    RETURN jsonb_build_object('status','ok','waived',false);
  END IF;

  INSERT INTO public.product_identification_waivers
    (organization_id, business_id, product_id, packaging_id, reason, created_by)
  VALUES (v_org, p_business_id, p_product_id, p_packaging_id, p_reason, v_user)
  ON CONFLICT (business_id, product_id, coalesce(packaging_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET reason = EXCLUDED.reason, updated_at = now();

  RETURN jsonb_build_object('status','ok','waived',true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.waive_product_identification(uuid, uuid, uuid, text, boolean) TO authenticated, service_role;

-- 10. POS resolver now delegates item identity to the canonical resolver.
CREATE OR REPLACE FUNCTION public.pos_resolve_barcode(
  p_business_id uuid,
  p_branch_id uuid,
  p_code text
)
RETURNS TABLE(
  product_id uuid, name text, sku text, selling_price numeric, cost_price numeric,
  tax_rate numeric, tax_rate_id uuid, tax_rate_name text, etims_tax_code text,
  category_id uuid, category_name text, branch_on_hand numeric,
  matched_kind public.product_identifier_kind, matched_code text,
  matched_rule_kind public.pos_barcode_rule_kind, scan_quantity numeric,
  scan_weight numeric, embedded_price numeric, is_weighted boolean,
  packaging_id uuid, base_uom_id uuid
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
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

    SELECT * INTO v_id FROM public.resolve_product_identity(p_business_id, v_item_code) LIMIT 1;
  END IF;

  IF v_id.product_id IS NULL THEN
    SELECT * INTO v_id FROM public.resolve_product_identity(p_business_id, v_code) LIMIT 1;
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
END;
$$;