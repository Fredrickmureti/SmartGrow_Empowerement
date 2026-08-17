DO $sim$
DECLARE
  c_org   uuid := '8e682296-c634-44c8-ae00-bc48940ec28b';
  c_biz   uuid := 'bf392ca6-a743-435c-ae41-5bf25199470d';
  c_wh    uuid := '62853bd5-96be-4d9d-983c-67bb4f154775';
  c_br    uuid := 'aeb86a80-af26-437b-a033-e95615fdaa28';
  c_sup   uuid := '54709d33-f976-4c42-8f2e-f27cca6a85fd';
  c_user  uuid := 'af903a2e-3ab0-43f5-b2f0-1a4000985084';
  c_stage uuid := '64a85d6c-edfd-4c83-a0ce-4a3fc687d2a5';
  c_carrier uuid := '68965c18-0b82-4c30-88c5-9b2e3be5759a';
  v_prod uuid; v_pack uuid;
  v_po uuid; v_poi uuid; v_asn uuid; v_asn_item uuid;
  v_dock uuid; v_appt uuid; v_sess uuid;
  v_rv int; v_j jsonb; v_bins jsonb;
  v_task record; v_dest uuid; v_i int;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', c_user, 'role', 'authenticated')::text, true);

  SELECT id INTO v_prod FROM products WHERE business_id=c_biz AND sku='E2E-MILK-500';
  SELECT id INTO v_pack FROM product_packaging WHERE product_id=v_prod AND name='Carton (30)';

  FOR v_i IN 1..4 LOOP
    INSERT INTO stock_locations (organization_id, business_id, branch_id, warehouse_id,
      code, name, location_type, usage, is_active, is_default,
      is_putaway_target, is_receiving_staging, pick_sequence, putaway_priority,
      capacity_max_units, storage_role, ground_level, created_by)
    SELECT c_org, c_biz, c_br, c_wh,
      'NKR-A-'||lpad(v_i::text,2,'0'), 'Rack A Bin '||v_i,
      'internal', 'storage', true, false, true, false, v_i*10, 100 - v_i,
      8000, CASE WHEN v_i=4 THEN 'overflow' ELSE 'bulk' END, v_i<=2, c_user
    WHERE NOT EXISTS (SELECT 1 FROM stock_locations
                      WHERE warehouse_id=c_wh AND code='NKR-A-'||lpad(v_i::text,2,'0'));
  END LOOP;
  UPDATE stock_locations SET is_receiving_staging = true, is_putaway_target = false
   WHERE id = c_stage;
  SELECT jsonb_agg(jsonb_build_object('code',code,'target',is_putaway_target,'cap',capacity_max_units))
    INTO v_bins FROM stock_locations WHERE warehouse_id=c_wh;
  INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R3_00_topology','ok',
    jsonb_build_object('locations',v_bins));

  SELECT id INTO v_dock FROM warehouse_docks WHERE warehouse_id=c_wh LIMIT 1;
  IF v_dock IS NULL THEN
    INSERT INTO warehouse_docks (organization_id,business_id,warehouse_id,code,name,dock_type,is_active,created_by)
    VALUES (c_org,c_biz,c_wh,'NKR-D1','Nakuru Dock 1','receiving',true,c_user)
    RETURNING id INTO v_dock;
  END IF;

  BEGIN
    SELECT row_version INTO v_rv FROM wms_receiving_sessions
     WHERE id='d748bb30-abe3-4cf4-b0d3-78f8d4158e4f';
    IF v_rv IS NOT NULL THEN
      PERFORM wms_transition_receiving('d748bb30-abe3-4cf4-b0d3-78f8d4158e4f'::uuid,
        'cancelled'::wms_receiving_state, v_rv,
        'E2E: aborted probe session with no source document', NULL);
    END IF;
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R3_01_strand','ok',
      jsonb_build_object('state',(SELECT state::text FROM wms_receiving_sessions
        WHERE id='d748bb30-abe3-4cf4-b0d3-78f8d4158e4f')));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R3_01_strand','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE)); END;

  INSERT INTO purchase_orders (organization_id,business_id,branch_id,vendor_id,po_number,status,
    order_date,expected_date,currency,deliver_to_warehouse_id,deliver_to_branch_id,
    subtotal,tax_amount,total,created_by,notes,is_sample_data)
  VALUES (c_org,c_biz,c_br,c_sup,'E2E-MILK-PO-R3-'||to_char(clock_timestamp(),'HH24MISSMS'),
    'draft',current_date,current_date+3,'KES',c_wh,c_br,120000,0,120000,c_user,'E2E R3 full lifecycle',true)
  RETURNING id INTO v_po;
  INSERT INTO purchase_order_items (purchase_order_id,product_id,description,quantity,unit_price,
    tax_rate,tax_amount,line_total,packaging_id,display_quantity,sort_order)
  VALUES (v_po,v_prod,'Milk 500ml - 100 cartons',100,40,0,0,120000,v_pack,100,1)
  RETURNING id INTO v_poi;
  PERFORM submit_purchase_order(v_po);
  BEGIN PERFORM approve_purchase_order(v_po,'e2e-r3');
  EXCEPTION WHEN OTHERS THEN INSERT INTO _e2e_milk_log(step,status,detail)
    VALUES ('R3_02_approve','error',jsonb_build_object('err',SQLERRM)); END;
  INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R3_02_po','ok',
    jsonb_build_object('po',v_po,'status',(SELECT status::text FROM purchase_orders WHERE id=v_po),
      'base_qty',(SELECT quantity FROM purchase_order_items WHERE id=v_poi),
      'display',(SELECT display_quantity FROM purchase_order_items WHERE id=v_poi)));

  v_asn := create_inbound_shipment(c_biz,c_sup,v_po, now()+interval '2 hours',
    'E2E Logistics','TRK-R3',c_wh,c_br,'E2E R3 ASN');
  INSERT INTO inbound_shipment_items (organization_id,business_id,branch_id,shipment_id,
    purchase_order_item_id,product_id,expected_quantity,expected_packaging_id,
    display_quantity,notes,sort_order)
  SELECT c_org,c_biz,c_br,v_asn,v_poi,v_prod,3000,v_pack,100,'100 cartons',1
  WHERE NOT EXISTS (SELECT 1 FROM inbound_shipment_items WHERE shipment_id=v_asn)
  RETURNING id INTO v_asn_item;
  IF v_asn_item IS NULL THEN
    SELECT id INTO v_asn_item FROM inbound_shipment_items WHERE shipment_id=v_asn LIMIT 1;
  END IF;
  PERFORM dispatch_inbound_shipment(v_asn, now());
  PERFORM mark_inbound_shipment_in_transit(v_asn);
  INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R3_03_asn','ok',
    jsonb_build_object('asn',v_asn,'status',(SELECT status::text FROM inbound_shipments WHERE id=v_asn),
      'line_base_qty',(SELECT expected_quantity FROM inbound_shipment_items WHERE id=v_asn_item)));

  BEGIN
    v_appt := schedule_dock_appointment(
      p_dock_id=>v_dock, p_type=>'receiving',
      p_window_start=>now(), p_window_end=>now()+interval '2 hours',
      p_carrier_id=>c_carrier, p_reference=>'E2E-R3', p_priority=>'normal',
      p_party_contact_id=>c_sup, p_trailer_ref=>'TRL-R3', p_tractor_ref=>NULL,
      p_driver_name=>'E2E Driver', p_driver_phone=>NULL,
      p_scheduled_departure=>NULL, p_requirements=>NULL, p_documents=>NULL);
    PERFORM mark_appointment_arrived(v_appt);
    PERFORM start_appointment(v_appt);
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R3_04_appointment','ok',
      jsonb_build_object('appt',v_appt,
        'state',(SELECT state FROM wms_dock_appointments WHERE id=v_appt)));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R3_04_appointment','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE)); END;

  PERFORM mark_inbound_shipment_arrived(v_asn, now());

  INSERT INTO wms_receiving_sessions (organization_id,business_id,branch_id,warehouse_id,code,
    source_doc_type,source_doc_id,state,supervisor_id,created_by)
  VALUES (c_org,c_biz,c_br,c_wh,'E2E-RCV-R3-'||to_char(clock_timestamp(),'HH24MISSMS'),
    'inbound_shipment',v_asn,'open',c_user,c_user)
  RETURNING id INTO v_sess;
  v_j := wms_materialize_expected_lines(v_sess);
  SELECT row_version INTO v_rv FROM wms_receiving_sessions WHERE id=v_sess;
  PERFORM wms_transition_receiving(v_sess,'unloading'::wms_receiving_state,v_rv,'e2e r3',NULL);
  INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R3_05_session','ok',
    jsonb_build_object('session',v_sess,'materialize',v_j,
      'state',(SELECT state::text FROM wms_receiving_sessions WHERE id=v_sess),
      'lines',(SELECT jsonb_agg(jsonb_build_object('expected',expected_qty,'state',line_state))
               FROM wms_receiving_lines WHERE session_id=v_sess)));

  BEGIN
    v_j := wms_capture_receiving_line(p_session_id=>v_sess,p_product_id=>v_prod,
      p_received_qty=>98,p_packaging_id=>v_pack,p_entered_qty=>98,
      p_client_scan_id=>'e2e-r3-1',p_device_id=>'e2e-sim',
      p_notes=>'2 cartons short on the trailer');
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R3_06_capture','ok',
      jsonb_build_object('rpc',v_j,'lines',(SELECT jsonb_agg(jsonb_build_object(
        'expected',expected_qty,'received',received_qty,'entered',entered_qty,'uom',uom,
        'state',line_state)) FROM wms_receiving_lines WHERE session_id=v_sess)));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R3_06_capture','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE)); END;

  BEGIN
    SELECT row_version INTO v_rv FROM wms_receiving_sessions WHERE id=v_sess;
    PERFORM wms_transition_receiving(v_sess,'captured'::wms_receiving_state,v_rv,'e2e r3',NULL);
    v_j := wms_flag_receiving_variances(v_sess);
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R3_07_variance','ok',
      jsonb_build_object('rpc',v_j,'state',(SELECT state::text FROM wms_receiving_sessions WHERE id=v_sess),
        'lines',(SELECT jsonb_agg(jsonb_build_object('state',line_state,'reason',discrepancy_reason))
                 FROM wms_receiving_lines WHERE session_id=v_sess)));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R3_07_variance','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE)); END;

  BEGIN
    SELECT row_version INTO v_rv FROM wms_receiving_sessions WHERE id=v_sess;
    v_j := wms_post_receiving_session(v_sess,v_rv,NULL);
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R3_08_post','ok',
      jsonb_build_object('rpc',v_j,'state',(SELECT state::text FROM wms_receiving_sessions WHERE id=v_sess),
        'grn',(SELECT jsonb_agg(jsonb_build_object('num',receipt_number,'status',status))
               FROM goods_receipts WHERE purchase_order_id=v_po),
        'po_received',(SELECT quantity_received FROM purchase_order_items WHERE id=v_poi),
        'po_status',(SELECT status::text FROM purchase_orders WHERE id=v_po)));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R3_08_post','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE,
        'state',(SELECT state::text FROM wms_receiving_sessions WHERE id=v_sess))); END;

  FOR v_task IN
    SELECT * FROM wms_tasks
     WHERE task_type='putaway' AND warehouse_id=c_wh
       AND state IN ('pending','available','claimed','in_progress')
     ORDER BY created_at
  LOOP
    BEGIN
      v_dest := v_task.destination_location_id;
      IF v_dest IS NULL THEN
        SELECT location_id INTO v_dest
          FROM suggest_putaway_locations(c_wh, v_task.product_id, v_task.quantity, v_task.lot_number)
         ORDER BY rank LIMIT 1;
      END IF;
      IF v_dest IS NULL THEN
        INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R3_09_putaway','error',
          jsonb_build_object('task',v_task.id,'err','no feasible destination'));
        CONTINUE;
      END IF;
      v_j := complete_putaway_task(v_task.id, v_dest, NULL);
      INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R3_09_putaway','ok',
        jsonb_build_object('task',v_task.id,'qty',v_task.quantity,'rpc',v_j,
          'dest_code',(SELECT code FROM stock_locations WHERE id=v_dest)));
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R3_09_putaway','error',
        jsonb_build_object('task',v_task.id,'err',SQLERRM,'code',SQLSTATE));
    END;
  END LOOP;

  BEGIN
    SELECT row_version INTO v_rv FROM wms_receiving_sessions WHERE id=v_sess;
    PERFORM wms_transition_receiving(v_sess,'closed'::wms_receiving_state,v_rv,'e2e r3 complete',NULL);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R3_10_close','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE)); END;

  INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R3_11_recon','ok',
    jsonb_build_object(
      'session_state',(SELECT state::text FROM wms_receiving_sessions WHERE id=v_sess),
      'movements_net',(SELECT COALESCE(SUM(quantity),0) FROM stock_movements WHERE product_id=v_prod),
      'quants',(SELECT jsonb_agg(jsonb_build_object('loc',(SELECT code FROM stock_locations l WHERE l.id=q.location_id),
        'lpn',q.lpn_id IS NOT NULL,'qty',q.quantity)) FROM stock_quants q WHERE q.product_id=v_prod),
      'products_stock_quantity',(SELECT stock_quantity FROM products WHERE id=v_prod),
      'open_putaway',(SELECT count(*) FROM wms_tasks WHERE task_type='putaway'
        AND state IN ('pending','available','claimed','in_progress')),
      'open_sessions',(SELECT jsonb_agg(jsonb_build_object('code',code,'state',state))
        FROM wms_receiving_sessions WHERE state NOT IN ('closed','cancelled')),
      'journals',(SELECT count(*) FROM journal_entries WHERE created_at > now()-interval '5 minutes'),
      'dead_letters_total',(SELECT count(*) FROM business_event_outbox_dead)));
END $sim$;