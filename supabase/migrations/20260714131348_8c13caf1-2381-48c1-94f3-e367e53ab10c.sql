
CREATE OR REPLACE FUNCTION public.attach_recommendation_to_po(
  p_rec_id uuid,
  p_po_id uuid,
  p_qty numeric DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rec public.procurement_recommendations%ROWTYPE;
  v_po  public.purchase_orders%ROWTYPE;
  v_uid uuid := auth.uid();
  v_qty numeric;
  v_unit_price numeric := 0;
  v_product_name text;
  v_line_total numeric;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO v_rec FROM public.procurement_recommendations WHERE id = p_rec_id;
  IF v_rec.id IS NULL THEN RAISE EXCEPTION 'Recommendation not found'; END IF;

  SELECT * INTO v_po FROM public.purchase_orders WHERE id = p_po_id;
  IF v_po.id IS NULL THEN RAISE EXCEPTION 'Purchase order not found'; END IF;

  IF NOT public.user_can_access_business(v_uid, v_rec.business_id) THEN
    RAISE EXCEPTION 'Access denied to business';
  END IF;
  IF v_rec.branch_id IS NOT NULL AND NOT public.can_access_branch(v_uid, v_rec.branch_id) THEN
    RAISE EXCEPTION 'Access denied to branch';
  END IF;
  IF v_po.business_id IS DISTINCT FROM v_rec.business_id THEN
    RAISE EXCEPTION 'Purchase order belongs to a different business';
  END IF;
  IF v_po.status <> 'draft' THEN
    RAISE EXCEPTION 'Purchase order is % — only draft POs can accept new lines', v_po.status;
  END IF;
  IF v_rec.status IN ('fulfilled','cancelled','merged') THEN
    RAISE EXCEPTION 'Recommendation is % and cannot be converted', v_rec.status;
  END IF;
  IF v_rec.linked_po_id IS NOT NULL THEN
    RAISE EXCEPTION 'Recommendation already linked to purchase order %', v_rec.linked_po_id;
  END IF;
  IF v_rec.preferred_vendor_id IS NOT NULL
     AND v_po.vendor_id IS DISTINCT FROM v_rec.preferred_vendor_id THEN
    RAISE EXCEPTION 'Vendor mismatch: recommendation prefers a different vendor than the PO';
  END IF;

  v_qty := COALESCE(p_qty, v_rec.edited_qty, v_rec.suggested_qty);
  IF v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;

  SELECT name, COALESCE(cost_price, 0) INTO v_product_name, v_unit_price
  FROM public.products WHERE id = v_rec.product_id;

  v_line_total := v_qty * v_unit_price;

  INSERT INTO public.purchase_order_items(
    purchase_order_id, product_id, description, quantity, unit_price, line_total
  ) VALUES (
    p_po_id, v_rec.product_id,
    COALESCE(v_product_name, 'Replenishment'),
    v_qty, v_unit_price, v_line_total
  );

  UPDATE public.purchase_orders
  SET subtotal = COALESCE(subtotal, 0) + v_line_total,
      total    = COALESCE(total,    0) + v_line_total,
      updated_at = now()
  WHERE id = p_po_id;

  UPDATE public.procurement_recommendations
  SET status = 'executing',
      linked_po_id = p_po_id,
      actioned_at = now(),
      actioned_by = v_uid,
      actioned_ref_type = 'purchase_order',
      actioned_ref_id = p_po_id,
      updated_at = now()
  WHERE id = p_rec_id;

  PERFORM public.log_procurement_recommendation_event(
    p_rec_id, 'attached_po', v_rec.status, 'executing',
    jsonb_build_object(
      'purchase_order_id', p_po_id,
      'po_number', v_po.po_number,
      'vendor_id', v_po.vendor_id,
      'quantity', v_qty,
      'attached_to_existing', true
    ),
    p_notes
  );

  RETURN p_po_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.attach_recommendation_to_po(uuid, uuid, numeric, text) TO authenticated;
