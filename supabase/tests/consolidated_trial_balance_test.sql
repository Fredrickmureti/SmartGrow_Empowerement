-- Brick 2 — consolidated trial balance: database invariants.
-- Run against a database with the consolidation migrations applied:
--   psql "$DATABASE_URL" -f supabase/tests/consolidated_trial_balance_test.sql
-- Any failed assertion raises and aborts the transaction; nothing is committed.

BEGIN;

DO $$
DECLARE
  v_secdef boolean;
  v_kind text;
BEGIN
  -- 1. Both reporting functions exist and run as the CALLER, so the finance
  --    read checks inside the authoritative ledger RPCs still apply.
  FOR v_kind IN SELECT unnest(ARRAY['resolve_consolidation_scope','get_consolidated_trial_balance'])
  LOOP
    SELECT p.prosecdef INTO v_secdef
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_kind;
    IF v_secdef IS NULL THEN
      RAISE EXCEPTION 'missing function public.%', v_kind;
    END IF;
    IF v_secdef THEN
      RAISE EXCEPTION 'public.% must be SECURITY INVOKER so member-level access is enforced', v_kind;
    END IF;
  END LOOP;

  -- 2. The scope-count helper is the only SECURITY DEFINER piece; it exists so a
  --    hidden member can be detected and the run refused, and it must not be
  --    callable anonymously.
  SELECT p.prosecdef INTO v_secdef
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'consolidation_scope_member_count';
  IF v_secdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'consolidation_scope_member_count must be SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', 'public.consolidation_scope_member_count(uuid, date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not execute consolidation_scope_member_count';
  END IF;

  -- 3. Signed-in users may run the reports; anonymous callers may not.
  IF NOT has_function_privilege('authenticated', 'public.get_consolidated_trial_balance(uuid, date, date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must be able to execute get_consolidated_trial_balance';
  END IF;
  IF has_function_privilege('anon', 'public.get_consolidated_trial_balance(uuid, date, date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not execute get_consolidated_trial_balance';
  END IF;
  IF has_function_privilege('anon', 'public.resolve_consolidation_scope(uuid, date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not execute resolve_consolidation_scope';
  END IF;

  -- 4. No second ledger engine: the consolidated report must read balances only
  --    through the authoritative ledger functions.
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'get_consolidated_trial_balance')
       NOT LIKE '%get_ledger_opening_balances%' THEN
    RAISE EXCEPTION 'consolidated trial balance must use get_ledger_opening_balances';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'get_consolidated_trial_balance')
       NOT LIKE '%get_account_movements%' THEN
    RAISE EXCEPTION 'consolidated trial balance must use get_account_movements';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'get_consolidated_trial_balance')
       LIKE '%journal_entry_lines%' THEN
    RAISE EXCEPTION 'consolidated trial balance must not query journal lines directly';
  END IF;

  -- 5. Refusal behaviour: an unknown group must raise, never return zero rows.
  BEGIN
    PERFORM * FROM public.resolve_consolidation_scope(
      '00000000-0000-0000-0000-000000000000'::uuid, current_date);
    RAISE EXCEPTION 'resolve_consolidation_scope must refuse an unknown group';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- expected
  END;

  -- 6. An inverted date range must be refused.
  BEGIN
    PERFORM * FROM public.get_consolidated_trial_balance(
      '00000000-0000-0000-0000-000000000000'::uuid, current_date, current_date - 1);
    RAISE EXCEPTION 'inverted date range must be refused';
  EXCEPTION WHEN others THEN
    NULL; -- expected
  END;

  RAISE NOTICE 'Brick 2 consolidated trial balance invariants: OK';
END $$;

ROLLBACK;
