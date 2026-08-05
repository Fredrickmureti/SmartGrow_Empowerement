-- ============================================================
-- Phase 5 — every identifier write goes through the service
-- ============================================================
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

  -- Live duplicate anywhere in the business blocks the write.
  SELECT pi.id, pi.product_id INTO v_clash
    FROM public.product_identifiers pi
   WHERE pi.business_id = p_business_id
     AND pi.code_norm = v_norm
     AND pi.status = 'active'
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

  -- Primary flip is ONE atomic step: demote siblings, then promote.
  IF p_is_primary THEN
    UPDATE public.product_identifiers
       SET is_primary = false, updated_at = now()
     WHERE product_id = p_product_id AND is_primary = true AND id <> v_id;
    UPDATE public.product_identifiers
       SET is_primary = true, updated_at = now()
     WHERE id = v_id;
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.product_identifiers
     WHERE product_id = p_product_id AND is_primary = true AND status = 'active'
  ) THEN
    -- Invariant: an active product always has exactly one primary.
    UPDATE public.product_identifiers SET is_primary = true, updated_at = now() WHERE id = v_id;
  END IF;

  RETURN jsonb_build_object('status', 'ok', 'identifier_id', v_id, 'code', v_code);
END $fn$;

CREATE OR REPLACE FUNCTION public.retire_product_identifier(
  p_business_id uuid,
  p_identifier_id uuid,
  p_status public.product_identifier_status DEFAULT 'archived',
  p_replaced_by_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_user uuid := auth.uid();
  v_row public.product_identifiers%ROWTYPE;
  v_promoted uuid;
BEGIN
  IF v_user IS NULL OR NOT public.user_can_access_business(v_user, p_business_id) THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'unauthenticated');
  END IF;
  IF p_status = 'active' THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'not_a_retirement');
  END IF;

  SELECT * INTO v_row FROM public.product_identifiers
   WHERE id = p_identifier_id AND business_id = p_business_id;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'unknown_identifier');
  END IF;

  UPDATE public.product_identifiers
     SET status = p_status,
         is_primary = false,
         replaced_by_id = p_replaced_by_id,
         valid_to = COALESCE(valid_to, now()),
         updated_at = now()
   WHERE id = p_identifier_id;

  -- Keep "exactly one primary" true after retiring the primary.
  IF v_row.is_primary THEN
    UPDATE public.product_identifiers
       SET is_primary = true, updated_at = now()
     WHERE id = (
       SELECT pi.id FROM public.product_identifiers pi
        WHERE pi.product_id = v_row.product_id
          AND pi.status = 'active'
          AND pi.id <> p_identifier_id
        ORDER BY pi.created_at
        LIMIT 1
     )
     RETURNING id INTO v_promoted;
  END IF;

  RETURN jsonb_build_object('status', 'ok', 'identifier_id', p_identifier_id,
                            'promoted_identifier_id', v_promoted);
END $fn$;

REVOKE ALL ON FUNCTION public.upsert_product_identifier(uuid, uuid, text, public.product_identifier_kind, uuid, boolean, uuid, public.product_identifier_source, uuid, timestamptz, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.retire_product_identifier(uuid, uuid, public.product_identifier_status, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_product_identifier(uuid, uuid, text, public.product_identifier_kind, uuid, boolean, uuid, public.product_identifier_source, uuid, timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.retire_product_identifier(uuid, uuid, public.product_identifier_status, uuid) TO authenticated;