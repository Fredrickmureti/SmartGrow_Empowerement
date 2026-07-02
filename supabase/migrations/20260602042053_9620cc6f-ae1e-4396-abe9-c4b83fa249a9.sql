-- M-3 (ADR 0027 Batch 2 PR1)
-- 1) currency-match consistency guard
-- 2) reallocate_payment_atomic RPC (append-only allocation moves)
-- 3) invoice-void cascade (compensates allocations when an invoice is voided/cancelled)
-- 4) enum widening for reversal event op + reason

-- ============================================================
-- 1. Widen reversal-event vocabulary
-- ============================================================
DO $$ BEGIN
  ALTER TYPE public.payment_reversal_reason ADD VALUE IF NOT EXISTS 'payment_reallocated';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE public.payment_reversal_reason ADD VALUE IF NOT EXISTS 'invoice_voided_cascade';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.payment_reversal_events DROP CONSTRAINT IF EXISTS payment_reversal_events_op_check;
ALTER TABLE public.payment_reversal_events
  ADD CONSTRAINT payment_reversal_events_op_check
  CHECK (op IN ('void','unapply','refund','credit_note','apply_deposit','reallocate'));

-- ============================================================
-- 2. Currency-match guard inside allocation consistency trigger
-- ============================================================
CREATE OR REPLACE FUNCTION public.check_payment_allocation_consistency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  p_contact uuid; p_business uuid; p_org uuid; p_currency text;
  i_contact uuid; i_business uuid; i_org uuid; i_currency text;
BEGIN
  SELECT contact_id, business_id, organization_id, currency
    INTO p_contact, p_business, p_org, p_currency
    FROM public.payments WHERE id = NEW.payment_id;
  SELECT contact_id, business_id, organization_id, currency
    INTO i_contact, i_business, i_org, i_currency
    FROM public.invoices WHERE id = NEW.invoice_id;

  IF p_contact IS DISTINCT FROM i_contact THEN
    RAISE EXCEPTION 'Allocation rejected: payment customer % does not match invoice customer %.', p_contact, i_contact
      USING ERRCODE = '23514';
  END IF;
  IF p_business IS DISTINCT FROM i_business THEN
    RAISE EXCEPTION 'Allocation rejected: payment and invoice belong to different companies.'
      USING ERRCODE = '23514';
  END IF;
  IF p_org IS DISTINCT FROM i_org THEN
    RAISE EXCEPTION 'Allocation rejected: payment and invoice belong to different workspaces.'
      USING ERRCODE = '23514';
  END IF;
  -- Currency match (ADR 0015 will introduce FX-aware allocation; until then, reject mismatches).
  IF p_currency IS NOT NULL AND i_currency IS NOT NULL AND p_currency <> i_currency THEN
    RAISE EXCEPTION 'Allocation rejected: payment currency % does not match invoice currency %. Cross-currency allocation is not supported (ADR 0015).',
      p_currency, i_currency
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- ============================================================
-- 3. reallocate_payment_atomic RPC
--    Append-only: insert negative compensating rows for prior live state,
--    insert positive rows for new state, recompute touched invoices &
--    parent payment, write a reversal_events row.
-- ============================================================
CREATE OR REPLACE FUNCTION public.reallocate_payment_atomic(
  _payment_id uuid,
  _new_allocations jsonb,        -- [{"invoice_id":"...","amount":123.45}, ...]
  _reason text DEFAULT NULL,
  _actor uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_payment public.payments%ROWTYPE;
  v_alloc jsonb;
  v_invoice_id uuid;
  v_amount numeric;
  v_new_sum numeric := 0;
  v_prior_applied numeric;
  v_prior_outstanding numeric;
  v_touched uuid[] := ARRAY[]::uuid[];
  v_event_id uuid;
  v_inv RECORD;
  v_new_paid numeric;
  v_new_status invoice_status;
BEGIN
  -- Lock payment header for the duration of the txn
  SELECT * INTO v_payment FROM public.payments WHERE id = _payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment % not found.', _payment_id USING ERRCODE = 'P0002';
  END IF;
  IF COALESCE(v_payment.status, 'completed') IN ('voided','cancelled') THEN
    RAISE EXCEPTION 'Cannot reallocate a voided or cancelled payment.' USING ERRCODE = '22023';
  END IF;
  IF v_payment.business_id IS NOT NULL
     AND NOT public.is_period_open(v_payment.business_id, COALESCE(v_payment.payment_date, CURRENT_DATE)) THEN
    RAISE EXCEPTION 'Payment date falls in a closed fiscal period. Reallocation refused.' USING ERRCODE = '22023';
  END IF;

  -- Validate new-state payload
  IF _new_allocations IS NULL OR jsonb_typeof(_new_allocations) <> 'array' THEN
    RAISE EXCEPTION 'New allocations must be a JSON array.' USING ERRCODE = '22023';
  END IF;
  FOR v_alloc IN SELECT * FROM jsonb_array_elements(_new_allocations) LOOP
    v_invoice_id := (v_alloc->>'invoice_id')::uuid;
    v_amount     := COALESCE((v_alloc->>'amount')::numeric, 0);
    IF v_invoice_id IS NULL THEN
      RAISE EXCEPTION 'Allocation row missing invoice_id.' USING ERRCODE = '22023';
    END IF;
    IF v_amount <= 0 THEN
      RAISE EXCEPTION 'Allocation amount for invoice % must be > 0.', v_invoice_id USING ERRCODE = '22023';
    END IF;
    v_new_sum := v_new_sum + v_amount;
  END LOOP;

  IF v_new_sum > COALESCE(v_payment.amount, 0) + 0.005 THEN
    RAISE EXCEPTION 'New allocation total % exceeds payment amount %.', v_new_sum, v_payment.amount
      USING ERRCODE = '22023';
  END IF;

  -- Snapshot prior amounts for the reversal event
  v_prior_applied     := COALESCE(v_payment.applied_amount, 0);
  v_prior_outstanding := COALESCE(v_payment.outstanding_amount, 0);

  -- Collect touched invoices (prior + new)
  SELECT array_agg(DISTINCT invoice_id) INTO v_touched
    FROM public.payment_allocations WHERE payment_id = _payment_id;
  v_touched := COALESCE(v_touched, ARRAY[]::uuid[]);
  FOR v_alloc IN SELECT * FROM jsonb_array_elements(_new_allocations) LOOP
    v_invoice_id := (v_alloc->>'invoice_id')::uuid;
    IF NOT (v_invoice_id = ANY(v_touched)) THEN
      v_touched := v_touched || v_invoice_id;
    END IF;
  END LOOP;

  -- Defer the sum-invariant trigger to end of transaction
  SET CONSTRAINTS trg_payment_alloc_sum_invariant DEFERRED;

  -- Append negative compensating rows for every existing live allocation
  INSERT INTO public.payment_allocations
    (payment_id, invoice_id, amount, branch_id, source, created_by, created_at)
  SELECT a.payment_id, a.invoice_id, -a.amount, a.branch_id, 'reallocation', _actor, now()
    FROM public.payment_allocations a
   WHERE a.payment_id = _payment_id
     AND a.amount > 0
     -- only compensate rows that still net positive
     AND (SELECT COALESCE(SUM(amount),0) FROM public.payment_allocations
            WHERE payment_id = a.payment_id AND invoice_id = a.invoice_id) > 0
   GROUP BY a.id, a.payment_id, a.invoice_id, a.amount, a.branch_id;

  -- Append positive rows for the new state
  FOR v_alloc IN SELECT * FROM jsonb_array_elements(_new_allocations) LOOP
    v_invoice_id := (v_alloc->>'invoice_id')::uuid;
    v_amount     := (v_alloc->>'amount')::numeric;
    INSERT INTO public.payment_allocations
      (payment_id, invoice_id, amount, branch_id, source, created_by, created_at)
    VALUES (_payment_id, v_invoice_id, v_amount, v_payment.branch_id, 'reallocation', _actor, now());
  END LOOP;

  -- Recompute amount_paid + status for every touched invoice (live allocation sum only)
  FOREACH v_invoice_id IN ARRAY v_touched LOOP
    SELECT i.id, i.invoice_number, i.total
      INTO v_inv
      FROM public.invoices i
     WHERE i.id = v_invoice_id
     FOR UPDATE;
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

  -- Recompute parent payment applied/outstanding from live allocation sum
  UPDATE public.payments
     SET applied_amount = v_new_sum,
         outstanding_amount = GREATEST(COALESCE(amount,0) - v_new_sum, 0),
         updated_at = now()
   WHERE id = _payment_id;

  -- Reversal-event audit row
  INSERT INTO public.payment_reversal_events
    (organization_id, business_id, payment_id, op, reason_code, reason_text,
     amount_before_outstanding, amount_before_applied,
     amount_after_outstanding,  amount_after_applied,
     performed_by, performed_at)
  VALUES
    (v_payment.organization_id, v_payment.business_id, _payment_id,
     'reallocate', 'payment_reallocated', _reason,
     v_prior_outstanding, v_prior_applied,
     GREATEST(COALESCE(v_payment.amount,0) - v_new_sum, 0), v_new_sum,
     _actor, now())
  RETURNING id INTO v_event_id;

  RETURN jsonb_build_object(
    'payment_id', _payment_id,
    'event_id', v_event_id,
    'new_applied', v_new_sum,
    'new_outstanding', GREATEST(COALESCE(v_payment.amount,0) - v_new_sum, 0),
    'touched_invoices', to_jsonb(v_touched)
  );
END $$;

REVOKE ALL ON FUNCTION public.reallocate_payment_atomic(uuid, jsonb, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reallocate_payment_atomic(uuid, jsonb, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reallocate_payment_atomic(uuid, jsonb, text, uuid) TO service_role;

COMMENT ON FUNCTION public.reallocate_payment_atomic(uuid, jsonb, text, uuid) IS
  'ADR 0027 — Append-only reallocation. Inserts negative compensating allocation rows for the prior live state and positive rows for the new state, never UPDATEs an existing allocation. Recomputes amount_paid + status on every touched invoice and applied/outstanding on the payment.';

-- ============================================================
-- 4. Invoice-void cascade
--    When an invoice transitions to voided/cancelled, compensate any live
--    allocations pointing at it and recompute the affected payments.
-- ============================================================
CREATE OR REPLACE FUNCTION public.cascade_voided_invoice_allocations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_payment_id uuid;
  v_payment public.payments%ROWTYPE;
  v_new_applied numeric;
BEGIN
  IF NEW.status NOT IN ('voided','cancelled') OR OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  SET CONSTRAINTS trg_payment_alloc_sum_invariant DEFERRED;

  -- Append negative compensating rows for every live allocation against this invoice
  INSERT INTO public.payment_allocations
    (payment_id, invoice_id, amount, branch_id, source, created_by, created_at)
  SELECT a.payment_id, a.invoice_id, -SUM(a.amount), MAX(a.branch_id), 'reallocation', NULL, now()
    FROM public.payment_allocations a
   WHERE a.invoice_id = NEW.id
   GROUP BY a.payment_id, a.invoice_id
   HAVING SUM(a.amount) > 0;

  -- Recompute every affected payment + write a cascade audit event
  FOR v_payment_id IN
    SELECT DISTINCT payment_id FROM public.payment_allocations WHERE invoice_id = NEW.id
  LOOP
    SELECT * INTO v_payment FROM public.payments WHERE id = v_payment_id FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF COALESCE(v_payment.status,'completed') IN ('voided','cancelled') THEN CONTINUE; END IF;

    SELECT COALESCE(SUM(amount), 0) INTO v_new_applied
      FROM public.payment_allocations WHERE payment_id = v_payment_id;

    UPDATE public.payments
       SET applied_amount = v_new_applied,
           outstanding_amount = GREATEST(COALESCE(amount,0) - v_new_applied, 0),
           updated_at = now()
     WHERE id = v_payment_id;

    INSERT INTO public.payment_reversal_events
      (organization_id, business_id, payment_id, op, reason_code, reason_text,
       amount_before_outstanding, amount_before_applied,
       amount_after_outstanding,  amount_after_applied,
       performed_at)
    VALUES
      (v_payment.organization_id, v_payment.business_id, v_payment_id,
       'reallocate', 'invoice_voided_cascade',
       format('Invoice %s voided; allocation auto-compensated.', NEW.invoice_number),
       COALESCE(v_payment.outstanding_amount,0), COALESCE(v_payment.applied_amount,0),
       GREATEST(COALESCE(v_payment.amount,0) - v_new_applied, 0), v_new_applied,
       now());
  END LOOP;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_cascade_voided_invoice_allocations ON public.invoices;
CREATE TRIGGER trg_cascade_voided_invoice_allocations
  AFTER UPDATE OF status ON public.invoices
  FOR EACH ROW
  WHEN (NEW.status IN ('voided','cancelled') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.cascade_voided_invoice_allocations();