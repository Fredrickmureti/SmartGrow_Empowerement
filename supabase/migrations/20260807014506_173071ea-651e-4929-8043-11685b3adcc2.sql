-- ============================================================================
-- Phase 1 fix — blocker accumulation
--
-- `v_blockers := v_blockers || 'settled'` resolves to anyarray || anyarray in
-- Postgres, so the untyped literal was parsed as an array literal and every
-- blocked document raised 22P02 "malformed array literal". Found by exercising
-- resolve_reversal_intent against a real settled invoice. Each append is now
-- explicitly ::text. Behaviour is otherwise byte-identical.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.resolve_reversal_intent(
  _document_type text,
  _document_id   uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv            public.invoices%ROWTYPE;
  v_pmt            public.payments%ROWTYPE;
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

    -- live settlement, walked through the allocation ledger (ADR 0027)
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

  ELSE
    RAISE EXCEPTION 'resolve_reversal_intent does not know document type %. Supported: invoice, payment.', _document_type
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
    v_blockers := v_blockers || 'settled'::text;
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

  ELSE -- payment
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
$$;

COMMENT ON FUNCTION public.resolve_reversal_intent(text, uuid) IS
  'Phase 1 reversal intent policy. Single authority on which reversal operation is legal for a document given its settlement, bank-reconciliation and period state. UI and sagas must consult it instead of re-deriving the rules.';

GRANT EXECUTE ON FUNCTION public.resolve_reversal_intent(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_reversal_intent(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_reversal_intent(text, uuid) TO supabase_read_only_user;