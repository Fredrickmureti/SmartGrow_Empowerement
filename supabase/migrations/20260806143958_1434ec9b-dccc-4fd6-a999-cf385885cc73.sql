-- 1. Bill payments become soft-voidable (history preserved, ADR 0126)
ALTER TABLE public.bill_payments
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by uuid,
  ADD COLUMN IF NOT EXISTS void_reason text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_bill_payments_status ON public.bill_payments(status);

-- 2. AP reversal audit trail (mirror of payment_reversal_events)
CREATE TABLE IF NOT EXISTS public.bill_payment_reversal_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  bill_payment_id uuid NOT NULL REFERENCES public.bill_payments(id) ON DELETE CASCADE,
  op text NOT NULL,
  reason_text text,
  amount numeric,
  reversal_journal_entry_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  touched_bills uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  performed_by uuid,
  performed_at timestamptz NOT NULL DEFAULT now(),
  client_request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.bill_payment_reversal_events TO authenticated;
GRANT ALL ON public.bill_payment_reversal_events TO service_role;

ALTER TABLE public.bill_payment_reversal_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members read AP reversal events"
  ON public.bill_payment_reversal_events
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = auth.uid()
       AND ur.organization_id = bill_payment_reversal_events.organization_id
       AND ur.is_active = true
  ));

CREATE UNIQUE INDEX IF NOT EXISTS uq_bp_reversal_client_request
  ON public.bill_payment_reversal_events(organization_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE TRIGGER trg_bp_reversal_events_updated_at
  BEFORE UPDATE ON public.bill_payment_reversal_events
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3. Single canonical AP reversal writer
CREATE OR REPLACE FUNCTION public.void_bill_payment_atomic(
  _bill_payment_id uuid,
  _reason text,
  _void_date date DEFAULT NULL,
  _actor uuid DEFAULT NULL,
  _client_request_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_bp         public.bill_payments%ROWTYPE;
  v_touched    uuid[] := ARRAY[]::uuid[];
  v_reversals  uuid[] := ARRAY[]::uuid[];
  v_bill_id    uuid;
  v_bill       RECORD;
  v_new_paid   numeric;
  v_je         RECORD;
  v_rev        uuid;
  v_event_id   uuid;
  v_label      text;
BEGIN
  SELECT * INTO v_bp FROM public.bill_payments WHERE id = _bill_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bill payment % not found.', _bill_payment_id USING ERRCODE = 'P0002';
  END IF;

  IF COALESCE(v_bp.status, 'completed') = 'voided' THEN
    RETURN jsonb_build_object('bill_payment_id', _bill_payment_id, 'already_voided', true);
  END IF;

  IF v_bp.business_id IS NOT NULL
     AND NOT public.is_period_open(v_bp.business_id,
                                   COALESCE(_void_date, v_bp.payment_date, CURRENT_DATE)) THEN
    RAISE EXCEPTION 'Void date falls in a closed fiscal period. Void refused.' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT a.bill_id), ARRAY[]::uuid[])
    INTO v_touched
    FROM public.bill_payment_allocations a
   WHERE a.bill_payment_id = _bill_payment_id;

  v_label := 'Void bill payment ' || COALESCE(v_bp.reference, _bill_payment_id::text)
             || ': ' || COALESCE(_reason, 'no reason given');

  -- 1. GL first. Reverse every live entry sourced from this payment
  --    (the settlement entry plus any withholding-tax entry).
  FOR v_je IN
    SELECT je.id
      FROM public.journal_entries je
     WHERE je.status NOT IN ('voided', 'reversed')
       AND (
         (je.source_type = 'bill_payment' AND je.source_id = _bill_payment_id)
         OR je.id = v_bp.journal_entry_id
       )
  LOOP
    v_rev := public.void_journal_entry_atomic(v_je.id, v_label, _actor, NULL, _void_date);
    IF v_rev IS NOT NULL THEN
      v_reversals := v_reversals || v_rev;
    END IF;
  END LOOP;

  -- 2. Header. Set before the bill recompute so live-allocation sums already
  --    exclude this payment. The row is never deleted (ADR 0027 invariant 5).
  UPDATE public.bill_payments
     SET status      = 'voided',
         voided_at   = now(),
         voided_by   = _actor,
         void_reason = _reason,
         updated_at  = now()
   WHERE id = _bill_payment_id;

  -- 3. Recompute each touched bill from the live allocation sum.
  FOREACH v_bill_id IN ARRAY v_touched LOOP
    SELECT b.id, b.total, b.status::text AS status INTO v_bill
      FROM public.bills b WHERE b.id = v_bill_id FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;

    SELECT COALESCE(SUM(a.amount), 0) INTO v_new_paid
      FROM public.bill_payment_allocations a
      JOIN public.bill_payments bp ON bp.id = a.bill_payment_id
     WHERE a.bill_id = v_bill_id
       AND COALESCE(bp.status, 'completed') <> 'voided';

    IF v_bill.status IN ('void', 'draft') THEN
      UPDATE public.bills
         SET amount_paid = v_new_paid, updated_at = now()
       WHERE id = v_bill_id;
    ELSE
      UPDATE public.bills
         SET amount_paid = v_new_paid,
             status = CASE
                        WHEN v_new_paid >= v_bill.total - 0.005 THEN 'paid'::bill_status
                        WHEN v_new_paid > 0.005 THEN 'partial'::bill_status
                        ELSE 'received'::bill_status
                      END,
             updated_at = now()
       WHERE id = v_bill_id;
    END IF;
  END LOOP;

  -- 4. Audit trail, inside the same transaction.
  INSERT INTO public.bill_payment_reversal_events
    (organization_id, business_id, bill_payment_id, op, reason_text, amount,
     reversal_journal_entry_ids, touched_bills, performed_by, client_request_id)
  VALUES
    (v_bp.organization_id, v_bp.business_id, _bill_payment_id, 'void', _reason,
     v_bp.amount, v_reversals, v_touched, _actor, _client_request_id)
  RETURNING id INTO v_event_id;

  RETURN jsonb_build_object(
    'bill_payment_id', _bill_payment_id,
    'event_id', v_event_id,
    'reversal_journal_entry_ids', to_jsonb(v_reversals),
    'touched_bills', to_jsonb(v_touched)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.void_bill_payment_atomic(uuid, text, date, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.void_bill_payment_atomic(uuid, text, date, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_bill_payment_atomic(uuid, text, date, uuid, text) TO service_role;