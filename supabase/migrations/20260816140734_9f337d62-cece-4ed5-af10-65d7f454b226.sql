CREATE OR REPLACE FUNCTION public.landed_cost_bill_encumbrance(_bill_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH v AS (
    SELECT DISTINCT lv.id, lv.voucher_number, lv.status, lv.total_base_amount,
           lv.capitalized_amount
      FROM public.landed_cost_vouchers lv
     WHERE lv.status NOT IN ('draft', 'cancelled', 'reversed')
       AND (
         lv.source_bill_id = _bill_id
         OR EXISTS (SELECT 1 FROM public.landed_cost_components c
                     WHERE c.voucher_id = lv.id AND c.source_bill_id = _bill_id)
       )
  )
  SELECT jsonb_build_object(
    'bill_id',          _bill_id,
    'encumbered',       EXISTS (SELECT 1 FROM v),
    'posted_count',     (SELECT count(*)::int FROM v WHERE status = 'posted'),
    'open_count',       (SELECT count(*)::int FROM v WHERE status <> 'posted'),
    'capitalized',      COALESCE((SELECT SUM(capitalized_amount) FROM v WHERE status = 'posted'), 0),
    'vouchers',         COALESCE((SELECT jsonb_agg(jsonb_build_object(
                                          'id', id, 'voucher_number', voucher_number,
                                          'status', status, 'amount', total_base_amount)
                                        ORDER BY voucher_number)
                                    FROM v), '[]'::jsonb),
    'voucher_numbers',  COALESCE((SELECT string_agg(voucher_number, ', ' ORDER BY voucher_number)
                                    FROM v), ''));
$function$;

CREATE OR REPLACE FUNCTION public.landed_cost_bill_block_reason(_bill_id uuid)
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN NOT COALESCE((e->>'encumbered')::boolean, false) THEN NULL
    WHEN (e->>'posted_count')::int > 0 THEN
      'Landed cost ' || (e->>'voucher_numbers') || ' uses this bill and '
      || to_char((e->>'capitalized')::numeric, 'FM999999999990.00')
      || ' of those charges are capitalised into the stock value. Reverse the landed cost first, '
      || 'otherwise crediting the supplier would relieve the landed cost clearing account twice '
      || 'and leave the charges inside inventory.'
    ELSE
      'Landed cost ' || (e->>'voucher_numbers') || ' is built from this bill. '
      || 'Cancel or re-build the landed cost first, otherwise it would spread charges the '
      || 'supplier has already credited.'
  END
  FROM (SELECT public.landed_cost_bill_encumbrance(_bill_id) AS e) s;
$function$;

CREATE OR REPLACE FUNCTION public.landed_cost_assert_bill_unencumbered(
  _bill_id uuid, _operation text DEFAULT 'vendor_credit_note'::text)
RETURNS void
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_reason text;
BEGIN
  IF _bill_id IS NULL THEN RETURN; END IF;
  v_reason := public.landed_cost_bill_block_reason(_bill_id);
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION '%', v_reason USING ERRCODE = '23514', HINT = 'LANDED_COST_ENCUMBERED';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.landed_cost_bill_encumbrance(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.landed_cost_bill_block_reason(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.landed_cost_assert_bill_unencumbered(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.landed_cost_bill_encumbrance(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.landed_cost_bill_block_reason(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.landed_cost_assert_bill_unencumbered(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public._landed_cost_guard_vendor_credit_note()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.bill_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM public.landed_cost_assert_bill_unencumbered(NEW.bill_id, 'vendor_credit_note');
    RETURN NEW;
  END IF;

  IF NEW.bill_id IS DISTINCT FROM OLD.bill_id
     OR (NEW.accounting_status = 'posted' AND OLD.accounting_status IS DISTINCT FROM 'posted') THEN
    PERFORM public.landed_cost_assert_bill_unencumbered(NEW.bill_id, 'vendor_credit_note');
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_landed_cost_guard_vendor_credit_note ON public.vendor_credit_notes;
CREATE TRIGGER trg_landed_cost_guard_vendor_credit_note
  BEFORE INSERT OR UPDATE OF bill_id, accounting_status ON public.vendor_credit_notes
  FOR EACH ROW EXECUTE FUNCTION public._landed_cost_guard_vendor_credit_note();

CREATE OR REPLACE FUNCTION public._landed_cost_annotate_reversal_intent(_intent jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_type   text := _intent->>'document_type';
  v_doc    uuid := NULLIF(_intent->>'document_id', '')::uuid;
  v_enc    jsonb;
  v_reason text;
  v_ops    jsonb := '[]'::jsonb;
  v_op     jsonb;
  v_blocked text[];
BEGIN
  IF v_doc IS NULL THEN
    RETURN _intent;
  END IF;

  IF v_type = 'goods_receipt' THEN
    v_enc     := public.landed_cost_receipt_encumbrance(v_doc);
    v_reason  := public.landed_cost_receipt_block_reason(v_doc);
    v_blocked := ARRAY['goods_return'];
  ELSIF v_type = 'bill' THEN
    v_enc     := public.landed_cost_bill_encumbrance(v_doc);
    v_reason  := public.landed_cost_bill_block_reason(v_doc);
    v_blocked := ARRAY['vendor_credit_note', 'void'];
  ELSE
    RETURN _intent;
  END IF;

  IF NOT COALESCE((v_enc->>'encumbered')::boolean, false) THEN
    RETURN _intent;
  END IF;

  FOR v_op IN SELECT * FROM jsonb_array_elements(COALESCE(_intent->'operations', '[]'::jsonb)) LOOP
    IF v_op->>'operation' = ANY (v_blocked) THEN
      v_op := v_op || jsonb_build_object('allowed', false, 'blocked_reason', v_reason);
    END IF;
    v_ops := v_ops || v_op;
  END LOOP;

  v_ops := v_ops || jsonb_build_array(jsonb_build_object(
    'operation', 'reverse_landed_cost',
    'allowed',   true,
    'label',     'Reverse the landed cost first',
    'description',
      'Unwinds landed cost ' || (v_enc->>'voucher_numbers') ||
      ' from the stock value and the ledger. Once that is done this document can be corrected.',
    'blocked_reason', NULL,
    'landed_cost', v_enc));

  RETURN _intent
      || jsonb_build_object(
           'operations',   v_ops,
           'recommended',  'reverse_landed_cost',
           'landed_cost',  v_enc,
           'blockers',     COALESCE(_intent->'blockers', '[]'::jsonb) || '["landed_cost_encumbered"]'::jsonb);
END;
$function$;

CREATE OR REPLACE FUNCTION public.resolve_reversal_intent(_document_type text, _document_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF _document_id IS NULL THEN
    RAISE EXCEPTION 'resolve_reversal_intent requires a document id' USING ERRCODE = '22023';
  END IF;

  IF _document_type = 'pos_transaction' THEN
    RETURN public.resolve_reversal_intent_pos(_document_id);
  ELSIF _document_type = 'payroll_run' THEN
    RETURN public.resolve_reversal_intent_payroll(_document_id);
  ELSIF _document_type = 'vendor_credit_note' THEN
    RETURN public.resolve_reversal_intent_vendor_credit_note(_document_id);
  ELSIF _document_type = 'expense' THEN
    RETURN public.resolve_reversal_intent_expense(_document_id);
  ELSIF _document_type = 'customer_refund' THEN
    RETURN public.resolve_reversal_intent_customer_refund(_document_id);
  ELSIF _document_type IN ('goods_receipt', 'bill') THEN
    RETURN public._landed_cost_annotate_reversal_intent(
             public.resolve_reversal_intent_finance(_document_type, _document_id));
  ELSE
    RETURN public.resolve_reversal_intent_finance(_document_type, _document_id);
  END IF;
END;
$function$;