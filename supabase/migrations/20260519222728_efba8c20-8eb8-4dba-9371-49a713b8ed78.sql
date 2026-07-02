CREATE OR REPLACE FUNCTION public.revoke_product_barcode(
  p_business_id uuid,
  p_product_id  uuid,
  p_code        text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user     uuid := auth.uid();
  v_norm     text;
  v_row      record;
  v_promote  uuid;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('status','forbidden','reason','unauthenticated');
  END IF;

  IF NOT public.user_can_access_business(v_user, p_business_id) THEN
    RETURN jsonb_build_object('status','forbidden','reason','forbidden');
  END IF;

  v_norm := upper(btrim(coalesce(p_code, '')));
  IF length(v_norm) = 0 THEN
    RETURN jsonb_build_object('status','not_found','reason','empty_code');
  END IF;

  SELECT id, is_primary
    INTO v_row
    FROM public.product_identifiers
   WHERE business_id = p_business_id
     AND product_id  = p_product_id
     AND code_norm   = v_norm
   LIMIT 1;

  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('status','not_found');
  END IF;

  DELETE FROM public.product_identifiers WHERE id = v_row.id;

  -- Preserve "every product has a primary identifier" invariant.
  IF v_row.is_primary THEN
    SELECT id INTO v_promote
      FROM public.product_identifiers
     WHERE product_id = p_product_id
     ORDER BY created_at ASC
     LIMIT 1;
    IF v_promote IS NOT NULL THEN
      UPDATE public.product_identifiers
         SET is_primary = true
       WHERE id = v_promote;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'status','ok',
    'promoted_identifier_id', v_promote
  );
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_product_barcode(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.revoke_product_barcode(uuid,uuid,text) TO authenticated;

COMMENT ON FUNCTION public.revoke_product_barcode(uuid,uuid,text) IS
  'Barcode Enrollment Workspace — clean reversal. Deletes the identifier and promotes the oldest remaining identifier to primary if the deleted row was primary. Returns jsonb {status: ok|not_found|forbidden, ...}.';