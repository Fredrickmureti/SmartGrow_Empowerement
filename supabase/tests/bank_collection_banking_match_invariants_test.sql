-- =====================================================================
-- Bank Reconciliation · Waves 1–3 — microfinance document kinds, in SQL.
--
-- WHAT THIS PROVES
-- 1. Wave 1: `mf_bank_collection_batch` never writes to `bank_transactions`
--    — that table is the STATEMENT side (import / feed / manual entry only).
-- 2. Wave 2: the matching seam knows the two document kinds this product
--    actually banks — `collection_banking` and `disbursement` — across
--    candidates, validation, confirmation and the un-match pre-flight.
-- 3. Wave 2: confirming those kinds LINKS an already-posted journal entry;
--    it never settles a document a second time.
-- 4. Wave 3: aggregation is supported (several banked batches under one
--    bank credit) because validation loops over the allocation array and
--    balances the sum against the bank line, while a bank charge against a
--    banked batch / disbursement is REFUSED — the banking already posted
--    the gross amount, so the charge is its own statement line.
-- 5. Guard rails on the new kinds: same bank account, no double
--    confirmation, full-amount only, direction enforced.
--
-- Run with:
--   supabase test db --linked --file bank_collection_banking_match_invariants_test.sql
-- =====================================================================
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- 1) Wave 1 — the book side never fabricates a statement line.
-- ---------------------------------------------------------------------
DO $$
DECLARE src text;
BEGIN
  SELECT p.prosrc INTO src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'mf_bank_collection_batch';
  IF src IS NULL THEN
    RAISE EXCEPTION 'mf_bank_collection_batch is missing';
  END IF;

  -- Strip SQL comments before looking for a write: the function documents
  -- the rule in prose, and that prose must not be mistaken for a write.
  src := regexp_replace(src, '--[^\n]*', '', 'g');

  IF src ~* 'insert\s+into\s+public\.bank_transactions' THEN
    RAISE EXCEPTION
      'mf_bank_collection_batch inserts into bank_transactions — the banking is the book side, not a statement line';
  END IF;
  IF src !~* 'insert\s+into\s+public\.mf_collection_bankings' THEN
    RAISE EXCEPTION 'mf_bank_collection_batch no longer records the banking';
  END IF;
  IF src !~* 'post_journal_entry_atomic' THEN
    RAISE EXCEPTION 'mf_bank_collection_batch no longer posts through the canonical GL engine';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2) Wave 2 — every seam member knows the microfinance kinds.
-- ---------------------------------------------------------------------
DO $$
DECLARE fn text; src text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'bank_match_candidates',
    '_bank_match_validate',
    'bank_match_confirm',
    'bank_unmatch_preflight',
    'unreconcile_bank_transaction'
  ] LOOP
    SELECT p.prosrc INTO src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = fn;
    IF src IS NULL THEN
      RAISE EXCEPTION 'matching seam member % is missing', fn;
    END IF;
    IF src !~* 'collection_banking' THEN
      RAISE EXCEPTION '% does not handle banked collections', fn;
    END IF;
  END LOOP;

  FOREACH fn IN ARRAY ARRAY[
    'bank_match_candidates',
    '_bank_match_validate',
    'bank_match_confirm'
  ] LOOP
    SELECT p.prosrc INTO src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = fn;
    IF src !~* 'disbursement' THEN
      RAISE EXCEPTION '% does not handle loan disbursements', fn;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 3) Candidates read the canonical microfinance tables, not ERP proxies,
--    and refuse a banking that is already tied to a statement line.
-- ---------------------------------------------------------------------
DO $$
DECLARE src text;
BEGIN
  SELECT p.prosrc INTO src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'bank_match_candidates';

  IF src !~* 'mf_collection_bankings' THEN
    RAISE EXCEPTION 'bank_match_candidates does not read mf_collection_bankings';
  END IF;
  IF src !~* 'mf_loan_disbursements' THEN
    RAISE EXCEPTION 'bank_match_candidates does not read mf_loan_disbursements';
  END IF;
  IF src !~* 'bank_transaction_id\s+IS\s+NULL' THEN
    RAISE EXCEPTION 'bank_match_candidates may offer a banking that is already confirmed against a statement line';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 4) Waves 2–3 — the amount law and the refusals on the new kinds.
-- ---------------------------------------------------------------------
DO $$
DECLARE src text;
BEGIN
  SELECT p.prosrc INTO src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_bank_match_validate';

  -- Aggregation: validation iterates the allocation array and balances the
  -- total against the bank line, so N banked batches may settle one credit.
  IF src !~* 'jsonb_array_elements\s*\(\s*_allocations\s*\)' THEN
    RAISE EXCEPTION 'validation no longer iterates allocations — aggregate deposits would break';
  END IF;
  IF src !~* 'BANK_MATCH_UNBALANCED' THEN
    RAISE EXCEPTION 'validation no longer balances allocations against the bank line';
  END IF;

  -- Full-amount confirmation and single ownership for the new kinds.
  IF src !~* 'BANK_MATCH_COLLECTION_AMOUNT_MISMATCH' THEN
    RAISE EXCEPTION 'a banked batch may be confirmed for a partial amount';
  END IF;
  IF src !~* 'BANK_MATCH_COLLECTION_ALREADY_CONFIRMED' THEN
    RAISE EXCEPTION 'a banked batch may be confirmed against two statement lines';
  END IF;
  IF src !~* 'BANK_MATCH_COLLECTION_OTHER_BANK_ACCOUNT' THEN
    RAISE EXCEPTION 'a banked batch may be confirmed against another bank account';
  END IF;
  IF src !~* 'BANK_MATCH_DISBURSEMENT_AMOUNT_MISMATCH' THEN
    RAISE EXCEPTION 'a disbursement may be confirmed for a partial amount';
  END IF;
  IF src !~* 'BANK_MATCH_DISBURSEMENT_ALREADY_CONFIRMED' THEN
    RAISE EXCEPTION 'a disbursement may be confirmed twice';
  END IF;

  -- Direction: money in confirms a banking, money out confirms a disbursement.
  IF src !~* 'BANK_MATCH_DIRECTION_MISMATCH' THEN
    RAISE EXCEPTION 'validation no longer enforces the direction of the bank line';
  END IF;

  -- A bank charge cannot be netted against a gross-posted banking.
  IF src !~* 'BANK_MATCH_FEE_ON_DIRECT_PAYMENT' THEN
    RAISE EXCEPTION 'a bank charge may be netted against an already-posted banking';
  END IF;

  -- One deposit settles one kind of document.
  IF src !~* 'BANK_MATCH_MIXED_DOCUMENT_TYPES' THEN
    RAISE EXCEPTION 'validation no longer refuses mixed document kinds';
  END IF;

  -- Branch and company boundaries hold for the new kinds too.
  IF src !~* 'BANK_MATCH_CROSS_BRANCH' OR src !~* 'BANK_MATCH_CROSS_COMPANY' THEN
    RAISE EXCEPTION 'validation no longer enforces branch/company scope';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 5) Confirming a microfinance kind links; it never settles again.
-- ---------------------------------------------------------------------
DO $$
DECLARE src text;
BEGIN
  SELECT p.prosrc INTO src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'bank_match_confirm';

  IF src !~* 'record_multi_invoice_payment' AND src !~* 'record_multi_bill_payment' THEN
    RAISE EXCEPTION 'settlement is no longer delegated to the canonical payment engines (ADR-0123)';
  END IF;

  -- The un-match pre-flight must describe the new kinds as link-only, so a
  -- correction removes the link without unwinding an accounting entry that
  -- reconciliation never created.
  SELECT p.prosrc INTO src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'bank_unmatch_preflight';
  IF src !~* 'link_only' THEN
    RAISE EXCEPTION 'bank_unmatch_preflight no longer reports link-only un-matching';
  END IF;
END $$;

SELECT 'bank_collection_banking_match_invariants_test: OK' AS result;
