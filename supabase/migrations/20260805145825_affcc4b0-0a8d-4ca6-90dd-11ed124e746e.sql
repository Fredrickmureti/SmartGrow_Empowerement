DROP FUNCTION IF EXISTS public.upsert_product_identifier(uuid,uuid,text,product_identifier_kind,uuid,boolean,uuid,product_identifier_source,uuid,timestamptz,timestamptz);

CREATE FUNCTION public.upsert_product_identifier(
  p_business_id uuid,
  p_product_id uuid,
  p_code text DEFAULT NULL,
  p_kind product_identifier_kind DEFAULT 'gtin',
  p_packaging_id uuid DEFAULT NULL,
  p_is_primary boolean DEFAULT false,
  p_supplier_id uuid DEFAULT NULL,
  p_source product_identifier_source DEFAULT NULL,
  p_identifier_id uuid DEFAULT NULL,
  p_valid_from timestamptz DEFAULT NULL,
  p_valid_to timestamptz DEFAULT NULL
) RETURNS jsonb
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
  SELECT pi.id, pi.product_id, pi.packaging_id, pr.name AS product_name
    INTO v_clash
    FROM public.product_identifiers pi
    JOIN public.products pr ON pr.id = pi.product_id
   WHERE pi.business_id = p_business_id
     AND pi.code_norm = v_norm
     AND pi.status = 'active'
     AND ((p_supplier_id IS NULL AND pi.supplier_id IS NULL)
       OR (p_supplier_id IS NOT NULL AND pi.supplier_id = p_supplier_id))
     AND (p_identifier_id IS NULL OR pi.id <> p_identifier_id)
   LIMIT 1;

  IF v_clash.id IS NOT NULL THEN
    -- Re-scanning the SAME code onto the SAME product and level is not an
    -- operator error: enrolment is idempotent, so a repeated gun trigger
    -- confirms rather than blocks.
    IF v_clash.product_id = p_product_id
       AND v_clash.packaging_id IS NOT DISTINCT FROM p_packaging_id THEN
      RETURN jsonb_build_object(
        'status', 'ok',
        'identifier_id', v_clash.id,
        'code', v_code,
        'idempotent', true
      );
    END IF;
    RETURN jsonb_build_object(
      'status', 'duplicate',
      'reason', 'code_taken',
      'identifier_id', v_clash.id,
      'product_id', v_clash.product_id,
      'product_name', v_clash.product_name,
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
END
$fn$;

REVOKE ALL ON FUNCTION public.upsert_product_identifier(uuid,uuid,text,product_identifier_kind,uuid,boolean,uuid,product_identifier_source,uuid,timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_product_identifier(uuid,uuid,text,product_identifier_kind,uuid,boolean,uuid,product_identifier_source,uuid,timestamptz,timestamptz) TO authenticated, service_role;

-- ADR: one write seam. The legacy enrolment RPC wrote identifiers without
-- the lifecycle, supplier-scope and primary-label invariants above.
DROP FUNCTION IF EXISTS public.enroll_product_barcode(uuid,uuid,text,product_identifier_kind,uuid);

-- Identity grammar helpers are part of the identity surface: no anon.
REVOKE ALL ON FUNCTION public.identity_code_candidates(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.identity_code_candidates(text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.parse_gs1_element_string(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.parse_gs1_element_string(text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.gs1_ai_table() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gs1_ai_table() TO authenticated, service_role;