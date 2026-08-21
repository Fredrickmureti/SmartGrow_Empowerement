CREATE OR REPLACE FUNCTION public.unapply_payment_atomic(_payment_id uuid, _reason_code payment_reversal_reason, _reason_text text, _reversal_date date, _client_request_id text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_settle_je public.journal_entries%ROWTYPE;
  v_line record;
  v_plug numeric := 0;
BEGIN
  IF _payment_id IS NULL THEN RAISE EXCEPTION 'payment_id is required'; END IF;
  IF _reason_code IS NULL THEN RAISE EXCEPTION 'reason_code is required'; END IF;

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

  IF _client_request_id IS NOT NULL THEN
    SELECT id INTO v_event_id
    FROM public.payment_reversal_events
    WHERE payment_id = _payment_id AND op = 'unapply' AND client_request_id = _client_request_id;
    IF v_event_id IS NOT NULL THEN RETURN v_event_id; END IF;
  END IF;

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

  -- The unapply entry mirrors the original settlement journal (ADR 0136): the
  -- receivable is restored at the base amount it was relieved at, and any
  -- realised FX line booked on settlement is backed out on the opposite side.
  -- The cash leg is untouched — the money is simply reclassified from the
  -- receivable to a customer deposit — so the cash line is excluded from the
  -- mirror and the balancing amount lands on customer deposits.
  -- No rate is re-resolved here: a reversal never invents a rate.
  IF v_payment.journal_entry_id IS NOT NULL THEN
    SELECT * INTO v_settle_je FROM public.journal_entries
     WHERE id = v_payment.journal_entry_id AND status = 'posted';
  END IF;

  v_lines := '[]'::jsonb;

  IF v_settle_je.id IS NOT NULL THEN
    FOR v_line IN
      SELECT l.account_id, l.debit, l.credit, l.description, l.contact_id
        FROM public.journal_entry_lines l
       WHERE l.journal_entry_id = v_settle_je.id
         AND l.account_id IS DISTINCT FROM v_payment.deposit_account_id
       ORDER BY l.sort_order NULLS LAST, l.id
    LOOP
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_line.account_id,
        'debit',  COALESCE(v_line.credit, 0),
        'credit', COALESCE(v_line.debit, 0),
        'description', concat('Unapply payment ', v_payment.receipt_number),
        'contact_id', COALESCE(v_line.contact_id, v_payment.contact_id)
      ));
      v_plug := v_plug + COALESCE(v_line.credit, 0) - COALESCE(v_line.debit, 0);
    END LOOP;
  END IF;

  IF jsonb_array_length(v_lines) = 0 THEN
    -- No posted settlement journal to mirror: the payment was applied without
    -- a journal (base currency, legacy rows). Restore at face value.
    v_lines := jsonb_build_array(
      jsonb_build_object(
        'account_id', v_ar_account,
        'debit',  v_payment.applied_amount,
        'credit', 0,
        'description', concat('Unapply payment ', v_payment.receipt_number),
        'contact_id', v_payment.contact_id
      ),
      jsonb_build_object(
        'account_id', v_deposits_account,
        'debit',  0,
        'credit', v_payment.applied_amount,
        'description', concat('Unapply payment ', v_payment.receipt_number),
        'contact_id', v_payment.contact_id
      )
    );
  ELSE
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_deposits_account,
      'debit',  CASE WHEN v_plug < 0 THEN ROUND(-v_plug, 2) ELSE 0 END,
      'credit', CASE WHEN v_plug > 0 THEN ROUND(v_plug, 2) ELSE 0 END,
      'description', concat('Unapplied receipt held as customer deposit ', v_payment.receipt_number),
      'contact_id', v_payment.contact_id
    ));
  END IF;

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
$function$;