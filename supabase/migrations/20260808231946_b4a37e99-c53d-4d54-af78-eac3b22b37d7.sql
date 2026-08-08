CREATE OR REPLACE FUNCTION public.set_estimate_status_atomic(
  p_estimate_id uuid,
  p_status text,
  p_user_id uuid DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_est RECORD;
  v_auth_user uuid := auth.uid();
  v_jwt_role text := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_user uuid;
  v_allowed text[];
BEGIN
  IF v_jwt_role = 'service_role' THEN
    v_user := p_user_id;
  ELSE
    IF v_auth_user IS NULL THEN
      RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    IF p_user_id IS NOT NULL AND p_user_id IS DISTINCT FROM v_auth_user THEN
      RAISE EXCEPTION 'Caller identity mismatch' USING ERRCODE = '42501';
    END IF;
    v_user := v_auth_user;
  END IF;

  SELECT * INTO v_est FROM public.estimates WHERE id = p_estimate_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Estimate % not found', p_estimate_id;
  END IF;

  IF v_user IS NULL OR NOT public.user_can_access_business(v_user, v_est.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_est.business_id USING ERRCODE = '42501';
  END IF;

  IF v_est.status::text = p_status THEN
    RETURN jsonb_build_object('success', true, 'status', p_status, 'unchanged', true);
  END IF;

  v_allowed := CASE v_est.status::text
    WHEN 'draft'     THEN ARRAY['sent','rejected','expired']
    WHEN 'sent'      THEN ARRAY['viewed','accepted','rejected','expired']
    WHEN 'viewed'    THEN ARRAY['accepted','rejected','expired']
    WHEN 'accepted'  THEN ARRAY['converted','rejected','expired']
    WHEN 'expired'   THEN ARRAY['sent']
    ELSE ARRAY[]::text[]
  END;

  IF NOT (p_status = ANY (v_allowed)) THEN
    RAISE EXCEPTION 'Illegal estimate transition % -> %', v_est.status, p_status
      USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('app.estimate_status_writer', '1', true);
  UPDATE public.estimates
  SET status      = p_status::public.estimate_status,
      sent_at     = CASE WHEN p_status = 'sent'     THEN now() ELSE sent_at END,
      viewed_at   = CASE WHEN p_status = 'viewed'   THEN now() ELSE viewed_at END,
      accepted_at = CASE WHEN p_status = 'accepted' THEN now() ELSE accepted_at END,
      rejected_at = CASE WHEN p_status = 'rejected' THEN now() ELSE rejected_at END,
      updated_at  = now()
  WHERE id = p_estimate_id;
  PERFORM set_config('app.estimate_status_writer', '0', true);

  INSERT INTO public.estimate_status_events(
    estimate_id, organization_id, business_id, from_status, to_status, reason, changed_by
  ) VALUES (
    p_estimate_id, v_est.organization_id, v_est.business_id, v_est.status::text, p_status, p_reason, v_user
  );

  RETURN jsonb_build_object('success', true, 'status', p_status, 'from_status', v_est.status::text);
END;
$$;

REVOKE ALL ON FUNCTION public.set_estimate_status_atomic(uuid, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_estimate_status_atomic(uuid, text, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.set_estimate_status_atomic(uuid, text, uuid, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.set_estimate_status_atomic(uuid, text, uuid, text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.set_estimate_status_atomic(uuid, text, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_estimate_status_atomic(uuid, text, uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';