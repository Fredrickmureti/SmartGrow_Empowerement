CREATE OR REPLACE FUNCTION public._wms_reprice_billable_activity_internal(
  p_activity_id uuid, p_reason text
) RETURNS wms_billable_activities
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_src     public.wms_billable_activities;
  v_cur     public.wms_billable_activities;
  v_evt     public.business_event_outbox;
  v_evt_id  uuid;
  v_hops    int := 0;
  v_agg     uuid;
  v_client  uuid;
  v_qty     numeric;
  v_tariff  public.wms_billing_tariffs;
  v_row     public.wms_billable_activities;
BEGIN
  SELECT * INTO v_src FROM public.wms_billable_activities WHERE id = p_activity_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'activity not found'; END IF;
  IF v_src.reverses_activity_id IS NOT NULL THEN
    RAISE EXCEPTION 'a reversal cannot be repriced';
  END IF;

  PERFORM public._wms_reverse_billable_activity_internal(
    p_activity_id, COALESCE(NULLIF(btrim(p_reason),''), 'repriced'));

  -- Walk back through prior restatements to the originating warehouse event.
  v_cur := v_src;
  WHILE v_cur.source_event_id IS NULL
        AND v_cur.source_doc_type = 'wms_billing_restatement'
        AND v_cur.source_doc_id IS NOT NULL
        AND v_hops < 20 LOOP
    SELECT * INTO v_cur FROM public.wms_billable_activities WHERE id = v_cur.source_doc_id;
    IF NOT FOUND THEN EXIT; END IF;
    v_hops := v_hops + 1;
  END LOOP;
  v_evt_id := v_cur.source_event_id;

  IF v_evt_id IS NOT NULL THEN
    SELECT * INTO v_evt FROM public.business_event_outbox WHERE id = v_evt_id;
  END IF;

  v_agg := COALESCE(
    NULLIF(v_evt.payload->>'aggregate_id','')::uuid,
    v_evt.source_doc_id,
    v_cur.source_doc_id,
    v_src.source_doc_id);

  v_client := COALESCE(
    public._wms_resolve_client_id(v_src.business_id,
                                  COALESCE(v_evt.payload, '{}'::jsonb), v_agg),
    v_src.client_id);
  IF v_client IS NOT NULL THEN
    SELECT id INTO v_client FROM public.wms_billing_clients
     WHERE business_id = v_src.business_id AND id = v_client AND is_active;
  END IF;

  v_qty := public._wms_billing_quantity(v_src.activity,
                                        COALESCE(v_evt.payload, '{}'::jsonb), v_agg);

  v_tariff := public._wms_resolve_tariff(v_src.business_id, v_client, v_src.activity,
                                         v_src.occurred_at::date, v_qty);

  INSERT INTO public.wms_billable_activities (
    business_id, client_id, client_business_id, warehouse_id, activity, uom,
    quantity, occurred_at, source_event_id, source_doc_type, source_doc_id,
    tariff_id, unit_rate, currency, amount, dispute_reason
  ) VALUES (
    v_src.business_id, v_client, v_src.client_business_id, v_src.warehouse_id,
    v_src.activity, COALESCE(v_tariff.uom, v_src.uom, 'unit'),
    v_qty, v_src.occurred_at, NULL, 'wms_billing_restatement', p_activity_id,
    v_tariff.id, v_tariff.rate, v_tariff.currency,
    public._wms_price_activity(v_tariff, v_qty),
    COALESCE(NULLIF(btrim(p_reason),''), 'repriced')
  ) RETURNING * INTO v_row;

  RETURN v_row;
END; $function$;
