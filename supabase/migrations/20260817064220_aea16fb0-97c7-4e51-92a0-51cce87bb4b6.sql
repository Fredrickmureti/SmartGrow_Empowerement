CREATE OR REPLACE FUNCTION public._wms_event_dwell_hours(_payload jsonb, _aggregate_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_min   numeric;
  v_visit uuid;
BEGIN
  v_min := NULLIF(_payload->>'dwell_minutes','')::numeric;
  -- A zero/absent dwell means the emitter had no measurement; fall back to the
  -- authoritative trailer visit clock rather than billing zero hours.
  IF COALESCE(v_min, 0) <= 0 THEN
    v_visit := COALESCE(NULLIF(_payload->>'trailer_visit_id','')::uuid,
                        NULLIF(_payload->>'visit_id','')::uuid,
                        _aggregate_id);
    IF v_visit IS NOT NULL THEN
      SELECT GREATEST(COALESCE(NULLIF(v.dwell_minutes, 0),
                      EXTRACT(EPOCH FROM (COALESCE(v.departed_at, now()) - v.arrived_at)) / 60.0), 0)
        INTO v_min
        FROM public.wms_trailer_visits v
       WHERE v.id = v_visit;
    END IF;
  END IF;
  IF v_min IS NULL THEN RETURN NULL; END IF;
  RETURN round(GREATEST(v_min, 0) / 60.0, 4);
END; $function$;

CREATE OR REPLACE FUNCTION public._wms_client_from_goods_receipt(_business_id uuid, _grn_id uuid)
 RETURNS uuid
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT rs.client_id
    FROM public.goods_receipts gr
    JOIN public.wms_receiving_sessions rs
      ON rs.business_id = _business_id
     AND rs.client_id IS NOT NULL
     AND ((rs.source_doc_type = 'purchase_order' AND rs.source_doc_id = gr.purchase_order_id)
       OR (rs.source_doc_type = 'goods_receipt'  AND rs.source_doc_id = gr.id))
   WHERE gr.id = _grn_id
   LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public._wms_client_from_count_session(_business_id uuid, _session_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_clients uuid[];
BEGIN
  SELECT array_agg(DISTINCT lp.client_id)
    INTO v_clients
    FROM public.wms_count_lines cl
    JOIN public.wms_license_plates lp
      ON lp.business_id = _business_id
     AND lp.current_location_id = cl.location_id
     AND lp.client_id IS NOT NULL
   WHERE cl.session_id = _session_id;

  -- Attribute only when the counted stock unambiguously belongs to one client.
  IF v_clients IS NULL OR array_length(v_clients, 1) <> 1 THEN RETURN NULL; END IF;
  RETURN v_clients[1];
END; $function$;

CREATE OR REPLACE FUNCTION public._wms_resolve_client_id(_business_id uuid, _payload jsonb, _aggregate_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_client   uuid;
  v_lpn      uuid;
  v_wave     uuid;
  v_manifest uuid;
  v_visit    uuid;
  v_grn      uuid;
  v_count    uuid;
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

  -- Inbound receipt work: GRN -> receiving session for the same PO -> client.
  v_grn := COALESCE(NULLIF(_payload->>'goods_receipt_id','')::uuid,
                    NULLIF(_payload->>'grn_id','')::uuid);
  IF v_grn IS NULL AND _aggregate_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.goods_receipts WHERE id = _aggregate_id) THEN
    v_grn := _aggregate_id;
  END IF;
  IF v_grn IS NOT NULL THEN
    v_client := public._wms_client_from_goods_receipt(_business_id, v_grn);
    IF v_client IS NOT NULL THEN RETURN v_client; END IF;
  END IF;

  -- Cycle count work: session -> counted locations -> stored pallets -> client.
  v_count := COALESCE(NULLIF(_payload->>'count_session_id','')::uuid, _aggregate_id);
  IF v_count IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.wms_count_sessions WHERE id = v_count) THEN
    v_client := public._wms_client_from_count_session(_business_id, v_count);
    IF v_client IS NOT NULL THEN RETURN v_client; END IF;
  END IF;

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

REVOKE ALL ON FUNCTION public._wms_client_from_goods_receipt(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._wms_client_from_count_session(uuid, uuid) FROM PUBLIC;
