-- ============================================================
-- Phase 1.4 — Receiving / Return / Exception FSM RPCs
-- ADR 0101. All transition writers are SECURITY DEFINER, enforce
-- optimistic row_version locking, validate the state edge, stamp
-- lifecycle timestamps, and emit to business_event_outbox.
-- ============================================================

-- ---------- helpers ---------------------------------------------------
CREATE OR REPLACE FUNCTION public._wms_emit_outbox(
  p_topic text,
  p_idempotency_key text,
  p_organization_id uuid,
  p_business_id uuid,
  p_payload jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.business_event_outbox (
    organization_id, business_id, topic, idempotency_key, payload, status
  ) VALUES (
    p_organization_id, p_business_id, p_topic, p_idempotency_key, COALESCE(p_payload, '{}'::jsonb), 'pending'
  )
  ON CONFLICT (idempotency_key) DO NOTHING;
EXCEPTION WHEN undefined_column OR undefined_table THEN
  -- If outbox schema differs slightly, do not fail the transition.
  NULL;
END;
$$;

REVOKE ALL ON FUNCTION public._wms_emit_outbox(text,text,uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._wms_emit_outbox(text,text,uuid,uuid,jsonb) TO authenticated, service_role;

-- ---------- Receiving sessions ---------------------------------------
CREATE OR REPLACE FUNCTION public.wms_transition_receiving(
  p_session_id uuid,
  p_to_state wms_receiving_state,
  p_row_version integer,
  p_reason text DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.wms_receiving_sessions%ROWTYPE;
  v_from wms_receiving_state;
  v_allowed boolean := false;
  v_new_rv integer;
BEGIN
  SELECT * INTO v_row FROM public.wms_receiving_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receiving session not found' USING ERRCODE = 'P0002'; END IF;
  IF v_row.row_version <> p_row_version THEN
    RAISE EXCEPTION 'Row version mismatch (have %, expected %)', v_row.row_version, p_row_version USING ERRCODE = '40001';
  END IF;
  v_from := v_row.state;

  -- FSM edges
  v_allowed := CASE
    WHEN v_from = 'open'       AND p_to_state IN ('unloading','cancelled')                 THEN true
    WHEN v_from = 'unloading'  AND p_to_state IN ('captured','discrepant','cancelled')     THEN true
    WHEN v_from = 'captured'   AND p_to_state IN ('posted','discrepant','cancelled')       THEN true
    WHEN v_from = 'discrepant' AND p_to_state IN ('captured','posted','closed','cancelled') THEN true
    WHEN v_from = 'posted'     AND p_to_state IN ('closed')                                THEN true
    WHEN v_from = p_to_state                                                                THEN false
    ELSE false
  END;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Illegal receiving transition % → %', v_from, p_to_state USING ERRCODE = '22023';
  END IF;

  v_new_rv := v_row.row_version + 1;
  UPDATE public.wms_receiving_sessions SET
    state       = p_to_state,
    row_version = v_new_rv,
    started_at  = COALESCE(started_at, CASE WHEN p_to_state = 'unloading' THEN now() ELSE NULL END),
    closed_at   = CASE WHEN p_to_state IN ('closed','cancelled') THEN now() ELSE closed_at END,
    updated_at  = now()
  WHERE id = p_session_id;

  PERFORM public._wms_emit_outbox(
    'warehouse.receiving.' || p_to_state::text,
    'wms.receiving:' || p_session_id::text || ':' || p_to_state::text,
    v_row.organization_id,
    v_row.business_id,
    jsonb_build_object(
      'aggregate_id', p_session_id,
      'warehouse_id', v_row.warehouse_id,
      'branch_id',    v_row.branch_id,
      'actor_id',     auth.uid(),
      'occurred_at',  now(),
      'from_state',   v_from,
      'to_state',     p_to_state,
      'reason',       p_reason,
      'extra',        COALESCE(p_payload, '{}'::jsonb)
    )
  );

  RETURN jsonb_build_object('row_version', v_new_rv, 'state', p_to_state);
END;
$$;

REVOKE ALL ON FUNCTION public.wms_transition_receiving(uuid,wms_receiving_state,integer,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_transition_receiving(uuid,wms_receiving_state,integer,text,jsonb) TO authenticated, service_role;

-- ---------- Return orders --------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_transition_return(
  p_return_id uuid,
  p_to_state wms_return_state,
  p_row_version integer,
  p_reason text DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.wms_return_orders%ROWTYPE;
  v_from wms_return_state;
  v_allowed boolean := false;
  v_new_rv integer;
BEGIN
  SELECT * INTO v_row FROM public.wms_return_orders WHERE id = p_return_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Return order not found' USING ERRCODE = 'P0002'; END IF;
  IF v_row.row_version <> p_row_version THEN
    RAISE EXCEPTION 'Row version mismatch (have %, expected %)', v_row.row_version, p_row_version USING ERRCODE = '40001';
  END IF;
  v_from := v_row.state;

  v_allowed := CASE
    WHEN v_from = 'draft'      AND p_to_state IN ('authorized','cancelled')                THEN true
    WHEN v_from = 'authorized' AND p_to_state IN ('in_transit','received','cancelled')     THEN true
    WHEN v_from = 'in_transit' AND p_to_state IN ('received','cancelled')                  THEN true
    WHEN v_from = 'received'   AND p_to_state IN ('inspecting','disposed','cancelled')     THEN true
    WHEN v_from = 'inspecting' AND p_to_state IN ('disposed','cancelled')                  THEN true
    WHEN v_from = 'disposed'   AND p_to_state IN ('closed')                                THEN true
    ELSE false
  END;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Illegal return transition % → %', v_from, p_to_state USING ERRCODE = '22023';
  END IF;

  v_new_rv := v_row.row_version + 1;
  UPDATE public.wms_return_orders SET
    state       = p_to_state,
    row_version = v_new_rv,
    received_at = COALESCE(received_at, CASE WHEN p_to_state = 'received' THEN now() ELSE NULL END),
    closed_at   = CASE WHEN p_to_state IN ('closed','cancelled') THEN now() ELSE closed_at END,
    updated_at  = now()
  WHERE id = p_return_id;

  PERFORM public._wms_emit_outbox(
    'warehouse.return.' || p_to_state::text,
    'wms.return:' || p_return_id::text || ':' || p_to_state::text,
    v_row.organization_id,
    v_row.business_id,
    jsonb_build_object(
      'aggregate_id', p_return_id,
      'warehouse_id', v_row.warehouse_id,
      'branch_id',    v_row.branch_id,
      'actor_id',     auth.uid(),
      'occurred_at',  now(),
      'from_state',   v_from,
      'to_state',     p_to_state,
      'reason',       p_reason,
      'extra',        COALESCE(p_payload, '{}'::jsonb)
    )
  );

  RETURN jsonb_build_object('row_version', v_new_rv, 'state', p_to_state);
END;
$$;

REVOKE ALL ON FUNCTION public.wms_transition_return(uuid,wms_return_state,integer,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_transition_return(uuid,wms_return_state,integer,text,jsonb) TO authenticated, service_role;

-- ---------- Exceptions -----------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_raise_exception(
  p_warehouse_id uuid,
  p_kind wms_exception_kind,
  p_reason text,
  p_aggregate_type text DEFAULT NULL,
  p_aggregate_id uuid DEFAULT NULL,
  p_task_id uuid DEFAULT NULL,
  p_lpn_id uuid DEFAULT NULL,
  p_severity smallint DEFAULT 2,
  p_details jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wh RECORD;
  v_id uuid;
BEGIN
  SELECT id, organization_id, business_id, branch_id
    INTO v_wh
    FROM public.warehouses WHERE id = p_warehouse_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Warehouse not found' USING ERRCODE='P0002'; END IF;

  INSERT INTO public.wms_exceptions (
    organization_id, business_id, branch_id, warehouse_id,
    kind, state, severity, aggregate_type, aggregate_id,
    task_id, lpn_id, reason, details, raised_by
  ) VALUES (
    v_wh.organization_id, v_wh.business_id, v_wh.branch_id, p_warehouse_id,
    p_kind, 'open', COALESCE(p_severity,2), p_aggregate_type, p_aggregate_id,
    p_task_id, p_lpn_id, p_reason, COALESCE(p_details,'{}'::jsonb), auth.uid()
  ) RETURNING id INTO v_id;

  PERFORM public._wms_emit_outbox(
    'warehouse.exception.raised',
    'wms.exception:' || v_id::text || ':raised',
    v_wh.organization_id,
    v_wh.business_id,
    jsonb_build_object(
      'aggregate_id', v_id,
      'kind',         p_kind,
      'warehouse_id', p_warehouse_id,
      'branch_id',    v_wh.branch_id,
      'actor_id',     auth.uid(),
      'occurred_at',  now(),
      'task_id',      p_task_id,
      'lpn_id',       p_lpn_id,
      'reason',       p_reason,
      'details',      COALESCE(p_details,'{}'::jsonb)
    )
  );
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.wms_raise_exception(uuid,wms_exception_kind,text,text,uuid,uuid,uuid,smallint,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_raise_exception(uuid,wms_exception_kind,text,text,uuid,uuid,uuid,smallint,jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.wms_resolve_exception(
  p_exception_id uuid,
  p_to_state wms_exception_state,
  p_row_version integer,
  p_resolution text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.wms_exceptions%ROWTYPE;
  v_from wms_exception_state;
  v_allowed boolean := false;
  v_new_rv integer;
BEGIN
  SELECT * INTO v_row FROM public.wms_exceptions WHERE id = p_exception_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Exception not found' USING ERRCODE='P0002'; END IF;
  IF v_row.row_version <> p_row_version THEN
    RAISE EXCEPTION 'Row version mismatch (have %, expected %)', v_row.row_version, p_row_version USING ERRCODE = '40001';
  END IF;
  v_from := v_row.state;

  v_allowed := CASE
    WHEN v_from = 'open'          AND p_to_state IN ('acknowledged','investigating','escalated','resolved','wont_fix') THEN true
    WHEN v_from = 'acknowledged'  AND p_to_state IN ('investigating','escalated','resolved','wont_fix')                THEN true
    WHEN v_from = 'investigating' AND p_to_state IN ('escalated','resolved','wont_fix')                                 THEN true
    WHEN v_from = 'escalated'     AND p_to_state IN ('investigating','resolved','wont_fix')                             THEN true
    ELSE false
  END;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Illegal exception transition % → %', v_from, p_to_state USING ERRCODE='22023';
  END IF;

  v_new_rv := v_row.row_version + 1;
  UPDATE public.wms_exceptions SET
    state       = p_to_state,
    row_version = v_new_rv,
    resolution  = COALESCE(p_resolution, resolution),
    resolved_by = CASE WHEN p_to_state IN ('resolved','wont_fix') THEN auth.uid() ELSE resolved_by END,
    resolved_at = CASE WHEN p_to_state IN ('resolved','wont_fix') THEN now() ELSE resolved_at END,
    updated_at  = now()
  WHERE id = p_exception_id;

  PERFORM public._wms_emit_outbox(
    'warehouse.exception.' || p_to_state::text,
    'wms.exception:' || p_exception_id::text || ':' || p_to_state::text,
    v_row.organization_id,
    v_row.business_id,
    jsonb_build_object(
      'aggregate_id', p_exception_id,
      'warehouse_id', v_row.warehouse_id,
      'branch_id',    v_row.branch_id,
      'actor_id',     auth.uid(),
      'occurred_at',  now(),
      'from_state',   v_from,
      'to_state',     p_to_state,
      'resolution',   p_resolution
    )
  );

  RETURN jsonb_build_object('row_version', v_new_rv, 'state', p_to_state);
END;
$$;

REVOKE ALL ON FUNCTION public.wms_resolve_exception(uuid,wms_exception_state,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_resolve_exception(uuid,wms_exception_state,integer,text) TO authenticated, service_role;
