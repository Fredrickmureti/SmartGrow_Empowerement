-- ── Phase 11: capture is base-unit only ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.wms_capture_receiving_line(p_session_id uuid, p_product_id uuid, p_received_qty numeric, p_expected_qty numeric DEFAULT NULL::numeric, p_lpn_id uuid DEFAULT NULL::uuid, p_lot_number text DEFAULT NULL::text, p_serial_number text DEFAULT NULL::text, p_uom text DEFAULT NULL::text, p_staging_location_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_client_scan_id text DEFAULT NULL::text, p_device_id text DEFAULT NULL::text, p_expiry_date date DEFAULT NULL::date, p_damaged_qty numeric DEFAULT 0, p_qc_hold boolean DEFAULT false)
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
  v_pack_factor numeric;
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
  IF COALESCE(p_damaged_qty, 0) < 0 THEN
    RAISE EXCEPTION 'damaged_qty must be >= 0';
  END IF;
  IF COALESCE(p_damaged_qty, 0) > p_received_qty THEN
    RAISE EXCEPTION 'damaged_qty (%) cannot exceed received_qty (%)', p_damaged_qty, p_received_qty;
  END IF;

  -- Phase 11 — quantities crossing this seam are ALWAYS base units. p_uom is
  -- the operator-facing label the count was typed in (audit trail only). If it
  -- names a packaging level with a multiplier, the caller failed to convert.
  IF p_uom IS NOT NULL THEN
    SELECT MAX(pp.qty_in_base_uom) INTO v_pack_factor
      FROM public.product_packaging pp
     WHERE pp.product_id = p_product_id
       AND lower(pp.name) = lower(p_uom);
    IF COALESCE(v_pack_factor, 1) > 1 THEN
      RAISE EXCEPTION 'received_qty must be in base units; uom % is a packaging level of % base units — convert before capture', p_uom, v_pack_factor
        USING ERRCODE = '22023';
    END IF;
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

-- ── Phase 12: quarantined goods are on the books, just not available ─────
CREATE OR REPLACE FUNCTION public.wms_post_receiving_session(p_session_id uuid, p_row_version integer, p_staging_location_id uuid DEFAULT NULL::uuid)
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
  v_quarantine uuid;
  v_held integer := 0;
  v_moved integer := 0;
  v_src text;
  v_row RECORD;
BEGIN
  SELECT * INTO v_sess FROM public.wms_receiving_sessions WHERE id = p_session_id;
  IF v_sess.id IS NULL THEN RAISE EXCEPTION 'receiving session % not found', p_session_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_sess.business_id) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF v_sess.state NOT IN ('captured','discrepant') THEN
    RAISE EXCEPTION 'session must be captured or discrepant before posting (is %)', v_sess.state;
  END IF;

  v_src := lower(COALESCE(v_sess.source_doc_type, ''));
  IF v_sess.source_doc_id IS NULL
     OR v_src NOT IN ('purchase_order','inbound_shipment','asn') THEN
    RAISE EXCEPTION 'session must be bound to a purchase order or inbound shipment to post (source is %)',
      COALESCE(v_sess.source_doc_type, 'none');
  END IF;

  -- Quarantine destination for held / damaged goods.
  SELECT id INTO v_quarantine
    FROM public.stock_locations
   WHERE warehouse_id = v_sess.warehouse_id
     AND is_active
     AND location_type = 'quarantine'
   ORDER BY is_default DESC NULLS LAST, code
   LIMIT 1;

  UPDATE public.wms_receiving_lines l
     SET staging_location_id = COALESCE(v_quarantine, l.staging_location_id)
   WHERE l.session_id = v_sess.id
     AND (COALESCE(l.qc_hold, false) OR COALESCE(l.damaged_qty, 0) > 0);
  GET DIAGNOSTICS v_held = ROW_COUNT;

  -- Phase 12 — the receipt now carries the FULL captured quantity, including
  -- held and damaged units. Legally and financially those goods arrived; they
  -- are simply not available to sell. Excluding them made quarantined stock
  -- invisible to the ledger. Availability is expressed by LOCATION (quarantine
  -- bin) via the transfer movements emitted after staging, not by omission.
  IF v_src = 'purchase_order' THEN
    SELECT jsonb_agg(jsonb_build_object(
             'purchase_order_item_id', l.purchase_order_item_id,
             'product_id',             l.product_id,
             'quantity_received',      COALESCE(l.received_qty,0),
             'lot_number',             l.lot_number,
             'serial_number',          l.serial_number,
             'notes',                  l.notes
           ))
      INTO v_lines
      FROM public.wms_receiving_lines l
     WHERE l.session_id = v_sess.id
       AND COALESCE(l.received_qty,0) > 0
       AND l.purchase_order_item_id IS NOT NULL;

    IF v_lines IS NULL OR jsonb_array_length(v_lines) = 0 THEN
      RAISE EXCEPTION 'nothing receivable against purchase-order lines — no captured quantity is matched to a line';
    END IF;

    v_gr := public.create_goods_receipt(
      v_sess.business_id, v_sess.source_doc_id, v_lines, auth.uid(), v_sess.warehouse_id
    );
  ELSE
    SELECT jsonb_agg(jsonb_build_object(
             'shipment_item_id',  l.inbound_shipment_item_id,
             'quantity_received', COALESCE(l.received_qty,0),
             'lot_number',        l.lot_number,
             'serial_number',     l.serial_number,
             'notes',             l.notes
           ))
      INTO v_lines
      FROM public.wms_receiving_lines l
     WHERE l.session_id = v_sess.id
       AND COALESCE(l.received_qty,0) > 0
       AND l.inbound_shipment_item_id IS NOT NULL;

    IF v_lines IS NULL OR jsonb_array_length(v_lines) = 0 THEN
      RAISE EXCEPTION 'nothing receivable against shipment lines — no captured quantity is matched to a line';
    END IF;

    v_gr := public.receive_inbound_shipment(
      v_sess.source_doc_id, v_lines, auth.uid(), NULL, NULL
    );
  END IF;

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

  -- Move held / damaged quantity out of the receiving location into quarantine
  -- so it stops counting as available stock while remaining on the books.
  IF v_quarantine IS NOT NULL AND v_quarantine IS DISTINCT FROM v_staging THEN
    FOR v_row IN
      SELECT l.product_id,
             l.lot_number,
             CASE WHEN COALESCE(l.qc_hold, false)
                    THEN COALESCE(l.received_qty, 0)
                  ELSE COALESCE(l.damaged_qty, 0) END AS qty,
             COALESCE(l.qc_hold, false) AS held
        FROM public.wms_receiving_lines l
       WHERE l.session_id = v_sess.id
         AND (COALESCE(l.qc_hold, false) OR COALESCE(l.damaged_qty, 0) > 0)
         AND l.product_id IS NOT NULL
    LOOP
      CONTINUE WHEN COALESCE(v_row.qty, 0) <= 0;
      INSERT INTO public.stock_movements (
        organization_id, business_id, branch_id, warehouse_id,
        product_id, movement_type, quantity,
        reference_type, reference_id,
        lot_number, source_location_id, destination_location_id,
        movement_date, notes, is_sample_data
      ) VALUES (
        v_sess.organization_id, v_sess.business_id,
        COALESCE(v_sess.branch_id, (SELECT branch_id FROM public.warehouses WHERE id = v_sess.warehouse_id)),
        v_sess.warehouse_id,
        v_row.product_id, 'quarantine_hold', v_row.qty,
        'receiving_session', v_sess.id,
        v_row.lot_number, v_staging, v_quarantine,
        now(),
        CASE WHEN v_row.held THEN 'Auto: receiving QC hold' ELSE 'Auto: receiving damage hold' END,
        false
      );
      v_moved := v_moved + 1;
    END LOOP;
  END IF;

  PERFORM public.wms_flag_receiving_variances(v_sess.id);
  PERFORM public.wms_transition_receiving(
    v_sess.id, 'posted'::wms_receiving_state, p_row_version, 'Posted from receiving workspace',
    jsonb_build_object('goods_receipt_id', v_gr->>'goods_receipt_id')
  );

  RETURN jsonb_build_object(
    'goods_receipt_id',  v_gr->>'goods_receipt_id',
    'receipt_number',    v_gr->>'receipt_number',
    'staged',            v_staged,
    'quarantined_lines', v_held,
    'quarantine_movements', v_moved,
    'quarantine_location_id', v_quarantine
  );
END
$function$;

-- ── Phase 13: retire the legacy discrepancy list (0 rows; superseded by
--    wms_exceptions raised by wms_flag_receiving_variances) ───────────────
DO $do$
DECLARE
  v_def text;
BEGIN
  IF to_regclass('public.goods_receipt_discrepancies') IS NULL THEN
    RETURN;
  END IF;
  IF (SELECT count(*) FROM public.goods_receipt_discrepancies) > 0 THEN
    RAISE EXCEPTION 'goods_receipt_discrepancies is not empty — backfill into wms_exceptions before dropping';
  END IF;

  SELECT pg_get_functiondef('public.reset_module__inventory'::regproc) INTO v_def;
  v_def := replace(
    v_def,
    '  WITH d AS (DELETE FROM public.goods_receipt_discrepancies
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object(''goods_receipt_discrepancies'', n);

',
    '');
  IF v_def LIKE '%goods_receipt_discrepancies%' THEN
    RAISE EXCEPTION 'could not strip goods_receipt_discrepancies from reset_module__inventory';
  END IF;
  EXECUTE v_def;

  DROP TABLE public.goods_receipt_discrepancies;
END
$do$;