DROP FUNCTION IF EXISTS public.record_multi_bill_payment(uuid,uuid,uuid,jsonb,numeric,date,text,text,text,uuid,uuid,uuid,uuid,text,numeric,uuid);

CREATE OR REPLACE FUNCTION public.record_multi_bill_payment(
  _org_id uuid, _business_id uuid, _vendor_id uuid, _allocations jsonb,
  _total_amount numeric, _payment_date date,
  _payment_method text DEFAULT 'bank_transfer'::text,
  _reference text DEFAULT NULL::text, _notes text DEFAULT NULL::text,
  _created_by uuid DEFAULT NULL::uuid, _bank_account_id uuid DEFAULT NULL::uuid,
  _payable_account_id uuid DEFAULT NULL::uuid, _branch_id uuid DEFAULT NULL::uuid,
  _request_id text DEFAULT NULL::text, _wht_rate numeric DEFAULT NULL::numeric,
  _wht_account_id uuid DEFAULT NULL::uuid, _credit_account_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_treasury_id uuid;
  v_credit_account_id uuid;
BEGIN
  -- Funding account resolution: treasury instrument (bank_accounts) and GL
  -- account (accounts) are DISTINCT id spaces. Never conflate them.
  v_credit_account_id := _credit_account_id;
  v_treasury_id := NULL;

  IF _bank_account_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.bank_accounts ba WHERE ba.id = _bank_account_id) THEN
      v_treasury_id := _bank_account_id;
      IF v_credit_account_id IS NULL THEN
        SELECT ba.account_id INTO v_credit_account_id
          FROM public.bank_accounts ba WHERE ba.id = _bank_account_id;
        IF v_credit_account_id IS NULL THEN
          RAISE EXCEPTION 'The selected bank account has no linked ledger account. Map it in Settings > Banking before paying bills.';
        END IF;
      END IF;
    ELSIF EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = _bank_account_id) THEN
      -- Legacy callers passed a GL account through _bank_account_id.
      v_credit_account_id := COALESCE(v_credit_account_id, _bank_account_id);
    ELSE
      RAISE EXCEPTION 'The selected cash/bank account could not be found.';
    END IF;
  END IF;

  IF v_credit_account_id IS NULL THEN
    RAISE EXCEPTION 'Bank/cash account is required for multi-bill payment.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = v_credit_account_id) THEN
    RAISE EXCEPTION 'The cash/bank ledger account for this payment does not exist.';
  END IF;

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
    (_org_id, _business_id, v_treasury_id, _payment_date,
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
      jsonb_build_object('account_id', v_credit_account_id, 'debit', 0, 'credit', _total_amount,
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
$function$;