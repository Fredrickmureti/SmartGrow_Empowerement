CREATE OR REPLACE FUNCTION public.bank_unmatch_preflight(_bank_transaction_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _txn record;
  _m public.bank_reconciliation_matches;
  _kind text;
  _rdate date;
  _je record;
  _link_only boolean;
BEGIN
  SELECT * INTO _txn FROM public.bank_transactions WHERE id = _bank_transaction_id;
  IF _txn.id IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'code', 'BANK_TRANSACTION_NOT_FOUND',
      'reason', 'This bank line no longer exists.', 'requires', NULL);
  END IF;

  IF NOT public.has_finance_permission(auth.uid(), 'finance.reconcile_bank', _txn.business_id) THEN
    RETURN jsonb_build_object('allowed', false, 'code', 'INSUFFICIENT_PRIVILEGE_RECONCILE',
      'reason', 'You do not have permission to reconcile bank accounts for this business.',
      'requires', 'finance.reconcile_bank');
  END IF;

  IF NOT COALESCE(_txn.is_reconciled, false) THEN
    RETURN jsonb_build_object('allowed', false, 'code', 'ALREADY_UNRECONCILED',
      'reason', 'This bank line is not reconciled, so there is nothing to undo.', 'requires', NULL);
  END IF;

  _rdate := COALESCE(_txn.transaction_date, CURRENT_DATE);
  IF NOT public.is_period_open(_txn.business_id, _rdate) THEN
    RETURN jsonb_build_object('allowed', false, 'code', 'BANK_UNRECONCILE_PERIOD_LOCKED',
      'reason', format('The accounting period containing %s is closed. Reopen the period, or post a correcting entry in an open period.', _rdate),
      'requires', 'open_period');
  END IF;

  SELECT * INTO _m
    FROM public.bank_reconciliation_matches
   WHERE bank_transaction_id = _bank_transaction_id
     AND status = 'confirmed'
   ORDER BY confirmed_at DESC NULLS LAST
   LIMIT 1;

  _kind := COALESCE(_m.matched_entity_type, _txn.reconciled_type);

  -- A banked collection batch was posted when it was banked; confirming the
  -- statement line only linked that entry, so un-matching is link-only.
  _link_only := COALESCE(_kind, '') = 'collection_banking';

  IF _kind = 'invoice' AND _m.matched_payment_id IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'code', 'BANK_UNRECONCILE_MISSING_SETTLEMENT',
      'reason', 'This line settled an invoice but its payment record is missing. Reverse the payment first.',
      'requires', 'payment_record');
  END IF;

  IF _kind = 'bill' AND _m.matched_bill_payment_id IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'code', 'BANK_UNRECONCILE_MISSING_SETTLEMENT',
      'reason', 'This line settled a bill but its payment record is missing. Reverse the payment first.',
      'requires', 'payment_record');
  END IF;

  IF NOT _link_only AND _txn.journal_entry_id IS NOT NULL THEN
    SELECT status, is_reversal, reversal_of_id INTO _je
      FROM public.journal_entries WHERE id = _txn.journal_entry_id;
    IF COALESCE(_je.is_reversal, false) OR _je.reversal_of_id IS NOT NULL THEN
      RETURN jsonb_build_object('allowed', false, 'code', 'BANK_UNRECONCILE_ENTRY_IS_REVERSAL',
        'reason', 'The posting behind this line is itself a reversal and cannot be voided again.',
        'requires', NULL);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'allowed', true,
    'code', 'OK',
    'reason', CASE
      WHEN _link_only THEN 'Un-matching will only unlink the banked collection batch; the accounting entry the banking created stays untouched, and the batch becomes available to match again.'
      WHEN _kind IN ('invoice','bill') THEN 'Un-matching will void the settlement payment and its posting.'
      WHEN _txn.journal_entry_id IS NOT NULL THEN 'Un-matching will void the journal entry this line created.'
      ELSE 'Un-matching will break the link only; no posting is affected.'
    END,
    'requires', CASE
      WHEN _link_only THEN 'link_only'
      WHEN _kind IN ('invoice','bill') THEN 'void_payment'
      WHEN _txn.journal_entry_id IS NOT NULL THEN 'void_journal_entry'
      ELSE 'link_only'
    END,
    'resolution', _kind
  );
END;
$$;