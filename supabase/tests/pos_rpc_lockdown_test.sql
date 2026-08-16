-- POS Wave · Phase 4a — no POS routine may be callable by anon/PUBLIC.
-- Every POS routine is SECURITY DEFINER and therefore RLS-bypassing.
\set ON_ERROR_STOP on

DO $$
DECLARE v_leak text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, E'\n  ')
    INTO v_leak
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND (p.proname LIKE 'pos\_%' OR p.proname LIKE '\_pos\_%'
         OR p.proname IN ('process_pos_transaction','finalize_table_order',
                          'get_next_pos_transaction_number',
                          'get_next_draft_transaction_number'))
    AND EXISTS (
      SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
      WHERE a.privilege_type = 'EXECUTE'
        AND a.grantee IN (0, (SELECT oid FROM pg_roles WHERE rolname = 'anon'))
    );
  IF v_leak IS NOT NULL THEN
    RAISE EXCEPTION 'POS routines executable by anon/PUBLIC:%s  %', E'\n', v_leak;
  END IF;
END $$;

-- Phase 4b — a concurrent duplicate submission must collapse to a replay,
-- never surface a raw unique-violation to the cashier.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'process_pos_transaction'
    AND pg_get_functiondef(p.oid) ILIKE '%unique_violation%'
) THEN 1 ELSE 0 END AS commit_idempotency_race_handled;

-- Phase 5 — table orders are priced server-side.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'pos_sync_table_order'
    AND pg_get_functiondef(p.oid) ILIKE '%pos_quote_cart%'
) THEN 1 ELSE 0 END AS table_order_server_priced;

-- Phase 7 — payment integrity invariants.
-- 7a) Commit must re-derive the payable total from the canonical resolvers.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public' AND p.proname='pos_payment_session_commit'
    AND pg_get_functiondef(p.oid) ILIKE '%pos_quote_cart%'
    AND pg_get_functiondef(p.oid) ILIKE '%total mismatch%'
) THEN 1 ELSE 0 END AS commit_reprices_server_side;

-- 7b) Change is a cash-only concept; non-cash tendered == amount.
DO $$
DECLARE missing text[] := ARRAY[]::text[]; c text;
BEGIN
  FOREACH c IN ARRAY ARRAY[
    'pos_payment_session_tenders_change_cash_only',
    'pos_payment_session_tenders_noncash_exact'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid='public.pos_payment_session_tenders'::regclass
                      AND conname=c) THEN
      missing := array_append(missing, c);
    END IF;
  END LOOP;
  IF array_length(missing,1) > 0 THEN
    RAISE EXCEPTION 'Phase 7 tender hygiene constraints missing: %', missing;
  END IF;
END $$;

-- 7c) Cancel must refuse to discard captured non-cash money, and the sweeper
--     must only touch sessions with nothing allocated.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public' AND p.proname='pos_payment_session_cancel'
    AND pg_get_functiondef(p.oid) ILIKE '%captured non-cash tenders%'
) THEN 1 ELSE 0 END AS cancel_protects_captured_money;

SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public' AND p.proname='pos_payment_session_sweep_abandoned'
    AND pg_get_functiondef(p.oid) ILIKE '%pos_payment_session_allocated(s.id) = 0%'
) THEN 1 ELSE 0 END AS sweeper_skips_funded_sessions;
