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
    GET DIAGNOSTICS v_created = ROW_COUNT;
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
    GET DIAGNOSTICS v_created = ROW_COUNT;
  ELSE
    RETURN jsonb_build_object('created', 0, 'reason', 'unsupported source_doc_type');
  END IF;

  RETURN jsonb_build_object('created', v_created);
END $function$;

DROP FUNCTION IF EXISTS public.ROW_COUNT_HACK();