-- ═══════════════════════════════════════════════════════════════════════
-- 3PL billing platform — Phase 3: client attribution end to end
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1) Client ownership on the physical/document aggregates ────────────
ALTER TABLE public.wms_license_plates
  ADD COLUMN IF NOT EXISTS client_id uuid NULL
    REFERENCES public.wms_billing_clients(id) ON DELETE SET NULL;
ALTER TABLE public.wms_receiving_sessions
  ADD COLUMN IF NOT EXISTS client_id uuid NULL
    REFERENCES public.wms_billing_clients(id) ON DELETE SET NULL;
ALTER TABLE public.wms_loading_manifests
  ADD COLUMN IF NOT EXISTS client_id uuid NULL
    REFERENCES public.wms_billing_clients(id) ON DELETE SET NULL;
ALTER TABLE public.wms_trailer_visits
  ADD COLUMN IF NOT EXISTS client_id uuid NULL
    REFERENCES public.wms_billing_clients(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_wms_license_plates_client
  ON public.wms_license_plates (business_id, client_id);
CREATE INDEX IF NOT EXISTS idx_wms_receiving_sessions_client
  ON public.wms_receiving_sessions (business_id, client_id);
CREATE INDEX IF NOT EXISTS idx_wms_loading_manifests_client
  ON public.wms_loading_manifests (business_id, client_id);
CREATE INDEX IF NOT EXISTS idx_wms_trailer_visits_client
  ON public.wms_trailer_visits (business_id, client_id);

-- ── 2) Central client resolver used by every emitter ───────────────────
CREATE OR REPLACE FUNCTION public._wms_resolve_client_id(
  _business_id uuid,
  _payload     jsonb,
  _aggregate_id uuid
) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_client uuid;
  v_lpn    uuid;
BEGIN
  IF _business_id IS NULL THEN RETURN NULL; END IF;

  -- 1) Explicit on the payload.
  v_client := NULLIF(_payload->>'client_id','')::uuid;
  IF v_client IS NOT NULL THEN RETURN v_client; END IF;

  -- 2) The license plate the work touched.
  v_lpn := COALESCE(NULLIF(_payload->>'lpn_id','')::uuid,
                    NULLIF(_payload->>'license_plate_id','')::uuid);
  IF v_lpn IS NOT NULL THEN
    SELECT client_id INTO v_client FROM public.wms_license_plates WHERE id = v_lpn;
    IF v_client IS NOT NULL THEN RETURN v_client; END IF;
  END IF;

  -- 3) The aggregate the event belongs to.
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

  -- 4) Referenced session / manifest / visit on the payload.
  SELECT client_id INTO v_client FROM public.wms_receiving_sessions
   WHERE id = NULLIF(_payload->>'receiving_session_id','')::uuid;
  IF v_client IS NOT NULL THEN RETURN v_client; END IF;
  SELECT client_id INTO v_client FROM public.wms_loading_manifests
   WHERE id = NULLIF(_payload->>'manifest_id','')::uuid;
  IF v_client IS NOT NULL THEN RETURN v_client; END IF;
  SELECT client_id INTO v_client FROM public.wms_trailer_visits
   WHERE id = NULLIF(_payload->>'trailer_visit_id','')::uuid;

  RETURN v_client;
END; $function$;

REVOKE ALL ON FUNCTION public._wms_resolve_client_id(uuid, jsonb, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public._wms_resolve_client_id(uuid, jsonb, uuid) TO authenticated, service_role;

-- ── 3) Every warehouse event carries client_id ─────────────────────────
CREATE OR REPLACE FUNCTION public._wms_emit_event(
  _event_type text, _aggregate_id uuid, _org_id uuid, _business_id uuid,
  _warehouse_id uuid, _branch_id uuid, _actor uuid, _payload jsonb,
  _idempotency_key text DEFAULT NULL::text,
  _source_doc_type text DEFAULT NULL::text,
  _source_doc_id uuid DEFAULT NULL::uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  _id UUID;
  _key TEXT := COALESCE(_idempotency_key, _event_type || ':' || _aggregate_id::text);
  _aggregate TEXT := split_part(_event_type, '.', 2);
  _client UUID := public._wms_resolve_client_id(_business_id, COALESCE(_payload,'{}'::jsonb), _aggregate_id);
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
     actor_user_id, source, source_doc_type, source_doc_id, status)
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
     _doc_type, COALESCE(_source_doc_id, _aggregate_id), 'pending')
  ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = now()
  RETURNING id INTO _id;
  RETURN _id;
END $function$;

-- ── 4) Yard events were being thrown away ──────────────────────────────
--    emit_yard_event called a 9-argument _wms_emit_outbox that does not
--    exist (only two 5-argument overloads do), and the surrounding
--    EXCEPTION WHEN OTHERS swallowed the undefined_function error. Result:
--    zero warehouse.trailer.* rows ever reached the outbox, so the
--    yard_dwell tariff could never bill. Route through _wms_emit_event.
CREATE OR REPLACE FUNCTION public.emit_yard_event(
  p_type text,
  p_visit public.wms_trailer_visits
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_topic text;
BEGIN
  v_topic := CASE p_type
    WHEN 'warehouse.yard.checked_in' THEN 'warehouse.trailer.arrived'
    WHEN 'warehouse.yard.docked'     THEN 'warehouse.trailer.docked'
    WHEN 'warehouse.yard.departed'   THEN 'warehouse.trailer.departed'
    WHEN 'warehouse.yard.no_show'    THEN 'warehouse.trailer.no_show'
    ELSE p_type
  END;

  PERFORM public._wms_emit_event(
    v_topic,
    p_visit.id,
    p_visit.organization_id,
    p_visit.business_id,
    p_visit.warehouse_id,
    p_visit.branch_id,
    auth.uid(),
    jsonb_build_object(
      'trailer_visit_id', p_visit.id,
      'client_id',        p_visit.client_id,
      'appointment_id',   p_visit.appointment_id,
      'carrier_id',       p_visit.carrier_id,
      'trailer_ref',      p_visit.trailer_ref,
      'yard_slot_id',     p_visit.yard_slot_id,
      'dock_id',          p_visit.dock_id,
      'status',           p_visit.status,
      'arrived_at',       p_visit.arrived_at,
      'docked_at',        p_visit.docked_at,
      'departed_at',      p_visit.departed_at,
      'dwell_minutes',    p_visit.dwell_minutes,
      'seal_in',          p_visit.seal_in,
      'seal_out',         p_visit.seal_out,
      'emitted_by',       'emit_yard_event'
    ),
    'wms.trailer_visit:' || p_visit.id::text || ':' || COALESCE(p_visit.status::text,'unknown'),
    'wms_trailer_visits',
    p_visit.id
  );
END; $function$;

-- ── 5) Capture falls back to the plate's client, never to NULL blindly ─
CREATE OR REPLACE FUNCTION public.capture_billable_activity(p_event_id uuid)
RETURNS public.wms_billable_activities
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_evt       public.business_event_outbox;
  v_activity  text;
  v_biz       uuid;
  v_client    uuid;
  v_client_bz uuid;
  v_warehouse uuid;
  v_qty       numeric;
  v_occurred  timestamptz;
  v_tariff    public.wms_billing_tariffs;
  v_existing  public.wms_billable_activities;
  v_row       public.wms_billable_activities;
BEGIN
  SELECT * INTO v_evt FROM public.business_event_outbox WHERE id = p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'event not found'; END IF;

  v_biz := v_evt.org_id;

  IF NOT public.user_can_access_business(auth.uid(), v_biz) THEN
    RAISE EXCEPTION 'access denied';
  END IF;

  v_activity := public._wms_map_event_to_activity(v_evt.event_type, v_evt.payload);
  IF v_activity IS NULL THEN
    RAISE EXCEPTION 'event_type % is not billable', v_evt.event_type;
  END IF;

  SELECT * INTO v_existing
    FROM public.wms_billable_activities
   WHERE business_id = v_biz AND source_event_id = p_event_id;
  IF FOUND THEN RETURN v_existing; END IF;

  -- Client: payload/plate/aggregate chain, then the legacy business link.
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
  v_occurred  := COALESCE(v_evt.created_at, now());

  SELECT * INTO v_tariff
    FROM public.wms_billing_tariffs t
   WHERE t.business_id = v_biz
     AND t.activity    = v_activity
     AND t.is_active
     AND t.effective_from <= v_occurred::date
     AND (t.effective_to IS NULL OR t.effective_to >= v_occurred::date)
     AND (t.client_id IS NULL OR t.client_id = v_client)
   ORDER BY (t.client_id IS NOT NULL) DESC, t.effective_from DESC
   LIMIT 1;

  INSERT INTO public.wms_billable_activities (
    business_id, client_id, client_business_id, warehouse_id, activity, uom,
    quantity, occurred_at, source_event_id, source_doc_type, source_doc_id,
    tariff_id, unit_rate, currency, amount
  ) VALUES (
    v_biz, v_client, v_client_bz, v_warehouse, v_activity,
    COALESCE(v_tariff.uom, 'unit'),
    v_qty, v_occurred, p_event_id, v_evt.source_doc_type, v_evt.source_doc_id,
    v_tariff.id, v_tariff.rate, v_tariff.currency,
    CASE WHEN v_tariff.id IS NOT NULL THEN round(v_qty * v_tariff.rate, 4) ELSE NULL END
  ) RETURNING * INTO v_row;

  RETURN v_row;
END; $function$;