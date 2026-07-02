
-- ============================================================
-- Purchases hardening: vendor_pricelists.branch_id + 
-- record_bill_payment_atomic with _branch_id
-- ============================================================

-- 1) Vendor pricelists: branch column for branch-scoped pricing.
ALTER TABLE public.vendor_pricelists
  ADD COLUMN IF NOT EXISTS branch_id uuid NULL REFERENCES public.branches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_vendor_pricelists_branch
  ON public.vendor_pricelists (organization_id, business_id, branch_id);

COMMENT ON COLUMN public.vendor_pricelists.branch_id IS
  'NULL = company-wide vendor price; non-NULL = branch-specific override';

-- 2) record_bill_payment_atomic: add _branch_id (default null, derived from bill if null)
CREATE OR REPLACE FUNCTION public.record_bill_payment_atomic(
  _org_id uuid,
  _business_id uuid,
  _bill_id uuid,
  _amount numeric,
  _payment_date date,
  _payment_method text DEFAULT 'bank_transfer'::text,
  _reference text DEFAULT NULL::text,
  _notes text DEFAULT NULL::text,
  _bank_account_id uuid DEFAULT NULL::uuid,
  _created_by uuid DEFAULT NULL::uuid,
  _ap_account_id uuid DEFAULT NULL::uuid,
  _cash_account_id uuid DEFAULT NULL::uuid,
  _je_entry_number text DEFAULT NULL::text,
  _wht_rate numeric DEFAULT 0,
  _wht_account_id uuid DEFAULT NULL::uuid,
  _branch_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_payment_id uuid; v_bill RECORD; v_new_amount_paid numeric; v_new_status bill_status;
  v_je_id uuid; v_je_number text; v_wht_je_id uuid; v_wht_je_number text;
  v_wht_amount numeric := 0; v_attempts int := 0; v_max_attempts int := 20; v_result jsonb;
  v_branch_id uuid;
BEGIN
  IF _ap_account_id IS NULL OR _cash_account_id IS NULL THEN
    RAISE EXCEPTION 'Cannot record bill payment: missing GL account mapping (AP=%, Cash=%).', _ap_account_id, _cash_account_id;
  END IF;

  SELECT id, bill_number, total, amount_paid, status, journal_entry_id, vendor_id, branch_id
    INTO v_bill FROM bills WHERE id = _bill_id AND organization_id = _org_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bill not found'; END IF;
  IF _amount > (v_bill.total - COALESCE(v_bill.amount_paid, 0)) THEN
    RAISE EXCEPTION 'Payment amount (%) exceeds balance due (%)', _amount, (v_bill.total - COALESCE(v_bill.amount_paid, 0));
  END IF;

  -- Branch derivation: caller-supplied wins, else inherit from bill (parent inheritance).
  v_branch_id := COALESCE(_branch_id, v_bill.branch_id);

  INSERT INTO bill_payments (organization_id, business_id, branch_id, bill_id, amount,
    payment_date, payment_method, reference, notes, bank_account_id, created_by)
  VALUES (_org_id, _business_id, v_branch_id, _bill_id, _amount, _payment_date, _payment_method,
    _reference, _notes, _bank_account_id, _created_by) RETURNING id INTO v_payment_id;

  v_new_amount_paid := COALESCE(v_bill.amount_paid, 0) + _amount;
  v_new_status := CASE WHEN v_new_amount_paid >= v_bill.total THEN 'paid'::bill_status ELSE 'partial'::bill_status END;

  LOOP
    v_attempts := v_attempts + 1;
    IF v_attempts > v_max_attempts THEN RAISE EXCEPTION 'Unable to allocate JE number after % attempts', v_max_attempts; END IF;
    v_je_number := generate_next_je_number(_org_id);
    BEGIN
      INSERT INTO journal_entries (organization_id, business_id, branch_id, entry_number, entry_date,
        reference, description, source_type, source_id, status, created_by)
      VALUES (_org_id, _business_id, v_branch_id, v_je_number, _payment_date,
        'BP-' || v_bill.bill_number, 'Bill payment for ' || v_bill.bill_number,
        'bill_payment', v_payment_id, 'posted', _created_by)
      RETURNING id INTO v_je_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF POSITION('journal_entries_organization_id_entry_number_key' IN SQLERRM) > 0 THEN CONTINUE; ELSE RAISE; END IF;
    END;
  END LOOP;

  INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
  VALUES (v_je_id, _ap_account_id, _amount, 0, 'Bill payment ' || v_bill.bill_number || ' - AP reduction');
  INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
  VALUES (v_je_id, _cash_account_id, 0, _amount, 'Bill payment ' || v_bill.bill_number || ' - Cash/Bank');

  UPDATE bill_payments SET journal_entry_id = v_je_id WHERE id = v_payment_id;

  IF _wht_rate IS NOT NULL AND _wht_rate > 0 AND _wht_account_id IS NOT NULL THEN
    v_wht_amount := ROUND(_amount * (_wht_rate / 100.0), 2);
    IF v_wht_amount > 0 THEN
      v_attempts := 0;
      LOOP
        v_attempts := v_attempts + 1;
        IF v_attempts > v_max_attempts THEN RAISE EXCEPTION 'Unable to allocate WHT JE number'; END IF;
        v_wht_je_number := generate_next_je_number(_org_id);
        BEGIN
          INSERT INTO journal_entries (organization_id, business_id, branch_id, entry_number, entry_date,
            reference, description, source_type, source_id, source_subtype, status, created_by)
          VALUES (_org_id, _business_id, v_branch_id, v_wht_je_number, _payment_date,
            'WHT-' || v_bill.bill_number,
            'Withholding tax on payment for ' || v_bill.bill_number || ' (' || _wht_rate || '%)',
            'bill_payment', v_payment_id, 'wht', 'posted', _created_by)
          RETURNING id INTO v_wht_je_id;
          EXIT;
        EXCEPTION WHEN unique_violation THEN
          IF POSITION('journal_entries_organization_id_entry_number_key' IN SQLERRM) > 0 THEN CONTINUE; ELSE RAISE; END IF;
        END;
      END LOOP;

      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
      VALUES (v_wht_je_id, _ap_account_id, v_wht_amount, 0,
        'WHT on payment ' || v_bill.bill_number || ' - additional AP reduction');
      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
      VALUES (v_wht_je_id, _wht_account_id, 0, v_wht_amount,
        'WHT on payment ' || v_bill.bill_number || ' - Withholding tax payable');

      v_new_amount_paid := v_new_amount_paid + v_wht_amount;
      v_new_status := CASE WHEN v_new_amount_paid >= v_bill.total THEN 'paid'::bill_status ELSE 'partial'::bill_status END;
    END IF;
  END IF;

  UPDATE bills SET amount_paid = v_new_amount_paid, status = v_new_status, updated_at = now()
    WHERE id = _bill_id;

  v_result := jsonb_build_object(
    'payment_id', v_payment_id,
    'journal_entry_id', v_je_id,
    'wht_journal_entry_id', v_wht_je_id,
    'wht_amount', v_wht_amount,
    'new_amount_paid', v_new_amount_paid,
    'new_status', v_new_status,
    'branch_id', v_branch_id
  );
  RETURN v_result;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.record_bill_payment_atomic(
  uuid, uuid, uuid, numeric, date, text, text, text, uuid, uuid, uuid, uuid, text, numeric, uuid, uuid
) TO authenticated;
