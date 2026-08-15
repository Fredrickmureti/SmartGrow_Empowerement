CREATE OR REPLACE FUNCTION public.finance_post_gr_journal(_gr_id uuid, _actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_grn RECORD; v_total_cost numeric := 0;
  v_inventory_acct uuid; v_grni_acct uuid; v_journal_id uuid;
BEGIN
  SELECT id, organization_id, business_id, branch_id, warehouse_id, receipt_number
    INTO v_grn FROM goods_receipts WHERE id = _gr_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Goods receipt not found'); END IF;

  SELECT COALESCE(SUM(quantity * unit_cost), 0)
    INTO v_total_cost
    FROM stock_movements
   WHERE reference_type = 'goods_receipt' AND reference_id = _gr_id;

  IF v_total_cost <= 0 THEN
    RETURN jsonb_build_object('success', true, 'total_cost', 0, 'journal_id', NULL);
  END IF;

  SELECT id INTO v_inventory_acct FROM accounts
   WHERE organization_id = v_grn.organization_id AND business_id = v_grn.business_id
     AND detail_type = 'inventory' AND is_active = true LIMIT 1;
  SELECT id INTO v_grni_acct FROM accounts
   WHERE business_id = v_grn.business_id AND system_role = 'grni' LIMIT 1;

  IF v_inventory_acct IS NULL OR v_grni_acct IS NULL THEN
    RETURN jsonb_build_object('success', true, 'total_cost', v_total_cost, 'journal_id', NULL,
      'warning', 'Inventory or GR/NI account missing — journal skipped');
  END IF;

  -- Single posting monopoly: delegate to post_journal_entry_atomic.
  v_journal_id := public.post_journal_entry_atomic(
    v_grn.organization_id, v_grn.business_id,
    public.generate_next_je_number(v_grn.organization_id, v_grn.business_id),
    current_date,
    v_grn.receipt_number,
    'GRN ' || v_grn.receipt_number || ' — Inventory receipt',
    'goods_receipt', _gr_id, _actor, false, false,
    jsonb_build_array(
      jsonb_build_object('account_id', v_inventory_acct, 'debit', v_total_cost, 'credit', 0,
        'description', 'Inventory in (GRN ' || v_grn.receipt_number || ')'),
      jsonb_build_object('account_id', v_grni_acct, 'debit', 0, 'credit', v_total_cost,
        'description', 'GR/NI accrual (GRN ' || v_grn.receipt_number || ')')
    ),
    NULL, NULL, NULL, v_grn.branch_id
  );

  -- journal_entries carries provenance on source_type/source_id only; the
  -- legacy reference_type/reference_id columns no longer exist.

  RETURN jsonb_build_object('success', true, 'total_cost', v_total_cost, 'journal_id', v_journal_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.void_goods_receipt_atomic(_gr_id uuid, _reason text, _void_date date DEFAULT NULL::date, _actor uuid DEFAULT NULL::uuid, _client_request_id text DEFAULT NULL::text, _reason_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_grn        public.goods_receipts%ROWTYPE;
  v_date       date := COALESCE(_void_date, CURRENT_DATE);
  v_actor      uuid := COALESCE(_actor, auth.uid());
  v_je         RECORD;
  v_rev        uuid;
  v_reversals  uuid[] := ARRAY[]::uuid[];
  v_stock      jsonb;
  v_tasks      jsonb;
BEGIN
  IF _gr_id IS NULL THEN
    RAISE EXCEPTION 'void_goods_receipt_atomic requires a goods receipt id' USING ERRCODE = '22023';
  END IF;
  IF _reason IS NULL OR btrim(_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required to reverse a goods receipt.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_grn FROM public.goods_receipts WHERE id = _gr_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Goods receipt % not found.', _gr_id USING ERRCODE = 'P0002';
  END IF;

  IF COALESCE(v_grn.status, 'draft') IN ('reversed', 'cancelled', 'voided') THEN
    RETURN jsonb_build_object(
      'result', 'already_reversed',
      'goods_receipt_id', _gr_id,
      'receipt_number', v_grn.receipt_number);
  END IF;

  PERFORM public.assert_reversal_reason('goods_receipt', _reason_code, _reason);
  PERFORM public.assert_can_reverse('goods_receipt', _gr_id, 'goods_return', v_actor, v_date);

  FOR v_je IN
    SELECT je.id
      FROM public.journal_entries je
     WHERE je.organization_id = v_grn.organization_id
       AND je.source_type = 'goods_receipt'
       AND je.source_id = _gr_id
       AND je.status::text NOT IN ('voided', 'reversed')
  LOOP
    v_rev := public.void_journal_entry_atomic(
      v_je.id,
      'Reverse goods receipt ' || COALESCE(v_grn.receipt_number, _gr_id::text) || ': ' || _reason,
      v_actor,
      NULL,
      v_date);
    IF v_rev IS NOT NULL THEN
      v_reversals := v_reversals || v_rev;
    END IF;
  END LOOP;

  v_stock := public.wms_reverse_gr_stock(_gr_id, v_actor, _reason);
  IF NOT COALESCE((v_stock->>'success')::boolean, false) THEN
    RAISE EXCEPTION 'wms_reverse_gr_stock failed: %', v_stock->>'error';
  END IF;

  v_tasks := public.wms_cancel_tasks_for_document('goods_receipt', _gr_id, _reason, v_actor);

  DELETE FROM public.bill_grn_matches WHERE goods_receipt_id = _gr_id;

  UPDATE public.goods_receipts
     SET status               = 'reversed',
         reversal_reason_code = _reason_code,
         notes                = COALESCE(notes || E'\n', '') || 'Reversed ' || v_date::text || ': ' || _reason,
         updated_at           = now()
   WHERE id = _gr_id;

  INSERT INTO public.business_event_outbox (
    org_id, branch_id, warehouse_id,
    event_type, source_doc_type, source_doc_id,
    payload, occurred_at)
  VALUES (
    v_grn.organization_id, v_grn.branch_id, v_grn.warehouse_id,
    'goods_receipt.reversed', 'goods_receipt', _gr_id,
    jsonb_build_object(
      'receipt_number', v_grn.receipt_number,
      'reason', _reason,
      'reason_code', _reason_code,
      'reversal_journal_entry_ids', to_jsonb(v_reversals),
      'stock', v_stock,
      'tasks', v_tasks,
      'client_request_id', _client_request_id),
    now());

  RETURN jsonb_build_object(
    'result', 'reversed',
    'goods_receipt_id', _gr_id,
    'receipt_number', v_grn.receipt_number,
    'void_date', v_date,
    'reversal_journal_entry_ids', to_jsonb(v_reversals),
    'stock', v_stock,
    'tasks', v_tasks,
    'client_request_id', _client_request_id);
END;
$function$;