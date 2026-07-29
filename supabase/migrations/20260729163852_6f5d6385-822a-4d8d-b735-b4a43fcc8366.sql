-- ============================================================
-- Phase 4 §0 · Repair _wms_emit_outbox
--
-- The original body inserted (organization_id, business_id, topic) —
-- none of which exist on business_event_outbox — and swallowed
-- undefined_column, so EVERY warehouse transition event was silently
-- discarded. Rewritten against the real column set, with the swallow
-- removed so a future schema drift fails loudly.
-- ============================================================

CREATE OR REPLACE FUNCTION public._wms_emit_outbox(
  p_topic text,
  p_idempotency_key text,
  p_organization_id uuid,
  p_business_id uuid,
  p_payload jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_payload   jsonb := COALESCE(p_payload, '{}'::jsonb);
  v_aggregate text := split_part(p_topic, '.', 2);
  v_doc_type  text;
  v_doc_id    uuid;
BEGIN
  -- business_event_outbox.org_id carries the BUSINESS id (see the
  -- org_read RLS policy, which joins user_business_access.business_id).
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
    'wms'
  )
  ON CONFLICT (idempotency_key) DO NOTHING;
END;
$function$;

COMMENT ON FUNCTION public._wms_emit_outbox(text, text, uuid, uuid, jsonb) IS
  'Phase 4 §0 — single writer of warehouse.* rows on business_event_outbox. Maps the WMS payload onto the real outbox columns; never swallows errors.';

CREATE INDEX IF NOT EXISTS idx_business_event_outbox_source_doc
  ON public.business_event_outbox (source_doc_id, created_at DESC);