-- ============================================================================
-- Phase 3.7 — Loading manifest scan-out enforcement + cancellation cascade
-- ============================================================================
-- Amends `public.wms_transition_manifest` to (a) guarantee full scan-out at
-- close/dispatch, (b) cascade cancellation into pack-carton unbind + open
-- load-task cancellation + wave re-open events. Trigger-owned emission
-- pattern is preserved via `_wms_emit_outbox`; the cascade emits ancillary
-- `warehouse.wave.reopened` rows in-body because there is no wave-side
-- transition to piggyback on (the wave stays in its current state; only
-- reservation intent changes).
--
-- New topic: warehouse.wave.reopened  (aggregate=wave, transition=reopened)
-- Idempotency key: wms.wave:{wave_id}:reopened_by_manifest:{manifest_id}
-- ============================================================================

CREATE OR REPLACE FUNCTION public.wms_transition_manifest(
  p_manifest_id uuid,
  p_to_state wms_manifest_state,
  p_row_version integer,
  p_reason text DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_row       public.wms_loading_manifests%ROWTYPE;
  v_from      wms_manifest_state;
  v_allowed   boolean := false;
  v_new_rv    integer;
  v_short     jsonb;
  v_wave      record;
  v_task      record;
  v_carton_ct int := 0;
BEGIN
  SELECT * INTO v_row FROM public.wms_loading_manifests WHERE id = p_manifest_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loading manifest not found' USING ERRCODE = 'P0002'; END IF;
  IF v_row.row_version <> p_row_version THEN
    RAISE EXCEPTION 'Row version mismatch (have %, expected %)', v_row.row_version, p_row_version USING ERRCODE = '40001';
  END IF;
  v_from := v_row.state;

  v_allowed := CASE
    WHEN v_from = 'draft'   AND p_to_state IN ('loading','cancelled')     THEN true
    WHEN v_from = 'loading' AND p_to_state IN ('closed','cancelled')      THEN true
    WHEN v_from = 'closed'  AND p_to_state IN ('dispatched','cancelled')  THEN true
    ELSE false
  END;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Illegal manifest transition % → %', v_from, p_to_state USING ERRCODE = '22023';
  END IF;

  -- ------------------------------------------------------------------
  -- Full scan-out enforcement at close AND dispatch.
  --
  -- Rule: for every (wave_id, sales_order_id) pair with ≥1 sealed pack
  -- carton on this manifest, every OTHER sealed carton for the same
  -- pair must ALSO be on this manifest (or already on another
  -- manifest that is closed/dispatched). Otherwise the operator is
  -- leaving stock behind — refuse with WMS_SCAN_SHORTAGE and list the
  -- missing carton ids so the UI can highlight them.
  -- ------------------------------------------------------------------
  IF p_to_state IN ('closed','dispatched') THEN
    WITH pairs_on_manifest AS (
      SELECT DISTINCT c.wave_id, c.sales_order_id
        FROM public.wms_manifest_cartons mc
        JOIN public.wms_pack_cartons c ON c.id = mc.carton_id
       WHERE mc.manifest_id = p_manifest_id
    ),
    expected AS (
      SELECT c.id AS carton_id, c.wave_id, c.sales_order_id, c.manifest_id
        FROM public.wms_pack_cartons c
        JOIN pairs_on_manifest p
          ON p.wave_id = c.wave_id
         AND p.sales_order_id = c.sales_order_id
       WHERE c.sealed_at IS NOT NULL
    ),
    missing AS (
      SELECT e.carton_id, e.wave_id, e.sales_order_id
        FROM expected e
        LEFT JOIN public.wms_manifest_cartons mc
          ON mc.carton_id = e.carton_id
       WHERE mc.manifest_id IS NULL
    )
    SELECT jsonb_agg(jsonb_build_object(
             'carton_id', carton_id,
             'wave_id', wave_id,
             'sales_order_id', sales_order_id
           ))
      INTO v_short
      FROM missing;

    IF v_short IS NOT NULL AND jsonb_array_length(v_short) > 0 THEN
      RAISE EXCEPTION 'WMS_SCAN_SHORTAGE: % sealed carton(s) missing from manifest % — %',
        jsonb_array_length(v_short), p_manifest_id, v_short::text
        USING ERRCODE = '22023';
    END IF;

    -- Require at least one loaded carton for a real close/dispatch.
    SELECT count(*) INTO v_carton_ct
      FROM public.wms_manifest_cartons WHERE manifest_id = p_manifest_id;
    IF v_carton_ct = 0 THEN
      RAISE EXCEPTION 'WMS_SCAN_SHORTAGE: manifest % has no loaded cartons', p_manifest_id
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- ------------------------------------------------------------------
  -- Persist the state change.
  -- ------------------------------------------------------------------
  v_new_rv := v_row.row_version + 1;
  UPDATE public.wms_loading_manifests SET
    state          = p_to_state,
    row_version    = v_new_rv,
    closed_at      = COALESCE(closed_at,     CASE WHEN p_to_state = 'closed' THEN now() END),
    closed_by      = COALESCE(closed_by,     CASE WHEN p_to_state = 'closed' THEN auth.uid() END),
    dispatched_at  = COALESCE(dispatched_at, CASE WHEN p_to_state = 'dispatched' THEN now() END),
    dispatched_by  = COALESCE(dispatched_by, CASE WHEN p_to_state = 'dispatched' THEN auth.uid() END),
    updated_at     = now()
  WHERE id = p_manifest_id;

  PERFORM public._wms_emit_outbox(
    'warehouse.manifest.' || p_to_state::text,
    'wms.manifest:' || p_manifest_id::text || ':' || p_to_state::text,
    v_row.organization_id, v_row.business_id,
    jsonb_build_object(
      'aggregate_id', p_manifest_id, 'warehouse_id', v_row.warehouse_id, 'branch_id', v_row.branch_id,
      'actor_id', auth.uid(), 'occurred_at', now(),
      'from_state', v_from, 'to_state', p_to_state,
      'reason', p_reason, 'extra', COALESCE(p_payload, '{}'::jsonb)
    )
  );

  -- ------------------------------------------------------------------
  -- Cancellation cascade: unbind cartons, cancel open load tasks tied
  -- to those cartons, emit warehouse.wave.reopened per affected wave.
  -- ------------------------------------------------------------------
  IF p_to_state = 'cancelled' THEN
    -- Snapshot the affected waves BEFORE we unbind, so we can emit reopens.
    FOR v_wave IN
      SELECT DISTINCT c.wave_id
        FROM public.wms_manifest_cartons mc
        JOIN public.wms_pack_cartons c ON c.id = mc.carton_id
       WHERE mc.manifest_id = p_manifest_id
         AND c.wave_id IS NOT NULL
    LOOP
      PERFORM public._wms_emit_outbox(
        'warehouse.wave.reopened',
        'wms.wave:' || v_wave.wave_id::text || ':reopened_by_manifest:' || p_manifest_id::text,
        v_row.organization_id, v_row.business_id,
        jsonb_build_object(
          'aggregate_id', v_wave.wave_id,
          'warehouse_id', v_row.warehouse_id,
          'branch_id',    v_row.branch_id,
          'actor_id',     auth.uid(),
          'occurred_at',  now(),
          'reason',       COALESCE(p_reason, 'manifest_cancelled'),
          'manifest_id',  p_manifest_id
        )
      );
    END LOOP;

    -- Cancel any open `load` tasks whose source_doc points at cartons
    -- on this manifest. Route through wms_transition_task so the
    -- task-lifecycle trigger emits warehouse.task.cancelled.
    FOR v_task IN
      SELECT t.id, t.row_version
        FROM public.wms_tasks t
        JOIN public.wms_manifest_cartons mc
          ON mc.carton_id::text = t.source_doc_id::text
       WHERE mc.manifest_id = p_manifest_id
         AND t.task_type = 'load'
         AND t.state NOT IN ('completed','cancelled','done')
    LOOP
      BEGIN
        PERFORM public.wms_transition_task(
          v_task.id, 'cancelled'::wms_task_state, v_task.row_version,
          'manifest_cancelled', jsonb_build_object('manifest_id', p_manifest_id)
        );
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'wms_transition_manifest: could not cancel load task %: %', v_task.id, SQLERRM;
      END;
    END LOOP;

    -- Finally, break the carton ↔ manifest link so the cartons return
    -- to the packed pool and can be loaded onto a fresh manifest.
    UPDATE public.wms_pack_cartons
       SET manifest_id = NULL
     WHERE manifest_id = p_manifest_id;

    DELETE FROM public.wms_manifest_cartons WHERE manifest_id = p_manifest_id;
  END IF;

  RETURN jsonb_build_object('row_version', v_new_rv, 'state', p_to_state);
END;
$$;

REVOKE ALL ON FUNCTION public.wms_transition_manifest(uuid,wms_manifest_state,integer,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_transition_manifest(uuid,wms_manifest_state,integer,text,jsonb) TO authenticated, service_role;

-- ============================================================================
-- Register new topic warehouse.wave.reopened in the events catalog.
-- ============================================================================
INSERT INTO public.wms_events_catalog
  (topic, aggregate, transition, producers, consumers, payload_schema, description, idempotency_key_shape)
VALUES
  ('warehouse.wave.reopened', 'wave', 'reopened',
   ARRAY['wms_transition_manifest'],
   ARRAY['wave_planner','labour','audit'],
   '{}'::jsonb,
   'Manifest cancellation released the wave''s reservations — planner may re-allocate.',
   'wms.wave:{id}:reopened_by_manifest:{manifest_id}')
ON CONFLICT (topic) DO NOTHING;
