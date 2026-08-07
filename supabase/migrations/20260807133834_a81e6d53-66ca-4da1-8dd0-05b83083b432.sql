-- ============================================================================
-- Phase 5.2 — one reversal reason taxonomy.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.reversal_reason_codes (
  code             text PRIMARY KEY,
  label            text NOT NULL,
  description      text,
  applies_to       text[] NOT NULL,
  requires_comment boolean NOT NULL DEFAULT false,
  sort_order       integer NOT NULL DEFAULT 100,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.reversal_reason_codes IS
  'ADR 0129 — the single reversal reason vocabulary. Every reversal writer validates its reason code against this catalog for the document type being reversed.';

GRANT SELECT ON public.reversal_reason_codes TO authenticated;
GRANT ALL    ON public.reversal_reason_codes TO service_role;

ALTER TABLE public.reversal_reason_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Reversal reason codes are readable by signed-in users" ON public.reversal_reason_codes;
CREATE POLICY "Reversal reason codes are readable by signed-in users"
  ON public.reversal_reason_codes FOR SELECT TO authenticated USING (true);

DROP TRIGGER IF EXISTS trg_reversal_reason_codes_updated_at ON public.reversal_reason_codes;
CREATE TRIGGER trg_reversal_reason_codes_updated_at
  BEFORE UPDATE ON public.reversal_reason_codes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------- seed
-- Payment codes are deliberately a subset of the `payment_reversal_reason`
-- enum: `void_payment_atomic` still casts to it when writing its event row.
INSERT INTO public.reversal_reason_codes (code, label, description, applies_to, requires_comment, sort_order) VALUES
  ('data_entry_error', 'Data entry error', 'Captured incorrectly and being re-entered.',
     ARRAY['invoice','payment','bill','bill_payment','goods_receipt'], false, 10),
  ('duplicate_document', 'Duplicate document', 'The same document was recorded twice.',
     ARRAY['invoice','bill','goods_receipt'], false, 20),
  ('duplicate_payment', 'Duplicate payment', 'The same payment was recorded twice.',
     ARRAY['payment','bill_payment'], false, 20),
  ('wrong_amount', 'Wrong amount', 'Amount does not match the agreed value.',
     ARRAY['invoice','payment','bill','bill_payment','goods_receipt'], false, 30),
  ('wrong_counterparty', 'Wrong customer or supplier', 'Raised against the wrong party.',
     ARRAY['invoice','bill','goods_receipt','bill_payment'], false, 40),
  ('pricing_error', 'Pricing error', 'Incorrect price, discount or tax applied.',
     ARRAY['invoice','bill'], false, 50),
  ('order_cancelled', 'Order cancelled', 'The underlying order was cancelled.',
     ARRAY['invoice','bill','goods_receipt'], false, 60),
  ('goods_returned', 'Goods returned to supplier', 'Received stock is going back.',
     ARRAY['goods_receipt'], false, 61),
  ('goods_rejected', 'Goods rejected on inspection', 'Quality failure at receiving.',
     ARRAY['goods_receipt'], true, 62),
  ('short_delivery', 'Short or over delivery', 'Quantities received do not match the receipt.',
     ARRAY['goods_receipt'], false, 63),
  ('wrong_invoice_applied', 'Applied to the wrong invoice', 'Settlement pointed at the wrong invoice.',
     ARRAY['payment'], false, 70),
  ('payment_reallocated', 'Payment reallocated', 'Cash is being re-applied elsewhere.',
     ARRAY['payment','bill_payment'], false, 71),
  ('bank_transfer_failed', 'Bank transfer failed', 'The funds never cleared.',
     ARRAY['payment','bill_payment'], false, 72),
  ('customer_refund_requested', 'Customer refund requested', 'Cash is being returned to the customer.',
     ARRAY['payment'], false, 73),
  ('payment_currency_mismatch', 'Currency mismatch', 'Recorded in the wrong currency.',
     ARRAY['payment','bill_payment'], false, 74),
  ('pre_refund_unapply', 'Un-apply before refund', 'Releasing the allocation ahead of a refund.',
     ARRAY['payment'], false, 75),
  ('invoice_cancelled_keep_as_credit', 'Invoice cancelled — keep as credit', 'Retain the cash as a customer credit.',
     ARRAY['payment'], false, 76),
  ('invoice_cancelled_keep_as_advance', 'Invoice cancelled — keep as advance', 'Retain the cash as an unapplied advance.',
     ARRAY['payment'], false, 77),
  ('invoice_voided_cascade', 'Invoice voided', 'Reversed because its invoice was voided.',
     ARRAY['payment'], false, 78),
  ('test_transaction', 'Test transaction', 'Created while testing; not a real trade.',
     ARRAY['invoice','payment','bill','bill_payment','goods_receipt'], true, 90),
  ('other', 'Other (explain)', 'Anything the list does not cover — a written explanation is required.',
     ARRAY['invoice','payment','bill','bill_payment','goods_receipt'], true, 999)
ON CONFLICT (code) DO UPDATE
  SET label = EXCLUDED.label,
      description = EXCLUDED.description,
      applies_to = EXCLUDED.applies_to,
      requires_comment = EXCLUDED.requires_comment,
      sort_order = EXCLUDED.sort_order,
      active = true,
      updated_at = now();

-- ------------------------------------------------- reason code columns
ALTER TABLE public.invoices        ADD COLUMN IF NOT EXISTS void_reason_code text;
ALTER TABLE public.payments        ADD COLUMN IF NOT EXISTS void_reason_code text;
ALTER TABLE public.bills           ADD COLUMN IF NOT EXISTS void_reason_code text;
ALTER TABLE public.bill_payments   ADD COLUMN IF NOT EXISTS void_reason_code text;
ALTER TABLE public.goods_receipts  ADD COLUMN IF NOT EXISTS reversal_reason_code text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_void_reason_code_fkey') THEN
    ALTER TABLE public.invoices ADD CONSTRAINT invoices_void_reason_code_fkey
      FOREIGN KEY (void_reason_code) REFERENCES public.reversal_reason_codes(code);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_void_reason_code_fkey') THEN
    ALTER TABLE public.payments ADD CONSTRAINT payments_void_reason_code_fkey
      FOREIGN KEY (void_reason_code) REFERENCES public.reversal_reason_codes(code);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bills_void_reason_code_fkey') THEN
    ALTER TABLE public.bills ADD CONSTRAINT bills_void_reason_code_fkey
      FOREIGN KEY (void_reason_code) REFERENCES public.reversal_reason_codes(code);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bill_payments_void_reason_code_fkey') THEN
    ALTER TABLE public.bill_payments ADD CONSTRAINT bill_payments_void_reason_code_fkey
      FOREIGN KEY (void_reason_code) REFERENCES public.reversal_reason_codes(code);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'goods_receipts_reversal_reason_code_fkey') THEN
    ALTER TABLE public.goods_receipts ADD CONSTRAINT goods_receipts_reversal_reason_code_fkey
      FOREIGN KEY (reversal_reason_code) REFERENCES public.reversal_reason_codes(code);
  END IF;
END $$;

-- ------------------------------------------------------- validator
CREATE OR REPLACE FUNCTION public.assert_reversal_reason(
  _document_type text,
  _reason_code   text,
  _comment       text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_row public.reversal_reason_codes%ROWTYPE;
BEGIN
  IF _reason_code IS NULL OR btrim(_reason_code) = '' THEN
    RAISE EXCEPTION 'A reversal reason must be chosen from the reason list before a % can be reversed.', _document_type
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row FROM public.reversal_reason_codes WHERE code = _reason_code;

  IF NOT FOUND OR NOT v_row.active THEN
    RAISE EXCEPTION 'Reversal reason "%" is not a recognised reason.', _reason_code
      USING ERRCODE = '23514';
  END IF;

  IF NOT (_document_type = ANY (v_row.applies_to)) THEN
    RAISE EXCEPTION 'Reversal reason "%" does not apply to a %.', _reason_code, _document_type
      USING ERRCODE = '23514';
  END IF;

  IF v_row.requires_comment AND (_comment IS NULL OR btrim(_comment) = '') THEN
    RAISE EXCEPTION 'Reversal reason "%" requires a written explanation.', v_row.label
      USING ERRCODE = '22023';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.assert_reversal_reason(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_reversal_reason(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assert_reversal_reason(text, text, text) TO service_role;

-- ============================================================================
-- Writers take a reason code and validate it through the one validator.
-- ============================================================================

DROP FUNCTION IF EXISTS public.void_invoice_atomic(uuid, text, date, uuid, boolean, text);
CREATE OR REPLACE FUNCTION public.void_invoice_atomic(_invoice_id uuid, _reason text, _void_date date DEFAULT NULL::date, _actor uuid DEFAULT NULL::uuid, _cascade_payments boolean DEFAULT false, _client_request_id text DEFAULT NULL::text, _reason_code text DEFAULT NULL::text)
 RETURNS jsonb
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
  v_tasks_cancelled int := 0;
BEGIN
  SELECT * INTO v_inv FROM public.invoices WHERE id = _invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice % not found.', _invoice_id USING ERRCODE = 'P0002';
  END IF;

  IF v_inv.status::text IN ('voided', 'cancelled') THEN
    RETURN jsonb_build_object('invoice_id', _invoice_id, 'already_voided', true);
  END IF;

  v_date := COALESCE(_void_date, CURRENT_DATE);

  IF COALESCE(_cascade_payments, false) THEN
    RAISE EXCEPTION 'Cascading payment voids are no longer permitted. Voiding an invoice must not unwind a customer payment — issue a credit note, refund the customer, or reverse the payment through the guided wizard.'
      USING ERRCODE = '0A000';
  END IF;

  PERFORM public.assert_reversal_reason('invoice', _reason_code, _reason);
  PERFORM public.assert_can_reverse('invoice', _invoice_id, 'void', _actor, v_date);

  v_label := 'Void invoice ' || COALESCE(v_inv.invoice_number, _invoice_id::text)
             || ': ' || COALESCE(_reason, 'no reason given');

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
         void_reason_code            = _reason_code,
         journal_entry_id            = NULL,
         reversal_journal_entry_id   = v_main_rev,
         updated_at                  = now()
   WHERE id = _invoice_id;

  PERFORM public.restore_invoice_stock_atomic(_invoice_id, _actor, _reason);

  v_tasks_cancelled := public.wms_cancel_tasks_for_document(
    'invoice', _invoice_id,
    'Invoice voided: ' || COALESCE(_reason, 'no reason given'), _actor);

  RETURN jsonb_build_object(
    'invoice_id', _invoice_id,
    'reversal_journal_entry_ids', to_jsonb(v_reversals),
    'main_reversal_journal_entry_id', v_main_rev,
    'voided_payment_ids', '[]'::jsonb,
    'cancelled_warehouse_task_count', v_tasks_cancelled
  );
END;
$function$;

-- payment: signature already carries _reason_code; add validation + column stamp
CREATE OR REPLACE FUNCTION public.void_payment_atomic(_payment_id uuid, _reason text, _reason_code text DEFAULT NULL::text, _void_date date DEFAULT NULL::date, _actor uuid DEFAULT NULL::uuid, _client_request_id text DEFAULT NULL::text)
 RETURNS jsonb
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

  PERFORM public.assert_reversal_reason('payment', _reason_code, _reason);
  PERFORM public.assert_can_reverse(
    'payment', _payment_id, 'void', _actor,
    COALESCE(_void_date, v_payment.payment_date, CURRENT_DATE));

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
     SET status           = 'voided',
         voided_at        = now(),
         voided_by        = _actor,
         void_reason      = _reason,
         void_reason_code = _reason_code,
         updated_at       = now()
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

DROP FUNCTION IF EXISTS public.void_bill_atomic(uuid, text, date, uuid, text);
CREATE OR REPLACE FUNCTION public.void_bill_atomic(_bill_id uuid, _reason text, _void_date date DEFAULT NULL::date, _actor uuid DEFAULT NULL::uuid, _client_request_id text DEFAULT NULL::text, _reason_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_bill        public.bills%ROWTYPE;
  v_date        date := COALESCE(_void_date, CURRENT_DATE);
  v_je          RECORD;
  v_rev         uuid;
  v_reversals   uuid[] := ARRAY[]::uuid[];
BEGIN
  IF _bill_id IS NULL THEN
    RAISE EXCEPTION 'void_bill_atomic requires a bill id' USING ERRCODE = '22023';
  END IF;
  IF _reason IS NULL OR btrim(_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required to void a bill.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_bill FROM public.bills WHERE id = _bill_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bill % not found.', _bill_id USING ERRCODE = 'P0002';
  END IF;

  IF v_bill.status::text = 'void' THEN
    RETURN jsonb_build_object(
      'result', 'already_voided',
      'bill_id', _bill_id,
      'bill_number', v_bill.bill_number);
  END IF;

  PERFORM public.assert_reversal_reason('bill', _reason_code, _reason);
  PERFORM public.assert_can_reverse('bill', _bill_id, 'void', _actor, v_date);

  FOR v_je IN
    SELECT je.id, je.entry_number
      FROM public.journal_entries je
     WHERE je.organization_id = v_bill.organization_id
       AND je.source_type = 'bill'
       AND je.source_id = _bill_id
       AND je.status::text NOT IN ('voided', 'reversed')
  LOOP
    v_rev := public.void_journal_entry_atomic(
      v_je.id,
      'Void bill ' || COALESCE(v_bill.bill_number, _bill_id::text) || ': ' || _reason,
      _actor,
      NULL,
      v_date);
    IF v_rev IS NOT NULL THEN
      v_reversals := v_reversals || v_rev;
    END IF;
  END LOOP;

  IF array_length(v_reversals, 1) IS NULL AND v_bill.journal_entry_id IS NOT NULL THEN
    SELECT je.id INTO v_je
      FROM public.journal_entries je
     WHERE je.id = v_bill.journal_entry_id
       AND je.status::text NOT IN ('voided', 'reversed');
    IF FOUND THEN
      v_rev := public.void_journal_entry_atomic(
        v_bill.journal_entry_id,
        'Void bill ' || COALESCE(v_bill.bill_number, _bill_id::text) || ': ' || _reason,
        _actor,
        NULL,
        v_date);
      IF v_rev IS NOT NULL THEN
        v_reversals := v_reversals || v_rev;
      END IF;
    END IF;
  END IF;

  DELETE FROM public.bill_match_results WHERE bill_id = _bill_id;

  UPDATE public.bills
     SET status           = 'void',
         amount_paid      = 0,
         voided_at        = now(),
         voided_by        = _actor,
         void_reason      = _reason,
         void_reason_code = _reason_code,
         updated_at       = now()
   WHERE id = _bill_id;

  PERFORM public.po_resync_billed_state_for_bill(_bill_id);

  RETURN jsonb_build_object(
    'result', 'voided',
    'bill_id', _bill_id,
    'bill_number', v_bill.bill_number,
    'void_date', v_date,
    'reversal_journal_entry_ids', to_jsonb(v_reversals),
    'purchase_order_billing_restored', true,
    'client_request_id', _client_request_id);
END;
$function$;

DROP FUNCTION IF EXISTS public.void_bill_payment_atomic(uuid, text, date, uuid, text);
CREATE OR REPLACE FUNCTION public.void_bill_payment_atomic(_bill_payment_id uuid, _reason text, _void_date date DEFAULT NULL::date, _actor uuid DEFAULT NULL::uuid, _client_request_id text DEFAULT NULL::text, _reason_code text DEFAULT NULL::text)
 RETURNS jsonb
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

  PERFORM public.assert_reversal_reason('bill_payment', _reason_code, _reason);
  PERFORM public.assert_can_reverse(
    'bill_payment', _bill_payment_id, 'void', _actor,
    COALESCE(_void_date, v_bp.payment_date, CURRENT_DATE));

  SELECT COALESCE(array_agg(DISTINCT a.bill_id), ARRAY[]::uuid[])
    INTO v_touched
    FROM public.bill_payment_allocations a
   WHERE a.bill_payment_id = _bill_payment_id;

  v_label := 'Void bill payment ' || COALESCE(v_bp.reference, _bill_payment_id::text)
             || ': ' || COALESCE(_reason, 'no reason given');

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

  UPDATE public.bill_payments
     SET status           = 'voided',
         voided_at        = now(),
         voided_by        = _actor,
         void_reason      = _reason,
         void_reason_code = _reason_code,
         updated_at       = now()
   WHERE id = _bill_payment_id;

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

DROP FUNCTION IF EXISTS public.void_goods_receipt_atomic(uuid, text, date, uuid, text);
CREATE OR REPLACE FUNCTION public.void_goods_receipt_atomic(_gr_id uuid, _reason text, _void_date date DEFAULT NULL::date, _actor uuid DEFAULT NULL::uuid, _client_request_id text DEFAULT NULL::text, _reason_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_grn        public.goods_receipts%ROWTYPE;
  v_date       date := COALESCE(_void_date, CURRENT_DATE);
  v_actor      uuid := COALESCE(_actor, auth.uid());
  v_je         RECORD;
  v_rev        uuid;
  v_reversals  uuid[] := ARRAY[]::uuid[];
  v_stock      jsonb;
  v_tasks      jsonb;
BEGIN
  IF _gr_id IS NULL THEN
    RAISE EXCEPTION 'void_goods_receipt_atomic requires a goods receipt id' USING ERRCODE = '22023';
  END IF;
  IF _reason IS NULL OR btrim(_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required to reverse a goods receipt.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_grn FROM public.goods_receipts WHERE id = _gr_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Goods receipt % not found.', _gr_id USING ERRCODE = 'P0002';
  END IF;

  IF COALESCE(v_grn.status, 'draft') IN ('reversed', 'cancelled', 'voided') THEN
    RETURN jsonb_build_object(
      'result', 'already_reversed',
      'goods_receipt_id', _gr_id,
      'receipt_number', v_grn.receipt_number);
  END IF;

  PERFORM public.assert_reversal_reason('goods_receipt', _reason_code, _reason);
  PERFORM public.assert_can_reverse('goods_receipt', _gr_id, 'goods_return', v_actor, v_date);

  FOR v_je IN
    SELECT je.id
      FROM public.journal_entries je
     WHERE je.organization_id = v_grn.organization_id
       AND ((je.source_type = 'goods_receipt' AND je.source_id = _gr_id)
         OR (je.reference_type = 'goods_receipt' AND je.reference_id = _gr_id))
       AND je.status::text NOT IN ('voided', 'reversed')
  LOOP
    v_rev := public.void_journal_entry_atomic(
      v_je.id,
      'Reverse goods receipt ' || COALESCE(v_grn.receipt_number, _gr_id::text) || ': ' || _reason,
      v_actor,
      NULL,
      v_date);
    IF v_rev IS NOT NULL THEN
      v_reversals := v_reversals || v_rev;
    END IF;
  END LOOP;

  v_stock := public.wms_reverse_gr_stock(_gr_id, v_actor, _reason);
  IF NOT COALESCE((v_stock->>'success')::boolean, false) THEN
    RAISE EXCEPTION 'wms_reverse_gr_stock failed: %', v_stock->>'error';
  END IF;

  v_tasks := public.wms_cancel_tasks_for_document('goods_receipt', _gr_id, _reason, v_actor);

  DELETE FROM public.bill_grn_matches WHERE goods_receipt_id = _gr_id;

  UPDATE public.goods_receipts
     SET status               = 'reversed',
         reversal_reason_code = _reason_code,
         notes                = COALESCE(notes || E'\n', '') || 'Reversed ' || v_date::text || ': ' || _reason,
         updated_at           = now()
   WHERE id = _gr_id;

  INSERT INTO public.business_event_outbox (
    org_id, branch_id, warehouse_id,
    event_type, source_doc_type, source_doc_id,
    payload, occurred_at)
  VALUES (
    v_grn.organization_id, v_grn.branch_id, v_grn.warehouse_id,
    'goods_receipt.reversed', 'goods_receipt', _gr_id,
    jsonb_build_object(
      'receipt_number', v_grn.receipt_number,
      'reason', _reason,
      'reason_code', _reason_code,
      'reversal_journal_entry_ids', to_jsonb(v_reversals),
      'stock', v_stock,
      'tasks', v_tasks,
      'client_request_id', _client_request_id),
    now());

  RETURN jsonb_build_object(
    'result', 'reversed',
    'goods_receipt_id', _gr_id,
    'receipt_number', v_grn.receipt_number,
    'void_date', v_date,
    'reversal_journal_entry_ids', to_jsonb(v_reversals),
    'stock', v_stock,
    'tasks', v_tasks,
    'client_request_id', _client_request_id);
END;
$function$;
