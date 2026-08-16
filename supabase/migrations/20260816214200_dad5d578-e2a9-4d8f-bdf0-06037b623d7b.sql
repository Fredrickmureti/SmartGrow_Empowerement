TRUNCATE public._pret_sim_log;

DO $sim$
DECLARE
  v_uid uuid := 'af903a2e-3ab0-43f5-b2f0-1a4000985084';
  v_org uuid := '8e682296-c634-44c8-ae00-bc48940ec28b';
  v_biz uuid := 'bf392ca6-a743-435c-ae41-5bf25199470d';
  v_branch uuid := 'aeb86a80-af26-437b-a033-e95615fdaa28';
  v_wh uuid := '22782c20-a09b-449d-ad37-89cca25ab988';
  v_vendor uuid := '54709d33-f976-4c42-8f2e-f27cca6a85fd';
  v_product uuid := '945ab89f-24d2-4279-88dd-5613bee9700d';
  v_pack uuid := 'd47cdfc7-34a2-4670-9120-7170701c60a4';
  v_duom uuid := '8a1504de-0f82-40bf-8eed-68862ded24b6';
  v_po uuid; v_poi uuid; v_grn uuid; v_pr uuid; v_ver int;
  v_res jsonb; v_line record; v_log jsonb := '[]'::jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);

  BEGIN
    INSERT INTO public.purchase_orders(organization_id, business_id, branch_id, vendor_id,
        po_number, status, order_date, currency, deliver_to_warehouse_id, created_by)
    VALUES (v_org, v_biz, v_branch, v_vendor,
        'PO-SIM-' || to_char(now(),'YYYYMMDDHH24MISS'), 'approved', CURRENT_DATE, 'KES', v_wh, v_uid)
    RETURNING id INTO v_po;

    INSERT INTO public.purchase_order_items(purchase_order_id, product_id, description,
        display_quantity, packaging_id, display_uom_id, unit_price, sort_order)
    VALUES (v_po, v_product, 'Sugar (simulation)', 2, v_pack, v_duom, 120, 1)
    RETURNING id INTO v_poi;

    v_res := public.create_goods_receipt(v_biz, v_po,
      jsonb_build_array(jsonb_build_object(
        'purchase_order_item_id', v_poi,
        'product_id', v_product,
        'display_quantity', 2)),
      v_uid, v_wh, NULL, CURRENT_DATE);
    v_log := v_log || jsonb_build_array(jsonb_build_object('step','receipt','detail',v_res));
    v_grn := (v_res->>'goods_receipt_id')::uuid;

    FOR v_line IN SELECT * FROM public.purchase_return_returnable_lines(v_grn) LOOP
      v_log := v_log || jsonb_build_array(jsonb_build_object('step','returnable','detail',to_jsonb(v_line)));
    END LOOP;
    SELECT * INTO v_line FROM public.purchase_return_returnable_lines(v_grn) LIMIT 1;

    v_res := public.purchase_return_create(v_biz, v_vendor,
      jsonb_build_array(jsonb_build_object(
        'goods_receipt_item_id', v_line.goods_receipt_item_id,
        'product_id', v_line.product_id,
        'description', v_line.description,
        'display_quantity', 1,
        'packaging_id', v_pack,
        'display_uom_id', v_duom,
        'quantity', 50,
        'return_reason', 'damaged')),
      'goods', v_grn, NULL, v_wh, CURRENT_DATE, 'damaged', 'Simulated damaged bag', NULL);
    v_log := v_log || jsonb_build_array(jsonb_build_object('step','create','detail',v_res));
    v_pr := (v_res->>'id')::uuid;

    SELECT row_version INTO v_ver FROM public.purchase_returns WHERE id = v_pr;
    v_res := public.purchase_return_submit(v_pr, v_ver);
    v_log := v_log || jsonb_build_array(jsonb_build_object('step','submit','detail',v_res,
      'status',(SELECT status FROM public.purchase_returns WHERE id=v_pr)));

    IF (SELECT status FROM public.purchase_returns WHERE id = v_pr) = 'submitted' THEN
      SELECT row_version INTO v_ver FROM public.purchase_returns WHERE id = v_pr;
      v_res := public.purchase_return_approve(v_pr, v_ver, 'Simulation approval');
      v_log := v_log || jsonb_build_array(jsonb_build_object('step','approve','detail',v_res));
    END IF;

    IF (SELECT status FROM public.purchase_returns WHERE id = v_pr) = 'approved' THEN
      SELECT row_version INTO v_ver FROM public.purchase_returns WHERE id = v_pr;
      v_res := public.purchase_return_dispatch(v_pr, v_ver, CURRENT_DATE, 'SIM-TRACK-1');
      v_log := v_log || jsonb_build_array(jsonb_build_object('step','dispatch','detail',v_res));

      SELECT row_version INTO v_ver FROM public.purchase_returns WHERE id = v_pr;
      v_res := public.purchase_return_acknowledge(v_pr, v_ver, 'RMA-SIM-1', NULL);
      v_log := v_log || jsonb_build_array(jsonb_build_object('step','acknowledge','detail',v_res));

      SELECT row_version INTO v_ver FROM public.purchase_returns WHERE id = v_pr;
      v_res := public.purchase_return_raise_credit(v_pr, v_ver);
      v_log := v_log || jsonb_build_array(jsonb_build_object('step','credit','detail',v_res));
    END IF;

    v_log := v_log || jsonb_build_array(jsonb_build_object('step','final',
      'detail', (SELECT jsonb_build_object('return_number', r.return_number, 'status', r.status,
                        'subtotal', r.subtotal, 'total', r.total)
                   FROM public.purchase_returns r WHERE r.id = v_pr)));
  EXCEPTION WHEN OTHERS THEN
    v_log := v_log || jsonb_build_array(jsonb_build_object('step','error','detail',
      jsonb_build_object('sqlstate', SQLSTATE, 'message', SQLERRM)));
  END;

  INSERT INTO public._pret_sim_log(step, ok, detail)
  VALUES ('run', true, v_log || jsonb_build_array(jsonb_build_object('step','ids',
    'detail', jsonb_build_object('po', v_po, 'grn', v_grn, 'pr', v_pr))));
END
$sim$;