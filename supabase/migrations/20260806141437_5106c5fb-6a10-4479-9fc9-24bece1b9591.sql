-- Un-reconcile as a settlement operation, not a client-side sequence of writes.
-- The previous path (useTransactionReversal.unreconcilePayment) reversed the JE,
-- flipped the payment, decremented invoices and then DELETEd the allocation rows
-- from the browser: four unprotected round-trips, and a hard delete that destroys
-- the audit trail ADR 0027 invariant 5 requires. This RPC does the same work
-- atomically and append-only, mirroring reallocate_payment_atomic.
CREATE OR REPLACE FUNCTION public.unreconcile_payment_atomic(
  _payment_id uuid,
  _reason text,
  _actor uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_payment           public.payments%ROWTYPE;
  v_prior_applied     numeric;
  v_prior_outstanding numeric;
  v_touched           uuid[] := ARRAY[]::uuid[];
  v_invoice_id        uuid;
  v_inv               RECORD;
  v_new_paid          numeric;
  v_new_status        invoice_status;
  v_reversal_je       uuid;
  v_event_id          uuid;
  v_cleared           numeric := 0;
BEGIN
  SELECT * INTO v_payment FROM public.payments WHERE id = _payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment % not found.', _payment_id USING ERRCODE = 'P0002';
  END IF;
  IF COALESCE(v_payment.status, 'completed') IN ('voided','cancelled') THEN
    RAISE EXCEPTION 'Cannot unreconcile a voided or cancelled payment.' USING ERRCODE = '22023';
  END IF;
  IF v_payment.business_id IS NOT NULL
     AND NOT public.is_period_open(v_payment.business_id, COALESCE(v_payment.payment_date, CURRENT_DATE)) THEN
    RAISE EXCEPTION 'Payment date falls in a closed fiscal period. Unreconcile refused.' USING ERRCODE = '22023';
  END IF;

  -- Live allocation state = the net-positive rows, same definition the
  -- reallocation path uses.
  SELECT COALESCE(array_agg(t.invoice_id), ARRAY[]::uuid[]), COALESCE(SUM(t.net), 0)
    INTO v_touched, v_cleared
    FROM (
      SELECT a.invoice_id, SUM(a.amount) AS net
        FROM public.payment_allocations a
       WHERE a.payment_id = _payment_id
       GROUP BY a.invoice_id
      HAVING SUM(a.amount) > 0
    ) t;

  IF array_length(v_touched, 1) IS NULL THEN
    RAISE EXCEPTION 'Payment is not currently applied to any invoice.' USING ERRCODE = '22023';
  END IF;

  v_prior_applied     := COALESCE(v_payment.applied_amount, 0);
  v_prior_outstanding := COALESCE(v_payment.outstanding_amount, 0);

  -- 1. Reverse the payment journal. The AR credit carries contact linkage, so
  --    it cannot survive detachment; reapply posts a fresh entry.
  IF v_payment.journal_entry_id IS NOT NULL THEN
    v_reversal_je := public.void_journal_entry_atomic(
      v_payment.journal_entry_id,
      'Unreconcile payment ' || COALESCE(v_payment.receipt_number, _payment_id::text)
        || ': ' || COALESCE(_reason, 'no reason given'),
      _actor
    );
  END IF;

  -- 2. Payment header first, so the deferred sum-invariant trigger evaluates
  --    against the cleared state at commit.
  UPDATE public.payments
     SET journal_entry_id    = NULL,
         status              = 'unreconciled',
         applied_amount      = 0,
         outstanding_amount  = COALESCE(amount, 0),
         unreconciled_at     = now(),
         unreconciled_by     = _actor,
         unreconcile_reason  = _reason,
         updated_at          = now()
   WHERE id = _payment_id;

  SET CONSTRAINTS trg_payment_alloc_sum_invariant DEFERRED;

  -- 3. Append compensating negatives. Never DELETE: the history of what this
  --    payment settled, and when it stopped settling it, is the audit trail.
  INSERT INTO public.payment_allocations
    (payment_id, invoice_id, amount, branch_id, source, created_by, created_at)
  SELECT _payment_id, t.invoice_id, -t.net, v_payment.branch_id, 'reallocation', _actor, now()
    FROM (
      SELECT a.invoice_id, SUM(a.amount) AS net
        FROM public.payment_allocations a
       WHERE a.payment_id = _payment_id
       GROUP BY a.invoice_id
      HAVING SUM(a.amount) > 0
    ) t;

  -- 4. Recompute each touched invoice from the live allocation sum rather than
  --    decrementing, so a concurrent payment on the same invoice is respected.
  FOREACH v_invoice_id IN ARRAY v_touched LOOP
    SELECT i.id, i.total INTO v_inv
      FROM public.invoices i WHERE i.id = v_invoice_id FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;

    SELECT COALESCE(SUM(amount), 0) INTO v_new_paid
      FROM public.payment_allocations
     WHERE invoice_id = v_invoice_id
       AND payment_id IN (
         SELECT id FROM public.payments
          WHERE COALESCE(status, 'completed') NOT IN ('voided','cancelled')
       );

    IF v_new_paid >= v_inv.total - 0.005 THEN
      v_new_status := 'paid'::invoice_status;
    ELSIF v_new_paid > 0.005 THEN
      v_new_status := 'partial'::invoice_status;
    ELSE
      v_new_status := 'sent'::invoice_status;
    END IF;

    UPDATE public.invoices
       SET amount_paid = v_new_paid,
           status = v_new_status,
           updated_at = now()
     WHERE id = v_invoice_id;
  END LOOP;

  INSERT INTO public.payment_reversal_events
    (organization_id, business_id, payment_id, op, reason_code, reason_text,
     amount_before_outstanding, amount_before_applied,
     amount_after_outstanding,  amount_after_applied,
     reversal_journal_entry_id, performed_by, performed_at)
  VALUES
    (v_payment.organization_id, v_payment.business_id, _payment_id,
     'unapply', 'payment_unreconciled', _reason,
     v_prior_outstanding, v_prior_applied,
     COALESCE(v_payment.amount, 0), 0,
     v_reversal_je, _actor, now())
  RETURNING id INTO v_event_id;

  RETURN jsonb_build_object(
    'payment_id', _payment_id,
    'event_id', v_event_id,
    'reversal_journal_entry_id', v_reversal_je,
    'cleared_amount', v_cleared,
    'touched_invoices', to_jsonb(v_touched)
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.unreconcile_payment_atomic(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unreconcile_payment_atomic(uuid, text, uuid) TO authenticated, service_role;