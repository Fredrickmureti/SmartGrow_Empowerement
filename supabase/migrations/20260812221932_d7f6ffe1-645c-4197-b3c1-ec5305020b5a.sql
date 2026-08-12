-- ============================================================
-- Step 8: realized FX at settlement (AR + AP), base-currency posting
-- ============================================================

CREATE OR REPLACE FUNCTION public.resolve_fx_realized_account(p_business_id uuid, p_kind text)
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_org uuid;
BEGIN
  IF p_kind NOT IN ('gain', 'loss') THEN
    RAISE EXCEPTION 'Unknown FX account kind %', p_kind;
  END IF;

  SELECT account_id INTO v_id
    FROM public.default_accounts
   WHERE business_id = p_business_id
     AND purpose = 'fx_realized_' || p_kind
     AND branch_id IS NULL;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  SELECT organization_id INTO v_org FROM public.businesses WHERE id = p_business_id;

  SELECT id INTO v_id FROM public.accounts
   WHERE business_id = p_business_id AND organization_id = v_org
     AND is_active = true AND COALESCE(is_header, false) = false
     AND account_type = CASE WHEN p_kind = 'gain' THEN 'income'::account_type ELSE 'expense'::account_type END
     AND (LOWER(name) LIKE '%exchange%' OR LOWER(name) LIKE '%forex%' OR LOWER(name) LIKE '%fx %')
   ORDER BY code
   LIMIT 1;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'No realised exchange % account is configured. Map it under Settings > Default Accounts before settling foreign-currency documents.', p_kind
      USING ERRCODE = '23514';
  END IF;
  RETURN v_id;
END;
$$;

-- ------------------------------------------------------------
-- AP settlement
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_multi_bill_payment(
  _org_id uuid, _business_id uuid, _vendor_id uuid, _allocations jsonb, _total_amount numeric,
  _payment_date date, _payment_method text DEFAULT 'bank_transfer'::text, _reference text DEFAULT NULL::text,
  _notes text DEFAULT NULL::text, _created_by uuid DEFAULT NULL::uuid, _bank_account_id uuid DEFAULT NULL::uuid,
  _payable_account_id uuid DEFAULT NULL::uuid, _branch_id uuid DEFAULT NULL::uuid, _request_id text DEFAULT NULL::text,
  _wht_rate numeric DEFAULT NULL::numeric, _wht_account_id uuid DEFAULT NULL::uuid,
  _credit_account_id uuid DEFAULT NULL::uuid, _exchange_rate numeric DEFAULT NULL::numeric)
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
  v_business_id uuid;
  v_currency text;
  v_base_currency text;
  v_settle_rate numeric;
  v_doc_rate numeric;
  v_ap_base numeric := 0;
  v_bank_base numeric;
  v_fx_delta numeric := 0;
  v_lines jsonb;
BEGIN
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
         count(DISTINCT organization_id), count(DISTINCT upper(currency))
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

  v_business_id := _business_id;
  IF v_business_id IS NULL THEN
    SELECT DISTINCT business_id INTO v_business_id FROM public.bills WHERE id = ANY(v_bill_ids);
  END IF;
  IF v_business_id IS NULL THEN
    RAISE EXCEPTION 'This payment is not linked to a company. Select a company and try again.';
  END IF;

  SELECT upper(currency) INTO v_currency FROM public.bills WHERE id = ANY(v_bill_ids) LIMIT 1;
  SELECT upper(base_currency) INTO v_base_currency FROM public.businesses WHERE id = v_business_id;

  -- Settlement rate: caller-supplied, else the canonical rate book. Never invented.
  IF v_currency IS NULL OR v_currency = v_base_currency THEN
    v_settle_rate := 1;
  ELSE
    v_settle_rate := COALESCE(_exchange_rate,
      public.resolve_exchange_rate(_org_id, v_business_id, v_currency, _payment_date));
    IF v_settle_rate IS NULL OR v_settle_rate <= 0 THEN
      RAISE EXCEPTION 'No exchange rate on file for % -> % on %. Add one in Currency settings before recording this payment.',
        v_currency, v_base_currency, _payment_date USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT name INTO v_vendor_name FROM public.contacts WHERE id = _vendor_id AND organization_id = _org_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Vendor not found'; END IF;

  INSERT INTO public.bill_payments
    (organization_id, business_id, bank_account_id, payment_date,
     amount, payment_method, reference, notes, created_by, branch_id,
     vendor_id, client_request_id, currency_rate)
  VALUES
    (_org_id, v_business_id, v_treasury_id, _payment_date,
     _total_amount, _payment_method, _reference, _notes, _created_by, _branch_id,
     _vendor_id, _request_id, v_settle_rate)
  RETURNING id INTO v_bp_id;

  FOR v_alloc IN
    SELECT (x->>'bill_id')::uuid AS bill_id, (x->>'amount')::numeric AS amount
      FROM jsonb_array_elements(_allocations) AS x
  LOOP
    SELECT id, bill_number, total, COALESCE(amount_paid, 0) AS amount_paid, vendor_id,
           COALESCE(currency_rate, 1) AS currency_rate
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
    -- Each bill is relieved at the rate it was booked at.
    v_ap_base := v_ap_base + ROUND(v_alloc.amount * v_bill.currency_rate, 2);
    v_bill_statuses := v_bill_statuses || jsonb_build_object(
      'bill_id', v_alloc.bill_id, 'new_status', v_new_status, 'new_amount_paid', v_new_amount_paid);
  END LOOP;

  IF ABS(_total_amount - v_sum_allocated) > 0.005 THEN
    RAISE EXCEPTION 'Payment total % does not match the allocated amount %. Allocate the full amount, or record the excess as a vendor advance.',
      _total_amount, v_sum_allocated;
  END IF;

  v_doc_rate := CASE WHEN v_sum_allocated > 0 THEN v_ap_base / v_sum_allocated ELSE 1 END;
  v_bank_base := ROUND(_total_amount * v_settle_rate, 2);
  v_fx_delta := ROUND(v_bank_base - v_ap_base, 2);

  v_lines := jsonb_build_array(
    jsonb_build_object('account_id', _payable_account_id, 'debit', v_ap_base, 'credit', 0,
                       'description', 'AP reduction - ' || v_vendor_name, 'contact_id', _vendor_id),
    jsonb_build_object('account_id', v_credit_account_id, 'debit', 0, 'credit', v_bank_base,
                       'description', 'Bill payment to ' || v_vendor_name)
  );

  IF v_fx_delta > 0.005 THEN
    -- Paid more base currency than the liability was booked at: realised loss.
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.resolve_fx_realized_account(v_business_id, 'loss'),
      'debit', v_fx_delta, 'credit', 0,
      'description', 'Realised FX loss on settlement of ' || v_currency || ' bills'));
  ELSIF v_fx_delta < -0.005 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.resolve_fx_realized_account(v_business_id, 'gain'),
      'debit', 0, 'credit', ABS(v_fx_delta),
      'description', 'Realised FX gain on settlement of ' || v_currency || ' bills'));
  END IF;

  v_je_id := public.post_journal_entry_atomic(
    _org_id, v_business_id,
    public.generate_next_je_number(_org_id, v_business_id),
    _payment_date,
    'BPMT-' || v_bp_id::text,
    'Bill payment to ' || v_vendor_name,
    'bill_payment', v_bp_id, _created_by, false, false,
    v_lines,
    v_currency, v_settle_rate, NULL, _branch_id
  );

  UPDATE public.bill_payments SET journal_entry_id = v_je_id WHERE id = v_bp_id;

  IF _wht_rate IS NOT NULL AND _wht_rate > 0 AND _wht_account_id IS NOT NULL THEN
    v_wht_amount := ROUND(v_sum_allocated * (_wht_rate / 100.0), 2);
    IF v_wht_amount > 0 THEN
      v_wht_je_id := public.post_journal_entry_atomic(
        _org_id, v_business_id,
        public.generate_next_je_number(_org_id, v_business_id),
        _payment_date,
        'WHT-' || v_bp_id::text,
        'Withholding tax on payment to ' || v_vendor_name || ' (' || _wht_rate || '%)',
        'bill_payment', v_bp_id, _created_by, false, false,
        jsonb_build_array(
          jsonb_build_object('account_id', _payable_account_id,
                             'debit', ROUND(v_wht_amount * v_doc_rate, 2), 'credit', 0,
                             'description', 'WHT on payment to ' || v_vendor_name || ' - additional AP reduction',
                             'contact_id', _vendor_id),
          jsonb_build_object('account_id', _wht_account_id, 'debit', 0,
                             'credit', ROUND(v_wht_amount * v_doc_rate, 2),
                             'description', 'WHT on payment to ' || v_vendor_name || ' - Withholding tax payable')
        ),
        v_currency, v_doc_rate, 'wht', _branch_id
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
    'currency', v_currency,
    'exchange_rate', v_settle_rate,
    'realized_fx', -v_fx_delta,
    'bill_statuses', v_bill_statuses
  );
END;
$function$;

-- ------------------------------------------------------------
-- AR settlement
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_multi_invoice_payment(
  _org_id uuid, _business_id uuid, _contact_id uuid, _allocations jsonb, _total_amount numeric,
  _payment_date date, _payment_method text DEFAULT 'bank_transfer'::text, _reference text DEFAULT NULL::text,
  _notes text DEFAULT NULL::text, _receipt_number text DEFAULT NULL::text, _created_by uuid DEFAULT NULL::uuid,
  _deposit_account_id uuid DEFAULT NULL::uuid, _receivable_account_id uuid DEFAULT NULL::uuid,
  _customer_credit_account_id uuid DEFAULT NULL::uuid, _branch_id uuid DEFAULT NULL::uuid,
  _exchange_rate numeric DEFAULT NULL::numeric, _request_id text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_payment_id uuid;
  v_je_id uuid;
  v_je_number text;
  v_alloc record;
  v_invoice record;
  v_sum_allocated numeric := 0;
  v_excess numeric := 0;
  v_new_amount_paid numeric;
  v_new_status invoice_status;
  v_invoice_statuses jsonb := '[]'::jsonb;
  v_contact_name text;
  v_currency text;
  v_base_currency text;
  v_alloc_count int := 0;
  v_invoice_ids uuid[];
  v_distinct_business int;
  v_distinct_org int;
  v_distinct_contact int;
  v_distinct_currency int;
  v_distinct_nonnull_branch int;
  v_has_null_branch boolean;
  v_resolved_business uuid;
  v_resolved_org uuid;
  v_resolved_contact uuid;
  v_resolved_branch uuid;
  v_account_ok int;
  v_existing_payment record;
  v_lines jsonb;
  v_settle_rate numeric;
  v_ar_base numeric := 0;
  v_deposit_base numeric;
  v_excess_base numeric := 0;
  v_fx_delta numeric := 0;
BEGIN
  IF _total_amount <= 0 THEN RAISE EXCEPTION 'Payment amount must be positive.'; END IF;
  IF _deposit_account_id IS NULL THEN
    RAISE EXCEPTION 'Deposit account is required. Select the GL account that will receive these funds.';
  END IF;
  IF _receivable_account_id IS NULL THEN
    RAISE EXCEPTION 'Accounts Receivable account is not configured. Map it under Settings > Default Accounts.';
  END IF;
  IF _allocations IS NULL OR jsonb_typeof(_allocations) <> 'array' OR jsonb_array_length(_allocations) = 0 THEN
    RAISE EXCEPTION 'No invoices were selected for this payment.';
  END IF;

  IF _request_id IS NOT NULL AND _org_id IS NOT NULL THEN
    SELECT p.id, p.journal_entry_id, p.amount, p.outstanding_amount, p.applied_amount
      INTO v_existing_payment
      FROM payments p
     WHERE p.organization_id = _org_id AND p.client_request_id = _request_id
     LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'payment_id', v_existing_payment.id,
        'journal_entry_id', v_existing_payment.journal_entry_id,
        'allocated', v_existing_payment.applied_amount,
        'applied_amount', v_existing_payment.applied_amount,
        'excess', v_existing_payment.outstanding_amount,
        'excess_amount', v_existing_payment.outstanding_amount,
        'outstanding_amount', v_existing_payment.outstanding_amount,
        'credit_note_id', NULL,
        'invoice_statuses', '[]'::jsonb,
        'idempotent_replay', true
      );
    END IF;
  END IF;

  IF _receipt_number IS NOT NULL AND _org_id IS NOT NULL THEN
    SELECT p.id, p.journal_entry_id, p.amount, p.outstanding_amount, p.applied_amount
      INTO v_existing_payment
      FROM payments p
     WHERE p.organization_id = _org_id AND p.receipt_number = _receipt_number
     LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'payment_id', v_existing_payment.id,
        'journal_entry_id', v_existing_payment.journal_entry_id,
        'allocated', v_existing_payment.applied_amount,
        'excess', v_existing_payment.outstanding_amount,
        'excess_amount', v_existing_payment.outstanding_amount,
        'credit_note_id', NULL,
        'invoice_statuses', '[]'::jsonb,
        'idempotent_replay', true
      );
    END IF;
  END IF;

  SELECT array_agg((x->>'invoice_id')::uuid)
    INTO v_invoice_ids
    FROM jsonb_array_elements(_allocations) AS x
   WHERE COALESCE((x->>'amount')::numeric, 0) > 0;

  IF v_invoice_ids IS NULL OR array_length(v_invoice_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No invoices with a positive allocation amount were provided.';
  END IF;

  PERFORM 1 FROM invoices WHERE id = ANY(v_invoice_ids) FOR UPDATE;

  IF (SELECT count(*) FROM invoices WHERE id = ANY(v_invoice_ids)) <> array_length(v_invoice_ids, 1) THEN
    RAISE EXCEPTION 'One or more selected invoices could not be found. They may have been deleted.';
  END IF;

  SELECT count(DISTINCT business_id), count(DISTINCT organization_id),
         count(DISTINCT contact_id), count(DISTINCT upper(currency)),
         count(DISTINCT branch_id), bool_or(branch_id IS NULL)
    INTO v_distinct_business, v_distinct_org, v_distinct_contact, v_distinct_currency,
         v_distinct_nonnull_branch, v_has_null_branch
    FROM invoices WHERE id = ANY(v_invoice_ids);

  IF v_distinct_business > 1 OR v_distinct_org > 1 THEN
    RAISE EXCEPTION 'Selected invoices belong to different companies and cannot be paid together.';
  END IF;
  IF v_distinct_contact > 1 THEN
    RAISE EXCEPTION 'Selected invoices belong to different customers and cannot be paid together.';
  END IF;
  IF v_distinct_currency > 1 THEN
    RAISE EXCEPTION 'Selected invoices use different currencies and cannot be paid together.';
  END IF;
  IF v_distinct_nonnull_branch > 1 OR (v_distinct_nonnull_branch = 1 AND v_has_null_branch) THEN
    RAISE EXCEPTION 'Selected invoices span different branch scopes. Record separate payments per branch/HQ scope.';
  END IF;

  SELECT business_id, organization_id, contact_id, upper(currency)
    INTO v_resolved_business, v_resolved_org, v_resolved_contact, v_currency
    FROM invoices WHERE id = ANY(v_invoice_ids) LIMIT 1;

  IF v_distinct_nonnull_branch = 1 THEN
    SELECT DISTINCT branch_id INTO v_resolved_branch
      FROM invoices WHERE id = ANY(v_invoice_ids) AND branch_id IS NOT NULL;
  ELSE
    v_resolved_branch := NULL;
  END IF;

  IF _org_id IS NOT NULL AND _org_id <> v_resolved_org THEN
    RAISE EXCEPTION 'Selected invoices do not belong to the active workspace.';
  END IF;
  IF _business_id IS NOT NULL AND _business_id <> v_resolved_business THEN
    RAISE EXCEPTION 'Selected invoices do not belong to the active company.';
  END IF;
  IF _contact_id IS NOT NULL AND _contact_id <> v_resolved_contact THEN
    RAISE EXCEPTION 'Payment customer does not match selected invoices.';
  END IF;
  IF _branch_id IS NOT NULL AND v_resolved_branch IS NOT NULL AND _branch_id <> v_resolved_branch THEN
    RAISE EXCEPTION 'Selected invoices belong to a different branch than the active branch.';
  END IF;

  _org_id := v_resolved_org;
  _business_id := v_resolved_business;
  _contact_id := v_resolved_contact;
  _branch_id := COALESCE(_branch_id, v_resolved_branch);

  SELECT upper(base_currency) INTO v_base_currency FROM businesses WHERE id = _business_id;

  IF _exchange_rate IS NOT NULL AND _exchange_rate <= 0 THEN
    RAISE EXCEPTION 'Exchange rate must be positive.';
  END IF;

  IF v_currency IS NULL OR v_currency = v_base_currency THEN
    v_settle_rate := 1;
  ELSE
    v_settle_rate := COALESCE(_exchange_rate,
      public.resolve_exchange_rate(_org_id, _business_id, v_currency, _payment_date));
    IF v_settle_rate IS NULL OR v_settle_rate <= 0 THEN
      RAISE EXCEPTION 'No exchange rate on file for % -> % on %. Add one in Currency settings before recording this receipt.',
        v_currency, v_base_currency, _payment_date USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT name INTO v_contact_name
    FROM contacts
   WHERE id = _contact_id AND organization_id = _org_id
     AND (business_id = _business_id OR business_id IS NULL);
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found in the active workspace/company.'; END IF;

  IF _branch_id IS NOT NULL THEN
    PERFORM 1 FROM branches
     WHERE id = _branch_id AND organization_id = _org_id AND business_id = _business_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Selected branch does not belong to the active company.'; END IF;
  END IF;

  SELECT count(*) INTO v_account_ok
    FROM accounts WHERE id = _deposit_account_id
     AND organization_id = _org_id AND business_id = _business_id
     AND account_type = 'asset'::account_type AND COALESCE(is_header, false) = false;
  IF v_account_ok = 0 THEN
    RAISE EXCEPTION 'Deposit account must be a posting asset account in the active company.';
  END IF;

  SELECT count(*) INTO v_account_ok
    FROM accounts WHERE id = _receivable_account_id
     AND organization_id = _org_id AND business_id = _business_id
     AND account_type = 'asset'::account_type AND COALESCE(is_header, false) = false;
  IF v_account_ok = 0 THEN
    RAISE EXCEPTION 'Accounts Receivable account must be a posting asset account in the active company.';
  END IF;

  BEGIN
    INSERT INTO payments (
      organization_id, business_id, branch_id, contact_id, amount,
      outstanding_amount, applied_amount,
      payment_date, payment_method, reference, notes, receipt_number, created_by,
      deposit_account_id, client_request_id
    ) VALUES (
      _org_id, _business_id, _branch_id, _contact_id, _total_amount,
      _total_amount, 0,
      _payment_date, _payment_method::payment_method, _reference, _notes, _receipt_number, _created_by,
      _deposit_account_id, _request_id
    ) RETURNING id INTO v_payment_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT p.id, p.journal_entry_id, p.outstanding_amount, p.applied_amount
      INTO v_existing_payment
      FROM payments p
     WHERE p.organization_id = _org_id AND p.client_request_id = _request_id
     LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'payment_id', v_existing_payment.id,
        'journal_entry_id', v_existing_payment.journal_entry_id,
        'allocated', v_existing_payment.applied_amount,
        'applied_amount', v_existing_payment.applied_amount,
        'excess', v_existing_payment.outstanding_amount,
        'excess_amount', v_existing_payment.outstanding_amount,
        'outstanding_amount', v_existing_payment.outstanding_amount,
        'credit_note_id', NULL,
        'invoice_statuses', '[]'::jsonb,
        'idempotent_replay', true
      );
    END IF;
    RAISE;
  END;

  FOR v_alloc IN
    SELECT (x->>'invoice_id')::uuid AS invoice_id, (x->>'amount')::numeric AS amount
      FROM jsonb_array_elements(_allocations) AS x
  LOOP
    IF v_alloc.amount IS NULL OR v_alloc.amount <= 0 THEN CONTINUE; END IF;

    SELECT id, invoice_number, total, COALESCE(amount_paid, 0) AS amount_paid,
           status, branch_id, journal_entry_id, COALESCE(exchange_rate, 1) AS exchange_rate
      INTO v_invoice FROM invoices WHERE id = v_alloc.invoice_id;

    IF v_invoice.status::text IN ('paid','void','voided','cancelled') THEN
      RAISE EXCEPTION 'Invoice % is already % and cannot receive a payment.', v_invoice.invoice_number, v_invoice.status;
    END IF;
    IF v_invoice.journal_entry_id IS NULL THEN
      RAISE EXCEPTION 'Invoice % has no posted journal entry. Payments can only settle posted invoices.', v_invoice.invoice_number;
    END IF;
    IF v_alloc.amount > (v_invoice.total - v_invoice.amount_paid) + 0.000001 THEN
      RAISE EXCEPTION 'Allocation of % to invoice % exceeds its outstanding balance of %.',
        v_alloc.amount, v_invoice.invoice_number, (v_invoice.total - v_invoice.amount_paid);
    END IF;

    INSERT INTO payment_allocations (payment_id, invoice_id, amount, branch_id)
    VALUES (v_payment_id, v_alloc.invoice_id, v_alloc.amount, COALESCE(v_invoice.branch_id, _branch_id));

    v_new_amount_paid := v_invoice.amount_paid + v_alloc.amount;
    IF v_new_amount_paid >= v_invoice.total - 0.000001 THEN
      v_new_status := 'paid'::invoice_status;
    ELSE
      v_new_status := 'partial'::invoice_status;
    END IF;

    UPDATE invoices
       SET amount_paid = v_new_amount_paid, status = v_new_status, updated_at = now()
     WHERE id = v_alloc.invoice_id;

    v_sum_allocated := v_sum_allocated + v_alloc.amount;
    -- Each invoice is relieved at the rate it was issued at.
    v_ar_base := v_ar_base + ROUND(v_alloc.amount * v_invoice.exchange_rate, 2);
    v_alloc_count := v_alloc_count + 1;

    v_invoice_statuses := v_invoice_statuses || jsonb_build_object(
      'invoice_id', v_alloc.invoice_id,
      'new_status', v_new_status,
      'new_amount_paid', v_new_amount_paid
    );
  END LOOP;

  IF v_alloc_count = 0 THEN
    RAISE EXCEPTION 'No invoices with a positive allocation amount were provided.';
  END IF;

  v_excess := _total_amount - v_sum_allocated;
  IF v_excess < -0.000001 THEN
    RAISE EXCEPTION 'Allocation total (%) exceeds payment amount (%).', v_sum_allocated, _total_amount;
  END IF;
  IF v_excess < 0 THEN v_excess := 0; END IF;

  IF v_excess > 0 THEN
    IF _customer_credit_account_id IS NULL THEN
      RAISE EXCEPTION 'Overpayment of % cannot be processed: Customer Deposits account is not configured.', v_excess;
    END IF;
    SELECT count(*) INTO v_account_ok
      FROM accounts WHERE id = _customer_credit_account_id
       AND organization_id = _org_id AND business_id = _business_id
       AND account_type = 'liability'::account_type AND COALESCE(is_header, false) = false;
    IF v_account_ok = 0 THEN
      RAISE EXCEPTION 'Customer Deposits account must be a posting liability account in the active company.';
    END IF;
  END IF;

  UPDATE payments
     SET applied_amount = v_sum_allocated, outstanding_amount = v_excess
   WHERE id = v_payment_id;

  v_deposit_base := ROUND(_total_amount * v_settle_rate, 2);
  v_excess_base := ROUND(v_excess * v_settle_rate, 2);
  v_fx_delta := ROUND(v_deposit_base - v_ar_base - v_excess_base, 2);

  v_lines := jsonb_build_array(
    jsonb_build_object('account_id', _deposit_account_id, 'debit', v_deposit_base, 'credit', 0,
      'description', 'Payment received from ' || v_contact_name, 'contact_id', _contact_id),
    jsonb_build_object('account_id', _receivable_account_id, 'debit', 0, 'credit', v_ar_base,
      'description', 'Allocated to ' || v_alloc_count || ' invoice(s)', 'contact_id', _contact_id)
  );
  IF v_excess > 0 THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account_id', _customer_credit_account_id, 'debit', 0, 'credit', v_excess_base,
        'description', 'Customer deposit / overpayment', 'contact_id', _contact_id)
    );
  END IF;

  IF v_fx_delta > 0.005 THEN
    -- Received more base currency than the receivable was booked at: realised gain.
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.resolve_fx_realized_account(_business_id, 'gain'),
      'debit', 0, 'credit', v_fx_delta,
      'description', 'Realised FX gain on settlement of ' || v_currency || ' invoices'));
  ELSIF v_fx_delta < -0.005 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.resolve_fx_realized_account(_business_id, 'loss'),
      'debit', ABS(v_fx_delta), 'credit', 0,
      'description', 'Realised FX loss on settlement of ' || v_currency || ' invoices'));
  END IF;

  v_je_number := generate_next_je_number(_org_id, _business_id);
  v_je_id := post_journal_entry_atomic(
    _org_id, _business_id,
    v_je_number, _payment_date,
    'PMT-' || COALESCE(_receipt_number, v_payment_id::text),
    'Payment from ' || v_contact_name,
    'payment', v_payment_id, _created_by,
    false, false,
    v_lines, v_currency,
    v_settle_rate,
    NULL, _branch_id
  );

  UPDATE payments SET journal_entry_id = v_je_id WHERE id = v_payment_id;

  RETURN jsonb_build_object(
    'payment_id', v_payment_id,
    'journal_entry_id', v_je_id,
    'journal_entry_number', v_je_number,
    'currency', v_currency,
    'exchange_rate', v_settle_rate,
    'realized_fx', v_fx_delta,
    'allocated', v_sum_allocated,
    'applied_amount', v_sum_allocated,
    'excess', v_excess,
    'excess_amount', v_excess,
    'outstanding_amount', v_excess,
    'credit_note_id', NULL,
    'invoice_statuses', v_invoice_statuses
  );
END;
$function$;