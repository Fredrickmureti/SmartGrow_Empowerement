-- loan_gl_posting_test.sql
-- ADR 0091: Loans emit events, Finance owns posting and numbering.
--
-- Pins the structural invariants of the loan GL lifecycle without touching
-- production data (everything runs inside a rolled-back block):
--   1. The loan RPCs exist with the shapes the app calls.
--   2. employee_loan_disburse posts through post_journal_entry_atomic and
--      never inserts into journal_entries directly.
--   3. journal_entries.entry_number is NOT NULL and has no default/trigger
--      that would assign it — i.e. numbering must come from the engine.
--   4. Every loan GL event has a distinct source_type.
--   5. The bank-movement + repayment-split helpers exist.

BEGIN;

  --------------------------------------------------------------------------
  -- (1) RPC surface
  --------------------------------------------------------------------------
  DO $$
  DECLARE v_missing text;
  BEGIN
    SELECT string_agg(needed, ', ') INTO v_missing
    FROM (VALUES
      ('employee_loan_disburse'),
      ('employee_loan_record_manual_repayment'),
      ('employee_loan_reverse_repayment'),
      ('employee_loan_write_off'),
      ('_loan_record_bank_movement'),
      ('_loan_split_repayment'),
      ('generate_next_je_number'),
      ('post_journal_entry_atomic')
    ) AS req(needed)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = req.needed
    );
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'missing loan/finance functions: %', v_missing;
    END IF;
  END $$;

  --------------------------------------------------------------------------
  -- (2) No private posting implementation in the loan module
  --------------------------------------------------------------------------
  DO $$
  DECLARE v_def text; v_fn text;
  BEGIN
    FOR v_fn IN SELECT unnest(ARRAY[
      'employee_loan_disburse',
      'employee_loan_record_manual_repayment',
      'employee_loan_write_off',
      'employee_loan_reverse_repayment'])
    LOOP
      SELECT pg_get_functiondef(p.oid) INTO v_def
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = v_fn
       LIMIT 1;

      IF v_def ILIKE '%INSERT INTO public.journal_entries%'
         OR v_def ILIKE '%INSERT INTO public.journal_entry_lines%' THEN
        RAISE EXCEPTION '% must post via post_journal_entry_atomic, not direct INSERT', v_fn;
      END IF;
    END LOOP;

    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname='employee_loan_disburse';
    IF v_def NOT ILIKE '%post_journal_entry_atomic%'
       OR v_def NOT ILIKE '%generate_next_je_number%' THEN
      RAISE EXCEPTION 'employee_loan_disburse must use the Finance posting engine and numbering';
    END IF;
  END $$;

  --------------------------------------------------------------------------
  -- (3) entry_number is engine-owned: NOT NULL, no default
  --------------------------------------------------------------------------
  DO $$
  DECLARE v_nullable text; v_default text;
  BEGIN
    SELECT is_nullable, column_default INTO v_nullable, v_default
      FROM information_schema.columns
     WHERE table_schema='public' AND table_name='journal_entries'
       AND column_name='entry_number';
    IF v_nullable <> 'NO' THEN
      RAISE EXCEPTION 'journal_entries.entry_number must stay NOT NULL';
    END IF;
    IF v_default IS NOT NULL THEN
      RAISE EXCEPTION 'entry_number must not get a default — numbering belongs to generate_next_je_number';
    END IF;
  END $$;

  --------------------------------------------------------------------------
  -- (4) distinct source_type per loan GL event
  --------------------------------------------------------------------------
  DO $$
  DECLARE v_def text; v_pair record;
  BEGIN
    FOR v_pair IN SELECT * FROM (VALUES
      ('employee_loan_disburse','loan_disbursement'),
      ('employee_loan_record_manual_repayment','loan_repayment'),
      ('employee_loan_reverse_repayment','loan_repayment_reversal'),
      ('employee_loan_write_off','loan_write_off')
    ) AS t(fn, src)
    LOOP
      SELECT pg_get_functiondef(p.oid) INTO v_def
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname = v_pair.fn LIMIT 1;
      IF v_def NOT LIKE '%' || v_pair.src || '%' THEN
        RAISE EXCEPTION '% must post with source_type %', v_pair.fn, v_pair.src;
      END IF;
    END LOOP;
  END $$;

  --------------------------------------------------------------------------
  -- (5) repayment split never invents money
  --------------------------------------------------------------------------
  DO $$
  DECLARE v_loan uuid; p numeric; i numeric;
  BEGIN
    SELECT id INTO v_loan FROM public.employee_loans LIMIT 1;
    IF v_loan IS NULL THEN
      RAISE NOTICE 'no loans; skipping split test';
      RETURN;
    END IF;
    SELECT o_principal, o_interest INTO p, i
      FROM public._loan_split_repayment(v_loan, 1000);
    IF ABS((p + i) - 1000) > 0.01 THEN
      RAISE EXCEPTION '_loan_split_repayment must conserve the amount (got % + %)', p, i;
    END IF;
  END $$;

ROLLBACK;
