-- =====================================================================
-- Reconciliation engine · Phase 8 repairs
-- F10: a bank charge cannot ride on a clearing allocation that was already
--      posted directly into this bank account (the bank leg would net to
--      -fee instead of the statement amount).
-- F11: unreconciling an invoice/bill match whose settlement row is missing
--      must refuse, never void the settlement journal while leaving
--      invoices.amount_paid / bills.amount_paid overstated.
-- =====================================================================

CREATE OR REPLACE FUNCTION public._bank_match_validate(_txn bank_transactions, _allocations jsonb, _fee_amount numeric)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  _a jsonb;
  _kind text;
  _kinds text[] := '{}';
  _primaries text[];
  _primary text;
  _sum numeric := 0;
  _open numeric;
  _biz uuid;
  _branch uuid;
  _ccy text;
  _amt numeric;
  _inflow boolean;
  _bank_ccy text;
  _bank_gl uuid;
  _dep uuid;
  _status text;
  _pay_amount numeric;
  _required numeric;
  _dest_ccy text;
BEGIN
  IF _allocations IS NULL OR jsonb_typeof(_allocations) <> 'array' OR jsonb_array_length(_allocations) = 0 THEN
    RAISE EXCEPTION 'BANK_MATCH_NO_ALLOCATIONS' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(_fee_amount, 0) < 0 THEN
    RAISE EXCEPTION 'BANK_MATCH_NEGATIVE_FEE' USING ERRCODE = '22023';
  END IF;

  _inflow := COALESCE(_txn.transaction_type, CASE WHEN _txn.amount >= 0 THEN 'credit' ELSE 'debit' END) = 'credit';

  SELECT currency, account_id INTO _bank_ccy, _bank_gl
    FROM public.bank_accounts WHERE id = _txn.bank_account_id;

  FOR _a IN SELECT jsonb_array_elements(_allocations) LOOP
    _kind := COALESCE(_a->>'document_type', '');
    _amt := COALESCE((_a->>'amount')::numeric, 0);
    IF _amt <= 0 THEN
      RAISE EXCEPTION 'BANK_MATCH_NONPOSITIVE_ALLOCATION' USING ERRCODE = '22023';
    END IF;
    _sum := _sum + _amt;
    _kinds := _kinds || _kind;
    _biz := NULL; _branch := NULL; _ccy := NULL; _open := NULL; _dep := NULL;

    IF _kind = 'invoice' THEN
      IF NOT _inflow THEN
        RAISE EXCEPTION 'BANK_MATCH_DIRECTION_MISMATCH: an invoice is settled by money in' USING ERRCODE = '22023';
      END IF;
      SELECT business_id, branch_id, currency, GREATEST(COALESCE(total,0) - COALESCE(amount_paid,0), 0)
        INTO _biz, _branch, _ccy, _open
        FROM public.invoices WHERE id = (_a->>'document_id')::uuid;
      IF _biz IS NULL THEN RAISE EXCEPTION 'BANK_MATCH_DOCUMENT_NOT_FOUND' USING ERRCODE = '22023'; END IF;

    ELSIF _kind = 'bill' THEN
      IF _inflow THEN
        RAISE EXCEPTION 'BANK_MATCH_DIRECTION_MISMATCH: a bill is settled by money out' USING ERRCODE = '22023';
      END IF;
      SELECT business_id, branch_id, currency, GREATEST(COALESCE(total,0) - COALESCE(amount_paid,0), 0)
        INTO _biz, _branch, _ccy, _open
        FROM public.bills WHERE id = (_a->>'document_id')::uuid;
      IF _biz IS NULL THEN RAISE EXCEPTION 'BANK_MATCH_DOCUMENT_NOT_FOUND' USING ERRCODE = '22023'; END IF;

    ELSIF _kind = 'payment' THEN
      -- A receipt that already exists. This bank line is its deposit.
      IF NOT _inflow THEN
        RAISE EXCEPTION 'BANK_MATCH_DIRECTION_MISMATCH: a customer receipt is deposited by money in' USING ERRCODE = '22023';
      END IF;
      SELECT business_id, branch_id, deposit_account_id, status, amount
        INTO _biz, _branch, _dep, _status, _pay_amount
        FROM public.payments WHERE id = (_a->>'document_id')::uuid;
      IF _biz IS NULL THEN RAISE EXCEPTION 'BANK_MATCH_PAYMENT_NOT_FOUND' USING ERRCODE = '22023'; END IF;
      IF COALESCE(_status, '') IN ('voided', 'cancelled') THEN
        RAISE EXCEPTION 'BANK_MATCH_PAYMENT_VOIDED' USING ERRCODE = '22023';
      END IF;
      IF _dep IS NULL THEN
        RAISE EXCEPTION 'BANK_MATCH_PAYMENT_NO_DEPOSIT_ACCOUNT' USING ERRCODE = '22023';
      END IF;
      IF abs(_amt - COALESCE(_pay_amount, 0)) > 0.005 THEN
        RAISE EXCEPTION 'BANK_MATCH_PAYMENT_AMOUNT_MISMATCH: a receipt is deposited in full' USING ERRCODE = '22023';
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.bank_reconciliation_matches m
         WHERE m.status = 'confirmed'
           AND m.bank_transaction_id IS DISTINCT FROM _txn.id
           AND m.allocations @> jsonb_build_array(jsonb_build_object('document_type','payment','document_id', _a->>'document_id'))
      ) THEN
        RAISE EXCEPTION 'BANK_MATCH_PAYMENT_ALREADY_DEPOSITED' USING ERRCODE = '22023';
      END IF;
      -- F10: nothing is cleared when the receipt already landed in this very
      -- bank account, so a charge here would leave the bank leg short.
      IF _dep = _bank_gl AND COALESCE(_fee_amount, 0) > 0 THEN
        RAISE EXCEPTION 'BANK_MATCH_FEE_ON_DIRECT_PAYMENT: this receipt was already posted to this bank account — record the charge as its own bank line'
          USING ERRCODE = '22023';
      END IF;

    ELSIF _kind = 'bill_payment' THEN
      IF _inflow THEN
        RAISE EXCEPTION 'BANK_MATCH_DIRECTION_MISMATCH: a supplier payment clears by money out' USING ERRCODE = '22023';
      END IF;
      SELECT bp.business_id, bp.branch_id, bp.status, bp.amount, ba.account_id
        INTO _biz, _branch, _status, _pay_amount, _dep
        FROM public.bill_payments bp
        LEFT JOIN public.bank_accounts ba ON ba.id = bp.bank_account_id
       WHERE bp.id = (_a->>'document_id')::uuid;
      IF _biz IS NULL THEN RAISE EXCEPTION 'BANK_MATCH_PAYMENT_NOT_FOUND' USING ERRCODE = '22023'; END IF;
      IF COALESCE(_status, '') IN ('voided', 'cancelled') THEN
        RAISE EXCEPTION 'BANK_MATCH_PAYMENT_VOIDED' USING ERRCODE = '22023';
      END IF;
      IF abs(_amt - COALESCE(_pay_amount, 0)) > 0.005 THEN
        RAISE EXCEPTION 'BANK_MATCH_PAYMENT_AMOUNT_MISMATCH: a supplier payment clears in full' USING ERRCODE = '22023';
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.bank_reconciliation_matches m
         WHERE m.status = 'confirmed'
           AND m.bank_transaction_id IS DISTINCT FROM _txn.id
           AND m.allocations @> jsonb_build_array(jsonb_build_object('document_type','bill_payment','document_id', _a->>'document_id'))
      ) THEN
        RAISE EXCEPTION 'BANK_MATCH_PAYMENT_ALREADY_DEPOSITED' USING ERRCODE = '22023';
      END IF;
      IF _dep IS NOT NULL AND _dep = _bank_gl AND COALESCE(_fee_amount, 0) > 0 THEN
        RAISE EXCEPTION 'BANK_MATCH_FEE_ON_DIRECT_PAYMENT: this payment was already posted to this bank account — record the charge as its own bank line'
          USING ERRCODE = '22023';
      END IF;

    ELSIF _kind = 'transfer' THEN
      IF jsonb_array_length(_allocations) <> 1 THEN
        RAISE EXCEPTION 'BANK_MATCH_TRANSFER_SINGLE_ALLOCATION' USING ERRCODE = '22023';
      END IF;
      SELECT business_id, branch_id, currency INTO _biz, _branch, _dest_ccy
        FROM public.bank_accounts WHERE id = (_a->>'document_id')::uuid;
      IF _biz IS NULL THEN RAISE EXCEPTION 'BANK_MATCH_TRANSFER_ACCOUNT_NOT_FOUND' USING ERRCODE = '22023'; END IF;
      IF (_a->>'document_id')::uuid = _txn.bank_account_id THEN
        RAISE EXCEPTION 'BANK_MATCH_TRANSFER_SAME_ACCOUNT' USING ERRCODE = '22023';
      END IF;
      _ccy := _dest_ccy;
      _branch := NULL; -- a transfer counterparty account may live in another branch

    ELSIF _kind = 'account' THEN
      SELECT business_id INTO _biz FROM public.accounts WHERE id = (_a->>'document_id')::uuid;
      IF _biz IS NULL THEN RAISE EXCEPTION 'BANK_MATCH_ACCOUNT_NOT_FOUND' USING ERRCODE = '22023'; END IF;

    ELSE
      RAISE EXCEPTION 'BANK_MATCH_UNSUPPORTED_DOCUMENT_TYPE' USING ERRCODE = '22023';
    END IF;

    IF _biz IS DISTINCT FROM _txn.business_id THEN
      RAISE EXCEPTION 'BANK_MATCH_CROSS_COMPANY' USING ERRCODE = '42501';
    END IF;
    IF _branch IS NOT NULL AND _txn.branch_id IS NOT NULL AND _branch IS DISTINCT FROM _txn.branch_id THEN
      RAISE EXCEPTION 'BANK_MATCH_CROSS_BRANCH' USING ERRCODE = '42501';
    END IF;
    IF _ccy IS NOT NULL AND _bank_ccy IS NOT NULL AND _ccy IS DISTINCT FROM _bank_ccy THEN
      RAISE EXCEPTION 'BANK_MATCH_CURRENCY_MISMATCH: % against a % bank account', _ccy, _bank_ccy USING ERRCODE = '22023';
    END IF;
    IF _open IS NOT NULL AND _amt > _open + 0.005 THEN
      RAISE EXCEPTION 'BANK_MATCH_EXCEEDS_OPEN_AMOUNT' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  SELECT array_agg(DISTINCT k) INTO _primaries FROM unnest(_kinds) k WHERE k <> 'account';
  IF _primaries IS NULL THEN
    _primary := 'account';
  ELSIF array_length(_primaries, 1) > 1 THEN
    RAISE EXCEPTION 'BANK_MATCH_MIXED_DOCUMENT_TYPES' USING ERRCODE = '22023';
  ELSE
    _primary := _primaries[1];
  END IF;

  -- Amount law: the documents are settled GROSS; the bank moves the statement
  -- amount. On money in the bank received less than was settled by the charge;
  -- on money out it paid more.
  _required := abs(_txn.amount) + CASE WHEN _inflow THEN COALESCE(_fee_amount, 0) ELSE -COALESCE(_fee_amount, 0) END;
  IF abs(_sum - _required) > 0.005 THEN
    RAISE EXCEPTION 'BANK_MATCH_UNBALANCED: allocations (%) must equal the bank line (%) adjusted for the bank charge (%)',
      _sum, abs(_txn.amount), COALESCE(_fee_amount, 0) USING ERRCODE = '22023';
  END IF;

  RETURN _primary;
END;
$function$;

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
    -- F11: never void the settlement journal without unwinding the document
    -- allocations — that would leave invoices.amount_paid overstated.
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
    -- Clearing, transfer or classified movement: the reconciliation itself was
    -- the only posting, so voiding it is the whole reversal. The underlying
    -- payment stays valid — it simply is not deposited any more.
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
           lifecycle_status = 'for_review', match_source = 'unreconciled', updated_at = now()
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
         match_source = 'unreconciled',
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

REVOKE ALL ON FUNCTION public._bank_match_validate(bank_transactions, jsonb, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.unreconcile_bank_transaction(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unreconcile_bank_transaction(uuid, text, uuid) TO authenticated, service_role;