CREATE OR REPLACE FUNCTION public.wms_set_trailer_visit_client(
  p_visit_id uuid, p_client_id uuid
) RETURNS wms_trailer_visits
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_visit  public.wms_trailer_visits;
  v_client public.wms_billing_clients;
BEGIN
  SELECT * INTO v_visit FROM public.wms_trailer_visits WHERE id = p_visit_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'trailer visit not found'; END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_visit.business_id) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF NOT public.user_has_module_permission(auth.uid(), v_visit.business_id, 'inventory', 'write') THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF p_client_id IS NULL THEN RAISE EXCEPTION 'a billing client is required'; END IF;

  SELECT * INTO v_client FROM public.wms_billing_clients
   WHERE id = p_client_id AND business_id = v_visit.business_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'billing client not found for this business'; END IF;

  IF v_visit.client_id IS NOT NULL AND v_visit.client_id <> p_client_id THEN
    RAISE EXCEPTION 'visit is already attributed to another 3PL client';
  END IF;

  UPDATE public.wms_trailer_visits
     SET client_id = p_client_id
   WHERE id = p_visit_id
   RETURNING * INTO v_visit;

  RETURN v_visit;
END; $function$;

GRANT EXECUTE ON FUNCTION public.wms_set_trailer_visit_client(uuid, uuid) TO authenticated;
