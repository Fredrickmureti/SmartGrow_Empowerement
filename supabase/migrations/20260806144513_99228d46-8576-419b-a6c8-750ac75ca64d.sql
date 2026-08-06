-- 1. Cascade void must use a valid payment_reversal_reason value.
CREATE OR REPLACE FUNCTION public.void_invoice_atomic(
  _invoice_id uuid,
  _reason text,
  _void_date date DEFAULT NULL,
  _actor uuid DEFAULT NULL,
  _cascade_payments boolean DEFAULT true,
  _client_request_id text DEFAULT NULL
) RETURNS jsonb
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
  v_payment_ids  uuid[] := ARRAY[]::uuid[];
  v_payment_id   uuid;
  v_voided_pmts  uuid[] := ARRAY[]::uuid[];
BEGIN
  SELECT * INTO v_inv FROM public.invoices WHERE id = _invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice % not found.', _invoice_id USING ERRCODE = 'P0002';
  END IF;

  IF v_inv.status::text IN ('voided', 'cancelled') THEN
    RETURN jsonb_build_object('invoice_id', _invoice_id, 'already_voided', true);
  END IF;

  v_date := COALESCE(_void_date, CURRENT_DATE);

  IF v_inv.business_id IS NOT NULL
     AND NOT public.is_period_open(v_inv.business_id, v_date) THEN
    RAISE EXCEPTION 'Void date falls in a closed fiscal period. Void refused.' USING ERRCODE = '22023';
  END IF;

  v_label := 'Void invoice ' || COALESCE(v_inv.invoice_number, _invoice_id::text)
             || ': ' || COALESCE(_reason, 'no reason given');

  SELECT COALESCE(array_agg(DISTINCT p.id), ARRAY[]::uuid[])
    INTO v_payment_ids
    FROM public.payment_allocations a
    JOIN public.payments p ON p.id = a.payment_id
   WHERE a.invoice_id = _invoice_id
     AND COALESCE(p.status, 'completed') NOT IN ('voided', 'cancelled');

  IF array_length(v_payment_ids, 1) > 0 AND NOT _cascade_payments THEN
    RAISE EXCEPTION 'Invoice % still has % live payment(s). Void or unapply them first, or request a cascading void.',
      COALESCE(v_inv.invoice_number, _invoice_id::text), array_length(v_payment_ids, 1)
      USING ERRCODE = '23514';
  END IF;

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

  FOREACH v_payment_id IN ARRAY v_payment_ids LOOP
    PERFORM public.void_payment_atomic(
      v_payment_id,
      'Parent invoice ' || COALESCE(v_inv.invoice_number, _invoice_id::text)
        || ' voided: ' || COALESCE(_reason, 'no reason given'),
      'invoice_voided_cascade',
      v_date,
      _actor,
      CASE WHEN _client_request_id IS NULL THEN NULL
           ELSE _client_request_id || ':' || v_payment_id::text END
    );
    v_voided_pmts := v_voided_pmts || v_payment_id;
  END LOOP;

  PERFORM public.restore_invoice_stock_atomic(_invoice_id, _actor, _reason);

  RETURN jsonb_build_object(
    'invoice_id', _invoice_id,
    'reversal_journal_entry_ids', to_jsonb(v_reversals),
    'main_reversal_journal_entry_id', v_main_rev,
    'voided_payment_ids', to_jsonb(v_voided_pmts)
  );
END;
$function$;

-- 2. `payment_voided` is not a member of payment_reversal_reason; the COALESCE
--    made a void with no reason code fail at the enum cast. The column is
--    nullable, so pass the value through unchanged.
CREATE OR REPLACE FUNCTION public.void_payment_atomic(
  _payment_id uuid,
  _reason text,
  _reason_code text DEFAULT NULL,
  _void_date date DEFAULT NULL,
  _actor uuid DEFAULT NULL,
  _client_request_id text DEFAULT NULL
) RETURNS jsonb
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
  IF v_payment.business_id IS NOT NULL
     AND NOT public.is_period_open(v_payment.business_id,
                                   COALESCE(_void_date, v_payment.payment_date, CURRENT_DATE)) THEN
    RAISE EXCEPTION 'Void date falls in a closed fiscal period. Void refused.' USING ERRCODE = '22023';
  END IF;

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