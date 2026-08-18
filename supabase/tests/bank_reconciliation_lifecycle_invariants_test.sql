-- =====================================================================
-- Banking Wave 1 · Phase 6.3 — reconciliation lifecycle invariants
--
-- WHAT THIS PROVES
-- Reconciliation MATCHES, it never MINTS (ADR-0123). A session is
-- server-owned: one open session per account, lines must belong to that
-- account, a line dated after the statement cannot be cleared, a write-off
-- is bounded, completion is gated on a balanced session, and cancellation
-- preserves provenance rather than deleting history.
--
-- Run with: supabase test db --linked --file bank_reconciliation_lifecycle_invariants_test.sql
-- =====================================================================
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- 1) The six seams exist, are hardened, and are not anonymous.
-- ---------------------------------------------------------------------
DO $$
DECLARE seam text; r record;
BEGIN
  FOREACH seam IN ARRAY ARRAY[
    'bank_reconciliation_session_start',
    'bank_reconciliation_item_set',
    'bank_reconciliation_session_writeoff',
    'bank_reconciliation_session_complete',
    'bank_reconciliation_session_cancel',
    'bank_transaction_set_category'
  ] LOOP
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public' AND p.proname=seam) <> 1 THEN
      RAISE EXCEPTION 'reconciliation seam % must have exactly one overload', seam;
    END IF;

    SELECT p.prosecdef, p.proconfig, p.proacl, p.proowner INTO r
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname=seam;

    IF NOT r.prosecdef THEN RAISE EXCEPTION 'seam % is not SECURITY DEFINER', seam; END IF;
    IF NOT EXISTS (SELECT 1 FROM unnest(COALESCE(r.proconfig,'{}')) c WHERE c LIKE 'search\_path=%') THEN
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
-- 2) Session guards live in the seams.
-- ---------------------------------------------------------------------
DO $$
DECLARE v_start text; v_item text; v_wo text; v_done text; v_cancel text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_start FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='bank_reconciliation_session_start';
  SELECT pg_get_functiondef(p.oid) INTO v_item FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='bank_reconciliation_item_set';
  SELECT pg_get_functiondef(p.oid) INTO v_wo FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='bank_reconciliation_session_writeoff';
  SELECT pg_get_functiondef(p.oid) INTO v_done FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='bank_reconciliation_session_complete';
  SELECT pg_get_functiondef(p.oid) INTO v_cancel FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='bank_reconciliation_session_cancel';

  IF v_start NOT LIKE '%_bank_reconciliation_assert_account%' THEN
    RAISE EXCEPTION 'session start bypasses the account guard';
  END IF;
  IF (SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='_bank_reconciliation_assert_account')
     NOT LIKE '%BANK_ACCOUNT_NOT_ACTIVE%' THEN
    RAISE EXCEPTION 'a non-active account can open a reconciliation session';
  END IF;
  IF v_start NOT LIKE '%BANK_RECON_SESSION_OPEN%' THEN
    RAISE EXCEPTION 'a second open session per account is not refused';
  END IF;
  IF v_start NOT LIKE '%unique_violation%' THEN
    RAISE EXCEPTION 'D-9 regression: the concurrent-start race is not collapsed into a domain error';
  END IF;
  IF v_start NOT LIKE '%BANK_RECON_PERIOD_LOCKED%' THEN
    RAISE EXCEPTION 'a locked accounting period can be reconciled into';
  END IF;

  IF v_item NOT LIKE '%BANK_RECON_TXN_SCOPE%' THEN
    RAISE EXCEPTION 'a line from another bank account can be cleared into a session';
  END IF;
  IF v_item NOT LIKE '%BANK_RECON_TXN_AFTER_STATEMENT%' THEN
    RAISE EXCEPTION 'a line dated after the statement date can be cleared';
  END IF;
  IF v_item NOT LIKE '%BANK_RECON_SESSION_CLOSED%' THEN
    RAISE EXCEPTION 'a closed session still accepts item changes';
  END IF;

  IF v_wo NOT LIKE '%BANK_RECON_WRITEOFF_TOO_LARGE%' THEN
    RAISE EXCEPTION 'the write-off is unbounded';
  END IF;
  IF v_wo NOT LIKE '%BANK_RECON_WRITEOFF_NEEDS_ACCOUNT%' THEN
    RAISE EXCEPTION 'a write-off can post without a destination account';
  END IF;

  IF v_done NOT LIKE '%BANK_RECON_NOT_BALANCED%' THEN
    RAISE EXCEPTION 'an unbalanced session can be completed';
  END IF;

  IF v_cancel NOT ILIKE '%cancelled%' THEN
    RAISE EXCEPTION 'cancel does not record a cancelled state (provenance lost)';
  END IF;
  IF v_cancel ~* 'delete\s+from\s+(public\.)?bank_reconciliation_sessions' THEN
    RAISE EXCEPTION 'cancel deletes the session instead of preserving provenance';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 3) ADR-0123: reconciliation matches, it never mints a payment.
--    No reconciliation seam may INSERT into a payment-bearing table; GL
--    effects must be routed through post_journal_entry_atomic.
-- ---------------------------------------------------------------------
DO $$
DECLARE v_offenders text;
BEGIN
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_offenders
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public'
    AND p.proname LIKE 'bank\_reconciliation\_%'
    AND pg_get_functiondef(p.oid) ~* 'insert\s+into\s+(public\.)?(payments|bill_payments|customer_payments)\b';
  IF v_offenders IS NOT NULL THEN
    RAISE EXCEPTION 'ADR-0123 violated — reconciliation mints payments in: %', v_offenders;
  END IF;

  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_offenders
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public'
    AND (p.proname LIKE 'bank\_reconciliation\_%' OR p.proname LIKE 'reconcile\_bank\_%')
    AND pg_get_functiondef(p.oid) ~* 'insert\s+into\s+(public\.)?journal_entr'
    AND pg_get_functiondef(p.oid) NOT ILIKE '%post_journal_entry_atomic%';
  IF v_offenders IS NOT NULL THEN
    RAISE EXCEPTION 'banking routines write journals directly (bypassing the posting engine): %', v_offenders;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 4) One open session per bank account — enforced by an index, not by a
--    read-then-write check.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = 'public.bank_reconciliation_sessions'::regclass
      AND i.indisunique
      AND pg_get_indexdef(i.indexrelid) ILIKE '%bank_account_id%'
      AND pg_get_indexdef(i.indexrelid) ILIKE '%in_progress%'
  ) THEN
    RAISE EXCEPTION 'no partial unique index guaranteeing a single open session per account';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 5) Cross-currency transfers are refused by the transfer seam.
-- ---------------------------------------------------------------------
DO $$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='reconcile_bank_transfer_atomic';

  IF v_src NOT LIKE '%BANK_TRANSFER_CURRENCY_MISMATCH%' THEN
    RAISE EXCEPTION 'a cross-currency bank transfer can be reconciled without an FX decision';
  END IF;
END $$;


-- ---------------------------------------------------------------------
-- 6) Phase 18 — close semantics.
--    (a) Completion no longer stamps the dropped per-transaction session
--        column: a cleared line belongs to a session through the session's
--        cleared items, and nowhere else.
--    (b) A closed session is frozen: its statement figures cannot be edited
--        and it cannot be reopened.
-- ---------------------------------------------------------------------
DO $$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='bank_reconciliation_session_complete';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'bank_reconciliation_session_complete is missing';
  END IF;

  IF v_src ~ 'reconciliation_session_id' THEN
    RAISE EXCEPTION 'session completion writes the dropped bank_transactions.reconciliation_session_id column';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='bank_transactions'
      AND column_name='reconciliation_session_id'
  ) THEN
    RAISE EXCEPTION 'regression: a second representation of session membership is back on bank_transactions';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'bank_reconciliation_session_freeze' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'a completed reconciliation session is not frozen';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 7) Phase 18 — one movement projection.
--    The cash position and the reconciliation recompute must derive bank
--    movement from the same helper, or the two screens can disagree.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='_bank_account_movement'
  ) THEN
    RAISE EXCEPTION 'the shared bank movement projection is missing';
  END IF;

  IF (SELECT pg_get_functiondef(p.oid) !~ '_bank_account_movement'
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='bank_account_positions') THEN
    RAISE EXCEPTION 'bank_account_positions computes movement itself instead of using the shared projection';
  END IF;

  IF (SELECT pg_get_functiondef(p.oid) !~ '_bank_account_movement'
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='_bank_reconciliation_recompute') THEN
    RAISE EXCEPTION 'reconciliation recompute computes movement itself instead of using the shared projection';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 8) Phase 18 — scheduled feed dispatch is server-owned.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='bank_feed_dispatch_due'
  ) THEN
    RAISE EXCEPTION 'bank_feed_dispatch_due is missing: nothing schedules a feed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.proname='bank_feed_dispatch_due'
      AND a.privilege_type='EXECUTE'
      AND a.grantee IN (0,
        (SELECT oid FROM pg_roles WHERE rolname='anon'),
        (SELECT oid FROM pg_roles WHERE rolname='authenticated'))
  ) THEN
    RAISE EXCEPTION 'a client can trigger the scheduled feed dispatcher';
  END IF;
END $$;

SELECT 'bank_reconciliation_lifecycle_invariants: ok' AS result;
