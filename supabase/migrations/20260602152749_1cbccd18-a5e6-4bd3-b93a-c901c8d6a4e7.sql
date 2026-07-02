-- S3c.2 — Add WHT to record_multi_bill_payment + drop legacy bill_id.

DROP FUNCTION IF EXISTS public.record_multi_bill_payment(
  uuid, uuid, uuid, jsonb, numeric, date, text, text, text, uuid, uuid, uuid, uuid, text
);

CREATE OR REPLACE FUNCTION public.record_multi_bill_payment(
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
  _wht_rate numeric DEFAULT 0,
  _wht_account_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_bp_id uuid;
  v_je_id uuid;
  v_wht_je_id uuid;
  v_je_number text;
  v_retry int := 0;
  v_max_retries int := 5;
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
     WHERE bp.organization_id = _org_id AND bp.reference = _request_id
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
     amount, payment_method, reference, notes, created_by, branch_id)
  VALUES
    (_org_id, _business_id, _bank_account_id, _payment_date,
     _total_amount, _payment_method, COALESCE(_reference, _request_id), _notes, _created_by, _branch_id)
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

  -- Primary payment JE: Dr AP / Cr Bank
  LOOP
    BEGIN
      v_je_number := public.generate_next_je_number(_org_id);
      INSERT INTO public.journal_entries
        (organization_id, business_id, entry_number, entry_date, reference, description,
         source_type, source_id, status, created_by, branch_id)
      VALUES
        (_org_id, _business_id, v_je_number, _payment_date,
         'BPMT-' || v_bp_id::text, 'Bill payment to ' || v_vendor_name,
         'bill_payment', v_bp_id, 'posted', _created_by, _branch_id)
      RETURNING id INTO v_je_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_retry := v_retry + 1;
      IF v_retry >= v_max_retries THEN
        RAISE EXCEPTION 'Could not generate unique JE number after % retries', v_max_retries;
      END IF;
    END;
  END LOOP;

  IF v_sum_allocated > 0 THEN
    INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, debit, credit, description, branch_id)
    VALUES (v_je_id, _payable_account_id, v_sum_allocated, 0, 'AP reduction - ' || v_vendor_name, _branch_id);
  END IF;
  INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, debit, credit, description, branch_id)
  VALUES (v_je_id, _bank_account_id, 0, _total_amount, 'Bill payment to ' || v_vendor_name, _branch_id);

  UPDATE public.bill_payments SET journal_entry_id = v_je_id WHERE id = v_bp_id;

  -- Optional WHT JE: Dr AP (extra reduction) / Cr WHT payable; bumps each
  -- allocated bill's amount_paid proportionally so the same legacy behaviour
  -- ("bill considered paid once payment + WHT cover the total") is preserved.
  IF _wht_rate IS NOT NULL AND _wht_rate > 0 AND _wht_account_id IS NOT NULL THEN
    v_wht_amount := ROUND(v_sum_allocated * (_wht_rate / 100.0), 2);
    IF v_wht_amount > 0 THEN
      v_retry := 0;
      LOOP
        BEGIN
          v_je_number := public.generate_next_je_number(_org_id);
          INSERT INTO public.journal_entries
            (organization_id, business_id, entry_number, entry_date,
             reference, description, source_type, source_id, source_subtype,
             status, created_by, branch_id)
          VALUES
            (_org_id, _business_id, v_je_number, _payment_date,
             'WHT-' || v_bp_id::text,
             'Withholding tax on payment to ' || v_vendor_name || ' (' || _wht_rate || '%)',
             'bill_payment', v_bp_id, 'wht', 'posted', _created_by, _branch_id)
          RETURNING id INTO v_wht_je_id;
          EXIT;
        EXCEPTION WHEN unique_violation THEN
          v_retry := v_retry + 1;
          IF v_retry >= v_max_retries THEN
            RAISE EXCEPTION 'Could not generate unique WHT JE number after % retries', v_max_retries;
          END IF;
        END;
      END LOOP;

      INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, debit, credit, description, branch_id)
      VALUES (v_wht_je_id, _payable_account_id, v_wht_amount, 0,
              'WHT on payment to ' || v_vendor_name || ' - additional AP reduction', _branch_id);
      INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, debit, credit, description, branch_id)
      VALUES (v_wht_je_id, _wht_account_id, 0, v_wht_amount,
              'WHT on payment to ' || v_vendor_name || ' - Withholding tax payable', _branch_id);

      -- Pro-rate WHT bump across each allocated bill.
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

GRANT EXECUTE ON FUNCTION public.record_multi_bill_payment(
  uuid, uuid, uuid, jsonb, numeric, date, text, text, text, uuid, uuid, uuid, uuid, text, numeric, uuid
) TO authenticated;

-- Drop legacy plumbing tied to bill_payments.bill_id.
DROP TRIGGER IF EXISTS trg_auto_bill_payment_allocation ON public.bill_payments;
DROP FUNCTION IF EXISTS public.auto_create_bill_payment_allocation();

-- The branch-cascade trigger reads NEW.bill_id; with multi-bill payments
-- branch must come from the caller (or the parent payment header).
DROP TRIGGER IF EXISTS trg_cascade_branch_bill_payments ON public.bill_payments;

-- The consistency trigger on allocations still joins bp.bill_id to derive
-- vendor — rewrite it to derive vendor directly from the allocation's bill.
CREATE OR REPLACE FUNCTION public.check_bill_payment_allocation_consistency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  bp_business uuid; bp_org uuid; bp_branch uuid;
  bl_vendor uuid; bl_business uuid; bl_org uuid;
  bp_existing_vendor uuid;
BEGIN
  SELECT bp.organization_id, bp.business_id, bp.branch_id
    INTO bp_org, bp_business, bp_branch
    FROM public.bill_payments bp
    WHERE bp.id = NEW.bill_payment_id;

  SELECT vendor_id, business_id, organization_id
    INTO bl_vendor, bl_business, bl_org
    FROM public.bills WHERE id = NEW.bill_id;

  IF bl_org IS DISTINCT FROM bp_org THEN
    RAISE EXCEPTION 'Bill payment allocation rejected: bill and payment belong to different workspaces.'
      USING ERRCODE = '23514';
  END IF;
  IF bl_business IS DISTINCT FROM bp_business THEN
    RAISE EXCEPTION 'Bill payment allocation rejected: bill and payment belong to different companies.'
      USING ERRCODE = '23514';
  END IF;

  -- All allocations on a single payment must point at bills of the same vendor.
  SELECT b2.vendor_id INTO bp_existing_vendor
    FROM public.bill_payment_allocations bpa2
    JOIN public.bills b2 ON b2.id = bpa2.bill_id
   WHERE bpa2.bill_payment_id = NEW.bill_payment_id
     AND bpa2.id IS DISTINCT FROM NEW.id
   LIMIT 1;
  IF bp_existing_vendor IS NOT NULL AND bp_existing_vendor IS DISTINCT FROM bl_vendor THEN
    RAISE EXCEPTION 'Bill payment allocation rejected: all allocations on a payment must share one vendor.'
      USING ERRCODE = '23514';
  END IF;

  NEW.organization_id := bp_org;
  NEW.business_id     := bp_business;
  NEW.branch_id       := COALESCE(NEW.branch_id, bp_branch);
  RETURN NEW;
END $$;

-- Drop the column.
ALTER TABLE public.bill_payments DROP COLUMN IF EXISTS bill_id;