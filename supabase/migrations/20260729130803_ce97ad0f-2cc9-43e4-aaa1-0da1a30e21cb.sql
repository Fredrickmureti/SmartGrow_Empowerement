-- 1) Rewire emit_yard_event to canonical trailer topics
CREATE OR REPLACE FUNCTION public.emit_yard_event(
  p_type text, p_visit public.wms_trailer_visits
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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

  BEGIN
    PERFORM public._wms_emit_outbox(
      v_topic,
      'trailer_visit', p_visit.id,
      jsonb_build_object(
        'trailer_visit_id', p_visit.id,
        'warehouse_id', p_visit.warehouse_id,
        'business_id', p_visit.business_id,
        'branch_id', p_visit.branch_id,
        'appointment_id', p_visit.appointment_id,
        'carrier_id', p_visit.carrier_id,
        'trailer_ref', p_visit.trailer_ref,
        'yard_slot_id', p_visit.yard_slot_id,
        'dock_id', p_visit.dock_id,
        'status', p_visit.status,
        'arrived_at', p_visit.arrived_at,
        'docked_at', p_visit.docked_at,
        'departed_at', p_visit.departed_at,
        'dwell_minutes', p_visit.dwell_minutes,
        'seal_in', p_visit.seal_in,
        'seal_out', p_visit.seal_out
      ),
      p_visit.organization_id, p_visit.branch_id, p_visit.warehouse_id,
      'wms.trailer_visit:' || p_visit.id || ':' || p_visit.status,
      NULL
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'trailer event emission failed: %', SQLERRM;
  END;
END; $$;

-- 2) mark_trailer_no_show RPC
CREATE OR REPLACE FUNCTION public.mark_trailer_no_show(
  p_visit_id uuid,
  p_reason text DEFAULT NULL
) RETURNS public.wms_trailer_visits
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_visit public.wms_trailer_visits;
  v_freed_slot uuid;
BEGIN
  SELECT * INTO v_visit FROM public.wms_trailer_visits WHERE id = p_visit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'trailer visit not found'; END IF;
  IF v_visit.business_id NOT IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF v_visit.status IN ('departed','no_show') THEN
    RAISE EXCEPTION 'visit already closed (status=%)', v_visit.status;
  END IF;
  IF v_visit.status = 'at_dock' THEN
    RAISE EXCEPTION 'trailer is at a dock; depart it instead of marking no-show';
  END IF;

  v_freed_slot := v_visit.yard_slot_id;

  UPDATE public.wms_trailer_visits
     SET status = 'no_show',
         departed_at = now(),
         dwell_minutes = EXTRACT(EPOCH FROM (now() - arrived_at)) / 60.0,
         yard_slot_id = NULL,
         notes = CASE
           WHEN p_reason IS NULL OR btrim(p_reason) = '' THEN notes
           ELSE COALESCE(notes || E'\n', '') || 'no-show: ' || btrim(p_reason)
         END
   WHERE id = p_visit_id
   RETURNING * INTO v_visit;

  IF v_freed_slot IS NOT NULL THEN
    UPDATE public.wms_yard_slots SET status = 'available' WHERE id = v_freed_slot;
  END IF;

  IF v_visit.appointment_id IS NOT NULL THEN
    UPDATE public.wms_dock_appointments
       SET state = CASE WHEN state IN ('scheduled','arrived') THEN 'cancelled' ELSE state END,
           cancelled_reason = COALESCE(cancelled_reason, 'trailer no-show')
     WHERE id = v_visit.appointment_id
       AND business_id = v_visit.business_id;
  END IF;

  PERFORM public.emit_yard_event('warehouse.trailer.no_show', v_visit);
  RETURN v_visit;
END; $$;

REVOKE ALL ON FUNCTION public.mark_trailer_no_show(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_trailer_no_show(uuid,text) TO authenticated;

-- 3) Register new topic in catalog
INSERT INTO public.wms_events_catalog (topic, aggregate, transition, producers, consumers, description, idempotency_key_shape)
VALUES (
  'warehouse.trailer.no_show',
  'trailer',
  '*->no_show',
  ARRAY['mark_trailer_no_show'],
  ARRAY['yard','appointments'],
  'Trailer failed to dock in the allowed window; visit closed and any linked appointment cancelled.',
  'wms.trailer_visit:<visit_id>:no_show'
)
ON CONFLICT (topic) DO NOTHING;