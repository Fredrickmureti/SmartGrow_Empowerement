-- Drop the stale 12-argument overload of wms_capture_receiving_line.
DROP FUNCTION IF EXISTS public.wms_capture_receiving_line(
  uuid, uuid, numeric, numeric, uuid, text, text, text, uuid, text, text, text
);

CREATE OR REPLACE FUNCTION public.wms_post_receiving_session(
  p_session_id uuid,
  p_row_version integer,
  p_staging_location_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_sess public.wms_receiving_sessions%ROWTYPE;
  v_lines jsonb;
  v_gr jsonb;
  v_staged jsonb := NULL;
  v_staging uuid := p_staging_location_id;
  v_quarantine uuid;
  v_held integer := 0;
  v_src text;
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

  -- Quarantine destination for held / damaged goods (never posted to inventory).
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

  IF v_src = 'purchase_order' THEN
    -- Sound quantity only: held lines excluded, damaged units deducted.
    SELECT jsonb_agg(jsonb_build_object(
             'purchase_order_item_id', l.purchase_order_item_id,
             'product_id',             l.product_id,
             'quantity_received',      COALESCE(l.received_qty,0) - COALESCE(l.damaged_qty,0),
             'lot_number',             l.lot_number,
             'serial_number',          l.serial_number,
             'notes',                  l.notes
           ))
      INTO v_lines
      FROM public.wms_receiving_lines l
     WHERE l.session_id = v_sess.id
       AND NOT COALESCE(l.qc_hold, false)
       AND COALESCE(l.received_qty,0) - COALESCE(l.damaged_qty,0) > 0
       AND l.purchase_order_item_id IS NOT NULL;

    IF v_lines IS NULL OR jsonb_array_length(v_lines) = 0 THEN
      RAISE EXCEPTION 'nothing receivable against purchase-order lines — all captured quantity is held, damaged or unmatched';
    END IF;

    v_gr := public.create_goods_receipt(
      v_sess.business_id, v_sess.source_doc_id, v_lines, auth.uid(), v_sess.warehouse_id
    );
  ELSE
    SELECT jsonb_agg(jsonb_build_object(
             'shipment_item_id',  l.inbound_shipment_item_id,
             'quantity_received', COALESCE(l.received_qty,0) - COALESCE(l.damaged_qty,0),
             'lot_number',        l.lot_number,
             'serial_number',     l.serial_number,
             'notes',             l.notes
           ))
      INTO v_lines
      FROM public.wms_receiving_lines l
     WHERE l.session_id = v_sess.id
       AND NOT COALESCE(l.qc_hold, false)
       AND COALESCE(l.received_qty,0) - COALESCE(l.damaged_qty,0) > 0
       AND l.inbound_shipment_item_id IS NOT NULL;

    IF v_lines IS NULL OR jsonb_array_length(v_lines) = 0 THEN
      RAISE EXCEPTION 'nothing receivable against shipment lines — all captured quantity is held, damaged or unmatched';
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
    'quarantine_location_id', v_quarantine
  );
END
$fn$;