-- ADR 0136 — a reversal mirrors the original posting; it never re-resolves a rate.
--
-- Read-only catalogue invariants (no DML), safe to run anywhere.
--
-- Contracts ratcheted here:
--   1. `void_journal_entry_atomic` carries the original line-level FX metadata
--      (original_currency / exchange_rate / original_debit / original_credit)
--      onto the reversal lines, mirrored to the opposite side, and inherits the
--      header currency + rate. Losing it makes foreign-currency reversals
--      invisible to FX reporting.
--   2. No reversal path resolves a NEW exchange rate. Reversals mirror; they
--      never call `resolve_exchange_rate` / `require_exchange_rate`.
--   3. No reversal path carries a `COALESCE(rate, 1)` parity fallback.
--   4. `unapply_payment_atomic` derives its posting from the original
--      settlement journal (so the realised-FX line is backed out) rather than
--      from the payment's face `applied_amount` alone.

BEGIN;

DO $$
DECLARE
  v_def       text;
  v_fn        text;
  v_offenders text;
  v_reversal_fns text[] := ARRAY[
    'void_journal_entry_atomic',
    'unapply_payment_atomic',
    'void_payment_atomic',
    'void_bill_payment_atomic',
    'unapply_vendor_credit_from_bill_atomic'
  ];
BEGIN
  -- 1. Reversal lines preserve FX metadata, mirrored.
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'void_journal_entry_atomic';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'void_journal_entry_atomic is missing';
  END IF;

  IF v_def !~* 'original_currency' OR v_def !~* 'original_debit' OR v_def !~* 'original_credit' THEN
    RAISE EXCEPTION
      'ADR 0136: void_journal_entry_atomic drops line-level FX metadata from the reversal lines';
  END IF;

  IF v_def !~* '_line\.original_credit' OR v_def !~* '_line\.original_debit' THEN
    RAISE EXCEPTION
      'ADR 0136: void_journal_entry_atomic must mirror original_debit/original_credit to the opposite side';
  END IF;

  IF v_def !~* '_original\.currency' OR v_def !~* '_original\.exchange_rate' THEN
    RAISE EXCEPTION
      'ADR 0136: the reversal header must inherit the original entry currency and exchange rate';
  END IF;

  -- 2 + 3. Reversals never resolve a rate and never fall back to parity.
  FOREACH v_fn IN ARRAY v_reversal_fns LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_fn;

    IF v_def IS NULL THEN
      RAISE EXCEPTION 'reversal path % is missing', v_fn;
    END IF;

    IF v_def ~* '\mrequire_exchange_rate\M' OR v_def ~* '\mresolve_exchange_rate\M' THEN
      RAISE EXCEPTION
        'ADR 0136: % resolves a new exchange rate on a reversal; reversals must mirror the original rate',
        v_fn;
    END IF;

    IF v_def ~* 'coalesce\s*\([^()]*rate[^()]*,\s*1\s*\)' THEN
      RAISE EXCEPTION 'ADR 0136: % carries a silent 1:1 parity fallback', v_fn;
    END IF;
  END LOOP;

  -- 4. Unapply mirrors the settlement journal.
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'unapply_payment_atomic';

  IF v_def !~* 'journal_entry_lines' THEN
    RAISE EXCEPTION
      'unapply_payment_atomic must derive its reversal from the original settlement journal lines so the realised-FX line is backed out';
  END IF;

  RAISE NOTICE 'fx_reversal_symmetry_test: all contracts hold';
END $$;

ROLLBACK;
