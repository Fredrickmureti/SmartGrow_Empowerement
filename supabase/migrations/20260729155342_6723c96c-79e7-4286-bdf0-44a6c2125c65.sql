-- ============================================================
-- Phase 3.8 · Offline scan replay idempotency
-- ============================================================

-- 1. Ledger table ---------------------------------------------
CREATE TABLE IF NOT EXISTS public.wms_client_scan_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id text NOT NULL,
  client_scan_id text NOT NULL,
  rpc_name text NOT NULL,
  actor_user_id uuid,
  organization_id uuid,
  business_id uuid,
  warehouse_id uuid,
  rpc_result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_wms_client_scan_receipts_device_key
  ON public.wms_client_scan_receipts (device_id, client_scan_id);

CREATE INDEX IF NOT EXISTS idx_wms_client_scan_receipts_business
  ON public.wms_client_scan_receipts (business_id, created_at DESC);

GRANT SELECT ON public.wms_client_scan_receipts TO authenticated;
GRANT ALL    ON public.wms_client_scan_receipts TO service_role;

ALTER TABLE public.wms_client_scan_receipts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wms_client_scan_receipts read" ON public.wms_client_scan_receipts;
CREATE POLICY "wms_client_scan_receipts read"
  ON public.wms_client_scan_receipts FOR SELECT TO authenticated
  USING (
    business_id IS NULL
    OR EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = wms_client_scan_receipts.business_id)
  );
-- No INSERT / UPDATE / DELETE policies: only SECURITY DEFINER RPCs write.

COMMENT ON TABLE public.wms_client_scan_receipts IS
  'Idempotency ledger for offline mobile scan replays. Unique on (device_id, client_scan_id). Written only by SECURITY DEFINER wrappers (wms_capture_receiving_line, wms_complete_pick_scan, …).';

-- 2. Internal helper: lock + lookup ---------------------------
CREATE OR REPLACE FUNCTION public._wms_client_scan_lookup(
  p_device_id text,
  p_client_scan_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_prior jsonb;
BEGIN
  IF p_device_id IS NULL OR p_client_scan_id IS NULL
     OR length(p_device_id) = 0 OR length(p_client_scan_id) = 0 THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_device_id || ':' || p_client_scan_id, 0));
  SELECT rpc_result INTO v_prior
    FROM public.wms_client_scan_receipts
   WHERE device_id = p_device_id AND client_scan_id = p_client_scan_id;
  RETURN v_prior;
END $$;

REVOKE ALL ON FUNCTION public._wms_client_scan_lookup(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._wms_client_scan_lookup(text, text) TO service_role;

-- 3. Internal helper: record receipt --------------------------
CREATE OR REPLACE FUNCTION public._wms_client_scan_record(
  p_device_id text,
  p_client_scan_id text,
  p_rpc_name text,
  p_result jsonb,
  p_organization_id uuid,
  p_business_id uuid,
  p_warehouse_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF p_device_id IS NULL OR p_client_scan_id IS NULL
     OR length(p_device_id) = 0 OR length(p_client_scan_id) = 0 THEN
    RETURN;
  END IF;
  INSERT INTO public.wms_client_scan_receipts (
    device_id, client_scan_id, rpc_name, actor_user_id,
    organization_id, business_id, warehouse_id, rpc_result
  ) VALUES (
    p_device_id, p_client_scan_id, p_rpc_name, auth.uid(),
    p_organization_id, p_business_id, p_warehouse_id, p_result
  )
  ON CONFLICT (device_id, client_scan_id) DO NOTHING;
END $$;

REVOKE ALL ON FUNCTION public._wms_client_scan_record(text, text, text, jsonb, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._wms_client_scan_record(text, text, text, jsonb, uuid, uuid, uuid) TO service_role;

-- 4. Public RPC: wms_capture_receiving_line -------------------
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
  p_device_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_prior jsonb;
  v_sess public.wms_receiving_sessions%ROWTYPE;
  v_line_id uuid;
  v_result jsonb;
BEGIN
  -- Replay short-circuit
  v_prior := public._wms_client_scan_lookup(p_device_id, p_client_scan_id);
  IF v_prior IS NOT NULL THEN
    RETURN v_prior || jsonb_build_object('replayed', true);
  END IF;

  SELECT * INTO v_sess FROM public.wms_receiving_sessions WHERE id = p_session_id;
  IF v_sess.id IS NULL THEN RAISE EXCEPTION 'receiving session % not found', p_session_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_sess.business_id) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF p_received_qty IS NULL OR p_received_qty < 0 THEN
    RAISE EXCEPTION 'received_qty must be >= 0';
  END IF;

  INSERT INTO public.wms_receiving_lines (
    session_id, organization_id, business_id, warehouse_id,
    product_id, lpn_id, lot_number, serial_number,
    expected_qty, received_qty, uom, staging_location_id,
    captured_by, captured_at, notes
  ) VALUES (
    v_sess.id, v_sess.organization_id, v_sess.business_id, v_sess.warehouse_id,
    p_product_id, p_lpn_id, p_lot_number, p_serial_number,
    p_expected_qty, p_received_qty, p_uom, p_staging_location_id,
    auth.uid(), now(), p_notes
  ) RETURNING id INTO v_line_id;

  v_result := jsonb_build_object(
    'line_id', v_line_id,
    'session_id', v_sess.id,
    'received_qty', p_received_qty,
    'replayed', false
  );

  PERFORM public._wms_client_scan_record(
    p_device_id, p_client_scan_id, 'wms_capture_receiving_line',
    v_result, v_sess.organization_id, v_sess.business_id, v_sess.warehouse_id
  );

  RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION public.wms_capture_receiving_line(uuid, uuid, numeric, numeric, uuid, text, text, text, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_capture_receiving_line(uuid, uuid, numeric, numeric, uuid, text, text, text, uuid, text, text, text) TO authenticated, service_role;

-- 5. Public RPC: wms_complete_pick_scan -----------------------
CREATE OR REPLACE FUNCTION public.wms_complete_pick_scan(
  p_task_id uuid,
  p_picked_qty numeric,
  p_lpn_id uuid DEFAULT NULL,
  p_client_scan_id text DEFAULT NULL,
  p_device_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_prior jsonb;
  v_task public.wms_tasks%ROWTYPE;
  v_result jsonb;
BEGIN
  v_prior := public._wms_client_scan_lookup(p_device_id, p_client_scan_id);
  IF v_prior IS NOT NULL THEN
    RETURN v_prior || jsonb_build_object('replayed', true);
  END IF;

  SELECT * INTO v_task FROM public.wms_tasks WHERE id = p_task_id;
  IF v_task.id IS NULL THEN RAISE EXCEPTION 'task % not found', p_task_id; END IF;

  v_result := public.complete_pick_task(p_task_id, p_picked_qty, p_lpn_id);
  v_result := COALESCE(v_result, '{}'::jsonb) || jsonb_build_object('replayed', false);

  PERFORM public._wms_client_scan_record(
    p_device_id, p_client_scan_id, 'wms_complete_pick_scan',
    v_result, v_task.organization_id, v_task.business_id, v_task.warehouse_id
  );

  RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION public.wms_complete_pick_scan(uuid, numeric, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_complete_pick_scan(uuid, numeric, uuid, text, text) TO authenticated, service_role;