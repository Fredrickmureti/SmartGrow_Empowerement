-- ============================================================
-- Phase 8 — Supplier identity & discovery (ADR-0110)
--
-- A supplier's part number is scoped to that supplier: two vendors may use
-- the same code for different goods. Global identifiers (GTIN, SKU, PLU,
-- internal) stay business-unique.
-- ============================================================

-- 1. Uniqueness partitioned by ownership scope -----------------------------
DROP INDEX IF EXISTS public.product_identifiers_active_business_code_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS product_identifiers_active_global_code_uidx
  ON public.product_identifiers (business_id, code_norm)
  WHERE status = 'active' AND supplier_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS product_identifiers_active_supplier_code_uidx
  ON public.product_identifiers (business_id, supplier_id, code_norm)
  WHERE status = 'active' AND supplier_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS product_identifiers_supplier_lookup_idx
  ON public.product_identifiers (business_id, supplier_id, code_norm, status)
  WHERE supplier_id IS NOT NULL;

-- 2. The write seam clashes within the SAME scope only ---------------------
CREATE OR REPLACE FUNCTION public.upsert_product_identifier(
  p_business_id uuid,
  p_product_id uuid,
  p_code text,
  p_kind public.product_identifier_kind DEFAULT 'gtin',
  p_packaging_id uuid DEFAULT NULL,
  p_is_primary boolean DEFAULT false,
  p_supplier_id uuid DEFAULT NULL,
  p_source public.product_identifier_source DEFAULT 'manual',
  p_identifier_id uuid DEFAULT NULL,
  p_valid_from timestamptz DEFAULT NULL,
  p_valid_to timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_user uuid := auth.uid();
  v_code text := btrim(coalesce(p_code, ''));
  v_norm text := upper(v_code);
  v_org uuid;
  v_clash record;
  v_id uuid;
BEGIN
  IF v_user IS NULL OR NOT public.user_can_access_business(v_user, p_business_id) THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'unauthenticated');
  END IF;
  IF length(v_code) = 0 THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'empty_code');
  END IF;

  SELECT p.organization_id INTO v_org
    FROM public.products p
   WHERE p.id = p_product_id AND p.business_id = p_business_id;
  IF v_org IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'unknown_product');
  END IF;

  IF p_packaging_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.product_packaging pk
     WHERE pk.id = p_packaging_id AND pk.product_id = p_product_id
       AND pk.business_id = p_business_id
  ) THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'foreign_packaging_level');
  END IF;

  IF p_kind = 'supplier' AND p_supplier_id IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'supplier_required');
  END IF;

  -- A supplier code is unique per supplier; a global code is unique per
  -- business. Cross-scope collisions are legitimate and must not block.
  SELECT pi.id, pi.product_id INTO v_clash
    FROM public.product_identifiers pi
   WHERE pi.business_id = p_business_id
     AND pi.code_norm = v_norm
     AND pi.status = 'active'
     AND ((p_supplier_id IS NULL AND pi.supplier_id IS NULL)
       OR (p_supplier_id IS NOT NULL AND pi.supplier_id = p_supplier_id))
     AND (p_identifier_id IS NULL OR pi.id <> p_identifier_id)
   LIMIT 1;

  IF v_clash.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'duplicate',
      'identifier_id', v_clash.id,
      'product_id', v_clash.product_id,
      'same_product', v_clash.product_id = p_product_id
    );
  END IF;

  IF p_identifier_id IS NOT NULL THEN
    UPDATE public.product_identifiers
       SET code = v_code,
           kind = p_kind,
           packaging_id = p_packaging_id,
           supplier_id = p_supplier_id,
           source = p_source,
           valid_from = p_valid_from,
           valid_to = p_valid_to,
           status = 'active',
           updated_at = now()
     WHERE id = p_identifier_id
       AND business_id = p_business_id
       AND product_id = p_product_id
     RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      RETURN jsonb_build_object('status', 'invalid', 'reason', 'unknown_identifier');
    END IF;
  ELSE
    INSERT INTO public.product_identifiers
      (organization_id, business_id, product_id, code, kind, packaging_id,
       supplier_id, source, valid_from, valid_to, created_by, is_primary)
    VALUES
      (v_org, p_business_id, p_product_id, v_code, p_kind, p_packaging_id,
       p_supplier_id, p_source, p_valid_from, p_valid_to, v_user, false)
    RETURNING id INTO v_id;
  END IF;

  -- Primary flip is ONE atomic step: demote siblings, then promote. A
  -- supplier-scoped code may never become the product's primary label.
  IF p_is_primary AND p_supplier_id IS NULL THEN
    UPDATE public.product_identifiers
       SET is_primary = false, updated_at = now()
     WHERE product_id = p_product_id AND is_primary = true AND id <> v_id;
    UPDATE public.product_identifiers
       SET is_primary = true, updated_at = now()
     WHERE id = v_id;
  ELSIF p_supplier_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM public.product_identifiers
     WHERE product_id = p_product_id AND is_primary = true AND status = 'active'
  ) THEN
    UPDATE public.product_identifiers SET is_primary = true, updated_at = now() WHERE id = v_id;
  END IF;

  RETURN jsonb_build_object('status', 'ok', 'identifier_id', v_id, 'code', v_code);
END $fn$;

REVOKE ALL ON FUNCTION public.upsert_product_identifier(uuid, uuid, text, public.product_identifier_kind, uuid, boolean, uuid, public.product_identifier_source, uuid, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_product_identifier(uuid, uuid, text, public.product_identifier_kind, uuid, boolean, uuid, public.product_identifier_source, uuid, timestamptz, timestamptz) TO authenticated;

-- 3. The resolver becomes supplier-aware -----------------------------------
--    Global identifiers always match. Supplier-scoped identifiers match ONLY
--    when the caller supplies the supplier context (receiving against that
--    vendor's PO / ASN). Otherwise the decision is 'supplier_scoped' — a
--    blocking outcome that names the reason instead of "not registered".
DROP FUNCTION IF EXISTS public.resolve_product_identity(uuid, text, uuid, boolean);

CREATE FUNCTION public.resolve_product_identity(
  p_business_id uuid,
  p_code text,
  p_branch_id uuid DEFAULT NULL::uuid,
  p_allow_sku_fallback boolean DEFAULT false,
  p_supplier_id uuid DEFAULT NULL::uuid)
RETURNS TABLE(status text, product_id uuid, product_name text, sku text, identifier_id uuid,
  matched_kind product_identifier_kind, matched_code text, packaging_id uuid, packaging_name text,
  qty_in_base_uom numeric, base_uom_id uuid, is_base_unit boolean, match_count integer)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_code text := btrim(coalesce(p_code, ''));
  v_norm text := upper(v_code);
  v_cands text[];
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

  v_cands := public.identity_code_candidates(v_code);

  IF array_length(v_cands, 1) IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::text, NULL::uuid,
      NULL::public.product_identifier_kind, v_code, NULL::uuid, NULL::text,
      NULL::numeric, NULL::uuid, NULL::boolean, 0;
    RETURN;
  END IF;

  -- Ambiguity = more than one DISTINCT product behind the eligible codes.
  SELECT count(DISTINCT pi.product_id) INTO v_count
    FROM public.product_identifiers pi
   WHERE pi.business_id = p_business_id
     AND pi.code_norm = ANY(v_cands)
     AND pi.status = 'active'
     AND (pi.valid_from IS NULL OR pi.valid_from <= now())
     AND (pi.valid_to IS NULL OR pi.valid_to > now())
     AND (pi.supplier_id IS NULL
       OR (p_supplier_id IS NOT NULL AND pi.supplier_id = p_supplier_id));

  SELECT pi.id, pi.product_id, pi.kind, pi.code, pi.packaging_id
    INTO v_ident
    FROM public.product_identifiers pi
   WHERE pi.business_id = p_business_id
     AND pi.code_norm = ANY(v_cands)
     AND pi.status = 'active'
     AND (pi.valid_from IS NULL OR pi.valid_from <= now())
     AND (pi.valid_to IS NULL OR pi.valid_to > now())
     AND (pi.supplier_id IS NULL
       OR (p_supplier_id IS NOT NULL AND pi.supplier_id = p_supplier_id))
   ORDER BY (pi.code_norm = v_norm) DESC,
            array_position(v_cands, pi.code_norm),
            (pi.supplier_id IS NOT NULL AND p_supplier_id IS NOT NULL) DESC,
            pi.is_primary DESC, pi.created_at
   LIMIT 1;

  IF v_ident.product_id IS NOT NULL THEN
    v_pid := v_ident.product_id;
    v_status := CASE WHEN v_count > 1 THEN 'ambiguous' ELSE 'resolved' END;
  ELSE
    -- Lifecycle outcomes are read from the SAME scope as the match test.
    SELECT CASE
             WHEN pi.status = 'archived' THEN 'archived'
             WHEN pi.status = 'inactive' THEN 'inactive'
             ELSE 'expired'
           END
      INTO v_status
      FROM public.product_identifiers pi
     WHERE pi.business_id = p_business_id
       AND pi.code_norm = ANY(v_cands)
       AND (pi.supplier_id IS NULL
         OR (p_supplier_id IS NOT NULL AND pi.supplier_id = p_supplier_id))
     ORDER BY pi.updated_at DESC
     LIMIT 1;

    -- A live code that only exists inside another supplier's catalogue is
    -- neither unknown nor usable here: say so.
    IF v_status IS NULL AND EXISTS (
      SELECT 1 FROM public.product_identifiers pi
       WHERE pi.business_id = p_business_id
         AND pi.code_norm = ANY(v_cands)
         AND pi.status = 'active'
         AND pi.supplier_id IS NOT NULL
    ) THEN
      v_status := 'supplier_scoped';
    END IF;

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
END $function$;

REVOKE ALL ON FUNCTION public.resolve_product_identity(uuid, text, uuid, boolean, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_product_identity(uuid, text, uuid, boolean, uuid) TO authenticated, service_role;

-- 4. Discovery — evidence for an unrecognised code -------------------------
CREATE OR REPLACE FUNCTION public.discover_supplier_identity(
  p_business_id uuid,
  p_code text,
  p_supplier_id uuid DEFAULT NULL,
  p_purchase_order_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_user uuid := auth.uid();
  v_code text := btrim(coalesce(p_code, ''));
  v_cands text[];
  v_supplier uuid := p_supplier_id;
  v_candidates jsonb := '[]'::jsonb;
BEGIN
  IF v_user IS NULL OR NOT public.user_can_access_business(v_user, p_business_id) THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'code', v_code, 'candidates', v_candidates);
  END IF;
  IF length(v_code) = 0 THEN
    RETURN jsonb_build_object('status', 'empty', 'code', v_code, 'candidates', v_candidates);
  END IF;

  v_cands := public.identity_code_candidates(v_code);

  IF v_supplier IS NULL AND p_purchase_order_id IS NOT NULL THEN
    SELECT po.vendor_id INTO v_supplier
      FROM public.purchase_orders po
     WHERE po.id = p_purchase_order_id AND po.business_id = p_business_id;
  END IF;

  WITH other_supplier AS (
    SELECT pi.product_id,
           'other_supplier'::text AS evidence,
           pi.supplier_id AS supplier_id,
           pi.packaging_id,
           1 AS rank
      FROM public.product_identifiers pi
     WHERE pi.business_id = p_business_id
       AND pi.code_norm = ANY(v_cands)
       AND pi.status = 'active'
       AND pi.supplier_id IS NOT NULL
       AND (v_supplier IS NULL OR pi.supplier_id <> v_supplier)
  ),
  po_lines AS (
    SELECT poi.product_id,
           'open_po'::text AS evidence,
           po.vendor_id AS supplier_id,
           poi.packaging_id,
           2 AS rank
      FROM public.purchase_order_items poi
      JOIN public.purchase_orders po ON po.id = poi.purchase_order_id
     WHERE po.business_id = p_business_id
       AND poi.product_id IS NOT NULL
       AND po.status::text NOT IN ('draft', 'cancelled', 'rejected', 'closed')
       AND (p_purchase_order_id IS NULL OR po.id = p_purchase_order_id)
       AND (v_supplier IS NULL OR po.vendor_id = v_supplier)
       AND coalesce(poi.quantity_received, 0) < poi.quantity
  ),
  pricelist AS (
    SELECT vp.product_id,
           'supplier_catalogue'::text AS evidence,
           vp.vendor_id AS supplier_id,
           NULL::uuid AS packaging_id,
           3 AS rank
      FROM public.vendor_pricelists vp
     WHERE vp.business_id = p_business_id
       AND vp.is_active = true
       AND v_supplier IS NOT NULL
       AND vp.vendor_id = v_supplier
  ),
  unioned AS (
    SELECT * FROM other_supplier
    UNION ALL SELECT * FROM po_lines
    UNION ALL SELECT * FROM pricelist
  ),
  best AS (
    SELECT DISTINCT ON (u.product_id) u.*
      FROM unioned u
     ORDER BY u.product_id, u.rank
  )
  SELECT coalesce(jsonb_agg(x.row ORDER BY x.rank, x.name), '[]'::jsonb)
    INTO v_candidates
    FROM (
      SELECT b.rank,
             p.name::text AS name,
             jsonb_build_object(
               'product_id', p.id,
               'product_name', p.name::text,
               'sku', p.sku::text,
               'evidence', b.evidence,
               'supplier_id', b.supplier_id,
               'supplier_name', c.name::text,
               'packaging_id', b.packaging_id
             ) AS row
        FROM best b
        JOIN public.products p ON p.id = b.product_id AND p.business_id = p_business_id
                              AND p.is_active = true
        LEFT JOIN public.contacts c ON c.id = b.supplier_id
       ORDER BY b.rank, p.name
       LIMIT 20
    ) x;

  RETURN jsonb_build_object(
    'status', CASE WHEN jsonb_array_length(v_candidates) > 0 THEN 'candidates' ELSE 'none' END,
    'code', v_code,
    'supplier_id', v_supplier,
    'candidates', v_candidates
  );
END $fn$;

REVOKE ALL ON FUNCTION public.discover_supplier_identity(uuid, text, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.discover_supplier_identity(uuid, text, uuid, uuid) TO authenticated, service_role;