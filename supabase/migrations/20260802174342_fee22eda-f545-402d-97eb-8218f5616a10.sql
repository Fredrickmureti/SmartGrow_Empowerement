-- 1. Receiving line enrichment -------------------------------------------------
ALTER TABLE public.wms_receiving_lines
  ADD COLUMN IF NOT EXISTS expiry_date date,
  ADD COLUMN IF NOT EXISTS damaged_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS qc_hold boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS line_state text NOT NULL DEFAULT 'expected',
  ADD COLUMN IF NOT EXISTS purchase_order_item_id uuid REFERENCES public.purchase_order_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS inbound_shipment_item_id uuid REFERENCES public.inbound_shipment_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS wms_receiving_lines_session_idx
  ON public.wms_receiving_lines (session_id);
CREATE INDEX IF NOT EXISTS wms_receiving_lines_session_product_idx
  ON public.wms_receiving_lines (session_id, product_id);

-- 2. Expected-line materialisation --------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_materialize_expected_lines(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_sess public.wms_receiving_sessions%ROWTYPE;
  v_created int := 0;
BEGIN
  SELECT * INTO v_sess FROM public.wms_receiving_sessions WHERE id = p_session_id;
  IF v_sess.id IS NULL THEN RAISE EXCEPTION 'receiving session % not found', p_session_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_sess.business_id) THEN
    RAISE EXCEPTION 'access denied';
  END IF;

  IF v_sess.source_doc_id IS NULL THEN
    RETURN jsonb_build_object('created', 0, 'reason', 'no source document bound');
  END IF;

  IF v_sess.source_doc_type = 'purchase_order' THEN
    INSERT INTO public.wms_receiving_lines (
      session_id, organization_id, business_id, warehouse_id,
      product_id, purchase_order_item_id, expected_qty, received_qty, line_state
    )
    SELECT v_sess.id, v_sess.organization_id, v_sess.business_id, v_sess.warehouse_id,
           poi.product_id, poi.id,
           GREATEST(COALESCE(poi.quantity, 0) - COALESCE(poi.quantity_received, 0), 0),
           0, 'expected'
      FROM public.purchase_order_items poi
     WHERE poi.purchase_order_id = v_sess.source_doc_id
       AND poi.product_id IS NOT NULL
       AND GREATEST(COALESCE(poi.quantity, 0) - COALESCE(poi.quantity_received, 0), 0) > 0
       AND NOT EXISTS (
         SELECT 1 FROM public.wms_receiving_lines l
          WHERE l.session_id = v_sess.id AND l.purchase_order_item_id = poi.id
       );
    v_created := ROW_COUNT_HACK();
  ELSIF v_sess.source_doc_type = 'inbound_shipment' THEN
    INSERT INTO public.wms_receiving_lines (
      session_id, organization_id, business_id, warehouse_id,
      product_id, inbound_shipment_item_id, purchase_order_item_id,
      lot_number, expiry_date, expected_qty, received_qty, line_state
    )
    SELECT v_sess.id, v_sess.organization_id, v_sess.business_id, v_sess.warehouse_id,
           isi.product_id, isi.id, isi.purchase_order_item_id,
           isi.expected_lot_number, isi.expected_expiry_date,
           COALESCE(isi.expected_quantity, 0), 0, 'expected'
      FROM public.inbound_shipment_items isi
     WHERE isi.shipment_id = v_sess.source_doc_id
       AND isi.product_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.wms_receiving_lines l
          WHERE l.session_id = v_sess.id AND l.inbound_shipment_item_id = isi.id
       );
    v_created := ROW_COUNT_HACK();
  ELSE
    RETURN jsonb_build_object('created', 0, 'reason', 'unsupported source_doc_type');
  END IF;

  RETURN jsonb_build_object('created', v_created);
END $function$;

-- helper so the two branches above can report inserted counts
CREATE OR REPLACE FUNCTION public.ROW_COUNT_HACK() RETURNS int
LANGUAGE plpgsql AS $function$
DECLARE v int; BEGIN GET DIAGNOSTICS v = ROW_COUNT; RETURN v; END $function$;

-- 3. Capture: fill the expected line when one exists --------------------------
CREATE OR REPLACE FUNCTION public.wms_capture_receiving_line(
  p_session_id uuid,
  p_product_id uuid,
  p_received_qty numeric,
  p_expected_qty numeric DEFAULT NULL::numeric,
  p_lpn_id uuid DEFAULT NULL::uuid,
  p_lot_number text DEFAULT NULL::text,
  p_serial_number text DEFAULT NULL::text,
  p_uom text DEFAULT NULL::text,
  p_staging_location_id uuid DEFAULT NULL::uuid,
  p_notes text DEFAULT NULL::text,
  p_client_scan_id text DEFAULT NULL::text,
  p_device_id text DEFAULT NULL::text,
  p_expiry_date date DEFAULT NULL::date,
  p_damaged_qty numeric DEFAULT 0,
  p_qc_hold boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_prior jsonb;
  v_sess public.wms_receiving_sessions%ROWTYPE;
  v_line_id uuid;
  v_unexpected boolean := false;
  v_result jsonb;
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
  IF p_received_qty IS NULL OR p_received_qty < 0 THEN
    RAISE EXCEPTION 'received_qty must be >= 0';
  END IF;

  -- Prefer an untouched expected line for this product (and lot when given).
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
      received_qty        = COALESCE(received_qty, 0) + p_received_qty,
      damaged_qty         = COALESCE(damaged_qty, 0) + COALESCE(p_damaged_qty, 0),
      qc_hold             = qc_hold OR COALESCE(p_qc_hold, false),
      lot_number          = COALESCE(p_lot_number, lot_number),
      serial_number       = COALESCE(p_serial_number, serial_number),
      expiry_date         = COALESCE(p_expiry_date, expiry_date),
      uom                 = COALESCE(p_uom, uom),
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
      staging_location_id, captured_by, captured_at, notes, line_state
    ) VALUES (
      v_sess.id, v_sess.organization_id, v_sess.business_id, v_sess.warehouse_id,
      p_product_id, p_lpn_id, p_lot_number, p_serial_number, p_expiry_date,
      COALESCE(p_expected_qty, 0), p_received_qty, COALESCE(p_damaged_qty, 0),
      COALESCE(p_qc_hold, false), p_uom,
      p_staging_location_id, auth.uid(), now(), p_notes, 'unexpected'
    ) RETURNING id INTO v_line_id;
  END IF;

  v_result := jsonb_build_object(
    'line_id', v_line_id,
    'session_id', v_sess.id,
    'received_qty', p_received_qty,
    'unexpected', v_unexpected,
    'replayed', false
  );

  PERFORM public._wms_client_scan_record(
    p_device_id, p_client_scan_id, 'wms_capture_receiving_line',
    v_result, v_sess.organization_id, v_sess.business_id, v_sess.warehouse_id
  );

  RETURN v_result;
END $function$;

-- 4. Session progress ----------------------------------------------------------
CREATE OR REPLACE VIEW public.wms_receiving_session_progress
WITH (security_invoker = true) AS
SELECT
  s.id                                                     AS session_id,
  s.business_id,
  s.warehouse_id,
  s.state,
  count(l.id)                                              AS line_count,
  count(l.id) FILTER (WHERE l.line_state <> 'expected')    AS captured_lines,
  COALESCE(sum(l.expected_qty), 0)                         AS expected_qty,
  COALESCE(sum(l.received_qty), 0)                          AS received_qty,
  COALESCE(sum(l.damaged_qty), 0)                           AS damaged_qty,
  count(l.id) FILTER (WHERE l.line_state = 'unexpected')    AS unexpected_lines,
  count(l.id) FILTER (WHERE l.line_state <> 'expected' AND l.received_qty < l.expected_qty) AS short_lines,
  count(l.id) FILTER (WHERE l.received_qty > l.expected_qty)  AS over_lines,
  count(l.id) FILTER (WHERE l.qc_hold)                        AS hold_lines,
  count(l.id) FILTER (WHERE l.damaged_qty > 0)                AS damaged_lines
FROM public.wms_receiving_sessions s
LEFT JOIN public.wms_receiving_lines l ON l.session_id = s.id
GROUP BY s.id, s.business_id, s.warehouse_id, s.state;

GRANT SELECT ON public.wms_receiving_session_progress TO authenticated;

-- 5. Variance → exceptions -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_flag_receiving_variances(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_sess public.wms_receiving_sessions%ROWTYPE;
  v_line RECORD;
  v_raised int := 0;
  v_kind wms_exception_kind;
  v_reason text;
BEGIN
  SELECT * INTO v_sess FROM public.wms_receiving_sessions WHERE id = p_session_id;
  IF v_sess.id IS NULL THEN RAISE EXCEPTION 'receiving session % not found', p_session_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_sess.business_id) THEN
    RAISE EXCEPTION 'access denied';
  END IF;

  FOR v_line IN
    SELECT l.*, p.name AS product_name
      FROM public.wms_receiving_lines l
      LEFT JOIN public.products p ON p.id = l.product_id
     WHERE l.session_id = v_sess.id
  LOOP
    v_kind := NULL;
    IF v_line.line_state = 'unexpected' THEN
      v_kind := 'unknown_scan';
      v_reason := format('Unexpected item on %s: %s x%s', v_sess.code, COALESCE(v_line.product_name,'item'), v_line.received_qty);
    ELSIF v_line.qc_hold THEN
      v_kind := 'qc_fail';
      v_reason := format('Quality hold on %s: %s', v_sess.code, COALESCE(v_line.product_name,'item'));
    ELSIF COALESCE(v_line.damaged_qty,0) > 0 THEN
      v_kind := 'damaged_lpn';
      v_reason := format('Damage on %s: %s x%s', v_sess.code, COALESCE(v_line.product_name,'item'), v_line.damaged_qty);
    ELSIF v_line.line_state <> 'expected' AND v_line.received_qty <> v_line.expected_qty THEN
      v_kind := 'receiving_discrepancy';
      v_reason := format('%s on %s: %s expected %s, received %s',
        CASE WHEN v_line.received_qty < v_line.expected_qty THEN 'Shortage' ELSE 'Overage' END,
        v_sess.code, COALESCE(v_line.product_name,'item'), v_line.expected_qty, v_line.received_qty);
    END IF;

    IF v_kind IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.wms_exceptions e
       WHERE e.aggregate_type = 'receiving_line'
         AND e.aggregate_id = v_line.id
         AND e.kind = v_kind
         AND e.state NOT IN ('resolved','wont_fix')
    ) THEN
      INSERT INTO public.wms_exceptions (
        organization_id, business_id, branch_id, warehouse_id,
        kind, severity, aggregate_type, aggregate_id, lpn_id, reason, details, raised_by
      ) VALUES (
        v_sess.organization_id, v_sess.business_id, v_sess.branch_id, v_sess.warehouse_id,
        v_kind,
        CASE WHEN v_kind = 'qc_fail' THEN 3 ELSE 2 END,
        'receiving_line', v_line.id, v_line.lpn_id, v_reason,
        jsonb_build_object(
          'session_id', v_sess.id,
          'session_code', v_sess.code,
          'product_id', v_line.product_id,
          'expected_qty', v_line.expected_qty,
          'received_qty', v_line.received_qty,
          'damaged_qty', v_line.damaged_qty
        ),
        auth.uid()
      );
      v_raised := v_raised + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('raised', v_raised);
END $function$;

-- 6. Post once -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_post_receiving_session(
  p_session_id uuid,
  p_row_version integer,
  p_staging_location_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_sess public.wms_receiving_sessions%ROWTYPE;
  v_lines jsonb;
  v_gr jsonb;
  v_staged jsonb := NULL;
  v_staging uuid := p_staging_location_id;
BEGIN
  SELECT * INTO v_sess FROM public.wms_receiving_sessions WHERE id = p_session_id;
  IF v_sess.id IS NULL THEN RAISE EXCEPTION 'receiving session % not found', p_session_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_sess.business_id) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF v_sess.state NOT IN ('captured','discrepant') THEN
    RAISE EXCEPTION 'session must be captured or discrepant before posting (is %)', v_sess.state;
  END IF;
  IF v_sess.source_doc_type <> 'purchase_order' OR v_sess.source_doc_id IS NULL THEN
    RAISE EXCEPTION 'only purchase-order sessions can post to inventory from the warehouse';
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'purchase_order_item_id', l.purchase_order_item_id,
           'product_id',             l.product_id,
           'quantity_received',      l.received_qty,
           'lot_number',             l.lot_number,
           'serial_number',          l.serial_number,
           'notes',                  l.notes
         ))
    INTO v_lines
    FROM public.wms_receiving_lines l
   WHERE l.session_id = v_sess.id
     AND l.received_qty > 0
     AND l.purchase_order_item_id IS NOT NULL;

  IF v_lines IS NULL OR jsonb_array_length(v_lines) = 0 THEN
    RAISE EXCEPTION 'nothing captured against purchase-order lines — scan before posting';
  END IF;

  v_gr := public.create_goods_receipt(
    v_sess.business_id, v_sess.source_doc_id, v_lines, auth.uid(), v_sess.warehouse_id
  );
  IF NOT COALESCE((v_gr->>'success')::boolean, false) THEN
    RAISE EXCEPTION 'goods receipt failed: %', COALESCE(v_gr->>'error','unknown');
  END IF;

  IF v_staging IS NULL THEN
    SELECT id INTO v_staging FROM public.stock_locations
     WHERE warehouse_id = v_sess.warehouse_id AND is_active
     ORDER BY is_receiving_staging DESC NULLS LAST, is_default DESC NULLS LAST, code
     LIMIT 1;
  END IF;

  IF v_staging IS NOT NULL THEN
    v_staged := public.receive_goods_to_wms((v_gr->>'goods_receipt_id')::uuid, v_staging);
  END IF;

  PERFORM public.wms_flag_receiving_variances(v_sess.id);
  PERFORM public.wms_transition_receiving(
    v_sess.id, 'posted'::wms_receiving_state, p_row_version, 'Posted from receiving workspace',
    jsonb_build_object('goods_receipt_id', v_gr->>'goods_receipt_id')
  );

  RETURN jsonb_build_object(
    'goods_receipt_id', v_gr->>'goods_receipt_id',
    'receipt_number',   v_gr->>'receipt_number',
    'staged',           v_staged
  );
END $function$;

GRANT EXECUTE ON FUNCTION public.wms_materialize_expected_lines(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wms_flag_receiving_variances(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wms_post_receiving_session(uuid, integer, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wms_capture_receiving_line(uuid, uuid, numeric, numeric, uuid, text, text, text, uuid, text, text, text, date, numeric, boolean) TO authenticated;