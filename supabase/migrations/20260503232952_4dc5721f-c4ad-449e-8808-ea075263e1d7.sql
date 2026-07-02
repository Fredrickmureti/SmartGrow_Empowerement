-- Phase 13 — Bank Reconciliation hardening (branch + finance.reconcile_bank)

-- 1. Add branch_id to bank_reconciliation_sessions and backfill from bank_accounts
ALTER TABLE public.bank_reconciliation_sessions
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_brs_branch
  ON public.bank_reconciliation_sessions(business_id, branch_id);

UPDATE public.bank_reconciliation_sessions s
   SET branch_id = ba.branch_id
  FROM public.bank_accounts ba
 WHERE s.bank_account_id = ba.id
   AND s.branch_id IS DISTINCT FROM ba.branch_id;

-- 2. assert_can_reconcile_bank helper
CREATE OR REPLACE FUNCTION public.assert_can_reconcile_bank(_business_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_finance_permission(auth.uid(), 'finance.reconcile_bank', _business_id) THEN
    RAISE EXCEPTION 'INSUFFICIENT_PRIVILEGE_RECONCILE: caller lacks finance.reconcile_bank for business %', _business_id
      USING ERRCODE = '42501';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_can_reconcile_bank(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.assert_can_reconcile_bank(uuid) TO authenticated;

COMMENT ON FUNCTION public.assert_can_reconcile_bank(uuid) IS
'Phase 13: raises 42501 INSUFFICIENT_PRIVILEGE_RECONCILE when caller lacks finance.reconcile_bank for the given business.';

-- 3. Replace org-only RLS on bank_reconciliation_sessions with perm + branch policies
DROP POLICY IF EXISTS "Users can view reconciliation sessions" ON public.bank_reconciliation_sessions;
DROP POLICY IF EXISTS "Users can manage reconciliation sessions" ON public.bank_reconciliation_sessions;
DROP POLICY IF EXISTS "Users can update reconciliation sessions" ON public.bank_reconciliation_sessions;
DROP POLICY IF EXISTS "Users can delete reconciliation sessions" ON public.bank_reconciliation_sessions;
DROP POLICY IF EXISTS bank_recon_sessions_select_perm_v1 ON public.bank_reconciliation_sessions;
DROP POLICY IF EXISTS bank_recon_sessions_insert_perm_v1 ON public.bank_reconciliation_sessions;
DROP POLICY IF EXISTS bank_recon_sessions_update_perm_v1 ON public.bank_reconciliation_sessions;
DROP POLICY IF EXISTS bank_recon_sessions_delete_perm_v1 ON public.bank_reconciliation_sessions;

CREATE POLICY bank_recon_sessions_select_perm_v1
  ON public.bank_reconciliation_sessions
  FOR SELECT TO authenticated
  USING (
    business_id IS NOT NULL
    AND public.user_can_access_business(auth.uid(), business_id)
    AND (
      branch_id IS NULL
      OR public.user_can_access_branch(auth.uid(), branch_id)
      OR public.has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id)
    )
  );

CREATE POLICY bank_recon_sessions_insert_perm_v1
  ON public.bank_reconciliation_sessions
  FOR INSERT TO authenticated
  WITH CHECK (
    business_id IS NOT NULL
    AND public.user_can_access_business(auth.uid(), business_id)
    AND public.has_finance_permission(auth.uid(), 'finance.reconcile_bank', business_id)
    AND (
      branch_id IS NULL
      OR public.user_can_access_branch(auth.uid(), branch_id)
      OR public.has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id)
    )
  );

CREATE POLICY bank_recon_sessions_update_perm_v1
  ON public.bank_reconciliation_sessions
  FOR UPDATE TO authenticated
  USING (
    business_id IS NOT NULL
    AND public.user_can_access_business(auth.uid(), business_id)
    AND public.has_finance_permission(auth.uid(), 'finance.reconcile_bank', business_id)
    AND (
      branch_id IS NULL
      OR public.user_can_access_branch(auth.uid(), branch_id)
      OR public.has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id)
    )
  )
  WITH CHECK (
    business_id IS NOT NULL
    AND public.user_can_access_business(auth.uid(), business_id)
    AND public.has_finance_permission(auth.uid(), 'finance.reconcile_bank', business_id)
    AND (
      branch_id IS NULL
      OR public.user_can_access_branch(auth.uid(), branch_id)
      OR public.has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id)
    )
  );

CREATE POLICY bank_recon_sessions_delete_perm_v1
  ON public.bank_reconciliation_sessions
  FOR DELETE TO authenticated
  USING (
    business_id IS NOT NULL
    AND public.user_can_access_business(auth.uid(), business_id)
    AND public.has_finance_permission(auth.uid(), 'finance.reconcile_bank', business_id)
    AND (
      branch_id IS NULL
      OR public.user_can_access_branch(auth.uid(), branch_id)
      OR public.has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id)
    )
  );

-- 4. Tighten bank_reconciliation_matches write to finance.reconcile_bank + branch
DROP POLICY IF EXISTS "bank_recon_matches_write" ON public.bank_reconciliation_matches;
DROP POLICY IF EXISTS bank_recon_matches_write_perm_v1 ON public.bank_reconciliation_matches;
CREATE POLICY bank_recon_matches_write_perm_v1
  ON public.bank_reconciliation_matches
  FOR ALL TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.has_finance_permission(auth.uid(), 'finance.reconcile_bank', business_id)
    AND (
      branch_id IS NULL
      OR public.user_can_access_branch(auth.uid(), branch_id)
      OR public.has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id)
    )
  )
  WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.has_finance_permission(auth.uid(), 'finance.reconcile_bank', business_id)
    AND (
      branch_id IS NULL
      OR public.user_can_access_branch(auth.uid(), branch_id)
      OR public.has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id)
    )
  );

-- 5. Replace reconcile_bank_transaction_atomic with perm + offset-branch check
CREATE OR REPLACE FUNCTION public.reconcile_bank_transaction_atomic(
  _txn_id uuid,
  _recon_type text,
  _entity_id uuid DEFAULT NULL,
  _category text DEFAULT NULL,
  _offset_account_id uuid DEFAULT NULL,
  _create_gl boolean DEFAULT true,
  _user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  _new_amount_paid numeric;
  _new_status text;
  _je_number text;
  _match_id uuid;
  _offset_business uuid;
  _offset_branch uuid;
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

  -- Phase 13: server-side permission gate
  PERFORM public.assert_can_reconcile_bank(_biz_id);

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
    -- Phase 13: offset account must be company-wide OR same branch as the txn
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

    SELECT total, amount_paid, business_id INTO _entity_record
    FROM public.invoices
    WHERE id = _entity_id
    FOR UPDATE;
    IF NOT FOUND OR _entity_record.business_id IS DISTINCT FROM _biz_id THEN
      RAISE EXCEPTION 'Invoice not found in the selected company';
    END IF;

    SELECT public.get_next_receipt_number(_org_id) INTO _receipt_number;
    IF _receipt_number IS NULL THEN
      _receipt_number := 'RCP-BRECON-' || substr(_txn_id::text, 1, 8);
    END IF;

    INSERT INTO public.payments (
      organization_id, business_id, branch_id, invoice_id, amount, payment_date,
      payment_method, reference, created_by, receipt_number, deposit_account_id, status
    ) VALUES (
      _org_id, _biz_id, _branch_id, _entity_id, _abs_amount, _txn.transaction_date,
      'bank_transfer', coalesce(_txn.reference, 'Bank recon: ' || _txn.description),
      _user_id, _receipt_number::text, _bank_gl_account, 'applied'
    ) RETURNING id INTO _payment_id;

    _new_amount_paid := coalesce(_entity_record.amount_paid, 0) + _abs_amount;
    _new_status := CASE WHEN _new_amount_paid >= _entity_record.total THEN 'paid' ELSE 'partial' END;
    UPDATE public.invoices SET amount_paid = _new_amount_paid, status = _new_status WHERE id = _entity_id;

    IF _bank_gl_account IS NOT NULL AND _ar_account IS NOT NULL THEN
      SELECT 'JE-' || to_char(now(), 'YYYYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 6) INTO _je_number;
      INSERT INTO public.journal_entries (
        organization_id, business_id, branch_id, entry_number, entry_date, description, reference,
        source_type, source_id, status, created_by, is_approved, approved_by, approved_at
      ) VALUES (
        _org_id, _biz_id, _branch_id, _je_number, _txn.transaction_date,
        'Bank reconciliation: payment for invoice matched',
        'BRECON-' || substr(_txn_id::text, 1, 8),
        'bank_reconciliation', _txn_id, 'posted', _user_id, true, _user_id, now()
      ) RETURNING id INTO _je_id;

      INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, business_id, branch_id, debit, credit, description, sort_order)
      VALUES
        (_je_id, _bank_gl_account, _biz_id, _branch_id, _abs_amount, 0, 'Bank deposit: ' || _txn.description, 0),
        (_je_id, _ar_account, _biz_id, _branch_id, 0, _abs_amount, 'AR cleared: ' || _txn.description, 1);

      UPDATE public.payments SET journal_entry_id = _je_id WHERE id = _payment_id;
    END IF;

  ELSIF _recon_type = 'bill' AND _entity_id IS NOT NULL THEN
    SELECT id INTO _ap_account
    FROM public.accounts
    WHERE organization_id = _org_id
      AND business_id = _biz_id
      AND detail_type = 'accounts_payable'
      AND is_active = true
    LIMIT 1;

    SELECT total, amount_paid, business_id INTO _entity_record
    FROM public.bills
    WHERE id = _entity_id
    FOR UPDATE;
    IF NOT FOUND OR _entity_record.business_id IS DISTINCT FROM _biz_id THEN
      RAISE EXCEPTION 'Bill not found in the selected company';
    END IF;

    INSERT INTO public.bill_payments (
      organization_id, business_id, branch_id, bill_id, amount, payment_date,
      payment_method, reference, created_by, bank_account_id
    ) VALUES (
      _org_id, _biz_id, _branch_id, _entity_id, _abs_amount, _txn.transaction_date,
      'bank_transfer', coalesce(_txn.reference, 'Bank recon: ' || _txn.description),
      _user_id, _txn.bank_account_id
    ) RETURNING id INTO _bill_payment_id;

    _new_amount_paid := coalesce(_entity_record.amount_paid, 0) + _abs_amount;
    _new_status := CASE WHEN _new_amount_paid >= _entity_record.total THEN 'paid' ELSE 'partial' END;
    UPDATE public.bills SET amount_paid = _new_amount_paid, status = _new_status WHERE id = _entity_id;

    IF _bank_gl_account IS NOT NULL AND _ap_account IS NOT NULL THEN
      SELECT 'JE-' || to_char(now(), 'YYYYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 6) INTO _je_number;
      INSERT INTO public.journal_entries (
        organization_id, business_id, branch_id, entry_number, entry_date, description, reference,
        source_type, source_id, status, created_by, is_approved, approved_by, approved_at
      ) VALUES (
        _org_id, _biz_id, _branch_id, _je_number, _txn.transaction_date,
        'Bank reconciliation: bill payment matched',
        'BRECON-' || substr(_txn_id::text, 1, 8),
        'bank_reconciliation', _txn_id, 'posted', _user_id, true, _user_id, now()
      ) RETURNING id INTO _je_id;

      INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, business_id, branch_id, debit, credit, description, sort_order)
      VALUES
        (_je_id, _ap_account, _biz_id, _branch_id, _abs_amount, 0, 'AP cleared: ' || _txn.description, 0),
        (_je_id, _bank_gl_account, _biz_id, _branch_id, 0, _abs_amount, 'Bank withdrawal: ' || _txn.description, 1);

      UPDATE public.bill_payments SET journal_entry_id = _je_id WHERE id = _bill_payment_id;
    END IF;

  ELSIF _recon_type = 'manual' AND _create_gl AND _offset_account_id IS NOT NULL AND _bank_gl_account IS NOT NULL THEN
    SELECT 'JE-' || to_char(now(), 'YYYYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 6) INTO _je_number;
    INSERT INTO public.journal_entries (
      organization_id, business_id, branch_id, entry_number, entry_date, description, reference,
      source_type, source_id, status, created_by, is_approved, approved_by, approved_at
    ) VALUES (
      _org_id, _biz_id, _branch_id, _je_number, _txn.transaction_date,
      'Bank reconciliation: manual operation', 'BRECON-' || substr(_txn_id::text, 1, 8),
      'bank_reconciliation', _txn_id, 'posted', _user_id, true, _user_id, now()
    ) RETURNING id INTO _je_id;

    IF _txn.transaction_type = 'credit' THEN
      INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, business_id, branch_id, debit, credit, description, sort_order)
      VALUES
        (_je_id, _bank_gl_account, _biz_id, _branch_id, _abs_amount, 0, 'Bank deposit: ' || _txn.description, 0),
        (_je_id, _offset_account_id, _biz_id, _branch_id, 0, _abs_amount, 'Offset: ' || _txn.description, 1);
    ELSE
      INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, business_id, branch_id, debit, credit, description, sort_order)
      VALUES
        (_je_id, _offset_account_id, _biz_id, _branch_id, _abs_amount, 0, 'Offset: ' || _txn.description, 0),
        (_je_id, _bank_gl_account, _biz_id, _branch_id, 0, _abs_amount, 'Bank withdrawal: ' || _txn.description, 1);
    END IF;
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
$$;

REVOKE ALL ON FUNCTION public.reconcile_bank_transaction_atomic(uuid, text, uuid, text, uuid, boolean, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.reconcile_bank_transaction_atomic(uuid, text, uuid, text, uuid, boolean, uuid) TO authenticated;

-- 6. Replace unreconcile_bank_transaction with perm gate
CREATE OR REPLACE FUNCTION public.unreconcile_bank_transaction(
  _bank_transaction_id uuid,
  _reason text DEFAULT NULL,
  _user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _txn record;
  _writeoff record;
  _reversed_matches integer := 0;
  _reversed_writeoffs integer := 0;
  _voided_entries integer := 0;
BEGIN
  SELECT * INTO _txn FROM public.bank_transactions WHERE id = _bank_transaction_id FOR UPDATE;
  IF _txn.id IS NULL THEN
    RAISE EXCEPTION 'Bank transaction % not found', _bank_transaction_id;
  END IF;

  -- Phase 13: server-side permission gate
  PERFORM public.assert_can_reconcile_bank(_txn.business_id);

  IF _txn.journal_entry_id IS NOT NULL THEN
    PERFORM public.void_journal_entry_atomic(
      _txn.journal_entry_id,
      COALESCE(_reason, 'Bank transaction unreconciled'),
      _user_id,
      NULL,
      COALESCE(_txn.transaction_date, CURRENT_DATE)
    );
    _voided_entries := _voided_entries + 1;
  END IF;

  FOR _writeoff IN
    SELECT w.*
    FROM public.bank_reconciliation_writeoffs w
    JOIN public.bank_reconciliation_matches m ON m.id = w.reconciliation_match_id
    WHERE m.bank_transaction_id = _bank_transaction_id
      AND w.status IN ('draft','posted')
  LOOP
    IF _writeoff.journal_entry_id IS NOT NULL THEN
      PERFORM public.void_journal_entry_atomic(
        _writeoff.journal_entry_id,
        COALESCE(_reason, 'Bank reconciliation write-off unreconciled'),
        _user_id,
        COALESCE(_txn.transaction_date, CURRENT_DATE)
      );
      _voided_entries := _voided_entries + 1;
    END IF;
  END LOOP;

  UPDATE public.bank_reconciliation_writeoffs w
     SET status = 'reversed',
         reversed_by = _user_id,
         reversed_at = now(),
         updated_at = now()
    FROM public.bank_reconciliation_matches m
   WHERE w.reconciliation_match_id = m.id
     AND m.bank_transaction_id = _bank_transaction_id
     AND w.status IN ('draft','posted');
  GET DIAGNOSTICS _reversed_writeoffs = ROW_COUNT;

  UPDATE public.bank_reconciliation_matches
     SET status = 'reversed',
         reversed_by = _user_id,
         reversed_at = now(),
         notes = trim(both from concat_ws(' | ', notes, 'Unreconciled: ' || COALESCE(_reason, 'No reason provided'))),
         updated_at = now()
   WHERE bank_transaction_id = _bank_transaction_id
     AND status IN ('suggested','to_check','confirmed');
  GET DIAGNOSTICS _reversed_matches = ROW_COUNT;

  IF _txn.reconciled_type = 'invoice' AND _txn.reconciled_payment_id IS NOT NULL THEN
    UPDATE public.payments
       SET status = 'unreconciled',
           unreconciled_at = now(),
           unreconciled_by = _user_id,
           unreconcile_reason = COALESCE(_reason, 'Bank transaction unreconciled')
     WHERE id = _txn.reconciled_payment_id;
  END IF;

  UPDATE public.bank_transactions
     SET is_reconciled = false,
         reconciled_type = NULL,
         reconciled_entity_id = NULL,
         reconciled_at = NULL,
         reconciled_by = NULL,
         journal_entry_id = NULL,
         reconciled_payment_id = NULL,
         match_confidence = NULL,
         match_source = 'unreconciled',
         lifecycle_status = 'for_review',
         updated_at = now()
   WHERE id = _bank_transaction_id;

  RETURN jsonb_build_object(
    'success', true,
    'reversed_matches', _reversed_matches,
    'reversed_writeoffs', _reversed_writeoffs,
    'voided_entries', _voided_entries
  );
END;
$$;

REVOKE ALL ON FUNCTION public.unreconcile_bank_transaction(uuid, text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.unreconcile_bank_transaction(uuid, text, uuid) TO authenticated;