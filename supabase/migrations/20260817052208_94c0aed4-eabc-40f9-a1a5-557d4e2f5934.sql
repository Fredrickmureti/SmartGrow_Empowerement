CREATE TABLE IF NOT EXISTS public._sim_log (
  id bigserial primary key,
  step text not null,
  outcome text not null,
  detail text,
  at timestamptz not null default now()
);

DO $sim$
DECLARE
  c_actor uuid := 'af903a2e-3ab0-43f5-b2f0-1a4000985084';
  c_org   uuid := '8e682296-c634-44c8-ae00-bc48940ec28b';
  c_biz   uuid := 'bf392ca6-a743-435c-ae41-5bf25199470d';
  c_wh    uuid := '22782c20-a09b-449d-ad37-89cca25ab988';
  c_dock  uuid := '25813126-8fcf-457e-aabe-b3bf2a070fca';
  c_carr  uuid := '68965c18-0b82-4c30-88c5-9b2e3be5759a';
  c_cust  uuid := '54709d33-f976-4c42-8f2e-f27cca6a85fd';
  c_client uuid := '60c9fed0-a72c-46ac-aed3-c2a333ae7add';
  v_appt uuid; v_so uuid; v_wave uuid; v_res jsonb; v_task record; v_line record;
  v_carton uuid; v_pack_task uuid; v_manifest uuid; v_state text; v_rv int; v_cnt int; v_inv record;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', c_actor, 'role', 'authenticated')::text, false);

  SELECT id INTO v_so FROM public.sales_orders ORDER BY created_at DESC LIMIT 1;
  SELECT id INTO v_wave FROM public.wms_pick_waves WHERE state = 'draft' ORDER BY created_at DESC LIMIT 1;

  -- A: dock appointment
  BEGIN
    SELECT (public.schedule_dock_appointment(
      p_dock_id => c_dock, p_type => 'outbound',
      p_window_start => now() + interval '5 minutes', p_window_end => now() + interval '3 hours',
      p_carrier_id => c_carr, p_reference => 'APPT-YARDSIM-002', p_priority => 'normal',
      p_party_contact_id => c_cust, p_trailer_ref => 'TR-SIM-002', p_tractor_ref => 'KDA 123T',
      p_driver_name => 'Simulated Driver', p_driver_phone => '+254700000001',
      p_scheduled_departure => now() + interval '3 hours')).id INTO v_appt;
    INSERT INTO public._sim_log(step, outcome, detail) VALUES ('A schedule_dock_appointment','ok', v_appt::text);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public._sim_log(step, outcome, detail) VALUES ('A schedule_dock_appointment','fail', SQLSTATE||' '||SQLERRM);
  END;

  -- B: wave readiness + release
  BEGIN
    INSERT INTO public._sim_log(step, outcome, detail)
    VALUES ('B0 wave_readiness','ok', public.wms_wave_readiness(v_wave)::text);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public._sim_log(step, outcome, detail) VALUES ('B0 wave_readiness','fail', SQLSTATE||' '||SQLERRM);
  END;
  BEGIN
    v_res := public.release_pick_wave(v_wave, true);
    INSERT INTO public._sim_log(step, outcome, detail) VALUES ('B1 release_pick_wave','ok', v_res::text);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public._sim_log(step, outcome, detail) VALUES ('B1 release_pick_wave','fail', SQLSTATE||' '||SQLERRM);
  END;

  -- C: picking
  FOR v_task IN
    SELECT id, quantity FROM public.wms_tasks
     WHERE task_type = 'pick' AND (metadata->>'wave_id')::uuid = v_wave
       AND state NOT IN ('completed','cancelled')
  LOOP
    BEGIN
      PERFORM public.complete_pick_task(v_task.id, COALESCE(v_task.quantity,0));
      INSERT INTO public._sim_log(step, outcome, detail) VALUES ('C complete_pick_task','ok', v_task.id::text||' qty='||v_task.quantity);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public._sim_log(step, outcome, detail) VALUES ('C complete_pick_task','fail', SQLSTATE||' '||SQLERRM);
    END;
  END LOOP;
  INSERT INTO public._sim_log(step, outcome, detail)
  VALUES ('C wave state','info', (SELECT state::text FROM public.wms_pick_waves WHERE id = v_wave));

  -- D: pack
  BEGIN
    SELECT (public.open_pack_carton(v_wave, v_so, 'CTN-SIM-002')).id INTO v_carton;
    INSERT INTO public._sim_log(step, outcome, detail) VALUES ('D1 open_pack_carton','ok', v_carton::text);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public._sim_log(step, outcome, detail) VALUES ('D1 open_pack_carton','fail', SQLSTATE||' '||SQLERRM);
  END;
  IF v_carton IS NOT NULL THEN
    FOR v_line IN
      SELECT id, quantity_picked FROM public.wms_pick_wave_lines
       WHERE wave_id = v_wave AND COALESCE(quantity_picked,0) > 0 AND packed_carton_id IS NULL
    LOOP
      BEGIN
        PERFORM public.assign_line_to_carton(v_carton, v_line.id, v_line.quantity_picked);
        INSERT INTO public._sim_log(step, outcome, detail) VALUES ('D2 assign_line_to_carton','ok', v_line.id::text);
      EXCEPTION WHEN OTHERS THEN
        INSERT INTO public._sim_log(step, outcome, detail) VALUES ('D2 assign_line_to_carton','fail', SQLSTATE||' '||SQLERRM);
      END;
    END LOOP;
    BEGIN
      PERFORM public.seal_pack_carton(v_carton, 12.5, jsonb_build_object('length_cm',60,'width_cm',40,'height_cm',35));
      INSERT INTO public._sim_log(step, outcome, detail) VALUES ('D3 seal_pack_carton','ok', NULL);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public._sim_log(step, outcome, detail) VALUES ('D3 seal_pack_carton','fail', SQLSTATE||' '||SQLERRM);
    END;
  END IF;
  SELECT id INTO v_pack_task FROM public.wms_tasks
   WHERE task_type = 'pack' AND (metadata->>'wave_id')::uuid = v_wave
     AND state NOT IN ('completed','cancelled') LIMIT 1;
  IF v_pack_task IS NULL THEN
    INSERT INTO public._sim_log(step, outcome, detail) VALUES ('D4 pack task','info','no open pack task found');
  ELSE
    BEGIN
      PERFORM public.complete_pack_task(v_pack_task);
      INSERT INTO public._sim_log(step, outcome, detail) VALUES ('D4 complete_pack_task','ok', v_pack_task::text);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public._sim_log(step, outcome, detail) VALUES ('D4 complete_pack_task','fail', SQLSTATE||' '||SQLERRM);
    END;
  END IF;

  -- E: manifest
  BEGIN
    SELECT (public.open_loading_manifest(c_dock, c_carr, now() + interval '1 hour', v_appt)).id INTO v_manifest;
    INSERT INTO public._sim_log(step, outcome, detail) VALUES ('E1 open_loading_manifest','ok', v_manifest::text);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public._sim_log(step, outcome, detail) VALUES ('E1 open_loading_manifest','fail', SQLSTATE||' '||SQLERRM);
  END;
  IF v_manifest IS NOT NULL THEN
    SELECT state::text, row_version INTO v_state, v_rv FROM public.wms_loading_manifests WHERE id = v_manifest;
    INSERT INTO public._sim_log(step, outcome, detail) VALUES ('E1 manifest state','info', v_state);
    IF v_state = 'draft' THEN
      BEGIN
        PERFORM public.wms_transition_manifest(v_manifest, 'loading'::public.wms_manifest_state, v_rv, 'simulation', NULL);
        INSERT INTO public._sim_log(step, outcome, detail) VALUES ('E2 transition->loading','ok', NULL);
      EXCEPTION WHEN OTHERS THEN
        INSERT INTO public._sim_log(step, outcome, detail) VALUES ('E2 transition->loading','fail', SQLSTATE||' '||SQLERRM);
      END;
    END IF;
    IF v_carton IS NOT NULL THEN
      BEGIN
        PERFORM public.load_carton_onto_manifest(v_manifest, v_carton);
        INSERT INTO public._sim_log(step, outcome, detail) VALUES ('E3 load_carton_onto_manifest','ok', NULL);
      EXCEPTION WHEN OTHERS THEN
        INSERT INTO public._sim_log(step, outcome, detail) VALUES ('E3 load_carton_onto_manifest','fail', SQLSTATE||' '||SQLERRM);
      END;
    END IF;
    BEGIN
      PERFORM public.close_loading_manifest(v_manifest);
      INSERT INTO public._sim_log(step, outcome, detail) VALUES ('E4 close_loading_manifest','ok', NULL);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public._sim_log(step, outcome, detail) VALUES ('E4 close_loading_manifest','fail', SQLSTATE||' '||SQLERRM);
    END;
    BEGIN
      PERFORM public.dispatch_loading_manifest(v_manifest, now());
      INSERT INTO public._sim_log(step, outcome, detail) VALUES ('E5 dispatch_loading_manifest','ok', NULL);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public._sim_log(step, outcome, detail) VALUES ('E5 dispatch_loading_manifest','fail', SQLSTATE||' '||SQLERRM);
    END;
    INSERT INTO public._sim_log(step, outcome, detail) VALUES ('E manifest final','info',
      (SELECT state::text FROM public.wms_loading_manifests WHERE id = v_manifest));
  END IF;

  -- F: 3PL billing
  BEGIN
    v_cnt := public.capture_pending_billable_activities(c_biz, 500);
    INSERT INTO public._sim_log(step, outcome, detail) VALUES ('F1 capture_pending','ok', v_cnt||' rows');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public._sim_log(step, outcome, detail) VALUES ('F1 capture_pending','fail', SQLSTATE||' '||SQLERRM);
  END;
  INSERT INTO public._sim_log(step, outcome, detail) VALUES ('F1b billable events matchable','info',
    (SELECT count(*)::text FROM public.business_event_outbox o
      WHERE o.event_type LIKE 'warehouse.%'
        AND public._wms_map_event_to_activity(o.event_type, o.payload) IS NOT NULL));
  INSERT INTO public._sim_log(step, outcome, detail) VALUES ('F1c same but org_id=business_id','info',
    (SELECT count(*)::text FROM public.business_event_outbox o
      WHERE o.org_id = c_biz AND o.event_type LIKE 'warehouse.%'
        AND public._wms_map_event_to_activity(o.event_type, o.payload) IS NOT NULL));
  BEGIN
    v_cnt := public.wms_accrue_storage_days(c_biz, CURRENT_DATE - 1);
    INSERT INTO public._sim_log(step, outcome, detail) VALUES ('F2 accrue_storage_days','ok', v_cnt||' rows');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public._sim_log(step, outcome, detail) VALUES ('F2 accrue_storage_days','fail', SQLSTATE||' '||SQLERRM);
  END;
  BEGIN
    SELECT * INTO v_inv FROM public.generate_3pl_invoice(c_biz, c_client, CURRENT_DATE - 7, CURRENT_DATE);
    INSERT INTO public._sim_log(step, outcome, detail) VALUES ('F3 generate_3pl_invoice','ok',
      v_inv.invoice_number||' '||v_inv.currency||' '||v_inv.total);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public._sim_log(step, outcome, detail) VALUES ('F3 generate_3pl_invoice','fail', SQLSTATE||' '||SQLERRM);
  END;
END $sim$;