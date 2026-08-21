-- Root cause: unreconcile_bank_transaction stamped match_source = 'unreconciled',
-- a value outside bank_transactions_match_source_check (manual | rule | ai).
-- A line that is not matched has no match source: the correct value is NULL.
-- Fixing the writer, not widening the vocabulary — 'unreconciled' is a
-- lifecycle fact (lifecycle_status = 'for_review', is_reconciled = false),
-- never a way of matching.

CREATE OR REPLACE FUNCTION public.unreconcile_bank_transaction(_bank_transaction_id uuid, _reason text DEFAULT NULL::text, _user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _txn record;
  _m public.bank_reconciliation_matches;
  _writeoff record;
  _reversed_matches integer := 0;
  _reversed_writeoffs integer := 0;
  _voided_entries integer := 0;
  _kind text;
  _rdate date;
BEGIN
  SELECT * INTO _txn FROM public.bank_transactions WHERE id = _bank_transaction_id FOR UPDATE;
  IF _txn.id IS NULL THEN
    RAISE EXCEPTION 'Bank transaction % not found', _bank_transaction_id;
  END IF;

  PERFORM public.assert_can_reconcile_bank(_txn.business_id);

  IF NOT COALESCE(_txn.is_reconciled, false) THEN
    RETURN jsonb_build_object('success', true, 'already_unreconciled', true);
  END IF;

  _rdate := COALESCE(_txn.transaction_date, CURRENT_DATE);
  IF NOT public.is_period_open(_txn.business_id, _rdate) THEN
    RAISE EXCEPTION 'BANK_UNRECONCILE_PERIOD_LOCKED' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO _m
    FROM public.bank_reconciliation_matches
   WHERE bank_transaction_id = _bank_transaction_id
     AND status = 'confirmed'
   ORDER BY confirmed_at DESC NULLS LAST
   LIMIT 1
   FOR UPDATE;

  _kind := COALESCE(_m.matched_entity_type, _txn.reconciled_type);

  -- 1. Settlements the seam created are reversed by their own writer, so the
  --    document balance is recomputed from live allocations.
  IF _kind = 'invoice' THEN
    IF _m.matched_payment_id IS NULL THEN
      RAISE EXCEPTION 'BANK_UNRECONCILE_MISSING_SETTLEMENT: this line settled an invoice but its payment record is missing — reverse the payment first'
        USING ERRCODE = '22023';
    END IF;
    PERFORM public.void_payment_atomic(
      _payment_id := _m.matched_payment_id,
      _reason := COALESCE(_reason, 'Bank transaction unreconciled'),
      _reason_code := NULL,
      _void_date := _rdate,
      _actor := _user_id,
      _client_request_id := 'bunrec:' || _bank_transaction_id::text
    );
    _voided_entries := _voided_entries + 1;

  ELSIF _kind = 'bill' THEN
    IF _m.matched_bill_payment_id IS NULL THEN
      RAISE EXCEPTION 'BANK_UNRECONCILE_MISSING_SETTLEMENT: this line settled a bill but its payment record is missing — reverse the payment first'
        USING ERRCODE = '22023';
    END IF;
    PERFORM public.void_bill_payment_atomic(
      _bill_payment_id := _m.matched_bill_payment_id,
      _reason := COALESCE(_reason, 'Bank transaction unreconciled'),
      _void_date := _rdate,
      _actor := _user_id,
      _client_request_id := 'bunrec:' || _bank_transaction_id::text,
      _reason_code := NULL
    );
    _voided_entries := _voided_entries + 1;

  ELSIF _txn.journal_entry_id IS NOT NULL THEN
    PERFORM public.void_journal_entry_atomic(
      _txn.journal_entry_id,
      COALESCE(_reason, 'Bank transaction unreconciled'),
      _user_id,
      NULL,
      _rdate
    );
    _voided_entries := _voided_entries + 1;
  END IF;

  -- 2. Residual and bank-charge entries.
  IF _m.adjustment_journal_entry_id IS NOT NULL THEN
    PERFORM public.void_journal_entry_atomic(_m.adjustment_journal_entry_id,
      COALESCE(_reason, 'Bank transaction unreconciled'), _user_id, NULL, _rdate);
    _voided_entries := _voided_entries + 1;
  END IF;
  IF _m.fee_journal_entry_id IS NOT NULL THEN
    PERFORM public.void_journal_entry_atomic(_m.fee_journal_entry_id,
      COALESCE(_reason, 'Bank transaction unreconciled'), _user_id, NULL, _rdate);
    _voided_entries := _voided_entries + 1;
  END IF;

  -- 3. Write-offs raised on this line.
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
        NULL,
        _rdate
      );
      _voided_entries := _voided_entries + 1;
    END IF;
  END LOOP;

  UPDATE public.bank_reconciliation_writeoffs w
     SET status = 'reversed', reversed_by = _user_id, reversed_at = now(), updated_at = now()
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

  -- 4. A transfer's mirror line is released with its source.
  IF _kind = 'transfer' AND _txn.journal_entry_id IS NOT NULL THEN
    UPDATE public.bank_transactions
       SET is_reconciled = false, reconciled_type = NULL, reconciled_entity_id = NULL,
           reconciled_at = NULL, reconciled_by = NULL, journal_entry_id = NULL,
           lifecycle_status = 'for_review', match_source = NULL, updated_at = now()
     WHERE journal_entry_id = _txn.journal_entry_id
       AND id <> _bank_transaction_id
       AND business_id = _txn.business_id;
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
         match_source = NULL,
         lifecycle_status = 'for_review',
         updated_at = now()
   WHERE id = _bank_transaction_id;

  RETURN jsonb_build_object(
    'success', true,
    'resolution', _kind,
    'reversed_matches', _reversed_matches,
    'reversed_writeoffs', _reversed_writeoffs,
    'voided_entries', _voided_entries
  );
END;
$function$;
