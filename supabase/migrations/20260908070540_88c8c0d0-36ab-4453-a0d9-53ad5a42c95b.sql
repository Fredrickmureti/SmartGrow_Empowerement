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
  _cb_account uuid;
  _cb_link uuid;
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

    ELSIF _kind = 'collection_banking' THEN
      -- A closed collection batch already banked. Its entry debited this bank
      -- account and credited cash / mobile money, so this statement line is
      -- the bank confirming it: linkage only, never a second settlement.
      IF NOT _inflow THEN
        RAISE EXCEPTION 'BANK_MATCH_DIRECTION_MISMATCH: a banked collection batch is confirmed by money in' USING ERRCODE = '22023';
      END IF;
      SELECT cb.business_id, cb.branch_id, cb.amount, cb.bank_account_id, cb.bank_transaction_id
        INTO _biz, _branch, _pay_amount, _cb_account, _cb_link
        FROM public.mf_collection_bankings cb WHERE cb.id = (_a->>'document_id')::uuid;
      IF _biz IS NULL THEN RAISE EXCEPTION 'BANK_MATCH_DOCUMENT_NOT_FOUND' USING ERRCODE = '22023'; END IF;
      IF _cb_account IS DISTINCT FROM _txn.bank_account_id THEN
        RAISE EXCEPTION 'BANK_MATCH_COLLECTION_OTHER_BANK_ACCOUNT: this batch was banked into a different bank account' USING ERRCODE = '22023';
      END IF;
      IF _cb_link IS NOT NULL AND _cb_link IS DISTINCT FROM _txn.id THEN
        RAISE EXCEPTION 'BANK_MATCH_COLLECTION_ALREADY_CONFIRMED' USING ERRCODE = '22023';
      END IF;
      IF abs(_amt - COALESCE(_pay_amount, 0)) > 0.005 THEN
        RAISE EXCEPTION 'BANK_MATCH_COLLECTION_AMOUNT_MISMATCH: a banked batch is confirmed in full' USING ERRCODE = '22023';
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.bank_reconciliation_matches m
         WHERE m.status = 'confirmed'
           AND m.bank_transaction_id IS DISTINCT FROM _txn.id
           AND m.allocations @> jsonb_build_array(jsonb_build_object('document_type','collection_banking','document_id', _a->>'document_id'))
      ) THEN
        RAISE EXCEPTION 'BANK_MATCH_COLLECTION_ALREADY_CONFIRMED' USING ERRCODE = '22023';
      END IF;
      IF COALESCE(_fee_amount, 0) > 0 THEN
        RAISE EXCEPTION 'BANK_MATCH_FEE_ON_DIRECT_PAYMENT: the banking already posted the full amount to this bank account — record the charge as its own bank line'
          USING ERRCODE = '22023';
      END IF;

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