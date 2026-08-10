CREATE OR REPLACE FUNCTION public.rfq_convert_awards_to_po(_rfq_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v public.rfqs; aw RECORD; q public.rfq_quotations;
  v_po_id uuid; v_po_no text; v_sub numeric; v_tax numeric; v_lead int;
  v_pos jsonb := '[]'::jsonb;
BEGIN
  v := _rfq_guard(_rfq_id, ARRAY['awarded','partially_awarded']);
  PERFORM public._rfq_assert_award_decided(_rfq_id);

  FOR aw IN SELECT * FROM rfq_awards WHERE rfq_id = _rfq_id FOR UPDATE LOOP
    IF aw.purchase_order_id IS NOT NULL THEN CONTINUE; END IF;  -- idempotent
    SELECT * INTO q FROM rfq_quotations WHERE id = aw.quotation_id;

    SELECT COALESCE(SUM(line_total),0), COALESCE(SUM(line_total * tax_rate / 100),0)
      INTO v_sub, v_tax FROM rfq_award_items WHERE award_id = aw.id;
    v_lead := COALESCE(q.lead_time_days, 0);
    v_po_no := get_next_po_number(v.organization_id);

    INSERT INTO purchase_orders (organization_id, business_id, branch_id, vendor_id, po_number,
      status, order_date, expected_date, subtotal, tax_amount, discount_amount, total, currency,
      notes, created_by, project_id, requisition_id, deliver_to_warehouse_id, deliver_to_branch_id,
      rfq_id, rfq_award_id)
    VALUES (v.organization_id, v.business_id, v.branch_id, aw.supplier_id, v_po_no,
      'draft', CURRENT_DATE, CURRENT_DATE + (v_lead || ' days')::interval,
      v_sub, v_tax, 0, v_sub + v_tax, aw.currency,
      v.notes, auth.uid(), v.project_id, v.requisition_id, v.deliver_to_warehouse_id,
      COALESCE(v.deliver_to_branch_id, v.branch_id), v.id, aw.id)
    RETURNING id INTO v_po_id;

    INSERT INTO purchase_order_items (purchase_order_id, product_id, description, quantity,
      quantity_received, unit_price, tax_rate, tax_amount, line_total, sort_order,
      display_uom_id, display_quantity, requisition_item_id, rfq_item_id, rfq_quotation_item_id)
    SELECT v_po_id, COALESCE(qi.alternate_product_id, qi.product_id, ri.product_id),
      COALESCE(qi.description, ri.description), ai.awarded_quantity, 0, ai.unit_price,
      ai.tax_rate, ROUND(ai.line_total * ai.tax_rate / 100, 6), ai.line_total,
      COALESCE(ri.sort_order, 0), ai.awarded_uom_id, ai.awarded_quantity,
      ri.requisition_item_id, ri.id, qi.id
    FROM rfq_award_items ai
    JOIN rfq_items ri ON ri.id = ai.rfq_item_id
    JOIN rfq_quotation_items qi ON qi.id = ai.quotation_item_id
    WHERE ai.award_id = aw.id;

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
END;
$function$;