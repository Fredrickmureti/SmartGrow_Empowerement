
DO $$
DECLARE
  v_biz UUID; v_org UUID;
  v_user_a UUID; v_user_b UUID;
  v_vendor UUID; v_po UUID;
  v_caught BOOLEAN; v_rev_count INTEGER; v_outbox_count INTEGER;
  r_status TEXT;
BEGIN
  SELECT business_id, organization_id, user_id INTO v_biz, v_org, v_user_a
    FROM public.user_business_access ORDER BY created_at LIMIT 1;
  SELECT user_id INTO v_user_b
    FROM public.user_business_access
   WHERE business_id=v_biz AND user_id<>v_user_a LIMIT 1;

  INSERT INTO public.contacts (organization_id, business_id, name, type, supplier_rank)
  VALUES (v_org, v_biz, 'SMOKE-VENDOR-E', 'supplier', 1) RETURNING id INTO v_vendor;

  INSERT INTO public.purchase_orders
    (id, organization_id, business_id, vendor_id, po_number, status, order_date,
     subtotal, total, currency, created_by, created_at, updated_at)
  VALUES (gen_random_uuid(), v_org, v_biz, v_vendor,
     'PO-SMOKE-E-' || substr(gen_random_uuid()::text,1,8),
     'draft', CURRENT_DATE, 1000, 1000, 'USD', v_user_a, now(), now())
  RETURNING id INTO v_po;

  PERFORM set_config('request.jwt.claim.sub', v_user_a::text, true);
  PERFORM public.submit_purchase_order(v_po);
  SELECT status::text INTO r_status FROM public.purchase_orders WHERE id=v_po;
  IF r_status <> 'submitted' THEN RAISE EXCEPTION 'submit: %', r_status; END IF;

  v_caught:=false;
  BEGIN PERFORM public.approve_purchase_order(v_po); EXCEPTION WHEN OTHERS THEN v_caught:=true; END;
  IF NOT v_caught THEN RAISE EXCEPTION 'self-approve not blocked'; END IF;

  PERFORM set_config('request.jwt.claim.sub', v_user_b::text, true);
  PERFORM public.approve_purchase_order(v_po);
  SELECT status::text INTO r_status FROM public.purchase_orders WHERE id=v_po;
  IF r_status <> 'approved' THEN RAISE EXCEPTION 'approve: %', r_status; END IF;

  v_caught:=false;
  BEGIN PERFORM public.acknowledge_purchase_order(v_po); EXCEPTION WHEN OTHERS THEN v_caught:=true; END;
  IF NOT v_caught THEN RAISE EXCEPTION 'approver acked'; END IF;

  PERFORM set_config('request.jwt.claim.sub', v_user_a::text, true);
  PERFORM public.acknowledge_purchase_order(v_po, 'ok');
  SELECT status::text INTO r_status FROM public.purchase_orders WHERE id=v_po;
  IF r_status <> 'acknowledged' THEN RAISE EXCEPTION 'ack: %', r_status; END IF;

  PERFORM public.revise_purchase_order(v_po, 'reason');
  SELECT COUNT(*) INTO v_rev_count FROM public.purchase_order_revisions WHERE purchase_order_id=v_po;
  IF v_rev_count <> 1 THEN RAISE EXCEPTION 'rev=%', v_rev_count; END IF;

  PERFORM public.cancel_purchase_order(v_po, 'nn');
  SELECT status::text INTO r_status FROM public.purchase_orders WHERE id=v_po;
  IF r_status <> 'cancelled' THEN RAISE EXCEPTION 'cancel: %', r_status; END IF;

  SELECT COUNT(*) INTO v_outbox_count FROM public.business_event_outbox
   WHERE source_doc_id=v_po AND event_type LIKE 'procurement.po.%';
  IF v_outbox_count < 5 THEN RAISE EXCEPTION 'outbox=%', v_outbox_count; END IF;

  RAISE EXCEPTION '__SMOKE_ROLLBACK_MARKER__';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM='__SMOKE_ROLLBACK_MARKER__' THEN RAISE NOTICE 'E-smoke: PASS'; RETURN; END IF;
  RAISE;
END $$;
