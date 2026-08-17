CREATE OR REPLACE FUNCTION public.wms_set_lpn_client(p_lpn_id uuid, p_client_id uuid)
RETURNS wms_license_plates
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_lpn public.wms_license_plates;
BEGIN
  SELECT * INTO v_lpn FROM public.wms_license_plates WHERE id = p_lpn_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'license plate not found'; END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_lpn.business_id)
     OR NOT public.user_has_module_permission(auth.uid(), v_lpn.business_id, 'inventory', 'write') THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF p_client_id IS NULL THEN RAISE EXCEPTION 'a billing client is required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.wms_billing_clients
                  WHERE id = p_client_id AND business_id = v_lpn.business_id AND is_active) THEN
    RAISE EXCEPTION 'billing client not found for this business';
  END IF;
  IF v_lpn.client_id IS NOT NULL AND v_lpn.client_id <> p_client_id THEN
    RAISE EXCEPTION 'license plate is already attributed to another 3PL client';
  END IF;

  UPDATE public.wms_license_plates SET client_id = p_client_id
   WHERE id = p_lpn_id RETURNING * INTO v_lpn;
  RETURN v_lpn;
END; $function$;

CREATE OR REPLACE FUNCTION public.wms_set_receiving_session_client(p_session_id uuid, p_client_id uuid)
RETURNS wms_receiving_sessions
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_sess public.wms_receiving_sessions;
BEGIN
  SELECT * INTO v_sess FROM public.wms_receiving_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'receiving session not found'; END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_sess.business_id)
     OR NOT public.user_has_module_permission(auth.uid(), v_sess.business_id, 'inventory', 'write') THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF p_client_id IS NULL THEN RAISE EXCEPTION 'a billing client is required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.wms_billing_clients
                  WHERE id = p_client_id AND business_id = v_sess.business_id AND is_active) THEN
    RAISE EXCEPTION 'billing client not found for this business';
  END IF;
  IF v_sess.client_id IS NOT NULL AND v_sess.client_id <> p_client_id THEN
    RAISE EXCEPTION 'receiving session is already attributed to another 3PL client';
  END IF;

  UPDATE public.wms_receiving_sessions SET client_id = p_client_id
   WHERE id = p_session_id RETURNING * INTO v_sess;

  -- Propagate to pallets received under this session that are not yet attributed.
  UPDATE public.wms_license_plates lp
     SET client_id = p_client_id
   WHERE lp.business_id = v_sess.business_id
     AND lp.client_id IS NULL
     AND EXISTS (
       SELECT 1 FROM public.business_event_outbox e
        WHERE e.event_type LIKE 'warehouse.receiving.%'
          AND (e.payload->>'receiving_session_id')::uuid = p_session_id
          AND COALESCE(NULLIF(e.payload->>'lpn_id',''), NULLIF(e.payload->>'license_plate_id',''))::uuid = lp.id);

  RETURN v_sess;
END; $function$;

GRANT EXECUTE ON FUNCTION public.wms_set_lpn_client(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wms_set_receiving_session_client(uuid, uuid) TO authenticated;
