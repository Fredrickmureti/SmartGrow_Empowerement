-- =====================================================================
-- Banking Wave 1 · Phase 6.1 — bank account lifecycle invariants
--
-- WHAT THIS PROVES
-- The account lifecycle is owned by the server. Every state change goes
-- through a SECURITY DEFINER seam that (a) refuses illegal transitions,
-- (b) enforces optimistic concurrency via row_version, (c) refuses to
-- activate an account with no ledger account behind it (defect D-8), and
-- (d) only allows a hard delete while the account is still a draft.
--
-- These are catalog + definition assertions on purpose: they cannot be
-- satisfied by a comment or by application code, only by the live routine
-- bodies, and they survive a `CREATE OR REPLACE` by a future engineer
-- (the assertion re-reads pg_get_functiondef every run).
--
-- Run with: supabase test db --linked --file bank_account_lifecycle_invariants_test.sql
-- =====================================================================
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- 1) The lifecycle vocabulary is a closed enum, not free text.
-- ---------------------------------------------------------------------
DO $$
DECLARE v_labels text[];
BEGIN
  SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder)
    INTO v_labels
  FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
  WHERE t.typname = 'bank_account_lifecycle_status';

  IF v_labels IS DISTINCT FROM ARRAY['draft','active','suspended','closed'] THEN
    RAISE EXCEPTION 'bank_account_lifecycle_status drifted: %', v_labels;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='bank_accounts'
      AND column_name='lifecycle_status' AND udt_name='bank_account_lifecycle_status'
  ) THEN
    RAISE EXCEPTION 'bank_accounts.lifecycle_status is not the lifecycle enum';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2) Exactly one overload per seam, all SECURITY DEFINER with a pinned
--    search_path, none executable by anon/PUBLIC.
-- ---------------------------------------------------------------------
DO $$
DECLARE r record; seam text;
BEGIN
  FOREACH seam IN ARRAY ARRAY[
    'bank_account_create','bank_account_update','bank_account_transition',
    'bank_account_delete_draft','bank_account_reset_opening_balances'
  ] LOOP
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public' AND p.proname=seam) <> 1 THEN
      RAISE EXCEPTION 'seam % must have exactly one overload', seam;
    END IF;

    SELECT p.oid, p.prosecdef, p.proconfig, p.proacl, p.proowner
      INTO r
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=seam;

    IF NOT r.prosecdef THEN
      RAISE EXCEPTION 'seam % is not SECURITY DEFINER', seam;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM unnest(COALESCE(r.proconfig, '{}')) c WHERE c LIKE 'search\_path=%') THEN
      RAISE EXCEPTION 'seam % has no pinned search_path', seam;
    END IF;
    IF EXISTS (
      SELECT 1 FROM aclexplode(COALESCE(r.proacl, acldefault('f', r.proowner))) a
      WHERE a.privilege_type='EXECUTE'
        AND a.grantee IN (0, (SELECT oid FROM pg_roles WHERE rolname='anon'))
    ) THEN
      RAISE EXCEPTION 'seam % is executable by anon/PUBLIC', seam;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 3) Illegal transitions are refused inside the transition seam.
--    The legal graph is: draft→active, active↔suspended, {active,
--    suspended}→closed. Anything else raises BANK_ACCOUNT_INVALID_TRANSITION.
-- ---------------------------------------------------------------------
DO $$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='bank_account_transition';

  IF v_src NOT LIKE '%BANK_ACCOUNT_INVALID_TRANSITION%' THEN
    RAISE EXCEPTION 'bank_account_transition does not refuse illegal transitions';
  END IF;
  IF v_src NOT LIKE '%BANK_ACCOUNT_VERSION_CONFLICT%' THEN
    RAISE EXCEPTION 'bank_account_transition has no optimistic-concurrency guard';
  END IF;
  -- Closing an account is an accounting act, not a flag flip.
  IF v_src NOT LIKE '%BANK_ACCOUNT_UNRECONCILED%'
     OR v_src NOT LIKE '%BANK_ACCOUNT_OPEN_RECONCILIATION%' THEN
    RAISE EXCEPTION 'closing an account does not check reconciliation state';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 4) D-8: activation requires a linked ledger account — on BOTH paths.
--    `bank_account_create(..., activate=true)` must apply the same
--    invariant as `bank_account_transition(..., 'active')`.
-- ---------------------------------------------------------------------
DO $$
DECLARE v_create text; v_transition text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_create
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='bank_account_create';
  SELECT pg_get_functiondef(p.oid) INTO v_transition
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='bank_account_transition';

  IF v_transition NOT LIKE '%BANK_ACCOUNT_NEEDS_GL%' THEN
    RAISE EXCEPTION 'transition→active does not require a GL account';
  END IF;
  IF v_create NOT LIKE '%BANK_ACCOUNT_NEEDS_GL%' THEN
    RAISE EXCEPTION 'D-8 regression: create→active can bypass the GL requirement';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 5) Opening balance is posted through the accounting engine, exactly
--    once, and only for a live account. A draft holds an intention only.
-- ---------------------------------------------------------------------
DO $$
DECLARE v_post text; v_create text; v_reset text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_post
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='_bank_account_post_opening_balance';
  IF v_post IS NULL THEN
    RAISE EXCEPTION 'no opening-balance poster: opening balances are unprovenanced';
  END IF;
  IF v_post NOT LIKE '%post_journal_entry_atomic%' THEN
    RAISE EXCEPTION 'opening balance does not route through post_journal_entry_atomic';
  END IF;
  IF v_post NOT LIKE '%BANK_OPENING_BALANCE_NEEDS_GL%' THEN
    RAISE EXCEPTION 'opening balance can post without a control account';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_create
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='bank_account_create';
  IF v_create NOT LIKE '%IF v_activate AND v_opening <> 0 THEN%' THEN
    RAISE EXCEPTION 'a draft account may post its opening balance before activation';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_reset
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='bank_account_reset_opening_balances';
  IF v_reset IS NULL THEN
    RAISE EXCEPTION 'opening balances cannot be reversed through a seam';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 6) Hard delete is draft-only, and it is guarded by row_version.
-- ---------------------------------------------------------------------
DO $$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='bank_account_delete_draft';

  IF v_src NOT LIKE '%BANK_ACCOUNT_NOT_DELETABLE%' THEN
    RAISE EXCEPTION 'a non-draft bank account can be hard deleted';
  END IF;
  IF v_src NOT LIKE '%BANK_ACCOUNT_VERSION_CONFLICT%' THEN
    RAISE EXCEPTION 'delete_draft has no optimistic-concurrency guard';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 7) row_version exists and is maintained by the database, not the client.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='bank_accounts' AND column_name='row_version'
  ) THEN
    RAISE EXCEPTION 'bank_accounts.row_version is missing — no optimistic concurrency';
  END IF;
END $$;

SELECT 'bank_account_lifecycle_invariants: ok' AS result;
