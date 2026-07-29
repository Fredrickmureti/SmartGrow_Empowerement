-- =====================================================================
-- WMS Phase 2.4 §5b — retire the rival event vocabulary.
--
-- Two independent trigger families were writing to the outbox for the
-- same aggregates with different topic names:
--
--   legacy  tg_wms_task_emit_event  -> warehouse.task.started
--           tg_wms_lpn_emit_event   -> warehouse.plate.moved / .sealed
--   canonical (WMS_TOPIC / wms_events_catalog)
--                                   -> warehouse.task.in_progress
--                                   -> warehouse.lpn.moved / .sealed
--
-- Worse, the legacy task trigger used the *same* idempotency key as the
-- canonical producer (`wms.task:<id>:<state>`) while writing a different
-- `event_type`. With ON CONFLICT DO NOTHING, whichever trigger fired
-- first won, so the published topic for an `in_progress` transition was
-- non-deterministic.
--
-- Resolution: one vocabulary — the catalogued one. The legacy triggers
-- are dropped and their richer payload fields are folded into the
-- canonical task emitter. Existing consumers are log-only placeholders
-- and are repointed in the same change.
-- =====================================================================

DROP TRIGGER IF EXISTS trg_wms_task_emit_event ON public.wms_tasks;
DROP TRIGGER IF EXISTS trg_wms_lpn_emit_event ON public.wms_license_plates;
DROP FUNCTION IF EXISTS public.tg_wms_task_emit_event();
DROP FUNCTION IF EXISTS public.tg_wms_lpn_emit_event();

-- ---------------------------------------------------------------------
-- Canonical task emitter. `done` and `completed` are both live values of
-- wms_task_state; they collapse onto the single catalogued topic
-- `warehouse.task.completed` so consumers see one terminal event.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._wms_emit_task_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_transition text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RETURN NULL;
  END IF;

  v_transition := CASE NEW.state::text
    WHEN 'done'      THEN 'completed'
    WHEN 'completed' THEN 'completed'
    WHEN 'available' THEN 'available'
    WHEN 'assigned'  THEN 'assigned'
    WHEN 'claimed'   THEN 'claimed'
    WHEN 'in_progress' THEN 'in_progress'
    WHEN 'exception' THEN 'exception'
    WHEN 'cancelled' THEN 'cancelled'
    ELSE NULL
  END;

  IF v_transition IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM public._wms_emit_event(
    'warehouse.task.' || v_transition,
    NEW.id, NEW.organization_id, NEW.business_id, NEW.warehouse_id, NEW.branch_id,
    COALESCE(auth.uid(), NEW.assignee_user_id),
    jsonb_build_object(
      'task_type', NEW.task_type,
      'state', NEW.state,
      'from_state', CASE WHEN TG_OP = 'UPDATE' THEN OLD.state::text ELSE NULL END,
      'priority', NEW.priority,
      'assignee_user_id', NEW.assignee_user_id,
      'source_location_id', NEW.source_location_id,
      'destination_location_id', NEW.destination_location_id,
      'product_id', NEW.product_id,
      'lot_number', NEW.lot_number,
      'lpn_id', NEW.lpn_id,
      'quantity', NEW.quantity,
      'started_at', NEW.started_at,
      'completed_at', NEW.completed_at,
      'emitted_by', 'trigger:wms_tasks'
    ),
    'wms.task:' || NEW.id::text || ':' || v_transition,
    'wms_task',
    NEW.id
  );
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_wms_tasks_emit ON public.wms_tasks;
CREATE TRIGGER trg_wms_tasks_emit
AFTER INSERT OR UPDATE OF state ON public.wms_tasks
FOR EACH ROW EXECUTE FUNCTION public._wms_emit_task_event();

-- ---------------------------------------------------------------------
-- LPN: `sealed` is a real wms_lpn_status value and was only covered by
-- the retired legacy trigger. Add it to the canonical allow-list.
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_wms_lpn_emit ON public.wms_license_plates;
CREATE TRIGGER trg_wms_lpn_emit
AFTER INSERT OR UPDATE OF status ON public.wms_license_plates
FOR EACH ROW EXECUTE FUNCTION public._wms_emit_state_change(
  'lpn', 'warehouse.lpn.', 'status',
  'receiving,putaway,stored,picked,packed,sealed,staged,loaded,shipped,quarantined,voided');

-- ---------------------------------------------------------------------
-- Catalog the two topics that gained a canonical producer.
-- ---------------------------------------------------------------------
INSERT INTO public.wms_events_catalog
  (topic, aggregate, transition, producers, consumers, description, idempotency_key_shape)
VALUES
  ('warehouse.task.assigned', 'task', 'assigned',
   ARRAY['trigger:wms_tasks'], ARRAY[]::text[],
   'Task directly assigned to a worker (bypassing the shared claim queue).',
   'wms.task:<task_id>:assigned'),
  ('warehouse.lpn.sealed', 'lpn', 'sealed',
   ARRAY['seal_pack_carton','trigger:wms_license_plates'], ARRAY[]::text[],
   'License plate sealed and closed to further content changes.',
   'wms.lpn:<lpn_id>:sealed')
ON CONFLICT (topic) DO UPDATE
  SET producers = EXCLUDED.producers,
      description = EXCLUDED.description,
      idempotency_key_shape = EXCLUDED.idempotency_key_shape,
      updated_at = now();

-- Retire the rival names from the catalog so observability tooling stops
-- advertising topics that no longer have a producer.
DELETE FROM public.wms_events_catalog
 WHERE topic IN ('warehouse.plate.moved', 'warehouse.plate.sealed', 'warehouse.task.started');