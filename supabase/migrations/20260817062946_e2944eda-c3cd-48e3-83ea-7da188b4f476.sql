-- 1. Duplicate producer: wms_trailer_visits carried BOTH the canonical
--    emit_yard_event call (ADR 0080, rich payload) and the generic FSM
--    trigger. Both emitted warehouse.trailer.departed under different
--    idempotency keys ('wms.trailer_visit:<id>:departed' vs
--    'wms.trailer:<id>:departed'), so one physical departure produced two
--    outbox rows and two yard_dwell ledger rows. Keep emit_yard_event.
DROP TRIGGER IF EXISTS trg_wms_trailers_emit ON public.wms_trailer_visits;

-- 2. Billing quantity semantics. Per-event activities are charged one unit
--    per event; only measured activities read a quantity off the event.
CREATE OR REPLACE FUNCTION public._wms_billing_quantity(
  _activity text, _payload jsonb, _aggregate_id uuid
) RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF _activity = 'yard_dwell' THEN
    RETURN COALESCE(public._wms_event_dwell_hours(_payload, _aggregate_id), 0);
  ELSIF _activity = 'storage_lpn_day' THEN
    RETURN COALESCE((_payload->>'quantity')::numeric, 1);
  ELSE
    -- receive_lpn, putaway, pick_line, pack_package, dispatch_shipment,
    -- qc_inspection, cycle_count: the event IS the billable unit. The
    -- payload 'quantity' is a stock quantity, never a handling count.
    RETURN 1;
  END IF;
END; $function$;

-- 3. Capture: use the quantity helper, and refuse a second yard_dwell for
--    the same trailer visit (defence in depth behind fix 1).
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

  -- One yard dwell charge per trailer visit, whatever emitted the event.
  IF v_activity = 'yard_dwell' AND v_agg IS NOT NULL THEN
    SELECT * INTO v_existing
      FROM public.wms_billable_activities b
     WHERE b.business_id = v_biz
       AND b.activity = 'yard_dwell'
       AND b.source_doc_id = v_agg
       AND b.reverses_activity_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.wms_billable_activities r
                        WHERE r.reverses_activity_id = b.id)
     LIMIT 1;
    IF FOUND THEN RETURN v_existing; END IF;
  END IF;

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

  v_qty := public._wms_billing_quantity(v_activity, v_evt.payload, v_agg);

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
    v_qty, v_occurred, p_event_id, v_evt.source_doc_type,
    COALESCE(v_evt.source_doc_id, v_agg),
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

-- 4. Reversal: split the ledger mechanics out of the authorization wrapper
--    so corrections can also be driven by maintenance/backfill paths.
CREATE OR REPLACE FUNCTION public._wms_reverse_billable_activity_internal(
  p_activity_id uuid, p_reason text
) RETURNS wms_billable_activities
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_src public.wms_billable_activities;
  v_row public.wms_billable_activities;
BEGIN
  SELECT * INTO v_src FROM public.wms_billable_activities WHERE id = p_activity_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'activity not found'; END IF;
  IF v_src.reverses_activity_id IS NOT NULL THEN
    RAISE EXCEPTION 'a reversal cannot itself be reversed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.wms_billable_activities
              WHERE reverses_activity_id = p_activity_id) THEN
    RAISE EXCEPTION 'this activity has already been reversed';
  END IF;
  IF COALESCE(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'a reversal reason is required';
  END IF;
  IF v_src.invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'activity is already invoiced; issue a credit note instead';
  END IF;

  PERFORM public._wms_assert_period_open(v_src.business_id, CURRENT_DATE);

  INSERT INTO public.wms_billable_activities (
    business_id, client_id, client_business_id, warehouse_id, activity, uom,
    quantity, occurred_at, source_event_id, source_doc_type, source_doc_id,
    tariff_id, unit_rate, currency, amount, reverses_activity_id, dispute_reason
  ) VALUES (
    v_src.business_id, v_src.client_id, v_src.client_business_id, v_src.warehouse_id,
    v_src.activity, v_src.uom,
    -v_src.quantity, now(), NULL, 'wms_billing_reversal', v_src.id,
    v_src.tariff_id, v_src.unit_rate, v_src.currency,
    CASE WHEN v_src.amount IS NULL THEN NULL ELSE -v_src.amount END,
    v_src.id, p_reason
  ) RETURNING * INTO v_row;

  RETURN v_row;
END; $function$;

CREATE OR REPLACE FUNCTION public.wms_reverse_billable_activity(
  p_activity_id uuid, p_reason text
) RETURNS wms_billable_activities
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_biz uuid;
BEGIN
  SELECT business_id INTO v_biz FROM public.wms_billable_activities WHERE id = p_activity_id;
  IF v_biz IS NULL THEN RAISE EXCEPTION 'activity not found'; END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_biz) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF NOT public.user_has_module_permission(auth.uid(), v_biz, 'inventory', 'write') THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  RETURN public._wms_reverse_billable_activity_internal(p_activity_id, p_reason);
END; $function$;

-- 5. Re-pricing: reverse the stale row and post a restatement priced with
--    today's client attribution, quantity rules and tariffs. The ledger is
--    never edited or deleted; the chain original → reversal → restatement
--    is fully auditable.
CREATE OR REPLACE FUNCTION public._wms_reprice_billable_activity_internal(
  p_activity_id uuid, p_reason text
) RETURNS wms_billable_activities
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_src     public.wms_billable_activities;
  v_evt     public.business_event_outbox;
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

  IF v_src.source_event_id IS NOT NULL THEN
    SELECT * INTO v_evt FROM public.business_event_outbox WHERE id = v_src.source_event_id;
  END IF;

  v_agg := COALESCE(
    NULLIF(v_evt.payload->>'aggregate_id','')::uuid,
    v_evt.source_doc_id,
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

CREATE OR REPLACE FUNCTION public.wms_reprice_billable_activity(
  p_activity_id uuid, p_reason text
) RETURNS wms_billable_activities
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_biz uuid;
BEGIN
  SELECT business_id INTO v_biz FROM public.wms_billable_activities WHERE id = p_activity_id;
  IF v_biz IS NULL THEN RAISE EXCEPTION 'activity not found'; END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_biz) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF NOT public.user_has_module_permission(auth.uid(), v_biz, 'inventory', 'write') THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF COALESCE(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'a re-pricing reason is required';
  END IF;
  RETURN public._wms_reprice_billable_activity_internal(p_activity_id, p_reason);
END; $function$;

REVOKE ALL ON FUNCTION public._wms_reverse_billable_activity_internal(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._wms_reprice_billable_activity_internal(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._wms_billing_quantity(text, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_reprice_billable_activity(uuid, text) TO authenticated;
