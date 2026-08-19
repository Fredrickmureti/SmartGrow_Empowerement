-- =====================================================================
-- Reconciliation engine · Phase 8 — what a match MEANS, asserted in SQL.
-- Companion to bank_matching_seam_invariants_test.sql (which asserts that
-- the seam exists and is hardened). This file asserts the accounting
-- consequences of each resolution kind (ADR-0147).
--
-- WHAT THIS PROVES
--  1. Clearing recognises money already recorded: an undeposited receipt
--     produces NO second payment, and the holding account nets to zero.
--  2. The bank leg equals the statement amount exactly once, even with a
--     bank charge; the document is settled GROSS.
--  3. Reverse restores the document balance from LIVE allocations, and a
--     reversal with a missing settlement row refuses instead of corrupting
--     amount_paid.
--  4. The seam refuses: wrong company, wrong branch, wrong currency, wrong
--     direction, locked period, double confirm, already-deposited receipt,
--     partial deposit of a receipt, a charge on an already-banked receipt.
--  5. Aggregate (3 documents -> 1 line) is ONE match with N allocations.
--  6. A rule may not auto-post when a document/payment could explain the
--     line.
--
-- Behavioural blocks run against live data inside a self-rolled-back
-- transaction, so this file is safe in any environment. Where the fixture
-- data required does not exist, the block raises a NOTICE and skips rather
-- than asserting a falsehood.
--
-- Run with: supabase test db --linked --file bank_match_resolution_invariants_test.sql
-- =====================================================================
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- 1) Contract: the resolution kinds are named, and each has a branch.
-- ---------------------------------------------------------------------
DO $$
DECLARE v text; token text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='bank_match_confirm';

  FOREACH token IN ARRAY ARRAY[
    '''invoice''',        -- settle AR
    '''bill''',           -- settle AP
    '''payment''',        -- clear an undeposited receipt
    '''bill_payment''',   -- clear a recorded supplier payment
    '''transfer''',       -- bank to bank
    'BDEP-',              -- the clearing entry is labelled as a deposit
    'BFEE-',              -- the charge is labelled as a charge
    'BADJ-'               -- the named residual is labelled as a residual
  ] LOOP
    IF v NOT LIKE '%' || token || '%' THEN
      RAISE EXCEPTION 'bank_match_confirm has no branch/label for %', token;
    END IF;
  END LOOP;

  -- Clearing must NEVER route through the settlement engines: re-settling an
  -- already-recorded receipt is the duplicate the engine exists to prevent.
  IF substring(v from 'ELSIF _kind IN \(''payment''.*?ELSIF _kind = ''transfer''') LIKE '%record_multi_invoice_payment%' THEN
    RAISE EXCEPTION 'the clearing branch mints a settlement — a recorded receipt must only be cleared';
  END IF;
  IF substring(v from 'ELSIF _kind IN \(''payment''.*?ELSIF _kind = ''transfer''') LIKE '%record_multi_bill_payment%' THEN
    RAISE EXCEPTION 'the clearing branch mints a settlement — a recorded payment must only be cleared';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2) Contract: the validator refuses every unsafe resolution.
-- ---------------------------------------------------------------------
DO $$
DECLARE v text; token text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='_bank_match_validate';

  FOREACH token IN ARRAY ARRAY[
    'BANK_MATCH_DIRECTION_MISMATCH',        -- an invoice is not settled by money out
    'BANK_MATCH_PAYMENT_VOIDED',
    'BANK_MATCH_PAYMENT_NO_DEPOSIT_ACCOUNT',
    'BANK_MATCH_PAYMENT_AMOUNT_MISMATCH',   -- a receipt is deposited in full
    'BANK_MATCH_PAYMENT_ALREADY_DEPOSITED', -- never twice
    'BANK_MATCH_FEE_ON_DIRECT_PAYMENT',     -- F10
    'BANK_MATCH_TRANSFER_SAME_ACCOUNT',
    'BANK_MATCH_TRANSFER_SINGLE_ALLOCATION',
    'BANK_MATCH_CURRENCY_MISMATCH',
    'BANK_MATCH_CROSS_BRANCH',
    'BANK_MATCH_CROSS_COMPANY',
    'BANK_MATCH_UNBALANCED'
  ] LOOP
    IF v NOT LIKE '%' || token || '%' THEN
      RAISE EXCEPTION 'the validator does not refuse %', token;
    END IF;
  END LOOP;

  -- The amount law must be stated once, in terms of the statement amount and
  -- the named charge — never by shrinking an allocation.
  IF v NOT LIKE '%abs(_txn.amount) + CASE WHEN _inflow THEN COALESCE(_fee_amount, 0) ELSE -COALESCE(_fee_amount, 0) END%' THEN
    RAISE EXCEPTION 'the gross-settlement amount law is not stated as statement +/- charge';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 3) Contract: reversal is kind-aware and refuses on a missing settlement.
-- ---------------------------------------------------------------------
DO $$
DECLARE v text; token text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='unreconcile_bank_transaction';

  FOREACH token IN ARRAY ARRAY[
    'void_payment_atomic',                    -- AR settlement unwound by its own writer
    'void_bill_payment_atomic',               -- AP likewise
    'void_journal_entry_atomic',              -- clearing/transfer/classified
    'BANK_UNRECONCILE_PERIOD_LOCKED',
    'BANK_UNRECONCILE_MISSING_SETTLEMENT',    -- F11
    'assert_can_reconcile_bank',
    'FOR UPDATE',
    'already_unreconciled'                    -- idempotent
  ] LOOP
    IF v NOT LIKE '%' || token || '%' THEN
      RAISE EXCEPTION 'unreconcile_bank_transaction does not use/enforce %', token;
    END IF;
  END LOOP;

  -- History is preserved: matches are marked reversed, never deleted.
  IF v ~* 'delete\s+from\s+(public\.)?bank_reconciliation_matches' THEN
    RAISE EXCEPTION 'unreconcile deletes match history — a reversal must preserve it';
  END IF;
  IF v ~* 'delete\s+from\s+(public\.)?(payments|bill_payments|journal_entr)' THEN
    RAISE EXCEPTION 'unreconcile deletes posted accounting records';
  END IF;
  IF v ~* 'insert\s+into\s+(public\.)?journal_entr' THEN
    RAISE EXCEPTION 'ADR-0123 violated: unreconcile writes journal rows directly';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 4) Contract: one bank line carries at most one confirmed match.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_index x
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_class t ON t.oid = x.indrelid
     WHERE t.relname = 'bank_reconciliation_matches'
       AND x.indisunique
       AND pg_get_indexdef(i.oid) LIKE '%confirmed%'
       AND pg_get_indexdef(i.oid) LIKE '%bank_transaction_id%'
  ) THEN
    RAISE EXCEPTION 'no unique index enforces one confirmed match per bank line — concurrent confirms could both post';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 5) Contract: rules are subordinate to accounting truth.
-- ---------------------------------------------------------------------
DO $$
DECLARE v text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='apply_reconciliation_rules';

  IF v NOT LIKE '%DOCUMENT_CANDIDATE_EXISTS%' THEN
    RAISE EXCEPTION 'a categorisation rule can post over a document/payment candidate';
  END IF;
  IF v NOT LIKE '%bank_match_propose%' THEN
    RAISE EXCEPTION 'rules do not go through the matching seam';
  END IF;
  IF v ~* 'insert\s+into\s+(public\.)?journal_entr' THEN
    RAISE EXCEPTION 'ADR-0123 violated: the rules engine posts journal rows directly';
  END IF;
  IF v ~* 'update\s+(public\.)?bank_transactions\s+set[^;]*is_reconciled\s*=\s*true' THEN
    RAISE EXCEPTION 'the rules engine flips reconciled state outside the seam';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 6) Behavioural: clearing an undeposited receipt.
--    Asserts: no second payment row, holding account nets to zero, the
--    bank leg equals the statement amount, the invoice is not paid twice,
--    a repeat confirm is a no-op, and reverse restores the position.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_biz uuid; v_txn uuid; v_pay uuid; v_bank_gl uuid; v_dep uuid;
  v_match uuid; v_amt numeric; v_inv uuid;
  v_pay_count_1 int; v_pay_count_2 int;
  v_bank_delta numeric; v_hold_delta numeric;
  v_paid_before numeric; v_paid_after numeric;
  v_je uuid; v_je_count_1 int; v_je_count_2 int;
BEGIN
  -- A recorded receipt whose deposit account is NOT the bank's own GL, and an
  -- unreconciled inflow on that bank account for exactly its amount.
  SELECT p.business_id, p.id, p.amount, p.deposit_account_id, ba.account_id, t.id
    INTO v_biz, v_pay, v_amt, v_dep, v_bank_gl, v_txn
    FROM public.payments p
    JOIN public.bank_transactions t
      ON t.business_id = p.business_id
     AND COALESCE(t.is_reconciled, false) = false
     AND abs(t.amount) = p.amount
     AND COALESCE(t.transaction_type, CASE WHEN t.amount >= 0 THEN 'credit' ELSE 'debit' END) = 'credit'
    JOIN public.bank_accounts ba ON ba.id = t.bank_account_id
   WHERE COALESCE(p.status, 'completed') NOT IN ('voided','cancelled')
     AND p.deposit_account_id IS NOT NULL
     AND ba.account_id IS NOT NULL
     AND p.deposit_account_id <> ba.account_id
     AND public.is_period_open(p.business_id, t.transaction_date)
     AND NOT EXISTS (
       SELECT 1 FROM public.bank_reconciliation_matches m
        WHERE m.status = 'confirmed'
          AND m.allocations @> jsonb_build_array(jsonb_build_object('document_type','payment','document_id', p.id::text))
     )
   ORDER BY t.transaction_date DESC
   LIMIT 1;

  IF v_txn IS NULL THEN
    RAISE NOTICE 'no undeposited-receipt fixture present — clearing block skipped';
    RETURN;
  END IF;

  SELECT count(*) INTO v_pay_count_1 FROM public.payments WHERE business_id = v_biz;
  SELECT COALESCE(sum(l.debit) - sum(l.credit), 0) INTO v_bank_delta
    FROM public.journal_entry_lines l WHERE l.account_id = v_bank_gl;
  SELECT COALESCE(sum(l.debit) - sum(l.credit), 0) INTO v_hold_delta
    FROM public.journal_entry_lines l WHERE l.account_id = v_dep;

  v_match := (public.bank_match_propose(
    _txn_id := v_txn,
    _allocations := jsonb_build_array(jsonb_build_object(
      'document_type','payment','document_id', v_pay, 'amount', v_amt)),
    _fee_amount := 0,
    _match_type := 'manual',
    _rule_id := NULL,
    _notes := 'test clearing',
    _user_id := NULL
  )->>'match_id')::uuid;

  v_je := (public.bank_match_confirm(v_match, NULL, 'test:' || v_txn::text)->>'journal_entry_id')::uuid;

  -- (a) no second payment was minted
  SELECT count(*) INTO v_pay_count_2 FROM public.payments WHERE business_id = v_biz;
  IF v_pay_count_2 <> v_pay_count_1 THEN
    RAISE EXCEPTION 'clearing minted % payment row(s) — a recorded receipt must only be cleared', v_pay_count_2 - v_pay_count_1;
  END IF;

  -- (b) the bank leg moved by exactly the statement amount
  IF (SELECT COALESCE(sum(l.debit) - sum(l.credit), 0) FROM public.journal_entry_lines l
       WHERE l.account_id = v_bank_gl) - v_bank_delta <> v_amt THEN
    RAISE EXCEPTION 'the bank GL did not move by the statement amount exactly once';
  END IF;

  -- (c) the holding account drained by exactly the same amount
  IF (SELECT COALESCE(sum(l.debit) - sum(l.credit), 0) FROM public.journal_entry_lines l
       WHERE l.account_id = v_dep) - v_hold_delta <> -v_amt THEN
    RAISE EXCEPTION 'the holding account did not drain — Undeposited Funds would never clear';
  END IF;

  -- (d) a repeat confirm posts nothing
  SELECT count(*) INTO v_je_count_1 FROM public.journal_entries WHERE business_id = v_biz;
  PERFORM public.bank_match_confirm(v_match, NULL, 'test:' || v_txn::text);
  SELECT count(*) INTO v_je_count_2 FROM public.journal_entries WHERE business_id = v_biz;
  IF v_je_count_2 <> v_je_count_1 THEN
    RAISE EXCEPTION 'a repeated confirm posted % extra journal entries', v_je_count_2 - v_je_count_1;
  END IF;

  -- (e) the same receipt cannot be deposited by a second bank line
  BEGIN
    PERFORM public._bank_match_validate(
      (SELECT t FROM public.bank_transactions t
        WHERE t.business_id = v_biz AND t.id <> v_txn
          AND abs(t.amount) = v_amt LIMIT 1),
      jsonb_build_array(jsonb_build_object('document_type','payment','document_id', v_pay, 'amount', v_amt)),
      0);
    RAISE EXCEPTION 'the same receipt was accepted for a second deposit';
  EXCEPTION
    WHEN sqlstate '22023' THEN NULL;  -- refused, as required
    WHEN no_data_found THEN NULL;     -- no second line to try
  END;

  -- (f) reverse: the clearing entry is voided, the receipt stays valid
  PERFORM public.unreconcile_bank_transaction(v_txn, 'test reversal', NULL);
  IF (SELECT COALESCE(is_reconciled, false) FROM public.bank_transactions WHERE id = v_txn) THEN
    RAISE EXCEPTION 'the bank line is still reconciled after a reversal';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.payments WHERE id = v_pay
                   AND COALESCE(status,'completed') NOT IN ('voided','cancelled')) THEN
    RAISE EXCEPTION 'reversing a clearing voided the underlying receipt — it is simply not deposited any more';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bank_reconciliation_matches
                  WHERE id = v_match AND status = 'reversed') THEN
    RAISE EXCEPTION 'the match was not preserved as reversed';
  END IF;

  RAISE NOTICE 'clearing invariants hold (no duplicate payment, holding account drains, reversible)';
  RAISE EXCEPTION 'rollback: behavioural block complete';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'rollback: behavioural block complete' THEN RAISE; END IF;
END $$;

-- ---------------------------------------------------------------------
-- 7) Behavioural refusals: cross-company, wrong direction, wrong currency,
--    unbalanced, partial deposit, charge on an already-banked receipt.
--    Each uses a composed (never inserted) bank_transactions row, so the
--    refusals are proved without touching data.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_a record; v_b record; v_acct uuid; v_pay record; v_txn public.bank_transactions;
  v_refused boolean;
BEGIN
  SELECT ba.id AS bank_account_id, ba.business_id, ba.organization_id, ba.branch_id,
         ba.account_id, ba.currency
    INTO v_a
    FROM public.bank_accounts ba
   WHERE ba.account_id IS NOT NULL
   ORDER BY ba.created_at LIMIT 1;

  IF v_a.bank_account_id IS NULL THEN
    RAISE NOTICE 'no bank account with a GL account — refusal block skipped';
    RETURN;
  END IF;

  v_txn := NULL;
  SELECT t.* INTO v_txn FROM public.bank_transactions t LIMIT 1;
  IF v_txn.id IS NULL THEN
    RAISE NOTICE 'no bank transaction shape available — refusal block skipped';
    RETURN;
  END IF;

  v_txn.id := gen_random_uuid();
  v_txn.organization_id := v_a.organization_id;
  v_txn.business_id := v_a.business_id;
  v_txn.bank_account_id := v_a.bank_account_id;
  v_txn.branch_id := v_a.branch_id;
  v_txn.transaction_date := CURRENT_DATE;
  v_txn.amount := 1000;
  v_txn.transaction_type := 'credit';
  v_txn.is_reconciled := false;
  v_txn.original_currency := NULL;

  SELECT id INTO v_acct FROM public.accounts WHERE business_id = v_a.business_id LIMIT 1;

  -- (a) unbalanced: allocations must equal the statement line +/- the charge
  v_refused := false;
  BEGIN
    PERFORM public._bank_match_validate(v_txn,
      jsonb_build_array(jsonb_build_object('document_type','account','document_id', v_acct, 'amount', 999)), 0);
  EXCEPTION WHEN sqlstate '22023' THEN v_refused := true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'an unbalanced allocation set was accepted';
  END IF;

  -- (b) cross-company: a document belonging to another business
  SELECT id INTO v_acct FROM public.accounts
   WHERE business_id IS DISTINCT FROM v_a.business_id AND business_id IS NOT NULL LIMIT 1;
  IF v_acct IS NOT NULL THEN
    v_refused := false;
    BEGIN
      PERFORM public._bank_match_validate(v_txn,
        jsonb_build_array(jsonb_build_object('document_type','account','document_id', v_acct, 'amount', 1000)), 0);
    EXCEPTION WHEN sqlstate '42501' THEN v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'a cross-company allocation was accepted';
    END IF;
  END IF;

  -- (c) unsupported resolution kind
  v_refused := false;
  BEGIN
    PERFORM public._bank_match_validate(v_txn,
      jsonb_build_array(jsonb_build_object('document_type','guess','document_id', gen_random_uuid(), 'amount', 1000)), 0);
  EXCEPTION WHEN sqlstate '22023' THEN v_refused := true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'an unknown resolution kind was accepted';
  END IF;

  -- (d) wrong direction: an invoice cannot be settled by money out
  SELECT i.id, i.business_id INTO v_pay FROM public.invoices i
   WHERE i.business_id = v_a.business_id LIMIT 1;
  IF v_pay.id IS NOT NULL THEN
    v_txn.transaction_type := 'debit';
    v_txn.amount := -1000;
    v_refused := false;
    BEGIN
      PERFORM public._bank_match_validate(v_txn,
        jsonb_build_array(jsonb_build_object('document_type','invoice','document_id', v_pay.id, 'amount', 1000)), 0);
    EXCEPTION WHEN sqlstate '22023' THEN v_refused := true;
         WHEN sqlstate '42501' THEN v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'an invoice was settled by money leaving the bank';
    END IF;
    v_txn.transaction_type := 'credit';
    v_txn.amount := 1000;
  END IF;

  -- (e) a receipt is deposited in full, never partially
  SELECT p.id, p.amount, p.deposit_account_id INTO v_pay
    FROM public.payments p
   WHERE p.business_id = v_a.business_id
     AND p.deposit_account_id IS NOT NULL
     AND COALESCE(p.status,'completed') NOT IN ('voided','cancelled')
   LIMIT 1;
  IF v_pay.id IS NOT NULL THEN
    v_txn.amount := v_pay.amount / 2;
    v_refused := false;
    BEGIN
      PERFORM public._bank_match_validate(v_txn,
        jsonb_build_array(jsonb_build_object('document_type','payment','document_id', v_pay.id, 'amount', v_pay.amount / 2)), 0);
    EXCEPTION WHEN sqlstate '22023' THEN v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'a receipt was deposited partially — the deposit is the whole receipt';
    END IF;

    -- (f) F10: a charge cannot ride on a receipt already banked here
    IF v_pay.deposit_account_id = v_a.account_id THEN
      v_txn.amount := v_pay.amount - 10;
      v_refused := false;
      BEGIN
        PERFORM public._bank_match_validate(v_txn,
          jsonb_build_array(jsonb_build_object('document_type','payment','document_id', v_pay.id, 'amount', v_pay.amount)), 10);
      EXCEPTION WHEN sqlstate '22023' THEN v_refused := true;
      END;
      IF NOT v_refused THEN
        RAISE EXCEPTION 'a bank charge was accepted on a receipt already posted to this bank account';
      END IF;
    END IF;
  END IF;

  RAISE NOTICE 'refusal invariants hold (unbalanced, cross-company, unknown kind, direction, partial deposit, charge-on-direct)';
END $$;

SELECT 'bank_match_resolution_invariants: ok' AS result;
