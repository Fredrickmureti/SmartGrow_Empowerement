
-- =========================================================================
-- ADR 0012 — P1c: refund_customer_atomic hardening
-- =========================================================================

-- 1. Idempotency column on customer_refunds (covers credit-note source) ----
ALTER TABLE public.customer_refunds
  ADD COLUMN IF NOT EXISTS client_request_id text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_refunds_idem
  ON public.customer_refunds(client_request_id)
  WHERE client_request_id IS NOT NULL;

-- 2. Rewritten refund_customer_atomic --------------------------------------
-- Fixes:
--   * Insert customer_refunds BEFORE posting JE so JE.source_id = refund.id
--     (preserves GL → source drill-down).
--   * Derive currency from businesses.base_currency (no KES hardcode).
--   * Idempotency now short-circuits on either payment_reversal_events
--     (payment source) OR customer_refunds.client_request_id (credit-note
--     source) — duplicate POSTs are safe for both branches.

CREATE OR REPLACE FUNCTION public.refund_customer_atomic(
  _source text,
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
  v_post_date date;
BEGIN
  IF _source NOT IN ('payment','credit_note') THEN RAISE EXCEPTION 'source must be payment or credit_note'; END IF;
  IF _source_id IS NULL THEN RAISE EXCEPTION 'source_id required'; END IF;
  IF _bank_account_id IS NULL THEN RAISE EXCEPTION 'bank_account_id required'; END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'amount must be positive'; END IF;

  v_post_date := COALESCE(_refund_date, CURRENT_DATE);

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
  ELSE
    SELECT * INTO v_credit FROM public.credit_notes WHERE id = _source_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'source credit_note % not found', _source_id; END IF;
    v_org_id := v_credit.organization_id; v_business_id := v_credit.business_id;
    v_contact_id := v_credit.contact_id;

    SELECT account_id INTO v_drain_account
    FROM public.default_account_settings
    WHERE business_id = v_business_id AND setting_key = 'accounts_receivable';
    IF v_drain_account IS NULL THEN RAISE EXCEPTION 'accounts_receivable default account not configured'; END IF;
  END IF;

  IF NOT public.is_period_open(v_business_id, v_post_date) THEN
    RAISE EXCEPTION 'accounting period is closed for %', v_post_date;
  END IF;

  -- Idempotency replay (both branches).
  IF _client_request_id IS NOT NULL THEN
    IF _source = 'payment' THEN
      SELECT id INTO v_event_id
      FROM public.payment_reversal_events
      WHERE payment_id = v_payment.id AND op = 'refund' AND client_request_id = _client_request_id;
      IF v_event_id IS NOT NULL THEN RETURN v_event_id; END IF;
    ELSE
      SELECT id INTO v_refund_id
      FROM public.customer_refunds
      WHERE client_request_id = _client_request_id;
      IF v_refund_id IS NOT NULL THEN RETURN v_refund_id; END IF;
    END IF;
  END IF;

  -- Derive currency from business; fall back to KES only as last resort.
  SELECT COALESCE(NULLIF(base_currency, ''), 'KES')
    INTO v_currency
  FROM public.businesses WHERE id = v_business_id;
  IF v_currency IS NULL THEN v_currency := 'KES'; END IF;

  -- Insert refund row FIRST so JE source_id resolves back to the refund.
  INSERT INTO public.customer_refunds (
    organization_id, business_id, contact_id,
    source_payment_id, source_credit_note_id,
    amount, currency, refund_date, bank_account_id,
    payment_method, reference, reason, status, created_by,
    client_request_id
  ) VALUES (
    v_org_id, v_business_id, v_contact_id,
    CASE WHEN _source='payment' THEN _source_id ELSE NULL END,
    CASE WHEN _source='credit_note' THEN _source_id ELSE NULL END,
    _amount, v_currency, v_post_date, _bank_account_id,
    _payment_method, _reference, _reason_text, 'posted', auth.uid(),
    _client_request_id
  ) RETURNING id INTO v_refund_id;

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
    _entry_date := v_post_date,
    _description := concat('Customer refund — ', COALESCE(_reason_text, _reason_code::text)),
    _source_type := 'customer_refund',
    _source_id := v_refund_id,
    _source_subtype := NULL,
    _entry_number := NULL,
    _reference_number := _reference,
    _business_id := v_business_id,
    _user_id := auth.uid(),
    _lines := v_lines,
    _auto_post := true,
    _idempotency_key := concat('refund:', _source, ':', _source_id, ':', COALESCE(_client_request_id, v_refund_id::text)),
    _metadata := jsonb_build_object('source', _source, 'source_id', _source_id, 'reason_code', _reason_code, 'refund_id', v_refund_id)
  )) INTO v_je_id;

  UPDATE public.customer_refunds SET journal_entry_id = v_je_id WHERE id = v_refund_id;

  -- Drain outstanding from source payment + log event.
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
