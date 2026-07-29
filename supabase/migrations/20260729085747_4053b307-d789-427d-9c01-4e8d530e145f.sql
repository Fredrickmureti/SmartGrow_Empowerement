-- =====================================================================
-- WMS Phase 2.4 §5/§6 — outbox emission parity + lease reaper schedule
--
-- Prior state: only the `wms_transition_*` FSMs called `_wms_emit_event`.
-- Twenty-one legacy domain RPCs (create_pick_wave, move_lpn,
-- open_qc_inspection, the pack/load/trailer family, …) mutate the same
-- aggregate tables directly and emitted nothing, so `warehouse.*`
-- consumers saw an incomplete stream.
--
-- Fix: emit from AFTER triggers on the aggregate tables rather than
-- patching 21 function bodies. Emission then cannot be bypassed by any
-- writer, present or future. The triggers reuse the FSMs' exact
-- idempotency-key shape (`wms.<aggregate>:<id>:<transition>`), so when
-- an FSM already emitted, the trigger's insert collapses into the
-- existing outbox row instead of double-publishing.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Generic state-change emitter.
--    TG_ARGV[0] aggregate key   (task | lpn | wave | manifest | qc | count | trailer)
--    TG_ARGV[1] topic prefix    (e.g. 'warehouse.task.')
--    TG_ARGV[2] state column    (state | status)
--    TG_ARGV[3] allowed states  (comma separated; anything else is ignored)
--
--    The allow-list is deliberate: it stops a future enum value from
--    silently publishing a topic that is not declared in
--    `wms_events_catalog` / `WMS_TOPIC`.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._wms_emit_state_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agg     text := TG_ARGV[0];
  v_prefix  text := TG_ARGV[1];
  v_col     text := TG_ARGV[2];
  v_allowed text[] := string_to_array(TG_ARGV[3], ',');
  v_new     jsonb := to_jsonb(NEW);
  v_old     jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END;
  v_state   text;
  v_prev    text;
BEGIN
  v_state := v_new ->> v_col;
  IF v_state IS NULL OR NOT (v_state = ANY (v_allowed)) THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_prev := v_old ->> v_col;
    IF v_prev IS NOT DISTINCT FROM v_state THEN
      RETURN NULL;
    END IF;
  END IF;

  PERFORM public._wms_emit_event(
    v_prefix || v_state,
    (v_new ->> 'id')::uuid,
    (v_new ->> 'organization_id')::uuid,
    (v_new ->> 'business_id')::uuid,
    (v_new ->> 'warehouse_id')::uuid,
    (v_new ->> 'branch_id')::uuid,
    auth.uid(),
    jsonb_build_object(
      'from_state', v_prev,
      'to_state',   v_state,
      'emitted_by', 'trigger:' || TG_TABLE_NAME
    ),
    'wms.' || v_agg || ':' || (v_new ->> 'id') || ':' || v_state
  );
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------
-- 2. LPN relocation without a status change (`move_lpn`).
--    Keyed on row_version so each distinct move is its own event.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._wms_emit_lpn_moved()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.current_location_id IS NOT DISTINCT FROM OLD.current_location_id THEN
    RETURN NULL;
  END IF;

  PERFORM public._wms_emit_event(
    'warehouse.lpn.moved',
    NEW.id, NEW.organization_id, NEW.business_id, NEW.warehouse_id, NEW.branch_id,
    auth.uid(),
    jsonb_build_object(
      'code', NEW.code,
      'from_location_id', OLD.current_location_id,
      'to_location_id',   NEW.current_location_id,
      'status',           NEW.status,
      'emitted_by',       'trigger:wms_license_plates'
    ),
    'wms.lpn:' || NEW.id::text || ':moved:' || NEW.row_version::text
  );
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------
-- 3. Wire the triggers.
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_wms_tasks_emit ON public.wms_tasks;
CREATE TRIGGER trg_wms_tasks_emit
AFTER INSERT OR UPDATE OF state ON public.wms_tasks
FOR EACH ROW EXECUTE FUNCTION public._wms_emit_state_change(
  'task', 'warehouse.task.', 'state',
  'available,claimed,in_progress,completed,exception,cancelled');

DROP TRIGGER IF EXISTS trg_wms_lpn_emit ON public.wms_license_plates;
CREATE TRIGGER trg_wms_lpn_emit
AFTER INSERT OR UPDATE OF status ON public.wms_license_plates
FOR EACH ROW EXECUTE FUNCTION public._wms_emit_state_change(
  'lpn', 'warehouse.lpn.', 'status',
  'receiving,putaway,stored,picked,packed,staged,loaded,shipped,quarantined,voided');

DROP TRIGGER IF EXISTS trg_wms_lpn_moved ON public.wms_license_plates;
CREATE TRIGGER trg_wms_lpn_moved
AFTER UPDATE OF current_location_id ON public.wms_license_plates
FOR EACH ROW EXECUTE FUNCTION public._wms_emit_lpn_moved();

DROP TRIGGER IF EXISTS trg_wms_waves_emit ON public.wms_pick_waves;
CREATE TRIGGER trg_wms_waves_emit
AFTER INSERT OR UPDATE OF state ON public.wms_pick_waves
FOR EACH ROW EXECUTE FUNCTION public._wms_emit_state_change(
  'wave', 'warehouse.wave.', 'state',
  'draft,released,picking,picked,packing,packed,cancelled');

DROP TRIGGER IF EXISTS trg_wms_manifests_emit ON public.wms_loading_manifests;
CREATE TRIGGER trg_wms_manifests_emit
AFTER INSERT OR UPDATE OF state ON public.wms_loading_manifests
FOR EACH ROW EXECUTE FUNCTION public._wms_emit_state_change(
  'manifest', 'warehouse.manifest.', 'state',
  'draft,loading,closed,dispatched,cancelled');

DROP TRIGGER IF EXISTS trg_wms_qc_emit ON public.wms_qc_inspections;
CREATE TRIGGER trg_wms_qc_emit
AFTER INSERT OR UPDATE OF state ON public.wms_qc_inspections
FOR EACH ROW EXECUTE FUNCTION public._wms_emit_state_change(
  'qc', 'warehouse.qc.', 'state',
  'pending,in_progress,passed,failed,conditional,closed,cancelled');

DROP TRIGGER IF EXISTS trg_wms_counts_emit ON public.wms_count_sessions;
CREATE TRIGGER trg_wms_counts_emit
AFTER INSERT OR UPDATE OF state ON public.wms_count_sessions
FOR EACH ROW EXECUTE FUNCTION public._wms_emit_state_change(
  'count', 'warehouse.count.', 'state',
  'draft,counting,review,posted,cancelled');

DROP TRIGGER IF EXISTS trg_wms_trailers_emit ON public.wms_trailer_visits;
CREATE TRIGGER trg_wms_trailers_emit
AFTER INSERT OR UPDATE OF status ON public.wms_trailer_visits
FOR EACH ROW EXECUTE FUNCTION public._wms_emit_state_change(
  'trailer', 'warehouse.trailer.', 'status',
  'arrived,docked,departed');

-- ---------------------------------------------------------------------
-- 4. Catalog rows for the four newly-produced topics.
-- ---------------------------------------------------------------------
INSERT INTO public.wms_events_catalog
  (topic, aggregate, transition, producers, consumers, description, idempotency_key_shape)
VALUES
  ('warehouse.lpn.moved', 'lpn', 'moved',
   ARRAY['move_lpn','trigger:wms_license_plates'], ARRAY[]::text[],
   'License plate relocated to a new location without a status change.',
   'wms.lpn:<lpn_id>:moved:<row_version>'),
  ('warehouse.trailer.arrived', 'trailer', 'arrived',
   ARRAY['check_in_trailer','trigger:wms_trailer_visits'], ARRAY[]::text[],
   'Trailer checked in to the yard.',
   'wms.trailer:<visit_id>:arrived'),
  ('warehouse.trailer.docked', 'trailer', 'docked',
   ARRAY['trigger:wms_trailer_visits'], ARRAY[]::text[],
   'Trailer assigned to and parked at a dock door.',
   'wms.trailer:<visit_id>:docked'),
  ('warehouse.trailer.departed', 'trailer', 'departed',
   ARRAY['depart_trailer','trigger:wms_trailer_visits'], ARRAY[]::text[],
   'Trailer departed the yard.',
   'wms.trailer:<visit_id>:departed')
ON CONFLICT (topic) DO UPDATE
  SET producers = EXCLUDED.producers,
      description = EXCLUDED.description,
      idempotency_key_shape = EXCLUDED.idempotency_key_shape,
      updated_at = now();

-- ---------------------------------------------------------------------
-- 5. Schedule the abandoned-task lease reaper (Phase 2.4 §6).
--    `wms_task_reap_expired` existed but was never scheduled, so a task
--    claimed by a device that went offline stayed claimed forever.
--    Releasing it back to `available` now also emits
--    `warehouse.task.available` via the trigger above.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  PERFORM cron.unschedule('wms-task-lease-reaper');
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

SELECT cron.schedule(
  'wms-task-lease-reaper',
  '* * * * *',
  $$ SELECT public.wms_task_reap_expired(); $$
);