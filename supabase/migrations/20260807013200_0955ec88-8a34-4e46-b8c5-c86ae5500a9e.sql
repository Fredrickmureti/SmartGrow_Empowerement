-- ============================================================================
-- Phase 1 — Reversal intent policy
--
-- Policy decides WHICH reversal is legal before any UI offers a button.
-- Mature ERPs (SAP VF11, Oracle, NetSuite, D365, Odoo) all refuse to void a
-- settled / reconciled / period-closed sales document and force a corrective
-- document instead. None of them cascade-unwind a customer payment as a side
-- effect of voiding an invoice. This migration brings the platform in line.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Helper: is this payment tied to a reconciled bank statement line?
-- Un-reconciling is a bank-side operation (own engine, Phase 4). Until then
-- reversal must refuse rather than silently desynchronise the reconciliation.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payment_is_bank_reconciled(_payment_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.bank_transactions bt
     WHERE COALESCE(bt.is_reconciled, false)
       AND (bt.reconciled_payment_id = _payment_id
         OR (bt.reconciled_type = 'payment' AND bt.reconciled_entity_id = _payment_id))
  ) OR EXISTS (
    SELECT 1 FROM public.bank_reconciliation_matches m
     WHERE COALESCE(m.status, 'matched') NOT IN ('rejected', 'unmatched', 'cancelled')
       AND (m.matched_payment_id = _payment_id
         OR (m.matched_entity_type = 'payment' AND m.matched_entity_id = _payment_id))
  );
$$;

COMMENT ON FUNCTION public.payment_is_bank_reconciled(uuid) IS
  'True when the payment is matched to a reconciled bank statement line. Reversal engines must refuse rather than desynchronise the reconciliation.';

-- ---------------------------------------------------------------------------
-- resolve_reversal_intent(document_type, document_id)
--
-- The single policy authority. Returns the document''s reversal state, the
-- recommended legal operation, and every operation with allowed/blocked and a
-- plain-English reason. Callers (UI and sagas) must not re-derive this.
--
-- Operations vocabulary:
--   void            cancel the document and reverse its postings
--   credit_note     issue a corrective credit document (customer keeps credit)
--   refund          return money to the customer
--   customer_credit park the cash as a customer deposit / advance
--   reverse_payment unwind the settling payment first (guided wizard)
--   none            nothing legal to do
-- ---------------------------------------------------------------------------
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

  -- appends one operation descriptor
  PROCEDURE_placeholder boolean;
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

    IF NOT public.user_belongs_to_org(auth.uid(), v_org) THEN
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

    IF NOT public.user_belongs_to_org(auth.uid(), v_org) THEN
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
    v_blockers := v_blockers || 'already_reversed';
  END IF;
  IF v_live_count > 0 THEN
    v_blockers := v_blockers || 'settled';
  END IF;
  IF v_reconciled THEN
    v_blockers := v_blockers || 'bank_reconciled';
  END IF;
  IF NOT v_period_open THEN
    v_blockers := v_blockers || 'period_closed';
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
        WHEN v_live_count > 0 THEN 'credit_note'
        WHEN NOT v_period_open THEN 'credit_note'
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

GRANT EXECUTE ON FUNCTION public.payment_is_bank_reconciled(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_reversal_intent(text, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- void_invoice_atomic — enforce the policy at the writer.
--
-- Changes vs. the previous definition:
--   * A settled invoice is refused outright. `_cascade_payments` no longer
--     buys the caller the right to unwind a customer''s payment; passing true
--     is now an explicit error naming the legal alternatives. The parameter is
--     retained only so existing call sites fail loudly instead of silently
--     resolving to a different overload.
--   * A bank-reconciled settlement is refused.
--   * The closed-period guard is kept (ADR 0127) and its message now names the
--     corrective document.
-- Everything else — JE reversal (main + COGS legs), header flip, stock
-- restoration — is unchanged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.void_invoice_atomic(
  _invoice_id        uuid,
  _reason            text,
  _void_date         date    DEFAULT NULL,
  _actor             uuid    DEFAULT NULL,
  _cascade_payments  boolean DEFAULT false,
  _client_request_id text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv          public.invoices%ROWTYPE;
  v_date         date;
  v_label        text;
  v_main_rev     uuid;
  v_je           RECORD;
  v_rev          uuid;
  v_reversals    uuid[] := ARRAY[]::uuid[];
  v_live_count   int := 0;
  v_live_total   numeric := 0;
  v_reconciled   boolean := false;
BEGIN
  SELECT * INTO v_inv FROM public.invoices WHERE id = _invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice % not found.', _invoice_id USING ERRCODE = 'P0002';
  END IF;

  IF v_inv.status::text IN ('voided', 'cancelled') THEN
    RETURN jsonb_build_object('invoice_id', _invoice_id, 'already_voided', true);
  END IF;

  v_date := COALESCE(_void_date, CURRENT_DATE);

  -- Phase 1: cascading payment voids are retired as an operator-facing power.
  IF COALESCE(_cascade_payments, false) THEN
    RAISE EXCEPTION 'Cascading payment voids are no longer permitted. Voiding an invoice must not unwind a customer payment — issue a credit note, refund the customer, or reverse the payment through the guided wizard. See resolve_reversal_intent(''invoice'', %L).', _invoice_id
      USING ERRCODE = '0A000';
  END IF;

  IF v_inv.business_id IS NOT NULL
     AND NOT public.is_period_open(v_inv.business_id, v_date) THEN
    RAISE EXCEPTION 'Void date % falls in a closed fiscal period. Post a credit note in an open period instead.', v_date
      USING ERRCODE = '22023';
  END IF;

  -- Settlement guard (ADR-aligned with SAP/Oracle/NetSuite/D365/Odoo):
  -- a settled sales document is corrected, never voided.
  SELECT count(DISTINCT p.id), COALESCE(SUM(a.amount), 0)
    INTO v_live_count, v_live_total
    FROM public.payment_allocations a
    JOIN public.payments p ON p.id = a.payment_id
   WHERE a.invoice_id = _invoice_id
     AND COALESCE(p.status, 'completed') NOT IN ('voided', 'cancelled');

  IF v_live_count > 0 THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.payment_allocations a
        JOIN public.payments p ON p.id = a.payment_id
       WHERE a.invoice_id = _invoice_id
         AND COALESCE(p.status, 'completed') NOT IN ('voided', 'cancelled')
         AND public.payment_is_bank_reconciled(p.id)
    ) INTO v_reconciled;

    IF v_reconciled THEN
      RAISE EXCEPTION 'Invoice % is settled by a payment matched to a reconciled bank statement. Un-reconcile the bank line first, or issue a credit note / refund.',
        COALESCE(v_inv.invoice_number, _invoice_id::text) USING ERRCODE = '23514';
    END IF;

    RAISE EXCEPTION 'Invoice % is settled by % live payment(s) totalling %. A settled invoice cannot be voided — issue a credit note, refund the customer, or reverse the payment first.',
      COALESCE(v_inv.invoice_number, _invoice_id::text), v_live_count, round(v_live_total, 2)
      USING ERRCODE = '23514';
  END IF;

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

  RETURN jsonb_build_object(
    'invoice_id', _invoice_id,
    'reversal_journal_entry_ids', to_jsonb(v_reversals),
    'main_reversal_journal_entry_id', v_main_rev,
    'voided_payment_ids', '[]'::jsonb
  );
END;
$$;

COMMENT ON FUNCTION public.void_invoice_atomic(uuid, text, date, uuid, boolean, text) IS
  'Invoice reversal saga. Refuses settled, bank-reconciled and closed-period invoices (Phase 1 reversal intent policy); those resolve to credit note, refund or payment reversal. Never cascade-voids customer payments.';
