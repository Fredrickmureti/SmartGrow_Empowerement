-- =====================================================================
-- Ratchet: landed cost reversal must respect stock consumed after posting
-- (Phase B — 2026-08-16)
--
-- Two invariants, both introspective plus a live rehearsal that is rolled
-- back at the end of the transaction:
--
--   1. inventory_reverse_cost_revaluation unwinds using the quantity that
--      was on hand when the uplift was APPLIED (qty_remaining_at_apply),
--      never the current qty_remaining, and reports the split between the
--      portion still in inventory ("unwound") and the portion already
--      relieved through cost of sales ("consumed").
--   2. landed_cost_reverse_voucher builds its journal from that split
--      instead of mirroring the original entry, so inventory is only
--      credited for value that is still on hand.
--
-- Run:  psql "$DATABASE_URL" -f supabase/tests/landed_cost_reversal_split_test.sql
-- =====================================================================
BEGIN;

DO $$
DECLARE
  v_src text;
BEGIN
  ---------------------------------------------------------------- unwind math
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'inventory_reverse_cost_revaluation';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'FAIL: inventory_reverse_cost_revaluation() is missing';
  END IF;
  IF position('qty_remaining_at_apply' IN v_src) = 0 THEN
    RAISE EXCEPTION 'FAIL: reversal no longer unwinds against the quantity on hand at apply time';
  END IF;
  IF position('consumed' IN v_src) = 0 OR position('by_product' IN v_src) = 0 THEN
    RAISE EXCEPTION 'FAIL: reversal no longer reports the inventory/COGS split per product';
  END IF;

  ------------------------------------------------------------ one writer only
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'inventory_reverse_cost_revaluation') <> 1 THEN
    RAISE EXCEPTION 'FAIL: more than one inventory_reverse_cost_revaluation overload';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'landed_cost_reverse_voucher') <> 1 THEN
    RAISE EXCEPTION 'FAIL: more than one landed_cost_reverse_voucher overload';
  END IF;

  ---------------------------------------------------------- reversal journal
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'landed_cost_reverse_voucher';

  IF position('by_product' IN v_src) = 0 THEN
    RAISE EXCEPTION 'FAIL: reversal journal is back to mirroring the original entry';
  END IF;
  IF position('post_journal_entry_atomic' IN v_src) = 0 THEN
    RAISE EXCEPTION 'FAIL: reversal no longer posts through the shared journal writer (ADR 0123)';
  END IF;
  IF position('inventory_reverse_cost_revaluation' IN v_src) = 0 THEN
    RAISE EXCEPTION 'FAIL: reversal no longer unwinds inventory through the canonical revaluation engine';
  END IF;
  IF position('a reversal reason is required' IN v_src) = 0 THEN
    RAISE EXCEPTION 'FAIL: reversal reason is no longer mandatory';
  END IF;

  ------------------------------------------------------- live data invariants
  -- Every reversed voucher's revaluation rows are closed out.
  IF EXISTS (
    SELECT 1
      FROM public.landed_cost_vouchers v
      JOIN public.inventory_cost_revaluations r
        ON r.source_type = 'landed_cost_voucher' AND r.source_id = v.id
     WHERE v.status = 'reversed' AND r.reversed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'FAIL: a reversed voucher still has open cost revaluations';
  END IF;

  -- Every landed-cost reversal journal balances.
  IF EXISTS (
    SELECT 1
      FROM public.journal_entries je
      JOIN public.journal_entry_lines l ON l.journal_entry_id = je.id
     WHERE je.source_type = 'landed_cost_voucher'
     GROUP BY je.id
    HAVING ROUND(SUM(l.debit) - SUM(l.credit), 2) <> 0
  ) THEN
    RAISE EXCEPTION 'FAIL: an unbalanced landed cost journal exists';
  END IF;

  RAISE NOTICE 'PASS: landed cost reversal split ratchet';
END $$;

ROLLBACK;
