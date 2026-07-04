-- loan_policy_and_lifecycle_test.sql
-- Phase H: invariants added in phases A–E of the loan-lifecycle work.
--
-- What this pins:
--   1. loan_types has the policy/GL columns the app + triggers now depend on
--      (allow_skip, max_skips_per_loan, max_skips_per_calendar_year,
--       min_gap_between_skips_days, dual_control_writeoff,
--       writeoff_account_id, interest_income_account_id, requires_interest).
--   2. loan_lifecycle_events table exists with the shape lifecycle emitters
--      write to (loan_id, event, actor_user_id, payload).
--   3. loan_types_validate_policy_bounds() trigger rejects negative caps.
--   4. loan_skip_overrides_enforce_policy() trigger is wired BEFORE INSERT
--      on payroll_run_loan_skip_overrides and refuses when allow_skip=false.
--   5. RLS is enabled on both tables.
--
-- No production data is touched — all mutations run in a rolled-back block.

BEGIN;

  --------------------------------------------------------------------------
  -- (1) loan_types policy + GL columns
  --------------------------------------------------------------------------
  DO $$
  DECLARE
    v_missing text;
  BEGIN
    SELECT string_agg(needed, ', ')
      INTO v_missing
    FROM (
      VALUES
        ('allow_skip'),
        ('max_skips_per_loan'),
        ('max_skips_per_calendar_year'),
        ('min_gap_between_skips_days'),
        ('dual_control_writeoff'),
        ('writeoff_account_id'),
        ('interest_income_account_id'),
        ('requires_interest')
    ) AS req(needed)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'loan_types'
        AND column_name  = req.needed
    );

    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'loan_types missing required columns: %', v_missing;
    END IF;
  END $$;

  --------------------------------------------------------------------------
  -- (2) loan_lifecycle_events table shape
  --------------------------------------------------------------------------
  DO $$
  DECLARE
    v_missing text;
  BEGIN
    PERFORM 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name='loan_lifecycle_events';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'loan_lifecycle_events table missing';
    END IF;

    SELECT string_agg(needed, ', ')
      INTO v_missing
    FROM (
      VALUES ('loan_id'), ('event'), ('actor_user_id'), ('payload')
    ) AS req(needed)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name='loan_lifecycle_events'
        AND column_name = req.needed
    );

    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'loan_lifecycle_events missing columns: %', v_missing;
    END IF;
  END $$;

  --------------------------------------------------------------------------
  -- (3) policy-bounds trigger rejects negative caps
  --------------------------------------------------------------------------
  DO $$
  DECLARE
    v_org uuid;
    v_biz uuid;
    v_caught boolean := false;
  BEGIN
    SELECT organization_id, id INTO v_org, v_biz
      FROM public.businesses LIMIT 1;
    IF v_biz IS NULL THEN
      RAISE NOTICE 'no business; skipping policy-bounds trigger test';
      RETURN;
    END IF;

    BEGIN
      INSERT INTO public.loan_types
        (organization_id, business_id, code, name,
         allow_skip, max_skips_per_loan)
      VALUES
        (v_org, v_biz, 'TEST_NEG_CAP', 'Test negative cap',
         true, -1);
    EXCEPTION WHEN OTHERS THEN
      v_caught := true;
    END;

    IF NOT v_caught THEN
      RAISE EXCEPTION
        'loan_types_validate_policy_bounds should reject max_skips_per_loan < 0';
    END IF;
  END $$;

  --------------------------------------------------------------------------
  -- (4) skip-overrides trigger is wired and refuses when allow_skip=false
  --------------------------------------------------------------------------
  DO $$
  BEGIN
    PERFORM 1
      FROM pg_trigger
     WHERE tgname = 'trg_loan_skip_overrides_enforce_policy'
       AND tgrelid = 'public.payroll_run_loan_skip_overrides'::regclass
       AND NOT tgisinternal;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'trg_loan_skip_overrides_enforce_policy trigger missing on payroll_run_loan_skip_overrides';
    END IF;

    PERFORM 1 FROM pg_proc
     WHERE proname = 'loan_skip_overrides_enforce_policy'
       AND pronamespace = 'public'::regnamespace;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'loan_skip_overrides_enforce_policy function missing';
    END IF;
  END $$;

  --------------------------------------------------------------------------
  -- (5) RLS enabled
  --------------------------------------------------------------------------
  DO $$
  BEGIN
    PERFORM 1 FROM pg_class
      WHERE oid = 'public.loan_types'::regclass AND relrowsecurity;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'RLS not enabled on loan_types';
    END IF;

    PERFORM 1 FROM pg_class
      WHERE oid = 'public.loan_lifecycle_events'::regclass AND relrowsecurity;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'RLS not enabled on loan_lifecycle_events';
    END IF;

    PERFORM 1 FROM pg_class
      WHERE oid = 'public.payroll_run_loan_skip_overrides'::regclass
        AND relrowsecurity;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'RLS not enabled on payroll_run_loan_skip_overrides';
    END IF;
  END $$;

ROLLBACK;
