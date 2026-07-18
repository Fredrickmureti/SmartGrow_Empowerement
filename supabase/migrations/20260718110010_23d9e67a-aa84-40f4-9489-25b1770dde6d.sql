
DO $$
DECLARE
  v_biz uuid; v_org uuid; v_user uuid; v_vendor uuid; v_product uuid;
  v_po uuid; v_poi uuid; v_asn uuid; v_asn_line uuid;
  v_wh uuid; v_res jsonb; v_grn uuid;
  v_caught bool; r_status text; v_outbox int; v_recv numeric;
BEGIN
  SELECT business_id, organization_id, user_id
    INTO v_biz, v_org, v_user
    FROM public.user_business_access ORDER BY created_at LIMIT 1;
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);

  SELECT id INTO v_wh FROM public.warehouses WHERE business_id=v_biz LIMIT 1;
  IF v_wh IS NULL THEN
    INSERT INTO public.warehouses(organization_id, business_id, name, code)
    VALUES (v_org, v_biz, 'SMOKE-WH-G', 'SMOKE-G') RETURNING id INTO v_wh;
  END IF;

  INSERT INTO public.contacts(organization_id, business_id, name, type, supplier_rank)
  VALUES (v_org, v_biz, 'SMOKE-VENDOR-G', 'supplier', 1) RETURNING id INTO v_vendor;

  INSERT INTO public.products(organization_id, business_id, name)
  VALUES (v_org, v_biz, 'SMOKE-PROD-G') RETURNING id INTO v_product;

  INSERT INTO public.purchase_orders
    (id, organization_id, business_id, vendor_id, po_number, status,
     order_date, subtotal, total, currency, created_by, created_at, updated_at)
  VALUES (gen_random_uuid(), v_org, v_biz, v_vendor,
          'PO-G-'||substr(gen_random_uuid()::text,1,8), 'approved',
          CURRENT_DATE, 100, 100, 'USD', v_user, now(), now())
  RETURNING id INTO v_po;

  INSERT INTO public.purchase_order_items
    (purchase_order_id, product_id, description, quantity, quantity_received,
     unit_price, line_total, sort_order)
  VALUES (v_po, v_product, 'SMOKE line', 10, 0, 10, 100, 1)
  RETURNING id INTO v_poi;

  v_asn := public.create_inbound_shipment(v_biz, v_vendor, v_po,
    now() + interval '1 day', 'DHL', 'TRK-G', v_wh, NULL, 'smoke-g');

  INSERT INTO public.inbound_shipment_items
    (shipment_id, organization_id, business_id, purchase_order_item_id,
     product_id, expected_quantity, sort_order)
  VALUES (v_asn, v_org, v_biz, v_poi, v_product, 10, 1)
  RETURNING id INTO v_asn_line;

  PERFORM public.dispatch_inbound_shipment(v_asn);
  PERFORM public.mark_inbound_shipment_in_transit(v_asn);
  PERFORM public.mark_inbound_shipment_arrived(v_asn);

  v_caught := false;
  BEGIN
    v_res := public.receive_inbound_shipment(v_asn,
      jsonb_build_array(jsonb_build_object(
        'shipment_item_id', v_asn_line, 'quantity_received', 15)),
      v_user);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM ILIKE '%over-receipt%' THEN v_caught := true; ELSE RAISE; END IF;
  END;
  IF NOT v_caught THEN RAISE EXCEPTION 'G: over-receipt not rejected'; END IF;

  v_res := public.receive_inbound_shipment(v_asn,
    jsonb_build_array(jsonb_build_object(
      'shipment_item_id', v_asn_line, 'quantity_received', 6, 'lot_number','LOT-1')),
    v_user);
  IF NOT COALESCE((v_res->>'success')::boolean,false) THEN
    RAISE EXCEPTION 'G: receive failed: %', v_res;
  END IF;
  v_grn := (v_res->>'goods_receipt_id')::uuid;

  SELECT status::text INTO r_status FROM public.inbound_shipments WHERE id=v_asn;
  IF r_status <> 'received' THEN RAISE EXCEPTION 'G: shipment status=%',r_status; END IF;

  SELECT quantity_received INTO v_recv FROM public.purchase_order_items WHERE id=v_poi;
  IF v_recv <> 6 THEN RAISE EXCEPTION 'G: PO line qty_recv=%', v_recv; END IF;

  SELECT status::text INTO r_status FROM public.purchase_orders WHERE id=v_po;
  IF r_status <> 'partial_received' THEN
    RAISE EXCEPTION 'G: PO status=% (expected partial_received)', r_status;
  END IF;

  v_caught := false;
  BEGIN
    v_res := public.receive_inbound_shipment(v_asn,
      jsonb_build_array(jsonb_build_object(
        'shipment_item_id', v_asn_line, 'quantity_received', 1)),
      v_user);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM ILIKE '%expected arrived%' THEN v_caught := true; ELSE RAISE; END IF;
  END;
  IF NOT v_caught THEN RAISE EXCEPTION 'G: replay not rejected'; END IF;

  SELECT count(*) INTO v_outbox FROM public.business_event_outbox
   WHERE source_doc_id = v_grn AND event_type = 'procurement.grn.received';
  IF v_outbox < 1 THEN RAISE EXCEPTION 'G: outbox=%', v_outbox; END IF;

  RAISE EXCEPTION '__SMOKE_ROLLBACK_MARKER__';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM='__SMOKE_ROLLBACK_MARKER__' THEN RAISE NOTICE 'G-smoke: PASS'; RETURN; END IF;
  RAISE;
END $$;
