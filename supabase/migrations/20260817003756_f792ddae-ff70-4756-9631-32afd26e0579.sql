CREATE OR REPLACE FUNCTION public.receive_goods_to_wms(p_goods_receipt_id uuid, p_staging_location_id uuid, p_actor uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_gr record;
  v_line record;
  v_lpn_id uuid;
  v_lpn_code text;
  v_dest_id uuid;
  v_task_id uuid;
  v_created_tasks int := 0;
  v_created_plates int := 0;
  v_suggestion record;
  v_sug_rank int;
  v_task_ids uuid[] := ARRAY[]::uuid[];
  v_default_location uuid;
  v_actor uuid := COALESCE(auth.uid(), p_actor);
  v_relieved int;
BEGIN
  SELECT id, organization_id, business_id, branch_id, warehouse_id
    INTO v_gr
  FROM public.goods_receipts
  WHERE id = p_goods_receipt_id;
  IF v_gr.id IS NULL THEN RAISE EXCEPTION 'goods_receipt % not found', p_goods_receipt_id; END IF;
  IF v_actor IS NULL OR NOT user_can_access_business(v_actor, v_gr.business_id) THEN
    RAISE EXCEPTION 'access denied';
  END IF;

  PERFORM 1 FROM public.stock_locations
   WHERE id = p_staging_location_id AND warehouse_id = v_gr.warehouse_id AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'staging location % not in warehouse %', p_staging_location_id, v_gr.warehouse_id;
  END IF;

  SELECT id INTO v_default_location
    FROM public.stock_locations
   WHERE warehouse_id = v_gr.warehouse_id AND is_default
   LIMIT 1;

  PERFORM public.wms_ensure_default_putaway_strategies(v_gr.warehouse_id);

  FOR v_line IN
    SELECT gri.id AS line_id, gri.product_id, gri.quantity_received, gri.lot_number,
           gri.packaging_id
    FROM public.goods_receipt_items gri
    WHERE gri.goods_receipt_id = p_goods_receipt_id
      AND COALESCE(gri.quantity_received, 0) > 0
      AND NOT EXISTS (
        SELECT 1 FROM public.wms_tasks t
        WHERE t.task_type = 'putaway'
          AND (t.metadata->>'goods_receipt_item_id')::uuid = gri.id
      )
  LOOP
    v_lpn_code := 'LPN-' || to_char(now(), 'YY') || upper(substr(md5(gen_random_uuid()::text), 1, 6));
    INSERT INTO public.wms_license_plates (
      organization_id, business_id, branch_id, warehouse_id,
      code, lpn_type, status, current_location_id, created_by
    ) VALUES (
      v_gr.organization_id, v_gr.business_id, v_gr.branch_id, v_gr.warehouse_id,
      v_lpn_code, 'pallet', 'open', p_staging_location_id, v_actor
    ) RETURNING id INTO v_lpn_id;
    v_created_plates := v_created_plates + 1;

    -- The goods receipt ledger already created the balance at the warehouse
    -- default location. Staging RELOCATES it — it must never add stock again.
    IF v_default_location IS NULL THEN
      RAISE EXCEPTION 'WMS_STAGING_NO_DEFAULT_LOCATION: warehouse % has no default stock location to relieve', v_gr.warehouse_id;
    END IF;

    UPDATE public.stock_quants
       SET quantity = quantity - v_line.quantity_received,
           updated_at = now()
     WHERE product_id  = v_line.product_id
       AND location_id = v_default_location
       AND COALESCE(lot_number,'') = COALESCE(v_line.lot_number,'')
       AND package_id IS NULL
       AND lpn_id IS NULL;
    GET DIAGNOSTICS v_relieved = ROW_COUNT;

    IF v_relieved = 0 THEN
      RAISE EXCEPTION
        'WMS_STAGING_UNRELIEVED_BALANCE: no loose quant for product % (lot %) at location % to relocate onto a plate — staging would double-count receipt %',
        v_line.product_id, COALESCE(v_line.lot_number,'-'), v_default_location, p_goods_receipt_id;
    END IF;

    INSERT INTO public.stock_quants AS q (
      organization_id, business_id, branch_id,
      product_id, location_id, lot_number, package_id, lpn_id, quantity
    ) VALUES (
      v_gr.organization_id, v_gr.business_id, v_gr.branch_id,
      v_line.product_id, p_staging_location_id, v_line.lot_number,
      v_line.packaging_id, v_lpn_id, v_line.quantity_received
    )
    ON CONFLICT (
      product_id, location_id,
      COALESCE(lot_number, ''),
      COALESCE(package_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(owner_id,   '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(lpn_id,     '00000000-0000-0000-0000-000000000000'::uuid)
    ) DO UPDATE SET quantity = q.quantity + EXCLUDED.quantity, updated_at = now();

    v_dest_id := NULL; v_sug_rank := 0;

    INSERT INTO public.wms_tasks (
      organization_id, business_id, branch_id, warehouse_id,
      task_type, state, priority,
      source_doc_type, source_doc_id,
      source_location_id, destination_location_id,
      product_id, lot_number, lpn_id, quantity,
      metadata, created_by
    ) VALUES (
      v_gr.organization_id, v_gr.business_id, v_gr.branch_id, v_gr.warehouse_id,
      'putaway', 'pending', 100,
      'goods_receipt', p_goods_receipt_id,
      p_staging_location_id, NULL,
      v_line.product_id, v_line.lot_number, v_lpn_id, v_line.quantity_received,
      jsonb_build_object('goods_receipt_item_id', v_line.line_id),
      v_actor
    ) RETURNING id INTO v_task_id;
    v_created_tasks := v_created_tasks + 1;
    v_task_ids := v_task_ids || v_task_id;

    -- Putaway destination: use the canonical suggestion engine.
    -- (Previously this called a non-existent `wms_suggest_putaway_location`
    --  and wrote columns that do not exist on wms_putaway_suggestions, so
    --  every receiving post aborted with 42883 / 42703.)
    FOR v_suggestion IN
      SELECT * FROM public.suggest_putaway_locations(
        v_gr.warehouse_id, v_line.product_id, v_line.quantity_received, v_line.lot_number
      ) ORDER BY rank
    LOOP
      v_sug_rank := v_sug_rank + 1;
      IF v_dest_id IS NULL THEN v_dest_id := v_suggestion.location_id; END IF;
      INSERT INTO public.wms_putaway_suggestions (
        organization_id, business_id, branch_id,
        task_id, location_id, rank, score, reason, strategy, feasible_qty, chosen
      ) VALUES (
        v_gr.organization_id, v_gr.business_id, v_gr.branch_id,
        v_task_id, v_suggestion.location_id, v_sug_rank,
        v_suggestion.score, v_suggestion.reason, v_suggestion.strategy,
        v_suggestion.feasible_qty, (v_sug_rank = 1)
      );
    END LOOP;

    IF v_dest_id IS NOT NULL THEN
      UPDATE public.wms_tasks SET destination_location_id = v_dest_id WHERE id = v_task_id;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'tasks_created', v_created_tasks,
    'plates_created', v_created_plates,
    'task_ids', to_jsonb(v_task_ids)
  );
END;
$function$;

-- Finish the simulation session that stalled on the defect above.
DO $sim$
DECLARE
  c_wh   uuid := '62853bd5-96be-4d9d-983c-67bb4f154775';
  c_user uuid := 'af903a2e-3ab0-43f5-b2f0-1a4000985084';
  v_prod uuid;
  v_sess uuid;
  v_rv int; v_j jsonb; v_task record; v_dest uuid;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', c_user, 'role', 'authenticated')::text, true);
  SELECT id INTO v_prod FROM products WHERE sku='E2E-MILK-500' LIMIT 1;
  SELECT id INTO v_sess FROM wms_receiving_sessions
   WHERE code LIKE 'E2E-RCV-R3-%' ORDER BY created_at DESC LIMIT 1;

  BEGIN
    SELECT row_version INTO v_rv FROM wms_receiving_sessions WHERE id=v_sess;
    v_j := wms_post_receiving_session(v_sess, v_rv, NULL);
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R4_01_post','ok',
      jsonb_build_object('rpc',v_j,'state',(SELECT state::text FROM wms_receiving_sessions WHERE id=v_sess)));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R4_01_post','error',
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
      v_j := complete_putaway_task(v_task.id, v_dest, NULL);
      INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R4_02_putaway','ok',
        jsonb_build_object('task',v_task.id,'qty',v_task.quantity,'rpc',v_j,
          'dest_code',(SELECT code FROM stock_locations WHERE id=v_dest),
          'suggestions',(SELECT count(*) FROM wms_putaway_suggestions WHERE task_id=v_task.id)));
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R4_02_putaway','error',
        jsonb_build_object('task',v_task.id,'err',SQLERRM,'code',SQLSTATE));
    END;
  END LOOP;

  BEGIN
    SELECT row_version INTO v_rv FROM wms_receiving_sessions WHERE id=v_sess;
    PERFORM wms_transition_receiving(v_sess,'closed'::wms_receiving_state,v_rv,'e2e r4 complete',NULL);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R4_03_close','error',
      jsonb_build_object('err',SQLERRM,'code',SQLSTATE)); END;

  INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R4_04_recon','ok',
    jsonb_build_object(
      'session_state',(SELECT state::text FROM wms_receiving_sessions WHERE id=v_sess),
      'movements',(SELECT jsonb_agg(jsonb_build_object('type',movement_type,'qty',quantity,'ref',reference_type))
        FROM stock_movements WHERE product_id=v_prod),
      'movements_net',(SELECT COALESCE(SUM(quantity),0) FROM stock_movements WHERE product_id=v_prod),
      'quants',(SELECT jsonb_agg(jsonb_build_object('loc',(SELECT code FROM stock_locations l WHERE l.id=q.location_id),
        'lpn',q.lpn_id IS NOT NULL,'qty',q.quantity)) FROM stock_quants q WHERE q.product_id=v_prod AND q.quantity <> 0),
      'products_stock_quantity',(SELECT stock_quantity FROM products WHERE id=v_prod),
      'open_putaway',(SELECT count(*) FROM wms_tasks WHERE task_type='putaway'
        AND state IN ('pending','available','claimed','in_progress')),
      'open_sessions',(SELECT jsonb_agg(jsonb_build_object('code',code,'state',state))
        FROM wms_receiving_sessions WHERE state NOT IN ('closed','cancelled')),
      'exceptions',(SELECT jsonb_agg(jsonb_build_object('kind',kind,'state',state,'reason',reason))
        FROM wms_exceptions WHERE created_at > now()-interval '30 minutes')));
END $sim$;