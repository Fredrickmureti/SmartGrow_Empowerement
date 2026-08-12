-- ── Phase 4 (ADR 0132): reversal & void of vendor credit notes ──────────────

-- 1. Reversal audit columns on the note and on each application row
ALTER TABLE public.vendor_credit_notes
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by uuid,
  ADD COLUMN IF NOT EXISTS reversal_reason text,
  ADD COLUMN IF NOT EXISTS reversal_reason_code text,
  ADD COLUMN IF NOT EXISTS reversal_journal_entry_id uuid;

ALTER TABLE public.vendor_credit_note_applications
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by uuid,
  ADD COLUMN IF NOT EXISTS reversal_reason text;

-- 2. Vendor credit movements: give-back and cancellation kinds
ALTER TABLE public.vendor_credit_movements
  DROP CONSTRAINT IF EXISTS vendor_credit_movements_kind_check;
ALTER TABLE public.vendor_credit_movements
  ADD CONSTRAINT vendor_credit_movements_kind_check
  CHECK (kind = ANY (ARRAY['issue','apply','refund','expire','unapply','reversal']));

CREATE OR REPLACE FUNCTION public._vcm_project_balance()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.vendor_credit_balances b
     SET credited_total = b.credited_total
           + CASE WHEN NEW.kind = 'issue' THEN NEW.amount
                  WHEN NEW.kind = 'reversal' THEN -NEW.amount ELSE 0 END,
         applied_total  = b.applied_total
           + CASE WHEN NEW.kind = 'apply' THEN NEW.amount
                  WHEN NEW.kind = 'unapply' THEN -NEW.amount ELSE 0 END,
         refunded_total = b.refunded_total + CASE WHEN NEW.kind = 'refund' THEN NEW.amount ELSE 0 END,
         expired_total  = b.expired_total  + CASE WHEN NEW.kind = 'expire' THEN NEW.amount ELSE 0 END,
         balance        = b.balance
           + CASE WHEN NEW.kind IN ('issue','unapply') THEN NEW.amount ELSE -NEW.amount END,
         updated_at     = now()
   WHERE b.id = NEW.balance_id;

  IF (SELECT balance FROM public.vendor_credit_balances WHERE id = NEW.balance_id) < -0.01 THEN
    RAISE EXCEPTION 'vendor credit balance cannot go negative (movement % of %)', NEW.kind, NEW.amount;
  END IF;
  RETURN NEW;
END $function$;

-- 3. Reason codes: the shared ones plus two AP-credit specific reasons
UPDATE public.reversal_reason_codes
   SET applies_to = array_append(applies_to, 'vendor_credit_note')
 WHERE code IN ('data_entry_error','wrong_amount','test_transaction','other',
                'duplicate_document','wrong_counterparty','pricing_error')
   AND NOT ('vendor_credit_note' = ANY (applies_to));

INSERT INTO public.reversal_reason_codes (code, label, applies_to, requires_comment, active)
VALUES
  ('vendor_credit_issued_in_error', 'Vendor credit issued in error',
   ARRAY['vendor_credit_note'], true, true),
  ('vendor_credit_superseded', 'Superseded by a corrected vendor credit',
   ARRAY['vendor_credit_note'], true, true)
ON CONFLICT (code) DO NOTHING;

-- 4. Reversal intent for a vendor credit note (canonical authority)
CREATE OR REPLACE FUNCTION public.resolve_reversal_intent_vendor_credit_note(_document_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v public.vendor_credit_notes%ROWTYPE;
  v_applied numeric := 0;
  v_period_open boolean := true;
  v_allowed boolean;
  v_blocked text;
BEGIN
  SELECT * INTO v FROM public.vendor_credit_notes WHERE id = _document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor credit note % not found.', _document_id USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.user_belongs_to_org(v.organization_id) THEN
    RAISE EXCEPTION 'Not authorized for this document.' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_applied
    FROM public.vendor_credit_note_applications
   WHERE credit_note_id = _document_id AND reversed_at IS NULL;

  v_period_open := public.is_period_open(v.business_id, v.credit_date);

  v_allowed := v.accounting_status = 'posted';
  v_blocked := CASE
    WHEN v.accounting_status = 'reversed' THEN 'This vendor credit note has already been reversed.'
    WHEN v.accounting_status = 'unposted' THEN
      'This vendor credit note has not been posted yet — cancel or delete it instead.'
    ELSE NULL END;

  RETURN jsonb_build_object(
    'document_type', 'vendor_credit_note',
    'document_id', _document_id,
    'document_number', v.credit_note_number,
    'organization_id', v.organization_id,
    'business_id', v.business_id,
    'status', v.status,
    'commercial_status', v.commercial_status,
    'accounting_status', v.accounting_status,
    'settlement_status', v.settlement_status,
    'total', COALESCE(v.total, 0),
    'applied_total', v_applied,
    'period_open', v_period_open,
    'operations', jsonb_build_array(jsonb_build_object(
      'operation', 'reverse',
      'allowed', v_allowed,
      'blocked_reason', v_blocked,
      'label', 'Reverse vendor credit note',
      'effect', CASE WHEN v_applied > 0
                     THEN 'Gives the credit back and restores the bills it settled.'
                     ELSE 'Cancels the credit and its journal entry.' END)),
    'recommended_operation', CASE WHEN v_allowed THEN 'reverse' ELSE NULL END,
    'blockers', CASE WHEN v_blocked IS NULL
                     THEN '[]'::jsonb ELSE jsonb_build_array(v_blocked) END);
END $function$;

CREATE OR REPLACE FUNCTION public.resolve_reversal_intent(_document_type text, _document_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF _document_id IS NULL THEN
    RAISE EXCEPTION 'resolve_reversal_intent requires a document id' USING ERRCODE = '22023';
  END IF;

  IF _document_type = 'pos_transaction' THEN
    RETURN public.resolve_reversal_intent_pos(_document_id);
  ELSIF _document_type = 'payroll_run' THEN
    RETURN public.resolve_reversal_intent_payroll(_document_id);
  ELSIF _document_type = 'vendor_credit_note' THEN
    RETURN public.resolve_reversal_intent_vendor_credit_note(_document_id);
  ELSE
    RETURN public.resolve_reversal_intent_finance(_document_type, _document_id);
  END IF;
END;
$function$;

-- 5. The writer: one command, one transaction
CREATE OR REPLACE FUNCTION public.reverse_vendor_credit_note_atomic(
  _vcn_id uuid,
  _reason text,
  _reason_code text DEFAULT NULL,
  _reversal_date date DEFAULT NULL,
  _actor uuid DEFAULT NULL,
  _client_request_id text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v public.vendor_credit_notes%ROWTYPE;
  v_actor uuid := COALESCE(_actor, auth.uid());
  v_date date := COALESCE(_reversal_date, CURRENT_DATE);
  v_je RECORD;
  v_rev uuid;
  v_reversals uuid[] := ARRAY[]::uuid[];
  v_app RECORD;
  v_unapplied numeric := 0;
  v_issued numeric := 0;
  v_applied_mov numeric := 0;
  v_balance_id uuid;
  v_new_paid numeric;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE = '42501'; END IF;
  IF _vcn_id IS NULL THEN
    RAISE EXCEPTION 'reverse_vendor_credit_note_atomic requires a credit note id' USING ERRCODE = '22023';
  END IF;
  IF _reason IS NULL OR btrim(_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required to reverse a vendor credit note.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v FROM public.vendor_credit_notes WHERE id = _vcn_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor credit note % not found.', _vcn_id USING ERRCODE = 'P0002';
  END IF;

  IF v.accounting_status = 'reversed' THEN
    RETURN jsonb_build_object('result', 'already_reversed', 'vendor_credit_note_id', _vcn_id,
      'credit_note_number', v.credit_note_number);
  END IF;

  IF NOT public.user_can_access_business(v_actor, v.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v.business_id USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_reversal_reason('vendor_credit_note', _reason_code, _reason);
  PERFORM public.assert_can_reverse('vendor_credit_note', _vcn_id, 'reverse', v_actor, v_date);

  IF NOT public.is_period_open(v.business_id, v_date) THEN
    RAISE EXCEPTION 'The accounting period covering % is closed.', v_date USING ERRCODE = '23514';
  END IF;

  -- 5a. Give back everything this credit settled, bill by bill.
  FOR v_app IN
    SELECT * FROM public.vendor_credit_note_applications
     WHERE credit_note_id = _vcn_id AND reversed_at IS NULL
     FOR UPDATE
  LOOP
    UPDATE public.bills
       SET amount_paid = GREATEST(COALESCE(amount_paid, 0) - v_app.amount, 0),
           status = CASE
             WHEN GREATEST(COALESCE(amount_paid, 0) - v_app.amount, 0) <= 0 THEN 'pending'
             WHEN GREATEST(COALESCE(amount_paid, 0) - v_app.amount, 0) >= COALESCE(total, 0) THEN 'paid'
             ELSE 'partial' END,
           updated_at = now()
     WHERE id = v_app.bill_id
     RETURNING amount_paid INTO v_new_paid;

    UPDATE public.vendor_credit_note_applications
       SET reversed_at = now(), reversed_by = v_actor, reversal_reason = _reason
     WHERE id = v_app.id;

    v_unapplied := v_unapplied + v_app.amount;
  END LOOP;

  -- 5b. Compensating journal entries for every live posting of this note.
  FOR v_je IN
    SELECT je.id, je.entry_number
      FROM public.journal_entries je
     WHERE je.organization_id = v.organization_id
       AND je.source_type IN ('vendor_credit_note', 'vendor_credit_application')
       AND je.source_id = _vcn_id
       AND je.status::text NOT IN ('voided', 'reversed')
  LOOP
    v_rev := public.void_journal_entry_atomic(
      v_je.id,
      'Reverse vendor credit note ' || COALESCE(v.credit_note_number, _vcn_id::text) || ': ' || _reason,
      v_actor, NULL, v_date);
    IF v_rev IS NOT NULL THEN v_reversals := v_reversals || v_rev; END IF;
  END LOOP;

  -- 5c. Unwind the credit ledger: hand back consumption first, then cancel
  --     the issue, so the running balance never dips below zero.
  SELECT COALESCE(SUM(amount) FILTER (WHERE kind = 'issue'), 0),
         COALESCE(SUM(amount) FILTER (WHERE kind = 'apply'), 0)
           - COALESCE(SUM(amount) FILTER (WHERE kind = 'unapply'), 0)
    INTO v_issued, v_applied_mov
    FROM public.vendor_credit_movements
   WHERE vendor_credit_note_id = _vcn_id;

  IF v_issued > 0 OR v_applied_mov > 0 THEN
    v_balance_id := public.vendor_credit_balance_id(
      v.organization_id, v.business_id, v.vendor_id, v.currency);
  END IF;

  IF v_applied_mov > 0 THEN
    INSERT INTO public.vendor_credit_movements (
      organization_id, business_id, branch_id, vendor_id, balance_id,
      kind, amount, currency, vendor_credit_note_id, created_by, notes
    ) VALUES (
      v.organization_id, v.business_id, v.branch_id, v.vendor_id, v_balance_id,
      'unapply', v_applied_mov, v.currency, _vcn_id, v_actor,
      'Reversal of ' || v.credit_note_number || ': credit returned');
  END IF;

  IF v_issued > 0 THEN
    INSERT INTO public.vendor_credit_movements (
      organization_id, business_id, branch_id, vendor_id, balance_id,
      kind, amount, currency, vendor_credit_note_id, created_by, notes
    ) VALUES (
      v.organization_id, v.business_id, v.branch_id, v.vendor_id, v_balance_id,
      'reversal', v_issued, v.currency, _vcn_id, v_actor,
      'Reversal of ' || v.credit_note_number || ': credit cancelled');
  END IF;

  UPDATE public.vendor_credit_notes
     SET accounting_status = 'reversed',
         settlement_status = 'open',
         amount_applied = 0,
         reversed_at = now(),
         reversed_by = v_actor,
         reversal_reason = _reason,
         reversal_reason_code = _reason_code,
         reversal_journal_entry_id = COALESCE(v_reversals[1], reversal_journal_entry_id),
         row_version = COALESCE(row_version, 1) + 1,
         updated_at = now()
   WHERE id = _vcn_id;

  RETURN jsonb_build_object(
    'result', 'reversed',
    'vendor_credit_note_id', _vcn_id,
    'credit_note_number', v.credit_note_number,
    'reversal_date', v_date,
    'unapplied_amount', v_unapplied,
    'credit_cancelled', v_issued,
    'reversal_journal_entry_ids', to_jsonb(v_reversals),
    'client_request_id', _client_request_id);
END $function$;

REVOKE ALL ON FUNCTION public.reverse_vendor_credit_note_atomic(uuid, text, text, date, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_vendor_credit_note_atomic(uuid, text, text, date, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_reversal_intent_vendor_credit_note(uuid) TO authenticated;

-- 6. A reversed note can never be spent: read the posting state, not the label.
CREATE OR REPLACE FUNCTION public.apply_vendor_credit_to_bill_atomic(
  _org_id uuid, _business_id uuid, _vendor_credit_note_id uuid, _bill_id uuid,
  _amount numeric, _applied_by uuid DEFAULT NULL::uuid, _notes text DEFAULT NULL::text,
  _branch_id uuid DEFAULT NULL::uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
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
    _currency := v_vcn.currency,
    _exchange_rate := NULL,
    _source_subtype := NULL,
    _branch_id := v_branch
  );

  INSERT INTO public.vendor_credit_movements (
    organization_id, business_id, branch_id, vendor_id, balance_id,
    kind, amount, currency, vendor_credit_note_id, bill_id, journal_entry_id, created_by, notes
  ) VALUES (
    _org_id, _business_id, v_branch, v_vcn.vendor_id, v_balance_id,
    'apply', _amount, v_vcn.currency, _vendor_credit_note_id, _bill_id, v_je_id, v_actor, _notes
  );

  v_new_paid := COALESCE(v_bill.amount_paid, 0) + _amount;
  UPDATE public.bills
     SET amount_paid = v_new_paid,
         status = CASE WHEN v_new_paid >= COALESCE(total, 0) THEN 'paid' ELSE 'partial' END,
         updated_at = now()
   WHERE id = _bill_id;

  UPDATE public.vendor_credit_notes
     SET amount_applied = COALESCE(amount_applied, 0) + _amount,
         settlement_status = CASE
           WHEN COALESCE(amount_applied, 0) + _amount >= total THEN 'applied'
           ELSE 'partially_applied' END,
         updated_at = now()
   WHERE id = _vendor_credit_note_id;

  RETURN jsonb_build_object('success', true, 'journal_entry_id', v_je_id,
    'amount_applied', _amount, 'bill_amount_paid', v_new_paid);
END $function$;

NOTIFY pgrst, 'reload schema';