-- D3: unreconcile must not destroy the cash leg.
CREATE OR REPLACE FUNCTION public.unreconcile_payment_atomic(_payment_id uuid, _reason text, _actor uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_payment           public.payments%ROWTYPE;
  v_prior_applied     numeric;
  v_prior_outstanding numeric;
  v_touched           uuid[] := ARRAY[]::uuid[];
  v_invoice_id        uuid;
  v_inv               RECORD;
  v_new_paid          numeric;
  v_new_status        invoice_status;
  v_reversal_je       uuid;
  v_event_id          uuid;
  v_cleared           numeric := 0;
  v_cash_account      uuid;
  v_deposit_account   uuid;
  v_reclass_je        uuid;
BEGIN
  SELECT * INTO v_payment FROM public.payments WHERE id = _payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment % not found.', _payment_id USING ERRCODE = 'P0002';
  END IF;
  IF COALESCE(v_payment.status, 'completed') IN ('voided','cancelled') THEN
    RAISE EXCEPTION 'Cannot unreconcile a voided or cancelled payment.' USING ERRCODE = '22023';
  END IF;
  IF v_payment.business_id IS NOT NULL
     AND NOT public.is_period_open(v_payment.business_id, COALESCE(v_payment.payment_date, CURRENT_DATE)) THEN
    RAISE EXCEPTION 'Payment date falls in a closed fiscal period. Unreconcile refused.' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(array_agg(t.invoice_id), ARRAY[]::uuid[]), COALESCE(SUM(t.net), 0)
    INTO v_touched, v_cleared
    FROM (
      SELECT a.invoice_id, SUM(a.amount) AS net
        FROM public.payment_allocations a
       WHERE a.payment_id = _payment_id
       GROUP BY a.invoice_id
      HAVING SUM(a.amount) > 0
    ) t;

  IF array_length(v_touched, 1) IS NULL THEN
    RAISE EXCEPTION 'Payment is not currently applied to any invoice.' USING ERRCODE = '22023';
  END IF;

  v_prior_applied     := COALESCE(v_payment.applied_amount, 0);
  v_prior_outstanding := COALESCE(v_payment.outstanding_amount, 0);

  -- 1. Reverse the settlement journal (Dr Bank / Cr AR). The AR credit carries
  --    invoice linkage and cannot survive detachment.
  IF v_payment.journal_entry_id IS NOT NULL THEN
    SELECT l.account_id INTO v_cash_account
      FROM public.journal_entry_lines l
     WHERE l.journal_entry_id = v_payment.journal_entry_id
       AND COALESCE(l.debit, 0) > 0
     ORDER BY COALESCE(l.debit, 0) DESC
     LIMIT 1;

    v_reversal_je := public.void_journal_entry_atomic(
      v_payment.journal_entry_id,
      'Unreconcile payment ' || COALESCE(v_payment.receipt_number, _payment_id::text)
        || ': ' || COALESCE(_reason, 'no reason given'),
      _actor
    );
  END IF;

  -- 1b. Re-recognise the cash as an unapplied customer deposit. Without this
  --     the reversal above would remove real money from the bank balance.
  IF v_cash_account IS NOT NULL AND v_payment.business_id IS NOT NULL
     AND COALESCE(v_payment.amount, 0) > 0 THEN
    v_deposit_account := public.customer_credit_account(v_payment.business_id);
    IF v_deposit_account IS NULL THEN
      RAISE EXCEPTION 'Customer Deposits account is not configured for this company; unreconcile refused.'
        USING ERRCODE = '22023';
    END IF;

    v_reclass_je := public.post_journal_entry_atomic(
      v_payment.organization_id,
      v_payment.business_id,
      public.generate_next_je_number(v_payment.organization_id, v_payment.business_id),
      COALESCE(v_payment.payment_date, CURRENT_DATE),
      COALESCE(v_payment.receipt_number, _payment_id::text),
      'Unreconciled receipt held as customer deposit',
      'payment_unreconcile', _payment_id, _actor, false, false,
      jsonb_build_array(
        jsonb_build_object('account_id', v_cash_account, 'debit', v_payment.amount, 'credit', 0,
          'description', 'Cash retained on unreconciled receipt'),
        jsonb_build_object('account_id', v_deposit_account, 'debit', 0, 'credit', v_payment.amount,
          'description', 'Unapplied customer deposit')
      ),
      NULL, NULL, NULL, v_payment.branch_id
    );
  END IF;

  -- 2. Payment header. The receipt remains live cash, now fully unapplied and
  --    pointing at the reclassification entry.
  UPDATE public.payments
     SET journal_entry_id    = v_reclass_je,
         status              = 'unreconciled',
         applied_amount      = 0,
         outstanding_amount  = COALESCE(amount, 0),
         unreconciled_at     = now(),
         unreconciled_by     = _actor,
         unreconcile_reason  = _reason,
         updated_at          = now()
   WHERE id = _payment_id;

  SET CONSTRAINTS trg_payment_alloc_sum_invariant DEFERRED;

  -- 3. Append compensating negatives; never DELETE (ADR 0027 invariant 5).
  INSERT INTO public.payment_allocations
    (payment_id, invoice_id, amount, branch_id, source, created_by, created_at)
  SELECT _payment_id, t.invoice_id, -t.net, v_payment.branch_id, 'reallocation', _actor, now()
    FROM (
      SELECT a.invoice_id, SUM(a.amount) AS net
        FROM public.payment_allocations a
       WHERE a.payment_id = _payment_id
       GROUP BY a.invoice_id
      HAVING SUM(a.amount) > 0
    ) t;

  -- 4. Recompute each touched invoice from the live allocation sum.
  FOREACH v_invoice_id IN ARRAY v_touched LOOP
    SELECT i.id, i.total INTO v_inv
      FROM public.invoices i WHERE i.id = v_invoice_id FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;

    SELECT COALESCE(SUM(amount), 0) INTO v_new_paid
      FROM public.payment_allocations
     WHERE invoice_id = v_invoice_id
       AND payment_id IN (
         SELECT id FROM public.payments
          WHERE COALESCE(status, 'completed') NOT IN ('voided','cancelled')
       );

    IF v_new_paid >= v_inv.total - 0.005 THEN
      v_new_status := 'paid'::invoice_status;
    ELSIF v_new_paid > 0.005 THEN
      v_new_status := 'partial'::invoice_status;
    ELSE
      v_new_status := 'sent'::invoice_status;
    END IF;

    UPDATE public.invoices
       SET amount_paid = v_new_paid,
           status = v_new_status,
           updated_at = now()
     WHERE id = v_invoice_id;
  END LOOP;

  INSERT INTO public.payment_reversal_events
    (organization_id, business_id, payment_id, op, reason_code, reason_text,
     amount_before_outstanding, amount_before_applied,
     amount_after_outstanding,  amount_after_applied,
     reversal_journal_entry_id, performed_by, performed_at)
  VALUES
    (v_payment.organization_id, v_payment.business_id, _payment_id,
     'unapply', 'payment_unreconciled', _reason,
     v_prior_outstanding, v_prior_applied,
     COALESCE(v_payment.amount, 0), 0,
     v_reversal_je, _actor, now())
  RETURNING id INTO v_event_id;

  RETURN jsonb_build_object(
    'payment_id', _payment_id,
    'event_id', v_event_id,
    'reversal_journal_entry_id', v_reversal_je,
    'reclass_journal_entry_id', v_reclass_je,
    'cleared_amount', v_cleared,
    'touched_invoices', to_jsonb(v_touched)
  );
END;
$function$;

-- D5: bank reconciliation gains a fiscal-period guard and an idempotency key.
DROP FUNCTION IF EXISTS public.reconcile_bank_transaction_atomic(uuid, text, uuid, text, uuid, boolean, uuid);

CREATE OR REPLACE FUNCTION public.reconcile_bank_transaction_atomic(
  _txn_id uuid,
  _recon_type text,
  _entity_id uuid DEFAULT NULL::uuid,
  _category text DEFAULT NULL::text,
  _offset_account_id uuid DEFAULT NULL::uuid,
  _create_gl boolean DEFAULT true,
  _user_id uuid DEFAULT NULL::uuid,
  _client_request_id text DEFAULT NULL::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _txn record;
  _org_id uuid;
  _biz_id uuid;
  _branch_id uuid;
  _bank_gl_account uuid;
  _ar_account uuid;
  _ap_account uuid;
  _je_id uuid;
  _payment_id uuid;
  _bill_payment_id uuid;
  _receipt_number text;
  _abs_amount numeric;
  _entity_record record;
  _match_id uuid;
  _offset_business uuid;
  _offset_branch uuid;
  _settlement jsonb;
  _req text;
BEGIN
  SELECT * INTO _txn FROM public.bank_transactions WHERE id = _txn_id FOR UPDATE;
  IF _txn IS NULL THEN
    RAISE EXCEPTION 'Bank transaction not found: %', _txn_id;
  END IF;
  IF COALESCE(_txn.is_reconciled, false) THEN
    RAISE EXCEPTION 'Bank transaction is already reconciled';
  END IF;

  _org_id := _txn.organization_id;
  _biz_id := _txn.business_id;
  _branch_id := _txn.branch_id;
  _abs_amount := abs(_txn.amount);
  _req := COALESCE(_client_request_id, 'brecon:' || _txn_id::text);

  PERFORM public.assert_can_reconcile_bank(_biz_id);

  IF _biz_id IS NOT NULL AND NOT public.is_period_open(_biz_id, _txn.transaction_date) THEN
    RAISE EXCEPTION 'Bank transaction date falls in a closed fiscal period. Reconciliation refused.'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id INTO _bank_gl_account
  FROM public.bank_accounts
  WHERE id = _txn.bank_account_id
    AND organization_id = _org_id
    AND business_id = _biz_id;

  IF _bank_gl_account IS NULL THEN
    SELECT id INTO _bank_gl_account
    FROM public.accounts
    WHERE organization_id = _org_id
      AND business_id = _biz_id
      AND detail_type = 'checking'
      AND is_active = true
    LIMIT 1;
  END IF;

  IF _offset_account_id IS NOT NULL THEN
    SELECT business_id, branch_id INTO _offset_business, _offset_branch
      FROM public.accounts WHERE id = _offset_account_id;
    IF _offset_business IS DISTINCT FROM _biz_id THEN
      RAISE EXCEPTION 'Manual reconciliation offset account belongs to a different company';
    END IF;
    IF _offset_branch IS NOT NULL AND _branch_id IS NOT NULL AND _offset_branch IS DISTINCT FROM _branch_id THEN
      RAISE EXCEPTION 'Manual reconciliation offset account belongs to a different branch than the bank transaction'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF _recon_type IN ('invoice', 'bill') AND _entity_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.bank_transactions
      WHERE is_reconciled = true
        AND reconciled_entity_id = _entity_id
        AND reconciled_type = _recon_type
        AND id <> _txn_id
    ) THEN
      RAISE EXCEPTION 'This % is already reconciled to another bank transaction', _recon_type;
    END IF;
  END IF;

  IF _recon_type = 'invoice' AND _entity_id IS NOT NULL THEN
    SELECT id INTO _ar_account
    FROM public.accounts
    WHERE organization_id = _org_id
      AND business_id = _biz_id
      AND detail_type = 'accounts_receivable'
      AND is_active = true
    LIMIT 1;

    SELECT total, amount_paid, business_id, contact_id INTO _entity_record
    FROM public.invoices
    WHERE id = _entity_id
    FOR UPDATE;
    IF NOT FOUND OR _entity_record.business_id IS DISTINCT FROM _biz_id THEN
      RAISE EXCEPTION 'Invoice not found in the selected company';
    END IF;

    IF _bank_gl_account IS NULL OR _ar_account IS NULL THEN
      RAISE EXCEPTION 'Cannot reconcile to invoice: bank GL account and Accounts Receivable account must be mapped';
    END IF;

    SELECT public.get_next_receipt_number(_org_id) INTO _receipt_number;
    IF _receipt_number IS NULL THEN
      _receipt_number := 'RCP-BRECON-' || substr(_txn_id::text, 1, 8);
    END IF;

    -- Single settlement engine: reconciliation never writes payments or
    -- journal entries itself; it delegates to the canonical AR engine.
    _settlement := public.record_multi_invoice_payment(
      _org_id := _org_id,
      _business_id := _biz_id,
      _contact_id := _entity_record.contact_id,
      _allocations := jsonb_build_array(jsonb_build_object('invoice_id', _entity_id, 'amount', _abs_amount)),
      _total_amount := _abs_amount,
      _payment_date := _txn.transaction_date,
      _payment_method := 'bank_transfer',
      _reference := coalesce(_txn.reference, 'Bank recon: ' || _txn.description),
      _notes := 'Created by bank reconciliation',
      _receipt_number := _receipt_number,
      _created_by := _user_id,
      _deposit_account_id := _bank_gl_account,
      _receivable_account_id := _ar_account,
      _customer_credit_account_id := NULL,
      _branch_id := _branch_id,
      _exchange_rate := 1,
      _request_id := _req
    );

    _payment_id := (_settlement->>'payment_id')::uuid;
    _je_id := NULLIF(_settlement->>'journal_entry_id', '')::uuid;

  ELSIF _recon_type = 'bill' AND _entity_id IS NOT NULL THEN
    SELECT id INTO _ap_account
    FROM public.accounts
    WHERE organization_id = _org_id
      AND business_id = _biz_id
      AND detail_type = 'accounts_payable'
      AND is_active = true
    LIMIT 1;

    SELECT total, amount_paid, business_id, vendor_id INTO _entity_record
    FROM public.bills
    WHERE id = _entity_id
    FOR UPDATE;
    IF NOT FOUND OR _entity_record.business_id IS DISTINCT FROM _biz_id THEN
      RAISE EXCEPTION 'Bill not found in the selected company';
    END IF;

    IF _ap_account IS NULL THEN
      RAISE EXCEPTION 'Cannot reconcile to bill: Accounts Payable account must be mapped';
    END IF;

    _settlement := public.record_multi_bill_payment(
      _org_id := _org_id,
      _business_id := _biz_id,
      _vendor_id := _entity_record.vendor_id,
      _allocations := jsonb_build_array(jsonb_build_object('bill_id', _entity_id, 'amount', _abs_amount)),
      _total_amount := _abs_amount,
      _payment_date := _txn.transaction_date,
      _payment_method := 'bank_transfer',
      _reference := coalesce(_txn.reference, 'Bank recon: ' || _txn.description),
      _notes := 'Created by bank reconciliation',
      _created_by := _user_id,
      _bank_account_id := _txn.bank_account_id,
      _payable_account_id := _ap_account,
      _branch_id := _branch_id,
      _request_id := _req
    );

    _bill_payment_id := (_settlement->>'bill_payment_id')::uuid;
    _je_id := NULLIF(_settlement->>'journal_entry_id', '')::uuid;

  ELSIF _recon_type = 'manual' AND _create_gl AND _offset_account_id IS NOT NULL AND _bank_gl_account IS NOT NULL THEN
    _je_id := public.post_journal_entry_atomic(
      _org_id, _biz_id,
      public.generate_next_je_number(_org_id, _biz_id),
      _txn.transaction_date,
      'BRECON-' || substr(_txn_id::text, 1, 8),
      'Bank reconciliation: manual operation',
      'bank_reconciliation', _txn_id, _user_id, false, false,
      CASE WHEN _txn.transaction_type = 'credit' THEN
        jsonb_build_array(
          jsonb_build_object('account_id', _bank_gl_account, 'debit', _abs_amount, 'credit', 0,
            'description', 'Bank deposit: ' || _txn.description),
          jsonb_build_object('account_id', _offset_account_id, 'debit', 0, 'credit', _abs_amount,
            'description', 'Offset: ' || _txn.description)
        )
      ELSE
        jsonb_build_array(
          jsonb_build_object('account_id', _offset_account_id, 'debit', _abs_amount, 'credit', 0,
            'description', 'Offset: ' || _txn.description),
          jsonb_build_object('account_id', _bank_gl_account, 'debit', 0, 'credit', _abs_amount,
            'description', 'Bank withdrawal: ' || _txn.description)
        )
      END,
      NULL, NULL, NULL, _branch_id
    );
  END IF;

  UPDATE public.bank_transactions SET
    is_reconciled = true,
    reconciled_type = _recon_type,
    reconciled_entity_id = _entity_id,
    reconciled_at = now(),
    reconciled_by = _user_id,
    journal_entry_id = _je_id,
    reconciled_payment_id = coalesce(_payment_id, _bill_payment_id),
    category = coalesce(_category, category),
    lifecycle_status = 'reconciled',
    updated_at = now()
  WHERE id = _txn_id;

  INSERT INTO public.bank_reconciliation_matches (
    organization_id, business_id, branch_id, bank_transaction_id,
    matched_journal_entry_id, matched_payment_id, matched_bill_payment_id,
    matched_entity_type, matched_entity_id, matched_amount, residual_amount,
    match_type, status, confidence, notes, created_by, confirmed_by, confirmed_at
  ) VALUES (
    _org_id, _biz_id, _branch_id, _txn_id,
    CASE WHEN _recon_type = 'manual' AND NOT _create_gl THEN _entity_id ELSE _je_id END,
    _payment_id, _bill_payment_id,
    _recon_type, _entity_id, _abs_amount, 0,
    CASE WHEN _create_gl THEN 'manual' ELSE 'suggested' END,
    'confirmed', 1,
    'Confirmed by canonical bank reconciliation RPC',
    _user_id, _user_id, now()
  ) RETURNING id INTO _match_id;

  RETURN jsonb_build_object(
    'success', true,
    'journal_entry_id', _je_id,
    'payment_id', _payment_id,
    'bill_payment_id', _bill_payment_id,
    'reconciliation_match_id', _match_id
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.reconcile_bank_transaction_atomic(uuid, text, uuid, text, uuid, boolean, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_bank_transaction_atomic(uuid, text, uuid, text, uuid, boolean, uuid, text) TO service_role;