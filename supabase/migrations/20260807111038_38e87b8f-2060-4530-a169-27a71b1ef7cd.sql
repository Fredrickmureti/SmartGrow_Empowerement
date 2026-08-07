-- ===========================================================================
-- Phase 3 — Purchases / AP / GRN join the reversal architecture
--
-- 1. Bills gain void metadata (status enum already carries 'void').
-- 2. bill_payment_is_bank_reconciled — AP mirror of payment_is_bank_reconciled.
-- 3. void_bill_atomic — the missing canonical writer named in
--    mem://features/business-reversal-architecture. Replaces the client-side
--    saga in useBills.voidBill / useTransactionReversal.voidBill.
-- 4. resolve_reversal_intent + preview_reversal_consequences gain 'bill',
--    'bill_payment' and 'goods_receipt' branches.
--
-- Posting monopoly (ADR 0123) is respected throughout: the only journal writer
-- called here is void_journal_entry_atomic.
-- ===========================================================================

ALTER TABLE public.bills
  ADD COLUMN IF NOT EXISTS voided_at  timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by  uuid,
  ADD COLUMN IF NOT EXISTS void_reason text;

COMMENT ON COLUMN public.bills.void_reason IS
  'Reason captured by void_bill_atomic. Bills are never deleted; a void is a status flip plus a reversal journal.';

-- ---------------------------------------------------------------------------
-- AP mirror of payment_is_bank_reconciled. A supplier payment matched to a
-- reconciled bank line may not be reversed silently: the reconciliation and
-- the ledger would disagree.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bill_payment_is_bank_reconciled(_bill_payment_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.bank_transactions bt
     WHERE COALESCE(bt.is_reconciled, false)
       AND bt.reconciled_type = 'bill_payment'
       AND bt.reconciled_entity_id = _bill_payment_id
  ) OR EXISTS (
    SELECT 1 FROM public.bank_reconciliation_matches m
     WHERE COALESCE(m.status, 'matched') NOT IN ('rejected', 'unmatched', 'cancelled')
       AND m.matched_entity_type = 'bill_payment'
       AND m.matched_entity_id = _bill_payment_id
  );
$function$;

-- ---------------------------------------------------------------------------
-- void_bill_atomic — one transaction, no deletes.
--
-- 1. Locks the bill; repeat calls return already_voided (idempotent).
-- 2. Refuses drafts (nothing posted), settled bills (live allocations) and
--    closed periods.
-- 3. Reverses EVERY live journal entry sourced from the bill through
--    void_journal_entry_atomic — never a raw journal write.
-- 4. Unwinds three-way-match state so the GRN is billable again.
-- 5. Stamps the void columns.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.void_bill_atomic(
  _bill_id uuid,
  _reason text,
  _void_date date DEFAULT NULL,
  _actor uuid DEFAULT NULL,
  _client_request_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_bill        public.bills%ROWTYPE;
  v_date        date := COALESCE(_void_date, CURRENT_DATE);
  v_live_pay    int := 0;
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

  IF NOT public.user_belongs_to_org(v_bill.organization_id) THEN
    RAISE EXCEPTION 'Not authorized for this document.' USING ERRCODE = '42501';
  END IF;

  -- idempotent
  IF v_bill.status::text = 'void' THEN
    RETURN jsonb_build_object(
      'result', 'already_voided',
      'bill_id', _bill_id,
      'bill_number', v_bill.bill_number);
  END IF;

  IF v_bill.status::text = 'draft' THEN
    RAISE EXCEPTION 'Bill % is still a draft — nothing was posted. Delete or edit the draft instead of voiding it.',
      COALESCE(v_bill.bill_number, _bill_id::text) USING ERRCODE = '23514';
  END IF;

  SELECT count(DISTINCT bp.id) INTO v_live_pay
    FROM public.bill_payment_allocations a
    JOIN public.bill_payments bp ON bp.id = a.bill_payment_id
   WHERE a.bill_id = _bill_id
     AND COALESCE(bp.status, 'completed') NOT IN ('voided', 'cancelled');

  IF v_live_pay > 0 THEN
    RAISE EXCEPTION
      'Bill % is settled by % supplier payment(s). Void the payment(s) first, or raise a vendor credit note.',
      COALESCE(v_bill.bill_number, _bill_id::text), v_live_pay
      USING ERRCODE = '23514';
  END IF;

  IF v_bill.business_id IS NOT NULL AND NOT public.is_period_open(v_bill.business_id, v_date) THEN
    RAISE EXCEPTION 'The accounting period covering % is closed. Raise a vendor credit note in an open period instead.', v_date
      USING ERRCODE = '23514';
  END IF;

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

  -- Legacy single-FK linkage, for bills posted before source_type/source_id
  -- stamping existed.
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

  -- --------------------------------------------- unwind three-way-match state
  -- The goods receipt must become billable again; the match result described a
  -- bill that no longer exists in the books.
  DELETE FROM public.bill_match_results WHERE bill_id = _bill_id;

  -- --------------------------------------------------------------- the flip
  UPDATE public.bills
     SET status      = 'void',
         amount_paid = 0,
         voided_at   = now(),
         voided_by   = _actor,
         void_reason = _reason,
         updated_at  = now()
   WHERE id = _bill_id;

  RETURN jsonb_build_object(
    'result', 'voided',
    'bill_id', _bill_id,
    'bill_number', v_bill.bill_number,
    'void_date', v_date,
    'reversal_journal_entry_ids', to_jsonb(v_reversals),
    'client_request_id', _client_request_id);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.void_bill_atomic(uuid, text, date, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bill_payment_is_bank_reconciled(uuid) TO authenticated;

-- ===========================================================================
-- resolve_reversal_intent — + bill, bill_payment, goods_receipt
-- Invoice and payment branches are unchanged from the Phase 1 definition.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.resolve_reversal_intent(_document_type text, _document_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_inv            public.invoices%ROWTYPE;
  v_pmt            public.payments%ROWTYPE;
  v_bill           public.bills%ROWTYPE;
  v_bp             public.bill_payments%ROWTYPE;
  v_grn            public.goods_receipts%ROWTYPE;
  v_org            uuid;
  v_biz            uuid;
  v_number         text;
  v_status         text;
  v_total          numeric := 0;
  v_paid           numeric := 0;
  v_live_count     int := 0;
  v_live_total     numeric := 0;
  v_reconciled     boolean := false;
  v_period_open    boolean := true;
  v_terminal       boolean := false;
  v_is_draft       boolean := false;
  v_posted         boolean := false;
  v_billed_count   int := 0;
  v_ops            jsonb := '[]'::jsonb;
  v_recommended    text;
  v_blockers       text[] := ARRAY[]::text[];
BEGIN
  IF _document_id IS NULL THEN
    RAISE EXCEPTION 'resolve_reversal_intent requires a document id' USING ERRCODE = '22023';
  END IF;

  -- ---------------------------------------------------------------- invoice
  IF _document_type = 'invoice' THEN
    SELECT * INTO v_inv FROM public.invoices WHERE id = _document_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invoice % not found.', _document_id USING ERRCODE = 'P0002';
    END IF;

    v_org    := v_inv.organization_id;
    v_biz    := v_inv.business_id;
    v_number := COALESCE(v_inv.invoice_number, _document_id::text);
    v_status := v_inv.status::text;
    v_total  := COALESCE(v_inv.total, 0);
    v_paid   := COALESCE(v_inv.amount_paid, 0);

    IF NOT public.user_belongs_to_org(v_org) THEN
      RAISE EXCEPTION 'Not authorized for this document.' USING ERRCODE = '42501';
    END IF;

    v_terminal := v_status IN ('voided', 'cancelled');
    v_is_draft := v_status = 'draft';
    v_posted   := NOT v_is_draft AND NOT v_terminal;

    SELECT count(DISTINCT p.id), COALESCE(SUM(a.amount), 0)
      INTO v_live_count, v_live_total
      FROM public.payment_allocations a
      JOIN public.payments p ON p.id = a.payment_id
     WHERE a.invoice_id = _document_id
       AND COALESCE(p.status, 'completed') NOT IN ('voided', 'cancelled');

    SELECT EXISTS (
      SELECT 1
        FROM public.payment_allocations a
        JOIN public.payments p ON p.id = a.payment_id
       WHERE a.invoice_id = _document_id
         AND COALESCE(p.status, 'completed') NOT IN ('voided', 'cancelled')
         AND public.payment_is_bank_reconciled(p.id)
    ) INTO v_reconciled;

  -- ---------------------------------------------------------------- payment
  ELSIF _document_type = 'payment' THEN
    SELECT * INTO v_pmt FROM public.payments WHERE id = _document_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Payment % not found.', _document_id USING ERRCODE = 'P0002';
    END IF;

    v_org    := v_pmt.organization_id;
    v_biz    := v_pmt.business_id;
    v_number := COALESCE(v_pmt.receipt_number, _document_id::text);
    v_status := COALESCE(v_pmt.status, 'completed');
    v_total  := COALESCE(v_pmt.amount, 0);

    IF NOT public.user_belongs_to_org(v_org) THEN
      RAISE EXCEPTION 'Not authorized for this document.' USING ERRCODE = '42501';
    END IF;

    v_terminal := v_status IN ('voided', 'cancelled');
    v_posted   := NOT v_terminal;

    SELECT count(*), COALESCE(SUM(amount), 0)
      INTO v_live_count, v_live_total
      FROM public.payment_allocations WHERE payment_id = _document_id;

    v_paid       := v_live_total;
    v_reconciled := public.payment_is_bank_reconciled(_document_id);

  -- ------------------------------------------------------------------- bill
  ELSIF _document_type = 'bill' THEN
    SELECT * INTO v_bill FROM public.bills WHERE id = _document_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Bill % not found.', _document_id USING ERRCODE = 'P0002';
    END IF;

    v_org    := v_bill.organization_id;
    v_biz    := v_bill.business_id;
    v_number := COALESCE(v_bill.bill_number, _document_id::text);
    v_status := v_bill.status::text;
    v_total  := COALESCE(v_bill.total, 0);
    v_paid   := COALESCE(v_bill.amount_paid, 0);

    IF NOT public.user_belongs_to_org(v_org) THEN
      RAISE EXCEPTION 'Not authorized for this document.' USING ERRCODE = '42501';
    END IF;

    v_terminal := v_status = 'void';
    v_is_draft := v_status = 'draft';
    v_posted   := NOT v_is_draft AND NOT v_terminal;

    -- settlement walked through the allocation ledger (ADR 0028)
    SELECT count(DISTINCT bp.id), COALESCE(SUM(a.amount), 0)
      INTO v_live_count, v_live_total
      FROM public.bill_payment_allocations a
      JOIN public.bill_payments bp ON bp.id = a.bill_payment_id
     WHERE a.bill_id = _document_id
       AND COALESCE(bp.status, 'completed') NOT IN ('voided', 'cancelled');

    SELECT EXISTS (
      SELECT 1
        FROM public.bill_payment_allocations a
        JOIN public.bill_payments bp ON bp.id = a.bill_payment_id
       WHERE a.bill_id = _document_id
         AND COALESCE(bp.status, 'completed') NOT IN ('voided', 'cancelled')
         AND public.bill_payment_is_bank_reconciled(bp.id)
    ) INTO v_reconciled;

  -- ----------------------------------------------------------- bill_payment
  ELSIF _document_type = 'bill_payment' THEN
    SELECT * INTO v_bp FROM public.bill_payments WHERE id = _document_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Supplier payment % not found.', _document_id USING ERRCODE = 'P0002';
    END IF;

    v_org    := v_bp.organization_id;
    v_biz    := v_bp.business_id;
    v_number := COALESCE(v_bp.reference, _document_id::text);
    v_status := COALESCE(v_bp.status, 'completed');
    v_total  := COALESCE(v_bp.amount, 0);

    IF NOT public.user_belongs_to_org(v_org) THEN
      RAISE EXCEPTION 'Not authorized for this document.' USING ERRCODE = '42501';
    END IF;

    v_terminal := v_status IN ('voided', 'cancelled');
    v_posted   := NOT v_terminal;

    SELECT count(*), COALESCE(SUM(amount), 0)
      INTO v_live_count, v_live_total
      FROM public.bill_payment_allocations WHERE bill_payment_id = _document_id;

    v_paid       := v_live_total;
    v_reconciled := public.bill_payment_is_bank_reconciled(_document_id);

  -- ---------------------------------------------------------- goods_receipt
  ELSIF _document_type = 'goods_receipt' THEN
    SELECT * INTO v_grn FROM public.goods_receipts WHERE id = _document_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Goods receipt % not found.', _document_id USING ERRCODE = 'P0002';
    END IF;

    v_org    := v_grn.organization_id;
    v_biz    := v_grn.business_id;
    v_number := COALESCE(v_grn.receipt_number, _document_id::text);
    v_status := COALESCE(v_grn.status, 'draft');

    IF NOT public.user_belongs_to_org(v_org) THEN
      RAISE EXCEPTION 'Not authorized for this document.' USING ERRCODE = '42501';
    END IF;

    v_terminal := v_status IN ('cancelled', 'voided', 'reversed');
    v_is_draft := v_status = 'draft';
    v_posted   := NOT v_is_draft AND NOT v_terminal;

    -- A receipt already turned into a supplier bill is not reversible on its
    -- own: the liability exists. That bill has to go first.
    SELECT count(*) INTO v_billed_count
      FROM public.bills b
     WHERE b.goods_receipt_id = _document_id
       AND b.status::text <> 'void';

    v_live_count := v_billed_count;
    v_total      := COALESCE((SELECT SUM(COALESCE(gi.quantity_received, 0))
                                FROM public.goods_receipt_items gi
                               WHERE gi.goods_receipt_id = _document_id), 0);

  ELSE
    RAISE EXCEPTION 'resolve_reversal_intent does not know document type %. Supported: invoice, payment, bill, bill_payment, goods_receipt.', _document_type
      USING ERRCODE = '22023';
  END IF;

  -- period state is evaluated for today, the date a reversal would post
  IF v_biz IS NOT NULL THEN
    v_period_open := public.is_period_open(v_biz, CURRENT_DATE);
  END IF;

  -- ------------------------------------------------------------- blockers
  IF v_terminal THEN
    v_blockers := v_blockers || 'already_reversed'::text;
  END IF;
  IF v_live_count > 0 THEN
    v_blockers := v_blockers ||
      CASE WHEN _document_type = 'goods_receipt' THEN 'billed'::text ELSE 'settled'::text END;
  END IF;
  IF v_reconciled THEN
    v_blockers := v_blockers || 'bank_reconciled'::text;
  END IF;
  IF NOT v_period_open THEN
    v_blockers := v_blockers || 'period_closed'::text;
  END IF;

  -- ------------------------------------------------------- operation matrix
  IF _document_type = 'invoice' THEN
    IF v_terminal THEN
      v_recommended := 'none';
      v_ops := jsonb_build_array(jsonb_build_object(
        'operation', 'none', 'allowed', false,
        'label', 'Nothing to reverse',
        'blocked_reason', 'This invoice is already ' || v_status || '.'));
    ELSE
      v_ops := jsonb_build_array(
        jsonb_build_object(
          'operation', 'void',
          'allowed', v_live_count = 0 AND NOT v_reconciled AND v_period_open,
          'label', CASE WHEN v_is_draft THEN 'Cancel draft invoice' ELSE 'Void invoice' END,
          'description', CASE
            WHEN v_is_draft THEN 'Cancels the draft. Nothing was posted, so nothing is reversed.'
            ELSE 'Cancels the invoice and reverses its postings. Only legal while it is unsettled and the period is open.' END,
          'blocked_reason', CASE
            WHEN v_live_count > 0 THEN
              v_live_count || ' customer payment(s) totalling ' || round(v_live_total, 2) ||
              ' settle this invoice. A settled invoice cannot be voided — issue a credit note, refund the customer, or reverse the payment first.'
            WHEN v_reconciled THEN
              'A payment on this invoice is matched to a reconciled bank statement. Un-reconcile the bank line first.'
            WHEN NOT v_period_open THEN
              'The current accounting period is closed. Post a credit note in an open period instead.'
            ELSE NULL END),
        jsonb_build_object(
          'operation', 'credit_note',
          'allowed', v_posted,
          'label', 'Issue a credit note',
          'description', 'Posts a corrective credit document against the invoice and leaves the original as history. The customer keeps the credit.',
          'blocked_reason', CASE WHEN v_is_draft
            THEN 'A draft invoice was never posted — cancel the draft instead of crediting it.' ELSE NULL END),
        jsonb_build_object(
          'operation', 'refund',
          'allowed', v_live_count > 0,
          'label', 'Refund the customer',
          'description', 'Returns money the customer already paid, through the guided refund flow.',
          'blocked_reason', CASE WHEN v_live_count = 0
            THEN 'Nothing has been paid on this invoice, so there is nothing to refund.' ELSE NULL END),
        jsonb_build_object(
          'operation', 'reverse_payment',
          'allowed', v_live_count > 0 AND NOT v_reconciled,
          'label', 'Reverse the payment first',
          'description', 'Unwinds the settling payment through the guided reversal wizard, after which the invoice can be voided.',
          'blocked_reason', CASE
            WHEN v_live_count = 0 THEN 'No live payment settles this invoice.'
            WHEN v_reconciled THEN 'The payment is matched to a reconciled bank statement. Un-reconcile the bank line first.'
            ELSE NULL END));

      v_recommended := CASE
        WHEN v_live_count = 0 AND NOT v_reconciled AND v_period_open THEN 'void'
        ELSE 'credit_note' END;
    END IF;

  ELSIF _document_type = 'payment' THEN
    IF v_terminal THEN
      v_recommended := 'none';
      v_ops := jsonb_build_array(jsonb_build_object(
        'operation', 'none', 'allowed', false,
        'label', 'Nothing to reverse',
        'blocked_reason', 'This payment is already ' || v_status || '.'));
    ELSE
      v_ops := jsonb_build_array(
        jsonb_build_object(
          'operation', 'void',
          'allowed', NOT v_reconciled AND v_period_open,
          'label', 'Void the payment',
          'description', 'Reverses the cash receipt and returns the settled invoices to outstanding.',
          'blocked_reason', CASE
            WHEN v_reconciled THEN 'This payment is matched to a reconciled bank statement. Un-reconcile the bank line first.'
            WHEN NOT v_period_open THEN 'The current accounting period is closed.'
            ELSE NULL END),
        jsonb_build_object(
          'operation', 'reverse_payment',
          'allowed', NOT v_reconciled AND v_period_open,
          'label', 'Re-apply to the right invoice',
          'description', 'Detaches the cash from the wrong invoice and parks it on customer deposits.',
          'blocked_reason', CASE
            WHEN v_reconciled THEN 'This payment is matched to a reconciled bank statement.'
            WHEN NOT v_period_open THEN 'The current accounting period is closed.'
            ELSE NULL END),
        jsonb_build_object(
          'operation', 'refund',
          'allowed', v_period_open,
          'label', 'Refund the customer',
          'description', 'Returns the money to the customer and keeps the receipt as history.',
          'blocked_reason', CASE WHEN NOT v_period_open
            THEN 'The current accounting period is closed.' ELSE NULL END),
        jsonb_build_object(
          'operation', 'customer_credit',
          'allowed', v_period_open,
          'label', 'Keep as customer credit',
          'description', 'Parks the cash as a customer deposit to apply to a future invoice.',
          'blocked_reason', CASE WHEN NOT v_period_open
            THEN 'The current accounting period is closed.' ELSE NULL END));

      v_recommended := CASE
        WHEN v_reconciled THEN 'refund'
        WHEN v_live_count = 0 THEN 'customer_credit'
        ELSE 'void' END;
    END IF;

  -- ------------------------------------------------------------------- bill
  ELSIF _document_type = 'bill' THEN
    IF v_terminal THEN
      v_recommended := 'none';
      v_ops := jsonb_build_array(jsonb_build_object(
        'operation', 'none', 'allowed', false,
        'label', 'Nothing to reverse',
        'blocked_reason', 'This bill is already void.'));
    ELSE
      v_ops := jsonb_build_array(
        jsonb_build_object(
          'operation', 'void',
          'allowed', NOT v_is_draft AND v_live_count = 0 AND NOT v_reconciled AND v_period_open,
          'label', 'Void bill',
          'description', 'Cancels the supplier bill and reverses its postings. Only legal while it is unpaid and the period is open.',
          'blocked_reason', CASE
            WHEN v_is_draft THEN 'This bill is still a draft — nothing was posted. Edit or delete the draft instead.'
            WHEN v_live_count > 0 THEN
              v_live_count || ' supplier payment(s) totalling ' || round(v_live_total, 2) ||
              ' settle this bill. Void the payment(s) first, or raise a vendor credit note.'
            WHEN v_reconciled THEN
              'A payment on this bill is matched to a reconciled bank statement. Un-reconcile the bank line first.'
            WHEN NOT v_period_open THEN
              'The current accounting period is closed. Raise a vendor credit note in an open period instead.'
            ELSE NULL END),
        jsonb_build_object(
          'operation', 'vendor_credit_note',
          'allowed', v_posted,
          'label', 'Raise a vendor credit note',
          'description', 'Posts a corrective credit against the supplier and leaves the bill as history. The correct move once the bill is paid or the period is closed.',
          'blocked_reason', CASE WHEN v_is_draft
            THEN 'A draft bill was never posted — edit the draft instead of crediting it.' ELSE NULL END),
        jsonb_build_object(
          'operation', 'reverse_payment',
          'allowed', v_live_count > 0 AND NOT v_reconciled AND v_period_open,
          'label', 'Void the supplier payment first',
          'description', 'Unwinds the settling supplier payment, after which the bill can be voided.',
          'blocked_reason', CASE
            WHEN v_live_count = 0 THEN 'No live supplier payment settles this bill.'
            WHEN v_reconciled THEN 'The payment is matched to a reconciled bank statement. Un-reconcile the bank line first.'
            WHEN NOT v_period_open THEN 'The current accounting period is closed.'
            ELSE NULL END));

      v_recommended := CASE
        WHEN NOT v_is_draft AND v_live_count = 0 AND NOT v_reconciled AND v_period_open THEN 'void'
        WHEN v_live_count > 0 AND NOT v_reconciled AND v_period_open THEN 'reverse_payment'
        ELSE 'vendor_credit_note' END;
    END IF;

  -- ----------------------------------------------------------- bill_payment
  ELSIF _document_type = 'bill_payment' THEN
    IF v_terminal THEN
      v_recommended := 'none';
      v_ops := jsonb_build_array(jsonb_build_object(
        'operation', 'none', 'allowed', false,
        'label', 'Nothing to reverse',
        'blocked_reason', 'This supplier payment is already ' || v_status || '.'));
    ELSE
      v_ops := jsonb_build_array(
        jsonb_build_object(
          'operation', 'void',
          'allowed', NOT v_reconciled AND v_period_open,
          'label', 'Void the supplier payment',
          'description', 'Reverses the cash payment and returns the settled bills to outstanding. The payment stays on record.',
          'blocked_reason', CASE
            WHEN v_reconciled THEN 'This payment is matched to a reconciled bank statement. Un-reconcile the bank line first.'
            WHEN NOT v_period_open THEN 'The current accounting period is closed.'
            ELSE NULL END),
        jsonb_build_object(
          'operation', 'vendor_credit_note',
          'allowed', v_posted,
          'label', 'Raise a vendor credit note instead',
          'description', 'Leaves the cash where it is and records a credit with the supplier. The correct move once the bank line is reconciled or the period is closed.',
          'blocked_reason', NULL));

      v_recommended := CASE
        WHEN NOT v_reconciled AND v_period_open THEN 'void'
        ELSE 'vendor_credit_note' END;
    END IF;

  -- ---------------------------------------------------------- goods_receipt
  ELSE
    IF v_terminal THEN
      v_recommended := 'none';
      v_ops := jsonb_build_array(jsonb_build_object(
        'operation', 'none', 'allowed', false,
        'label', 'Nothing to reverse',
        'blocked_reason', 'This goods receipt is already ' || v_status || '.'));
    ELSE
      v_ops := jsonb_build_array(
        jsonb_build_object(
          'operation', 'goods_return',
          'allowed', v_posted AND v_live_count = 0 AND v_period_open,
          'label', 'Return the goods to the supplier',
          'description', 'Takes the received quantities back out of stock and reverses the receipt posting.',
          'blocked_reason', CASE
            WHEN v_is_draft THEN 'This receipt has not been completed yet — edit it instead of returning goods.'
            WHEN v_live_count > 0 THEN
              v_live_count || ' supplier bill(s) already cover this receipt. Void or credit the bill first, otherwise the liability stays behind.'
            WHEN NOT v_period_open THEN 'The current accounting period is closed.'
            ELSE NULL END),
        jsonb_build_object(
          'operation', 'vendor_credit_note',
          'allowed', v_live_count > 0,
          'label', 'Raise a vendor credit note',
          'description', 'Corrects the supplier liability for goods that were billed but should not have been.',
          'blocked_reason', CASE WHEN v_live_count = 0
            THEN 'Nothing has been billed against this receipt yet, so there is no liability to credit.' ELSE NULL END));

      v_recommended := CASE
        WHEN v_posted AND v_live_count = 0 AND v_period_open THEN 'goods_return'
        ELSE 'vendor_credit_note' END;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'document_type',   _document_type,
    'document_id',     _document_id,
    'document_number', v_number,
    'status',          v_status,
    'organization_id', v_org,
    'business_id',     v_biz,
    'total',           v_total,
    'amount_settled',  v_paid,
    'state', jsonb_build_object(
      'already_reversed',    v_terminal,
      'is_draft',            v_is_draft,
      'is_posted',           v_posted,
      'is_settled',          v_live_count > 0,
      'live_payment_count',  v_live_count,
      'live_payment_total',  v_live_total,
      'is_bank_reconciled',  v_reconciled,
      'period_open',         v_period_open),
    'blockers',        to_jsonb(v_blockers),
    'recommended',     v_recommended,
    'operations',      v_ops);
END;
$function$;

-- ===========================================================================
-- preview_reversal_consequences — + bill, bill_payment, goods_receipt
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.preview_reversal_consequences(_document_type text, _document_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_intent      jsonb;
  v_org         uuid;
  v_biz         uuid;
  v_gl          jsonb := '[]'::jsonb;
  v_gl_total    numeric := 0;
  v_stock       jsonb := '[]'::jsonb;
  v_money       jsonb := '[]'::jsonb;
  v_docs        jsonb := '[]'::jsonb;
  v_warnings    jsonb := '[]'::jsonb;
  v_fiscalized  boolean := false;
  v_dn_count    int := 0;
  v_cn_count    int := 0;
  v_grn_count   int := 0;
  v_bill_count  int := 0;
  v_match       RECORD;
BEGIN
  v_intent := public.resolve_reversal_intent(_document_type, _document_id);
  v_org := NULLIF(v_intent->>'organization_id', '')::uuid;
  v_biz := NULLIF(v_intent->>'business_id', '')::uuid;

  -- ------------------------------------------------------------------ GL
  WITH jes AS (
    SELECT je.id,
           je.entry_number,
           je.entry_date,
           COALESCE(je.source_subtype, 'main') AS subtype,
           COALESCE(je.total_debit, 0)         AS total_debit,
           je.status::text                     AS status
      FROM public.journal_entries je
     WHERE je.organization_id = v_org
       AND je.status::text NOT IN ('voided', 'reversed')
       AND je.source_type = _document_type
       AND je.source_id   = _document_id
  ),
  lines AS (
    SELECT jel.journal_entry_id,
           jsonb_agg(jsonb_build_object(
             'account_id',     jel.account_id,
             'account_code',   a.code,
             'account_name',   a.name,
             'reverse_debit',  COALESCE(jel.credit, 0),
             'reverse_credit', COALESCE(jel.debit, 0)
           ) ORDER BY a.code) AS lines
      FROM public.journal_entry_lines jel
      LEFT JOIN public.accounts a ON a.id = jel.account_id
     WHERE jel.journal_entry_id IN (SELECT id FROM jes)
     GROUP BY jel.journal_entry_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'journal_entry_id', jes.id,
           'entry_number',     jes.entry_number,
           'entry_date',       jes.entry_date,
           'subtype',          jes.subtype,
           'total',            jes.total_debit,
           'status',           jes.status,
           'lines',            COALESCE(lines.lines, '[]'::jsonb)
         ) ORDER BY jes.subtype), '[]'::jsonb),
         COALESCE(SUM(jes.total_debit), 0)
    INTO v_gl, v_gl_total
    FROM jes LEFT JOIN lines ON lines.journal_entry_id = jes.id;

  -- --------------------------------------------------------------- invoice
  IF _document_type = 'invoice' THEN
    SELECT COALESCE(jsonb_agg(x ORDER BY x->>'product_name'), '[]'::jsonb)
      INTO v_stock
      FROM (
        SELECT jsonb_build_object(
                 'product_id',     sm.product_id,
                 'product_name',   p.name,
                 'product_sku',    p.sku,
                 'warehouse_id',   sm.warehouse_id,
                 'warehouse_name', w.name,
                 'quantity',       SUM(sm.quantity),
                 'unit_cost',      MAX(sm.unit_cost),
                 'direction',      'return_in'
               ) AS x
          FROM public.stock_movements sm
          JOIN public.products p ON p.id = sm.product_id
          LEFT JOIN public.warehouses w ON w.id = sm.warehouse_id
         WHERE sm.reference_type = 'invoice'
           AND sm.reference_id   = _document_id
           AND COALESCE(p.track_inventory, false) = true
         GROUP BY sm.product_id, p.name, p.sku, sm.warehouse_id, w.name
      ) s;

    IF EXISTS (
      SELECT 1 FROM public.stock_movements
       WHERE reference_type = 'invoice_void' AND reference_id = _document_id
    ) THEN
      v_stock := '[]'::jsonb;
      v_warnings := v_warnings || jsonb_build_object(
        'code', 'stock_already_restored',
        'severity', 'info',
        'message', 'Stock for this invoice was already returned to inventory. No further stock movement would be created.');
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'payment_id',       p.id,
             'receipt_number',   p.receipt_number,
             'payment_date',     p.payment_date,
             'payment_method',   p.payment_method,
             'allocated_amount', a.amount,
             'payment_amount',   p.amount,
             'bank_reconciled',  public.payment_is_bank_reconciled(p.id)
           ) ORDER BY p.payment_date), '[]'::jsonb)
      INTO v_money
      FROM public.payment_allocations a
      JOIN public.payments p ON p.id = a.payment_id
     WHERE a.invoice_id = _document_id
       AND COALESCE(p.status, 'completed') NOT IN ('voided', 'cancelled');

    SELECT count(*) INTO v_dn_count
      FROM public.delivery_notes dn
     WHERE (dn.source_invoice_id = _document_id OR dn.spawned_invoice_id = _document_id)
       AND COALESCE(dn.status::text, '') NOT IN ('cancelled', 'voided');

    SELECT count(*) INTO v_cn_count
      FROM public.credit_notes cn
     WHERE cn.invoice_id = _document_id
       AND COALESCE(cn.status::text, '') NOT IN ('cancelled', 'voided');

    SELECT EXISTS (
      SELECT 1 FROM public.fiscal_transmissions ft
       WHERE ft.source_doc_type = 'invoice'
         AND ft.source_doc_id = _document_id
         AND ft.state = 'succeeded'
    ) INTO v_fiscalized;

    v_docs := jsonb_build_array(
      jsonb_build_object('kind', 'delivery_note', 'label', 'Delivery notes', 'count', v_dn_count),
      jsonb_build_object('kind', 'credit_note',   'label', 'Credit notes',   'count', v_cn_count),
      jsonb_build_object('kind', 'fiscal_receipt','label', 'Fiscal receipt',
                         'count', CASE WHEN v_fiscalized THEN 1 ELSE 0 END)
    );

    IF v_fiscalized THEN
      v_warnings := v_warnings || jsonb_build_object(
        'code', 'fiscal_transmitted',
        'severity', 'warning',
        'message', 'This invoice was already accepted by the tax authority. Most jurisdictions require a credit note to cancel a fiscalised invoice — a local void does not withdraw the transmission.');
    END IF;

    IF v_dn_count > 0 THEN
      v_warnings := v_warnings || jsonb_build_object(
        'code', 'delivery_note_linked',
        'severity', 'warning',
        'message', v_dn_count || ' delivery note(s) are linked to this invoice. Goods dispatched on a delivery note come back through a sales return, not by voiding the invoice.');
    END IF;

    IF v_cn_count > 0 THEN
      v_warnings := v_warnings || jsonb_build_object(
        'code', 'credit_note_exists',
        'severity', 'warning',
        'message', v_cn_count || ' credit note(s) already correct this invoice. Reversing it again would compensate the customer twice.');
    END IF;

  -- --------------------------------------------------------------- payment
  ELSIF _document_type = 'payment' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'invoice_id',        i.id,
             'invoice_number',    i.invoice_number,
             'invoice_total',     i.total,
             'allocated_amount',  a.amount,
             'amount_paid_now',   i.amount_paid,
             'amount_paid_after', GREATEST(COALESCE(i.amount_paid, 0) - a.amount, 0),
             'status_now',        i.status::text
           ) ORDER BY i.invoice_number), '[]'::jsonb)
      INTO v_money
      FROM public.payment_allocations a
      JOIN public.invoices i ON i.id = a.invoice_id
     WHERE a.payment_id = _document_id;

    IF public.payment_is_bank_reconciled(_document_id) THEN
      v_warnings := v_warnings || jsonb_build_object(
        'code', 'bank_reconciled',
        'severity', 'error',
        'message', 'This payment is matched to a reconciled bank statement line. Un-reconcile the bank line before reversing, or the reconciliation and the ledger will disagree.');
    END IF;

  -- ------------------------------------------------------------------- bill
  ELSIF _document_type = 'bill' THEN
    -- Money: the supplier payments currently settling this bill.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'payment_id',       bp.id,
             'receipt_number',   bp.reference,
             'payment_date',     bp.payment_date,
             'payment_method',   bp.payment_method,
             'allocated_amount', a.amount,
             'payment_amount',   bp.amount,
             'bank_reconciled',  public.bill_payment_is_bank_reconciled(bp.id)
           ) ORDER BY bp.payment_date), '[]'::jsonb)
      INTO v_money
      FROM public.bill_payment_allocations a
      JOIN public.bill_payments bp ON bp.id = a.bill_payment_id
     WHERE a.bill_id = _document_id
       AND COALESCE(bp.status, 'completed') NOT IN ('voided', 'cancelled');

    SELECT count(*) INTO v_grn_count
      FROM public.goods_receipts g
      JOIN public.bills b ON b.goods_receipt_id = g.id
     WHERE b.id = _document_id;

    SELECT count(*) INTO v_cn_count
      FROM public.vendor_credit_notes vcn
     WHERE vcn.bill_id = _document_id
       AND COALESCE(vcn.status::text, '') NOT IN ('cancelled', 'voided');

    v_docs := jsonb_build_array(
      jsonb_build_object('kind', 'goods_receipt',      'label', 'Goods receipts',      'count', v_grn_count),
      jsonb_build_object('kind', 'vendor_credit_note', 'label', 'Vendor credit notes', 'count', v_cn_count)
    );

    SELECT match_state::text AS state, exception_state::text AS exception
      INTO v_match
      FROM public.bill_match_results
     WHERE bill_id = _document_id
     LIMIT 1;

    IF FOUND THEN
      v_warnings := v_warnings || jsonb_build_object(
        'code', 'three_way_match_unwound',
        'severity', 'info',
        'message', 'This bill is matched to its purchase order and goods receipt (' || COALESCE(v_match.state, 'matched') ||
                   '). Voiding it releases that match, so the receipt becomes billable again.');
    END IF;

    IF v_cn_count > 0 THEN
      v_warnings := v_warnings || jsonb_build_object(
        'code', 'vendor_credit_note_exists',
        'severity', 'warning',
        'message', v_cn_count || ' vendor credit note(s) already correct this bill. Voiding it as well would credit the supplier twice.');
    END IF;

  -- ----------------------------------------------------------- bill_payment
  ELSIF _document_type = 'bill_payment' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'invoice_id',        b.id,
             'invoice_number',    b.bill_number,
             'invoice_total',     b.total,
             'allocated_amount',  a.amount,
             'amount_paid_now',   b.amount_paid,
             'amount_paid_after', GREATEST(COALESCE(b.amount_paid, 0) - a.amount, 0),
             'status_now',        b.status::text
           ) ORDER BY b.bill_number), '[]'::jsonb)
      INTO v_money
      FROM public.bill_payment_allocations a
      JOIN public.bills b ON b.id = a.bill_id
     WHERE a.bill_payment_id = _document_id;

    IF public.bill_payment_is_bank_reconciled(_document_id) THEN
      v_warnings := v_warnings || jsonb_build_object(
        'code', 'bank_reconciled',
        'severity', 'error',
        'message', 'This supplier payment is matched to a reconciled bank statement line. Un-reconcile the bank line before reversing, or the reconciliation and the ledger will disagree.');
    END IF;

  -- ---------------------------------------------------------- goods_receipt
  ELSIF _document_type = 'goods_receipt' THEN
    -- Stock LEAVES again: the received quantities go back to the supplier.
    SELECT COALESCE(jsonb_agg(x ORDER BY x->>'product_name'), '[]'::jsonb)
      INTO v_stock
      FROM (
        SELECT jsonb_build_object(
                 'product_id',     gi.product_id,
                 'product_name',   p.name,
                 'product_sku',    p.sku,
                 'warehouse_id',   g.warehouse_id,
                 'warehouse_name', w.name,
                 'quantity',       SUM(COALESCE(gi.quantity_received, 0)),
                 'unit_cost',      MAX(gi.unit_cost_basis),
                 'direction',      'return_out'
               ) AS x
          FROM public.goods_receipt_items gi
          JOIN public.goods_receipts g ON g.id = gi.goods_receipt_id
          JOIN public.products p ON p.id = gi.product_id
          LEFT JOIN public.warehouses w ON w.id = g.warehouse_id
         WHERE gi.goods_receipt_id = _document_id
           AND COALESCE(gi.quantity_received, 0) > 0
           AND COALESCE(p.track_inventory, false) = true
         GROUP BY gi.product_id, p.name, p.sku, g.warehouse_id, w.name
      ) s;

    SELECT count(*) INTO v_bill_count
      FROM public.bills b
     WHERE b.goods_receipt_id = _document_id
       AND b.status::text <> 'void';

    v_docs := jsonb_build_array(
      jsonb_build_object('kind', 'bill', 'label', 'Supplier bills', 'count', v_bill_count)
    );

    IF v_bill_count > 0 THEN
      v_warnings := v_warnings || jsonb_build_object(
        'code', 'receipt_already_billed',
        'severity', 'error',
        'message', v_bill_count || ' supplier bill(s) already cover this receipt. Returning the goods without voiding or crediting the bill would leave the liability on the books.');
    END IF;
  END IF;

  IF jsonb_array_length(v_gl) = 0 AND COALESCE((v_intent->'state'->>'is_posted')::boolean, false) THEN
    v_warnings := v_warnings || jsonb_build_object(
      'code', 'no_gl_entry',
      'severity', 'warning',
      'message', 'No live accounting entry was found for this posted document. Reversing it changes the document only — check the ledger before continuing.');
  END IF;

  RETURN jsonb_build_object(
    'document_type',      _document_type,
    'document_id',        _document_id,
    'document_number',    v_intent->>'document_number',
    'organization_id',    v_org,
    'business_id',        v_biz,
    'intent',             v_intent,
    'gl',                 jsonb_build_object(
                            'entries', v_gl,
                            'entry_count', jsonb_array_length(v_gl),
                            'total_reversed', v_gl_total),
    'stock',              jsonb_build_object(
                            'lines', v_stock,
                            'line_count', jsonb_array_length(v_stock)),
    'money',              jsonb_build_object(
                            'lines', v_money,
                            'line_count', jsonb_array_length(v_money)),
    'related_documents',  v_docs,
    'warnings',           v_warnings
  );
END;
$function$;