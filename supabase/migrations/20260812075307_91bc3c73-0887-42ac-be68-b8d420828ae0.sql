CREATE OR REPLACE FUNCTION public.issue_vendor_credit_note_atomic(_vcn_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_vcn public.vendor_credit_notes%ROWTYPE;
  v_bill public.bills%ROWTYPE;
  v_open numeric := 0; v_to_ap numeric := 0; v_to_credit numeric := 0;
  v_ap uuid; v_exp uuid; v_tax uuid; v_credit_asset uuid;
  v_lines jsonb := '[]'::jsonb; v_je_id uuid; v_balance_id uuid;
  v_row record;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE = '42501'; END IF;

  SELECT * INTO v_vcn FROM public.vendor_credit_notes WHERE id = _vcn_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Vendor credit note % not found', _vcn_id; END IF;
  IF v_vcn.accounting_status <> 'unposted' THEN
    RAISE EXCEPTION 'Vendor credit note is already % — it cannot be posted again', v_vcn.accounting_status
      USING ERRCODE='22023';
  END IF;
  IF v_vcn.commercial_status IN ('cancelled','rejected') THEN
    RAISE EXCEPTION 'A % vendor credit note cannot be posted', v_vcn.commercial_status USING ERRCODE='22023';
  END IF;
  -- Governance: where an approval rule exists for vendor credit notes, the
  -- moment AP changes requires an approved document. Solo setups keep one click.
  IF v_vcn.commercial_status <> 'approved'
     AND public._vcn_requires_approval(v_vcn.organization_id, v_vcn.business_id) THEN
    RAISE EXCEPTION 'Vendor credit note % must be approved before it is posted', v_vcn.credit_note_number
      USING ERRCODE='42501';
  END IF;
  IF v_vcn.business_id IS NULL OR NOT public.user_can_access_business(auth.uid(), v_vcn.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_vcn.business_id USING ERRCODE = '42501';
  END IF;
  IF COALESCE(v_vcn.total, 0) <= 0 THEN
    RAISE EXCEPTION 'Vendor credit note % has a non-positive total', v_vcn.credit_note_number;
  END IF;
  IF NOT public.is_period_open(v_vcn.business_id, v_vcn.credit_date) THEN
    RAISE EXCEPTION 'accounting period is closed for %', v_vcn.credit_date;
  END IF;

  PERFORM public.assert_no_existing_source_posting(v_vcn.organization_id, 'vendor_credit_note', _vcn_id, NULL);

  v_ap  := public.compensation_account(v_vcn.business_id, 'accounts_payable');
  v_exp := public.compensation_account(v_vcn.business_id, 'operating_expenses');
  v_credit_asset := public.vendor_credit_account(v_vcn.business_id);
  IF COALESCE(v_vcn.tax_amount, 0) > 0 THEN
    v_tax := public.compensation_account(v_vcn.business_id, 'input_tax');
  END IF;

  FOR v_row IN
    SELECT COALESCE(i.account_id, v_exp) AS account_id, SUM(COALESCE(i.line_total, 0)) AS amt
      FROM public.vendor_credit_note_items i
     WHERE i.credit_note_id = _vcn_id
     GROUP BY COALESCE(i.account_id, v_exp)
  LOOP
    IF v_row.amt > 0 THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_row.account_id, 'debit', 0, 'credit', v_row.amt,
        'description', 'VCN ' || v_vcn.credit_note_number || ' — cost reversal'));
    END IF;
  END LOOP;

  IF COALESCE(v_vcn.tax_amount, 0) > 0 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_tax, 'debit', 0, 'credit', v_vcn.tax_amount,
      'description', 'VCN ' || v_vcn.credit_note_number || ' — input tax reversal'));
  END IF;

  IF v_vcn.bill_id IS NOT NULL THEN
    SELECT * INTO v_bill FROM public.bills WHERE id = v_vcn.bill_id FOR UPDATE;
    IF FOUND THEN
      v_open := GREATEST(COALESCE(v_bill.total, 0) - COALESCE(v_bill.amount_paid, 0), 0);
    END IF;
  END IF;
  v_to_ap := LEAST(v_vcn.total, v_open);
  v_to_credit := v_vcn.total - v_to_ap;

  IF v_to_ap > 0 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_ap, 'debit', v_to_ap, 'credit', 0,
      'description', 'VCN ' || v_vcn.credit_note_number || ' — payable reduction',
      'contact_id', v_vcn.vendor_id));
  END IF;
  IF v_to_credit > 0 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_credit_asset, 'debit', v_to_credit, 'credit', 0,
      'description', 'VCN ' || v_vcn.credit_note_number || ' — vendor credit',
      'contact_id', v_vcn.vendor_id));
  END IF;

  v_je_id := public.post_journal_entry_atomic(
    _org_id := v_vcn.organization_id,
    _business_id := v_vcn.business_id,
    _entry_number := public.generate_next_je_number(v_vcn.organization_id, v_vcn.business_id),
    _entry_date := v_vcn.credit_date,
    _reference := v_vcn.credit_note_number,
    _description := 'Vendor credit note ' || v_vcn.credit_note_number || ' issued',
    _source_type := 'vendor_credit_note',
    _source_id := _vcn_id,
    _created_by := auth.uid(),
    _is_closing := false,
    _is_adjusting := false,
    _lines := v_lines,
    _currency := v_vcn.currency,
    _exchange_rate := NULL,
    _source_subtype := NULL,
    _branch_id := v_vcn.branch_id
  );

  IF v_to_ap > 0 AND v_vcn.bill_id IS NOT NULL THEN
    UPDATE public.bills
       SET amount_paid = COALESCE(amount_paid, 0) + v_to_ap,
           status = CASE WHEN COALESCE(amount_paid, 0) + v_to_ap >= COALESCE(total, 0)
                         THEN 'paid' ELSE 'partial' END,
           updated_at = now()
     WHERE id = v_vcn.bill_id;

    INSERT INTO public.vendor_credit_note_applications
      (credit_note_id, bill_id, amount, applied_at, applied_by, organization_id, business_id, notes)
    VALUES (_vcn_id, v_vcn.bill_id, v_to_ap, now(), auth.uid(),
            v_vcn.organization_id, v_vcn.business_id, 'Applied on issue');
  END IF;

  IF v_to_credit > 0 THEN
    v_balance_id := public.vendor_credit_balance_id(
      v_vcn.organization_id, v_vcn.business_id, v_vcn.vendor_id, v_vcn.currency);
    INSERT INTO public.vendor_credit_movements (
      organization_id, business_id, branch_id, vendor_id, balance_id,
      kind, amount, currency, vendor_credit_note_id, journal_entry_id, created_by, notes
    ) VALUES (
      v_vcn.organization_id, v_vcn.business_id, v_vcn.branch_id, v_vcn.vendor_id, v_balance_id,
      'issue', v_to_credit, v_vcn.currency, _vcn_id, v_je_id, auth.uid(), 'Vendor credit note issued'
    );
  END IF;

  UPDATE public.vendor_credit_notes
     SET accounting_status = 'posted',
         commercial_status = CASE WHEN commercial_status IN ('draft','submitted')
                                  THEN 'approved' ELSE commercial_status END,
         approved_by = COALESCE(approved_by, auth.uid()),
         approved_at = COALESCE(approved_at, now()),
         settlement_status = CASE
             WHEN v_to_ap >= v_vcn.total THEN 'applied'
             WHEN v_to_ap > 0 THEN 'partially_applied'
             ELSE 'open' END,
         amount_applied = COALESCE(amount_applied, 0) + v_to_ap,
         journal_entry_id = v_je_id,
         row_version = COALESCE(row_version, 1) + 1,
         updated_at = now()
   WHERE id = _vcn_id;

  RETURN jsonb_build_object('success', true, 'journal_entry_id', v_je_id,
    'applied_to_bill', v_to_ap, 'vendor_credit_created', v_to_credit);
END $function$;

NOTIFY pgrst, 'reload schema';