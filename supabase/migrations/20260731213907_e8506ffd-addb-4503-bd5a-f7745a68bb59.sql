-- ============================================================================
-- Phase 5.2 — Trailer no-show → labour reclaim.
--
-- A no-show today closes the visit and cancels the appointment, but any
-- loading manifest already opened for that trailer keeps its cartons and
-- its open `load` tasks, so the labour stays booked against a truck that
-- never arrived. Manifests carry `appointment_id` but no direct trailer
-- link, so the no-show handler cannot find them.
-- ============================================================================

-- 1) Direct trailer link on the manifest.
ALTER TABLE public.wms_loading_manifests
  ADD COLUMN IF NOT EXISTS trailer_visit_id uuid NULL
    REFERENCES public.wms_trailer_visits(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_wms_manifests_trailer_visit
  ON public.wms_loading_manifests(trailer_visit_id)
  WHERE trailer_visit_id IS NOT NULL;

COMMENT ON COLUMN public.wms_loading_manifests.trailer_visit_id IS
  'Yard trailer visit this manifest is being loaded onto. Set at open time or backfilled from the shared dock appointment; a no-show on the visit cancels the manifest.';

-- Backfill: an appointment is served by at most one trailer visit.
UPDATE public.wms_loading_manifests m
   SET trailer_visit_id = v.id
  FROM public.wms_trailer_visits v
 WHERE m.trailer_visit_id IS NULL
   AND m.appointment_id IS NOT NULL
   AND v.appointment_id = m.appointment_id
   AND v.business_id = m.business_id;

-- 2) mark_trailer_no_show — cascade through the manifest cancel path.
CREATE OR REPLACE FUNCTION public.mark_trailer_no_show(
  p_visit_id uuid,
  p_reason text DEFAULT NULL
) RETURNS public.wms_trailer_visits
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_visit public.wms_trailer_visits;
  v_freed_slot uuid;
  v_manifest record;
  v_manifests int := 0;
  v_tasks int := 0;
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

  -- Labour reclaim: every manifest still being loaded for this trailer is
  -- cancelled through wms_transition_manifest, which already unlinks the
  -- cartons, cancels open `load` tasks via wms_transition_task (emitting
  -- warehouse.task.cancelled per task, so the labour queue frees them),
  -- and reopens the affected waves.
  FOR v_manifest IN
    SELECT m.id, m.row_version
      FROM public.wms_loading_manifests m
     WHERE m.business_id = v_visit.business_id
       AND m.state IN ('draft','loading')
       AND (
         m.trailer_visit_id = v_visit.id
         OR (m.trailer_visit_id IS NULL
             AND v_visit.appointment_id IS NOT NULL
             AND m.appointment_id = v_visit.appointment_id)
       )
  LOOP
    SELECT count(*) INTO v_tasks FROM (
      SELECT v_tasks
    ) s; -- keep v_tasks; per-manifest counts accumulated below
    BEGIN
      v_tasks := v_tasks + (
        SELECT count(*)
          FROM public.wms_tasks t
          JOIN public.wms_manifest_cartons mc
            ON mc.carton_id::text = t.source_doc_id::text
         WHERE mc.manifest_id = v_manifest.id
           AND t.task_type = 'load'
           AND t.state NOT IN ('done','cancelled')
      );
      PERFORM public.wms_transition_manifest(
        v_manifest.id, 'cancelled'::public.wms_manifest_state, v_manifest.row_version,
        COALESCE(NULLIF(btrim(p_reason), ''), 'trailer_no_show'),
        jsonb_build_object('trailer_visit_id', v_visit.id, 'cause', 'trailer_no_show')
      );
      v_manifests := v_manifests + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'mark_trailer_no_show: could not cancel manifest %: %', v_manifest.id, SQLERRM;
    END;
  END LOOP;

  PERFORM public.emit_yard_event('warehouse.trailer.no_show', v_visit);

  BEGIN
    INSERT INTO public.business_event_outbox (
      org_id, warehouse_id, event_type, source_doc_type, source_doc_id,
      payload, idempotency_key, status, actor_user_id
    ) VALUES (
      v_visit.organization_id, v_visit.warehouse_id, 'warehouse.labour.reclaimed',
      'wms_trailer_visit', v_visit.id,
      jsonb_build_object(
        'trailer_visit_id', v_visit.id,
        'business_id', v_visit.business_id,
        'cancelled_manifests', v_manifests,
        'released_load_tasks', v_tasks,
        'reason', COALESCE(NULLIF(btrim(p_reason), ''), 'trailer_no_show')
      ),
      'wms.trailer_visit:' || v_visit.id::text || ':labour_reclaimed',
      'pending', auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'labour reclaim outbox emit failed: %', SQLERRM;
  END;

  RETURN v_visit;
END; $$;

REVOKE ALL ON FUNCTION public.mark_trailer_no_show(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_trailer_no_show(uuid,text) TO authenticated;

-- 3) Register the reclaim topic.
INSERT INTO public.wms_events_catalog (topic, aggregate, transition, producers, consumers, description, idempotency_key_shape)
VALUES (
  'warehouse.labour.reclaimed',
  'trailer',
  'no_show->labour_released',
  ARRAY['mark_trailer_no_show'],
  ARRAY['labour','dispatch','supervisor'],
  'A trailer no-show cancelled its open loading manifests; the booked loading labour is released back to the queue.',
  'wms.trailer_visit:<visit_id>:labour_reclaimed'
)
ON CONFLICT (topic) DO NOTHING;