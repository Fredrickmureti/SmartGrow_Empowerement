
CREATE OR REPLACE FUNCTION public._wms_client_from_manifest(_business_id uuid, _manifest_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_client uuid;
  v_wave   uuid;
BEGIN
  IF _business_id IS NULL OR _manifest_id IS NULL THEN RETURN NULL; END IF;

  SELECT client_id, wave_id INTO v_client, v_wave
    FROM public.wms_loading_manifests WHERE id = _manifest_id;
  IF v_client IS NOT NULL THEN RETURN v_client; END IF;

  IF v_wave IS NOT NULL THEN
    v_client := public._wms_client_from_wave(_business_id, v_wave);
    IF v_client IS NOT NULL THEN RETURN v_client; END IF;
  END IF;

  -- Loaded cartons -> picked order lines -> customer -> 3PL client
  SELECT bc.id INTO v_client
    FROM public.wms_manifest_cartons mc
    JOIN public.wms_pick_wave_lines wl ON wl.packed_carton_id = mc.carton_id
    JOIN public.sales_orders so ON so.id = wl.sales_order_id
    JOIN public.wms_billing_clients bc
      ON bc.business_id = _business_id
     AND bc.is_active
     AND (bc.contact_id = so.contact_id OR bc.client_business_id = so.business_id)
   WHERE mc.manifest_id = _manifest_id
   LIMIT 1;

  RETURN v_client;
END; $$;

CREATE OR REPLACE FUNCTION public._wms_client_from_trailer_visit(_business_id uuid, _visit_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_client uuid;
  v_appt   uuid;
  v_man    uuid;
BEGIN
  IF _business_id IS NULL OR _visit_id IS NULL THEN RETURN NULL; END IF;

  SELECT client_id, appointment_id INTO v_client, v_appt
    FROM public.wms_trailer_visits WHERE id = _visit_id;
  IF v_client IS NOT NULL THEN RETURN v_client; END IF;

  SELECT m.id INTO v_man FROM public.wms_loading_manifests m
   WHERE m.trailer_visit_id = _visit_id
   ORDER BY m.created_at LIMIT 1;
  IF v_man IS NULL AND v_appt IS NOT NULL THEN
    SELECT m.id INTO v_man FROM public.wms_loading_manifests m
     WHERE m.appointment_id = v_appt
     ORDER BY m.created_at LIMIT 1;
  END IF;

  IF v_man IS NOT NULL THEN
    RETURN public._wms_client_from_manifest(_business_id, v_man);
  END IF;

  RETURN NULL;
END; $$;

CREATE OR REPLACE FUNCTION public._wms_resolve_client_id(_business_id uuid, _payload jsonb, _aggregate_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_client   uuid;
  v_lpn      uuid;
  v_wave     uuid;
  v_manifest uuid;
  v_visit    uuid;
BEGIN
  IF _business_id IS NULL THEN RETURN NULL; END IF;

  v_client := NULLIF(_payload->>'client_id','')::uuid;
  IF v_client IS NOT NULL THEN RETURN v_client; END IF;

  v_lpn := COALESCE(NULLIF(_payload->>'lpn_id','')::uuid,
                    NULLIF(_payload->>'license_plate_id','')::uuid);
  IF v_lpn IS NOT NULL THEN
    SELECT client_id INTO v_client FROM public.wms_license_plates WHERE id = v_lpn;
    IF v_client IS NOT NULL THEN RETURN v_client; END IF;
  END IF;

  IF _aggregate_id IS NOT NULL THEN
    SELECT client_id INTO v_client FROM public.wms_license_plates WHERE id = _aggregate_id;
    IF v_client IS NOT NULL THEN RETURN v_client; END IF;
    SELECT client_id INTO v_client FROM public.wms_receiving_sessions WHERE id = _aggregate_id;
    IF v_client IS NOT NULL THEN RETURN v_client; END IF;
  END IF;

  SELECT client_id INTO v_client FROM public.wms_receiving_sessions
   WHERE id = NULLIF(_payload->>'receiving_session_id','')::uuid;
  IF v_client IS NOT NULL THEN RETURN v_client; END IF;

  -- Outbound execution work: task -> wave -> sales order -> customer -> client.
  v_wave := COALESCE(
    NULLIF(_payload->>'wave_id','')::uuid,
    (SELECT t.wave_id FROM public.wms_tasks t WHERE t.id = _aggregate_id));
  IF v_wave IS NOT NULL THEN
    v_client := public._wms_client_from_wave(_business_id, v_wave);
    IF v_client IS NOT NULL THEN RETURN v_client; END IF;
  END IF;

  -- Dispatch work: manifest -> wave / loaded cartons -> order -> customer -> client.
  v_manifest := COALESCE(NULLIF(_payload->>'manifest_id','')::uuid, _aggregate_id);
  IF v_manifest IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.wms_loading_manifests WHERE id = v_manifest) THEN
    v_client := public._wms_client_from_manifest(_business_id, v_manifest);
    IF v_client IS NOT NULL THEN RETURN v_client; END IF;
  END IF;

  -- Yard work: trailer visit -> manifest -> order -> customer -> client.
  v_visit := COALESCE(NULLIF(_payload->>'trailer_visit_id','')::uuid,
                      NULLIF(_payload->>'visit_id','')::uuid,
                      _aggregate_id);
  IF v_visit IS NOT NULL THEN
    v_client := public._wms_client_from_trailer_visit(_business_id, v_visit);
    IF v_client IS NOT NULL THEN RETURN v_client; END IF;
  END IF;

  RETURN NULL;
END; $function$;
