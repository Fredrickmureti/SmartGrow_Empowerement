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
  _aggregate TEXT := split_part(_event_type, '.', 2);
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
       'occurred_at',  now()
     ),
     _org_id, _warehouse_id, _branch_id, _actor, 'warehouse',
     _doc_type, COALESCE(_source_doc_id, _aggregate_id), 'pending')
  ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = now()
  RETURNING id INTO _id;
  RETURN _id;
END
$fn$;