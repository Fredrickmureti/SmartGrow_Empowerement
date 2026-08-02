CREATE OR REPLACE FUNCTION public._wms_emit_event(
  _event_type text, _aggregate_id uuid, _org_id uuid, _business_id uuid,
  _warehouse_id uuid, _branch_id uuid, _actor uuid, _payload jsonb,
  _idempotency_key text DEFAULT NULL::text,
  _source_doc_type text DEFAULT NULL::text,
  _source_doc_id uuid DEFAULT NULL::uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  _id UUID;
  _key TEXT := COALESCE(_idempotency_key, _event_type || ':' || _aggregate_id::text);
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
       'occurred_at',  now()
     ),
     _org_id, _warehouse_id, _branch_id, _actor, 'warehouse',
     _source_doc_type, _source_doc_id, 'pending')
  ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = now()
  RETURNING id INTO _id;
  RETURN _id;
END
$fn$;

CREATE OR REPLACE FUNCTION public._wms_emit_outbox(
  p_topic text, p_organization_id uuid, p_business_id uuid, p_payload jsonb, p_idempotency_key text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_payload   jsonb := COALESCE(p_payload, '{}'::jsonb);
  v_aggregate text := split_part(p_topic, '.', 2);
  v_doc_type  text;
  v_doc_id    uuid;
BEGIN
  v_doc_type := COALESCE(
    NULLIF(v_payload->>'source_doc_type', ''),
    CASE v_aggregate
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
      ELSE 'wms_' || COALESCE(NULLIF(v_aggregate, ''), 'unknown')
    END
  );

  v_doc_id := COALESCE(
    NULLIF(v_payload->>'aggregate_id', '')::uuid,
    NULLIF(v_payload->>'source_doc_id', '')::uuid,
    NULLIF(v_payload->>'task_id', '')::uuid,
    NULLIF(v_payload->>'session_id', '')::uuid,
    NULLIF(v_payload->>'id', '')::uuid
  );

  INSERT INTO public.business_event_outbox (
    org_id, branch_id, warehouse_id,
    event_type, source_doc_type, source_doc_id,
    payload, status, idempotency_key, actor_user_id, source
  ) VALUES (
    COALESCE(p_business_id, p_organization_id),
    NULLIF(v_payload->>'branch_id', '')::uuid,
    NULLIF(v_payload->>'warehouse_id', '')::uuid,
    p_topic,
    v_doc_type,
    v_doc_id,
    v_payload,
    'pending',
    p_idempotency_key,
    COALESCE(NULLIF(v_payload->>'actor_id', '')::uuid, auth.uid()),
    'warehouse'
  )
  ON CONFLICT (idempotency_key) DO NOTHING;
END;
$fn$;