CREATE OR REPLACE FUNCTION public.unreconcile_bank_transaction(
  _bank_transaction_id uuid,
  _reason text DEFAULT NULL,
  _user_id uuid DEFAULT NULL
) RETURNS jsonb
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
  _link_only boolean := false;
  _cleared_bankings integer := 0;
BEGIN
  SELECT * INTO _txn FROM public.bank_transactions WHERE id = _bank_transaction_id FOR UPDATE;
  IF _txn.id IS NULL THEN
    RAISE EXCEPTION 'Bank transaction % not found', _bank_transaction_id;
  END IF;

  PERFORM public.assert_can_reconcile_bank(_txn.business_id);

  IF NOT COALESCE(_txn.is_reconciled, false) THEN
    RETURN jsonb_build_object('success', true, 'already_unreconciled', true);
  END IF;

  -- A banked collection batch posted its own journal entry when it was banked
  -- (Bank Dr / Cash + Mobile money Cr). Confirming the statement line only LINKED
  -- that entry; un-matching must therefore break the link and never void the
  -- institution's own correct posting.
  _link_only := COALESCE(_txn.reconciled_type, '') = 'collection_banking';

  IF _link_only THEN
    UPDATE public.mf_collection_bankings
       SET bank_transaction_id = NULL, updated_at = now()
     WHERE bank_transaction_id = _bank_transaction_id;
    GET DIAGNOSTICS _cleared_bankings = ROW_COUNT;
  ELSIF _txn.journal_entry_id IS NOT NULL THEN
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
    'bank_transaction_id', _bank_transaction_id,
    'reversed_matches', _reversed_matches,
    'reversed_writeoffs', _reversed_writeoffs,
    'voided_entries', _voided_entries,
    'link_only', _link_only,
    'released_bankings', _cleared_bankings,
    'reason', _reason
  );
END;
$$;