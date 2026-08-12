-- 1. Applications carry their own accounting linkage.
ALTER TABLE public.vendor_credit_note_applications
  ADD COLUMN IF NOT EXISTS journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reversal_journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_vcn_applications_credit_note ON public.vendor_credit_note_applications(credit_note_id);
CREATE INDEX IF NOT EXISTS idx_vcn_applications_bill ON public.vendor_credit_note_applications(bill_id);

-- Backfill from the credit ledger: one 'apply' movement per (note, bill).
UPDATE public.vendor_credit_note_applications a
   SET journal_entry_id = m.journal_entry_id
  FROM public.vendor_credit_movements m
 WHERE a.journal_entry_id IS NULL
   AND m.kind = 'apply'
   AND m.vendor_credit_note_id = a.credit_note_id
   AND m.bill_id = a.bill_id
   AND m.amount = a.amount;

-- 2. Repair the apply writer: the credit ledger movement must be written
--    directly (the previously referenced helper does not exist), and the
--    application row must keep its journal entry id.
CREATE OR REPLACE FUNCTION public.apply_vendor_credit_to_bill_atomic(_org_id uuid, _business_id uuid, _vendor_credit_note_id uuid, _bill_id uuid, _amount numeric, _applied_by uuid DEFAULT NULL::uuid, _notes text DEFAULT NULL::text, _branch_id uuid DEFAULT NULL::uuid)
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
  v_new_paid numeric; v_app_id uuid;
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

  INSERT INTO public.vendor_credit_note_applications
    (credit_note_id, bill_id, amount, applied_at, applied_by, organization_id, business_id, notes, journal_entry_id)
  VALUES (_vendor_credit_note_id, _bill_id, _amount, now(), v_actor, _org_id, _business_id, _notes, v_je_id)
  RETURNING id INTO v_app_id;

  INSERT INTO public.vendor_credit_movements (
    organization_id, business_id, branch_id, vendor_id, balance_id,
    kind, amount, currency, vendor_credit_note_id, bill_id, journal_entry_id, created_by, notes
  ) VALUES (
    _org_id, _business_id, v_branch, v_vcn.vendor_id, v_balance_id,
    'apply', _amount, v_vcn.currency, _vendor_credit_note_id, _bill_id, v_je_id, v_actor,
    COALESCE(_notes, 'Applied to bill ' || COALESCE(v_bill.bill_number, ''))
  );

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
    'application_id', v_app_id,
    'journal_entry_id', v_je_id,
    'amount_applied', _amount,
    'bill_id', _bill_id,
    'credit_note_id', _vendor_credit_note_id);
END
$function$;

-- 3. Unapply a single application, server-authoritative.
CREATE OR REPLACE FUNCTION public.unapply_vendor_credit_from_bill_atomic(
  _application_id uuid, _reason text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_app public.vendor_credit_note_applications%ROWTYPE;
  v_vcn public.vendor_credit_notes%ROWTYPE;
  v_bill public.bills%ROWTYPE;
  v_actor uuid := auth.uid();
  v_balance_id uuid; v_rev_je uuid; v_new_paid numeric; v_new_applied numeric;
  v_branch uuid;
BEGIN
  SELECT * INTO v_app FROM public.vendor_credit_note_applications
   WHERE id = _application_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Credit application not found'; END IF;
  IF v_app.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'This credit application has already been unapplied';
  END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_app.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_app.business_id USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_vcn FROM public.vendor_credit_notes WHERE id = v_app.credit_note_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Vendor credit note not found'; END IF;
  SELECT * INTO v_bill FROM public.bills WHERE id = v_app.bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bill not found'; END IF;

  IF NOT public.is_period_open(v_app.business_id, CURRENT_DATE) THEN
    RAISE EXCEPTION 'accounting period is closed for %', CURRENT_DATE USING ERRCODE = '23514';
  END IF;

  v_branch := COALESCE(v_bill.branch_id, v_vcn.branch_id);

  -- Reverse the application's journal entry.
  IF v_app.journal_entry_id IS NOT NULL THEN
    SELECT public.void_journal_entry_atomic(
      v_app.journal_entry_id,
      'Unapply vendor credit ' || COALESCE(v_vcn.credit_note_number, '') || ': ' || COALESCE(_reason, 'operator unapply'),
      v_actor, NULL, CURRENT_DATE) INTO v_rev_je;
  END IF;

  -- Restore the bill balance.
  v_new_paid := GREATEST(COALESCE(v_bill.amount_paid, 0) - v_app.amount, 0);
  UPDATE public.bills
     SET amount_paid = v_new_paid,
         status = CASE
           WHEN v_new_paid <= 0.01 THEN 'pending'::bill_status
           WHEN v_new_paid >= COALESCE(total, 0) - 0.01 THEN 'paid'::bill_status
           ELSE 'partial'::bill_status END,
         updated_at = now()
   WHERE id = v_bill.id;

  -- Hand the credit back to the vendor balance.
  v_balance_id := public.vendor_credit_balance_id(
    v_vcn.organization_id, v_vcn.business_id, v_vcn.vendor_id, v_vcn.currency);
  INSERT INTO public.vendor_credit_movements (
    organization_id, business_id, branch_id, vendor_id, balance_id,
    kind, amount, currency, vendor_credit_note_id, bill_id, journal_entry_id, created_by, notes
  ) VALUES (
    v_vcn.organization_id, v_vcn.business_id, v_branch, v_vcn.vendor_id, v_balance_id,
    'unapply', v_app.amount, v_vcn.currency, v_vcn.id, v_bill.id, v_rev_je, v_actor,
    'Unapplied from bill ' || COALESCE(v_bill.bill_number, '') || COALESCE(': ' || _reason, '')
  );

  UPDATE public.vendor_credit_note_applications
     SET reversed_at = now(), reversed_by = v_actor,
         reversal_reason = _reason,
         reversal_journal_entry_id = v_rev_je
   WHERE id = _application_id;

  v_new_applied := GREATEST(COALESCE(v_vcn.amount_applied, 0) - v_app.amount, 0);
  UPDATE public.vendor_credit_notes
     SET amount_applied = v_new_applied,
         settlement_status = CASE
           WHEN v_new_applied <= 0.01 THEN 'open'
           WHEN v_new_applied >= COALESCE(total, 0) - 0.01 THEN 'applied'
           ELSE 'partially_applied' END,
         row_version = COALESCE(row_version, 0) + 1,
         updated_at = now()
   WHERE id = v_vcn.id;

  RETURN jsonb_build_object(
    'success', true,
    'application_id', _application_id,
    'credit_note_id', v_vcn.id,
    'bill_id', v_bill.id,
    'amount_unapplied', v_app.amount,
    'reversal_journal_entry_id', v_rev_je);
END
$function$;

REVOKE ALL ON FUNCTION public.unapply_vendor_credit_from_bill_atomic(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unapply_vendor_credit_from_bill_atomic(uuid, text) TO authenticated;