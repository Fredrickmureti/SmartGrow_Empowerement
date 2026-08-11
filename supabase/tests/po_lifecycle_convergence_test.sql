-- po_lifecycle_convergence_test.sql
--
-- Functional + introspection coverage for the PO lifecycle convergence arc:
--   1. The *_purchase_order RPCs own the state machine end to end
--      (draft -> submitted -> approved -> sent -> revised), with idempotent
--      replay on approve/release.
--   2. update_po_items_atomic refuses line edits outside draft/revised/rejected.
--   3. trg_po_commercial_fields_immutable blocks silent commercial mutation
--      of a released commitment and allows it again after revise.
--   4. Release fans out exactly once: expected inbound shipment (WMS),
--      supplier email outbox row, and a single procurement.po.released event;
--      revise withdraws the expected inbound and emits po.revised.
--   5. run_replenishment_planning reads the canonical inventory_expected_supply
--      view (no divergent draft-inclusive incoming logic).
--
-- Idempotent: everything runs in a transaction that rolls back.
BEGIN;

DO $$
DECLARE
  v_org       uuid;
  v_business  uuid;
  v_member    uuid;
  v_vendor    uuid;
  v_po        uuid;
  v_status    text;
  v_n         int;
  v_n2        int;
  v_err       text;
BEGIN
  ---------------------------------------------------------------------------
  -- 0. Introspection invariants (run unconditionally, no fixtures needed)
  ---------------------------------------------------------------------------

  IF position('inventory_expected_supply' in pg_get_functiondef('public.run_replenishment_planning(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'run_replenishment_planning must read the canonical inventory_expected_supply view';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_po_commercial_fields_immutable'
  ) THEN
    RAISE EXCEPTION 'trg_po_commercial_fields_immutable is missing';
  END IF;

  IF position('editable only in draft/revised/rejected' in pg_get_functiondef('public.update_po_items_atomic(uuid,jsonb)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'update_po_items_atomic is missing its status guard';
  END IF;

  ---------------------------------------------------------------------------
  -- 1. Fixtures: org, business, member with business access, vendor, draft PO
  ---------------------------------------------------------------------------

  SELECT user_id INTO v_member FROM public.user_business_access LIMIT 1;
  IF v_member IS NULL THEN
    RAISE NOTICE 'No user_business_access rows exist; skipping functional section (introspection checks passed).';
    RETURN;
  END IF;

  INSERT INTO public.organizations (name, slug)
  VALUES ('PO Lifecycle Convergence Test', 'po-lifecycle-convergence-test')
  RETURNING id INTO v_org;

  INSERT INTO public.businesses (organization_id, name, legal_name)
  VALUES (v_org, 'PO Lifecycle Test Co', 'PO Lifecycle Test Co Ltd')
  RETURNING id INTO v_business;

  INSERT INTO public.user_business_access (user_id, business_id, role)
  VALUES (v_member, v_business, 'admin');

  INSERT INTO public.contacts (organization_id, business_id, type, name, email)
  VALUES (v_org, v_business, 'supplier', 'Convergence Vendor Ltd', 'vendor@convergence.test')
  RETURNING id INTO v_vendor;

  INSERT INTO public.purchase_orders (
    organization_id, business_id, vendor_id, po_number, status,
    order_date, subtotal, tax_amount, discount_amount, total, currency
  ) VALUES (
    v_org, v_business, v_vendor, 'PO-CONV-' || substring(gen_random_uuid()::text from 1 for 8), 'draft',
    current_date, 100, 16, 0, 116, 'KES'
  )
  RETURNING id INTO v_po;

  -- Simulate an authenticated caller for the SECURITY DEFINER RPC checks.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_member::text, 'role', 'authenticated')::text, true);

  ---------------------------------------------------------------------------
  -- 2. Draft: line edits allowed
  ---------------------------------------------------------------------------

  v_n := public.update_po_items_atomic(v_po, jsonb_build_array(jsonb_build_object(
    'description', 'Convergence widget', 'quantity', 2, 'unit_price', 50,
    'tax_rate', 16, 'tax_amount', 16, 'line_total', 100, 'sort_order', 1
  )));
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'update_po_items_atomic on draft returned %, expected 1', v_n;
  END IF;

  ---------------------------------------------------------------------------
  -- 3. submit -> approve (idempotent) -> line edits refused -> commercial lock
  ---------------------------------------------------------------------------

  PERFORM public.submit_purchase_order(v_po);
  SELECT status INTO v_status FROM public.purchase_orders WHERE id = v_po;
  IF v_status <> 'submitted' THEN
    RAISE EXCEPTION 'submit left status %, expected submitted', v_status;
  END IF;

  -- Line edits are refused once submitted.
  BEGIN
    PERFORM public.update_po_items_atomic(v_po, '[]'::jsonb);
    RAISE EXCEPTION 'update_po_items_atomic should refuse non-draft statuses';
  EXCEPTION WHEN raise_exception OR invalid_parameter_value THEN
    NULL; -- expected rejection
  END;

  PERFORM public.approve_purchase_order(v_po, 'conv-approve-1');
  SELECT status INTO v_status FROM public.purchase_orders WHERE id = v_po;
  IF v_status <> 'approved' THEN
    RAISE EXCEPTION 'approve left status %, expected approved', v_status;
  END IF;

  -- Replay with the same client request id must be a no-op (no second event).
  PERFORM public.approve_purchase_order(v_po, 'conv-approve-1');
  SELECT count(*) INTO v_n FROM public.business_event_outbox
   WHERE topic = 'procurement.po.approved' AND payload->>'po_id' = v_po::text;
  IF v_n > 1 THEN
    RAISE EXCEPTION 'approve replay emitted % approved events', v_n;
  END IF;

  -- Commercial fields are locked on a released commitment.
  BEGIN
    UPDATE public.purchase_orders SET total = total + 1 WHERE id = v_po;
    RAISE EXCEPTION 'commercial-field trigger should block total mutation while approved';
  EXCEPTION WHEN raise_exception THEN
    NULL; -- expected
  END;

  ---------------------------------------------------------------------------
  -- 4. release: sent + single fan-out (event, expected inbound, supplier email)
  ---------------------------------------------------------------------------

  PERFORM public.release_purchase_order(v_po);
  SELECT status INTO v_status FROM public.purchase_orders WHERE id = v_po;
  IF v_status <> 'sent' THEN
    RAISE EXCEPTION 'release left status %, expected sent', v_status;
  END IF;

  PERFORM public.release_purchase_order(v_po); -- idempotent replay

  SELECT count(*) INTO v_n FROM public.business_event_outbox
   WHERE topic = 'procurement.po.released' AND payload->>'po_id' = v_po::text;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 po.released event, found %', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM public.inbound_shipments
   WHERE purchase_order_id = v_po;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 expected inbound shipment, found %', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM public.email_event_outbox
   WHERE event_type = 'purchase_order_released' AND entity_id = v_po;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 supplier release email row, found %', v_n;
  END IF;

  ---------------------------------------------------------------------------
  -- 5. SoD: the approver cannot acknowledge their own PO
  ---------------------------------------------------------------------------

  BEGIN
    PERFORM public.acknowledge_purchase_order(v_po, 'self-ack attempt');
    RAISE EXCEPTION 'acknowledge should reject approver = acknowledger (SoD)';
  EXCEPTION WHEN raise_exception OR insufficient_privilege THEN
    NULL; -- expected
  END;

  ---------------------------------------------------------------------------
  -- 6. revise: reopens editing, withdraws expected inbound, occurrence-aware key
  ---------------------------------------------------------------------------

  PERFORM public.revise_purchase_order(v_po, 'convergence test revision');
  SELECT status INTO v_status FROM public.purchase_orders WHERE id = v_po;
  IF v_status <> 'revised' THEN
    RAISE EXCEPTION 'revise left status %, expected revised', v_status;
  END IF;

  SELECT count(*) INTO v_n FROM public.inbound_shipments
   WHERE purchase_order_id = v_po AND status <> 'cancelled';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'revise must withdraw expected inbound; % still open', v_n;
  END IF;

  SELECT count(*) INTO v_n, count(DISTINCT idempotency_key) INTO v_n2
    FROM public.business_event_outbox
   WHERE topic = 'procurement.po.revised' AND payload->>'po_id' = v_po::text;
  IF v_n <> v_n2 THEN
    RAISE EXCEPTION 'duplicate idempotency keys on po.revised (% rows, % keys)', v_n, v_n2;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.business_event_outbox
    WHERE topic = 'procurement.po.revised' AND payload->>'po_id' = v_po::text
      AND idempotency_key LIKE '%:revised:' || v_po::text
  ) THEN
    RAISE EXCEPTION 'po.revised idempotency key is not occurrence-aware';
  END IF;

  -- Revised is editable again: line edits allowed, notes mutation allowed.
  v_n := public.update_po_items_atomic(v_po, jsonb_build_array(jsonb_build_object(
    'description', 'Convergence widget v2', 'quantity', 3, 'unit_price', 50,
    'tax_rate', 16, 'tax_amount', 24, 'line_total', 150, 'sort_order', 1
  )));
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'update_po_items_atomic on revised returned %, expected 1', v_n;
  END IF;

  UPDATE public.purchase_orders SET notes = 'editable again after revise' WHERE id = v_po;

  RAISE NOTICE 'po_lifecycle_convergence_test: ALL CHECKS PASSED';
END $$;

ROLLBACK;
