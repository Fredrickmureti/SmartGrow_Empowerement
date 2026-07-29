-- Phase 2.4 §2 — Typed WMS transition RPCs (optimistic-locked, FSM-guarded, outbox-emitting)

-- ============ wms_transition_wave ============
CREATE OR REPLACE FUNCTION public.wms_transition_wave(
  p_wave_id uuid,
  p_to_state wms_wave_state,
  p_row_version integer,
  p_reason text DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_row public.wms_pick_waves%ROWTYPE;
  v_from wms_wave_state;
  v_allowed boolean := false;
  v_new_rv integer;
BEGIN
  SELECT * INTO v_row FROM public.wms_pick_waves WHERE id = p_wave_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pick wave not found' USING ERRCODE = 'P0002'; END IF;
  IF v_row.row_version <> p_row_version THEN
    RAISE EXCEPTION 'Row version mismatch (have %, expected %)', v_row.row_version, p_row_version USING ERRCODE = '40001';
  END IF;
  v_from := v_row.state;

  v_allowed := CASE
    WHEN v_from = 'draft'    AND p_to_state IN ('released','cancelled')            THEN true
    WHEN v_from = 'released' AND p_to_state IN ('picking','cancelled')             THEN true
    WHEN v_from = 'picking'  AND p_to_state IN ('picked','cancelled')              THEN true
    WHEN v_from = 'picked'   AND p_to_state IN ('packing','cancelled')             THEN true
    WHEN v_from = 'packing'  AND p_to_state IN ('packed','cancelled')              THEN true
    ELSE false
  END;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Illegal wave transition % → %', v_from, p_to_state USING ERRCODE = '22023';
  END IF;

  v_new_rv := v_row.row_version + 1;
  UPDATE public.wms_pick_waves SET
    state        = p_to_state,
    row_version  = v_new_rv,
    released_at  = COALESCE(released_at,  CASE WHEN p_to_state = 'released' THEN now() END),
    completed_at = COALESCE(completed_at, CASE WHEN p_to_state IN ('packed','cancelled') THEN now() END),
    updated_at   = now()
  WHERE id = p_wave_id;

  PERFORM public._wms_emit_outbox(
    'warehouse.wave.' || p_to_state::text,
    'wms.wave:' || p_wave_id::text || ':' || p_to_state::text,
    v_row.organization_id, v_row.business_id,
    jsonb_build_object(
      'aggregate_id', p_wave_id, 'warehouse_id', v_row.warehouse_id, 'branch_id', v_row.branch_id,
      'actor_id', auth.uid(), 'occurred_at', now(),
      'from_state', v_from, 'to_state', p_to_state,
      'reason', p_reason, 'extra', COALESCE(p_payload, '{}'::jsonb)
    )
  );

  RETURN jsonb_build_object('row_version', v_new_rv, 'state', p_to_state);
END;
$$;
REVOKE ALL ON FUNCTION public.wms_transition_wave(uuid,wms_wave_state,integer,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_transition_wave(uuid,wms_wave_state,integer,text,jsonb) TO authenticated, service_role;

-- ============ wms_transition_manifest ============
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
  v_row public.wms_loading_manifests%ROWTYPE;
  v_from wms_manifest_state;
  v_allowed boolean := false;
  v_new_rv integer;
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

  RETURN jsonb_build_object('row_version', v_new_rv, 'state', p_to_state);
END;
$$;
REVOKE ALL ON FUNCTION public.wms_transition_manifest(uuid,wms_manifest_state,integer,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_transition_manifest(uuid,wms_manifest_state,integer,text,jsonb) TO authenticated, service_role;

-- ============ wms_transition_qc ============
-- state is TEXT (no enum): pending, in_progress, passed, failed, conditional, closed, cancelled
CREATE OR REPLACE FUNCTION public.wms_transition_qc(
  p_qc_id uuid,
  p_to_state text,
  p_row_version integer,
  p_reason text DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_row public.wms_qc_inspections%ROWTYPE;
  v_from text;
  v_allowed boolean := false;
  v_new_rv integer;
BEGIN
  IF p_to_state NOT IN ('pending','in_progress','passed','failed','conditional','closed','cancelled') THEN
    RAISE EXCEPTION 'Unknown QC state %', p_to_state USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row FROM public.wms_qc_inspections WHERE id = p_qc_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'QC inspection not found' USING ERRCODE = 'P0002'; END IF;
  IF v_row.row_version <> p_row_version THEN
    RAISE EXCEPTION 'Row version mismatch (have %, expected %)', v_row.row_version, p_row_version USING ERRCODE = '40001';
  END IF;
  v_from := v_row.state;

  v_allowed := CASE
    WHEN v_from = 'pending'     AND p_to_state IN ('in_progress','cancelled')                      THEN true
    WHEN v_from = 'in_progress' AND p_to_state IN ('passed','failed','conditional','cancelled')    THEN true
    WHEN v_from IN ('passed','failed','conditional') AND p_to_state IN ('closed','cancelled')      THEN true
    ELSE false
  END;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Illegal QC transition % → %', v_from, p_to_state USING ERRCODE = '22023';
  END IF;

  v_new_rv := v_row.row_version + 1;
  UPDATE public.wms_qc_inspections SET
    state         = p_to_state,
    row_version   = v_new_rv,
    inspector_id  = COALESCE(inspector_id,  CASE WHEN p_to_state = 'in_progress' THEN auth.uid() END),
    inspected_at  = COALESCE(inspected_at,  CASE WHEN p_to_state IN ('passed','failed','conditional') THEN now() END),
    updated_at    = now()
  WHERE id = p_qc_id;

  PERFORM public._wms_emit_outbox(
    'warehouse.qc.' || p_to_state,
    'wms.qc:' || p_qc_id::text || ':' || p_to_state,
    v_row.organization_id, v_row.business_id,
    jsonb_build_object(
      'aggregate_id', p_qc_id, 'warehouse_id', v_row.warehouse_id, 'branch_id', v_row.branch_id,
      'actor_id', auth.uid(), 'occurred_at', now(),
      'from_state', v_from, 'to_state', p_to_state,
      'reason', p_reason, 'extra', COALESCE(p_payload, '{}'::jsonb)
    )
  );

  RETURN jsonb_build_object('row_version', v_new_rv, 'state', p_to_state);
END;
$$;
REVOKE ALL ON FUNCTION public.wms_transition_qc(uuid,text,integer,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_transition_qc(uuid,text,integer,text,jsonb) TO authenticated, service_role;

-- ============ wms_transition_count_session ============
CREATE OR REPLACE FUNCTION public.wms_transition_count_session(
  p_session_id uuid,
  p_to_state wms_count_state,
  p_row_version integer,
  p_reason text DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_row public.wms_count_sessions%ROWTYPE;
  v_from wms_count_state;
  v_allowed boolean := false;
  v_new_rv integer;
BEGIN
  SELECT * INTO v_row FROM public.wms_count_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Count session not found' USING ERRCODE = 'P0002'; END IF;
  IF v_row.row_version <> p_row_version THEN
    RAISE EXCEPTION 'Row version mismatch (have %, expected %)', v_row.row_version, p_row_version USING ERRCODE = '40001';
  END IF;
  v_from := v_row.state;

  v_allowed := CASE
    WHEN v_from = 'draft'    AND p_to_state IN ('counting','cancelled')       THEN true
    WHEN v_from = 'counting' AND p_to_state IN ('review','cancelled')         THEN true
    WHEN v_from = 'review'   AND p_to_state IN ('posted','counting','cancelled') THEN true
    ELSE false
  END;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Illegal count session transition % → %', v_from, p_to_state USING ERRCODE = '22023';
  END IF;

  v_new_rv := v_row.row_version + 1;
  UPDATE public.wms_count_sessions SET
    state       = p_to_state,
    row_version = v_new_rv,
    posted_at   = COALESCE(posted_at, CASE WHEN p_to_state = 'posted' THEN now() END),
    posted_by   = COALESCE(posted_by, CASE WHEN p_to_state = 'posted' THEN auth.uid() END),
    updated_at  = now()
  WHERE id = p_session_id;

  PERFORM public._wms_emit_outbox(
    'warehouse.count.' || p_to_state::text,
    'wms.count:' || p_session_id::text || ':' || p_to_state::text,
    v_row.organization_id, v_row.business_id,
    jsonb_build_object(
      'aggregate_id', p_session_id, 'warehouse_id', v_row.warehouse_id, 'branch_id', v_row.branch_id,
      'actor_id', auth.uid(), 'occurred_at', now(),
      'from_state', v_from, 'to_state', p_to_state,
      'reason', p_reason, 'extra', COALESCE(p_payload, '{}'::jsonb)
    )
  );

  RETURN jsonb_build_object('row_version', v_new_rv, 'state', p_to_state);
END;
$$;
REVOKE ALL ON FUNCTION public.wms_transition_count_session(uuid,wms_count_state,integer,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_transition_count_session(uuid,wms_count_state,integer,text,jsonb) TO authenticated, service_role;

-- ============ Register new topics in wms_events_catalog ============
INSERT INTO public.wms_events_catalog (topic, aggregate, transition, producers, consumers, payload_schema, description, idempotency_key_shape)
VALUES
  ('warehouse.wave.draft',        'wave',     'draft',        ARRAY['wms_transition_wave'],     ARRAY['audit'],                        '{}'::jsonb, 'Pick wave created in draft.',                    'wms.wave:{id}:draft'),
  ('warehouse.wave.released',     'wave',     'released',     ARRAY['wms_transition_wave'],     ARRAY['picking','audit'],              '{}'::jsonb, 'Pick wave released to operators.',               'wms.wave:{id}:released'),
  ('warehouse.wave.picking',      'wave',     'picking',      ARRAY['wms_transition_wave'],     ARRAY['audit'],                        '{}'::jsonb, 'Pick wave picking in progress.',                 'wms.wave:{id}:picking'),
  ('warehouse.wave.picked',       'wave',     'picked',       ARRAY['wms_transition_wave'],     ARRAY['packing','audit'],              '{}'::jsonb, 'Pick wave fully picked.',                        'wms.wave:{id}:picked'),
  ('warehouse.wave.packing',      'wave',     'packing',      ARRAY['wms_transition_wave'],     ARRAY['audit'],                        '{}'::jsonb, 'Pick wave moved to packing.',                    'wms.wave:{id}:packing'),
  ('warehouse.wave.packed',       'wave',     'packed',       ARRAY['wms_transition_wave'],     ARRAY['dispatch','audit'],             '{}'::jsonb, 'Pick wave packed and ready for dispatch.',       'wms.wave:{id}:packed'),
  ('warehouse.wave.cancelled',    'wave',     'cancelled',    ARRAY['wms_transition_wave'],     ARRAY['audit'],                        '{}'::jsonb, 'Pick wave cancelled.',                           'wms.wave:{id}:cancelled'),

  ('warehouse.manifest.draft',      'manifest', 'draft',      ARRAY['wms_transition_manifest'], ARRAY['audit'],                        '{}'::jsonb, 'Loading manifest opened in draft.',              'wms.manifest:{id}:draft'),
  ('warehouse.manifest.loading',    'manifest', 'loading',    ARRAY['wms_transition_manifest'], ARRAY['audit'],                        '{}'::jsonb, 'Manifest is being loaded onto the trailer.',     'wms.manifest:{id}:loading'),
  ('warehouse.manifest.closed',     'manifest', 'closed',     ARRAY['wms_transition_manifest'], ARRAY['dispatch','audit'],             '{}'::jsonb, 'Manifest closed, ready to dispatch.',            'wms.manifest:{id}:closed'),
  ('warehouse.manifest.dispatched', 'manifest', 'dispatched', ARRAY['wms_transition_manifest'], ARRAY['inventory','finance','audit'],  '{}'::jsonb, 'Manifest dispatched — trailer has left.',        'wms.manifest:{id}:dispatched'),
  ('warehouse.manifest.cancelled',  'manifest', 'cancelled',  ARRAY['wms_transition_manifest'], ARRAY['audit'],                        '{}'::jsonb, 'Manifest cancelled.',                            'wms.manifest:{id}:cancelled'),

  ('warehouse.qc.pending',      'qc', 'pending',      ARRAY['wms_transition_qc'], ARRAY['audit'],                        '{}'::jsonb, 'QC inspection queued.',                          'wms.qc:{id}:pending'),
  ('warehouse.qc.in_progress',  'qc', 'in_progress',  ARRAY['wms_transition_qc'], ARRAY['audit'],                        '{}'::jsonb, 'QC inspection started by inspector.',            'wms.qc:{id}:in_progress'),
  ('warehouse.qc.passed',       'qc', 'passed',       ARRAY['wms_transition_qc'], ARRAY['inventory','audit'],            '{}'::jsonb, 'QC inspection passed — stock released.',         'wms.qc:{id}:passed'),
  ('warehouse.qc.failed',       'qc', 'failed',       ARRAY['wms_transition_qc'], ARRAY['inventory','procurement','audit'], '{}'::jsonb, 'QC inspection failed — stock quarantined.',   'wms.qc:{id}:failed'),
  ('warehouse.qc.conditional',  'qc', 'conditional',  ARRAY['wms_transition_qc'], ARRAY['inventory','audit'],            '{}'::jsonb, 'QC inspection accepted with condition.',         'wms.qc:{id}:conditional'),
  ('warehouse.qc.closed',       'qc', 'closed',       ARRAY['wms_transition_qc'], ARRAY['audit'],                        '{}'::jsonb, 'QC inspection closed.',                          'wms.qc:{id}:closed'),
  ('warehouse.qc.cancelled',    'qc', 'cancelled',    ARRAY['wms_transition_qc'], ARRAY['audit'],                        '{}'::jsonb, 'QC inspection cancelled.',                       'wms.qc:{id}:cancelled'),

  ('warehouse.count.draft',     'count', 'draft',     ARRAY['wms_transition_count_session'], ARRAY['audit'],             '{}'::jsonb, 'Cycle count session created.',                   'wms.count:{id}:draft'),
  ('warehouse.count.counting',  'count', 'counting',  ARRAY['wms_transition_count_session'], ARRAY['audit'],             '{}'::jsonb, 'Cycle count in progress.',                       'wms.count:{id}:counting'),
  ('warehouse.count.review',    'count', 'review',    ARRAY['wms_transition_count_session'], ARRAY['audit'],             '{}'::jsonb, 'Cycle count under review.',                      'wms.count:{id}:review'),
  ('warehouse.count.posted',    'count', 'posted',    ARRAY['wms_transition_count_session'], ARRAY['inventory','audit'], '{}'::jsonb, 'Cycle count posted — adjustments applied.',      'wms.count:{id}:posted'),
  ('warehouse.count.cancelled', 'count', 'cancelled', ARRAY['wms_transition_count_session'], ARRAY['audit'],             '{}'::jsonb, 'Cycle count cancelled.',                         'wms.count:{id}:cancelled')
ON CONFLICT (topic) DO NOTHING;