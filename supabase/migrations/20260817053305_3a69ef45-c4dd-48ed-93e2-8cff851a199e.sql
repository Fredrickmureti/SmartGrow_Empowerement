DO $sim$
DECLARE
  c_actor uuid := 'af903a2e-3ab0-43f5-b2f0-1a4000985084';
  c_biz   uuid := 'bf392ca6-a743-435c-ae41-5bf25199470d';
  c_dock  uuid := '25813126-8fcf-457e-aabe-b3bf2a070fca';
  c_carr  uuid := '68965c18-0b82-4c30-88c5-9b2e3be5759a';
  c_cust  uuid := '54709d33-f976-4c42-8f2e-f27cca6a85fd';
  c_client uuid := '60c9fed0-a72c-46ac-aed3-c2a333ae7add';
  v_appt uuid; v_so uuid; v_wave uuid; v_res jsonb; v_task record; v_line record;
  v_carton uuid; v_pack_task uuid; v_manifest uuid; v_cnt int; v_inv record;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', c_actor, 'role', 'authenticated')::text, false);
  SELECT id INTO v_so FROM public.sales_orders ORDER BY created_at DESC LIMIT 1;
  SELECT id INTO v_wave FROM public.wms_pick_waves WHERE state = 'draft' ORDER BY created_at DESC LIMIT 1;

  BEGIN
    v_appt := public.schedule_dock_appointment(
      p_dock_id => c_dock, p_type => 'outbound',
      p_window_start => now() + interval '5 minutes', p_window_end => now() + interval '3 hours',
      p_carrier_id => c_carr, p_reference => 'APPT-YARDSIM-003', p_priority => 'normal',
      p_party_contact_id => c_cust, p_trailer_ref => 'TR-SIM-003',
      p_driver_name => 'Simulated Driver', p_driver_phone => '+254700000001');
    INSERT INTO public._sim_log(step,outcome,detail) VALUES ('V-A appointment','ok',v_appt::text);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public._sim_log(step,outcome,detail) VALUES ('V-A appointment','fail',SQLSTATE||' '||SQLERRM);
  END;

  BEGIN
    INSERT INTO public._sim_log(step,outcome,detail)
    VALUES ('V-B readiness','ok', left((public.wms_wave_readiness(v_wave)->>'state'),40));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public._sim_log(step,outcome,detail) VALUES ('V-B readiness','fail',SQLSTATE||' '||SQLERRM);
  END;
  BEGIN
    v_res := public.release_pick_wave(v_wave, true);
    INSERT INTO public._sim_log(step,outcome,detail) VALUES ('V-C release','ok',left(v_res::text,300));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public._sim_log(step,outcome,detail) VALUES ('V-C release','fail',SQLSTATE||' '||SQLERRM);
  END;

  FOR v_task IN SELECT t.id, t.quantity FROM public.wms_tasks t
     WHERE t.wave_id = v_wave AND t.task_type='pick' AND t.state::text NOT IN ('completed','cancelled')
  LOOP
    BEGIN
      PERFORM public.complete_pick_task(v_task.id, COALESCE(v_task.quantity,0));
      INSERT INTO public._sim_log(step,outcome,detail) VALUES ('V-D pick','ok',v_task.quantity::text);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public._sim_log(step,outcome,detail) VALUES ('V-D pick','fail',SQLSTATE||' '||SQLERRM);
    END;
  END LOOP;
  INSERT INTO public._sim_log(step,outcome,detail) VALUES ('V-D wave','info',
    (SELECT state::text FROM public.wms_pick_waves WHERE id=v_wave));

  BEGIN
    v_carton := public.open_pack_carton(v_wave, v_so, 'CTN-SIM-003');
    INSERT INTO public._sim_log(step,outcome,detail) VALUES ('V-E carton','ok',v_carton::text);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public._sim_log(step,outcome,detail) VALUES ('V-E carton','fail',SQLSTATE||' '||SQLERRM);
  END;
  IF v_carton IS NOT NULL THEN
    FOR v_line IN SELECT id, quantity_picked FROM public.wms_pick_wave_lines
       WHERE wave_id=v_wave AND COALESCE(quantity_picked,0)>0 AND packed_carton_id IS NULL
    LOOP
      BEGIN
        PERFORM public.assign_line_to_carton(v_carton, v_line.id, v_line.quantity_picked);
      EXCEPTION WHEN OTHERS THEN
        INSERT INTO public._sim_log(step,outcome,detail) VALUES ('V-E assign','fail',SQLSTATE||' '||SQLERRM);
      END;
    END LOOP;
    BEGIN
      PERFORM public.seal_pack_carton(v_carton, 12.5, jsonb_build_object('length_cm',60,'width_cm',40,'height_cm',35));
      INSERT INTO public._sim_log(step,outcome,detail) VALUES ('V-E seal','ok',NULL);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public._sim_log(step,outcome,detail) VALUES ('V-E seal','fail',SQLSTATE||' '||SQLERRM);
    END;
    SELECT id INTO v_pack_task FROM public.wms_tasks
     WHERE wave_id=v_wave AND task_type='pack' AND state::text NOT IN ('completed','cancelled') LIMIT 1;
    IF v_pack_task IS NOT NULL THEN
      BEGIN
        PERFORM public.complete_pack_task(v_pack_task);
        INSERT INTO public._sim_log(step,outcome,detail) VALUES ('V-E pack task','ok',NULL);
      EXCEPTION WHEN OTHERS THEN
        INSERT INTO public._sim_log(step,outcome,detail) VALUES ('V-E pack task','fail',SQLSTATE||' '||SQLERRM);
      END;
    END IF;

    BEGIN
      v_manifest := public.open_loading_manifest(c_dock, c_carr, now()+interval '1 hour', v_appt);
      INSERT INTO public._sim_log(step,outcome,detail) VALUES ('V-F manifest','ok',v_manifest::text);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public._sim_log(step,outcome,detail) VALUES ('V-F manifest','fail',SQLSTATE||' '||SQLERRM);
    END;
    IF v_manifest IS NOT NULL THEN
      BEGIN PERFORM public.load_carton_onto_manifest(v_manifest, v_carton);
        INSERT INTO public._sim_log(step,outcome,detail) VALUES ('V-F load','ok',NULL);
      EXCEPTION WHEN OTHERS THEN
        INSERT INTO public._sim_log(step,outcome,detail) VALUES ('V-F load','fail',SQLSTATE||' '||SQLERRM); END;
      BEGIN PERFORM public.close_loading_manifest(v_manifest);
        INSERT INTO public._sim_log(step,outcome,detail) VALUES ('V-F close','ok',NULL);
      EXCEPTION WHEN OTHERS THEN
        INSERT INTO public._sim_log(step,outcome,detail) VALUES ('V-F close','fail',SQLSTATE||' '||SQLERRM); END;
      BEGIN PERFORM public.dispatch_loading_manifest(v_manifest, now());
        INSERT INTO public._sim_log(step,outcome,detail) VALUES ('V-F dispatch','ok',NULL);
      EXCEPTION WHEN OTHERS THEN
        INSERT INTO public._sim_log(step,outcome,detail) VALUES ('V-F dispatch','fail',SQLSTATE||' '||SQLERRM); END;
      INSERT INTO public._sim_log(step,outcome,detail) VALUES ('V-F manifest final','info',
        (SELECT state::text FROM public.wms_loading_manifests WHERE id=v_manifest));
    END IF;
  END IF;

  BEGIN
    v_cnt := public.capture_pending_billable_activities(c_biz, 500);
    INSERT INTO public._sim_log(step,outcome,detail) VALUES ('V-G capture','ok',v_cnt||' rows');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public._sim_log(step,outcome,detail) VALUES ('V-G capture','fail',SQLSTATE||' '||SQLERRM);
  END;
  INSERT INTO public._sim_log(step,outcome,detail) VALUES ('V-G priced','info',
    COALESCE((SELECT string_agg(activity||' x'||quantity||' = '||COALESCE(amount,0)||' '||COALESCE(currency,'?'),'; ')
      FROM public.wms_billable_activities WHERE business_id=c_biz AND COALESCE(amount,0)>0),'none priced'));
  BEGIN
    SELECT * INTO v_inv FROM public.generate_3pl_invoice(c_biz, c_client, CURRENT_DATE-7, CURRENT_DATE);
    INSERT INTO public._sim_log(step,outcome,detail) VALUES ('V-H invoice','ok',left(v_inv::text,300));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public._sim_log(step,outcome,detail) VALUES ('V-H invoice','fail',SQLSTATE||' '||SQLERRM);
  END;
END $sim$;