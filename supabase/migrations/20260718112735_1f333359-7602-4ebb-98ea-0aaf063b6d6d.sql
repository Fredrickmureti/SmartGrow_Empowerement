DO $$
DECLARE
  v_biz uuid; v_org uuid; v_user_a uuid; v_user_b uuid;
  v_vendor uuid;
  v_po uuid; v_po_item uuid;
  v_bill uuid;
  v_lc uuid;
  v_result jsonb;
  v_excn int; v_outbox int; v_rows int;
  v_caught boolean;

  FUNCTION_LIKE bool; -- placeholder (unused)
BEGIN
  SELECT business_id, organization_id, user_id
    INTO v_biz, v_org, v_user_a
    FROM public.user_business_access
    ORDER BY created_at LIMIT 1;
  IF v_biz IS NULL THEN
    RAISE NOTICE 'H-Verify: SKIP (no seeded user_business_access)'; RETURN;
  END IF;
  SELECT user_id INTO v_user_b
    FROM public.user_business_access
   WHERE business_id = v_biz AND user_id <> v_user_a
   ORDER BY created_at LIMIT 1;
  IF v_user_b IS NULL THEN v_user_b := v_user_a; END IF;

  PERFORM set_config('request.jwt.claim.sub', v_user_a::text, true);

  INSERT INTO public.contacts(organization_id, business_id, name, type, supplier_rank)
  VALUES (v_org, v_biz, 'SMOKE-VENDOR-H', 'supplier', 1)
  RETURNING id INTO v_vendor;

  INSERT INTO public.purchase_orders
    (organization_id, business_id, vendor_id, po_number, status,
     order_date, subtotal, total, currency, created_by)
  VALUES (v_org, v_biz, v_vendor,
          'PO-H-'||substr(gen_random_uuid()::text,1,8),
          'approved', CURRENT_DATE, 1000, 1000, 'USD', v_user_a)
  RETURNING id INTO v_po;

  ---------------------------------------------------------------
  -- H1: qty match on its own PO line (received=10, bill 10)
  ---------------------------------------------------------------
  INSERT INTO public.purchase_order_items
    (purchase_order_id, description, quantity, unit_price, line_total,
     quantity_received, quantity_billed, receipt_status)
  VALUES (v_po, 'widget-h1', 10, 100, 1000, 10, 0, 'received')
  RETURNING id INTO v_po_item;

  INSERT INTO public.bills
    (organization_id, business_id, vendor_id, bill_number, status,
     bill_date, due_date, subtotal, total, currency, purchase_order_id, created_by)
  VALUES (v_org, v_biz, v_vendor, 'BILL-H1-'||substr(gen_random_uuid()::text,1,6),
          'draft', CURRENT_DATE, CURRENT_DATE+30, 1000, 1000, 'USD', v_po, v_user_a)
  RETURNING id INTO v_bill;
  INSERT INTO public.bill_items(bill_id, description, quantity, unit_price, line_total,
                                purchase_order_item_id)
  VALUES (v_bill, 'widget', 10, 100, 1000, v_po_item);

  v_result := public.match_bill_atomic(v_bill, v_user_b);
  IF v_result->>'match_state' <> 'matched' THEN
    RAISE EXCEPTION 'H1 expected matched got %', v_result->>'match_state';
  END IF;
  SELECT count(*) INTO v_excn FROM public.bill_match_exceptions WHERE bill_id=v_bill;
  IF v_excn <> 0 THEN RAISE EXCEPTION 'H1 unexpected exceptions=%', v_excn; END IF;
  SELECT count(*) INTO v_outbox FROM public.business_event_outbox
   WHERE source_doc_id=v_bill AND event_type='procurement.bill.match.matched';
  IF v_outbox <> 1 THEN RAISE EXCEPTION 'H1 outbox=%', v_outbox; END IF;

  PERFORM public.match_bill_atomic(v_bill, v_user_b);
  SELECT count(*) INTO v_rows FROM public.bill_match_results WHERE bill_id=v_bill;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'H1 replay row count=%', v_rows; END IF;
  SELECT count(*) INTO v_outbox FROM public.business_event_outbox
   WHERE source_doc_id=v_bill AND event_type='procurement.bill.match.matched';
  IF v_outbox <> 1 THEN RAISE EXCEPTION 'H1 replay outbox=%', v_outbox; END IF;

  ---------------------------------------------------------------
  -- H2: under-bill on its own PO line (received=10, bill 6)
  ---------------------------------------------------------------
  INSERT INTO public.purchase_order_items
    (purchase_order_id, description, quantity, unit_price, line_total,
     quantity_received, quantity_billed, receipt_status)
  VALUES (v_po, 'widget-h2', 10, 100, 1000, 10, 0, 'received')
  RETURNING id INTO v_po_item;

  INSERT INTO public.bills
    (organization_id, business_id, vendor_id, bill_number, status,
     bill_date, due_date, subtotal, total, currency, purchase_order_id, created_by)
  VALUES (v_org, v_biz, v_vendor, 'BILL-H2-'||substr(gen_random_uuid()::text,1,6),
          'draft', CURRENT_DATE, CURRENT_DATE+30, 600, 600, 'USD', v_po, v_user_a)
  RETURNING id INTO v_bill;
  INSERT INTO public.bill_items(bill_id, description, quantity, unit_price, line_total,
                                purchase_order_item_id)
  VALUES (v_bill, 'widget', 6, 100, 600, v_po_item);
  v_result := public.match_bill_atomic(v_bill, v_user_b);
  IF v_result->>'match_state' <> 'under_billed' THEN
    RAISE EXCEPTION 'H2 expected under_billed got %', v_result->>'match_state';
  END IF;
  SELECT count(*) INTO v_excn FROM public.bill_match_exceptions WHERE bill_id=v_bill;
  IF v_excn < 1 THEN RAISE EXCEPTION 'H2 exception not raised'; END IF;

  ---------------------------------------------------------------
  -- H3: over-bill on its own PO line — bypass insert trigger to
  --      simulate imported/historical bill (received=10, bill 15)
  ---------------------------------------------------------------
  INSERT INTO public.purchase_order_items
    (purchase_order_id, description, quantity, unit_price, line_total,
     quantity_received, quantity_billed, receipt_status)
  VALUES (v_po, 'widget-h3', 20, 100, 2000, 10, 0, 'partial')
  RETURNING id INTO v_po_item;

  INSERT INTO public.bills
    (organization_id, business_id, vendor_id, bill_number, status,
     bill_date, due_date, subtotal, total, currency, purchase_order_id, created_by)
  VALUES (v_org, v_biz, v_vendor, 'BILL-H3-'||substr(gen_random_uuid()::text,1,6),
          'draft', CURRENT_DATE, CURRENT_DATE+30, 1650, 1650, 'USD', v_po, v_user_a)
  RETURNING id INTO v_bill;

  SET LOCAL session_replication_role = replica;
  INSERT INTO public.bill_items(bill_id, description, quantity, unit_price, line_total,
                                purchase_order_item_id)
  VALUES (v_bill, 'widget', 15, 110, 1650, v_po_item);
  SET LOCAL session_replication_role = origin;

  v_result := public.match_bill_atomic(v_bill, v_user_b);
  IF v_result->>'match_state' <> 'over_billed' THEN
    RAISE EXCEPTION 'H3 expected over_billed got %', v_result->>'match_state';
  END IF;

  ---------------------------------------------------------------
  -- H4a: price variance beyond default 0% tol (received=10, bill 10 @ 120)
  ---------------------------------------------------------------
  INSERT INTO public.purchase_order_items
    (purchase_order_id, description, quantity, unit_price, line_total,
     quantity_received, quantity_billed, receipt_status)
  VALUES (v_po, 'widget-h4', 10, 100, 1000, 10, 0, 'received')
  RETURNING id INTO v_po_item;

  INSERT INTO public.bills
    (organization_id, business_id, vendor_id, bill_number, status,
     bill_date, due_date, subtotal, total, currency, purchase_order_id, created_by)
  VALUES (v_org, v_biz, v_vendor, 'BILL-H4-'||substr(gen_random_uuid()::text,1,6),
          'draft', CURRENT_DATE, CURRENT_DATE+30, 1200, 1200, 'USD', v_po, v_user_a)
  RETURNING id INTO v_bill;
  INSERT INTO public.bill_items(bill_id, description, quantity, unit_price, line_total,
                                purchase_order_item_id)
  VALUES (v_bill, 'widget', 10, 120, 1200, v_po_item);
  v_result := public.match_bill_atomic(v_bill, v_user_b);
  IF v_result->>'match_state' <> 'price_variance' THEN
    RAISE EXCEPTION 'H4a expected price_variance got %', v_result->>'match_state';
  END IF;

  -- H4b: same bill with 25% price tolerance → matched
  INSERT INTO public.bill_match_tolerance_policies
    (business_id, qty_tolerance_pct, price_tolerance_pct, effective_from)
  VALUES (v_biz, 0, 25, now() - interval '1 minute');
  v_result := public.match_bill_atomic(v_bill, v_user_b);
  IF v_result->>'match_state' <> 'matched' THEN
    RAISE EXCEPTION 'H4b expected matched under 25%% price tol got %', v_result->>'match_state';
  END IF;

  ---------------------------------------------------------------
  -- H5: qty tolerance branching (20% tol allows 9 vs 10)
  ---------------------------------------------------------------
  UPDATE public.bill_match_tolerance_policies
     SET qty_tolerance_pct = 20, price_tolerance_pct = 0
   WHERE business_id = v_biz;

  INSERT INTO public.purchase_order_items
    (purchase_order_id, description, quantity, unit_price, line_total,
     quantity_received, quantity_billed, receipt_status)
  VALUES (v_po, 'widget-h5', 10, 100, 1000, 10, 0, 'received')
  RETURNING id INTO v_po_item;

  INSERT INTO public.bills
    (organization_id, business_id, vendor_id, bill_number, status,
     bill_date, due_date, subtotal, total, currency, purchase_order_id, created_by)
  VALUES (v_org, v_biz, v_vendor, 'BILL-H5-'||substr(gen_random_uuid()::text,1,6),
          'draft', CURRENT_DATE, CURRENT_DATE+30, 900, 900, 'USD', v_po, v_user_a)
  RETURNING id INTO v_bill;
  INSERT INTO public.bill_items(bill_id, description, quantity, unit_price, line_total,
                                purchase_order_item_id)
  VALUES (v_bill, 'widget', 9, 100, 900, v_po_item);
  v_result := public.match_bill_atomic(v_bill, v_user_b);
  IF v_result->>'match_state' <> 'matched' THEN
    RAISE EXCEPTION 'H5 expected matched under 20%% qty tol got %', v_result->>'match_state';
  END IF;

  UPDATE public.bill_match_tolerance_policies
     SET qty_tolerance_pct = 0, price_tolerance_pct = 0
   WHERE business_id = v_biz;

  ---------------------------------------------------------------
  -- H6: 4-way match with landed cost (uplift 100/2000=5%, target 105
  --      but H6 line unit price is 100, so bill@105 → matched)
  --  Use fresh line so PO subtotal for uplift = qty*unit_price = 2000
  ---------------------------------------------------------------
  -- Wipe prior lines' impact by using a dedicated PO for H6
  DECLARE v_po6 uuid; v_po_item6 uuid;
  BEGIN
    INSERT INTO public.purchase_orders
      (organization_id, business_id, vendor_id, po_number, status,
       order_date, subtotal, total, currency, created_by)
    VALUES (v_org, v_biz, v_vendor,
            'PO-H6-'||substr(gen_random_uuid()::text,1,8),
            'approved', CURRENT_DATE, 2000, 2000, 'USD', v_user_a)
    RETURNING id INTO v_po6;
    INSERT INTO public.purchase_order_items
      (purchase_order_id, description, quantity, unit_price, line_total,
       quantity_received, quantity_billed, receipt_status)
    VALUES (v_po6, 'widget-h6', 20, 100, 2000, 20, 0, 'received')
    RETURNING id INTO v_po_item6;

    INSERT INTO public.landed_cost_bills
      (organization_id, business_id, cost_type, currency, total_amount, allocation_basis, status)
    VALUES (v_org, v_biz, 'freight', 'USD', 100, 'value', 'draft')
    RETURNING id INTO v_lc;

    INSERT INTO public.bills
      (organization_id, business_id, vendor_id, bill_number, status,
       bill_date, due_date, subtotal, total, currency, purchase_order_id, created_by)
    VALUES (v_org, v_biz, v_vendor, 'BILL-H6-'||substr(gen_random_uuid()::text,1,6),
            'draft', CURRENT_DATE, CURRENT_DATE+30, 2100, 2100, 'USD', v_po6, v_user_a)
    RETURNING id INTO v_bill;
    INSERT INTO public.bill_items(bill_id, description, quantity, unit_price, line_total,
                                  purchase_order_item_id)
    VALUES (v_bill, 'widget', 20, 105, 2100, v_po_item6);
    v_result := public.match_bill_with_landed_cost(v_bill, v_lc, v_user_b);
    IF v_result->>'match_state' <> 'matched' THEN
      RAISE EXCEPTION 'H6 4-way expected matched got % uplift=%',
        v_result->>'match_state', v_result->>'landed_cost_uplift';
    END IF;
  END;

  ---------------------------------------------------------------
  -- H7: self-approval SoD
  ---------------------------------------------------------------
  INSERT INTO public.purchase_order_items
    (purchase_order_id, description, quantity, unit_price, line_total,
     quantity_received, quantity_billed, receipt_status)
  VALUES (v_po, 'widget-h7', 10, 100, 1000, 10, 0, 'received')
  RETURNING id INTO v_po_item;

  INSERT INTO public.bills
    (organization_id, business_id, vendor_id, bill_number, status,
     bill_date, due_date, subtotal, total, currency, purchase_order_id,
     created_by, approved_by)
  VALUES (v_org, v_biz, v_vendor, 'BILL-H7-'||substr(gen_random_uuid()::text,1,6),
          'draft', CURRENT_DATE, CURRENT_DATE+30, 1000, 1000, 'USD', v_po,
          v_user_a, v_user_a)
  RETURNING id INTO v_bill;
  INSERT INTO public.bill_items(bill_id, description, quantity, unit_price, line_total,
                                purchase_order_item_id)
  VALUES (v_bill, 'widget', 10, 100, 1000, v_po_item);

  v_caught := false;
  BEGIN
    PERFORM public.match_bill_atomic(v_bill, v_user_a);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%SoD violation%' THEN v_caught := true; ELSE RAISE; END IF;
  END;
  IF NOT v_caught THEN RAISE EXCEPTION 'H7 self-approval SoD not enforced'; END IF;

  RAISE EXCEPTION '__SMOKE_ROLLBACK_MARKER__';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM = '__SMOKE_ROLLBACK_MARKER__' THEN
    RAISE NOTICE 'H-Verify: PASS'; RETURN;
  END IF;
  RAISE;
END $$;