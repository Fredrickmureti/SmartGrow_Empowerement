-- =========================================================================
-- ADR 0012 — P1b: Payment reversal service layer (atomic RPCs)
-- =========================================================================

-- 1. record_payment_reversal_event -----------------------------------------
-- Sole writer of payment_reversal_events. Returns the event id; idempotent
-- on (payment_id, op, client_request_id) via the existing partial unique
-- index uq_payment_reversal_events_idem.
CREATE OR REPLACE FUNCTION public.record_payment_reversal_event(
  _payment_id uuid,
  _op text,
  _reason_code public.payment_reversal_reason,
  _reason_text text,
  _client_request_id text,
  _reversal_journal_entry_id uuid DEFAULT NULL,
  _credit_note_id uuid DEFAULT NULL,
  _customer_refund_id uuid DEFAULT NULL,
  _amount_before_outstanding numeric DEFAULT NULL,
  _amount_before_applied numeric DEFAULT NULL,
  _amount_after_outstanding numeric DEFAULT NULL,
  _amount_after_applied numeric DEFAULT NULL,
  _notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment public.payments%ROWTYPE;
  v_event_id uuid;
BEGIN
  IF _payment_id IS NULL THEN RAISE EXCEPTION 'payment_id is required'; END IF;
  IF _op IS NULL OR _op NOT IN ('void','unapply','refund','reapply','credit_note') THEN
    RAISE EXCEPTION 'invalid op: %', _op;
  END IF;

  SELECT * INTO v_payment FROM public.payments WHERE id = _payment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment % not found', _payment_id; END IF;

  -- Idempotency: replay returns the existing row.
  IF _client_request_id IS NOT NULL THEN
    SELECT id INTO v_event_id
    FROM public.payment_reversal_events
    WHERE payment_id = _payment_id AND op = _op AND client_request_id = _client_request_id;
    IF v_event_id IS NOT NULL THEN RETURN v_event_id; END IF;
  END IF;

  INSERT INTO public.payment_reversal_events (
    organization_id, business_id, payment_id, op,
    reason_code, reason_text,
    amount_before_outstanding, amount_before_applied,
    amount_after_outstanding, amount_after_applied,
    reversal_journal_entry_id, credit_note_id, customer_refund_id,
    performed_by, notes, client_request_id
  ) VALUES (
    v_payment.organization_id, v_payment.business_id, _payment_id, _op,
    _reason_code, _reason_text,
    _amount_before_outstanding, _amount_before_applied,
    _amount_after_outstanding, _amount_after_applied,
    _reversal_journal_entry_id, _credit_note_id, _customer_refund_id,
    auth.uid(), _notes, _client_request_id
  ) RETURNING id INTO v_event_id;

  RETURN v_event_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_payment_reversal_event(uuid,text,public.payment_reversal_reason,text,text,uuid,uuid,uuid,numeric,numeric,numeric,numeric,text) FROM public;
GRANT EXECUTE ON FUNCTION public.record_payment_reversal_event(uuid,text,public.payment_reversal_reason,text,text,uuid,uuid,uuid,numeric,numeric,numeric,numeric,text) TO authenticated;

-- 2. unapply_payment_atomic ------------------------------------------------
-- Releases applied cash on a payment back to the customer deposit balance.
-- Does NOT touch the original cash receipt JE — the money stays in the
-- bank/cash account. The AR settlement is what gets reversed, and the
-- payment's amount becomes outstanding (advance/unapplied cash).
--
-- Posts:  DR Customer Deposits  CR Accounts Receivable   for applied_amount
-- Flips:  applied_amount → 0, outstanding_amount → amount
-- Stamps: status='unreconciled', unreconcile fields, clears invoice_id.
-- Restores the invoice's amount_paid/status.
CREATE OR REPLACE FUNCTION public.unapply_payment_atomic(
  _payment_id uuid,
  _reason_code public.payment_reversal_reason,
  _reason_text text,
  _reversal_date date,
  _client_request_id text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment public.payments%ROWTYPE;
  v_invoice public.invoices%ROWTYPE;
  v_deposits_account uuid;
  v_ar_account uuid;
  v_je_id uuid;
  v_event_id uuid;
  v_new_amount_paid numeric;
  v_new_status text;
  v_lines jsonb;
  v_post_date date;
BEGIN
  IF _payment_id IS NULL THEN RAISE EXCEPTION 'payment_id is required'; END IF;
  IF _reason_code IS NULL THEN RAISE EXCEPTION 'reason_code is required'; END IF;

  -- Row lock to serialize concurrent reversals.
  SELECT * INTO v_payment FROM public.payments WHERE id = _payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment % not found', _payment_id; END IF;
  IF v_payment.status = 'voided' THEN RAISE EXCEPTION 'payment is already voided'; END IF;
  IF COALESCE(v_payment.applied_amount, 0) <= 0 THEN
    RAISE EXCEPTION 'payment has no applied amount to unapply';
  END IF;
  IF v_payment.invoice_id IS NULL THEN
    RAISE EXCEPTION 'payment is not attached to an invoice';
  END IF;

  v_post_date := COALESCE(_reversal_date, CURRENT_DATE);
  IF NOT public.is_period_open(v_payment.business_id, v_post_date) THEN
    RAISE EXCEPTION 'accounting period is closed for %', v_post_date;
  END IF;

  -- Idempotency short-circuit
  IF _client_request_id IS NOT NULL THEN
    SELECT id INTO v_event_id
    FROM public.payment_reversal_events
    WHERE payment_id = _payment_id AND op = 'unapply' AND client_request_id = _client_request_id;
    IF v_event_id IS NOT NULL THEN RETURN v_event_id; END IF;
  END IF;

  -- Resolve GL accounts (deposits + AR) from default_account_settings.
  SELECT account_id INTO v_deposits_account
  FROM public.default_account_settings
  WHERE business_id = v_payment.business_id AND setting_key = 'customer_deposits';
  IF v_deposits_account IS NULL THEN
    RAISE EXCEPTION 'customer_deposits default account not configured for this business';
  END IF;

  SELECT account_id INTO v_ar_account
  FROM public.default_account_settings
  WHERE business_id = v_payment.business_id AND setting_key = 'accounts_receivable';
  IF v_ar_account IS NULL THEN
    RAISE EXCEPTION 'accounts_receivable default account not configured for this business';
  END IF;

  SELECT * INTO v_invoice FROM public.invoices WHERE id = v_payment.invoice_id;

  -- Post: DR Customer Deposits / CR AR for applied_amount.
  v_lines := jsonb_build_array(
    jsonb_build_object(
      'account_id', v_deposits_account,
      'debit',  v_payment.applied_amount,
      'credit', 0,
      'description', concat('Unapply payment ', v_payment.receipt_number),
      'contact_id', v_payment.contact_id
    ),
    jsonb_build_object(
      'account_id', v_ar_account,
      'debit',  0,
      'credit', v_payment.applied_amount,
      'description', concat('Unapply payment ', v_payment.receipt_number),
      'contact_id', v_payment.contact_id
    )
  );

  SELECT (public.post_journal_entry_atomic(
    _organization_id := v_payment.organization_id,
    _entry_date := v_post_date,
    _description := concat('Unapply payment ', v_payment.receipt_number, ' — ', COALESCE(_reason_text, _reason_code::text)),
    _source_type := 'payment_unapply',
    _source_id := v_payment.id,
    _source_subtype := NULL,
    _entry_number := NULL,
    _reference_number := v_payment.receipt_number,
    _business_id := v_payment.business_id,
    _user_id := auth.uid(),
    _lines := v_lines,
    _auto_post := true,
    _idempotency_key := concat('unapply:', v_payment.id, ':', COALESCE(_client_request_id, gen_random_uuid()::text)),
    _metadata := jsonb_build_object('payment_id', v_payment.id, 'reason_code', _reason_code)
  )) INTO v_je_id;

  -- Flip the payment split + clear the invoice link + mark reason.
  UPDATE public.payments SET
    invoice_id = NULL,
    journal_entry_id = NULL,
    status = 'unreconciled',
    unreconciled_at = now(),
    unreconciled_by = auth.uid(),
    unreconcile_reason = COALESCE(_reason_text, _reason_code::text),
    reversal_reason = _reason_code,
    outstanding_amount = v_payment.amount,
    applied_amount = 0
  WHERE id = v_payment.id;

  -- Restore invoice's amount_paid and status.
  IF v_invoice.id IS NOT NULL THEN
    v_new_amount_paid := GREATEST(0, COALESCE(v_invoice.amount_paid, 0) - v_payment.applied_amount);
    v_new_status := CASE
      WHEN v_new_amount_paid <= 0 THEN 'sent'
      WHEN v_new_amount_paid < v_invoice.total THEN 'partial'
      ELSE 'paid'
    END;
    UPDATE public.invoices SET amount_paid = v_new_amount_paid, status = v_new_status::text
    WHERE id = v_invoice.id;
  END IF;

  -- Log event.
  v_event_id := public.record_payment_reversal_event(
    _payment_id := v_payment.id,
    _op := 'unapply',
    _reason_code := _reason_code,
    _reason_text := _reason_text,
    _client_request_id := _client_request_id,
    _reversal_journal_entry_id := v_je_id,
    _credit_note_id := NULL,
    _customer_refund_id := NULL,
    _amount_before_outstanding := v_payment.outstanding_amount,
    _amount_before_applied := v_payment.applied_amount,
    _amount_after_outstanding := v_payment.amount,
    _amount_after_applied := 0,
    _notes := NULL
  );

  RETURN v_event_id;
END;
$$;

REVOKE ALL ON FUNCTION public.unapply_payment_atomic(uuid,public.payment_reversal_reason,text,date,text) FROM public;
GRANT EXECUTE ON FUNCTION public.unapply_payment_atomic(uuid,public.payment_reversal_reason,text,date,text) TO authenticated;

-- 3. refund_customer_atomic ------------------------------------------------
-- Pays a customer back out of a bank account. Drains either the customer's
-- deposit balance (when the source is an unapplied payment) or AR (when the
-- source is an issued credit note). Inserts a customer_refunds row and
-- posts the cash-out JE atomically.
--
-- Posts:  DR Customer Deposits   CR Bank   for amount   (payment source)
--    OR:  DR Accounts Receivable CR Bank   for amount   (credit-note source)
CREATE OR REPLACE FUNCTION public.refund_customer_atomic(
  _source text,                   -- 'payment' or 'credit_note'
  _source_id uuid,
  _bank_account_id uuid,
  _amount numeric,
  _refund_date date,
  _reason_code public.payment_reversal_reason,
  _reason_text text,
  _payment_method text,
  _reference text,
  _client_request_id text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment public.payments%ROWTYPE;
  v_credit  public.credit_notes%ROWTYPE;
  v_org_id uuid; v_business_id uuid; v_contact_id uuid; v_currency text;
  v_drain_account uuid;
  v_je_id uuid;
  v_refund_id uuid;
  v_event_id uuid;
  v_lines jsonb;
BEGIN
  IF _source NOT IN ('payment','credit_note') THEN RAISE EXCEPTION 'source must be payment or credit_note'; END IF;
  IF _source_id IS NULL THEN RAISE EXCEPTION 'source_id required'; END IF;
  IF _bank_account_id IS NULL THEN RAISE EXCEPTION 'bank_account_id required'; END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'amount must be positive'; END IF;

  IF _source = 'payment' THEN
    SELECT * INTO v_payment FROM public.payments WHERE id = _source_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'source payment % not found', _source_id; END IF;
    IF COALESCE(v_payment.outstanding_amount, 0) < _amount THEN
      RAISE EXCEPTION 'refund exceeds outstanding amount on payment (% < %)', v_payment.outstanding_amount, _amount;
    END IF;
    v_org_id := v_payment.organization_id; v_business_id := v_payment.business_id;
    v_contact_id := v_payment.contact_id;

    SELECT account_id INTO v_drain_account
    FROM public.default_account_settings
    WHERE business_id = v_business_id AND setting_key = 'customer_deposits';
    IF v_drain_account IS NULL THEN RAISE EXCEPTION 'customer_deposits default account not configured'; END IF;

  ELSE -- credit_note
    SELECT * INTO v_credit FROM public.credit_notes WHERE id = _source_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'source credit_note % not found', _source_id; END IF;
    v_org_id := v_credit.organization_id; v_business_id := v_credit.business_id;
    v_contact_id := v_credit.contact_id;

    SELECT account_id INTO v_drain_account
    FROM public.default_account_settings
    WHERE business_id = v_business_id AND setting_key = 'accounts_receivable';
    IF v_drain_account IS NULL THEN RAISE EXCEPTION 'accounts_receivable default account not configured'; END IF;
  END IF;

  IF NOT public.is_period_open(v_business_id, COALESCE(_refund_date, CURRENT_DATE)) THEN
    RAISE EXCEPTION 'accounting period is closed for %', COALESCE(_refund_date, CURRENT_DATE);
  END IF;

  -- Idempotency on payment-source refunds via event log.
  IF _source = 'payment' AND _client_request_id IS NOT NULL THEN
    SELECT id INTO v_event_id
    FROM public.payment_reversal_events
    WHERE payment_id = v_payment.id AND op = 'refund' AND client_request_id = _client_request_id;
    IF v_event_id IS NOT NULL THEN RETURN v_event_id; END IF;
  END IF;

  v_currency := COALESCE(v_payment.id::text IS NOT NULL::text, 'KES');
  -- (fallback to KES; payments table has no currency col in this schema)
  v_currency := 'KES';

  v_lines := jsonb_build_array(
    jsonb_build_object(
      'account_id', v_drain_account, 'debit', _amount, 'credit', 0,
      'description', concat('Customer refund — ', _source),
      'contact_id', v_contact_id
    ),
    jsonb_build_object(
      'account_id', _bank_account_id, 'debit', 0, 'credit', _amount,
      'description', concat('Customer refund — ', _source),
      'contact_id', v_contact_id
    )
  );

  SELECT (public.post_journal_entry_atomic(
    _organization_id := v_org_id,
    _entry_date := COALESCE(_refund_date, CURRENT_DATE),
    _description := concat('Customer refund — ', COALESCE(_reason_text, _reason_code::text)),
    _source_type := 'customer_refund',
    _source_id := gen_random_uuid(),
    _source_subtype := NULL,
    _entry_number := NULL,
    _reference_number := _reference,
    _business_id := v_business_id,
    _user_id := auth.uid(),
    _lines := v_lines,
    _auto_post := true,
    _idempotency_key := concat('refund:', _source, ':', _source_id, ':', COALESCE(_client_request_id, gen_random_uuid()::text)),
    _metadata := jsonb_build_object('source', _source, 'source_id', _source_id, 'reason_code', _reason_code)
  )) INTO v_je_id;

  INSERT INTO public.customer_refunds (
    organization_id, business_id, contact_id,
    source_payment_id, source_credit_note_id,
    amount, currency, refund_date, bank_account_id,
    payment_method, reference, reason, status, journal_entry_id, created_by
  ) VALUES (
    v_org_id, v_business_id, v_contact_id,
    CASE WHEN _source='payment' THEN _source_id ELSE NULL END,
    CASE WHEN _source='credit_note' THEN _source_id ELSE NULL END,
    _amount, v_currency, COALESCE(_refund_date, CURRENT_DATE), _bank_account_id,
    _payment_method, _reference, _reason_text, 'posted', v_je_id, auth.uid()
  ) RETURNING id INTO v_refund_id;

  -- Drain outstanding from source payment if applicable.
  IF _source = 'payment' THEN
    UPDATE public.payments
       SET outstanding_amount = outstanding_amount - _amount,
           reversal_reason = COALESCE(reversal_reason, _reason_code)
     WHERE id = v_payment.id;

    v_event_id := public.record_payment_reversal_event(
      _payment_id := v_payment.id,
      _op := 'refund',
      _reason_code := _reason_code,
      _reason_text := _reason_text,
      _client_request_id := _client_request_id,
      _reversal_journal_entry_id := v_je_id,
      _credit_note_id := NULL,
      _customer_refund_id := v_refund_id,
      _amount_before_outstanding := v_payment.outstanding_amount,
      _amount_before_applied := v_payment.applied_amount,
      _amount_after_outstanding := v_payment.outstanding_amount - _amount,
      _amount_after_applied := v_payment.applied_amount,
      _notes := NULL
    );
    RETURN v_event_id;
  END IF;

  RETURN v_refund_id;
END;
$$;

REVOKE ALL ON FUNCTION public.refund_customer_atomic(text,uuid,uuid,numeric,date,public.payment_reversal_reason,text,text,text,text) FROM public;
GRANT EXECUTE ON FUNCTION public.refund_customer_atomic(text,uuid,uuid,numeric,date,public.payment_reversal_reason,text,text,text,text) TO authenticated;