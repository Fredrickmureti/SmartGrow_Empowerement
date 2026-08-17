
-- 1) Client attribution helper: wave -> sales order -> customer -> billing client
CREATE OR REPLACE FUNCTION public._wms_client_from_wave(_business_id uuid, _wave_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT bc.id
    FROM public.wms_pick_wave_lines wl
    JOIN public.sales_orders so ON so.id = wl.sales_order_id
    JOIN public.wms_billing_clients bc
      ON bc.business_id = _business_id
     AND bc.is_active
     AND (bc.contact_id = so.contact_id OR bc.client_business_id = so.business_id)
   WHERE wl.wave_id = _wave_id
   LIMIT 1;
$$;

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
    SELECT client_id INTO v_client FROM public.wms_loading_manifests WHERE id = _aggregate_id;
    IF v_client IS NOT NULL THEN RETURN v_client; END IF;
    SELECT client_id INTO v_client FROM public.wms_trailer_visits WHERE id = _aggregate_id;
    IF v_client IS NOT NULL THEN RETURN v_client; END IF;
  END IF;

  SELECT client_id INTO v_client FROM public.wms_receiving_sessions
   WHERE id = NULLIF(_payload->>'receiving_session_id','')::uuid;
  IF v_client IS NOT NULL THEN RETURN v_client; END IF;
  SELECT client_id INTO v_client FROM public.wms_loading_manifests
   WHERE id = NULLIF(_payload->>'manifest_id','')::uuid;
  IF v_client IS NOT NULL THEN RETURN v_client; END IF;
  SELECT client_id INTO v_client FROM public.wms_trailer_visits
   WHERE id = NULLIF(_payload->>'trailer_visit_id','')::uuid;
  IF v_client IS NOT NULL THEN RETURN v_client; END IF;

  -- Outbound execution work: task -> wave -> sales order -> customer -> client.
  v_wave := COALESCE(
    NULLIF(_payload->>'wave_id','')::uuid,
    (SELECT t.wave_id FROM public.wms_tasks t WHERE t.id = _aggregate_id));
  IF v_wave IS NOT NULL THEN
    v_client := public._wms_client_from_wave(_business_id, v_wave);
    IF v_client IS NOT NULL THEN RETURN v_client; END IF;
  END IF;

  -- Dispatch work: manifest -> wave -> order -> customer -> client.
  v_manifest := COALESCE(NULLIF(_payload->>'manifest_id','')::uuid, _aggregate_id);
  IF v_manifest IS NOT NULL THEN
    SELECT wave_id INTO v_wave FROM public.wms_loading_manifests WHERE id = v_manifest;
    IF v_wave IS NOT NULL THEN
      v_client := public._wms_client_from_wave(_business_id, v_wave);
      IF v_client IS NOT NULL THEN RETURN v_client; END IF;
    END IF;
  END IF;

  -- Yard work: trailer visit -> its manifests -> wave -> order -> customer -> client.
  v_visit := COALESCE(NULLIF(_payload->>'trailer_visit_id','')::uuid,
                      NULLIF(_payload->>'visit_id','')::uuid,
                      _aggregate_id);
  IF v_visit IS NOT NULL THEN
    SELECT COALESCE(m.client_id, public._wms_client_from_wave(_business_id, m.wave_id))
      INTO v_client
      FROM public.wms_loading_manifests m
     WHERE m.trailer_visit_id = v_visit
       AND COALESCE(m.client_id, public._wms_client_from_wave(_business_id, m.wave_id)) IS NOT NULL
     ORDER BY m.created_at
     LIMIT 1;
    IF v_client IS NOT NULL THEN RETURN v_client; END IF;
  END IF;

  RETURN NULL;
END; $function$;

-- 2) Dwell quantity from the real yard clock when the event omits it
CREATE OR REPLACE FUNCTION public._wms_event_dwell_hours(_payload jsonb, _aggregate_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_min   numeric;
  v_visit uuid;
BEGIN
  v_min := NULLIF(_payload->>'dwell_minutes','')::numeric;
  IF v_min IS NULL THEN
    v_visit := COALESCE(NULLIF(_payload->>'trailer_visit_id','')::uuid,
                        NULLIF(_payload->>'visit_id','')::uuid,
                        _aggregate_id);
    IF v_visit IS NOT NULL THEN
      SELECT COALESCE(v.dwell_minutes,
                      EXTRACT(EPOCH FROM (COALESCE(v.departed_at, now()) - v.arrived_at)) / 60.0)
        INTO v_min
        FROM public.wms_trailer_visits v
       WHERE v.id = v_visit;
    END IF;
  END IF;
  IF v_min IS NULL THEN RETURN NULL; END IF;
  RETURN round(GREATEST(v_min, 0) / 60.0, 4);
END; $$;

CREATE OR REPLACE FUNCTION public._wms_capture_billable_activity_internal(p_event_id uuid)
RETURNS wms_billable_activities
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_evt       public.business_event_outbox;
  v_activity  text;
  v_biz       uuid;
  v_org       uuid;
  v_client    uuid;
  v_client_bz uuid;
  v_warehouse uuid;
  v_qty       numeric;
  v_agg       uuid;
  v_occurred  timestamptz;
  v_tariff    public.wms_billing_tariffs;
  v_existing  public.wms_billable_activities;
  v_row       public.wms_billable_activities;
  v_amount    numeric;
  v_code      text;
BEGIN
  SELECT * INTO v_evt FROM public.business_event_outbox WHERE id = p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'event not found'; END IF;

  v_biz := public._wms_event_business_id(v_evt.org_id, v_evt.warehouse_id, v_evt.payload);
  IF v_biz IS NULL THEN RAISE EXCEPTION 'cannot resolve business for event %', p_event_id; END IF;

  v_activity := public._wms_map_event_to_activity(v_evt.event_type, v_evt.payload);
  IF v_activity IS NULL THEN
    RAISE EXCEPTION 'event_type % is not billable', v_evt.event_type;
  END IF;

  SELECT * INTO v_existing
    FROM public.wms_billable_activities
   WHERE business_id = v_biz AND source_event_id = p_event_id;
  IF FOUND THEN RETURN v_existing; END IF;

  v_occurred := COALESCE(v_evt.created_at, now());
  PERFORM public._wms_assert_period_open(v_biz, v_occurred::date);

  v_agg := COALESCE(NULLIF(v_evt.payload->>'aggregate_id','')::uuid, v_evt.source_doc_id);

  v_client    := public._wms_resolve_client_id(v_biz, v_evt.payload, v_agg);
  v_client_bz := NULLIF(v_evt.payload->>'client_business_id','')::uuid;

  IF v_client IS NOT NULL THEN
    SELECT id INTO v_client FROM public.wms_billing_clients
     WHERE business_id = v_biz AND id = v_client AND is_active;
  ELSIF v_client_bz IS NOT NULL THEN
    SELECT id INTO v_client FROM public.wms_billing_clients
     WHERE business_id = v_biz AND client_business_id = v_client_bz AND is_active
     LIMIT 1;
  END IF;

  v_warehouse := COALESCE(v_evt.warehouse_id,
                          NULLIF(v_evt.payload->>'warehouse_id','')::uuid);

  IF v_activity = 'yard_dwell' THEN
    v_qty := COALESCE(public._wms_event_dwell_hours(v_evt.payload, v_agg), 0);
  ELSE
    v_qty := COALESCE((v_evt.payload->>'quantity')::numeric, 1);
  END IF;

  v_tariff := public._wms_resolve_tariff(v_biz, v_client, v_activity,
                                         v_occurred::date, v_qty);
  v_amount := public._wms_price_activity(v_tariff, v_qty);

  INSERT INTO public.wms_billable_activities (
    business_id, client_id, client_business_id, warehouse_id, activity, uom,
    quantity, occurred_at, source_event_id, source_doc_type, source_doc_id,
    tariff_id, unit_rate, currency, amount
  ) VALUES (
    v_biz, v_client, v_client_bz, v_warehouse, v_activity,
    COALESCE(v_tariff.uom, 'unit'),
    v_qty, v_occurred, p_event_id, v_evt.source_doc_type, v_evt.source_doc_id,
    v_tariff.id, v_tariff.rate, v_tariff.currency, v_amount
  ) RETURNING * INTO v_row;

  IF v_tariff.id IS NULL AND v_warehouse IS NOT NULL THEN
    SELECT organization_id INTO v_org FROM public.businesses WHERE id = v_biz;
    SELECT code INTO v_code FROM public.wms_billing_clients WHERE id = v_client;

    IF NOT EXISTS (
      SELECT 1 FROM public.wms_exceptions
       WHERE business_id = v_biz
         AND kind = 'billing_unpriced'
         AND state IN ('open','acknowledged','investigating','escalated')
         AND aggregate_type = 'wms_billable_activities'
         AND details->>'activity' = v_activity
         AND COALESCE(details->>'client_id','') = COALESCE(v_client::text,'')
    ) THEN
      INSERT INTO public.wms_exceptions (
        organization_id, business_id, branch_id, warehouse_id, kind, state,
        severity, aggregate_type, aggregate_id, reason, details, raised_by
      ) VALUES (
        v_org, v_biz, v_evt.branch_id, v_warehouse, 'billing_unpriced', 'open',
        2, 'wms_billable_activities', v_row.id,
        'No active tariff prices "' || v_activity || '"'
          || COALESCE(' for client ' || v_code, ' (no client attributed)')
          || ' — this work cannot be invoiced.',
        jsonb_build_object('activity', v_activity, 'client_id', v_client,
                           'quantity', v_qty, 'occurred_at', v_occurred),
        auth.uid()
      );
    END IF;
  END IF;

  RETURN v_row;
END; $function$;
