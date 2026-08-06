-- Voiding a payment is a settlement operation. The client previously did it in
-- four separate round-trips (reverse JE → flip status → per-invoice decrement →
-- audit event); a failure between steps left the GL reversed while invoices
-- still counted the cash. One transaction, one writer.
--
-- Allocations are intentionally left in place: `status = 'voided'` already
-- excludes the payment from every live-allocation sum, so the rows stay as
-- history instead of being deleted or compensated.
CREATE OR REPLACE FUNCTION public.void_payment_atomic(
  _payment_id uuid,
  _reason text,
  _reason_code text DEFAULT NULL,
  _void_date date DEFAULT NULL,
  _actor uuid DEFAULT NULL,
  _client_request_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
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

  -- Idempotent: a repeated void is a no-op, not an error.
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

  -- 1. GL first.
  IF v_payment.journal_entry_id IS NOT NULL THEN
    v_reversal_je := public.void_journal_entry_atomic(
      v_payment.journal_entry_id,
      'Void payment ' || COALESCE(v_payment.receipt_number, _payment_id::text)
        || ': ' || COALESCE(_reason, 'no reason given'),
      _actor, NULL, _void_date);
  ELSE
    -- Unlinked but posted: find the entry by source linkage.
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

  -- 2. Header. Set before the invoice recompute so live-allocation sums
  --    already exclude this payment.
  UPDATE public.payments
     SET status      = 'voided',
         voided_at   = now(),
         voided_by   = _actor,
         void_reason = _reason,
         updated_at  = now()
   WHERE id = _payment_id;

  -- 3. Recompute invoices from the live allocation sum. Voided and cancelled
  --    invoices keep their status — a void must not reopen them.
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

  -- 4. Reason-coded event (ADR 0012). Part of the transaction, not best-effort.
  INSERT INTO public.payment_reversal_events
    (organization_id, business_id, payment_id, op, reason_code, reason_text,
     amount_before_outstanding, amount_before_applied,
     amount_after_outstanding,  amount_after_applied,
     reversal_journal_entry_id, performed_by, performed_at, client_request_id)
  VALUES
    (v_payment.organization_id, v_payment.business_id, _payment_id,
     'void', COALESCE(_reason_code, 'payment_voided'), _reason,
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
$fn$;

REVOKE ALL ON FUNCTION public.void_payment_atomic(uuid, text, text, date, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.void_payment_atomic(uuid, text, text, date, uuid, text) TO authenticated, service_role;