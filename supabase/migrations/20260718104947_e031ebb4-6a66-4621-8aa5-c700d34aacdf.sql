
DO $$
DECLARE
  v_biz uuid; v_org uuid; v_user uuid; v_vendor uuid; v_po uuid;
  v_asn uuid; v_asn2 uuid; v_caught bool; r_status text; v_outbox int;
BEGIN
  SELECT business_id, organization_id, user_id INTO v_biz, v_org, v_user
    FROM public.user_business_access ORDER BY created_at LIMIT 1;
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);

  INSERT INTO public.contacts(organization_id, business_id, name, type, supplier_rank)
  VALUES (v_org, v_biz, 'SMOKE-VENDOR-F', 'supplier', 1) RETURNING id INTO v_vendor;

  INSERT INTO public.purchase_orders
    (id, organization_id, business_id, vendor_id, po_number, status, order_date,
     subtotal, total, currency, created_by, created_at, updated_at)
  VALUES (gen_random_uuid(), v_org, v_biz, v_vendor,
     'PO-F-'||substr(gen_random_uuid()::text,1,8),
     'approved', CURRENT_DATE, 100, 100, 'USD', v_user, now(), now())
  RETURNING id INTO v_po;

  -- Positive path
  v_asn := public.create_inbound_shipment(v_biz, v_vendor, v_po,
    now() + interval '2 days', 'DHL', 'TRK-1', NULL, NULL, 'smoke');

  -- Line validation: zero qty must fail
  v_caught := false;
  BEGIN
    INSERT INTO public.inbound_shipment_items
      (shipment_id, organization_id, business_id, product_id, expected_quantity, sort_order)
    VALUES (v_asn, v_org, v_biz, gen_random_uuid(), 0, 1);
  EXCEPTION WHEN OTHERS THEN v_caught := true; END;
  IF NOT v_caught THEN RAISE EXCEPTION 'F-smoke: zero-qty line was accepted'; END IF;

  PERFORM public.dispatch_inbound_shipment(v_asn);
  SELECT status::text INTO r_status FROM public.inbound_shipments WHERE id=v_asn;
  IF r_status <> 'dispatched' THEN RAISE EXCEPTION 'F: dispatch failed: %', r_status; END IF;

  PERFORM public.mark_inbound_shipment_in_transit(v_asn);
  PERFORM public.mark_inbound_shipment_arrived(v_asn);
  SELECT status::text INTO r_status FROM public.inbound_shipments WHERE id=v_asn;
  IF r_status <> 'arrived' THEN RAISE EXCEPTION 'F: arrived failed: %', r_status; END IF;

  -- Cancel path on new ASN
  v_asn2 := public.create_inbound_shipment(v_biz, v_vendor, v_po,
    now() + interval '3 days', 'FEDEX', 'TRK-2', NULL, NULL, NULL);
  PERFORM public.cancel_inbound_shipment(v_asn2, 'oops');
  SELECT status::text INTO r_status FROM public.inbound_shipments WHERE id=v_asn2;
  IF r_status <> 'cancelled' THEN RAISE EXCEPTION 'F: cancel failed: %', r_status; END IF;

  -- Terminal guard: can't cancel again
  v_caught := false;
  BEGIN PERFORM public.cancel_inbound_shipment(v_asn2,'x'); EXCEPTION WHEN OTHERS THEN v_caught := true; END;
  IF NOT v_caught THEN RAISE EXCEPTION 'F: terminal cancel not blocked'; END IF;

  -- Outbox emitted for each state (>=6: created, dispatched, in_transit, arrived, created, cancelled)
  SELECT count(*) INTO v_outbox FROM public.business_event_outbox
   WHERE source_doc_id IN (v_asn, v_asn2) AND event_type LIKE 'procurement.asn.%';
  IF v_outbox < 6 THEN RAISE EXCEPTION 'F: outbox=%',v_outbox; END IF;

  RAISE EXCEPTION '__SMOKE_ROLLBACK_MARKER__';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM='__SMOKE_ROLLBACK_MARKER__' THEN RAISE NOTICE 'F-smoke: PASS'; RETURN; END IF;
  RAISE;
END $$;
