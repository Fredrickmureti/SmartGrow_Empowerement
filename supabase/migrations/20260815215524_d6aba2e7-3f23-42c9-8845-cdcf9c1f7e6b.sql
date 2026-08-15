-- F4.0 — the UoM normalizer must fire before the consistency validator.
-- Postgres fires BEFORE triggers in name order; every other purchasing line
-- table uses the `a_` prefix. On purchase_order_items the validator sorted
-- first, so a pack-denominated line was rejected unless the browser had
-- already computed the base quantity itself.
ALTER TRIGGER trg_uom_normalize_po_items ON public.purchase_order_items
  RENAME TO a_uom_normalize_po_items;

-- F4.4 — one server-side gate for supplier purchasing terms at the point a
-- commitment is created. Reads policy only through the canonical validator
-- (ADR 0141); no arithmetic here.
CREATE OR REPLACE FUNCTION public._purchase_assert_order_quantity(
  p_business_id uuid,
  p_supplier_id uuid,
  p_product_id  uuid,
  p_quantity    numeric,
  p_label       text DEFAULT NULL,
  p_on_date     date DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v RECORD; v_item text := COALESCE(NULLIF(p_label, ''), 'This item');
BEGIN
  IF p_product_id IS NULL OR p_quantity IS NULL THEN RETURN; END IF;

  SELECT * INTO v
  FROM public.validate_supplier_order_quantity(
         p_business_id, p_product_id, p_supplier_id, p_quantity,
         COALESCE(p_on_date, CURRENT_DATE));

  IF v IS NULL OR v.is_valid THEN RETURN; END IF;

  CASE v.reason
    WHEN 'QUANTITY_NOT_POSITIVE' THEN
      RAISE EXCEPTION 'Enter a quantity greater than zero for %', v_item
        USING ERRCODE = '22023';
    WHEN 'BELOW_MIN_ORDER_QTY' THEN
      RAISE EXCEPTION '% has a minimum order quantity of %', v_item, v.min_order_qty
        USING ERRCODE = '22023';
    WHEN 'NOT_ON_ORDER_INCREMENT' THEN
      RAISE EXCEPTION '% must be ordered in multiples of %. The nearest allowed quantity is %',
        v_item, v.order_increment, v.adjusted_quantity
        USING ERRCODE = '22023';
    ELSE
      RAISE EXCEPTION 'This quantity is not allowed for the selected supplier (%)', v_item
        USING ERRCODE = '22023';
  END CASE;
END $$;

REVOKE ALL ON FUNCTION public._purchase_assert_order_quantity(uuid,uuid,uuid,numeric,text,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._purchase_assert_order_quantity(uuid,uuid,uuid,numeric,text,date) TO authenticated, service_role;

-- F4.1 — award -> PO keeps the purchasing unit, and the header is recomputed
-- from the persisted (normalized) lines rather than from the award rows.
CREATE OR REPLACE FUNCTION public.rfq_convert_awards_to_po(_rfq_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v public.rfqs; aw RECORD; q public.rfq_quotations; ln RECORD;
  v_po_id uuid; v_po_no text; v_sub numeric; v_tax numeric; v_lead int;
  v_pos jsonb := '[]'::jsonb;
BEGIN
  v := _rfq_guard(_rfq_id, ARRAY['awarded','partially_awarded']);
  PERFORM public._rfq_assert_award_decided(_rfq_id);

  FOR aw IN SELECT * FROM rfq_awards WHERE rfq_id = _rfq_id FOR UPDATE LOOP
    IF aw.purchase_order_id IS NOT NULL THEN CONTINUE; END IF;  -- idempotent
    SELECT * INTO q FROM rfq_quotations WHERE id = aw.quotation_id;

    -- Supplier purchasing terms are policy at the moment of commitment.
    FOR ln IN
      SELECT COALESCE(qi.alternate_product_id, qi.product_id, ri.product_id) AS product_id,
             COALESCE(qi.description, ri.description) AS description,
             ai.awarded_quantity
        FROM rfq_award_items ai
        JOIN rfq_items ri ON ri.id = ai.rfq_item_id
        JOIN rfq_quotation_items qi ON qi.id = ai.quotation_item_id
       WHERE ai.award_id = aw.id
    LOOP
      PERFORM public._purchase_assert_order_quantity(
        v.business_id, aw.supplier_id, ln.product_id,
        ln.awarded_quantity, ln.description);
    END LOOP;

    v_lead := COALESCE(q.lead_time_days, 0);
    v_po_no := get_next_po_number(v.organization_id);

    INSERT INTO purchase_orders (organization_id, business_id, branch_id, vendor_id, po_number,
      status, order_date, expected_date, subtotal, tax_amount, discount_amount, total, currency,
      notes, created_by, project_id, requisition_id, deliver_to_warehouse_id, deliver_to_branch_id,
      rfq_id, rfq_award_id)
    VALUES (v.organization_id, v.business_id, v.branch_id, aw.supplier_id, v_po_no,
      'draft', CURRENT_DATE, CURRENT_DATE + (v_lead || ' days')::interval,
      0, 0, 0, 0, aw.currency,
      v.notes, auth.uid(), v.project_id, v.requisition_id, v.deliver_to_warehouse_id,
      COALESCE(v.deliver_to_branch_id, v.branch_id), v.id, aw.id)
    RETURNING id INTO v_po_id;

    -- `quantity` is a placeholder: the a_uom_normalize_po_items trigger derives
    -- the canonical base quantity from display_quantity + purchasing unit.
    INSERT INTO purchase_order_items (purchase_order_id, product_id, description, quantity,
      quantity_received, unit_price, tax_rate, tax_amount, line_total, sort_order,
      display_uom_id, display_quantity, packaging_id,
      requisition_item_id, rfq_item_id, rfq_quotation_item_id)
    SELECT v_po_id, COALESCE(qi.alternate_product_id, qi.product_id, ri.product_id),
      COALESCE(qi.description, ri.description), ai.awarded_quantity, 0, ai.unit_price,
      ai.tax_rate, ROUND(ai.line_total * ai.tax_rate / 100, 6), ai.line_total,
      COALESCE(ri.sort_order, 0), ai.awarded_uom_id, ai.awarded_quantity,
      CASE
        WHEN ai.awarded_uom_id IS NULL
          OR ai.awarded_uom_id IS NOT DISTINCT FROM ri.display_uom_id
        THEN ri.packaging_id
        ELSE NULL
      END,
      ri.requisition_item_id, ri.id, qi.id
    FROM rfq_award_items ai
    JOIN rfq_items ri ON ri.id = ai.rfq_item_id
    JOIN rfq_quotation_items qi ON qi.id = ai.quotation_item_id
    WHERE ai.award_id = aw.id;

    SELECT COALESCE(SUM(line_total), 0), COALESCE(SUM(tax_amount), 0)
      INTO v_sub, v_tax
      FROM purchase_order_items WHERE purchase_order_id = v_po_id;

    UPDATE purchase_orders
       SET subtotal = v_sub, tax_amount = v_tax, total = v_sub + v_tax, updated_at = now()
     WHERE id = v_po_id;

    UPDATE rfq_awards SET purchase_order_id = v_po_id, converted_at = now() WHERE id = aw.id;
    v_pos := v_pos || jsonb_build_object('purchase_order_id', v_po_id, 'po_number', v_po_no,
                                         'supplier_id', aw.supplier_id);
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM rfq_awards WHERE rfq_id = _rfq_id AND purchase_order_id IS NULL) THEN
    UPDATE rfqs SET status = 'converted', converted_at = now(), closed_at = now(),
      closed_by = auth.uid(), updated_at = now() WHERE id = _rfq_id;
  END IF;

  PERFORM _rfq_emit(v, 'rfq.converted_to_purchase_order', jsonb_build_object('purchase_orders', v_pos), auth.uid());
  RETURN jsonb_build_object('success', true, 'purchase_orders', v_pos);
END $$;

-- F4.1/F4.4 — requisition -> PO keeps the purchasing unit and honours terms.
CREATE OR REPLACE FUNCTION public.requisition_convert_to_po(
  _requisition_id uuid, _supplier_id uuid, _line_ids uuid[] DEFAULT NULL::uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_r public.purchase_requisitions; v_uid uuid := auth.uid();
        v_po_id uuid; v_po_no text; n int; v_subtotal numeric := 0; ln RECORD;
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

  -- Supplier purchasing terms gate, before anything is written.
  FOR ln IN
    SELECT i.product_id, i.description,
           GREATEST(i.quantity - i.quantity_ordered, 0) AS outstanding,
           i.packaging_id
      FROM public.purchase_requisition_items i
     WHERE i.requisition_id = _requisition_id
       AND i.status NOT IN ('cancelled','closed')
       AND (_line_ids IS NULL OR i.id = ANY(_line_ids))
       AND GREATEST(i.quantity - i.quantity_ordered, 0) > 0
  LOOP
    PERFORM public._purchase_assert_order_quantity(
      v_r.business_id, _supplier_id, ln.product_id,
      CASE
        WHEN ln.packaging_id IS NULL THEN ln.outstanding
        ELSE ln.outstanding / NULLIF(
          (SELECT pk.qty_in_base_uom FROM public.product_packaging pk WHERE pk.id = ln.packaging_id), 0)
      END,
      ln.description);
  END LOOP;

  v_po_no := public.get_next_po_number(v_r.organization_id);
  INSERT INTO public.purchase_orders(organization_id, business_id, vendor_id, po_number, status,
    order_date, expected_date, subtotal, tax_amount, total, currency, branch_id,
    deliver_to_branch_id, deliver_to_warehouse_id, project_id, requisition_id, created_by, notes)
  VALUES (v_r.organization_id, v_r.business_id, _supplier_id, v_po_no, 'draft',
    CURRENT_DATE, v_r.need_by_date, 0, 0, 0, v_r.currency, v_r.branch_id,
    v_r.destination_branch_id, v_r.destination_warehouse_id, v_r.project_id, v_r.id, v_uid,
    'Created from requisition ' || v_r.requisition_number)
  RETURNING id INTO v_po_id;

  -- Outstanding demand is carried in base units; display_quantity is left NULL
  -- so the normalizer derives the supplier-facing quantity from the packaging.
  INSERT INTO public.purchase_order_items(purchase_order_id, product_id, description, quantity,
    unit_price, line_total, project_id, requisition_item_id, sort_order,
    packaging_id, display_uom_id)
  SELECT v_po_id, i.product_id, i.description,
         GREATEST(i.quantity - i.quantity_ordered, 0), COALESCE(i.estimated_unit_price, 0),
         GREATEST(i.quantity - i.quantity_ordered, 0) * COALESCE(i.estimated_unit_price, 0),
         v_r.project_id, i.id, i.sort_order,
         i.packaging_id, i.display_uom_id
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