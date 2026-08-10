ALTER TABLE public.purchase_requisitions DROP CONSTRAINT IF EXISTS purchase_requisitions_status_check;
ALTER TABLE public.purchase_requisitions ADD CONSTRAINT purchase_requisitions_status_check
  CHECK (status = ANY (ARRAY['draft','submitted','approved','rejected','sourcing',
                             'partially_procured','procured','ordered',
                             'partially_fulfilled','fulfilled','closed','cancelled']));

ALTER TABLE public.purchase_requisition_items DROP CONSTRAINT IF EXISTS purchase_requisition_items_status_check;
ALTER TABLE public.purchase_requisition_items ADD CONSTRAINT purchase_requisition_items_status_check
  CHECK (status = ANY (ARRAY['open','sourcing','partially_ordered','ordered',
                             'partially_received','received','cancelled','closed']));

-- ---------- rollup ----------
CREATE OR REPLACE FUNCTION public._pr_recalc(_requisition_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_r public.purchase_requisitions; v_status text;
BEGIN
  IF _requisition_id IS NULL THEN RETURN; END IF;
  SELECT * INTO v_r FROM public.purchase_requisitions WHERE id = _requisition_id;
  IF v_r.id IS NULL THEN RETURN; END IF;

  PERFORM public._pr_lifecycle_begin();

  WITH agg AS (
    SELECT i.id,
           COALESCE(sum(poi.quantity), 0) AS qty_ordered,
           COALESCE(sum(poi.quantity_received), 0) AS qty_received,
           bool_or(ri.id IS NOT NULL) AS sourcing
      FROM public.purchase_requisition_items i
      LEFT JOIN public.purchase_order_items poi ON poi.requisition_item_id = i.id
      LEFT JOIN public.purchase_orders po ON po.id = poi.purchase_order_id AND po.status <> 'cancelled'
      LEFT JOIN public.rfq_items ri ON ri.requisition_item_id = i.id
     WHERE i.requisition_id = _requisition_id
     GROUP BY i.id
  )
  UPDATE public.purchase_requisition_items i
     SET quantity_ordered = CASE WHEN po_exists.qty_ordered IS NULL THEN 0 ELSE po_exists.qty_ordered END,
         quantity_received = COALESCE(po_exists.qty_received, 0),
         status = CASE
           WHEN i.status = 'cancelled' THEN 'cancelled'
           WHEN COALESCE(po_exists.qty_received,0) >= i.quantity AND i.quantity > 0 THEN 'closed'
           WHEN COALESCE(po_exists.qty_received,0) > 0 THEN 'partially_received'
           WHEN COALESCE(po_exists.qty_ordered,0) >= i.quantity AND i.quantity > 0 THEN 'ordered'
           WHEN COALESCE(po_exists.qty_ordered,0) > 0 THEN 'partially_ordered'
           WHEN COALESCE(po_exists.sourcing,false) THEN 'sourcing'
           ELSE 'open' END,
         updated_at = now()
    FROM agg po_exists
   WHERE i.id = po_exists.id;

  IF v_r.status IN ('draft','submitted','rejected','cancelled') THEN
    RETURN;
  END IF;

  SELECT CASE
      WHEN count(*) FILTER (WHERE status <> 'cancelled') = 0 THEN 'cancelled'
      WHEN count(*) FILTER (WHERE status NOT IN ('cancelled','closed')) = 0 THEN 'closed'
      WHEN count(*) FILTER (WHERE status NOT IN ('cancelled','closed')) = 0 THEN 'fulfilled'
      WHEN count(*) FILTER (WHERE status IN ('partially_received','closed')) > 0 THEN 'partially_fulfilled'
      WHEN count(*) FILTER (WHERE status NOT IN ('cancelled','ordered')) = 0 THEN 'procured'
      WHEN count(*) FILTER (WHERE status IN ('ordered','partially_ordered')) > 0 THEN 'partially_procured'
      WHEN count(*) FILTER (WHERE status = 'sourcing') > 0 THEN 'sourcing'
      ELSE 'approved' END
    INTO v_status
    FROM public.purchase_requisition_items WHERE requisition_id = _requisition_id;

  IF v_status IS DISTINCT FROM v_r.status THEN
    UPDATE public.purchase_requisitions
       SET status = v_status,
           closed_at = CASE WHEN v_status = 'closed' THEN now() ELSE closed_at END,
           updated_at = now()
     WHERE id = _requisition_id;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public._pr_recalc_from_po_item()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_item uuid; v_req uuid;
BEGIN
  v_item := COALESCE(NEW.requisition_item_id, OLD.requisition_item_id);
  IF v_item IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT requisition_id INTO v_req FROM public.purchase_requisition_items WHERE id = v_item;
  PERFORM public._pr_recalc(v_req);
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS trg_pr_recalc_from_po_item ON public.purchase_order_items;
CREATE TRIGGER trg_pr_recalc_from_po_item
  AFTER INSERT OR UPDATE OR DELETE ON public.purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION public._pr_recalc_from_po_item();

CREATE OR REPLACE FUNCTION public._pr_recalc_from_po()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE r record;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  FOR r IN
    SELECT DISTINCT i.requisition_id
      FROM public.purchase_order_items poi
      JOIN public.purchase_requisition_items i ON i.id = poi.requisition_item_id
     WHERE poi.purchase_order_id = NEW.id
  LOOP
    PERFORM public._pr_recalc(r.requisition_id);
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pr_recalc_from_po ON public.purchase_orders;
CREATE TRIGGER trg_pr_recalc_from_po
  AFTER UPDATE ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public._pr_recalc_from_po();

CREATE OR REPLACE FUNCTION public._pr_recalc_from_rfq_item()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_item uuid; v_req uuid;
BEGIN
  v_item := COALESCE(NEW.requisition_item_id, OLD.requisition_item_id);
  IF v_item IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT requisition_id INTO v_req FROM public.purchase_requisition_items WHERE id = v_item;
  PERFORM public._pr_recalc(v_req);
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS trg_pr_recalc_from_rfq_item ON public.rfq_items;
CREATE TRIGGER trg_pr_recalc_from_rfq_item
  AFTER INSERT OR UPDATE OR DELETE ON public.rfq_items
  FOR EACH ROW EXECUTE FUNCTION public._pr_recalc_from_rfq_item();

-- ---------- release: requisition -> RFQ ----------
CREATE OR REPLACE FUNCTION public.requisition_create_rfq(
  _requisition_id uuid,
  _line_ids uuid[] DEFAULT NULL,
  _deadline date DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_r public.purchase_requisitions; v_uid uuid := auth.uid();
        v_rfq_id uuid; v_rfq_no text; n int;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_r FROM public.purchase_requisitions WHERE id = _requisition_id FOR UPDATE;
  IF v_r.id IS NULL THEN RAISE EXCEPTION 'Requisition not found' USING ERRCODE='22023'; END IF;
  IF NOT public.user_has_business_access(v_uid, v_r.business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF v_r.status NOT IN ('approved','sourcing','partially_procured') THEN
    RAISE EXCEPTION 'Only an approved requisition can be sourced' USING ERRCODE='22023';
  END IF;

  v_rfq_no := public.get_next_rfq_number(v_r.organization_id);
  INSERT INTO public.rfqs(organization_id, business_id, rfq_number, status, currency,
    branch_id, deliver_to_branch_id, deliver_to_warehouse_id, project_id,
    requisition_id, required_by_date, deadline, created_by, notes)
  VALUES (v_r.organization_id, v_r.business_id, v_rfq_no, 'draft', v_r.currency,
    v_r.branch_id, v_r.destination_branch_id, v_r.destination_warehouse_id, v_r.project_id,
    v_r.id, v_r.need_by_date, _deadline, v_uid,
    'Sourced from requisition ' || v_r.requisition_number)
  RETURNING id INTO v_rfq_id;

  INSERT INTO public.rfq_items(rfq_id, product_id, description, quantity, target_price,
                               uom_id, need_by_date, requisition_item_id, sort_order)
  SELECT v_rfq_id, i.product_id, i.description,
         GREATEST(i.quantity - i.quantity_ordered, 0), NULLIF(i.estimated_unit_price, 0),
         i.uom_id, COALESCE(i.need_by_date, v_r.need_by_date), i.id, i.sort_order
    FROM public.purchase_requisition_items i
   WHERE i.requisition_id = _requisition_id
     AND i.status NOT IN ('cancelled','closed')
     AND (_line_ids IS NULL OR i.id = ANY(_line_ids))
     AND GREATEST(i.quantity - i.quantity_ordered, 0) > 0;

  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    RAISE EXCEPTION 'No open requisition lines to source' USING ERRCODE='22023';
  END IF;

  PERFORM public._pr_recalc(_requisition_id);

  INSERT INTO public.business_event_outbox
    (org_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key, actor_user_id, source)
  VALUES (v_r.organization_id, 'procurement.requisition.sourced',
          'purchase_requisition', _requisition_id,
          jsonb_build_object('rfq_id', v_rfq_id, 'rfq_number', v_rfq_no, 'lines', n),
          'procurement.requisition.sourced:' || v_rfq_id::text, v_uid, 'procurement')
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN jsonb_build_object('success', true, 'rfq_id', v_rfq_id, 'rfq_number', v_rfq_no, 'lines', n);
END $$;

-- ---------- release: requisition -> PO ----------
CREATE OR REPLACE FUNCTION public.requisition_convert_to_po(
  _requisition_id uuid,
  _supplier_id uuid,
  _line_ids uuid[] DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_r public.purchase_requisitions; v_uid uuid := auth.uid();
        v_po_id uuid; v_po_no text; n int; v_subtotal numeric := 0;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  IF _supplier_id IS NULL THEN RAISE EXCEPTION 'A supplier is required' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_r FROM public.purchase_requisitions WHERE id = _requisition_id FOR UPDATE;
  IF v_r.id IS NULL THEN RAISE EXCEPTION 'Requisition not found' USING ERRCODE='22023'; END IF;
  IF NOT public.user_has_business_access(v_uid, v_r.business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF v_r.status NOT IN ('approved','sourcing','partially_procured') THEN
    RAISE EXCEPTION 'Only an approved requisition can be converted to a purchase order' USING ERRCODE='22023';
  END IF;

  v_po_no := public.get_next_po_number(v_r.organization_id);
  INSERT INTO public.purchase_orders(organization_id, business_id, vendor_id, po_number, status,
    order_date, expected_date, subtotal, tax_amount, total, currency, branch_id,
    deliver_to_branch_id, deliver_to_warehouse_id, project_id, requisition_id, created_by, notes)
  VALUES (v_r.organization_id, v_r.business_id, _supplier_id, v_po_no, 'draft',
    CURRENT_DATE, v_r.need_by_date, 0, 0, 0, v_r.currency, v_r.branch_id,
    v_r.destination_branch_id, v_r.destination_warehouse_id, v_r.project_id, v_r.id, v_uid,
    'Created from requisition ' || v_r.requisition_number)
  RETURNING id INTO v_po_id;

  INSERT INTO public.purchase_order_items(purchase_order_id, product_id, description, quantity,
    unit_price, line_total, project_id, requisition_item_id, sort_order)
  SELECT v_po_id, i.product_id, i.description,
         GREATEST(i.quantity - i.quantity_ordered, 0), COALESCE(i.estimated_unit_price, 0),
         GREATEST(i.quantity - i.quantity_ordered, 0) * COALESCE(i.estimated_unit_price, 0),
         v_r.project_id, i.id, i.sort_order
    FROM public.purchase_requisition_items i
   WHERE i.requisition_id = _requisition_id
     AND i.status NOT IN ('cancelled','closed')
     AND (_line_ids IS NULL OR i.id = ANY(_line_ids))
     AND GREATEST(i.quantity - i.quantity_ordered, 0) > 0;

  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    RAISE EXCEPTION 'No open requisition lines to order' USING ERRCODE='22023';
  END IF;

  SELECT COALESCE(sum(line_total),0) INTO v_subtotal
    FROM public.purchase_order_items WHERE purchase_order_id = v_po_id;
  UPDATE public.purchase_orders SET subtotal = v_subtotal, total = v_subtotal, updated_at = now()
   WHERE id = v_po_id;

  PERFORM public._pr_recalc(_requisition_id);

  INSERT INTO public.business_event_outbox
    (org_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key, actor_user_id, source)
  VALUES (v_r.organization_id, 'procurement.requisition.converted_to_po',
          'purchase_requisition', _requisition_id,
          jsonb_build_object('purchase_order_id', v_po_id, 'po_number', v_po_no, 'lines', n),
          'procurement.requisition.converted_to_po:' || v_po_id::text, v_uid, 'procurement')
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN jsonb_build_object('success', true, 'purchase_order_id', v_po_id, 'po_number', v_po_no, 'lines', n);
END $$;

-- ---------- over-ordering guard ----------
CREATE OR REPLACE FUNCTION public._pr_assert_not_overordered()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_req_qty numeric; v_ordered numeric;
BEGIN
  IF NEW.requisition_item_id IS NULL THEN RETURN NEW; END IF;
  SELECT quantity INTO v_req_qty FROM public.purchase_requisition_items WHERE id = NEW.requisition_item_id;
  SELECT COALESCE(sum(poi.quantity),0) INTO v_ordered
    FROM public.purchase_order_items poi
    JOIN public.purchase_orders po ON po.id = poi.purchase_order_id AND po.status <> 'cancelled'
   WHERE poi.requisition_item_id = NEW.requisition_item_id
     AND poi.id <> NEW.id;
  IF v_ordered + NEW.quantity > v_req_qty + 0.000001 THEN
    RAISE EXCEPTION 'Ordering % exceeds the requisitioned quantity of % for this requisition line',
      v_ordered + NEW.quantity, v_req_qty USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pr_assert_not_overordered ON public.purchase_order_items;
CREATE TRIGGER trg_pr_assert_not_overordered
  BEFORE INSERT OR UPDATE OF quantity, requisition_item_id ON public.purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION public._pr_assert_not_overordered();

-- ---------- R5: amend ----------
CREATE OR REPLACE FUNCTION public.requisition_amend(_requisition_id uuid, _reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_r public.purchase_requisitions; v_uid uuid := auth.uid(); v_ordered int; v_step int;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_r FROM public.purchase_requisitions WHERE id = _requisition_id FOR UPDATE;
  IF v_r.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Requisition not found'); END IF;
  IF NOT public.user_has_business_access(v_uid, v_r.business_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Access denied');
  END IF;
  IF v_r.status NOT IN ('approved','sourcing') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only an approved requisition that is not yet ordered can be amended');
  END IF;
  SELECT count(*) INTO v_ordered FROM public.purchase_requisition_items
   WHERE requisition_id = _requisition_id AND quantity_ordered > 0;
  IF v_ordered > 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Lines are already ordered; amend the purchase order instead');
  END IF;

  SELECT coalesce(max(step_order),0)+1 INTO v_step
    FROM public.purchase_requisition_approvals WHERE requisition_id = _requisition_id;
  PERFORM public._pr_lifecycle_begin();
  UPDATE public.purchase_requisitions
     SET status='draft', version = version + 1,
         submitted_at=NULL, submitted_by=NULL, approved_by=NULL, approved_at=NULL,
         approval_request_id=NULL, updated_at=now()
   WHERE id = _requisition_id;
  INSERT INTO public.purchase_requisition_approvals(requisition_id, step_order, actor_user_id, decision, comment)
    VALUES (_requisition_id, v_step, v_uid, 'amended', _reason);
  INSERT INTO public.business_event_outbox
    (org_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key, actor_user_id, source)
  VALUES (v_r.organization_id, 'procurement.requisition.amended',
          'purchase_requisition', _requisition_id,
          jsonb_build_object('reason', _reason, 'version', v_r.version + 1),
          'procurement.requisition.amended:' || _requisition_id::text || ':v' || (v_r.version + 1)::text,
          v_uid, 'procurement')
  ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN jsonb_build_object('success', true, 'version', v_r.version + 1);
END $$;

GRANT EXECUTE ON FUNCTION public.requisition_create_rfq(uuid, uuid[], date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.requisition_convert_to_po(uuid, uuid, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.requisition_amend(uuid, text) TO authenticated;