-- ============================================================
-- D6.1 — Supplier advances: read model + application operation
-- AP mirror of apply_customer_deposit_atomic (ADR 0012 / 0028).
-- ============================================================

-- 1. Read model: unapplied vendor cash.
--    AP has no outstanding_amount column (unlike payments); the split is
--    derived from the append-only allocation ledger, once, here.
CREATE OR REPLACE VIEW public.vendor_unapplied_advances
WITH (security_invoker = true) AS
SELECT
  bp.id,
  bp.organization_id,
  bp.business_id,
  bp.branch_id,
  bp.vendor_id,
  bp.payment_date,
  bp.payment_method,
  bp.reference,
  bp.notes,
  bp.amount,
  COALESCE(a.applied_amount, 0)                     AS applied_amount,
  bp.amount - COALESCE(a.applied_amount, 0)         AS outstanding_amount,
  bp.journal_entry_id,
  bp.created_at
FROM public.bill_payments bp
LEFT JOIN LATERAL (
  SELECT SUM(bpa.amount) AS applied_amount
    FROM public.bill_payment_allocations bpa
   WHERE bpa.bill_payment_id = bp.id
) a ON TRUE
WHERE COALESCE(bp.status, 'completed') <> 'voided'
  AND bp.amount - COALESCE(a.applied_amount, 0) > 0.005;

GRANT SELECT ON public.vendor_unapplied_advances TO authenticated;
GRANT SELECT ON public.vendor_unapplied_advances TO service_role;

COMMENT ON VIEW public.vendor_unapplied_advances IS
  'Supplier payments still holding unapplied cash (Vendor Credits). Single source for AP unapplied cash; never re-derive by summing allocations in app code.';


-- 2. Apply an existing vendor advance to a bill.
--    Dr Accounts Payable / Cr Vendor Credits. Cash is NOT touched — it
--    already left the bank when the advance was recorded. Routing this
--    through record_multi_bill_payment would credit Bank a second time.
CREATE OR REPLACE FUNCTION public.apply_vendor_advance_atomic(
  _bill_payment_id uuid,
  _bill_id uuid,
  _amount numeric,
  _apply_date date DEFAULT NULL,
  _actor uuid DEFAULT NULL,
  _client_request_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bp public.bill_payments%ROWTYPE;
  v_bill public.bills%ROWTYPE;
  v_outstanding numeric;
  v_clamp numeric;
  v_ap_account uuid;
  v_advance_account uuid;
  v_post_date date;
  v_je_id uuid;
  v_event_id uuid;
  v_new_amount_paid numeric;
  v_new_status text;
  v_vendor_name text;
BEGIN
  IF _bill_payment_id IS NULL THEN RAISE EXCEPTION 'bill_payment_id is required'; END IF;
  IF _bill_id IS NULL THEN RAISE EXCEPTION 'bill_id is required'; END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'amount must be > 0'; END IF;

  -- Idempotent replay
  IF _client_request_id IS NOT NULL THEN
    SELECT id INTO v_event_id
      FROM public.bill_payment_reversal_events
     WHERE bill_payment_id = _bill_payment_id
       AND op = 'apply_advance'
       AND client_request_id = _client_request_id
     LIMIT 1;
    IF v_event_id IS NOT NULL THEN
      RETURN jsonb_build_object('event_id', v_event_id, 'idempotent_replay', true);
    END IF;
  END IF;

  SELECT * INTO v_bp FROM public.bill_payments WHERE id = _bill_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'supplier payment % not found', _bill_payment_id; END IF;
  IF COALESCE(v_bp.status, 'completed') = 'voided' THEN
    RAISE EXCEPTION 'supplier payment is voided';
  END IF;

  SELECT v_bp.amount - COALESCE(SUM(bpa.amount), 0) INTO v_outstanding
    FROM public.bill_payment_allocations bpa
   WHERE bpa.bill_payment_id = v_bp.id;
  IF COALESCE(v_outstanding, v_bp.amount) <= 0.005 THEN
    RAISE EXCEPTION 'supplier payment has no unapplied cash';
  END IF;

  SELECT * INTO v_bill FROM public.bills WHERE id = _bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'bill % not found', _bill_id; END IF;
  IF v_bill.status::text IN ('void', 'voided', 'cancelled', 'draft') THEN
    RAISE EXCEPTION 'bill is not open for settlement (status %)', v_bill.status;
  END IF;
  IF v_bill.business_id IS DISTINCT FROM v_bp.business_id
     OR v_bill.organization_id IS DISTINCT FROM v_bp.organization_id THEN
    RAISE EXCEPTION 'bill belongs to a different company';
  END IF;
  IF v_bp.vendor_id IS NOT NULL AND v_bill.vendor_id IS DISTINCT FROM v_bp.vendor_id THEN
    RAISE EXCEPTION 'bill belongs to a different supplier';
  END IF;

  v_post_date := COALESCE(_apply_date, CURRENT_DATE);
  IF NOT public.is_period_open(v_bp.business_id, v_post_date) THEN
    RAISE EXCEPTION 'accounting period is closed for %', v_post_date;
  END IF;

  v_clamp := LEAST(
    COALESCE(v_outstanding, v_bp.amount),
    GREATEST(0, COALESCE(v_bill.total, 0) - COALESCE(v_bill.amount_paid, 0)),
    _amount
  );
  IF v_clamp <= 0.005 THEN RAISE EXCEPTION 'nothing to apply'; END IF;

  SELECT account_id INTO v_ap_account
    FROM public.default_account_settings
   WHERE business_id = v_bp.business_id AND setting_key = 'accounts_payable';
  IF v_ap_account IS NULL THEN
    RAISE EXCEPTION 'accounts_payable default account is not configured';
  END IF;

  v_advance_account := public.vendor_advance_account(v_bp.business_id);
  IF v_advance_account IS NULL THEN
    RAISE EXCEPTION 'vendor_advances (or vendor_credit) default account is not configured';
  END IF;

  SELECT name INTO v_vendor_name FROM public.contacts WHERE id = COALESCE(v_bp.vendor_id, v_bill.vendor_id);

  v_je_id := public.post_journal_entry_atomic(
    _organization_id := v_bp.organization_id,
    _entry_date := v_post_date,
    _description := concat('Apply supplier advance to bill ', v_bill.bill_number),
    _source_type := 'vendor_advance_application',
    _source_id := v_bp.id,
    _source_subtype := NULL,
    _entry_number := NULL,
    _reference_number := v_bp.reference,
    _business_id := v_bp.business_id,
    _user_id := COALESCE(_actor, auth.uid()),
    _lines := jsonb_build_array(
      jsonb_build_object('account_id', v_ap_account, 'debit', v_clamp, 'credit', 0,
        'description', concat('AP reduction - advance applied to ', v_bill.bill_number),
        'contact_id', COALESCE(v_bp.vendor_id, v_bill.vendor_id)),
      jsonb_build_object('account_id', v_advance_account, 'debit', 0, 'credit', v_clamp,
        'description', concat('Vendor credit consumed - ', COALESCE(v_vendor_name, 'supplier')),
        'contact_id', COALESCE(v_bp.vendor_id, v_bill.vendor_id))
    ),
    _auto_post := true,
    _idempotency_key := concat('apply_vendor_advance:', v_bp.id, ':', _bill_id, ':',
                               COALESCE(_client_request_id, gen_random_uuid()::text)),
    _metadata := jsonb_build_object('bill_payment_id', v_bp.id, 'bill_id', _bill_id, 'amount', v_clamp)
  );

  -- Allocation ledger (append-only). The consistency trigger stamps the
  -- header vendor when it is still NULL and rejects cross-vendor rows.
  INSERT INTO public.bill_payment_allocations
    (bill_payment_id, bill_id, amount, source, created_by)
  VALUES (v_bp.id, _bill_id, v_clamp, 'advance_application', COALESCE(_actor, auth.uid()));

  v_new_amount_paid := COALESCE(v_bill.amount_paid, 0) + v_clamp;
  v_new_status := CASE
    WHEN v_new_amount_paid >= COALESCE(v_bill.total, 0) - 0.005 THEN 'paid'
    ELSE 'partial'
  END;
  UPDATE public.bills
     SET amount_paid = v_new_amount_paid,
         status = v_new_status::bill_status,
         updated_at = now()
   WHERE id = _bill_id;

  INSERT INTO public.bill_payment_reversal_events (
    organization_id, business_id, bill_payment_id, op, reason_text, amount,
    reversal_journal_entry_ids, touched_bills, performed_by, performed_at, client_request_id
  ) VALUES (
    v_bp.organization_id, v_bp.business_id, v_bp.id, 'apply_advance',
    concat('Applied ', v_clamp, ' to bill ', v_bill.bill_number),
    v_clamp, ARRAY[v_je_id], ARRAY[_bill_id],
    COALESCE(_actor, auth.uid()), now(), _client_request_id
  ) RETURNING id INTO v_event_id;

  RETURN jsonb_build_object(
    'event_id', v_event_id,
    'journal_entry_id', v_je_id,
    'applied_amount', v_clamp,
    'bill_id', _bill_id,
    'bill_new_status', v_new_status,
    'bill_new_amount_paid', v_new_amount_paid,
    'advance_remaining', COALESCE(v_outstanding, v_bp.amount) - v_clamp,
    'idempotent_replay', false
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_vendor_advance_atomic(uuid, uuid, numeric, date, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_vendor_advance_atomic(uuid, uuid, numeric, date, uuid, text) TO service_role;

COMMENT ON FUNCTION public.apply_vendor_advance_atomic(uuid, uuid, numeric, date, uuid, text) IS
  'Applies unapplied supplier cash (Vendor Credits) to an open bill: Dr AP / Cr Vendor Credits. Cash is untouched - it left the bank when the advance was recorded.';


-- 3. record_multi_bill_payment: key idempotency off client_request_id
--    (which carries a partial unique index) instead of the operator-facing
--    reference column, which the old lookup silently overwrote.
DROP FUNCTION IF EXISTS public.record_multi_bill_payment(
  uuid, uuid, uuid, jsonb, numeric, date, text, text, text, uuid, uuid, uuid, uuid, text, numeric, uuid
);

CREATE FUNCTION public.record_multi_bill_payment(
  _org_id uuid,
  _business_id uuid,
  _vendor_id uuid,
  _allocations jsonb,
  _total_amount numeric,
  _payment_date date,
  _payment_method text DEFAULT 'bank_transfer',
  _reference text DEFAULT NULL,
  _notes text DEFAULT NULL,
  _created_by uuid DEFAULT NULL,
  _bank_account_id uuid DEFAULT NULL,
  _payable_account_id uuid DEFAULT NULL,
  _branch_id uuid DEFAULT NULL,
  _request_id text DEFAULT NULL,
  _wht_rate numeric DEFAULT NULL,
  _wht_account_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bp_id uuid;
  v_je_id uuid;
  v_wht_je_id uuid;
  v_alloc record;
  v_bill record;
  v_sum_allocated numeric := 0;
  v_wht_amount numeric := 0;
  v_new_amount_paid numeric;
  v_new_status text;
  v_bill_statuses jsonb := '[]'::jsonb;
  v_vendor_name text;
  v_bill_ids uuid[];
  v_distinct_currency int;
  v_distinct_vendor int;
  v_distinct_business int;
  v_distinct_org int;
  v_existing record;
BEGIN
  IF _bank_account_id IS NULL THEN RAISE EXCEPTION 'Bank/cash account is required for multi-bill payment.'; END IF;
  IF _payable_account_id IS NULL THEN RAISE EXCEPTION 'Accounts Payable account is required.'; END IF;
  IF _total_amount IS NULL OR _total_amount <= 0 THEN RAISE EXCEPTION 'Payment amount must be positive.'; END IF;
  IF _allocations IS NULL OR jsonb_typeof(_allocations) <> 'array' OR jsonb_array_length(_allocations) = 0 THEN
    RAISE EXCEPTION 'No bills were selected for this payment.';
  END IF;

  IF _request_id IS NOT NULL AND _org_id IS NOT NULL THEN
    SELECT bp.id, bp.journal_entry_id, bp.amount INTO v_existing
      FROM public.bill_payments bp
     WHERE bp.organization_id = _org_id
       AND (bp.client_request_id = _request_id OR bp.reference = _request_id)
     LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'bill_payment_id', v_existing.id,
        'journal_entry_id', v_existing.journal_entry_id,
        'sum_allocated', v_existing.amount,
        'excess_amount', 0,
        'bill_statuses', '[]'::jsonb,
        'idempotent_replay', true
      );
    END IF;
  END IF;

  SELECT array_agg((x->>'bill_id')::uuid) INTO v_bill_ids
    FROM jsonb_array_elements(_allocations) AS x
   WHERE COALESCE((x->>'amount')::numeric, 0) > 0;

  IF v_bill_ids IS NULL OR array_length(v_bill_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No bills with a positive allocation amount were provided.';
  END IF;

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(_allocations) AS x WHERE COALESCE((x->>'amount')::numeric, 0) <= 0) THEN
    RAISE EXCEPTION 'Allocation lines must have a positive amount.';
  END IF;

  PERFORM 1 FROM public.bills WHERE id = ANY(v_bill_ids) FOR UPDATE;

  IF (SELECT count(*) FROM public.bills WHERE id = ANY(v_bill_ids)) <> array_length(v_bill_ids, 1) THEN
    RAISE EXCEPTION 'One or more selected bills could not be found.';
  END IF;

  SELECT count(DISTINCT vendor_id), count(DISTINCT business_id),
         count(DISTINCT organization_id), count(DISTINCT COALESCE(currency, 'USD'))
    INTO v_distinct_vendor, v_distinct_business, v_distinct_org, v_distinct_currency
    FROM public.bills WHERE id = ANY(v_bill_ids);

  IF v_distinct_business > 1 OR v_distinct_org > 1 THEN
    RAISE EXCEPTION 'Selected bills belong to different companies and cannot be paid together.';
  END IF;
  IF v_distinct_vendor > 1 THEN
    RAISE EXCEPTION 'Selected bills belong to different vendors and cannot be paid together.';
  END IF;
  IF v_distinct_currency > 1 THEN
    RAISE EXCEPTION 'Selected bills are in different currencies and cannot be paid together.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.bills WHERE id = ANY(v_bill_ids) AND vendor_id IS DISTINCT FROM _vendor_id) THEN
    RAISE EXCEPTION 'One or more bills do not belong to vendor %', _vendor_id;
  END IF;

  IF (SELECT COALESCE(SUM((x->>'amount')::numeric), 0) FROM jsonb_array_elements(_allocations) AS x) > _total_amount + 0.005 THEN
    RAISE EXCEPTION 'Sum of allocations exceeds payment total.';
  END IF;

  SELECT name INTO v_vendor_name FROM public.contacts WHERE id = _vendor_id AND organization_id = _org_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Vendor not found'; END IF;

  INSERT INTO public.bill_payments
    (organization_id, business_id, bank_account_id, payment_date,
     amount, payment_method, reference, notes, created_by, branch_id,
     vendor_id, client_request_id)
  VALUES
    (_org_id, _business_id, _bank_account_id, _payment_date,
     _total_amount, _payment_method, _reference, _notes, _created_by, _branch_id,
     _vendor_id, _request_id)
  RETURNING id INTO v_bp_id;

  FOR v_alloc IN
    SELECT (x->>'bill_id')::uuid AS bill_id, (x->>'amount')::numeric AS amount
      FROM jsonb_array_elements(_allocations) AS x
  LOOP
    SELECT id, bill_number, total, COALESCE(amount_paid, 0) AS amount_paid, vendor_id
      INTO v_bill FROM public.bills WHERE id = v_alloc.bill_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Bill % not found', v_alloc.bill_id; END IF;
    IF v_bill.vendor_id IS DISTINCT FROM _vendor_id THEN
      RAISE EXCEPTION 'Bill % does not belong to vendor %', v_alloc.bill_id, _vendor_id;
    END IF;
    IF v_alloc.amount > (v_bill.total - v_bill.amount_paid) + 0.005 THEN
      RAISE EXCEPTION 'Allocation % exceeds open balance % on bill %',
        v_alloc.amount, (v_bill.total - v_bill.amount_paid), v_bill.bill_number;
    END IF;

    INSERT INTO public.bill_payment_allocations
      (bill_payment_id, bill_id, amount, source, created_by)
    VALUES (v_bp_id, v_alloc.bill_id, v_alloc.amount, 'rpc', _created_by);

    v_new_amount_paid := v_bill.amount_paid + v_alloc.amount;
    v_new_status := CASE WHEN v_new_amount_paid >= v_bill.total - 0.005 THEN 'paid' ELSE 'partial' END;

    UPDATE public.bills
       SET amount_paid = v_new_amount_paid, status = v_new_status::bill_status, updated_at = now()
     WHERE id = v_alloc.bill_id;

    v_sum_allocated := v_sum_allocated + v_alloc.amount;
    v_bill_statuses := v_bill_statuses || jsonb_build_object(
      'bill_id', v_alloc.bill_id, 'new_status', v_new_status, 'new_amount_paid', v_new_amount_paid);
  END LOOP;

  IF ABS(_total_amount - v_sum_allocated) > 0.005 THEN
    RAISE EXCEPTION 'Payment total % does not match the allocated amount %. Allocate the full amount, or record the excess as a vendor advance.',
      _total_amount, v_sum_allocated;
  END IF;

  v_je_id := public.post_journal_entry_atomic(
    _org_id, _business_id,
    public.generate_next_je_number(_org_id),
    _payment_date,
    'BPMT-' || v_bp_id::text,
    'Bill payment to ' || v_vendor_name,
    'bill_payment', v_bp_id, _created_by, false, false,
    jsonb_build_array(
      jsonb_build_object('account_id', _payable_account_id, 'debit', v_sum_allocated, 'credit', 0,
                         'description', 'AP reduction - ' || v_vendor_name, 'contact_id', _vendor_id),
      jsonb_build_object('account_id', _bank_account_id, 'debit', 0, 'credit', _total_amount,
                         'description', 'Bill payment to ' || v_vendor_name)
    ),
    NULL, NULL, NULL, _branch_id
  );

  UPDATE public.bill_payments SET journal_entry_id = v_je_id WHERE id = v_bp_id;

  IF _wht_rate IS NOT NULL AND _wht_rate > 0 AND _wht_account_id IS NOT NULL THEN
    v_wht_amount := ROUND(v_sum_allocated * (_wht_rate / 100.0), 2);
    IF v_wht_amount > 0 THEN
      v_wht_je_id := public.post_journal_entry_atomic(
        _org_id, _business_id,
        public.generate_next_je_number(_org_id),
        _payment_date,
        'WHT-' || v_bp_id::text,
        'Withholding tax on payment to ' || v_vendor_name || ' (' || _wht_rate || '%)',
        'bill_payment', v_bp_id, _created_by, false, false,
        jsonb_build_array(
          jsonb_build_object('account_id', _payable_account_id, 'debit', v_wht_amount, 'credit', 0,
                             'description', 'WHT on payment to ' || v_vendor_name || ' - additional AP reduction',
                             'contact_id', _vendor_id),
          jsonb_build_object('account_id', _wht_account_id, 'debit', 0, 'credit', v_wht_amount,
                             'description', 'WHT on payment to ' || v_vendor_name || ' - Withholding tax payable')
        ),
        NULL, NULL, 'wht', _branch_id
      );

      FOR v_alloc IN
        SELECT bpa.bill_id, bpa.amount FROM public.bill_payment_allocations bpa WHERE bpa.bill_payment_id = v_bp_id
      LOOP
        UPDATE public.bills
           SET amount_paid = LEAST(total, COALESCE(amount_paid, 0)
                                   + ROUND(v_alloc.amount / v_sum_allocated * v_wht_amount, 2)),
               status = CASE
                 WHEN COALESCE(amount_paid, 0) + ROUND(v_alloc.amount / v_sum_allocated * v_wht_amount, 2)
                      >= total - 0.005
                 THEN 'paid'::bill_status ELSE 'partial'::bill_status
               END,
               updated_at = now()
         WHERE id = v_alloc.bill_id;
      END LOOP;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'bill_payment_id', v_bp_id,
    'journal_entry_id', v_je_id,
    'wht_journal_entry_id', v_wht_je_id,
    'wht_amount', v_wht_amount,
    'sum_allocated', v_sum_allocated,
    'excess_amount', _total_amount - v_sum_allocated,
    'bill_statuses', v_bill_statuses
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_multi_bill_payment(uuid, uuid, uuid, jsonb, numeric, date, text, text, text, uuid, uuid, uuid, uuid, text, numeric, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_multi_bill_payment(uuid, uuid, uuid, jsonb, numeric, date, text, text, text, uuid, uuid, uuid, uuid, text, numeric, uuid) TO service_role;