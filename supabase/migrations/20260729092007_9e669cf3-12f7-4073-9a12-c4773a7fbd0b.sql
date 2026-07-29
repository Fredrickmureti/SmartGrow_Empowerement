
-- 1. Deterministic stripper: removes an outbox emission statement carrying a given topic literal.
CREATE OR REPLACE FUNCTION public._wms_strip_emit(p_src text, p_topic text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  res text := p_src;
  lit text := '''' || p_topic || '''';
  pos int; s int; i int; depth int; pa int; pb int; prefix text;
BEGIN
  LOOP
    pos := position(lit in res);
    EXIT WHEN pos = 0;
    prefix := substr(res, 1, pos);
    pa := 0; pb := 0;
    -- last INSERT INTO / PERFORM before the literal
    SELECT COALESCE(MAX(g), 0) INTO pa FROM generate_series(1, length(prefix)) g
      WHERE substr(prefix, g, 11) = 'INSERT INTO';
    SELECT COALESCE(MAX(g), 0) INTO pb FROM generate_series(1, length(prefix)) g
      WHERE substr(prefix, g, 7) = 'PERFORM';
    s := GREATEST(pa, pb);
    IF s = 0 THEN
      RAISE EXCEPTION 'cannot locate statement start for topic %', p_topic;
    END IF;
    i := s; depth := 0;
    WHILE i <= length(res) LOOP
      IF substr(res, i, 1) = '(' THEN depth := depth + 1;
      ELSIF substr(res, i, 1) = ')' THEN depth := depth - 1;
      ELSIF substr(res, i, 1) = ';' AND depth = 0 THEN EXIT;
      END IF;
      i := i + 1;
    END LOOP;
    res := substr(res, 1, s - 1) || substr(res, i + 1);
  END LOOP;
  RETURN res;
END
$fn$;

-- 2. Strip duplicate emissions (canonical topic already emitted by the AFTER triggers).
DO $do$
DECLARE
  r record;
  v_def text;
  v_new text;
  v_pairs text[][] := ARRAY[
    ARRAY['_wms_auto_open_qc_on_grn','warehouse.qc.opened'],
    ARRAY['open_qc_inspection','warehouse.qc.opened'],
    ARRAY['accept_qc_inspection','warehouse.qc.accepted'],
    ARRAY['reject_qc_inspection','warehouse.qc.rejected'],
    ARRAY['cancel_qc_inspection','warehouse.qc.cancelled'],
    ARRAY['check_in_trailer','warehouse.yard.checked_in'],
    ARRAY['assign_trailer_to_dock','warehouse.yard.docked'],
    ARRAY['depart_trailer','warehouse.yard.departed'],
    ARRAY['assign_wms_task','warehouse.task.assigned'],
    ARRAY['claim_pick_task','warehouse.task.assigned'],
    ARRAY['create_count_session','warehouse.count.opened'],
    ARRAY['post_count_session','warehouse.count.posted'],
    ARRAY['open_loading_manifest','warehouse.manifest.opened'],
    ARRAY['close_loading_manifest','warehouse.manifest.closed'],
    ARRAY['dispatch_loading_manifest','warehouse.manifest.dispatched'],
    ARRAY['release_pick_wave','warehouse.wave.released'],
    ARRAY['cancel_pick_wave','warehouse.wave.released'],
    ARRAY['complete_putaway_task','warehouse.putaway.completed'],
    ARRAY['complete_pick_task','warehouse.pick.completed'],
    ARRAY['complete_pack_task','warehouse.pack.completed']
  ];
  i int;
BEGIN
  FOR i IN 1 .. array_length(v_pairs, 1) LOOP
    FOR r IN
      SELECT p.oid FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = v_pairs[i][1]
         AND p.prosrc LIKE '%' || v_pairs[i][2] || '%'
    LOOP
      v_def := pg_get_functiondef(r.oid);
      v_new := public._wms_strip_emit(v_def, v_pairs[i][2]);
      IF v_new = v_def THEN
        RAISE EXCEPTION 'no emission stripped for %/%', v_pairs[i][1], v_pairs[i][2];
      END IF;
      EXECUTE v_new;
    END LOOP;
  END LOOP;
END
$do$;

-- 3. Retire the now-unused legacy emission helpers.
DROP FUNCTION IF EXISTS public.emit_qc_event(text, public.wms_qc_inspections);
DROP FUNCTION IF EXISTS public.emit_yard_event(text, public.wms_trailer_visits);

-- 4. Canonical billing activity mapping (payload-aware, single definition).
DROP FUNCTION IF EXISTS public._wms_map_event_to_activity(text);
CREATE OR REPLACE FUNCTION public._wms_map_event_to_activity(
  p_event_type text,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $fn$
  SELECT CASE
    WHEN p_event_type = 'warehouse.receipt.staged'     THEN 'receive_lpn'
    WHEN p_event_type = 'warehouse.task.completed' AND p_payload->>'task_type' = 'putaway' THEN 'putaway'
    WHEN p_event_type = 'warehouse.task.completed' AND p_payload->>'task_type' = 'pick'    THEN 'pick_line'
    WHEN p_event_type = 'warehouse.task.completed' AND p_payload->>'task_type' = 'pack'    THEN 'pack_package'
    WHEN p_event_type = 'warehouse.manifest.dispatched' THEN 'dispatch_shipment'
    WHEN p_event_type = 'warehouse.trailer.departed'    THEN 'yard_dwell'
    WHEN p_event_type IN ('warehouse.qc.passed','warehouse.qc.failed') THEN 'qc_inspection'
    WHEN p_event_type = 'warehouse.count.posted'        THEN 'cycle_count'
    ELSE NULL
  END;
$fn$;

-- 5. Pass the payload at every mapper call site.
DO $do$
DECLARE r record; v_def text; v_new text;
BEGIN
  FOR r IN
    SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosrc LIKE '%_wms_map_event_to_activity%'
       AND p.proname <> '_wms_map_event_to_activity'
  LOOP
    v_def := pg_get_functiondef(r.oid);
    v_new := regexp_replace(
      v_def,
      '_wms_map_event_to_activity\(([a-zA-Z_]+)\.event_type\)',
      '_wms_map_event_to_activity(\1.event_type, \1.payload)',
      'g'
    );
    IF v_new <> v_def THEN EXECUTE v_new; END IF;
  END LOOP;
END
$do$;

-- 6. Catalog the topics that legitimately had no canonical entry.
INSERT INTO public.wms_events_catalog (topic, aggregate, transition, producers, consumers, description, idempotency_key_shape)
VALUES
  ('warehouse.receipt.staged','receiving','received->staged', ARRAY['receive_goods_to_wms'], ARRAY['3pl_billing'], 'Goods receipt converted into license plates and putaway tasks.', 'wms.receipt.<goods_receipt_id>'),
  ('warehouse.count.recorded','count','line counted', ARRAY['record_count','record_count_scan'], ARRAY['count_analytics'], 'A count line quantity was recorded.', 'wms.count.line.<line_id>'),
  ('warehouse.carton.opened','carton','->open', ARRAY['open_pack_carton'], ARRAY['packing_analytics'], 'Pack carton opened at a pack station.', 'wms.carton.<carton_id>:open'),
  ('warehouse.carton.sealed','carton','open->sealed', ARRAY['seal_pack_carton'], ARRAY['packing_analytics','shipping'], 'Pack carton sealed and ready to load.', 'wms.carton.<carton_id>:sealed'),
  ('warehouse.carton.shipped','carton','loaded->shipped', ARRAY['dispatch_loading_manifest'], ARRAY['shipping','3pl_billing'], 'Carton left the building on a dispatched manifest.', 'wms.carton.<carton_id>:shipped'),
  ('warehouse.appointment.scheduled','appointment','->scheduled', ARRAY['schedule_dock_appointment'], ARRAY['yard'], 'Dock appointment scheduled.', 'wms.appt.<appointment_id>:scheduled'),
  ('warehouse.appointment.arrived','appointment','scheduled->arrived', ARRAY['mark_appointment_arrived'], ARRAY['yard'], 'Carrier arrived for a dock appointment.', 'wms.appt.<appointment_id>:arrived'),
  ('warehouse.appointment.in_progress','appointment','arrived->in_progress', ARRAY['start_appointment'], ARRAY['yard'], 'Dock appointment work started.', 'wms.appt.<appointment_id>:in_progress'),
  ('warehouse.appointment.completed','appointment','in_progress->completed', ARRAY['complete_dock_appointment'], ARRAY['yard'], 'Dock appointment completed.', 'wms.appt.<appointment_id>:completed'),
  ('warehouse.appointment.cancelled','appointment','*->cancelled', ARRAY['cancel_dock_appointment'], ARRAY['yard'], 'Dock appointment cancelled.', 'wms.appt.<appointment_id>:cancelled'),
  ('warehouse.crossdock.matched','crossdock','->matched', ARRAY['evaluate_crossdock_on_grn'], ARRAY['crossdock'], 'Inbound line matched to an outbound demand.', 'wms.crossdock.<opportunity_id>:matched'),
  ('warehouse.crossdock.staged','crossdock','matched->staged', ARRAY['confirm_crossdock_stage'], ARRAY['crossdock','shipping'], 'Cross-dock quantity staged for outbound.', 'wms.crossdock.<opportunity_id>:staged'),
  ('warehouse.crossdock.cancelled','crossdock','*->cancelled', ARRAY['cancel_crossdock_opportunity'], ARRAY['crossdock'], 'Cross-dock opportunity cancelled.', 'wms.crossdock.<opportunity_id>:cancelled')
ON CONFLICT (topic) DO NOTHING;

DROP FUNCTION IF EXISTS public._wms_strip_emit(text, text);
