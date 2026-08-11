CREATE OR REPLACE FUNCTION public._pret_write_lines(_pr_id uuid, _lines jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_pr public.purchase_returns;
  v_line jsonb; v_idx int := 0;
  v_grn_item public.goods_receipt_items;
  v_qty numeric; v_price numeric; v_tax_rate numeric; v_tax numeric; v_line_total numeric;
  v_returnable numeric;
  v_subtotal numeric := 0; v_tax_total numeric := 0;
BEGIN
  SELECT * INTO v_pr FROM public.purchase_returns WHERE id = _pr_id;

  DELETE FROM public.purchase_return_items WHERE purchase_return_id = _pr_id;

  IF _lines IS NULL OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'A purchase return needs at least one line' USING ERRCODE='22023';
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    v_qty := COALESCE((v_line->>'quantity')::numeric, 0);
    IF v_qty <= 0 THEN RAISE EXCEPTION 'Return quantity must be greater than zero' USING ERRCODE='22023'; END IF;

    v_grn_item := NULL;
    IF v_line->>'goods_receipt_item_id' IS NOT NULL THEN
      -- Serialise concurrent returns against the same receipt line: without this
      -- two transactions can each read the same remaining-returnable figure and
      -- jointly return more than was received.
      PERFORM public._pret_lock_receipt_line((v_line->>'goods_receipt_item_id')::uuid);

      SELECT gi.* INTO v_grn_item
        FROM public.goods_receipt_items gi
        JOIN public.goods_receipts gr ON gr.id = gi.goods_receipt_id
       WHERE gi.id = (v_line->>'goods_receipt_item_id')::uuid
         AND gr.business_id = v_pr.business_id
         AND (v_pr.goods_receipt_id IS NULL OR gi.goods_receipt_id = v_pr.goods_receipt_id);
      IF v_grn_item.id IS NULL THEN
        RAISE EXCEPTION 'Receipt line does not belong to this goods receipt' USING ERRCODE='22023';
      END IF;

      SELECT quantity_returnable INTO v_returnable
        FROM public.purchase_return_returnable_lines(v_grn_item.goods_receipt_id)
       WHERE goods_receipt_item_id = v_grn_item.id;

      IF v_qty > COALESCE(v_returnable, 0) + 1e-9 THEN
        RAISE EXCEPTION 'Cannot return % of "%": only % remain returnable on this receipt line',
          v_qty, COALESCE(v_grn_item.description,'item'), COALESCE(v_returnable,0)
          USING ERRCODE='22023';
      END IF;
    ELSIF v_pr.return_kind = 'goods' THEN
      RAISE EXCEPTION 'A goods return line must reference the goods receipt line it came from'
        USING ERRCODE='22023';
    END IF;

    -- Price basis: receipt landed cost wins; explicit price only for financial adjustments
    v_price := COALESCE(v_grn_item.unit_cost_basis, (v_line->>'unit_price')::numeric, 0);
    v_tax_rate := COALESCE((v_line->>'tax_rate')::numeric, 0);
    v_line_total := ROUND(v_qty * v_price, 6);
    v_tax := ROUND(v_line_total * v_tax_rate / 100.0, 6);

    INSERT INTO public.purchase_return_items(
      purchase_return_id, goods_receipt_item_id, product_id, bill_item_id, description,
      quantity, unit_price, unit_cost_basis, tax_rate, tax_amount, line_total,
      return_reason, condition, lot_number, serial_number, location_id,
      packaging_id, display_quantity, display_uom_id, uom_snapshot, sort_order)
    VALUES (
      _pr_id, v_grn_item.id,
      COALESCE(v_grn_item.product_id, NULLIF(v_line->>'product_id','')::uuid),
      NULLIF(v_line->>'bill_item_id','')::uuid,
      COALESCE(NULLIF(v_line->>'description',''), v_grn_item.description, 'Returned item'),
      v_qty, v_price, v_grn_item.unit_cost_basis, v_tax_rate, v_tax, v_line_total,
      NULLIF(v_line->>'return_reason',''), NULLIF(v_line->>'condition',''),
      COALESCE(v_grn_item.lot_number, NULLIF(v_line->>'lot_number','')),
      COALESCE(v_grn_item.serial_number, NULLIF(v_line->>'serial_number','')),
      NULLIF(v_line->>'location_id','')::uuid,
      COALESCE(v_grn_item.packaging_id, NULLIF(v_line->>'packaging_id','')::uuid),
      NULLIF(v_line->>'display_quantity','')::numeric,
      COALESCE(v_grn_item.display_uom_id, NULLIF(v_line->>'display_uom_id','')::uuid),
      COALESCE(v_grn_item.uom_snapshot, NULLIF(v_line->>'uom_snapshot','')),
      v_idx);

    v_subtotal := v_subtotal + v_line_total;
    v_tax_total := v_tax_total + v_tax;
    v_idx := v_idx + 1;
  END LOOP;

  UPDATE public.purchase_returns
     SET subtotal = v_subtotal, tax_amount = v_tax_total, total = v_subtotal + v_tax_total,
         updated_at = now()
   WHERE id = _pr_id;

  RETURN jsonb_build_object('subtotal', v_subtotal, 'tax_amount', v_tax_total,
                            'total', v_subtotal + v_tax_total, 'line_count', v_idx);
END
$fn$;