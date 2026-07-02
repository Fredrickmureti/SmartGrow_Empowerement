CREATE OR REPLACE FUNCTION public.flag_product_for_review(
  p_business_id uuid,
  p_product_id  uuid,
  p_reason      text DEFAULT 'Flagged in enrollment workspace'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user   uuid := auth.uid();
  v_reason text;
  v_ok     boolean;
  v_org    uuid;
  v_name   text;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('status','forbidden','reason','unauthenticated');
  END IF;

  IF NOT public.user_can_access_business(v_user, p_business_id) THEN
    RETURN jsonb_build_object('status','forbidden','reason','forbidden');
  END IF;

  v_reason := btrim(coalesce(p_reason, ''));
  IF length(v_reason) = 0 THEN
    v_reason := 'Flagged in enrollment workspace';
  END IF;
  IF length(v_reason) > 500 THEN
    v_reason := left(v_reason, 500);
  END IF;

  UPDATE public.products
     SET review_reason = v_reason
   WHERE id = p_product_id
     AND business_id = p_business_id
  RETURNING true, organization_id, name
       INTO v_ok, v_org, v_name;

  IF v_ok IS NULL THEN
    RETURN jsonb_build_object('status','not_found');
  END IF;

  -- Audit trail. Guarded so a schema drift on audit_logs can never
  -- break enrollment — flagging is the source of truth, audit is best-effort.
  BEGIN
    INSERT INTO public.audit_logs (
      organization_id, business_id, user_id, action,
      entity_type, entity_id, entity_name, new_values, changes_summary
    )
    VALUES (
      v_org, p_business_id, v_user, 'flag_for_review',
      'product', p_product_id, v_name,
      jsonb_build_object('review_reason', v_reason),
      'Flagged for review from Barcode Enrollment Workspace'
    );
  EXCEPTION WHEN OTHERS THEN
    -- Swallow audit-only failures (undefined_table, schema drift, etc.)
    NULL;
  END;

  RETURN jsonb_build_object('status','ok','reason', v_reason);
END;
$$;

COMMENT ON FUNCTION public.flag_product_for_review(uuid,uuid,text) IS
  'Barcode Enrollment Workspace — flag a product for later review. SECURITY DEFINER, user_can_access_business gated. Writes audit_logs entry (best-effort). Returns jsonb {status: ok|not_found|forbidden, reason}.';