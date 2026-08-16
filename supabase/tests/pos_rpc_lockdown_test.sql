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
