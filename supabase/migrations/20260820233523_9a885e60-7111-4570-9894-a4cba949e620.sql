-- 1. Pre-flight for un-matching a reconciled bank line.
--    Mirrors, and only reads, the exact refusal conditions enforced by
--    public.unreconcile_bank_transaction. It never mutates anything.
CREATE OR REPLACE FUNCTION public.bank_unmatch_preflight(_bank_transaction_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _txn record;
  _m public.bank_reconciliation_matches;
  _kind text;
  _rdate date;
  _je record;
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

  IF _txn.journal_entry_id IS NOT NULL THEN
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
      WHEN _kind IN ('invoice','bill') THEN 'Un-matching will void the settlement payment and its posting.'
      WHEN _txn.journal_entry_id IS NOT NULL THEN 'Un-matching will void the journal entry this line created.'
      ELSE 'Un-matching will break the link only; no posting is affected.'
    END,
    'requires', CASE
      WHEN _kind IN ('invoice','bill') THEN 'void_payment'
      WHEN _txn.journal_entry_id IS NOT NULL THEN 'void_journal_entry'
      ELSE 'link_only'
    END,
    'resolution', _kind
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.bank_unmatch_preflight(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bank_unmatch_preflight(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.bank_unmatch_preflight(uuid) TO authenticated, service_role;

-- 2. An opening balance may only be posted once per bank account.
--    A statement line classified straight to the bank's own control account on
--    or before the opening-balance date double-counts the opening balance
--    (the exact defect the residual explainer names as duplicate_opening_balance).
CREATE OR REPLACE FUNCTION public._guard_duplicate_opening_balance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _txn record;
  _ba record;
BEGIN
  IF NEW.status <> 'confirmed' OR COALESCE(NEW.matched_entity_type, '') <> 'account' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'confirmed' THEN
    RETURN NEW;
  END IF;

  SELECT bt.transaction_date, bt.bank_account_id INTO _txn
    FROM public.bank_transactions bt WHERE bt.id = NEW.bank_transaction_id;
  IF _txn.bank_account_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT ba.account_id, ba.opening_balance_je_id, ba.opening_balance_date INTO _ba
    FROM public.bank_accounts ba WHERE ba.id = _txn.bank_account_id;

  IF _ba.opening_balance_je_id IS NOT NULL
     AND _ba.account_id IS NOT NULL
     AND NEW.matched_entity_id = _ba.account_id
     AND _txn.transaction_date <= COALESCE(_ba.opening_balance_date, _txn.transaction_date)
  THEN
    RAISE EXCEPTION 'BANK_OPENING_BALANCE_ALREADY_POSTED: this bank account already carries a posted opening balance; classifying this line to the bank control account would count it twice'
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_guard_duplicate_opening_balance ON public.bank_reconciliation_matches;
CREATE TRIGGER trg_guard_duplicate_opening_balance
BEFORE INSERT OR UPDATE ON public.bank_reconciliation_matches
FOR EACH ROW EXECUTE FUNCTION public._guard_duplicate_opening_balance();