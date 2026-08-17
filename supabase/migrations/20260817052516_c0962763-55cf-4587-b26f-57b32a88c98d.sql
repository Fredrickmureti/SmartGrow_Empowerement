-- 1. The missing terminal exception state that crashed wave readiness.
ALTER TYPE public.wms_exception_state ADD VALUE IF NOT EXISTS 'cancelled';

-- 2. Register warehouse topics that emitters use but the registry did not know.
INSERT INTO public.business_event_topics (topic_prefix, producer_domain, handler_scope, description)
VALUES
  ('warehouse.task.claimed',      'warehouse', 'server', 'Operator claimed a warehouse task'),
  ('warehouse.task.completed',    'warehouse', 'server', 'Warehouse task completed (billable activity source)'),
  ('warehouse.task.exception',    'warehouse', 'server', 'Warehouse task raised an exception'),
  ('warehouse.wave.',             'warehouse', 'server', 'Pick wave lifecycle'),
  ('warehouse.pick.',             'warehouse', 'server', 'Pick execution lifecycle'),
  ('warehouse.carton.',           'warehouse', 'server', 'Pack carton lifecycle'),
  ('warehouse.manifest.',         'warehouse', 'server', 'Loading manifest lifecycle'),
  ('warehouse.count.',            'warehouse', 'server', 'Count session lifecycle'),
  ('warehouse.replen.',           'warehouse', 'server', 'Replenishment lifecycle'),
  ('warehouse.lpn.',              'warehouse', 'server', 'License plate lifecycle'),
  ('warehouse.return.',           'warehouse', 'server', 'Return order lifecycle'),
  ('warehouse.qc.',               'warehouse', 'server', 'Quality inspection lifecycle'),
  ('warehouse.appointment.',      'warehouse', 'server', 'Dock appointment lifecycle'),
  ('warehouse.gate.',             'warehouse', 'server', 'Gate check-in / exit'),
  ('warehouse.yard.',             'warehouse', 'server', 'Yard moves and trailer parking'),
  ('warehouse.trailer.',          'warehouse', 'server', 'Trailer visit lifecycle'),
  ('warehouse.crossdock.',        'warehouse', 'server', 'Cross-dock links'),
  ('warehouse.receiving.',        'warehouse', 'server', 'Receiving session lifecycle'),
  ('warehouse.billing.',          'warehouse', 'server', '3PL billing lifecycle')
ON CONFLICT (topic_prefix) DO NOTHING;

-- 3. Emitter must honour the topic registry instead of the column default.
CREATE OR REPLACE FUNCTION public._wms_emit_event(_event_type text, _aggregate_id uuid, _org_id uuid, _business_id uuid, _warehouse_id uuid, _branch_id uuid, _actor uuid, _payload jsonb, _idempotency_key text DEFAULT NULL::text, _source_doc_type text DEFAULT NULL::text, _source_doc_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _id UUID;
  _key TEXT := COALESCE(_idempotency_key, _event_type || ':' || _aggregate_id::text);
  _aggregate TEXT := split_part(_event_type, '.', 2);
  _client UUID := public._wms_resolve_client_id(_business_id, COALESCE(_payload,'{}'::jsonb), _aggregate_id);
  _scope TEXT := public.pos_topic_handler_scope(_event_type);
  _doc_type TEXT := COALESCE(NULLIF(btrim(_source_doc_type), ''), CASE _aggregate
      WHEN 'task'        THEN 'wms_tasks'
      WHEN 'lpn'         THEN 'wms_license_plates'
      WHEN 'carton'      THEN 'wms_pack_cartons'
      WHEN 'receiving'   THEN 'wms_receiving_sessions'
      WHEN 'receipt'     THEN 'wms_receiving_sessions'
      WHEN 'return'      THEN 'wms_return_orders'
      WHEN 'exception'   THEN 'wms_exceptions'
      WHEN 'wave'        THEN 'wms_pick_waves'
      WHEN 'manifest'    THEN 'wms_loading_manifests'
      WHEN 'qc'          THEN 'wms_qc_inspections'
      WHEN 'count'       THEN 'wms_count_sessions'
      WHEN 'trailer'     THEN 'wms_trailer_visits'
      WHEN 'appointment' THEN 'wms_dock_appointments'
      WHEN 'crossdock'   THEN 'wms_crossdock_links'
      WHEN 'replen'      THEN 'wms_tasks'
      ELSE 'wms_' || COALESCE(NULLIF(_aggregate, ''), 'unknown')
    END);
BEGIN
  INSERT INTO public.business_event_outbox
    (event_type, idempotency_key, payload, org_id, warehouse_id, branch_id,
     actor_user_id, source, source_doc_type, source_doc_id, status, handler_scope)
  VALUES
    (_event_type, _key,
     COALESCE(_payload,'{}'::jsonb) || jsonb_build_object(
       'aggregate_id', _aggregate_id,
       'business_id',  _business_id,
       'warehouse_id', _warehouse_id,
       'branch_id',    _branch_id,
       'actor_id',     _actor,
       'client_id',    _client,
       'occurred_at',  now()
     ),
     _org_id, _warehouse_id, _branch_id, _actor, 'warehouse',
     _doc_type, COALESCE(_source_doc_id, _aggregate_id), 'pending',
     COALESCE(_scope, 'server'))
  ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = now()
  RETURNING id INTO _id;
  RETURN _id;
END $function$;

-- 4. Billing must resolve the BUSINESS of an event, not assume org_id is a business.
CREATE OR REPLACE FUNCTION public._wms_event_business_id(_org_id uuid, _warehouse_id uuid, _payload jsonb)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT b.id FROM public.businesses b
      WHERE b.id = NULLIF(_payload->>'business_id','')::uuid),
    (SELECT w.business_id FROM public.warehouses w WHERE w.id = _warehouse_id),
    (SELECT b.id FROM public.businesses b WHERE b.id = _org_id)
  );
$function$;

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

  v_client    := public._wms_resolve_client_id(v_biz, v_evt.payload,
                   NULLIF(v_evt.payload->>'aggregate_id','')::uuid);
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
  v_qty       := COALESCE((v_evt.payload->>'quantity')::numeric,
                          (v_evt.payload->>'dwell_minutes')::numeric / 60.0,
                          1);

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

CREATE OR REPLACE FUNCTION public.capture_billable_activity(p_event_id uuid)
 RETURNS wms_billable_activities
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_biz uuid;
BEGIN
  SELECT public._wms_event_business_id(o.org_id, o.warehouse_id, o.payload)
    INTO v_biz
    FROM public.business_event_outbox o WHERE o.id = p_event_id;
  IF v_biz IS NULL THEN RAISE EXCEPTION 'event not found'; END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_biz) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  RETURN public._wms_capture_billable_activity_internal(p_event_id);
END; $function$;

CREATE OR REPLACE FUNCTION public.capture_pending_billable_activities(p_business_id uuid, p_limit integer DEFAULT 200)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_evt_id uuid;
  v_count  int := 0;
BEGIN
  IF p_business_id NOT IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'access denied';
  END IF;

  FOR v_evt_id IN
    SELECT o.id
      FROM public.business_event_outbox o
      LEFT JOIN public.wms_billable_activities b
        ON b.source_event_id = o.id AND b.business_id = p_business_id
     WHERE o.event_type LIKE 'warehouse.%'
       AND public._wms_event_business_id(o.org_id, o.warehouse_id, o.payload) = p_business_id
       AND public._wms_map_event_to_activity(o.event_type, o.payload) IS NOT NULL
       AND b.id IS NULL
     ORDER BY o.created_at ASC
     LIMIT p_limit
  LOOP
    BEGIN
      PERFORM public._wms_capture_billable_activity_internal(v_evt_id);
      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'capture failed for event %: %', v_evt_id, SQLERRM;
    END;
  END LOOP;

  RETURN v_count;
END; $function$;

CREATE OR REPLACE FUNCTION public.wms_billing_nightly_sweep()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_biz   uuid;
  v_total int := 0;
  v_evt   record;
BEGIN
  FOR v_biz IN
    SELECT DISTINCT business_id FROM public.wms_billing_clients WHERE is_active
  LOOP
    BEGIN
      v_total := v_total + public._wms_accrue_storage_days_internal(v_biz, CURRENT_DATE - 1);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'storage accrual failed for business %: %', v_biz, SQLERRM;
    END;

    FOR v_evt IN
      SELECT o.id
        FROM public.business_event_outbox o
       WHERE o.event_type LIKE 'warehouse.%'
         AND public._wms_event_business_id(o.org_id, o.warehouse_id, o.payload) = v_biz
         AND public._wms_map_event_to_activity(o.event_type, o.payload) IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM public.wms_billable_activities a
            WHERE a.business_id = v_biz AND a.source_event_id = o.id)
       ORDER BY o.created_at
       LIMIT 2000
    LOOP
      BEGIN
        PERFORM public._wms_capture_billable_activity_internal(v_evt.id);
        v_total := v_total + 1;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'capture failed for event %: %', v_evt.id, SQLERRM;
      END;
    END LOOP;
  END LOOP;

  RETURN v_total;
END; $function$;