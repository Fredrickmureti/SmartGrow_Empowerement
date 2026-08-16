DO $mig$
DECLARE
  v_org   uuid := '8e682296-c634-44c8-ae00-bc48940ec28b';
  v_biz   uuid := 'bf392ca6-a743-435c-ae41-5bf25199470d';
  v_branch uuid := 'aeb86a80-af26-437b-a033-e95615fdaa28';
  v_actor uuid := 'af903a2e-3ab0-43f5-b2f0-1a4000985084';
  v_vendor uuid := '54709d33-f976-4c42-8f2e-f27cca6a85fd';
  v_cable uuid := '86a5fec4-799c-4218-a932-1d9f46f3ca87';
  v_uom   uuid := 'a15c992e-dcee-40e6-8232-c2cb78abcaf8';
  v_hq    uuid := '22782c20-a09b-449d-ad37-89cca25ab988';
  v_wh_b  uuid;
  v_po    uuid;
  v_poi   uuid;
  v_num   text;
  v_res   jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_actor, 'role', 'authenticated')::text, true);
  ---------------------------------------------------------------- warehouse B
  SELECT id INTO v_wh_b FROM public.warehouses
   WHERE business_id = v_biz AND code = 'WH-NKR';

  IF v_wh_b IS NULL THEN
    INSERT INTO public.warehouses (organization_id, business_id, branch_id, code, name,
                                   city, country, is_active, is_default)
    VALUES (v_org, v_biz, v_branch, 'WH-NKR', 'Nakuru Depot', 'Nakuru', 'KE', true, false)
    RETURNING id INTO v_wh_b;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.stock_locations
                  WHERE warehouse_id = v_wh_b AND is_default) THEN
    INSERT INTO public.stock_locations (organization_id, business_id, branch_id, warehouse_id,
                                        code, name, is_default, created_by)
    VALUES (v_org, v_biz, v_branch, v_wh_b, 'NKR-DEFAULT', 'Nakuru Default', true, v_actor);
  END IF;

  RAISE NOTICE 'warehouse B = %', v_wh_b;

  ------------------------------------------------------------------------ PO
  v_num := public.get_next_po_number(v_org);

  INSERT INTO public.purchase_orders (
    organization_id, business_id, branch_id, po_number, vendor_id, status,
    order_date, currency, exchange_rate, subtotal, tax_amount, total,
    created_by, deliver_to_warehouse_id
  ) VALUES (
    v_org, v_biz, v_branch, v_num, v_vendor, 'draft',
    CURRENT_DATE, 'KES', 1, 5000.00, 0, 5000.00, v_actor, v_hq
  ) RETURNING id INTO v_po;

  INSERT INTO public.purchase_order_items (
    purchase_order_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, line_total, sort_order,
    display_uom_id, display_quantity, uom_snapshot, uom_snapshot_base_code, uom_snapshot_factor
  ) VALUES (
    v_po, v_cable, 'Cable', 100, 50.00, 0, 0, 5000.00, 0,
    v_uom, 100, 'PCE', 'PCE', 1
  ) RETURNING id INTO v_poi;

  PERFORM public.submit_purchase_order(v_po);
  PERFORM public.approve_purchase_order(v_po, 'f2-seed-' || v_po::text);

  ----------------------------------------------------------------------- GRN
  v_res := public.create_goods_receipt(
    v_biz, v_po,
    jsonb_build_array(jsonb_build_object(
      'purchase_order_item_id', v_poi,
      'product_id', v_cable,
      'quantity_received', 100)),
    v_actor, v_hq, NULL, CURRENT_DATE);

  RAISE NOTICE 'receipt: %', v_res;

  IF NOT COALESCE((v_res->>'success')::boolean, false) THEN
    RAISE EXCEPTION 'goods receipt failed: %', v_res;
  END IF;
END $mig$;