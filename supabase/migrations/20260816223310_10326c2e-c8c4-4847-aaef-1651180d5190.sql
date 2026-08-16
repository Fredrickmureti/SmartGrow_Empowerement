DO $sim$
DECLARE
  c_org   uuid := '8e682296-c634-44c8-ae00-bc48940ec28b';
  c_biz   uuid := 'bf392ca6-a743-435c-ae41-5bf25199470d';
  c_wh    uuid := '62853bd5-96be-4d9d-983c-67bb4f154775';
  c_br    uuid := 'aeb86a80-af26-437b-a033-e95615fdaa28';
  c_sup   uuid := '54709d33-f976-4c42-8f2e-f27cca6a85fd';
  c_user  uuid := 'af903a2e-3ab0-43f5-b2f0-1a4000985084';
  v_prod uuid; v_pack uuid;
  v_po_a uuid; v_po_b uuid; v_poi_a uuid; v_poi_b uuid;
  v_asn uuid; v_asn_item uuid;
  v_sess_a uuid; v_sess_b uuid;
  v_rv int; v_j jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', c_user, 'role', 'authenticated')::text, true);

  SELECT id INTO v_prod FROM products WHERE business_id=c_biz AND sku='E2E-MILK-500';
  SELECT id INTO v_pack FROM product_packaging WHERE product_id=v_prod AND name='Carton (30)';
  INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R2_00_ctx','ok',
    jsonb_build_object('product',v_prod,'pack',v_pack));

  -- PO-A : clerk orders 200 CARTONS
  BEGIN
    INSERT INTO purchase_orders (organization_id, business_id, branch_id, vendor_id, po_number,
      status, order_date, expected_date, currency, deliver_to_warehouse_id, deliver_to_branch_id,
      subtotal, tax_amount, total, created_by, notes)
    VALUES (c_org, c_biz, c_br, c_sup, 'E2E-MILK-PO-A2-'||to_char(clock_timestamp(),'HH24MISSMS'),
      'draft', current_date, current_date+7, 'KES', c_wh, c_br, 240000, 0, 240000, c_user, 'E2E ASN path')
    RETURNING id INTO v_po_a;
    INSERT INTO purchase_order_items (purchase_order_id, product_id, description,
      quantity, unit_price, tax_rate, tax_amount, line_total, packaging_id, display_quantity, sort_order)
    VALUES (v_po_a, v_prod, 'Milk 500ml - 200 cartons', 200, 40, 0, 0, 240000, v_pack, 200, 1)
    RETURNING id INTO v_poi_a;
    SELECT jsonb_build_object('quantity',quantity,'display_quantity',display_quantity,
      'uom_snapshot',uom_snapshot,'factor',uom_snapshot_factor,'pack_name',uom_snapshot_pack_name)
      INTO v_j FROM purchase_order_items WHERE id=v_poi_a;
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R2_02_po_a_line','ok',
      v_j || jsonb_build_object('po',v_po_a,'base_is_6000',(v_j->>'quantity')::numeric=6000));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R2_02_po_a_line','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE));
  END;

  BEGIN
    PERFORM submit_purchase_order(v_po_a);
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R2_03a_submit','ok',
      (SELECT jsonb_build_object('status',status) FROM purchase_orders WHERE id=v_po_a));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R2_03a_submit','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE)); END;
  BEGIN
    PERFORM approve_purchase_order(v_po_a,'e2e-a2');
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R2_03b_approve','ok',
      (SELECT jsonb_build_object('status',status) FROM purchase_orders WHERE id=v_po_a));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R2_03b_approve','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE,
        'status',(SELECT status::text FROM purchase_orders WHERE id=v_po_a))); END;

  -- ASN
  BEGIN
    v_j := create_inbound_shipment(c_biz, c_sup, v_po_a, now()+interval '1 day',
      'E2E Logistics','TRK-E2E','62853bd5-96be-4d9d-983c-67bb4f154775'::uuid, c_br, 'E2E ASN');
    v_asn := COALESCE((v_j->>'id')::uuid,(v_j->>'shipment_id')::uuid);
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R2_04a_asn','ok',
      jsonb_build_object('rpc',v_j,'asn',v_asn));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R2_04a_asn','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE)); END;
  BEGIN
    INSERT INTO inbound_shipment_items (organization_id, business_id, branch_id, shipment_id,
      purchase_order_item_id, product_id, expected_quantity, expected_packaging_id,
      display_quantity, notes, sort_order)
    VALUES (c_org,c_biz,c_br,v_asn,v_poi_a,v_prod,200,v_pack,200,'clerk typed 200 cartons',1)
    RETURNING id INTO v_asn_item;
    SELECT jsonb_build_object('expected_quantity',expected_quantity,'display_quantity',display_quantity,
      'pack',expected_packaging_id) INTO v_j FROM inbound_shipment_items WHERE id=v_asn_item;
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R2_04b_asn_line','ok',
      v_j || jsonb_build_object('normalized_to_6000',(v_j->>'expected_quantity')::numeric=6000));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R2_04b_asn_line','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE)); END;
  BEGIN
    PERFORM dispatch_inbound_shipment(v_asn, now());
    PERFORM mark_inbound_shipment_in_transit(v_asn);
    PERFORM mark_inbound_shipment_arrived(v_asn, now());
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R2_04c_transit','ok',
      (SELECT jsonb_build_object('status',status) FROM inbound_shipments WHERE id=v_asn));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R2_04c_transit','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE)); END;

  -- ASN receiving session
  BEGIN
    INSERT INTO wms_receiving_sessions (organization_id,business_id,branch_id,warehouse_id,code,
      source_doc_type,source_doc_id,state,supervisor_id,created_by)
    VALUES (c_org,c_biz,c_br,c_wh,'E2E-RCV-ASN2-'||to_char(clock_timestamp(),'HH24MISSMS'),
      'inbound_shipment',v_asn,'open',c_user,c_user)
    RETURNING id INTO v_sess_a;
    v_j := wms_materialize_expected_lines(v_sess_a);
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R2_05a_session','ok',
      jsonb_build_object('session',v_sess_a,'materialize',v_j,'lines',
        (SELECT jsonb_agg(jsonb_build_object('expected',expected_qty,'isi',inbound_shipment_item_id,
          'poi',purchase_order_item_id,'state',line_state)) FROM wms_receiving_lines WHERE session_id=v_sess_a)));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R2_05a_session','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE)); END;
  BEGIN
    SELECT row_version INTO v_rv FROM wms_receiving_sessions WHERE id=v_sess_a;
    PERFORM wms_transition_receiving(v_sess_a,'unloading'::wms_receiving_state,v_rv,'e2e',NULL);
    v_j := wms_capture_receiving_line(p_session_id=>v_sess_a,p_product_id=>v_prod,
      p_received_qty=>200,p_packaging_id=>v_pack,p_entered_qty=>200,
      p_client_scan_id=>'e2e-a2-1',p_device_id=>'e2e-sim');
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R2_05b_capture','ok',
      jsonb_build_object('rpc',v_j,'lines',(SELECT jsonb_agg(jsonb_build_object('expected',expected_qty,
        'received',received_qty,'entered',entered_qty,'uom',uom,'state',line_state,
        'isi',inbound_shipment_item_id,'poi',purchase_order_item_id))
        FROM wms_receiving_lines WHERE session_id=v_sess_a)));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R2_05b_capture','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE)); END;
  BEGIN
    SELECT row_version INTO v_rv FROM wms_receiving_sessions WHERE id=v_sess_a;
    PERFORM wms_transition_receiving(v_sess_a,'captured'::wms_receiving_state,v_rv,'e2e',NULL);
    SELECT row_version INTO v_rv FROM wms_receiving_sessions WHERE id=v_sess_a;
    v_j := wms_post_receiving_session(v_sess_a,v_rv,NULL);
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R2_06_post_asn','ok',
      jsonb_build_object('rpc',v_j,'state',(SELECT state::text FROM wms_receiving_sessions WHERE id=v_sess_a),
        'movements_net',(SELECT COALESCE(SUM(quantity),0) FROM stock_movements WHERE product_id=v_prod),
        'grn',(SELECT jsonb_agg(jsonb_build_object('num',receipt_number,'status',status))
               FROM goods_receipts WHERE purchase_order_id=v_po_a)));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R2_06_post_asn','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE,
        'state',(SELECT state::text FROM wms_receiving_sessions WHERE id=v_sess_a),
        'grn',(SELECT jsonb_agg(jsonb_build_object('num',receipt_number,'status',status))
               FROM goods_receipts WHERE purchase_order_id=v_po_a),
        'movements_net',(SELECT COALESCE(SUM(quantity),0) FROM stock_movements WHERE product_id=v_prod))); END;

  -- CONTROL: PO-B direct PO receiving path
  BEGIN
    INSERT INTO purchase_orders (organization_id,business_id,branch_id,vendor_id,po_number,status,
      order_date,expected_date,currency,deliver_to_warehouse_id,deliver_to_branch_id,
      subtotal,tax_amount,total,created_by,notes)
    VALUES (c_org,c_biz,c_br,c_sup,'E2E-MILK-PO-B2-'||to_char(clock_timestamp(),'HH24MISSMS'),
      'draft',current_date,current_date+7,'KES',c_wh,c_br,240000,0,240000,c_user,'E2E PO control')
    RETURNING id INTO v_po_b;
    INSERT INTO purchase_order_items (purchase_order_id,product_id,description,quantity,unit_price,
      tax_rate,tax_amount,line_total,packaging_id,display_quantity,sort_order)
    VALUES (v_po_b,v_prod,'Milk 500ml - 200 cartons',200,40,0,0,240000,v_pack,200,1)
    RETURNING id INTO v_poi_b;
    PERFORM submit_purchase_order(v_po_b);
    BEGIN PERFORM approve_purchase_order(v_po_b,'e2e-b2');
    EXCEPTION WHEN OTHERS THEN INSERT INTO _e2e_milk_log(step,status,detail)
      VALUES ('R2_07a_po_b_approve','error',jsonb_build_object('err',SQLERRM)); END;
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R2_07b_po_b','ok',
      jsonb_build_object('po',v_po_b,'status',(SELECT status::text FROM purchase_orders WHERE id=v_po_b),
        'line_base_qty',(SELECT quantity FROM purchase_order_items WHERE id=v_poi_b)));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R2_07_po_b','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE)); END;
  BEGIN
    INSERT INTO wms_receiving_sessions (organization_id,business_id,branch_id,warehouse_id,code,
      source_doc_type,source_doc_id,state,supervisor_id,created_by)
    VALUES (c_org,c_biz,c_br,c_wh,'E2E-RCV-PO2-'||to_char(clock_timestamp(),'HH24MISSMS'),
      'purchase_order',v_po_b,'open',c_user,c_user)
    RETURNING id INTO v_sess_b;
    v_j := wms_materialize_expected_lines(v_sess_b);
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R2_08a_po_session','ok',
      jsonb_build_object('session',v_sess_b,'materialize',v_j,'lines',
        (SELECT jsonb_agg(jsonb_build_object('expected',expected_qty,'poi',purchase_order_item_id))
         FROM wms_receiving_lines WHERE session_id=v_sess_b)));
    SELECT row_version INTO v_rv FROM wms_receiving_sessions WHERE id=v_sess_b;
    PERFORM wms_transition_receiving(v_sess_b,'unloading'::wms_receiving_state,v_rv,'e2e',NULL);
    PERFORM wms_capture_receiving_line(p_session_id=>v_sess_b,p_product_id=>v_prod,
      p_received_qty=>200,p_packaging_id=>v_pack,p_entered_qty=>200,
      p_client_scan_id=>'e2e-b2-1',p_device_id=>'e2e-sim');
    SELECT row_version INTO v_rv FROM wms_receiving_sessions WHERE id=v_sess_b;
    PERFORM wms_transition_receiving(v_sess_b,'captured'::wms_receiving_state,v_rv,'e2e',NULL);
    SELECT row_version INTO v_rv FROM wms_receiving_sessions WHERE id=v_sess_b;
    v_j := wms_post_receiving_session(v_sess_b,v_rv,NULL);
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R2_08b_post_po','ok',
      jsonb_build_object('rpc',v_j,'state',(SELECT state::text FROM wms_receiving_sessions WHERE id=v_sess_b),
        'lines',(SELECT jsonb_agg(jsonb_build_object('expected',expected_qty,'received',received_qty,
          'entered',entered_qty,'uom',uom,'state',line_state)) FROM wms_receiving_lines WHERE session_id=v_sess_b)));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R2_08b_post_po','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE,'session',v_sess_b,
        'state',(SELECT state::text FROM wms_receiving_sessions WHERE id=v_sess_b),
        'lines',(SELECT jsonb_agg(jsonb_build_object('expected',expected_qty,'received',received_qty,
          'state',line_state)) FROM wms_receiving_lines WHERE session_id=v_sess_b))); END;

  -- Reconciliation
  BEGIN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R2_09_recon','ok',
      jsonb_build_object(
        'movements',(SELECT jsonb_agg(jsonb_build_object('type',movement_type,'qty',quantity,
          'ref',reference_type,'display',display_quantity,'pack',uom_snapshot_pack_name,'wh',warehouse_id))
          FROM stock_movements WHERE product_id=v_prod),
        'movement_net',(SELECT COALESCE(SUM(quantity),0) FROM stock_movements WHERE product_id=v_prod),
        'quants',(SELECT jsonb_agg(jsonb_build_object('wh',warehouse_id,'qty',quantity,
          'reserved',reserved_quantity)) FROM stock_quants WHERE product_id=v_prod),
        'products_stock_quantity',(SELECT stock_quantity FROM products WHERE id=v_prod),
        'grns',(SELECT jsonb_agg(jsonb_build_object('num',receipt_number,'status',status,'po',purchase_order_id))
          FROM goods_receipts WHERE purchase_order_id IN (v_po_a,v_po_b)),
        'grn_items',(SELECT jsonb_agg(jsonb_build_object('qty',gi.quantity_received,'display',gi.display_quantity,
          'pack',gi.packaging_id)) FROM goods_receipt_items gi JOIN goods_receipts g ON g.id=gi.goods_receipt_id
          WHERE g.purchase_order_id IN (v_po_a,v_po_b)),
        'po_a_received',(SELECT quantity_received FROM purchase_order_items WHERE id=v_poi_a),
        'po_b_received',(SELECT quantity_received FROM purchase_order_items WHERE id=v_poi_b),
        'asn_status',(SELECT status::text FROM inbound_shipments WHERE id=v_asn),
        'outbox',(SELECT jsonb_agg(DISTINCT event_type) FROM business_event_outbox
          WHERE created_at > now()-interval '10 minutes'),
        'journal_entries',(SELECT count(*) FROM journal_entries
          WHERE created_at > now()-interval '10 minutes')));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R2_09_recon','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE)); END;
END $sim$;