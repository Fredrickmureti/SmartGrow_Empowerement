-- Barcode Enrollment Workspace — Phase 1
-- Adds:
--   1. products.review_reason (nullable text) for the F-flag affordance
--   2. enroll_product_barcode(...) RPC: atomic, idempotent barcode assignment
--      with TOCTOU-safe duplicate detection. Returns a structured envelope
--      so the workflow reducer can decide ok / duplicate / invalid without
--      relying on raw SQLSTATE strings.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS review_reason text;

COMMENT ON COLUMN public.products.review_reason IS
  'Set by the Barcode Enrollment workspace F-flag affordance. NULL = not flagged.';

CREATE OR REPLACE FUNCTION public.enroll_product_barcode(
  p_business_id uuid,
  p_product_id  uuid,
  p_code        text,
  p_kind        public.product_identifier_kind DEFAULT 'gtin'
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
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('status','invalid','reason','unauthenticated');
  END IF;

  IF NOT public.user_can_access_business(v_user, p_business_id) THEN
    RETURN jsonb_build_object('status','invalid','reason','forbidden');
  END IF;

  -- Trim + uppercase, mirroring the generated `code_norm`.
  v_norm := upper(btrim(coalesce(p_code, '')));
  IF length(v_norm) = 0 THEN
    RETURN jsonb_build_object('status','invalid','reason','empty_code');
  END IF;
  IF length(v_norm) > 64 THEN
    RETURN jsonb_build_object('status','invalid','reason','code_too_long');
  END IF;

  -- Confirm product exists in this business and capture its org.
  SELECT organization_id INTO v_org
    FROM public.products
   WHERE id = p_product_id AND business_id = p_business_id;
  IF v_org IS NULL THEN
    RETURN jsonb_build_object('status','invalid','reason','product_not_found');
  END IF;

  -- Idempotency: same (business, product, code, kind) → return existing.
  SELECT id INTO v_existing
    FROM public.product_identifiers
   WHERE business_id = p_business_id
     AND product_id  = p_product_id
     AND code_norm   = v_norm
     AND kind        = p_kind
   LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('status','ok','identifier_id',v_existing,'idempotent',true);
  END IF;

  -- TOCTOU-safe duplicate check against the unique (business, code_norm, kind).
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

  -- Promote to primary if this product has no primary identifier yet.
  SELECT EXISTS (
    SELECT 1 FROM public.product_identifiers
     WHERE product_id = p_product_id AND is_primary = true
  ) INTO v_has_primary;

  INSERT INTO public.product_identifiers
    (organization_id, business_id, product_id, code, kind, is_primary, created_by)
  VALUES
    (v_org, p_business_id, p_product_id, btrim(p_code), p_kind,
     NOT v_has_primary, v_user)
  RETURNING id INTO v_new_id;

  RETURN jsonb_build_object('status','ok','identifier_id',v_new_id,'idempotent',false);

EXCEPTION
  WHEN unique_violation THEN
    -- Lost a race with a concurrent insert — re-query the conflict.
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

REVOKE ALL ON FUNCTION public.enroll_product_barcode(uuid,uuid,text,public.product_identifier_kind) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enroll_product_barcode(uuid,uuid,text,public.product_identifier_kind) TO authenticated;

COMMENT ON FUNCTION public.enroll_product_barcode(uuid,uuid,text,public.product_identifier_kind) IS
  'Barcode Enrollment Workspace — atomic, idempotent identifier insert with structured envelope. Returns jsonb {status: ok|duplicate|invalid, ...}.';