-- Expected cash on a branch day must net reversals to zero.
--
-- A reversal in this ledger keeps the original entry (marked `reversed`) and
-- adds its mirror. Counting only `posted` rows drops the original and keeps the
-- mirror, so a reversed cash payment appears as cash in the box. Observed live
-- at Headquarters on 2026-09-16: a reversed 11,250 cash disbursement inflated
-- expected cash by exactly 11,250.
--
-- Read-only: asserts the calculation's status filter, writes no rows.

\set ON_ERROR_STOP on

DO $$
DECLARE
  v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'branch_day_expected_cash';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'branch_day_expected_cash is missing';
  END IF;

  IF v_src NOT LIKE '%ledger_visible_journal_statuses%' THEN
    RAISE EXCEPTION 'branch_day_expected_cash does not use the canonical ledger status set — reversals will not net to zero';
  END IF;

  IF v_src ~ 'status\s*=\s*''posted''' THEN
    RAISE EXCEPTION 'branch_day_expected_cash still filters status = ''posted'' only';
  END IF;

  -- The canonical set must keep reversed originals visible.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'ledger_visible_journal_statuses'
       AND p.prosrc LIKE '%reversed%'
  ) THEN
    RAISE EXCEPTION 'ledger_visible_journal_statuses no longer includes reversed originals';
  END IF;



  -- Every overload of the ledger totals engine must agree.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'get_account_movements'
       AND p.prosrc ~ 'status\s*=\s*''posted'''
  ) THEN
    RAISE EXCEPTION 'A get_account_movements overload still filters status = ''posted'' only';
  END IF;

  RAISE NOTICE 'branch day expected cash reversal handling: OK';
END $$;
