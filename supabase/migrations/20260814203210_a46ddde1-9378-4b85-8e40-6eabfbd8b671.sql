-- Phase 1 — move the packaging→base conversion off the browser and onto the server.

ALTER TABLE public.wms_receiving_lines
  ADD COLUMN IF NOT EXISTS packaging_id uuid REFERENCES public.product_packaging(id),
  ADD COLUMN IF NOT EXISTS entered_qty numeric,
  ADD COLUMN IF NOT EXISTS entered_damaged_qty numeric;

ALTER TABLE public.wms_return_lines
  ADD COLUMN IF NOT EXISTS packaging_id uuid REFERENCES public.product_packaging(id),
  ADD COLUMN IF NOT EXISTS entered_qty numeric;

ALTER TABLE public.wms_count_lines
  ADD COLUMN IF NOT EXISTS packaging_id uuid REFERENCES public.product_packaging(id),
  ADD COLUMN IF NOT EXISTS entered_qty numeric,
  ADD COLUMN IF NOT EXISTS entered_uom text;

-- ------------------------------------------------------------------
-- Canonical conversion delegate. No new mathematics — it resolves the
-- product's own packaging row and multiplies by qty_in_base_uom, which is
-- the same definition `product_packaging` gives every other consumer.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_to_base_qty(
  p_product_id uuid,
  p_packaging_id uuid,
  p_qty numeric
) RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_factor numeric;
BEGIN
  IF p_qty IS NULL THEN RETURN NULL; END IF;
  IF p_packaging_id IS NULL THEN RETURN p_qty; END IF;

  SELECT pp.qty_in_base_uom INTO v_factor
    FROM public.product_packaging pp
   WHERE pp.id = p_packaging_id
     AND pp.product_id = p_product_id;

  IF v_factor IS NULL THEN
    RAISE EXCEPTION 'WMS_PACKAGING_MISMATCH: packaging % does not belong to product %',
      p_packaging_id, p_product_id USING ERRCODE = '22023';
  END IF;
  IF v_factor <= 0 THEN
    RAISE EXCEPTION 'WMS_PACKAGING_INVALID: packaging % has a non-positive base factor', p_packaging_id
      USING ERRCODE = '22023';
  END IF;

  RETURN round(p_qty * v_factor, 6);
END $$;

REVOKE ALL ON FUNCTION public.wms_to_base_qty(uuid, uuid, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_to_base_qty(uuid, uuid, numeric) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.wms_packaging_label(p_packaging_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$ SELECT name FROM public.product_packaging WHERE id = p_packaging_id $$;

REVOKE ALL ON FUNCTION public.wms_packaging_label(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_packaging_label(uuid) TO authenticated, service_role;

-- ------------------------------------------------------------------
-- Receiving capture — packaging aware.
-- ------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.wms_capture_receiving_line(uuid,uuid,numeric,numeric,uuid,text,text,text,uuid,text,text,text,date,numeric,boolean);

CREATE OR REPLACE FUNCTION public.wms_capture_receiving_line(
  p_session_id uuid,
  p_product_id uuid,
  p_received_qty numeric,
  p_expected_qty numeric DEFAULT NULL,
  p_lpn_id uuid DEFAULT NULL,
  p_lot_number text DEFAULT NULL,
  p_serial_number text DEFAULT NULL,
  p_uom text DEFAULT NULL,
  p_staging_location_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_client_scan_id text DEFAULT NULL,
  p_device_id text DEFAULT NULL,
  p_expiry_date date DEFAULT NULL,
  p_damaged_qty numeric DEFAULT 0,
  p_qc_hold boolean DEFAULT false,
  p_packaging_id uuid DEFAULT NULL,
  p_entered_qty numeric DEFAULT NULL,
  p_entered_damaged_qty numeric DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_prior jsonb;
  v_sess public.wms_receiving_sessions%ROWTYPE;
  v_line_id uuid;
  v_unexpected boolean := false;
  v_result jsonb;
  v_pack_factor numeric;
  v_entered numeric;
  v_entered_damaged numeric;
  v_base numeric;
  v_base_damaged numeric;
  v_uom text;
BEGIN
  v_prior := public._wms_client_scan_lookup(p_device_id, p_client_scan_id);
  IF v_prior IS NOT NULL THEN
    RETURN v_prior || jsonb_build_object('replayed', true);
  END IF;

  SELECT * INTO v_sess FROM public.wms_receiving_sessions WHERE id = p_session_id;
  IF v_sess.id IS NULL THEN RAISE EXCEPTION 'receiving session % not found', p_session_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_sess.business_id) THEN
    RAISE EXCEPTION 'access denied';
  END IF;

  -- Server-side conversion path. The operator's typed quantity and packaging
  -- level arrive raw; the base quantity is derived HERE, never in the browser.
  IF p_packaging_id IS NOT NULL THEN
    v_entered         := COALESCE(p_entered_qty, p_received_qty);
    v_entered_damaged := COALESCE(p_entered_damaged_qty, p_damaged_qty, 0);
    v_base            := public.wms_to_base_qty(p_product_id, p_packaging_id, v_entered);
    v_base_damaged    := public.wms_to_base_qty(p_product_id, p_packaging_id, v_entered_damaged);
    v_uom             := COALESCE(public.wms_packaging_label(p_packaging_id), p_uom);
  ELSE
    v_entered         := COALESCE(p_entered_qty, p_received_qty);
    v_entered_damaged := COALESCE(p_entered_damaged_qty, p_damaged_qty, 0);
    v_base            := p_received_qty;
    v_base_damaged    := COALESCE(p_damaged_qty, 0);
    v_uom             := p_uom;

    -- Legacy label path: a bare packaging name means the caller tried to
    -- convert client-side. Keep rejecting it.
    IF p_uom IS NOT NULL THEN
      SELECT MAX(pp.qty_in_base_uom) INTO v_pack_factor
        FROM public.product_packaging pp
       WHERE pp.product_id = p_product_id
         AND lower(pp.name) = lower(p_uom);
      IF COALESCE(v_pack_factor, 1) > 1 THEN
        RAISE EXCEPTION 'received_qty must be in base units; uom % is a packaging level of % base units — pass p_packaging_id and p_entered_qty instead', p_uom, v_pack_factor
          USING ERRCODE = '22023';
      END IF;
    END IF;
  END IF;

  IF v_base IS NULL OR v_base < 0 THEN
    RAISE EXCEPTION 'received_qty must be >= 0' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(v_base_damaged, 0) < 0 THEN
    RAISE EXCEPTION 'damaged_qty must be >= 0' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(v_base_damaged, 0) > v_base THEN
    RAISE EXCEPTION 'damaged_qty (%) cannot exceed received_qty (%)', v_base_damaged, v_base
      USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_line_id
    FROM public.wms_receiving_lines
   WHERE session_id = v_sess.id
     AND product_id = p_product_id
     AND line_state = 'expected'
     AND (p_lot_number IS NULL OR lot_number IS NULL OR lot_number = p_lot_number)
   ORDER BY (lot_number IS NOT DISTINCT FROM p_lot_number) DESC, created_at
   LIMIT 1
   FOR UPDATE;

  IF v_line_id IS NOT NULL THEN
    UPDATE public.wms_receiving_lines SET
      received_qty        = COALESCE(received_qty, 0) + v_base,
      damaged_qty         = COALESCE(damaged_qty, 0) + COALESCE(v_base_damaged, 0),
      entered_qty         = COALESCE(entered_qty, 0) + COALESCE(v_entered, 0),
      entered_damaged_qty = COALESCE(entered_damaged_qty, 0) + COALESCE(v_entered_damaged, 0),
      packaging_id        = COALESCE(p_packaging_id, packaging_id),
      qc_hold             = qc_hold OR COALESCE(p_qc_hold, false),
      lot_number          = COALESCE(p_lot_number, lot_number),
      serial_number       = COALESCE(p_serial_number, serial_number),
      expiry_date         = COALESCE(p_expiry_date, expiry_date),
      uom                 = COALESCE(v_uom, uom),
      lpn_id              = COALESCE(p_lpn_id, lpn_id),
      staging_location_id = COALESCE(p_staging_location_id, staging_location_id),
      notes               = COALESCE(p_notes, notes),
      captured_by         = auth.uid(),
      captured_at         = now(),
      line_state          = 'captured',
      updated_at          = now()
    WHERE id = v_line_id;
  ELSE
    v_unexpected := true;
    INSERT INTO public.wms_receiving_lines (
      session_id, organization_id, business_id, warehouse_id,
      product_id, lpn_id, lot_number, serial_number, expiry_date,
      expected_qty, received_qty, damaged_qty, qc_hold, uom,
      packaging_id, entered_qty, entered_damaged_qty,
      staging_location_id, captured_by, captured_at, notes, line_state
    ) VALUES (
      v_sess.id, v_sess.organization_id, v_sess.business_id, v_sess.warehouse_id,
      p_product_id, p_lpn_id, p_lot_number, p_serial_number, p_expiry_date,
      COALESCE(p_expected_qty, 0), v_base, COALESCE(v_base_damaged, 0),
      COALESCE(p_qc_hold, false), v_uom,
      p_packaging_id, v_entered, v_entered_damaged,
      p_staging_location_id, auth.uid(), now(), p_notes, 'unexpected'
    ) RETURNING id INTO v_line_id;
  END IF;

  v_result := jsonb_build_object(
    'line_id', v_line_id,
    'session_id', v_sess.id,
    'received_qty', v_base,
    'entered_qty', v_entered,
    'packaging_id', p_packaging_id,
    'unexpected', v_unexpected,
    'replayed', false
  );

  PERFORM public._wms_client_scan_record(
    p_device_id, p_client_scan_id, 'wms_capture_receiving_line',
    v_result, v_sess.organization_id, v_sess.business_id, v_sess.warehouse_id
  );

  RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION public.wms_capture_receiving_line(uuid,uuid,numeric,numeric,uuid,text,text,text,uuid,text,text,text,date,numeric,boolean,uuid,numeric,numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_capture_receiving_line(uuid,uuid,numeric,numeric,uuid,text,text,text,uuid,text,text,text,date,numeric,boolean,uuid,numeric,numeric) TO authenticated, service_role;

-- ------------------------------------------------------------------
-- Return capture — packaging aware.
-- ------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.wms_capture_return_line(uuid,uuid,numeric,numeric,uuid,text,text,text,wms_return_condition,text,text,text);

CREATE OR REPLACE FUNCTION public.wms_capture_return_line(
  p_return_id uuid,
  p_product_id uuid,
  p_received_qty numeric,
  p_expected_qty numeric DEFAULT NULL,
  p_lpn_id uuid DEFAULT NULL,
  p_lot_number text DEFAULT NULL,
  p_serial_number text DEFAULT NULL,
  p_uom text DEFAULT NULL,
  p_condition_code public.wms_return_condition DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_client_scan_id text DEFAULT NULL,
  p_device_id text DEFAULT NULL,
  p_packaging_id uuid DEFAULT NULL,
  p_entered_qty numeric DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_prior jsonb;
  v_ord public.wms_return_orders%ROWTYPE;
  v_line_id uuid;
  v_unexpected boolean := false;
  v_result jsonb;
  v_entered numeric;
  v_base numeric;
  v_uom text;
  v_pack_factor numeric;
BEGIN
  v_prior := public._wms_client_scan_lookup(p_device_id, p_client_scan_id);
  IF v_prior IS NOT NULL THEN
    RETURN v_prior || jsonb_build_object('replayed', true);
  END IF;

  SELECT * INTO v_ord FROM public.wms_return_orders WHERE id = p_return_id FOR UPDATE;
  IF v_ord.id IS NULL THEN RAISE EXCEPTION 'return order % not found', p_return_id USING ERRCODE = '22023'; END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_ord.business_id) THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;
  IF v_ord.state NOT IN ('authorized','in_transit','received','inspecting') THEN
    RAISE EXCEPTION 'cannot capture lines while return is %', v_ord.state USING ERRCODE = '22023';
  END IF;

  v_entered := COALESCE(p_entered_qty, p_received_qty);
  IF p_packaging_id IS NOT NULL THEN
    v_base := public.wms_to_base_qty(p_product_id, p_packaging_id, v_entered);
    v_uom  := COALESCE(public.wms_packaging_label(p_packaging_id), p_uom);
  ELSE
    v_base := p_received_qty;
    v_uom  := p_uom;
    IF p_uom IS NOT NULL THEN
      SELECT MAX(pp.qty_in_base_uom) INTO v_pack_factor
        FROM public.product_packaging pp
       WHERE pp.product_id = p_product_id AND lower(pp.name) = lower(p_uom);
      IF COALESCE(v_pack_factor, 1) > 1 THEN
        RAISE EXCEPTION 'received_qty must be in base units; uom % is a packaging level of % base units — pass p_packaging_id and p_entered_qty instead', p_uom, v_pack_factor
          USING ERRCODE = '22023';
      END IF;
    END IF;
  END IF;

  IF v_base IS NULL OR v_base < 0 THEN
    RAISE EXCEPTION 'received_qty must be >= 0' USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_line_id
    FROM public.wms_return_lines
   WHERE return_order_id = v_ord.id
     AND product_id = p_product_id
     AND captured_at IS NULL
     AND (p_lot_number IS NULL OR lot_number IS NULL OR lot_number = p_lot_number)
   ORDER BY (lot_number IS NOT DISTINCT FROM p_lot_number) DESC, created_at
   LIMIT 1
   FOR UPDATE;

  IF v_line_id IS NOT NULL THEN
    UPDATE public.wms_return_lines SET
      received_qty   = COALESCE(received_qty, 0) + v_base,
      entered_qty    = COALESCE(entered_qty, 0) + COALESCE(v_entered, 0),
      packaging_id   = COALESCE(p_packaging_id, packaging_id),
      lot_number     = COALESCE(p_lot_number, lot_number),
      serial_number  = COALESCE(p_serial_number, serial_number),
      uom            = COALESCE(v_uom, uom),
      lpn_id         = COALESCE(p_lpn_id, lpn_id),
      condition_code = COALESCE(p_condition_code, condition_code),
      notes          = COALESCE(p_notes, notes),
      captured_by    = auth.uid(),
      captured_at    = now(),
      row_version    = row_version + 1,
      updated_at     = now()
    WHERE id = v_line_id;
  ELSE
    v_unexpected := true;
    INSERT INTO public.wms_return_lines (
      return_order_id, organization_id, business_id, warehouse_id,
      product_id, lpn_id, lot_number, serial_number, uom,
      packaging_id, entered_qty,
      expected_qty, received_qty, condition_code,
      captured_by, captured_at, notes
    ) VALUES (
      v_ord.id, v_ord.organization_id, v_ord.business_id, v_ord.warehouse_id,
      p_product_id, p_lpn_id, p_lot_number, p_serial_number, v_uom,
      p_packaging_id, v_entered,
      COALESCE(p_expected_qty, 0), v_base, p_condition_code,
      auth.uid(), now(), p_notes
    ) RETURNING id INTO v_line_id;
  END IF;

  v_result := jsonb_build_object(
    'line_id', v_line_id, 'return_id', v_ord.id,
    'received_qty', v_base, 'entered_qty', v_entered,
    'packaging_id', p_packaging_id,
    'unexpected', v_unexpected, 'replayed', false
  );

  PERFORM public._wms_emit_outbox(
    'warehouse.return.line_captured',
    'wms.return:' || v_line_id::text || ':line_captured',
    v_ord.organization_id, v_ord.business_id,
    jsonb_build_object(
      'aggregate_id', v_ord.id, 'line_id', v_line_id,
      'warehouse_id', v_ord.warehouse_id, 'branch_id', v_ord.branch_id,
      'actor_id', auth.uid(), 'occurred_at', now(),
      'extra', v_result
    )
  );

  PERFORM public._wms_client_scan_record(
    p_device_id, p_client_scan_id, 'wms_capture_return_line',
    v_result, v_ord.organization_id, v_ord.business_id, v_ord.warehouse_id
  );

  RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION public.wms_capture_return_line(uuid,uuid,numeric,numeric,uuid,text,text,text,public.wms_return_condition,text,text,text,uuid,numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_capture_return_line(uuid,uuid,numeric,numeric,uuid,text,text,text,public.wms_return_condition,text,text,text,uuid,numeric) TO authenticated, service_role;

-- ------------------------------------------------------------------
-- Count capture — packaging aware.
-- ------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.record_count(uuid,numeric,text,text,text[],date);

CREATE OR REPLACE FUNCTION public.record_count(
  p_line_id uuid,
  p_counted_qty numeric,
  p_note text DEFAULT NULL,
  p_variance_reason text DEFAULT NULL,
  p_serial_numbers text[] DEFAULT NULL,
  p_expiry_date date DEFAULT NULL,
  p_packaging_id uuid DEFAULT NULL,
  p_entered_qty numeric DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_line record;
  v_session record;
  v_outcome text;
  v_variance numeric;
  v_entered numeric;
  v_base numeric;
  v_uom text;
BEGIN
  SELECT * INTO v_line FROM public.wms_count_lines WHERE id = p_line_id;
  IF v_line.id IS NULL THEN RAISE EXCEPTION 'count line % not found', p_line_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_line.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;

  v_entered := COALESCE(p_entered_qty, p_counted_qty);
  IF p_packaging_id IS NOT NULL THEN
    v_base := public.wms_to_base_qty(v_line.product_id, p_packaging_id, v_entered);
    v_uom  := public.wms_packaging_label(p_packaging_id);
  ELSE
    v_base := p_counted_qty;
  END IF;

  IF v_base IS NULL OR v_base < 0 THEN RAISE EXCEPTION 'counted qty must be >= 0' USING ERRCODE = '22023'; END IF;

  SELECT * INTO v_session FROM public.wms_count_sessions WHERE id = v_line.session_id;
  IF v_session.state NOT IN ('draft','counting','review') THEN
    RAISE EXCEPTION 'session in state % cannot be counted', v_session.state;
  END IF;

  v_variance := v_base - v_line.system_qty;

  v_outcome := public.evaluate_count_tolerance(
    v_line.business_id, v_session.warehouse_id, v_line.product_id,
    v_line.system_qty, v_base
  );

  UPDATE public.wms_count_lines
     SET counted_qty = v_base,
         entered_qty = v_entered,
         entered_uom = COALESCE(v_uom, entered_uom),
         packaging_id = COALESCE(p_packaging_id, packaging_id),
         variance_qty = v_variance,
         note = COALESCE(p_note, note),
         variance_reason = CASE
           WHEN p_variance_reason IS NULL THEN variance_reason
           ELSE p_variance_reason::public.wms_count_variance_reason END,
         serial_numbers = COALESCE(p_serial_numbers, serial_numbers),
         expiry_date = COALESCE(p_expiry_date, expiry_date),
         tolerance_outcome = v_outcome,
         counted_by = auth.uid(),
         counted_at = now()
   WHERE id = p_line_id;

  BEGIN
    INSERT INTO public.business_event_outbox (
      org_id, branch_id, warehouse_id, event_type,
      source_doc_type, source_doc_id, payload, idempotency_key, status, actor_user_id
    ) VALUES (
      v_session.organization_id, v_session.branch_id, v_session.warehouse_id,
      'warehouse.count.recorded',
      'wms_count_line', p_line_id,
      jsonb_build_object(
        'line_id', p_line_id,
        'session_id', v_line.session_id,
        'business_id', v_line.business_id,
        'counted_qty', v_base,
        'entered_qty', v_entered,
        'packaging_id', p_packaging_id,
        'variance_qty', v_variance,
        'tolerance_outcome', v_outcome
      ),
      'wms.count.recorded:' || p_line_id::text || ':' || extract(epoch from now())::text,
      'pending', auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'wms count recorded outbox emit failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object(
    'line_id', p_line_id,
    'counted_qty', v_base,
    'entered_qty', v_entered,
    'tolerance_outcome', v_outcome,
    'variance_qty', CASE WHEN v_session.is_blind THEN NULL ELSE v_variance END,
    'blind', v_session.is_blind
  );
END $$;

REVOKE ALL ON FUNCTION public.record_count(uuid,numeric,text,text,text[],date,uuid,numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_count(uuid,numeric,text,text,text[],date,uuid,numeric) TO authenticated, service_role;

-- ------------------------------------------------------------------
-- Replay dispatcher — forward the new packaging arguments.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_replay_guarded_call(
  p_rpc text,
  p_args jsonb,
  p_client_scan_id text DEFAULT NULL,
  p_device_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_prior     jsonb;
  v_result    jsonb;
  v_business  uuid;
  v_org       uuid;
  v_warehouse uuid;
BEGIN
  IF p_rpc IS NULL OR length(p_rpc) = 0 THEN
    RAISE EXCEPTION 'WMS_REPLAY_BAD_RPC: rpc name required';
  END IF;
  p_args := COALESCE(p_args, '{}'::jsonb);

  v_prior := public._wms_client_scan_lookup(p_device_id, p_client_scan_id);
  IF v_prior IS NOT NULL THEN
    RETURN jsonb_build_object('replayed', true, 'rpc', p_rpc, 'result', v_prior);
  END IF;

  CASE p_rpc

    WHEN 'wms_capture_receiving_line' THEN
      v_result := public.wms_capture_receiving_line(
        (p_args->>'p_session_id')::uuid,
        (p_args->>'p_product_id')::uuid,
        (p_args->>'p_received_qty')::numeric,
        NULLIF(p_args->>'p_expected_qty','')::numeric,
        NULLIF(p_args->>'p_lpn_id','')::uuid,
        NULLIF(p_args->>'p_lot_number',''),
        NULLIF(p_args->>'p_serial_number',''),
        NULLIF(p_args->>'p_uom',''),
        NULLIF(p_args->>'p_staging_location_id','')::uuid,
        NULLIF(p_args->>'p_notes',''),
        p_client_scan_id,
        p_device_id,
        NULLIF(p_args->>'p_expiry_date','')::date,
        COALESCE((p_args->>'p_damaged_qty')::numeric, 0),
        COALESCE((p_args->>'p_qc_hold')::boolean, false),
        NULLIF(p_args->>'p_packaging_id','')::uuid,
        NULLIF(p_args->>'p_entered_qty','')::numeric,
        NULLIF(p_args->>'p_entered_damaged_qty','')::numeric
      );

    WHEN 'wms_capture_return_line' THEN
      v_result := public.wms_capture_return_line(
        (p_args->>'p_return_id')::uuid,
        (p_args->>'p_product_id')::uuid,
        (p_args->>'p_received_qty')::numeric,
        NULLIF(p_args->>'p_expected_qty','')::numeric,
        NULLIF(p_args->>'p_lpn_id','')::uuid,
        NULLIF(p_args->>'p_lot_number',''),
        NULLIF(p_args->>'p_serial_number',''),
        NULLIF(p_args->>'p_uom',''),
        NULLIF(p_args->>'p_condition_code','')::public.wms_return_condition,
        NULLIF(p_args->>'p_notes',''),
        p_client_scan_id,
        p_device_id,
        NULLIF(p_args->>'p_packaging_id','')::uuid,
        NULLIF(p_args->>'p_entered_qty','')::numeric
      );

    WHEN 'wms_inspect_return_line' THEN
      v_result := public.wms_inspect_return_line(
        (p_args->>'p_line_id')::uuid,
        (p_args->>'p_row_version')::integer,
        (p_args->>'p_inspection_state')::public.wms_return_line_inspection_state,
        NULLIF(p_args->>'p_condition_code','')::public.wms_return_condition,
        COALESCE(p_args->'p_checks', NULL),
        NULLIF(p_args->>'p_notes','')
      );

    WHEN 'wms_disposition_return_line' THEN
      v_result := public.wms_disposition_return_line(
        (p_args->>'p_line_id')::uuid,
        (p_args->>'p_row_version')::integer,
        NULLIF(p_args->>'p_disposition','')::public.wms_return_disposition,
        NULLIF(p_args->>'p_restock_qty','')::numeric,
        COALESCE((p_args->>'p_quarantine_qty')::numeric, 0),
        COALESCE((p_args->>'p_scrap_qty')::numeric, 0),
        NULLIF(p_args->>'p_destination_location_id','')::uuid,
        NULLIF(p_args->>'p_notes','')
      );

    WHEN 'complete_pick_task' THEN
      v_result := public.complete_pick_task(
        (p_args->>'p_task_id')::uuid,
        (p_args->>'p_picked_qty')::numeric,
        NULLIF(p_args->>'p_lpn_id','')::uuid
      );
      SELECT t.business_id, t.organization_id, t.warehouse_id
        INTO v_business, v_org, v_warehouse
        FROM public.wms_tasks t WHERE t.id = (p_args->>'p_task_id')::uuid;

    WHEN 'complete_putaway_task' THEN
      v_result := public.complete_putaway_task(
        (p_args->>'p_task_id')::uuid,
        NULLIF(p_args->>'p_location_id','')::uuid,
        NULLIF(p_args->>'p_override_reason','')
      );
      SELECT t.business_id, t.organization_id, t.warehouse_id
        INTO v_business, v_org, v_warehouse
        FROM public.wms_tasks t WHERE t.id = (p_args->>'p_task_id')::uuid;

    WHEN 'wms_split_putaway_task' THEN
      v_result := public.wms_split_putaway_task(
        (p_args->>'p_task_id')::uuid,
        (p_args->>'p_quantity')::numeric,
        NULLIF(p_args->>'p_location_id','')::uuid,
        NULLIF(p_args->>'p_reason','')
      );
      SELECT t.business_id, t.organization_id, t.warehouse_id
        INTO v_business, v_org, v_warehouse
        FROM public.wms_tasks t WHERE t.id = (p_args->>'p_task_id')::uuid;

    WHEN 'wms_report_putaway_exception' THEN
      v_result := public.wms_report_putaway_exception(
        (p_args->>'p_task_id')::uuid,
        (p_args->>'p_kind')::public.wms_exception_kind,
        p_args->>'p_reason',
        COALESCE(p_args->'p_details', '{}'::jsonb)
      );
      SELECT t.business_id, t.organization_id, t.warehouse_id
        INTO v_business, v_org, v_warehouse
        FROM public.wms_tasks t WHERE t.id = (p_args->>'p_task_id')::uuid;

    WHEN 'complete_pack_task' THEN
      v_result := public.complete_pack_task((p_args->>'p_task_id')::uuid);
      SELECT t.business_id, t.organization_id, t.warehouse_id
        INTO v_business, v_org, v_warehouse
        FROM public.wms_tasks t WHERE t.id = (p_args->>'p_task_id')::uuid;

    WHEN 'wms_lpn_set_packaging' THEN
      v_result := public._wms_replay_lpn_set_packaging(p_args);

    WHEN 'wms_lpn_move' THEN
      v_result := public._wms_replay_lpn_move(p_args);

    WHEN 'open_pack_carton' THEN
      v_result := jsonb_build_object('carton_id', public.open_pack_carton(
        (p_args->>'p_wave_id')::uuid,
        (p_args->>'p_sales_order_id')::uuid,
        NULLIF(p_args->>'p_shipment_lpn_code','')
      ));

    WHEN 'suggest_packaging' THEN
      v_result := public.suggest_packaging(
        (p_args->>'p_business_id')::uuid,
        COALESCE(p_args->'p_lines', '[]'::jsonb),
        COALESCE(p_args->'p_options', '{}'::jsonb)
      );

    WHEN 'assign_packaging_to_pack' THEN
      v_result := to_jsonb(public.assign_packaging_to_pack(
        (p_args->>'p_carton_id')::uuid,
        NULLIF(p_args->>'p_packaging_type_id','')::uuid
      ));

    WHEN 'wms_sscc_allocate' THEN
      v_result := public.wms_sscc_allocate(
        (p_args->>'p_business_id')::uuid,
        (p_args->>'p_entity_type')::public.wms_sscc_entity,
        NULLIF(p_args->>'p_entity_id','')::uuid,
        COALESCE((p_args->>'p_count')::int, 1),
        COALESCE(p_args->'p_options', '{}'::jsonb)
      );

    WHEN 'wms_sscc_mark_printed' THEN
      v_result := to_jsonb(public.wms_sscc_mark_printed(
        (p_args->>'p_business_id')::uuid,
        p_args->>'p_sscc',
        COALESCE((p_args->>'p_copies')::int, 1),
        COALESCE((p_args->>'p_is_reprint')::boolean, false),
        NULLIF(p_args->>'p_reason',''),
        COALESCE(p_args->'p_payload', '{}'::jsonb)
      ));

    WHEN 'assign_line_to_carton' THEN
      v_result := public.assign_line_to_carton(
        (p_args->>'p_carton_id')::uuid,
        (p_args->>'p_wave_line_id')::uuid,
        (p_args->>'p_qty')::numeric
      );

    WHEN 'seal_pack_carton' THEN
      v_result := public.seal_pack_carton(
        (p_args->>'p_carton_id')::uuid,
        NULLIF(p_args->>'p_weight_kg','')::numeric,
        COALESCE(p_args->'p_dims', 'null'::jsonb)
      );

    WHEN 'record_count' THEN
      v_result := public.record_count(
        (p_args->>'p_line_id')::uuid,
        (p_args->>'p_counted_qty')::numeric,
        NULLIF(p_args->>'p_note',''),
        NULLIF(p_args->>'p_variance_reason',''),
        NULL,
        NULLIF(p_args->>'p_expiry_date','')::date,
        NULLIF(p_args->>'p_packaging_id','')::uuid,
        NULLIF(p_args->>'p_entered_qty','')::numeric
      );

    WHEN 'post_count_session' THEN
      v_result := public.post_count_session((p_args->>'p_session_id')::uuid);

    WHEN 'create_pick_wave' THEN
      v_result := public.create_pick_wave(
        (p_args->>'p_warehouse_id')::uuid,
        ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_args->'p_sales_order_ids','[]'::jsonb)))::uuid[],
        NULLIF(p_args->>'p_notes','')
      );

    WHEN 'release_pick_wave' THEN
      v_result := public.release_pick_wave((p_args->>'p_wave_id')::uuid);

    WHEN 'load_carton_onto_manifest' THEN
      v_result := jsonb_build_object('manifest_carton_id', public.load_carton_onto_manifest(
        (p_args->>'p_manifest_id')::uuid,
        (p_args->>'p_carton_id')::uuid
      ));

    WHEN 'close_loading_manifest' THEN
      PERFORM public.close_loading_manifest((p_args->>'p_manifest_id')::uuid);
      v_result := jsonb_build_object('manifest_id', p_args->>'p_manifest_id', 'closed', true);

    WHEN 'dispatch_loading_manifest' THEN
      v_result := public.dispatch_loading_manifest(
        (p_args->>'p_manifest_id')::uuid,
        NULLIF(p_args->>'p_departure_at','')::timestamptz
      );

    WHEN 'accept_qc_inspection' THEN
      v_result := to_jsonb(public.accept_qc_inspection(
        (p_args->>'p_inspection_id')::uuid,
        NULLIF(p_args->>'p_accepted_qty','')::numeric,
        NULLIF(p_args->>'p_notes','')
      ));

    WHEN 'reject_qc_inspection' THEN
      v_result := to_jsonb(public.reject_qc_inspection(
        (p_args->>'p_inspection_id')::uuid,
        NULLIF(p_args->>'p_rejected_qty','')::numeric,
        NULLIF(p_args->>'p_disposition',''),
        NULLIF(p_args->>'p_notes','')
      ));

    WHEN 'cancel_qc_inspection' THEN
      v_result := to_jsonb(public.cancel_qc_inspection(
        (p_args->>'p_inspection_id')::uuid,
        NULLIF(p_args->>'p_reason','')
      ));

    ELSE
      RAISE EXCEPTION 'WMS_REPLAY_UNSUPPORTED_RPC: % is not replay-whitelisted', p_rpc;
  END CASE;

  v_result := COALESCE(v_result, '{}'::jsonb);

  IF v_business IS NULL THEN
    v_business := NULLIF(v_result->>'business_id','')::uuid;
    v_org       := COALESCE(v_org, NULLIF(v_result->>'organization_id','')::uuid);
    v_warehouse := COALESCE(v_warehouse, NULLIF(v_result->>'warehouse_id','')::uuid);
  END IF;

  PERFORM public._wms_client_scan_record(
    p_device_id, p_client_scan_id, p_rpc, v_result, v_org, v_business, v_warehouse
  );

  RETURN jsonb_build_object('replayed', false, 'rpc', p_rpc, 'result', v_result);
END $$;

REVOKE ALL ON FUNCTION public.wms_replay_guarded_call(text,jsonb,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_replay_guarded_call(text,jsonb,text,text) TO authenticated, service_role;