-- ============================================================================
-- Phase 5.1 — one reversal authorization / legality gate.
--
-- assert_can_reverse() is the single authority every canonical reversal writer
-- consults. It delegates legality to resolve_reversal_intent (which also
-- authorizes the caller against the owning organization) and owns the
-- effective-date fiscal-period check, which the intent function cannot know.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.assert_can_reverse(
  _document_type   text,
  _document_id     uuid,
  _operation       text,
  _actor           uuid DEFAULT NULL::uuid,
  _effective_date  date DEFAULT NULL::date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_intent   jsonb;
  v_op       jsonb;
  v_biz      uuid;
  v_date     date := COALESCE(_effective_date, CURRENT_DATE);
  v_number   text;
BEGIN
  IF _document_type IS NULL OR _document_id IS NULL OR _operation IS NULL THEN
    RAISE EXCEPTION 'assert_can_reverse requires a document type, id and operation'
      USING ERRCODE = '22023';
  END IF;

  -- Legality + caller authorization live in the intent authority. It raises
  -- 42501 when the caller does not belong to the document's organization and
  -- P0002 when the document does not exist.
  v_intent := public.resolve_reversal_intent(_document_type, _document_id);

  v_number := COALESCE(v_intent->>'document_number', _document_id::text);
  v_biz    := NULLIF(v_intent->>'business_id', '')::uuid;

  SELECT op INTO v_op
    FROM jsonb_array_elements(v_intent->'operations') AS op
   WHERE op->>'operation' = _operation
   LIMIT 1;

  IF v_op IS NULL THEN
    RAISE EXCEPTION
      'Operation % is not available for % %. Available: %.',
      _operation, _document_type, v_number,
      COALESCE((SELECT string_agg(o->>'operation', ', ')
                  FROM jsonb_array_elements(v_intent->'operations') AS o), 'none')
      USING ERRCODE = '0A000';
  END IF;

  IF NOT COALESCE((v_op->>'allowed')::boolean, false) THEN
    RAISE EXCEPTION '%',
      COALESCE(v_op->>'blocked_reason',
               'This ' || _document_type || ' cannot be reversed right now.')
      USING ERRCODE = '23514';
  END IF;

  -- The intent authority evaluates the period the document sits in; the writer
  -- may be posting the compensation into a different one.
  IF v_biz IS NOT NULL AND NOT public.is_period_open(v_biz, v_date) THEN
    RAISE EXCEPTION
      'The accounting period covering % is closed. Reverse % in an open period, or raise a credit note instead.',
      v_date, v_number
      USING ERRCODE = '23514';
  END IF;

  RETURN v_intent;
END;
$function$;

COMMENT ON FUNCTION public.assert_can_reverse(text, uuid, text, uuid, date) IS
  'ADR 0129 — single reversal authorization/legality gate. Every canonical reversal writer calls it after its idempotency short-circuit and performs no hand-rolled legality checks of its own.';

REVOKE ALL ON FUNCTION public.assert_can_reverse(text, uuid, text, uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_can_reverse(text, uuid, text, uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assert_can_reverse(text, uuid, text, uuid, date) TO service_role;

-- ============================================================================
-- Writers: delegate legality to the gate.
-- ============================================================================

-- ------------------------------------------------------------------ invoice
CREATE OR REPLACE FUNCTION public.void_invoice_atomic(_invoice_id uuid, _reason text, _void_date date DEFAULT NULL::date, _actor uuid DEFAULT NULL::uuid, _cascade_payments boolean DEFAULT false, _client_request_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inv          public.invoices%ROWTYPE;
  v_date         date;
  v_label        text;
  v_main_rev     uuid;
  v_je           RECORD;
  v_rev          uuid;
  v_reversals    uuid[] := ARRAY[]::uuid[];
  v_tasks_cancelled int := 0;
BEGIN
  SELECT * INTO v_inv FROM public.invoices WHERE id = _invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice % not found.', _invoice_id USING ERRCODE = 'P0002';
  END IF;

  IF v_inv.status::text IN ('voided', 'cancelled') THEN
    RETURN jsonb_build_object('invoice_id', _invoice_id, 'already_voided', true);
  END IF;

  v_date := COALESCE(_void_date, CURRENT_DATE);

  -- Cascading payment voids are retired as an operator-facing power.
  IF COALESCE(_cascade_payments, false) THEN
    RAISE EXCEPTION 'Cascading payment voids are no longer permitted. Voiding an invoice must not unwind a customer payment — issue a credit note, refund the customer, or reverse the payment through the guided wizard.'
      USING ERRCODE = '0A000';
  END IF;

  -- Authorization, settlement, bank-reconciliation and fiscal-period legality:
  -- ADR 0129 gate. No hand-rolled duplicates below this line.
  PERFORM public.assert_can_reverse('invoice', _invoice_id, 'void', _actor, v_date);

  v_label := 'Void invoice ' || COALESCE(v_inv.invoice_number, _invoice_id::text)
             || ': ' || COALESCE(_reason, 'no reason given');

  FOR v_je IN
    SELECT je.id, COALESCE(je.source_subtype, 'main') AS subtype
      FROM public.journal_entries je
     WHERE je.status NOT IN ('voided', 'reversed')
       AND (
         (je.source_type = 'invoice' AND je.source_id = _invoice_id)
         OR je.id = v_inv.journal_entry_id
       )
  LOOP
    v_rev := public.void_journal_entry_atomic(v_je.id, v_label, _actor, NULL, v_date);
    IF v_rev IS NOT NULL THEN
      v_reversals := v_reversals || v_rev;
      IF v_je.subtype IN ('main', '') THEN
        v_main_rev := v_rev;
      END IF;
    END IF;
  END LOOP;

  UPDATE public.invoices
     SET status                      = 'voided'::invoice_status,
         voided_at                   = now(),
         voided_by                   = _actor,
         void_reason                 = _reason,
         journal_entry_id            = NULL,
         reversal_journal_entry_id   = v_main_rev,
         updated_at                  = now()
   WHERE id = _invoice_id;

  PERFORM public.restore_invoice_stock_atomic(_invoice_id, _actor, _reason);

  v_tasks_cancelled := public.wms_cancel_tasks_for_document(
    'invoice', _invoice_id,
    'Invoice voided: ' || COALESCE(_reason, 'no reason given'), _actor);

  RETURN jsonb_build_object(
    'invoice_id', _invoice_id,
    'reversal_journal_entry_ids', to_jsonb(v_reversals),
    'main_reversal_journal_entry_id', v_main_rev,
    'voided_payment_ids', '[]'::jsonb,
    'cancelled_warehouse_task_count', v_tasks_cancelled
  );
END;
$function$;

-- ------------------------------------------------------------------ payment
CREATE OR REPLACE FUNCTION public.void_payment_atomic(_payment_id uuid, _reason text, _reason_code text DEFAULT NULL::text, _void_date date DEFAULT NULL::date, _actor uuid DEFAULT NULL::uuid, _client_request_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_payment      public.payments%ROWTYPE;
  v_touched      uuid[] := ARRAY[]::uuid[];
  v_invoice_id   uuid;
  v_inv          RECORD;
  v_new_paid     numeric;
  v_reversal_je  uuid;
  v_orphan_je    uuid;
  v_event_id     uuid;
BEGIN
  SELECT * INTO v_payment FROM public.payments WHERE id = _payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment % not found.', _payment_id USING ERRCODE = 'P0002';
  END IF;

  IF COALESCE(v_payment.status, 'completed') = 'voided' THEN
    RETURN jsonb_build_object('payment_id', _payment_id, 'already_voided', true);
  END IF;

  PERFORM public.assert_can_reverse(
    'payment', _payment_id, 'void', _actor,
    COALESCE(_void_date, v_payment.payment_date, CURRENT_DATE));

  SELECT COALESCE(array_agg(DISTINCT a.invoice_id), ARRAY[]::uuid[])
    INTO v_touched
    FROM public.payment_allocations a
   WHERE a.payment_id = _payment_id;

  IF v_payment.journal_entry_id IS NOT NULL THEN
    v_reversal_je := public.void_journal_entry_atomic(
      v_payment.journal_entry_id,
      'Void payment ' || COALESCE(v_payment.receipt_number, _payment_id::text)
        || ': ' || COALESCE(_reason, 'no reason given'),
      _actor, NULL, _void_date);
  ELSE
    SELECT je.id INTO v_orphan_je
      FROM public.journal_entries je
     WHERE je.source_type = 'payment'
       AND je.source_id = _payment_id
       AND je.status NOT IN ('voided','reversed')
     LIMIT 1;
    IF v_orphan_je IS NOT NULL THEN
      v_reversal_je := public.void_journal_entry_atomic(
        v_orphan_je,
        'Void payment ' || COALESCE(v_payment.receipt_number, _payment_id::text)
          || ': ' || COALESCE(_reason, 'no reason given'),
        _actor, NULL, _void_date);
    END IF;
  END IF;

  UPDATE public.payments
     SET status      = 'voided',
         voided_at   = now(),
         voided_by   = _actor,
         void_reason = _reason,
         updated_at  = now()
   WHERE id = _payment_id;

  FOREACH v_invoice_id IN ARRAY v_touched LOOP
    SELECT i.id, i.total, i.status::text AS status INTO v_inv
      FROM public.invoices i WHERE i.id = v_invoice_id FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;

    SELECT COALESCE(SUM(amount), 0) INTO v_new_paid
      FROM public.payment_allocations
     WHERE invoice_id = v_invoice_id
       AND payment_id IN (
         SELECT id FROM public.payments
          WHERE COALESCE(status, 'completed') NOT IN ('voided','cancelled')
       );

    IF v_inv.status IN ('voided','cancelled') THEN
      UPDATE public.invoices
         SET amount_paid = v_new_paid, updated_at = now()
       WHERE id = v_invoice_id;
    ELSE
      UPDATE public.invoices
         SET amount_paid = v_new_paid,
             status = CASE
                        WHEN v_new_paid >= v_inv.total - 0.005 THEN 'paid'::invoice_status
                        WHEN v_new_paid > 0.005 THEN 'partial'::invoice_status
                        ELSE 'sent'::invoice_status
                      END,
             updated_at = now()
       WHERE id = v_invoice_id;
    END IF;
  END LOOP;

  INSERT INTO public.payment_reversal_events
    (organization_id, business_id, payment_id, op, reason_code, reason_text,
     amount_before_outstanding, amount_before_applied,
     amount_after_outstanding,  amount_after_applied,
     reversal_journal_entry_id, performed_by, performed_at, client_request_id)
  VALUES
    (v_payment.organization_id, v_payment.business_id, _payment_id,
     'void', _reason_code::payment_reversal_reason, _reason,
     COALESCE(v_payment.outstanding_amount, 0), COALESCE(v_payment.applied_amount, 0),
     0, 0, v_reversal_je, _actor, now(), _client_request_id)
  RETURNING id INTO v_event_id;

  RETURN jsonb_build_object(
    'payment_id', _payment_id,
    'event_id', v_event_id,
    'reversal_journal_entry_id', v_reversal_je,
    'touched_invoices', to_jsonb(v_touched)
  );
END;
$function$;

-- --------------------------------------------------------------------- bill
CREATE OR REPLACE FUNCTION public.void_bill_atomic(_bill_id uuid, _reason text, _void_date date DEFAULT NULL::date, _actor uuid DEFAULT NULL::uuid, _client_request_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_bill        public.bills%ROWTYPE;
  v_date        date := COALESCE(_void_date, CURRENT_DATE);
  v_je          RECORD;
  v_rev         uuid;
  v_reversals   uuid[] := ARRAY[]::uuid[];
BEGIN
  IF _bill_id IS NULL THEN
    RAISE EXCEPTION 'void_bill_atomic requires a bill id' USING ERRCODE = '22023';
  END IF;
  IF _reason IS NULL OR btrim(_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required to void a bill.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_bill FROM public.bills WHERE id = _bill_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bill % not found.', _bill_id USING ERRCODE = 'P0002';
  END IF;

  -- idempotent
  IF v_bill.status::text = 'void' THEN
    RETURN jsonb_build_object(
      'result', 'already_voided',
      'bill_id', _bill_id,
      'bill_number', v_bill.bill_number);
  END IF;

  PERFORM public.assert_can_reverse('bill', _bill_id, 'void', _actor, v_date);

  -- ------------------------------------------------- reverse every live JE
  FOR v_je IN
    SELECT je.id, je.entry_number
      FROM public.journal_entries je
     WHERE je.organization_id = v_bill.organization_id
       AND je.source_type = 'bill'
       AND je.source_id = _bill_id
       AND je.status::text NOT IN ('voided', 'reversed')
  LOOP
    v_rev := public.void_journal_entry_atomic(
      v_je.id,
      'Void bill ' || COALESCE(v_bill.bill_number, _bill_id::text) || ': ' || _reason,
      _actor,
      NULL,
      v_date);
    IF v_rev IS NOT NULL THEN
      v_reversals := v_reversals || v_rev;
    END IF;
  END LOOP;

  IF array_length(v_reversals, 1) IS NULL AND v_bill.journal_entry_id IS NOT NULL THEN
    SELECT je.id INTO v_je
      FROM public.journal_entries je
     WHERE je.id = v_bill.journal_entry_id
       AND je.status::text NOT IN ('voided', 'reversed');
    IF FOUND THEN
      v_rev := public.void_journal_entry_atomic(
        v_bill.journal_entry_id,
        'Void bill ' || COALESCE(v_bill.bill_number, _bill_id::text) || ': ' || _reason,
        _actor,
        NULL,
        v_date);
      IF v_rev IS NOT NULL THEN
        v_reversals := v_reversals || v_rev;
      END IF;
    END IF;
  END IF;

  DELETE FROM public.bill_match_results WHERE bill_id = _bill_id;

  UPDATE public.bills
     SET status      = 'void',
         amount_paid = 0,
         voided_at   = now(),
         voided_by   = _actor,
         void_reason = _reason,
         updated_at  = now()
   WHERE id = _bill_id;

  PERFORM public.po_resync_billed_state_for_bill(_bill_id);

  RETURN jsonb_build_object(
    'result', 'voided',
    'bill_id', _bill_id,
    'bill_number', v_bill.bill_number,
    'void_date', v_date,
    'reversal_journal_entry_ids', to_jsonb(v_reversals),
    'purchase_order_billing_restored', true,
    'client_request_id', _client_request_id);
END;
$function$;

-- ------------------------------------------------------------- bill payment
CREATE OR REPLACE FUNCTION public.void_bill_payment_atomic(_bill_payment_id uuid, _reason text, _void_date date DEFAULT NULL::date, _actor uuid DEFAULT NULL::uuid, _client_request_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_bp         public.bill_payments%ROWTYPE;
  v_touched    uuid[] := ARRAY[]::uuid[];
  v_reversals  uuid[] := ARRAY[]::uuid[];
  v_bill_id    uuid;
  v_bill       RECORD;
  v_new_paid   numeric;
  v_je         RECORD;
  v_rev        uuid;
  v_event_id   uuid;
  v_label      text;
BEGIN
  SELECT * INTO v_bp FROM public.bill_payments WHERE id = _bill_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bill payment % not found.', _bill_payment_id USING ERRCODE = 'P0002';
  END IF;

  IF COALESCE(v_bp.status, 'completed') = 'voided' THEN
    RETURN jsonb_build_object('bill_payment_id', _bill_payment_id, 'already_voided', true);
  END IF;

  PERFORM public.assert_can_reverse(
    'bill_payment', _bill_payment_id, 'void', _actor,
    COALESCE(_void_date, v_bp.payment_date, CURRENT_DATE));

  SELECT COALESCE(array_agg(DISTINCT a.bill_id), ARRAY[]::uuid[])
    INTO v_touched
    FROM public.bill_payment_allocations a
   WHERE a.bill_payment_id = _bill_payment_id;

  v_label := 'Void bill payment ' || COALESCE(v_bp.reference, _bill_payment_id::text)
             || ': ' || COALESCE(_reason, 'no reason given');

  FOR v_je IN
    SELECT je.id
      FROM public.journal_entries je
     WHERE je.status NOT IN ('voided', 'reversed')
       AND (
         (je.source_type = 'bill_payment' AND je.source_id = _bill_payment_id)
         OR je.id = v_bp.journal_entry_id
       )
  LOOP
    v_rev := public.void_journal_entry_atomic(v_je.id, v_label, _actor, NULL, _void_date);
    IF v_rev IS NOT NULL THEN
      v_reversals := v_reversals || v_rev;
    END IF;
  END LOOP;

  UPDATE public.bill_payments
     SET status      = 'voided',
         voided_at   = now(),
         voided_by   = _actor,
         void_reason = _reason,
         updated_at  = now()
   WHERE id = _bill_payment_id;

  FOREACH v_bill_id IN ARRAY v_touched LOOP
    SELECT b.id, b.total, b.status::text AS status INTO v_bill
      FROM public.bills b WHERE b.id = v_bill_id FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;

    SELECT COALESCE(SUM(a.amount), 0) INTO v_new_paid
      FROM public.bill_payment_allocations a
      JOIN public.bill_payments bp ON bp.id = a.bill_payment_id
     WHERE a.bill_id = v_bill_id
       AND COALESCE(bp.status, 'completed') <> 'voided';

    IF v_bill.status IN ('void', 'draft') THEN
      UPDATE public.bills
         SET amount_paid = v_new_paid, updated_at = now()
       WHERE id = v_bill_id;
    ELSE
      UPDATE public.bills
         SET amount_paid = v_new_paid,
             status = CASE
                        WHEN v_new_paid >= v_bill.total - 0.005 THEN 'paid'::bill_status
                        WHEN v_new_paid > 0.005 THEN 'partial'::bill_status
                        ELSE 'received'::bill_status
                      END,
             updated_at = now()
       WHERE id = v_bill_id;
    END IF;
  END LOOP;

  INSERT INTO public.bill_payment_reversal_events
    (organization_id, business_id, bill_payment_id, op, reason_text, amount,
     reversal_journal_entry_ids, touched_bills, performed_by, client_request_id)
  VALUES
    (v_bp.organization_id, v_bp.business_id, _bill_payment_id, 'void', _reason,
     v_bp.amount, v_reversals, v_touched, _actor, _client_request_id)
  RETURNING id INTO v_event_id;

  RETURN jsonb_build_object(
    'bill_payment_id', _bill_payment_id,
    'event_id', v_event_id,
    'reversal_journal_entry_ids', to_jsonb(v_reversals),
    'touched_bills', to_jsonb(v_touched)
  );
END;
$function$;

-- ------------------------------------------------------------ goods receipt
CREATE OR REPLACE FUNCTION public.void_goods_receipt_atomic(_gr_id uuid, _reason text, _void_date date DEFAULT NULL::date, _actor uuid DEFAULT NULL::uuid, _client_request_id text DEFAULT NULL::text)
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

  -- idempotent
  IF COALESCE(v_grn.status, 'draft') IN ('reversed', 'cancelled', 'voided') THEN
    RETURN jsonb_build_object(
      'result', 'already_reversed',
      'goods_receipt_id', _gr_id,
      'receipt_number', v_grn.receipt_number);
  END IF;

  PERFORM public.assert_can_reverse('goods_receipt', _gr_id, 'goods_return', v_actor, v_date);

  -- ------------------------------------------------- reverse every live JE
  FOR v_je IN
    SELECT je.id
      FROM public.journal_entries je
     WHERE je.organization_id = v_grn.organization_id
       AND ((je.source_type = 'goods_receipt' AND je.source_id = _gr_id)
         OR (je.reference_type = 'goods_receipt' AND je.reference_id = _gr_id))
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

  -- --------------------------------------------------------- warehouse legs
  v_stock := public.wms_reverse_gr_stock(_gr_id, v_actor, _reason);
  IF NOT COALESCE((v_stock->>'success')::boolean, false) THEN
    RAISE EXCEPTION 'wms_reverse_gr_stock failed: %', v_stock->>'error';
  END IF;

  v_tasks := public.wms_cancel_tasks_for_document('goods_receipt', _gr_id, _reason, v_actor);

  DELETE FROM public.bill_grn_matches WHERE goods_receipt_id = _gr_id;

  UPDATE public.goods_receipts
     SET status     = 'reversed',
         notes      = COALESCE(notes || E'\n', '') || 'Reversed ' || v_date::text || ': ' || _reason,
         updated_at = now()
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
