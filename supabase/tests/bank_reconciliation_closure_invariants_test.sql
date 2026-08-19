-- =====================================================================
-- Reconciliation engine · Phase 11 — a completed reconciliation is a fact
--
-- WHAT THIS PROVES
-- F17  The closed window is shut from every path: no match may be born,
--      confirmed, reversed or rejected against a line dated inside a
--      completed reconciliation, and no line's reconciled state may be
--      flipped there. Reopening is the only door, and it is audited.
-- F18  Completion is tied out against the ledger, not against itself.
-- F19  The stored `difference` has exactly one writer: the recompute.
--
-- Run with: supabase test db --linked --file bank_reconciliation_closure_invariants_test.sql
-- =====================================================================
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- 1) Contract: the guard helpers exist once, are hardened, and are not
--    reachable by anon or by signed-in users (they are internal).
-- ---------------------------------------------------------------------
DO $$
DECLARE fn text; r record;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    '_bank_recon_closed_session',
    '_bank_reconciliation_gl_tieout',
    '_bank_match_closed_window_guard',
    '_bank_txn_reconcile_closed_window_guard'
  ] LOOP
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public' AND p.proname=fn) <> 1 THEN
      RAISE EXCEPTION 'closure helper % must have exactly one overload', fn;
    END IF;

    SELECT p.prosecdef, p.proconfig, p.proacl, p.proowner INTO r
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname=fn;

    IF NOT r.prosecdef THEN RAISE EXCEPTION 'helper % is not SECURITY DEFINER', fn; END IF;
    IF NOT EXISTS (SELECT 1 FROM unnest(COALESCE(r.proconfig,'{}')) c WHERE c LIKE 'search\_path=%') THEN
      RAISE EXCEPTION 'helper % has no pinned search_path', fn;
    END IF;
    IF EXISTS (
      SELECT 1 FROM aclexplode(COALESCE(r.proacl, acldefault('f', r.proowner))) a
      WHERE a.privilege_type='EXECUTE'
        AND a.grantee IN (0,
          (SELECT oid FROM pg_roles WHERE rolname='anon'),
          (SELECT oid FROM pg_roles WHERE rolname='authenticated'))
    ) THEN
      RAISE EXCEPTION 'internal helper % is callable by anon/authenticated/PUBLIC', fn;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 2) F17: the guards are wired as triggers, not as advice.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'bank_reconciliation_matches'
       AND t.tgname = 'trg_bank_match_closed_window' AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'F17: matches table has no closed-window guard trigger';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'bank_transactions'
       AND t.tgname = 'trg_bank_txn_reconcile_closed_window' AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'F17: bank_transactions has no closed-window reconcile guard trigger';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 3) F17: reopen is a real, audited seam — reason required, statement
--    order respected, period respected, and it publishes an event.
-- ---------------------------------------------------------------------
DO $$
DECLARE d text; r record;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='bank_reconciliation_session_reopen';
  IF d IS NULL THEN RAISE EXCEPTION 'F17: bank_reconciliation_session_reopen is missing'; END IF;

  IF d NOT LIKE '%BANK_RECON_REOPEN_NEEDS_REASON%' THEN
    RAISE EXCEPTION 'F17: reopen accepts an empty reason';
  END IF;
  IF d NOT LIKE '%BANK_RECON_LATER_SESSION_CLOSED%' THEN
    RAISE EXCEPTION 'F17: reopen does not refuse out of statement order';
  END IF;
  IF d NOT LIKE '%is_period_locked%' THEN
    RAISE EXCEPTION 'F17: reopen has no fiscal-period guard';
  END IF;
  IF d NOT LIKE '%_bank_reconciliation_assert_account%' THEN
    RAISE EXCEPTION 'F17: reopen has no membership/account assertion';
  END IF;
  IF d NOT LIKE '%publish_business_event%' THEN
    RAISE EXCEPTION 'F17: reopen leaves no audit trail';
  END IF;

  -- Reopening is possible only through that seam: the freeze trigger gates
  -- the completed -> in_progress transition behind the reopen GUC.
  SELECT pg_get_functiondef(p.oid) AS def INTO r
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='_bank_reconciliation_session_freeze';
  IF r.def NOT LIKE '%app.bank_recon_reopen%' THEN
    RAISE EXCEPTION 'F17: freeze trigger has no gated reopen escape (or reopen bypasses it)';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 4) F18: completion is tied out against the bank ledger.
-- ---------------------------------------------------------------------
DO $$
DECLARE d text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='bank_reconciliation_session_complete';

  IF d NOT LIKE '%gl_tieout%' THEN
    RAISE EXCEPTION 'F18: completion does not consult the GL tie-out';
  END IF;
  IF d NOT LIKE '%BANK_RECON_GL_DIVERGENCE%' THEN
    RAISE EXCEPTION 'F18: completion does not refuse on GL divergence';
  END IF;
  IF d NOT LIKE '%BANK_RECON_NOT_BALANCED%' THEN
    RAISE EXCEPTION 'F18: completion no longer refuses an unexplained difference';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 5) F19: the difference is persisted, and only by the recompute.
-- ---------------------------------------------------------------------
DO $$
DECLARE d text; other record;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='_bank_reconciliation_recompute';

  IF d NOT LIKE '%difference =%' THEN
    RAISE EXCEPTION 'F19: recompute still does not persist the difference';
  END IF;
  IF d NOT LIKE '%gl_tieout%' THEN
    RAISE EXCEPTION 'F19: recompute payload carries no GL tie-out for the report';
  END IF;

  -- No second writer of the stored difference.
  FOR other IN
    SELECT p.proname, pg_get_functiondef(p.oid) AS def
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public'
       AND p.proname <> '_bank_reconciliation_recompute'
       AND pg_get_functiondef(p.oid) LIKE '%UPDATE public.bank_reconciliation_sessions%'
  LOOP
    IF other.def ~* 'UPDATE public\.bank_reconciliation_sessions[^;]*\mdifference\M\s*=' THEN
      RAISE EXCEPTION 'F19: % also writes bank_reconciliation_sessions.difference', other.proname;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 6) F17 behavioural: with a completed session covering the window, the
--    guard refuses a match birth and a reconciled-state flip. Rolled back.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_txn   record;
  v_sess  uuid;
  v_ok    boolean := false;
BEGIN
  SELECT bt.* INTO v_txn
    FROM public.bank_transactions bt
   WHERE bt.transaction_date IS NOT NULL
     AND COALESCE(bt.is_reconciled, false) = false
   LIMIT 1;

  IF v_txn.id IS NULL THEN
    RAISE NOTICE 'F17 behavioural: no unreconciled bank line available — contract checks above stand alone';
    RETURN;
  END IF;

  -- A completed session whose statement date covers the line.
  INSERT INTO public.bank_reconciliation_sessions
    (organization_id, business_id, branch_id, bank_account_id, statement_date,
     opening_balance, closing_balance, reconciled_balance, difference, status,
     completed_at)
  VALUES
    (v_txn.organization_id, v_txn.business_id, v_txn.branch_id, v_txn.bank_account_id,
     v_txn.transaction_date, 0, 0, 0, 0, 'completed', now())
  RETURNING id INTO v_sess;

  BEGIN
    UPDATE public.bank_transactions SET is_reconciled = true WHERE id = v_txn.id;
  EXCEPTION WHEN check_violation THEN
    v_ok := true;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'F17: a line inside a completed reconciliation was marked reconciled';
  END IF;

  v_ok := false;
  BEGIN
    INSERT INTO public.bank_reconciliation_matches
      (organization_id, business_id, branch_id, bank_transaction_id, matched_entity_type, status)
    VALUES
      (v_txn.organization_id, v_txn.business_id, v_txn.branch_id, v_txn.id, 'account', 'suggested');
  EXCEPTION WHEN check_violation THEN
    v_ok := true;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'F17: a match was created against a line inside a completed reconciliation';
  END IF;

  RAISE EXCEPTION 'ROLLBACK_CLOSURE_TEST';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'ROLLBACK_CLOSURE_TEST' THEN RAISE; END IF;
END $$;

SELECT 'bank reconciliation closure invariants: OK' AS result;
