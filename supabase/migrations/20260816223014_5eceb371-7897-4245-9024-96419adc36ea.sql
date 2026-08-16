-- E2E business-event simulation: 200 cartons of milk (1 carton = 30 packets = 6,000 packets)
CREATE TABLE IF NOT EXISTS public._e2e_milk_log (
  id bigserial PRIMARY KEY,
  step text NOT NULL,
  status text NOT NULL,
  detail jsonb,
  at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public._e2e_milk_log TO service_role;
ALTER TABLE public._e2e_milk_log ENABLE ROW LEVEL SECURITY;

DO $sim$
DECLARE
  c_org   uuid := '8e682296-c634-44c8-ae00-bc48940ec28b';
  c_biz   uuid := 'bf392ca6-a743-435c-ae41-5bf25199470d';
  c_wh    uuid := '62853bd5-96be-4d9d-983c-67bb4f154775';
  c_br    uuid := 'aeb86a80-af26-437b-a033-e95615fdaa28';
  c_sup   uuid := '54709d33-f976-4c42-8f2e-f27cca6a85fd';
  c_pce   uuid := 'dbfb3833-6dd7-458a-9f3e-8d32bdcb376b';
  c_user  uuid := 'af903a2e-3ab0-43f5-b2f0-1a4000985084';
  v_prod uuid; v_pack uuid;
  v_po_a uuid; v_po_b uuid; v_poi_a uuid; v_poi_b uuid;
  v_asn uuid; v_asn_item uuid;
  v_sess_a uuid; v_sess_b uuid;
  v_rv int; v_j jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', c_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', c_user::text, true);

  BEGIN
    SELECT id INTO v_prod FROM products WHERE business_id=c_biz AND sku='E2E-MILK-500';
    IF v_prod IS NULL THEN
      INSERT INTO products (organization_id, business_id, name, sku, type, base_uom_id,
        purchase_uom_id, sales_uom_id, track_inventory, unit_price, cost_price, is_active, status)
      VALUES (c_org, c_biz, 'E2E Milk 500ml Packet', 'E2E-MILK-500', 'product', c_pce,
        c_pce, c_pce, true, 60, 40, true, 'active')
      RETURNING id INTO v_prod;
    END IF;
    SELECT id INTO v_pack FROM product_packaging WHERE product_id=v_prod AND name='Carton (30)';
    IF v_pack IS NULL THEN
      INSERT INTO product_packaging (organization_id, business_id, product_id, name,
        qty_in_base_uom, is_purchase_default, is_shipping_unit)
      VALUES (c_org, c_biz, v_prod, 'Carton (30)', 30, true, true)
      RETURNING id INTO v_pack;
    END IF;
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES
      ('01_master_data','ok', jsonb_build_object('product',v_prod,'packaging',v_pack,
        'base_uom','PCE','carton_factor',30));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('01_master_data','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE));
  END;

  BEGIN
    INSERT INTO purchase_orders (organization_id, business_id, branch_id, vendor_id, po_number,
      status, order_date, expected_date, currency, deliver_to_warehouse_id, deliver_to_branch_id,
      subtotal, tax_amount, total, created_by, notes)
    VALUES (c_org, c_biz, c_br, c_sup, 'E2E-MILK-PO-A-'||to_char(now(),'HH24MISS'),
      'draft', current_date, current_date+7, 'KES', c_wh, c_br, 240000, 0, 240000, c_user,
      'E2E sim: ASN path')
    RETURNING id INTO v_po_a;
    INSERT INTO purchase_order_items (purchase_order_id, product_id, description,
      quantity, unit_price, packaging_id, display_quantity, sort_order)
    VALUES (v_po_a, v_prod, 'Milk 500ml - 200 cartons', 200, 40, v_pack, 200, 1)
    RETURNING id INTO v_poi_a;
    SELECT jsonb_build_object('quantity',quantity,'display_quantity',display_quantity,
      'uom_snapshot',uom_snapshot,'factor',uom_snapshot_factor) INTO v_j
      FROM purchase_order_items WHERE id=v_poi_a;
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES
      ('02_po_a_line_normalized','ok', v_j || jsonb_build_object('po',v_po_a,
        'expected_base',6000,'matches_physical_reality',(v_j->>'quantity')::numeric = 6000));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('02_po_a','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE));
  END;

  BEGIN
    PERFORM submit_purchase_order(v_po_a);
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('03a_po_a_submit','ok',
      (SELECT jsonb_build_object('status',status) FROM purchase_orders WHERE id=v_po_a));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('03a_po_a_submit','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE));
  END;
  BEGIN
    PERFORM approve_purchase_order(v_po_a, 'e2e-milk-a');
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('03b_po_a_approve','ok',
      (SELECT jsonb_build_object('status',status,'approved_at',approved_at) FROM purchase_orders WHERE id=v_po_a));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('03b_po_a_approve','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE));
  END;

  BEGIN
    v_j := create_inbound_shipment(c_biz, c_sup, v_po_a, now()+interval '1 day',
      'E2E Logistics', 'TRK-E2E-MILK', c_wh, c_br, 'E2E sim ASN');
    v_asn := COALESCE((v_j->>'id')::uuid, (v_j->>'shipment_id')::uuid);
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('04a_asn_created','ok',
      jsonb_build_object('rpc_result',v_j,'shipment',v_asn));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('04a_asn_created','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE));
  END;
  BEGIN
    INSERT INTO inbound_shipment_items (organization_id, business_id, branch_id, shipment_id,
      purchase_order_item_id, product_id, expected_quantity, expected_packaging_id,
      display_quantity, notes, sort_order)
    VALUES (c_org, c_biz, c_br, v_asn, v_poi_a, v_prod, 200, v_pack, 200,
      'clerk typed 200 (cartons)', 1)
    RETURNING id INTO v_asn_item;
    SELECT jsonb_build_object('expected_quantity',expected_quantity,
      'expected_packaging_id',expected_packaging_id,'display_quantity',display_quantity)
      INTO v_j FROM inbound_shipment_items WHERE id=v_asn_item;
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('04b_asn_line_uom','ok',
      v_j || jsonb_build_object('normalized_to_base',(v_j->>'expected_quantity')::numeric = 6000));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('04b_asn_line_uom','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE));
  END;
  BEGIN
    PERFORM dispatch_inbound_shipment(v_asn, now());
    PERFORM mark_inbound_shipment_in_transit(v_asn);
    PERFORM mark_inbound_shipment_arrived(v_asn, now());
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('04c_asn_transit','ok',
      (SELECT jsonb_build_object('status',status) FROM inbound_shipments WHERE id=v_asn));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('04c_asn_transit','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE));
  END;

  BEGIN
    INSERT INTO wms_receiving_sessions (organization_id, business_id, branch_id, warehouse_id,
      code, source_doc_type, source_doc_id, state, supervisor_id, created_by, notes)
    VALUES (c_org, c_biz, c_br, c_wh, 'E2E-RCV-ASN-'||to_char(now(),'HH24MISS'),
      'inbound_shipment', v_asn, 'open', c_user, c_user, 'E2E sim ASN receiving')
    RETURNING id INTO v_sess_a;
    v_j := wms_materialize_expected_lines(v_sess_a);
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('05a_session_asn','ok',
      jsonb_build_object('session',v_sess_a,'materialize',v_j,
        'expected_lines',(SELECT jsonb_agg(jsonb_build_object('expected_qty',expected_qty,
           'inbound_item',inbound_shipment_item_id,'po_item',purchase_order_item_id))
           FROM wms_receiving_lines WHERE session_id=v_sess_a)));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('05a_session_asn','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE));
  END;
  BEGIN
    SELECT row_version INTO v_rv FROM wms_receiving_sessions WHERE id=v_sess_a;
    PERFORM wms_transition_receiving(v_sess_a, 'unloading'::wms_receiving_state, v_rv, 'e2e', NULL);
    v_j := wms_capture_receiving_line(
      p_session_id => v_sess_a, p_product_id => v_prod, p_received_qty => 200,
      p_packaging_id => v_pack, p_entered_qty => 200, p_client_scan_id => 'e2e-scan-a-1',
      p_device_id => 'e2e-sim');
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('05b_capture_asn','ok',
      jsonb_build_object('rpc',v_j,'lines',(SELECT jsonb_agg(jsonb_build_object(
        'expected',expected_qty,'received',received_qty,'entered',entered_qty,'uom',uom,
        'state',line_state)) FROM wms_receiving_lines WHERE session_id=v_sess_a)));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('05b_capture_asn','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE));
  END;

  BEGIN
    SELECT row_version INTO v_rv FROM wms_receiving_sessions WHERE id=v_sess_a;
    PERFORM wms_transition_receiving(v_sess_a, 'captured'::wms_receiving_state, v_rv, 'e2e', NULL);
    SELECT row_version INTO v_rv FROM wms_receiving_sessions WHERE id=v_sess_a;
    v_j := wms_post_receiving_session(v_sess_a, v_rv, NULL);
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('06_post_asn_session','ok',
      jsonb_build_object('rpc',v_j,
        'session_state',(SELECT state::text FROM wms_receiving_sessions WHERE id=v_sess_a),
        'movements_for_product',(SELECT COALESCE(SUM(quantity),0) FROM stock_movements WHERE product_id=v_prod),
        'grn',(SELECT jsonb_agg(jsonb_build_object('id',id,'status',status,'number',receipt_number))
               FROM goods_receipts WHERE business_id=c_biz AND purchase_order_id=v_po_a)));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('06_post_asn_session','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE,
        'session_state',(SELECT state::text FROM wms_receiving_sessions WHERE id=v_sess_a)));
  END;

  BEGIN
    INSERT INTO purchase_orders (organization_id, business_id, branch_id, vendor_id, po_number,
      status, order_date, expected_date, currency, deliver_to_warehouse_id, deliver_to_branch_id,
      subtotal, tax_amount, total, created_by, notes)
    VALUES (c_org, c_biz, c_br, c_sup, 'E2E-MILK-PO-B-'||to_char(now(),'HH24MISS'),
      'draft', current_date, current_date+7, 'KES', c_wh, c_br, 240000, 0, 240000, c_user,
      'E2E sim: PO control path')
    RETURNING id INTO v_po_b;
    INSERT INTO purchase_order_items (purchase_order_id, product_id, description,
      quantity, unit_price, packaging_id, display_quantity, sort_order)
    VALUES (v_po_b, v_prod, 'Milk 500ml - 200 cartons', 200, 40, v_pack, 200, 1)
    RETURNING id INTO v_poi_b;
    PERFORM submit_purchase_order(v_po_b);
    BEGIN PERFORM approve_purchase_order(v_po_b, 'e2e-milk-b');
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('07a_po_b_approve','error',
        jsonb_build_object('err',SQLERRM)); END;
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('07b_po_b_ready','ok',
      (SELECT jsonb_build_object('status',status,'line_qty',
        (SELECT quantity FROM purchase_order_items WHERE id=v_poi_b))
        FROM purchase_orders WHERE id=v_po_b));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('07_po_b','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE));
  END;
  BEGIN
    INSERT INTO wms_receiving_sessions (organization_id, business_id, branch_id, warehouse_id,
      code, source_doc_type, source_doc_id, state, supervisor_id, created_by, notes)
    VALUES (c_org, c_biz, c_br, c_wh, 'E2E-RCV-PO-'||to_char(now(),'HH24MISS'),
      'purchase_order', v_po_b, 'open', c_user, c_user, 'E2E sim PO receiving')
    RETURNING id INTO v_sess_b;
    v_j := wms_materialize_expected_lines(v_sess_b);
    SELECT row_version INTO v_rv FROM wms_receiving_sessions WHERE id=v_sess_b;
    PERFORM wms_transition_receiving(v_sess_b, 'unloading'::wms_receiving_state, v_rv, 'e2e', NULL);
    PERFORM wms_capture_receiving_line(
      p_session_id => v_sess_b, p_product_id => v_prod, p_received_qty => 200,
      p_packaging_id => v_pack, p_entered_qty => 200, p_client_scan_id => 'e2e-scan-b-1',
      p_device_id => 'e2e-sim');
    SELECT row_version INTO v_rv FROM wms_receiving_sessions WHERE id=v_sess_b;
    PERFORM wms_transition_receiving(v_sess_b, 'captured'::wms_receiving_state, v_rv, 'e2e', NULL);
    SELECT row_version INTO v_rv FROM wms_receiving_sessions WHERE id=v_sess_b;
    v_j := wms_post_receiving_session(v_sess_b, v_rv, NULL);
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('08_post_po_session','ok',
      jsonb_build_object('post',v_j,
        'session_state',(SELECT state::text FROM wms_receiving_sessions WHERE id=v_sess_b),
        'lines',(SELECT jsonb_agg(jsonb_build_object('expected',expected_qty,'received',received_qty,
           'entered',entered_qty,'uom',uom)) FROM wms_receiving_lines WHERE session_id=v_sess_b)));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('08_post_po_session','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE,'session',v_sess_b,
        'session_state',(SELECT state::text FROM wms_receiving_sessions WHERE id=v_sess_b)));
  END;

  BEGIN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('09_reconciliation','ok',
      jsonb_build_object(
        'stock_movements',(SELECT jsonb_agg(jsonb_build_object('type',movement_type,'qty',quantity,
            'ref',reference_type,'wh',warehouse_id,'display',display_quantity,'pack',uom_snapshot_pack_name))
          FROM stock_movements WHERE product_id=v_prod),
        'movement_net',(SELECT COALESCE(SUM(quantity),0) FROM stock_movements WHERE product_id=v_prod),
        'stock_quants',(SELECT jsonb_agg(to_jsonb(q)-'id'-'created_at'-'updated_at') FROM stock_quants q WHERE q.product_id=v_prod),
        'products_stock_quantity',(SELECT stock_quantity FROM products WHERE id=v_prod),
        'goods_receipts',(SELECT jsonb_agg(jsonb_build_object('num',receipt_number,'status',status,
            'po',purchase_order_id)) FROM goods_receipts WHERE business_id=c_biz
            AND purchase_order_id IN (v_po_a,v_po_b)),
        'grn_items',(SELECT jsonb_agg(jsonb_build_object('qty',gi.quantity_received,'display',gi.display_quantity))
            FROM goods_receipt_items gi JOIN goods_receipts g ON g.id=gi.goods_receipt_id
            WHERE g.purchase_order_id IN (v_po_a,v_po_b)),
        'po_a_received',(SELECT quantity_received FROM purchase_order_items WHERE id=v_poi_a),
        'po_b_received',(SELECT quantity_received FROM purchase_order_items WHERE id=v_poi_b),
        'outbox_topics',(SELECT jsonb_agg(DISTINCT topic) FROM business_event_outbox
            WHERE created_at > now()-interval '5 minutes'),
        'accounting_events',(SELECT count(*) FROM accounting_events WHERE created_at > now()-interval '5 minutes')
      ));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('09_reconciliation','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE));
  END;
END $sim$;