CREATE OR REPLACE FUNCTION public.purchase_return_create(_business_id uuid, _vendor_id uuid, _lines jsonb, _return_kind text DEFAULT 'goods'::text, _goods_receipt_id uuid DEFAULT NULL::uuid, _bill_id uuid DEFAULT NULL::uuid, _warehouse_id uuid DEFAULT NULL::uuid, _return_date date DEFAULT NULL::date, _reason_code text DEFAULT NULL::text, _reason text DEFAULT NULL::text, _notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_org uuid; v_branch uuid; v_grn public.goods_receipts;
  v_currency text; v_rate numeric := 1; v_base text;
  v_id uuid; v_pr public.purchase_returns; v_totals jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  IF NOT public.user_can_access_business(v_uid, _business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF _return_kind NOT IN ('goods','financial') THEN
    RAISE EXCEPTION 'Unknown return kind %', _return_kind USING ERRCODE='22023';
  END IF;

  SELECT organization_id, base_currency INTO v_org, v_base FROM public.businesses WHERE id = _business_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Business not found' USING ERRCODE='22023'; END IF;
  IF NOT public.user_has_module_permission(v_uid, v_org, _business_id, 'purchases', 'create') THEN
    RAISE EXCEPTION 'You do not have permission to create purchase returns' USING ERRCODE='42501';
  END IF;

  IF _goods_receipt_id IS NOT NULL THEN
    SELECT * INTO v_grn FROM public.goods_receipts WHERE id = _goods_receipt_id;
    IF v_grn.id IS NULL OR v_grn.business_id <> _business_id THEN
      RAISE EXCEPTION 'Goods receipt not found for this company' USING ERRCODE='22023';
    END IF;
    v_branch := v_grn.branch_id;

    -- Goods leaving a receipt that still carries landed cost would strand the
    -- capitalised charges in inventory. Landed cost is reversed first.
    IF _return_kind = 'goods' THEN
      PERFORM public.landed_cost_assert_receipt_unencumbered(_goods_receipt_id, 'goods_return');
    END IF;
  ELSIF _return_kind = 'goods' THEN
    RAISE EXCEPTION 'A goods return must originate from a goods receipt' USING ERRCODE='22023';
  END IF;

  SELECT COALESCE(b.currency, po.currency, v_base, 'USD')
    INTO v_currency
    FROM (SELECT 1) x
    LEFT JOIN public.bills b ON b.id = _bill_id
    LEFT JOIN public.purchase_orders po ON po.id = v_grn.purchase_order_id;
  v_currency := COALESCE(v_currency, v_base, 'USD');

  -- ADR 0135/0136: one rate book, one resolver, no silent parity. A foreign
  -- return with no rate on file is refused rather than valued at 1:1.
  IF v_currency IS DISTINCT FROM v_base THEN
    v_rate := public.require_exchange_rate(v_org, _business_id, v_currency,
                                           COALESCE(_return_date, CURRENT_DATE));
  END IF;

  PERFORM public._pret_lifecycle_begin();

  INSERT INTO public.purchase_returns(
    organization_id, business_id, branch_id, vendor_id, return_number, return_date, status,
    return_kind, goods_receipt_id, purchase_order_id, bill_id, warehouse_id,
    reason_code, reason, notes, currency, exchange_rate,
    subtotal, tax_amount, total, created_by)
  VALUES (
    v_org, _business_id, COALESCE(v_branch, (SELECT branch_id FROM public.warehouses WHERE id = _warehouse_id)),
    _vendor_id, NULL, COALESCE(_return_date, CURRENT_DATE), 'draft',
    _return_kind, _goods_receipt_id, v_grn.purchase_order_id, _bill_id,
    COALESCE(_warehouse_id, v_grn.warehouse_id),
    _reason_code, _reason, _notes, v_currency, v_rate, 0, 0, 0, v_uid)
  RETURNING id INTO v_id;

  v_totals := public._pret_write_lines(v_id, _lines);

  SELECT * INTO v_pr FROM public.purchase_returns WHERE id = v_id;
  PERFORM public._pret_log(v_pr, 'created', NULL, 'draft', v_totals);

  RETURN jsonb_build_object('success', true, 'id', v_id,
                            'return_number', v_pr.return_number, 'totals', v_totals);
END
$function$;