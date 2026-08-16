DO $mig$
DECLARE
  v_org   uuid := '8e682296-c634-44c8-ae00-bc48940ec28b';
  v_biz   uuid := 'bf392ca6-a743-435c-ae41-5bf25199470d';
  v_branch uuid := 'aeb86a80-af26-437b-a033-e95615fdaa28';
  v_actor uuid := 'af903a2e-3ab0-43f5-b2f0-1a4000985084';
  v_cable uuid := '86a5fec4-799c-4218-a932-1d9f46f3ca87';
  v_uom   uuid := 'a15c992e-dcee-40e6-8232-c2cb78abcaf8';
  v_hq    uuid := '22782c20-a09b-449d-ad37-89cca25ab988';
  v_nkr   uuid := '62853bd5-96be-4d9d-983c-67bb4f154775';
  v_tr    uuid;
  v_tri   uuid;
  v_res   jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_actor, 'role', 'authenticated')::text, true);

  INSERT INTO public.stock_transfers (
    organization_id, business_id, transfer_number, from_warehouse_id, to_warehouse_id,
    from_branch_id, to_branch_id, status, transfer_date, requested_by, notes
  ) VALUES (
    v_org, v_biz, public.get_next_transfer_number(v_org), v_hq, v_nkr,
    v_branch, v_branch, 'draft', CURRENT_DATE, v_actor,
    'Phase F2 — drain legacy layer so the new receipt spans two warehouses'
  ) RETURNING id INTO v_tr;

  INSERT INTO public.stock_transfer_items (
    transfer_id, product_id, quantity_requested, quantity_sent, branch_id,
    display_uom_id, display_quantity, uom_snapshot, uom_snapshot_base_code, uom_snapshot_factor
  ) VALUES (
    v_tr, v_cable, 96.5, 96.5, v_branch, v_uom, 96.5, 'PCE', 'PCE', 1
  ) RETURNING id INTO v_tri;

  UPDATE public.stock_transfers SET status = 'pending' WHERE id = v_tr;

  v_res := public.approve_stock_transfer_atomic(v_tr, v_actor);
  IF NOT COALESCE((v_res->>'success')::boolean, false) THEN
    RAISE EXCEPTION 'transfer approval failed: %', v_res;
  END IF;

  v_res := public.complete_stock_transfer_atomic(
    v_tr,
    jsonb_build_array(jsonb_build_object('id', v_tri, 'quantity_received', 96.5)),
    v_actor);
  IF NOT COALESCE((v_res->>'success')::boolean, false) THEN
    RAISE EXCEPTION 'transfer completion failed: %', v_res;
  END IF;
END $mig$;