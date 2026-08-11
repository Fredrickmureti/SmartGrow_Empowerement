CREATE OR REPLACE FUNCTION public.purchase_return_raise_credit(_id uuid, _row_version integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_pr public.purchase_returns; v_items jsonb; v_res jsonb; v_cn_id uuid; v_prev text;
BEGIN
  v_pr := public._pret_load(_id, _row_version);
  IF v_pr.vendor_credit_note_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'already', true,
                              'vendor_credit_note_id', v_pr.vendor_credit_note_id);
  END IF;
  IF v_pr.status NOT IN ('dispatched','acknowledged')
     AND NOT (v_pr.return_kind = 'financial' AND v_pr.status = 'approved') THEN
    RAISE EXCEPTION 'A debit note can only be raised once the goods are dispatched (or for an approved financial adjustment)'
      USING ERRCODE='22023';
  END IF;
  v_prev := v_pr.status;

  SELECT jsonb_agg(jsonb_build_object(
           'description', ri.description, 'quantity', ri.quantity,
           'unit_price', ri.unit_price, 'tax_rate', COALESCE(ri.tax_rate,0),
           'tax_amount', COALESCE(ri.tax_amount,0), 'line_total', ri.line_total,
           'product_id', ri.product_id, 'sort_order', ri.sort_order)
           ORDER BY ri.sort_order)
    INTO v_items
    FROM public.purchase_return_items ri WHERE ri.purchase_return_id = _id;

  v_res := public.create_vendor_credit_note_atomic(
    v_pr.organization_id, v_pr.business_id, v_pr.branch_id, v_pr.vendor_id, v_pr.bill_id,
    CURRENT_DATE,
    'Vendor debit note for purchase return ' || v_pr.return_number ||
      COALESCE(' — ' || v_pr.reason_code, ''),
    v_items, true);

  v_cn_id := NULLIF(v_res->>'credit_note_id','')::uuid;
  IF v_cn_id IS NULL THEN v_cn_id := NULLIF(v_res->>'id','')::uuid; END IF;

  PERFORM public._pret_lifecycle_begin();
  UPDATE public.purchase_returns
     SET vendor_credit_note_id = v_cn_id, credited_at = now(), status = 'credited',
         row_version = row_version + 1, updated_at = now()
   WHERE id = _id;
  SELECT * INTO v_pr FROM public.purchase_returns WHERE id=_id;
  PERFORM public._pret_log(v_pr, 'credited', v_prev, 'credited', v_res);

  -- Financial leg of the lifecycle. Idempotent per return via the outbox
  -- idempotency key, exactly like `procurement.return.dispatched`.
  PERFORM public._pret_emit_outbox(v_pr, 'credited',
    jsonb_build_object('return_number', v_pr.return_number,
                       'vendor_id', v_pr.vendor_id,
                       'bill_id', v_pr.bill_id,
                       'vendor_credit_note_id', v_cn_id,
                       'amount', v_pr.total,
                       'currency', v_pr.currency,
                       'credited_at', v_pr.credited_at));

  RETURN jsonb_build_object('success', true, 'row_version', v_pr.row_version,
                            'vendor_credit_note_id', v_cn_id, 'credit_note', v_res);
END $function$;