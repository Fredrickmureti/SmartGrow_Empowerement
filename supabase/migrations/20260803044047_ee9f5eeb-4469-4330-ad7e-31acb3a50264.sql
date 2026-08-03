-- =====================================================================
-- Phase A: Dispatch relieves inventory.
--
-- Root cause being fixed: wms_transition_manifest(... 'dispatched')
-- flipped manifest/LPN state but never posted stock movements. The
-- ledger-correct primitive wms_lpn_dispatch() existed but was called by
-- nothing on the manifest path, so goods left the building while the
-- books still carried them.
--
-- Fix: the FSM edge closed -> dispatched now dispatches every loaded
-- carton's shipment LPN through wms_lpn_dispatch(), in the same
-- transaction, idempotently.
--
-- Legacy wrappers close_loading_manifest / dispatch_loading_manifest are
-- reduced to thin delegates over the FSM so there is exactly ONE
-- implementation of close/dispatch semantics, including for the mobile
-- offline replay queue which enqueues those RPC names.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.wms_transition_manifest(
  p_manifest_id uuid,
  p_to_state wms_manifest_state,
  p_row_version integer,
  p_reason text DEFAULT NULL::text,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row        public.wms_loading_manifests%ROWTYPE;
  v_from       wms_manifest_state;
  v_allowed    boolean := false;
  v_new_rv     integer;
  v_short      jsonb;
  v_wave       record;
  v_task       record;
  v_carton     record;
  v_carton_ct  int := 0;
  v_relieved   int := 0;
  v_departure  timestamptz;
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
  v_departure := COALESCE(
    NULLIF(p_payload ->> 'departure_at', '')::timestamptz,
    now()
  );

  v_new_rv := v_row.row_version + 1;
  UPDATE public.wms_loading_manifests SET
    state          = p_to_state,
    row_version    = v_new_rv,
    closed_at      = COALESCE(closed_at,     CASE WHEN p_to_state IN ('closed','dispatched') THEN now() END),
    closed_by      = COALESCE(closed_by,     CASE WHEN p_to_state IN ('closed','dispatched') THEN auth.uid() END),
    dispatched_at  = COALESCE(dispatched_at, CASE WHEN p_to_state = 'dispatched' THEN v_departure END),
    dispatched_by  = COALESCE(dispatched_by, CASE WHEN p_to_state = 'dispatched' THEN auth.uid() END),
    updated_at     = now()
  WHERE id = p_manifest_id;

  -- ------------------------------------------------------------------
  -- LEDGER RELIEF (Phase A).
  --
  -- Departure is the moment custody transfers, so departure is the
  -- moment stock leaves the books. Route every loaded carton's shipment
  -- LPN through wms_lpn_dispatch(), which posts transfer_out movements,
  -- clears stock_quants and marks the plate (and its children) shipped.
  --
  -- Idempotent: plates already 'shipped' are skipped, so a replayed
  -- offline mutation cannot double-deduct. Errors are NOT swallowed —
  -- if inventory cannot be relieved, the dispatch rolls back.
  -- ------------------------------------------------------------------
  IF p_to_state = 'dispatched' THEN
    FOR v_carton IN
      SELECT c.id            AS carton_id,
             c.shipment_lpn_id,
             lp.status       AS lpn_status,
             lp.row_version  AS lpn_row_version
        FROM public.wms_manifest_cartons mc
        JOIN public.wms_pack_cartons c ON c.id = mc.carton_id
        LEFT JOIN public.wms_license_plates lp ON lp.id = c.shipment_lpn_id
       WHERE mc.manifest_id = p_manifest_id
       ORDER BY c.id
    LOOP
      IF v_carton.shipment_lpn_id IS NOT NULL
         AND v_carton.lpn_status IS DISTINCT FROM 'shipped'::public.wms_lpn_status THEN
        PERFORM public.wms_lpn_dispatch(
          v_carton.shipment_lpn_id,
          v_carton.lpn_row_version,
          'Manifest dispatch ' || COALESCE(v_row.code, p_manifest_id::text)
        );
        v_relieved := v_relieved + 1;
      END IF;

      PERFORM public._wms_emit_outbox(
        'warehouse.carton.shipped',
        'wms.carton.shipped:' || v_carton.carton_id::text,
        v_row.organization_id, v_row.business_id,
        jsonb_build_object(
          'aggregate_id',  v_carton.carton_id,
          'warehouse_id',  v_row.warehouse_id,
          'branch_id',     v_row.branch_id,
          'actor_id',      auth.uid(),
          'occurred_at',   now(),
          'carton_id',     v_carton.carton_id,
          'manifest_id',   p_manifest_id,
          'lpn_id',        v_carton.shipment_lpn_id
        )
      );
    END LOOP;
  END IF;

  PERFORM public._wms_emit_outbox(
    'warehouse.manifest.' || p_to_state::text,
    'wms.manifest:' || p_manifest_id::text || ':' || p_to_state::text,
    v_row.organization_id, v_row.business_id,
    jsonb_build_object(
      'aggregate_id', p_manifest_id, 'warehouse_id', v_row.warehouse_id, 'branch_id', v_row.branch_id,
      'actor_id', auth.uid(), 'occurred_at', now(),
      'from_state', v_from, 'to_state', p_to_state,
      'reason', p_reason, 'extra', COALESCE(p_payload, '{}'::jsonb),
      'lpns_relieved', v_relieved
    )
  );

  -- ------------------------------------------------------------------
  -- Cancellation cascade.
  -- ------------------------------------------------------------------
  IF p_to_state = 'cancelled' THEN
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

    UPDATE public.wms_pack_cartons
       SET manifest_id = NULL
     WHERE manifest_id = p_manifest_id;

    DELETE FROM public.wms_manifest_cartons WHERE manifest_id = p_manifest_id;
  END IF;

  RETURN jsonb_build_object(
    'row_version', v_new_rv,
    'state', p_to_state,
    'lpns_relieved', v_relieved
  );
END;
$function$;

-- =====================================================================
-- Legacy wrappers become thin delegates over the FSM.
-- Single authoritative implementation; no parallel enforcement.
-- =====================================================================

DROP FUNCTION IF EXISTS public.close_loading_manifest(uuid);

CREATE OR REPLACE FUNCTION public.close_loading_manifest(p_manifest_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_m record;
BEGIN
  SELECT * INTO v_m FROM public.wms_loading_manifests WHERE id = p_manifest_id;
  IF v_m.id IS NULL THEN RAISE EXCEPTION 'manifest % not found', p_manifest_id USING ERRCODE = 'P0002'; END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_m.business_id) THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;

  -- Idempotent: already closed (or beyond) is a no-op.
  IF v_m.state <> 'loading' THEN
    RETURN jsonb_build_object('manifest_id', p_manifest_id, 'state', v_m.state, 'noop', true);
  END IF;

  RETURN public.wms_transition_manifest(
    p_manifest_id, 'closed'::public.wms_manifest_state, v_m.row_version, 'close_loading_manifest'
  ) || jsonb_build_object('manifest_id', p_manifest_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.dispatch_loading_manifest(
  p_manifest_id uuid,
  p_departure_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_m       record;
  v_result  jsonb;
  v_count   int;
BEGIN
  SELECT * INTO v_m FROM public.wms_loading_manifests WHERE id = p_manifest_id;
  IF v_m.id IS NULL THEN RAISE EXCEPTION 'manifest % not found', p_manifest_id USING ERRCODE = 'P0002'; END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_m.business_id) THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;

  -- Idempotent replay guard for the offline mutation queue.
  IF v_m.state = 'dispatched' THEN
    SELECT count(*) INTO v_count FROM public.wms_manifest_cartons WHERE manifest_id = p_manifest_id;
    RETURN jsonb_build_object('manifest_id', p_manifest_id, 'shipped_cartons', v_count, 'noop', true);
  END IF;

  IF v_m.state NOT IN ('loading','closed') THEN
    RAISE EXCEPTION 'cannot dispatch manifest in state %', v_m.state USING ERRCODE = '22023';
  END IF;

  -- The FSM only permits closed -> dispatched; close first when needed.
  IF v_m.state = 'loading' THEN
    PERFORM public.wms_transition_manifest(
      p_manifest_id, 'closed'::public.wms_manifest_state, v_m.row_version, 'auto_close_before_dispatch'
    );
    SELECT * INTO v_m FROM public.wms_loading_manifests WHERE id = p_manifest_id;
  END IF;

  v_result := public.wms_transition_manifest(
    p_manifest_id,
    'dispatched'::public.wms_manifest_state,
    v_m.row_version,
    'dispatch_loading_manifest',
    jsonb_build_object('departure_at', p_departure_at)
  );

  SELECT count(*) INTO v_count FROM public.wms_manifest_cartons WHERE manifest_id = p_manifest_id;

  RETURN v_result || jsonb_build_object('manifest_id', p_manifest_id, 'shipped_cartons', v_count);
END;
$function$;

-- Remove the stale 3-argument overload so there is one way to open a manifest.
DROP FUNCTION IF EXISTS public.open_loading_manifest(uuid, uuid, timestamptz);