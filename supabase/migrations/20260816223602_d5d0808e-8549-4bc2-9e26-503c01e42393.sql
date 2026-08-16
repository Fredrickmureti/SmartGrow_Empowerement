DO $sim$
DECLARE
  c_org uuid := '8e682296-c634-44c8-ae00-bc48940ec28b';
  c_biz uuid := 'bf392ca6-a743-435c-ae41-5bf25199470d';
  c_wh  uuid := '62853bd5-96be-4d9d-983c-67bb4f154775';
  c_br  uuid := 'aeb86a80-af26-437b-a033-e95615fdaa28';
  c_sup uuid := '54709d33-f976-4c42-8f2e-f27cca6a85fd';
  c_user uuid := 'af903a2e-3ab0-43f5-b2f0-1a4000985084';
  v_prod uuid; v_pack uuid; v_po uuid; v_poi uuid;
  v_asn uuid; v_item uuid; v_sess uuid; v_rv int; v_j jsonb;
  v_before numeric; v_after numeric;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', c_user, 'role','authenticated')::text, true);
  SELECT id INTO v_prod FROM products WHERE business_id=c_biz AND sku='E2E-MILK-500';
  SELECT id INTO v_pack FROM product_packaging WHERE product_id=v_prod AND name='Carton (30)';
  SELECT id, (SELECT id FROM purchase_order_items WHERE purchase_order_id=po.id LIMIT 1)
    INTO v_po, v_poi FROM purchase_orders po
   WHERE po.po_number LIKE 'E2E-MILK-PO-A2-%' ORDER BY created_at DESC LIMIT 1;
  SELECT COALESCE(SUM(quantity),0) INTO v_before FROM stock_movements WHERE product_id=v_prod;

  BEGIN
    v_asn := create_inbound_shipment(c_biz, c_sup, v_po, now()+interval '1 day',
      'E2E Logistics','TRK-E2E-2', c_wh, c_br, 'E2E ASN leg');
    INSERT INTO inbound_shipment_items (organization_id,business_id,branch_id,shipment_id,
      purchase_order_item_id,product_id,expected_quantity,expected_packaging_id,display_quantity,notes,sort_order)
    VALUES (c_org,c_biz,c_br,v_asn,v_poi,v_prod,200,v_pack,200,'clerk typed 200 cartons',1)
    RETURNING id INTO v_item;
    PERFORM dispatch_inbound_shipment(v_asn, now());
    PERFORM mark_inbound_shipment_in_transit(v_asn);
    PERFORM mark_inbound_shipment_arrived(v_asn, now());
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R3_01_asn','ok',
      jsonb_build_object('asn',v_asn,'status',(SELECT status::text FROM inbound_shipments WHERE id=v_asn),
        'line',(SELECT jsonb_build_object('expected_quantity',expected_quantity,'display',display_quantity,
          'pack',expected_packaging_id) FROM inbound_shipment_items WHERE id=v_item),
        'asn_line_normalized_to_6000',
          (SELECT expected_quantity FROM inbound_shipment_items WHERE id=v_item) = 6000));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R3_01_asn','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE)); END;

  BEGIN
    INSERT INTO wms_receiving_sessions (organization_id,business_id,branch_id,warehouse_id,code,
      source_doc_type,source_doc_id,state,supervisor_id,created_by)
    VALUES (c_org,c_biz,c_br,c_wh,'E2E-RCV-ASN3-'||to_char(clock_timestamp(),'HH24MISSMS'),
      'inbound_shipment',v_asn,'open',c_user,c_user)
    RETURNING id INTO v_sess;
    v_j := wms_materialize_expected_lines(v_sess);
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R3_02_materialize','ok',
      jsonb_build_object('session',v_sess,'result',v_j,'lines',
        (SELECT jsonb_agg(jsonb_build_object('expected',expected_qty,'isi',inbound_shipment_item_id,
          'poi',purchase_order_item_id)) FROM wms_receiving_lines WHERE session_id=v_sess)));
    SELECT row_version INTO v_rv FROM wms_receiving_sessions WHERE id=v_sess;
    PERFORM wms_transition_receiving(v_sess,'unloading'::wms_receiving_state,v_rv,'e2e',NULL);
    PERFORM wms_capture_receiving_line(p_session_id=>v_sess,p_product_id=>v_prod,
      p_received_qty=>200,p_packaging_id=>v_pack,p_entered_qty=>200,
      p_client_scan_id=>'e2e-asn3-1',p_device_id=>'e2e-sim');
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R3_03_capture','ok',
      (SELECT jsonb_agg(jsonb_build_object('expected',expected_qty,'received',received_qty,
        'entered',entered_qty,'uom',uom,'state',line_state,'isi',inbound_shipment_item_id))
        FROM wms_receiving_lines WHERE session_id=v_sess));
    SELECT row_version INTO v_rv FROM wms_receiving_sessions WHERE id=v_sess;
    PERFORM wms_transition_receiving(v_sess,'captured'::wms_receiving_state,v_rv,'e2e',NULL);
    SELECT row_version INTO v_rv FROM wms_receiving_sessions WHERE id=v_sess;
    v_j := wms_post_receiving_session(v_sess,v_rv,NULL);
    SELECT COALESCE(SUM(quantity),0) INTO v_after FROM stock_movements WHERE product_id=v_prod;
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R3_04_post','ok',
      jsonb_build_object('rpc',v_j,'state',(SELECT state::text FROM wms_receiving_sessions WHERE id=v_sess),
        'movement_before',v_before,'movement_after',v_after,'delta',v_after-v_before,
        'grn',(SELECT jsonb_agg(jsonb_build_object('num',receipt_number,'status',status))
               FROM goods_receipts WHERE purchase_order_id=v_po),
        'asn_status',(SELECT status::text FROM inbound_shipments WHERE id=v_asn),
        'warehouse_stock',(SELECT quantity FROM warehouse_stock WHERE product_id=v_prod AND warehouse_id=c_wh),
        'quant_rows',(SELECT jsonb_agg(jsonb_build_object('qty',quantity,'lpn',lpn_id,'pack',uom_snapshot_pack_name))
                      FROM stock_quants WHERE product_id=v_prod)));
  EXCEPTION WHEN OTHERS THEN
    SELECT COALESCE(SUM(quantity),0) INTO v_after FROM stock_movements WHERE product_id=v_prod;
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R3_04_post','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE,'session',v_sess,
        'state',(SELECT state::text FROM wms_receiving_sessions WHERE id=v_sess),
        'movement_before',v_before,'movement_after',v_after,
        'grn',(SELECT jsonb_agg(jsonb_build_object('num',receipt_number,'status',status))
               FROM goods_receipts WHERE purchase_order_id=v_po),
        'asn_status',(SELECT status::text FROM inbound_shipments WHERE id=v_asn))); END;
END $sim$;