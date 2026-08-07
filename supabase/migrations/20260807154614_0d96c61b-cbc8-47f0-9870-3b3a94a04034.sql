CREATE OR REPLACE FUNCTION public.issue_credit_note_for_payment_atomic(_payment_id uuid, _reason_text text, _reversal_date date, _client_request_id text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_payment public.payments%ROWTYPE;
  v_invoice public.invoices%ROWTYPE;
  v_deposits_account uuid;
  v_credit_account uuid;
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
  v_balance_id uuid;
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

  SELECT COALESCE(base_currency, 'USD') INTO v_currency
    FROM public.businesses WHERE id = v_payment.business_id;
  v_currency := COALESCE(v_currency, 'USD');

  SELECT account_id INTO v_deposits_account
    FROM public.default_account_settings
    WHERE business_id = v_payment.business_id AND setting_key = 'customer_deposits';
  IF v_deposits_account IS NULL THEN
    RAISE EXCEPTION 'customer_deposits default account not configured for this business';
  END IF;
  v_credit_account := public.customer_credit_account(v_payment.business_id);

  IF v_payment.invoice_id IS NOT NULL AND COALESCE(v_payment.applied_amount, 0) > 0 THEN
    -- Applied payment: release the receivable and park the cash as customer credit.
    SELECT account_id INTO v_ar_account
      FROM public.default_account_settings
      WHERE business_id = v_payment.business_id AND setting_key = 'accounts_receivable';
    IF v_ar_account IS NULL THEN
      RAISE EXCEPTION 'accounts_receivable default account not configured for this business';
    END IF;

    SELECT * INTO v_invoice FROM public.invoices WHERE id = v_payment.invoice_id;

    v_lines := jsonb_build_array(
      jsonb_build_object('account_id', v_credit_account, 'debit', 0, 'credit', v_payment.applied_amount,
        'description', concat('Convert payment ', v_payment.receipt_number, ' to credit note'),
        'contact_id', v_payment.contact_id),
      jsonb_build_object('account_id', v_ar_account, 'debit', v_payment.applied_amount, 'credit', 0,
        'description', concat('Convert payment ', v_payment.receipt_number, ' to credit note'),
        'contact_id', v_payment.contact_id)
    );
  ELSE
    -- Unapplied advance: reclassify the deposit liability into customer credit.
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id', v_deposits_account, 'debit', COALESCE(v_payment.amount, 0), 'credit', 0,
        'description', concat('Convert payment ', v_payment.receipt_number, ' to credit note'),
        'contact_id', v_payment.contact_id),
      jsonb_build_object('account_id', v_credit_account, 'debit', 0, 'credit', COALESCE(v_payment.amount, 0),
        'description', concat('Convert payment ', v_payment.receipt_number, ' to credit note'),
        'contact_id', v_payment.contact_id)
    );
  END IF;

  IF v_credit_account = v_deposits_account
     AND (v_payment.invoice_id IS NULL OR COALESCE(v_payment.applied_amount, 0) <= 0) THEN
    -- Same account on both legs (legacy fallback): nothing to post.
    v_je_id := NULL;
  ELSE
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
  END IF;

  IF v_payment.invoice_id IS NOT NULL AND COALESCE(v_payment.applied_amount, 0) > 0 THEN
    -- Detach payment; the cash now sits as customer credit.
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

  -- Canonical, business-scoped numbering (ADR 0131 §6). No timestamp fallback:
  -- a document that cannot be numbered must not be created.
  v_cn_number := public.get_next_credit_note_number(
    v_payment.organization_id, v_payment.business_id, v_payment.branch_id);
  IF v_cn_number IS NULL THEN
    RAISE EXCEPTION 'could not allocate a credit note number for business %', v_payment.business_id;
  END IF;

  INSERT INTO public.credit_notes (
    organization_id, business_id, branch_id, contact_id,
    credit_note_number, status, issue_date,
    subtotal, tax_amount, total, amount_applied,
    currency, reason, source_payment_id, created_by
  ) VALUES (
    v_payment.organization_id, v_payment.business_id, v_payment.branch_id, v_payment.contact_id,
    v_cn_number, 'issued'::credit_note_status, v_post_date,
    v_payment.amount, 0, v_payment.amount, 0,
    v_currency, COALESCE(_reason_text, 'Payment converted to credit note'),
    v_payment.id, auth.uid()
  )
  RETURNING id INTO v_cn_id;

  -- The credit must be spendable: record it in the customer credit ledger.
  v_balance_id := public.customer_credit_balance_id(
    v_payment.organization_id, v_payment.business_id, v_payment.contact_id, v_currency);
  INSERT INTO public.customer_credit_movements (
    organization_id, business_id, branch_id, contact_id, balance_id,
    kind, amount, currency, credit_note_id, journal_entry_id, created_by, notes
  ) VALUES (
    v_payment.organization_id, v_payment.business_id, v_payment.branch_id,
    v_payment.contact_id, v_balance_id,
    'issue', COALESCE(v_payment.amount, 0), v_currency, v_cn_id, v_je_id, auth.uid(),
    'Payment converted to credit note'
  );

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
$function$;