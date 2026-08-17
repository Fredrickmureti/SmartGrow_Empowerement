DO $tidy$
DECLARE
  c_user uuid := 'af903a2e-3ab0-43f5-b2f0-1a4000985084';
  v_s record; v_t record; v_rv int; v_j jsonb; v_dest uuid;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', c_user, 'role', 'authenticated')::text, true);

  FOR v_s IN SELECT id, code, row_version FROM wms_receiving_sessions WHERE state = 'posted' LOOP
    BEGIN
      PERFORM wms_transition_receiving(v_s.id,'closed'::wms_receiving_state, v_s.row_version,
        'Closed after putaway completion', NULL);
      INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R6_close','ok',
        jsonb_build_object('code',v_s.code));
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R6_close','error',
        jsonb_build_object('code',v_s.code,'err',SQLERRM));
    END;
  END LOOP;

  FOR v_t IN SELECT * FROM wms_tasks
    WHERE task_type='putaway' AND state IN ('pending','available','claimed','in_progress') LOOP
    BEGIN
      v_dest := v_t.destination_location_id;
      IF v_dest IS NULL THEN
        SELECT location_id INTO v_dest
          FROM suggest_putaway_locations(v_t.warehouse_id, v_t.product_id, v_t.quantity, v_t.lot_number)
         ORDER BY rank LIMIT 1;
      END IF;
      v_j := complete_putaway_task(v_t.id, v_dest, NULL);
      INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R6_putaway','ok',
        jsonb_build_object('task',v_t.id,'rpc',v_j));
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R6_putaway','error',
        jsonb_build_object('task',v_t.id,'err',SQLERRM));
    END;
  END LOOP;

  INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R6_recon','ok',
    jsonb_build_object(
      'open_sessions',(SELECT jsonb_agg(jsonb_build_object('code',code,'state',state))
        FROM wms_receiving_sessions WHERE state NOT IN ('closed','cancelled')),
      'open_putaway',(SELECT count(*) FROM wms_tasks WHERE task_type='putaway'
        AND state IN ('pending','available','claimed','in_progress')),
      'milk_quants',(SELECT jsonb_agg(jsonb_build_object(
        'loc',(SELECT code FROM stock_locations l WHERE l.id=q.location_id),'lpn',q.lpn_id IS NOT NULL,'qty',q.quantity))
        FROM stock_quants q JOIN products p ON p.id=q.product_id
        WHERE p.sku='E2E-MILK-500' AND q.quantity <> 0)));
END $tidy$;