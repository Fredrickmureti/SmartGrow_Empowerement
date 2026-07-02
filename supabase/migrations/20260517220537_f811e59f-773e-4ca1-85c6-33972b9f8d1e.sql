
-- 1. Extend payment_reversal_reason with two new intent codes
DO $$ BEGIN
  ALTER TYPE public.payment_reversal_reason ADD VALUE IF NOT EXISTS 'pre_refund_unapply';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE public.payment_reversal_reason ADD VALUE IF NOT EXISTS 'payment_currency_mismatch';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Widen the payment_reversal_events.op CHECK to allow new ops
ALTER TABLE public.payment_reversal_events DROP CONSTRAINT IF EXISTS payment_reversal_events_op_check;
ALTER TABLE public.payment_reversal_events
  ADD CONSTRAINT payment_reversal_events_op_check
  CHECK (op IN ('void','unapply','refund','credit_note','apply_deposit'));

-- 3. credit_notes.source_payment_id — distinguish payment-sourced CN documents
ALTER TABLE public.credit_notes
  ADD COLUMN IF NOT EXISTS source_payment_id uuid REFERENCES public.payments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_credit_notes_source_payment_id
  ON public.credit_notes(source_payment_id)
  WHERE source_payment_id IS NOT NULL;

-- 4. issue_credit_note_for_payment_atomic
CREATE OR REPLACE FUNCTION public.issue_credit_note_for_payment_atomic(
  _payment_id uuid,
  _reason_text text,
  _reversal_date date,
  _client_request_id text
)
RETURNS uuid
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
  v_cn_id uuid;
  v_cn_number text;
  v_currency text;
  v_post_date date;
  v_lines jsonb;
  v_new_amount_paid numeric;
  v_new_status text;
BEGIN
  IF _payment_id IS NULL THEN RAISE EXCEPTION 'payment_id is required'; END IF;

  SELECT * INTO v_payment FROM public.payments WHERE id = _payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment % not found', _payment_id; END IF;
  IF v_payment.status = 'voided' THEN RAISE EXCEPTION 'payment is already voided'; END IF;

  v_post_date := COALESCE(_reversal_date, CURRENT_DATE);
  IF NOT public.is_period_open(v_payment.business_id, v_post_date) THEN
    RAISE EXCEPTION 'accounting period is closed for %', v_post_date;
  END IF;

  -- Idempotency: if a credit_note event already exists for this request, return it.
  IF _client_request_id IS NOT NULL THEN
    SELECT id INTO v_event_id
    FROM public.payment_reversal_events
    WHERE payment_id = _payment_id
      AND op = 'credit_note'
      AND client_request_id = _client_request_id;
    IF v_event_id IS NOT NULL THEN RETURN v_event_id; END IF;
  END IF;

  -- Resolve currency
  SELECT base_currency INTO v_currency FROM public.businesses WHERE id = v_payment.business_id;
  v_currency := COALESCE(v_currency, 'USD');

  -- If currently applied to an invoice, do the unapply leg first (DR Deposits / CR AR).
  IF v_payment.invoice_id IS NOT NULL AND COALESCE(v_payment.applied_amount, 0) > 0 THEN
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

    v_lines := jsonb_build_array(
      jsonb_build_object('account_id', v_deposits_account, 'debit', v_payment.applied_amount, 'credit', 0,
        'description', concat('Convert payment ', v_payment.receipt_number, ' to credit note'),
        'contact_id', v_payment.contact_id),
      jsonb_build_object('account_id', v_ar_account, 'debit', 0, 'credit', v_payment.applied_amount,
        'description', concat('Convert payment ', v_payment.receipt_number, ' to credit note'),
        'contact_id', v_payment.contact_id)
    );

    SELECT (public.post_journal_entry_atomic(
      _organization_id := v_payment.organization_id,
      _entry_date := v_post_date,
      _description := concat('Credit note from payment ', v_payment.receipt_number, ' — ', COALESCE(_reason_text, '')),
      _source_type := 'payment_credit_note',
      _source_id := v_payment.id,
      _source_subtype := NULL,
      _entry_number := NULL,
      _reference_number := v_payment.receipt_number,
      _business_id := v_payment.business_id,
      _user_id := auth.uid(),
      _lines := v_lines,
      _auto_post := true,
      _idempotency_key := concat('credit_note_unapply:', v_payment.id, ':', COALESCE(_client_request_id, gen_random_uuid()::text)),
      _metadata := jsonb_build_object('payment_id', v_payment.id, 'reason_code', 'invoice_cancelled_keep_as_credit')
    )) INTO v_je_id;

    -- Detach payment; cash now sits as unapplied advance on Customer Deposits.
    UPDATE public.payments SET
      invoice_id = NULL,
      journal_entry_id = NULL,
      status = 'unreconciled',
      outstanding_amount = v_payment.amount,
      applied_amount = 0,
      unreconciled_at = now(),
      unreconciled_by = auth.uid(),
      unreconcile_reason = COALESCE(_reason_text, 'invoice_cancelled_keep_as_credit')
    WHERE id = v_payment.id;

    -- Restore invoice status
    IF v_invoice.id IS NOT NULL THEN
      v_new_amount_paid := GREATEST(0, COALESCE(v_invoice.amount_paid, 0) - v_payment.applied_amount);
      v_new_status := CASE
        WHEN v_new_amount_paid <= 0 THEN 'sent'
        WHEN v_new_amount_paid < v_invoice.total THEN 'partial'
        ELSE 'paid'
      END;
      UPDATE public.invoices
        SET amount_paid = v_new_amount_paid, status = v_new_status
        WHERE id = v_invoice.id;
    END IF;
  END IF;

  -- Allocate a credit-note number
  SELECT public.get_next_credit_note_number(v_payment.organization_id) INTO v_cn_number;
  IF v_cn_number IS NULL THEN
    v_cn_number := concat('CN-', extract(epoch from now())::bigint);
  END IF;

  -- Insert credit-note document. balance derives from total - amount_applied; status='issued'.
  INSERT INTO public.credit_notes (
    organization_id, business_id, contact_id,
    credit_note_number, status, issue_date,
    subtotal, tax_amount, total, amount_applied,
    currency, reason, source_payment_id, created_by
  ) VALUES (
    v_payment.organization_id, v_payment.business_id, v_payment.contact_id,
    v_cn_number, 'issued'::credit_note_status, v_post_date,
    v_payment.amount, 0, v_payment.amount, 0,
    v_currency, COALESCE(_reason_text, 'Payment converted to credit note'),
    v_payment.id, auth.uid()
  )
  RETURNING id INTO v_cn_id;

  -- Record the intent event (links payment, CN, and reversal JE if any).
  INSERT INTO public.payment_reversal_events (
    organization_id, business_id, payment_id,
    op, reason_code, reason_text,
    amount_before_outstanding, amount_before_applied,
    amount_after_outstanding, amount_after_applied,
    reversal_journal_entry_id, credit_note_id,
    performed_by, performed_at, client_request_id
  ) VALUES (
    v_payment.organization_id, v_payment.business_id, v_payment.id,
    'credit_note', 'invoice_cancelled_keep_as_credit'::payment_reversal_reason, _reason_text,
    COALESCE(v_payment.outstanding_amount, 0), COALESCE(v_payment.applied_amount, 0),
    v_payment.amount, 0,
    v_je_id, v_cn_id,
    auth.uid(), now(), _client_request_id
  )
  RETURNING id INTO v_event_id;

  RETURN v_event_id;
END;
$$;

-- 5. apply_customer_deposit_atomic
CREATE OR REPLACE FUNCTION public.apply_customer_deposit_atomic(
  _payment_id uuid,
  _invoice_id uuid,
  _amount numeric,
  _apply_date date,
  _client_request_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment public.payments%ROWTYPE;
  v_invoice public.invoices%ROWTYPE;
  v_deposits_account uuid;
  v_ar_account uuid;
  v_clamp numeric;
  v_je_id uuid;
  v_event_id uuid;
  v_post_date date;
  v_lines jsonb;
  v_new_amount_paid numeric;
  v_new_status text;
BEGIN
  IF _payment_id IS NULL THEN RAISE EXCEPTION 'payment_id is required'; END IF;
  IF _invoice_id IS NULL THEN RAISE EXCEPTION 'invoice_id is required'; END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'amount must be > 0'; END IF;

  SELECT * INTO v_payment FROM public.payments WHERE id = _payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment % not found', _payment_id; END IF;
  IF v_payment.status = 'voided' THEN RAISE EXCEPTION 'payment is voided'; END IF;
  IF COALESCE(v_payment.outstanding_amount, 0) <= 0 THEN
    RAISE EXCEPTION 'payment has no unapplied cash';
  END IF;

  SELECT * INTO v_invoice FROM public.invoices WHERE id = _invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invoice % not found', _invoice_id; END IF;
  IF v_invoice.status IN ('voided','cancelled') THEN
    RAISE EXCEPTION 'invoice is voided or cancelled';
  END IF;
  IF v_invoice.contact_id IS DISTINCT FROM v_payment.contact_id THEN
    RAISE EXCEPTION 'invoice belongs to a different customer';
  END IF;
  IF v_invoice.business_id IS DISTINCT FROM v_payment.business_id THEN
    RAISE EXCEPTION 'invoice is in a different business';
  END IF;

  v_post_date := COALESCE(_apply_date, CURRENT_DATE);
  IF NOT public.is_period_open(v_payment.business_id, v_post_date) THEN
    RAISE EXCEPTION 'accounting period is closed for %', v_post_date;
  END IF;

  -- Idempotency
  IF _client_request_id IS NOT NULL THEN
    SELECT id INTO v_event_id
    FROM public.payment_reversal_events
    WHERE payment_id = _payment_id
      AND op = 'apply_deposit'
      AND client_request_id = _client_request_id;
    IF v_event_id IS NOT NULL THEN RETURN v_event_id; END IF;
  END IF;

  -- Clamp amount to min(unapplied cash, invoice balance)
  v_clamp := LEAST(
    COALESCE(v_payment.outstanding_amount, 0),
    GREATEST(0, COALESCE(v_invoice.total, 0) - COALESCE(v_invoice.amount_paid, 0)),
    _amount
  );
  IF v_clamp <= 0 THEN RAISE EXCEPTION 'nothing to apply (clamp = 0)'; END IF;

  -- Resolve GL accounts
  SELECT account_id INTO v_deposits_account
    FROM public.default_account_settings
    WHERE business_id = v_payment.business_id AND setting_key = 'customer_deposits';
  IF v_deposits_account IS NULL THEN
    RAISE EXCEPTION 'customer_deposits default account not configured';
  END IF;
  SELECT account_id INTO v_ar_account
    FROM public.default_account_settings
    WHERE business_id = v_payment.business_id AND setting_key = 'accounts_receivable';
  IF v_ar_account IS NULL THEN
    RAISE EXCEPTION 'accounts_receivable default account not configured';
  END IF;

  -- DR AR / CR Customer Deposits — opposite of unapply.
  v_lines := jsonb_build_array(
    jsonb_build_object('account_id', v_ar_account, 'debit', v_clamp, 'credit', 0,
      'description', concat('Apply deposit from ', v_payment.receipt_number, ' to ', v_invoice.invoice_number),
      'contact_id', v_payment.contact_id),
    jsonb_build_object('account_id', v_deposits_account, 'debit', 0, 'credit', v_clamp,
      'description', concat('Apply deposit from ', v_payment.receipt_number, ' to ', v_invoice.invoice_number),
      'contact_id', v_payment.contact_id)
  );

  SELECT (public.post_journal_entry_atomic(
    _organization_id := v_payment.organization_id,
    _entry_date := v_post_date,
    _description := concat('Apply customer deposit ', v_payment.receipt_number, ' to invoice ', v_invoice.invoice_number),
    _source_type := 'deposit_application',
    _source_id := v_payment.id,
    _source_subtype := NULL,
    _entry_number := NULL,
    _reference_number := v_payment.receipt_number,
    _business_id := v_payment.business_id,
    _user_id := auth.uid(),
    _lines := v_lines,
    _auto_post := true,
    _idempotency_key := concat('apply_deposit:', v_payment.id, ':', _invoice_id, ':', COALESCE(_client_request_id, gen_random_uuid()::text)),
    _metadata := jsonb_build_object('payment_id', v_payment.id, 'invoice_id', _invoice_id, 'amount', v_clamp)
  )) INTO v_je_id;

  -- Update payment split
  UPDATE public.payments SET
    outstanding_amount = COALESCE(outstanding_amount, 0) - v_clamp,
    applied_amount = COALESCE(applied_amount, 0) + v_clamp
  WHERE id = v_payment.id;

  -- Update invoice paid + status
  v_new_amount_paid := COALESCE(v_invoice.amount_paid, 0) + v_clamp;
  v_new_status := CASE
    WHEN v_new_amount_paid >= v_invoice.total THEN 'paid'
    WHEN v_new_amount_paid > 0 THEN 'partial'
    ELSE v_invoice.status::text
  END;
  UPDATE public.invoices
    SET amount_paid = v_new_amount_paid, status = v_new_status
    WHERE id = _invoice_id;

  -- Record event
  INSERT INTO public.payment_reversal_events (
    organization_id, business_id, payment_id,
    op, reason_code, reason_text,
    amount_before_outstanding, amount_before_applied,
    amount_after_outstanding, amount_after_applied,
    reversal_journal_entry_id,
    performed_by, performed_at, client_request_id, notes
  ) VALUES (
    v_payment.organization_id, v_payment.business_id, v_payment.id,
    'apply_deposit', 'wrong_invoice_applied'::payment_reversal_reason,
    concat('Apply ', v_clamp, ' to invoice ', v_invoice.invoice_number),
    COALESCE(v_payment.outstanding_amount, 0), COALESCE(v_payment.applied_amount, 0),
    COALESCE(v_payment.outstanding_amount, 0) - v_clamp, COALESCE(v_payment.applied_amount, 0) + v_clamp,
    v_je_id,
    auth.uid(), now(), _client_request_id, jsonb_build_object('invoice_id', _invoice_id)::text
  )
  RETURNING id INTO v_event_id;

  RETURN v_event_id;
END;
$$;

-- 6. Idempotency support for credit-note ops
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_reversal_events_credit_note_request
  ON public.payment_reversal_events(payment_id, op, client_request_id)
  WHERE op = 'credit_note' AND client_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_reversal_events_apply_deposit_request
  ON public.payment_reversal_events(payment_id, op, client_request_id)
  WHERE op = 'apply_deposit' AND client_request_id IS NOT NULL;
