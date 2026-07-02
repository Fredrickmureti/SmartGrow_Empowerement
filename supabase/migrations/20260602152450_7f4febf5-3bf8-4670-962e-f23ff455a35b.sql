-- S3c.1 — Harden record_multi_bill_payment + apply_vendor_credit_atomic,
-- repoint finance_ap_open_items and verify_company_isolation.

DROP FUNCTION IF EXISTS public.record_multi_bill_payment(
  uuid, uuid, uuid, jsonb, numeric, date, text, text, text, uuid, uuid, uuid, uuid
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
  _request_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_bp_id uuid;
  v_je_id uuid;
  v_je_number text;
  v_retry int := 0;
  v_max_retries int := 5;
  v_alloc record;
  v_bill record;
  v_sum_allocated numeric := 0;
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
    (organization_id, business_id, bill_id, bank_account_id, payment_date,
     amount, payment_method, reference, notes, created_by, branch_id)
  VALUES
    (_org_id, _business_id, NULL, _bank_account_id, _payment_date,
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

  RETURN jsonb_build_object(
    'bill_payment_id', v_bp_id,
    'journal_entry_id', v_je_id,
    'sum_allocated', v_sum_allocated,
    'excess_amount', _total_amount - v_sum_allocated,
    'bill_statuses', v_bill_statuses
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.record_multi_bill_payment(
  uuid, uuid, uuid, jsonb, numeric, date, text, text, text, uuid, uuid, uuid, uuid, text
) TO authenticated;

-- 2) apply_vendor_credit_atomic — explicit allocation row.
CREATE OR REPLACE FUNCTION public.apply_vendor_credit_atomic(
  p_vcn_id uuid, p_bill_id uuid, p_amount numeric, p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_vcn record; v_bill record;
  v_remaining_credit numeric; v_remaining_bill numeric;
  v_new_paid numeric; v_new_status text;
  v_app_id uuid; v_payment_id uuid;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount must be positive');
  END IF;

  SELECT id, organization_id, business_id, branch_id, vendor_id, total,
         COALESCE(amount_applied, 0) AS amount_applied, status, credit_note_number, currency
    INTO v_vcn FROM public.vendor_credit_notes WHERE id = p_vcn_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Vendor credit note not found'); END IF;

  SELECT id, organization_id, business_id, branch_id, vendor_id, total,
         COALESCE(amount_paid, 0) AS amount_paid, status, currency
    INTO v_bill FROM public.bills WHERE id = p_bill_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Bill not found'); END IF;

  IF v_vcn.organization_id <> v_bill.organization_id OR v_vcn.business_id <> v_bill.business_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'VCN and bill belong to different companies');
  END IF;
  IF v_vcn.vendor_id IS DISTINCT FROM v_bill.vendor_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'VCN vendor does not match bill vendor');
  END IF;

  v_remaining_credit := v_vcn.total - v_vcn.amount_applied;
  v_remaining_bill   := v_bill.total - v_bill.amount_paid;
  IF p_amount > v_remaining_credit + 0.001 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount exceeds remaining credit balance', 'remaining_credit', v_remaining_credit);
  END IF;
  IF p_amount > v_remaining_bill + 0.001 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount exceeds remaining bill balance', 'remaining_bill', v_remaining_bill);
  END IF;

  v_new_paid := v_bill.amount_paid + p_amount;
  v_new_status := CASE WHEN v_new_paid >= v_bill.total - 0.001 THEN 'paid' ELSE 'partial' END;

  INSERT INTO public.bill_payments (
    organization_id, business_id, branch_id, bill_id, payment_date,
    amount, payment_method, reference, notes, created_by
  ) VALUES (
    v_bill.organization_id, v_bill.business_id, v_bill.branch_id, NULL, CURRENT_DATE,
    p_amount, 'vendor_credit',
    'VCN ' || COALESCE(v_vcn.credit_note_number, v_vcn.id::text),
    'Vendor credit applied', p_user_id
  ) RETURNING id INTO v_payment_id;

  INSERT INTO public.bill_payment_allocations (bill_payment_id, bill_id, amount, source, created_by)
  VALUES (v_payment_id, v_bill.id, p_amount, 'rpc', p_user_id);

  INSERT INTO public.vendor_credit_note_applications (
    organization_id, business_id, credit_note_id, bill_id, amount, applied_by
  ) VALUES (
    v_vcn.organization_id, v_vcn.business_id, v_vcn.id, v_bill.id, p_amount, p_user_id
  ) RETURNING id INTO v_app_id;

  UPDATE public.bills
     SET amount_paid = v_new_paid, status = v_new_status::bill_status, updated_at = now()
   WHERE id = v_bill.id;

  UPDATE public.vendor_credit_notes
     SET amount_applied = amount_applied + p_amount,
         status = CASE WHEN amount_applied + p_amount >= total - 0.001 THEN 'applied' ELSE 'partial' END,
         updated_at = now()
   WHERE id = v_vcn.id;

  RETURN jsonb_build_object(
    'success', true, 'application_id', v_app_id, 'bill_payment_id', v_payment_id,
    'new_amount_paid', v_new_paid, 'new_bill_status', v_new_status, 'applied_amount', p_amount
  );
END$fn$;

-- 3) finance_ap_open_items — DROP + recreate on allocation table.
DROP VIEW IF EXISTS public.finance_ap_open_items;
CREATE VIEW public.finance_ap_open_items
WITH (security_invoker = true) AS
WITH paid AS (
  SELECT bpa.bill_id, SUM(bpa.amount)::numeric AS amount
    FROM public.bill_payment_allocations bpa GROUP BY bpa.bill_id
)
SELECT
  b.organization_id, b.business_id, b.branch_id,
  b.id AS document_id, b.bill_number AS document_number,
  b.vendor_id AS contact_id, b.bill_date AS document_date, b.due_date,
  b.total AS document_total,
  COALESCE(p.amount, 0)::numeric AS applied_amount,
  GREATEST(b.total - COALESCE(p.amount, 0), 0)::numeric AS residual_amount,
  b.status::text AS document_status,
  (SELECT je.id FROM public.journal_entries je
    WHERE je.source_type = 'bill' AND je.source_id = b.id AND je.status = 'posted'
    ORDER BY je.entry_date, je.created_at LIMIT 1) AS journal_entry_id
FROM public.bills b
LEFT JOIN paid p ON p.bill_id = b.id
WHERE b.status NOT IN ('draft','void')
  AND GREATEST(b.total - COALESCE(p.amount, 0), 0) > 0.01;

GRANT SELECT ON public.finance_ap_open_items TO authenticated;

-- 4) verify_company_isolation — DROP + CREATE (return shape changes).
DROP FUNCTION IF EXISTS public.verify_company_isolation();

CREATE FUNCTION public.verify_company_isolation()
RETURNS TABLE (
  table_name text, record_id uuid,
  expected_business_id uuid, actual_business_id uuid, detail text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT 'journal_entry_lines'::text, jel.id, je.business_id, jel.business_id,
         'JE line business mismatch with parent journal_entry'::text
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE jel.business_id IS DISTINCT FROM je.business_id

  UNION ALL
  SELECT 'bill_payment_allocations'::text, bpa.id, bp.business_id, bpa.business_id,
         'bill_payment_allocation business mismatch with parent bill_payment'::text
  FROM public.bill_payment_allocations bpa
  JOIN public.bill_payments bp ON bp.id = bpa.bill_payment_id
  WHERE bpa.business_id IS DISTINCT FROM bp.business_id

  UNION ALL
  SELECT 'bill_payment_allocations'::text, bpa.id, b.business_id, bpa.business_id,
         'bill_payment_allocation business mismatch with bill'::text
  FROM public.bill_payment_allocations bpa
  JOIN public.bills b ON b.id = bpa.bill_id
  WHERE bpa.business_id IS DISTINCT FROM b.business_id

  UNION ALL
  SELECT 'stock_movements'::text, sm.id, p.business_id, sm.business_id,
         'stock_movement business mismatch with product'::text
  FROM public.stock_movements sm
  JOIN public.products p ON p.id = sm.product_id
  WHERE sm.business_id IS DISTINCT FROM p.business_id

  UNION ALL
  SELECT 'pos_transactions'::text, pt.id, pr.business_id, pt.business_id,
         'pos_transaction business mismatch with register'::text
  FROM public.pos_transactions pt
  JOIN public.pos_registers pr ON pr.id = pt.register_id
  WHERE pt.business_id IS DISTINCT FROM pr.business_id

  UNION ALL
  SELECT 'invoices'::text, i.id, br.business_id, i.business_id,
         'invoice.branch_id belongs to a different business'::text
  FROM public.invoices i
  JOIN public.branches br ON br.id = i.branch_id
  WHERE i.branch_id IS NOT NULL AND br.business_id <> i.business_id;
$$;

REVOKE ALL ON FUNCTION public.verify_company_isolation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_company_isolation() TO authenticated;