DO $sim$
DECLARE
  c_actor uuid := 'af903a2e-3ab0-43f5-b2f0-1a4000985084';
  c_org   uuid := '8e682296-c634-44c8-ae00-bc48940ec28b';
  c_biz   uuid := 'bf392ca6-a743-435c-ae41-5bf25199470d';
  c_wh    uuid := '22782c20-a09b-449d-ad37-89cca25ab988';
  c_dock  uuid := '25813126-8fcf-457e-aabe-b3bf2a070fca';
  c_carr  uuid := '68965c18-0b82-4c30-88c5-9b2e3be5759a';
  c_cust  uuid := '54709d33-f976-4c42-8f2e-f27cca6a85fd';
  c_prod  uuid := '58e15e40-ae2c-4661-9b92-fa23744c99dc';
  c_client uuid := '60c9fed0-a72c-46ac-aed3-c2a333ae7add';
  v_branch uuid;
  v_appt uuid;
  v_visit uuid;
  v_slot uuid;
  v_so uuid;
  v_wave uuid;
  v_res jsonb;
  v_task record;
  v_line record;
  v_carton uuid;
  v_pack_task uuid;
  v_manifest uuid;
  v_state text;
  v_rv int;
  v_cnt int;
  v_inv record;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', c_actor, 'role', 'authenticated')::text, false);
  SELECT branch_id INTO v_branch FROM public.warehouses WHERE id = c_wh;
  RAISE NOTICE '=== SIM start: actor=% business=% warehouse=% branch=%', c_actor, c_biz, c_wh, v_branch;

  ---------------------------------------------------------------- seed: yard slots
  INSERT INTO public.wms_yard_slots (organization_id, business_id, warehouse_id, code, slot_type, zone_kind, sequence, created_by)
  SELECT c_org, c_biz, c_wh, x.code, 'either', x.zk, x.sq, c_actor
  FROM (VALUES ('YS-01','parking_bay',1), ('YS-02','waiting_lane',2)) x(code, zk, sq)
  WHERE NOT EXISTS (SELECT 1 FROM public.wms_yard_slots s WHERE s.warehouse_id = c_wh AND s.code = x.code);
  RAISE NOTICE 'yard slots ready: %', (SELECT count(*) FROM public.wms_yard_slots WHERE warehouse_id = c_wh);

  ---------------------------------------------------------------- seed: 3PL tariffs (KES = base currency)
  INSERT INTO public.wms_billing_tariffs (business_id, client_id, activity, uom, rate, currency, effective_from, notes, created_by)
  SELECT c_biz, c_client, t.activity, t.uom, t.rate, 'KES', CURRENT_DATE - 7, 'yard/outbound simulation price list', c_actor
  FROM (VALUES
    ('pick_line','line',45),('pack_package','package',120),('dispatch_shipment','shipment',1500),
    ('yard_dwell','hour',800),('receive_lpn','lpn',250),('putaway','move',100),('storage_lpn_day','lpn_day',30)
  ) t(activity, uom, rate)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.wms_billing_tariffs b
     WHERE b.business_id = c_biz AND b.client_id = c_client AND b.activity = t.activity);
  RAISE NOTICE 'tariffs ready: %', (SELECT count(*) FROM public.wms_billing_tariffs WHERE business_id = c_biz);

  ---------------------------------------------------------------- seed: customer order
  SELECT id INTO v_so FROM public.sales_orders
   WHERE business_id = c_biz AND notes = 'Yard/outbound/3PL simulation order'
   ORDER BY created_at DESC LIMIT 1;
  IF v_so IS NULL THEN
    BEGIN
      v_res := public.create_sales_order_atomic(
        jsonb_build_object(
          'organization_id', c_org, 'business_id', c_biz, 'branch_id', v_branch,
          'warehouse_id', c_wh, 'contact_id', c_cust, 'currency', 'KES',
          'status', 'draft', 'order_date', CURRENT_DATE,
          'notes', 'Yard/outbound/3PL simulation order'),
        jsonb_build_array(jsonb_build_object(
          'product_id', c_prod, 'description', 'SIM Fresh Milk 500ml',
          'quantity', 120, 'unit_price', 60)),
        c_actor, 'yardsim-so-001');
      v_so := COALESCE(NULLIF(v_res->>'sales_order_id','')::uuid, NULLIF(v_res->>'id','')::uuid);
      RAISE NOTICE 'STEP0 create_sales_order_atomic -> %', v_res;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'STEP0 create_sales_order_atomic FAILED: %', SQLERRM;
    END;
  END IF;
  IF v_so IS NOT NULL THEN
    BEGIN
      PERFORM public.confirm_sales_order_atomic(v_so, c_actor);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'STEP0 confirm_sales_order_atomic FAILED: %', SQLERRM;
    END;
  END IF;
  RAISE NOTICE 'STEP0 sales order=% status=%', v_so,
    (SELECT status FROM public.sales_orders WHERE id = v_so);

  ---------------------------------------------------------------- step 1: book the dock appointment
  SELECT id INTO v_appt FROM public.wms_dock_appointments
   WHERE business_id = c_biz AND reference = 'APPT-YARDSIM-001';
  IF v_appt IS NULL THEN
    BEGIN
      SELECT (public.schedule_dock_appointment(
        p_dock_id => c_dock, p_type => 'outbound',
        p_window_start => now() + interval '5 minutes', p_window_end => now() + interval '3 hours',
        p_carrier_id => c_carr, p_reference => 'APPT-YARDSIM-001', p_priority => 'normal',
        p_party_contact_id => c_cust, p_trailer_ref => 'TR-SIM-001', p_tractor_ref => 'KDA 123T',
        p_driver_name => 'Simulated Driver', p_driver_phone => '+254700000001',
        p_scheduled_departure => now() + interval '3 hours')).id INTO v_appt;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'STEP1 schedule_dock_appointment FAILED: %', SQLERRM;
    END;
  END IF;
  RAISE NOTICE 'STEP1 appointment=% state=%', v_appt,
    (SELECT state FROM public.wms_dock_appointments WHERE id = v_appt);

  ---------------------------------------------------------------- step 2: gate check-in
  SELECT id INTO v_visit FROM public.wms_trailer_visits
   WHERE warehouse_id = c_wh AND trailer_ref = 'TR-SIM-001' AND status <> 'departed'
   ORDER BY created_at DESC LIMIT 1;
  IF v_visit IS NULL THEN
    BEGIN
      PERFORM public.gate_check_in(
        p_warehouse_id => c_wh, p_trailer_ref => 'TR-SIM-001', p_qr_token => NULL,
        p_appointment_id => v_appt, p_carrier_id => c_carr,
        p_driver_name => 'Simulated Driver', p_driver_phone => '+254700000001',
        p_seal_in => 'SEAL-IN-77120', p_identity_kind => 'national_id', p_identity_ref => 'ID-SIM-001');
      SELECT id INTO v_visit FROM public.wms_trailer_visits
       WHERE warehouse_id = c_wh AND trailer_ref = 'TR-SIM-001'
       ORDER BY created_at DESC LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'STEP2 gate_check_in FAILED: %', SQLERRM;
    END;
  END IF;
  SELECT status, yard_slot_id INTO v_state, v_slot FROM public.wms_trailer_visits WHERE id = v_visit;
  RAISE NOTICE 'STEP2 visit=% status=% slot=% appt_state=%', v_visit, v_state, v_slot,
    (SELECT state FROM public.wms_dock_appointments WHERE id = v_appt);

  ---------------------------------------------------------------- step 3: bring the trailer to the dock
  BEGIN
    PERFORM public.assign_trailer_to_dock(v_visit, c_dock);
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'STEP3 assign_trailer_to_dock FAILED: %', SQLERRM;
  END;
  RAISE NOTICE 'STEP3 visit status=% dock=% appt_state=%',
    (SELECT status FROM public.wms_trailer_visits WHERE id = v_visit),
    (SELECT dock_id FROM public.wms_trailer_visits WHERE id = v_visit),
    (SELECT state FROM public.wms_dock_appointments WHERE id = v_appt);

  ---------------------------------------------------------------- step 4: wave create + release
  SELECT id INTO v_wave FROM public.wms_pick_waves
   WHERE business_id = c_biz AND notes = 'SIM yard/outbound wave' ORDER BY created_at DESC LIMIT 1;
  IF v_wave IS NULL THEN
    BEGIN
      v_res := public.create_pick_wave(c_wh, ARRAY[v_so], 'SIM yard/outbound wave');
      v_wave := (v_res->>'wave_id')::uuid;
      RAISE NOTICE 'STEP4a create_pick_wave -> %', v_res;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'STEP4a create_pick_wave FAILED: %', SQLERRM;
    END;
  END IF;
  IF v_wave IS NOT NULL THEN
    BEGIN
      v_res := public.release_pick_wave(v_wave, true);
      RAISE NOTICE 'STEP4b release_pick_wave -> %', v_res;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'STEP4b release_pick_wave FAILED: %', SQLERRM;
    END;
  END IF;
  RAISE NOTICE 'STEP4 wave=% state=%', v_wave,
    (SELECT state FROM public.wms_pick_waves WHERE id = v_wave);

  ---------------------------------------------------------------- step 5: pick every task
  FOR v_task IN
    SELECT id, quantity FROM public.wms_tasks
     WHERE task_type = 'pick' AND (metadata->>'wave_id')::uuid = v_wave
       AND state NOT IN ('completed','cancelled')
  LOOP
    BEGIN
      PERFORM public.complete_pick_task(v_task.id, COALESCE(v_task.quantity, 0));
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'STEP5 complete_pick_task % FAILED: %', v_task.id, SQLERRM;
    END;
  END LOOP;
  RAISE NOTICE 'STEP5 wave state=% picked=%',
    (SELECT state FROM public.wms_pick_waves WHERE id = v_wave),
    (SELECT sum(quantity_picked) FROM public.wms_pick_wave_lines WHERE wave_id = v_wave);

  ---------------------------------------------------------------- step 6: pack + seal
  SELECT id INTO v_carton FROM public.wms_pack_cartons
   WHERE wave_id = v_wave AND sales_order_id = v_so ORDER BY created_at LIMIT 1;
  IF v_carton IS NULL THEN
    BEGIN
      SELECT (public.open_pack_carton(v_wave, v_so, 'CTN-SIM-001')).id INTO v_carton;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'STEP6a open_pack_carton FAILED: %', SQLERRM;
    END;
  END IF;
  IF v_carton IS NOT NULL THEN
    FOR v_line IN
      SELECT id, quantity_picked FROM public.wms_pick_wave_lines
       WHERE wave_id = v_wave AND sales_order_id = v_so
         AND COALESCE(quantity_picked,0) > 0 AND packed_carton_id IS NULL
    LOOP
      BEGIN
        PERFORM public.assign_line_to_carton(v_carton, v_line.id, v_line.quantity_picked);
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'STEP6b assign_line_to_carton % FAILED: %', v_line.id, SQLERRM;
      END;
    END LOOP;
    BEGIN
      PERFORM public.seal_pack_carton(v_carton, 12.5,
        jsonb_build_object('length_cm', 60, 'width_cm', 40, 'height_cm', 35));
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'STEP6c seal_pack_carton FAILED: %', SQLERRM;
    END;
  END IF;
  SELECT id INTO v_pack_task FROM public.wms_tasks
   WHERE task_type = 'pack' AND (metadata->>'wave_id')::uuid = v_wave
     AND state NOT IN ('completed','cancelled') LIMIT 1;
  IF v_pack_task IS NOT NULL THEN
    BEGIN
      PERFORM public.complete_pack_task(v_pack_task);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'STEP6d complete_pack_task FAILED: %', SQLERRM;
    END;
  END IF;
  RAISE NOTICE 'STEP6 carton=% sealed=% wave state=%', v_carton,
    (SELECT sealed_at IS NOT NULL FROM public.wms_pack_cartons WHERE id = v_carton),
    (SELECT state FROM public.wms_pick_waves WHERE id = v_wave);

  ---------------------------------------------------------------- step 7: manifest open → load → close → dispatch
  BEGIN
    SELECT (public.open_loading_manifest(c_dock, c_carr, now() + interval '1 hour', v_appt)).id INTO v_manifest;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'STEP7a open_loading_manifest FAILED: %', SQLERRM;
  END;
  IF v_manifest IS NOT NULL THEN
    SELECT state::text, row_version INTO v_state, v_rv FROM public.wms_loading_manifests WHERE id = v_manifest;
    RAISE NOTICE 'STEP7a manifest=% state=%', v_manifest, v_state;
    IF v_state = 'draft' THEN
      BEGIN
        PERFORM public.wms_transition_manifest(v_manifest, 'loading'::public.wms_manifest_state, v_rv, 'simulation', NULL);
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'STEP7b wms_transition_manifest(loading) FAILED: %', SQLERRM;
      END;
    END IF;
    BEGIN
      PERFORM public.load_carton_onto_manifest(v_manifest, v_carton);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'STEP7c load_carton_onto_manifest FAILED: %', SQLERRM;
    END;
    BEGIN
      PERFORM public.close_loading_manifest(v_manifest);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'STEP7d close_loading_manifest FAILED: %', SQLERRM;
    END;
    BEGIN
      PERFORM public.dispatch_loading_manifest(v_manifest, now());
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'STEP7e dispatch_loading_manifest FAILED: %', SQLERRM;
    END;
    RAISE NOTICE 'STEP7 manifest state=% cartons=%',
      (SELECT state FROM public.wms_loading_manifests WHERE id = v_manifest),
      (SELECT count(*) FROM public.wms_manifest_cartons WHERE manifest_id = v_manifest);
  END IF;

  ---------------------------------------------------------------- step 8: gate out
  RAISE NOTICE 'STEP8 departure blockers=%', public.trailer_departure_blockers(v_visit);
  BEGIN
    PERFORM public.approve_trailer_departure(v_visit, 'simulation: supervisor override after dispatch');
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'STEP8a approve_trailer_departure FAILED: %', SQLERRM;
  END;
  BEGIN
    PERFORM public.gate_exit(v_visit, 'SEAL-OUT-88431', 'simulation gate out');
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'STEP8b gate_exit FAILED: %', SQLERRM;
  END;
  RAISE NOTICE 'STEP8 visit status=% dwell_min=% appt_state=%',
    (SELECT status FROM public.wms_trailer_visits WHERE id = v_visit),
    (SELECT round(dwell_minutes, 2) FROM public.wms_trailer_visits WHERE id = v_visit),
    (SELECT state FROM public.wms_dock_appointments WHERE id = v_appt);

  ---------------------------------------------------------------- step 9: what landed in the outbox
  RAISE NOTICE 'STEP9 outbox rows in this run: %', (
    SELECT jsonb_agg(jsonb_build_object('t', event_type, 'scope', handler_scope, 'st', status, 'org_id', org_id)
                     ORDER BY created_at)
      FROM public.business_event_outbox
     WHERE created_at > now() - interval '10 minutes' AND event_type LIKE 'warehouse.%');

  ---------------------------------------------------------------- step 10: 3PL capture + invoice
  BEGIN
    v_cnt := public.capture_pending_billable_activities(c_biz, 500);
    RAISE NOTICE 'STEP10a capture_pending_billable_activities -> % rows', v_cnt;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'STEP10a capture FAILED: %', SQLERRM;
  END;
  BEGIN
    v_cnt := public.wms_accrue_storage_days(c_biz, CURRENT_DATE - 1);
    RAISE NOTICE 'STEP10b wms_accrue_storage_days -> % rows', v_cnt;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'STEP10b storage accrual FAILED: %', SQLERRM;
  END;
  RAISE NOTICE 'STEP10c billable activities for business: % (unbilled priced: %)',
    (SELECT count(*) FROM public.wms_billable_activities WHERE business_id = c_biz),
    (SELECT count(*) FROM public.wms_billable_activities WHERE business_id = c_biz AND invoice_id IS NULL AND tariff_id IS NOT NULL);
  BEGIN
    SELECT * INTO v_inv FROM public.generate_3pl_invoice(c_biz, c_client, CURRENT_DATE - 7, CURRENT_DATE);
    RAISE NOTICE 'STEP10d invoice=% total=% currency=%', v_inv.invoice_number, v_inv.total, v_inv.currency;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'STEP10d generate_3pl_invoice FAILED: %', SQLERRM;
  END;

  RAISE NOTICE '=== SIM end';
END $sim$;