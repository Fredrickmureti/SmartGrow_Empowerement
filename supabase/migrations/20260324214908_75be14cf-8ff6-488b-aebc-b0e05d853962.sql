
-- R1: Bank reconciliation sessions table
CREATE TABLE public.bank_reconciliation_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  bank_account_id uuid NOT NULL REFERENCES public.bank_accounts(id) ON DELETE CASCADE,
  statement_date date NOT NULL,
  opening_balance numeric NOT NULL DEFAULT 0,
  closing_balance numeric NOT NULL DEFAULT 0,
  reconciled_balance numeric NOT NULL DEFAULT 0,
  difference numeric GENERATED ALWAYS AS (closing_balance - opening_balance - reconciled_balance) STORED,
  status text NOT NULL DEFAULT 'in_progress',
  completed_at timestamptz,
  completed_by uuid,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);

ALTER TABLE public.bank_reconciliation_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view reconciliation sessions"
  ON public.bank_reconciliation_sessions FOR SELECT TO authenticated
  USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can manage reconciliation sessions"
  ON public.bank_reconciliation_sessions FOR INSERT TO authenticated
  WITH CHECK (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can update reconciliation sessions"
  ON public.bank_reconciliation_sessions FOR UPDATE TO authenticated
  USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can delete reconciliation sessions"
  ON public.bank_reconciliation_sessions FOR DELETE TO authenticated
  USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

-- R4: Upgrade transaction_categorization_rules with auto-action columns
ALTER TABLE public.transaction_categorization_rules 
  ADD COLUMN IF NOT EXISTS auto_action text NOT NULL DEFAULT 'categorize_only',
  ADD COLUMN IF NOT EXISTS auto_offset_account_id uuid REFERENCES public.accounts(id),
  ADD COLUMN IF NOT EXISTS auto_post boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bank_account_id uuid REFERENCES public.bank_accounts(id),
  ADD COLUMN IF NOT EXISTS stop_processing boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS use_regex boolean NOT NULL DEFAULT false;

-- C2: Add reconciled_payment_id to bank_transactions (from previous migration that rolled back)
ALTER TABLE public.bank_transactions 
  ADD COLUMN IF NOT EXISTS reconciled_payment_id uuid DEFAULT NULL;

-- R2: Atomic bank transfer RPC
CREATE OR REPLACE FUNCTION public.reconcile_bank_transfer_atomic(
  _source_txn_id uuid,
  _dest_txn_id uuid DEFAULT NULL,
  _dest_bank_account_id uuid DEFAULT NULL,
  _user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _source_txn record;
  _dest_txn record;
  _source_gl uuid;
  _dest_gl uuid;
  _je_id uuid;
  _je_number text;
  _org_id uuid;
  _biz_id uuid;
  _abs_amount numeric;
BEGIN
  SELECT * INTO _source_txn FROM bank_transactions WHERE id = _source_txn_id FOR UPDATE;
  IF _source_txn IS NULL THEN RAISE EXCEPTION 'Source transaction not found'; END IF;
  IF _source_txn.is_reconciled THEN RAISE EXCEPTION 'Source transaction is already reconciled'; END IF;

  _org_id := _source_txn.organization_id;
  _biz_id := _source_txn.business_id;
  _abs_amount := abs(_source_txn.amount);

  SELECT account_id INTO _source_gl FROM bank_accounts WHERE id = _source_txn.bank_account_id;
  IF _source_gl IS NULL THEN RAISE EXCEPTION 'Source bank account has no GL account linked'; END IF;

  IF _dest_txn_id IS NOT NULL THEN
    SELECT * INTO _dest_txn FROM bank_transactions WHERE id = _dest_txn_id FOR UPDATE;
    IF _dest_txn IS NULL THEN RAISE EXCEPTION 'Destination transaction not found'; END IF;
    IF _dest_txn.is_reconciled THEN RAISE EXCEPTION 'Destination transaction already reconciled'; END IF;
    SELECT account_id INTO _dest_gl FROM bank_accounts WHERE id = _dest_txn.bank_account_id;
  ELSIF _dest_bank_account_id IS NOT NULL THEN
    SELECT account_id INTO _dest_gl FROM bank_accounts WHERE id = _dest_bank_account_id;
  END IF;

  IF _dest_gl IS NULL THEN RAISE EXCEPTION 'Destination bank account has no GL account linked'; END IF;
  IF _source_gl = _dest_gl THEN RAISE EXCEPTION 'Source and destination cannot be the same GL account'; END IF;

  SELECT 'JE-' || to_char(now(), 'YYYYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 6) INTO _je_number;

  INSERT INTO journal_entries (
    organization_id, business_id, entry_number, entry_date, description, reference,
    source_type, source_id, status, created_by, is_approved, approved_by, approved_at
  ) VALUES (
    _org_id, _biz_id, _je_number, _source_txn.transaction_date,
    'Bank transfer', 'BTRANSFER-' || substr(_source_txn_id::text, 1, 8),
    'bank_transfer', _source_txn_id::text, 'posted', _user_id, true, _user_id, now()
  ) RETURNING id INTO _je_id;

  IF _source_txn.transaction_type = 'debit' THEN
    INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description, sort_order)
    VALUES
      (_je_id, _dest_gl, _abs_amount, 0, 'Transfer in', 0),
      (_je_id, _source_gl, 0, _abs_amount, 'Transfer out', 1);
  ELSE
    INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description, sort_order)
    VALUES
      (_je_id, _source_gl, _abs_amount, 0, 'Transfer in', 0),
      (_je_id, _dest_gl, 0, _abs_amount, 'Transfer out', 1);
  END IF;

  UPDATE bank_transactions SET
    is_reconciled = true, reconciled_type = 'transfer',
    reconciled_entity_id = coalesce(_dest_txn_id::text, _dest_bank_account_id::text),
    reconciled_at = now(), reconciled_by = _user_id::text, journal_entry_id = _je_id
  WHERE id = _source_txn_id;

  IF _dest_txn_id IS NOT NULL THEN
    UPDATE bank_transactions SET
      is_reconciled = true, reconciled_type = 'transfer',
      reconciled_entity_id = _source_txn_id::text,
      reconciled_at = now(), reconciled_by = _user_id::text, journal_entry_id = _je_id
    WHERE id = _dest_txn_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'journal_entry_id', _je_id);
END;
$$;

-- C1: Re-create reconcile_bank_transaction_atomic (rolled back with previous migration)
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
BEGIN
  SELECT * INTO _txn FROM bank_transactions WHERE id = _txn_id FOR UPDATE;
  IF _txn IS NULL THEN RAISE EXCEPTION 'Bank transaction not found: %', _txn_id; END IF;
  IF _txn.is_reconciled THEN RAISE EXCEPTION 'Bank transaction is already reconciled'; END IF;

  _org_id := _txn.organization_id;
  _biz_id := _txn.business_id;
  _abs_amount := abs(_txn.amount);

  SELECT account_id INTO _bank_gl_account FROM bank_accounts WHERE id = _txn.bank_account_id;
  IF _bank_gl_account IS NULL THEN
    SELECT id INTO _bank_gl_account FROM accounts 
    WHERE organization_id = _org_id AND detail_type = 'checking' AND is_active = true LIMIT 1;
  END IF;

  IF _recon_type IN ('invoice', 'bill') AND _entity_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM bank_transactions 
      WHERE is_reconciled = true AND reconciled_entity_id = _entity_id::text
        AND reconciled_type = _recon_type AND id != _txn_id
    ) THEN
      RAISE EXCEPTION 'This % is already reconciled to another bank transaction', _recon_type;
    END IF;
  END IF;

  IF _recon_type = 'invoice' AND _entity_id IS NOT NULL THEN
    SELECT id INTO _ar_account FROM accounts 
    WHERE organization_id = _org_id AND detail_type = 'accounts_receivable' AND is_active = true LIMIT 1;

    SELECT public.get_next_receipt_number(_org_id) INTO _receipt_number;
    IF _receipt_number IS NULL THEN _receipt_number := 'RCP-BRECON-' || substr(_txn_id::text, 1, 8); END IF;

    INSERT INTO payments (
      organization_id, business_id, invoice_id, amount, payment_date,
      payment_method, reference, created_by, receipt_number, deposit_account_id, status
    ) VALUES (
      _org_id, _biz_id, _entity_id, _abs_amount, _txn.transaction_date,
      'bank_transfer', coalesce(_txn.reference, 'Bank recon: ' || _txn.description),
      _user_id, _receipt_number::text, _bank_gl_account, 'applied'
    ) RETURNING id INTO _payment_id;

    SELECT total, amount_paid INTO _entity_record FROM invoices WHERE id = _entity_id FOR UPDATE;
    _new_amount_paid := coalesce(_entity_record.amount_paid, 0) + _abs_amount;
    _new_status := CASE WHEN _new_amount_paid >= _entity_record.total THEN 'paid' ELSE 'partial' END;
    UPDATE invoices SET amount_paid = _new_amount_paid, status = _new_status WHERE id = _entity_id;

    IF _bank_gl_account IS NOT NULL AND _ar_account IS NOT NULL THEN
      SELECT 'JE-' || to_char(now(), 'YYYYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 6) INTO _je_number;
      INSERT INTO journal_entries (
        organization_id, business_id, entry_number, entry_date, description, reference,
        source_type, source_id, status, created_by, is_approved, approved_by, approved_at
      ) VALUES (
        _org_id, _biz_id, _je_number, _txn.transaction_date, 
        'Bank reconciliation: payment for invoice matched',
        'BRECON-' || substr(_txn_id::text, 1, 8),
        'bank_recon', _txn_id::text, 'posted', _user_id, true, _user_id, now()
      ) RETURNING id INTO _je_id;

      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description, sort_order)
      VALUES
        (_je_id, _bank_gl_account, _abs_amount, 0, 'Bank deposit: ' || _txn.description, 0),
        (_je_id, _ar_account, 0, _abs_amount, 'AR cleared: ' || _txn.description, 1);

      UPDATE payments SET journal_entry_id = _je_id WHERE id = _payment_id;
    END IF;

  ELSIF _recon_type = 'bill' AND _entity_id IS NOT NULL THEN
    SELECT id INTO _ap_account FROM accounts 
    WHERE organization_id = _org_id AND detail_type = 'accounts_payable' AND is_active = true LIMIT 1;

    INSERT INTO bill_payments (
      organization_id, business_id, bill_id, amount, payment_date,
      payment_method, reference, created_by, bank_account_id
    ) VALUES (
      _org_id, _biz_id, _entity_id, _abs_amount, _txn.transaction_date,
      'bank_transfer', coalesce(_txn.reference, 'Bank recon: ' || _txn.description),
      _user_id, _txn.bank_account_id
    ) RETURNING id INTO _bill_payment_id;

    SELECT total, amount_paid INTO _entity_record FROM bills WHERE id = _entity_id FOR UPDATE;
    _new_amount_paid := coalesce(_entity_record.amount_paid, 0) + _abs_amount;
    _new_status := CASE WHEN _new_amount_paid >= _entity_record.total THEN 'paid' ELSE 'partial' END;
    UPDATE bills SET amount_paid = _new_amount_paid, status = _new_status WHERE id = _entity_id;

    IF _bank_gl_account IS NOT NULL AND _ap_account IS NOT NULL THEN
      SELECT 'JE-' || to_char(now(), 'YYYYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 6) INTO _je_number;
      INSERT INTO journal_entries (
        organization_id, business_id, entry_number, entry_date, description, reference,
        source_type, source_id, status, created_by, is_approved, approved_by, approved_at
      ) VALUES (
        _org_id, _biz_id, _je_number, _txn.transaction_date,
        'Bank reconciliation: bill payment matched',
        'BRECON-' || substr(_txn_id::text, 1, 8),
        'bank_recon', _txn_id::text, 'posted', _user_id, true, _user_id, now()
      ) RETURNING id INTO _je_id;

      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description, sort_order)
      VALUES
        (_je_id, _ap_account, _abs_amount, 0, 'AP cleared: ' || _txn.description, 0),
        (_je_id, _bank_gl_account, 0, _abs_amount, 'Bank withdrawal: ' || _txn.description, 1);

      UPDATE bill_payments SET journal_entry_id = _je_id WHERE id = _bill_payment_id;
    END IF;

  ELSIF _recon_type = 'manual' AND _create_gl AND _offset_account_id IS NOT NULL AND _bank_gl_account IS NOT NULL THEN
    SELECT 'JE-' || to_char(now(), 'YYYYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 6) INTO _je_number;
    INSERT INTO journal_entries (
      organization_id, business_id, entry_number, entry_date, description, reference,
      source_type, source_id, status, created_by, is_approved, approved_by, approved_at
    ) VALUES (
      _org_id, _biz_id, _je_number, _txn.transaction_date,
      'Bank reconciliation: manual match', 'BRECON-' || substr(_txn_id::text, 1, 8),
      'bank_recon', _txn_id::text, 'posted', _user_id, true, _user_id, now()
    ) RETURNING id INTO _je_id;

    IF _txn.transaction_type = 'credit' THEN
      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description, sort_order)
      VALUES
        (_je_id, _bank_gl_account, _abs_amount, 0, 'Bank deposit: ' || _txn.description, 0),
        (_je_id, _offset_account_id, 0, _abs_amount, 'Offset: ' || _txn.description, 1);
    ELSE
      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description, sort_order)
      VALUES
        (_je_id, _offset_account_id, _abs_amount, 0, 'Offset: ' || _txn.description, 0),
        (_je_id, _bank_gl_account, 0, _abs_amount, 'Bank withdrawal: ' || _txn.description, 1);
    END IF;
  END IF;

  UPDATE bank_transactions SET
    is_reconciled = true, reconciled_type = _recon_type,
    reconciled_entity_id = CASE WHEN _entity_id IS NOT NULL THEN _entity_id::text ELSE NULL END,
    reconciled_at = now(), reconciled_by = _user_id::text,
    journal_entry_id = _je_id,
    reconciled_payment_id = coalesce(_payment_id, _bill_payment_id),
    category = coalesce(_category, category)
  WHERE id = _txn_id;

  RETURN jsonb_build_object(
    'success', true, 'journal_entry_id', _je_id,
    'payment_id', _payment_id, 'bill_payment_id', _bill_payment_id
  );
END;
$$;

-- C5: Re-create update_journal_entry_atomic (rolled back with previous migration)
CREATE OR REPLACE FUNCTION public.update_journal_entry_atomic(
  _entry_id uuid,
  _entry_date date,
  _description text,
  _reference text DEFAULT NULL,
  _is_adjusting boolean DEFAULT false,
  _is_closing boolean DEFAULT false,
  _lines jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _entry record;
  _total_debit numeric := 0;
  _total_credit numeric := 0;
  _line jsonb;
  _idx int := 0;
BEGIN
  SELECT * INTO _entry FROM journal_entries WHERE id = _entry_id FOR UPDATE;
  IF _entry IS NULL THEN RAISE EXCEPTION 'Journal entry not found'; END IF;
  IF _entry.status != 'draft' THEN RAISE EXCEPTION 'Only draft entries can be updated (current status: %)', _entry.status; END IF;

  FOR _line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    _total_debit := _total_debit + coalesce((_line->>'debit')::numeric, 0);
    _total_credit := _total_credit + coalesce((_line->>'credit')::numeric, 0);
  END LOOP;

  IF abs(_total_debit - _total_credit) > 0.01 THEN
    RAISE EXCEPTION 'Debits (%) must equal credits (%)', _total_debit, _total_credit;
  END IF;

  UPDATE journal_entries SET
    entry_date = _entry_date, description = _description, reference = _reference,
    is_adjusting = _is_adjusting, is_closing = _is_closing, updated_at = now()
  WHERE id = _entry_id;

  DELETE FROM journal_entry_lines WHERE journal_entry_id = _entry_id;

  FOR _line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    INSERT INTO journal_entry_lines (
      journal_entry_id, account_id, description, debit, credit, contact_id, sort_order
    ) VALUES (
      _entry_id, (_line->>'account_id')::uuid, _line->>'description',
      coalesce((_line->>'debit')::numeric, 0), coalesce((_line->>'credit')::numeric, 0),
      CASE WHEN _line->>'contact_id' IS NOT NULL THEN (_line->>'contact_id')::uuid ELSE NULL END,
      _idx
    );
    _idx := _idx + 1;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'entry_id', _entry_id);
END;
$$;
