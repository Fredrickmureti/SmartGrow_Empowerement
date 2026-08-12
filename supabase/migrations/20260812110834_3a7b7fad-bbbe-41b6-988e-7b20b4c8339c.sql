-- The lifecycle emitter keys outbox rows on (credit note, state, row_version).
-- Applying a credit note did not advance row_version, so a second partial
-- application produced an identical idempotency key to the first and was
-- silently swallowed by ON CONFLICT DO NOTHING. Bumping row_version on each
-- application makes every application a distinct, durably emitted event and
-- also keeps optimistic-concurrency readers honest.
CREATE OR REPLACE FUNCTION public.apply_vendor_credit_to_bill_atomic(
  _org_id uuid, _business_id uuid, _vendor_credit_note_id uuid, _bill_id uuid,
  _amount numeric, _applied_by uuid DEFAULT NULL::uuid, _notes text DEFAULT NULL::text,
  _branch_id uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_vcn public.vendor_credit_notes%ROWTYPE;
  v_bill public.bills%ROWTYPE;
  v_available numeric; v_bill_balance numeric;
  v_balance_id uuid; v_je_id uuid; v_branch uuid;
  v_ap uuid; v_credit_asset uuid; v_actor uuid := COALESCE(_applied_by, auth.uid());
  v_new_paid numeric;
BEGIN
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Application amount must be positive'; END IF;

  SELECT * INTO v_vcn FROM public.vendor_credit_notes
   WHERE id = _vendor_credit_note_id AND organization_id = _org_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Vendor credit note not found'; END IF;
  IF v_vcn.business_id IS DISTINCT FROM _business_id THEN
    RAISE EXCEPTION 'Vendor credit note business mismatch';
  END IF;
  IF NOT public.user_can_access_business(auth.uid(), _business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', _business_id USING ERRCODE = '42501';
  END IF;
  IF v_vcn.accounting_status <> 'posted' THEN
    RAISE EXCEPTION 'Only a posted vendor credit note can be applied (accounting status: %)',
      v_vcn.accounting_status;
  END IF;
  IF v_vcn.commercial_status IN ('cancelled','rejected') THEN
    RAISE EXCEPTION 'A % vendor credit note cannot be applied', v_vcn.commercial_status;
  END IF;
  -- Row-level SoD: whoever created the credit note cannot also spend it.
  IF v_vcn.created_by IS NOT NULL AND v_vcn.created_by = v_actor THEN
    RAISE EXCEPTION 'SoD violation: the user who raised this credit note cannot apply it';
  END IF;

  SELECT * INTO v_bill FROM public.bills WHERE id = _bill_id AND organization_id = _org_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bill not found'; END IF;
  IF v_bill.business_id IS DISTINCT FROM _business_id THEN RAISE EXCEPTION 'Bill business mismatch'; END IF;
  IF v_bill.vendor_id IS DISTINCT FROM v_vcn.vendor_id THEN
    RAISE EXCEPTION 'Vendor credit may only be applied to the same vendor''s bills';
  END IF;

  v_branch := COALESCE(v_bill.branch_id, v_vcn.branch_id, _branch_id);

  v_balance_id := public.vendor_credit_balance_id(_org_id, _business_id, v_vcn.vendor_id, v_vcn.currency);
  SELECT balance INTO v_available FROM public.vendor_credit_balances WHERE id = v_balance_id;
  IF _amount > COALESCE(v_available, 0) + 0.01 THEN
    RAISE EXCEPTION 'Amount (%) exceeds available vendor credit (%)', _amount, COALESCE(v_available, 0);
  END IF;

  v_bill_balance := COALESCE(v_bill.total, 0) - COALESCE(v_bill.amount_paid, 0);
  IF _amount > v_bill_balance + 0.01 THEN
    RAISE EXCEPTION 'Amount (%) exceeds bill balance (%)', _amount, v_bill_balance;
  END IF;

  IF NOT public.is_period_open(_business_id, CURRENT_DATE) THEN
    RAISE EXCEPTION 'accounting period is closed for %', CURRENT_DATE;
  END IF;

  v_ap := public.compensation_account(_business_id, 'accounts_payable');
  v_credit_asset := public.vendor_credit_account(_business_id);

  INSERT INTO public.vendor_credit_note_applications
    (credit_note_id, bill_id, amount, applied_at, applied_by, organization_id, business_id, notes)
  VALUES (_vendor_credit_note_id, _bill_id, _amount, now(), v_actor, _org_id, _business_id, _notes);

  v_je_id := public.post_journal_entry_atomic(
    _org_id := _org_id,
    _business_id := _business_id,
    _entry_number := public.generate_next_je_number(_org_id, _business_id),
    _entry_date := CURRENT_DATE,
    _reference := 'VCNA-' || v_vcn.credit_note_number || '-' || COALESCE(v_bill.bill_number, ''),
    _description := 'Apply vendor credit ' || v_vcn.credit_note_number || ' to bill ' || COALESCE(v_bill.bill_number, ''),
    _source_type := 'vendor_credit_application',
    _source_id := _vendor_credit_note_id,
    _created_by := v_actor,
    _is_closing := false,
    _is_adjusting := false,
    _lines := jsonb_build_array(
      jsonb_build_object('account_id', v_ap, 'debit', _amount, 'credit', 0,
        'description', 'Payable settled by vendor credit ' || v_vcn.credit_note_number,
        'contact_id', v_vcn.vendor_id),
      jsonb_build_object('account_id', v_credit_asset, 'debit', 0, 'credit', _amount,
        'description', 'Vendor credit consumed: ' || v_vcn.credit_note_number,
        'contact_id', v_vcn.vendor_id)
    ),
    _branch_id := v_branch
  );

  PERFORM public.vendor_credit_balance_apply(
    _org_id, _business_id, v_vcn.vendor_id, v_vcn.currency, -_amount,
    'vendor_credit_application', _vendor_credit_note_id,
    'Applied to bill ' || COALESCE(v_bill.bill_number, ''), v_actor);

  v_new_paid := COALESCE(v_bill.amount_paid, 0) + _amount;
  UPDATE public.bills
     SET amount_paid = v_new_paid,
         status = CASE WHEN v_new_paid >= COALESCE(total, 0) - 0.01 THEN 'paid'::bill_status
                       ELSE 'partial'::bill_status END,
         updated_at = now()
   WHERE id = _bill_id;

  UPDATE public.vendor_credit_notes
     SET amount_applied = COALESCE(amount_applied, 0) + _amount,
         settlement_status = CASE
           WHEN COALESCE(amount_applied, 0) + _amount >= total THEN 'applied'
           ELSE 'partially_applied' END,
         row_version = COALESCE(row_version, 0) + 1,
         updated_at = now()
   WHERE id = _vendor_credit_note_id;

  RETURN jsonb_build_object(
    'success', true,
    'journal_entry_id', v_je_id,
    'amount_applied', _amount,
    'bill_id', _bill_id,
    'credit_note_id', _vendor_credit_note_id);
END
$function$;

NOTIFY pgrst, 'reload schema';