-- Step 7.3 — default elimination policy templates.
-- Run against a database with the consolidation migrations applied:
--   psql "$DATABASE_URL" -f supabase/tests/consolidation_elimination_defaults_test.sql
-- Any failed assertion raises and aborts the transaction; nothing is committed.

BEGIN;

DO $$
DECLARE
  v_missing integer;
  v_rule public.consolidation_elimination_rules;
  v_flag boolean;
BEGIN
  ------------------------------------------------------------ 1. wiring ----
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'consolidation_groups'
       AND t.tgname = 'trg_consolidation_group_seed_rules') THEN
    RAISE EXCEPTION 'a new consolidation group must be seeded with a default elimination policy';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'consolidation_elimination_rules'
       AND t.tgname = 'trg_consolidation_elimination_rule_default_flag') THEN
    RAISE EXCEPTION 'a rule must record whether it is still the system default';
  END IF;

  ------------------------------------------------------- 2. authorisation --
  IF has_function_privilege('anon',
       'public.consolidation_seed_default_elimination_rules(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not seed elimination policy';
  END IF;
  IF NOT has_function_privilege('authenticated',
       'public.consolidation_seed_default_elimination_rules(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'signed-in owners/admins must be able to seed missing defaults';
  END IF;
  IF has_function_privilege('anon',
       'public._consolidation_seed_default_rules(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the internal seeder must not be reachable anonymously';
  END IF;

  --------------------------------------------------------- 3. backfill -----
  SELECT count(*) INTO v_missing
    FROM public.consolidation_groups g
    CROSS JOIN (VALUES ('intercompany_balance'::public.consolidation_elimination_class),
                       ('intercompany_trading'::public.consolidation_elimination_class)) AS c(cls)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.consolidation_elimination_rules r
      WHERE r.group_id = g.id AND r.elimination_class = c.cls);
  IF v_missing <> 0 THEN
    RAISE EXCEPTION 'every group must hold a policy for both standard classes, % missing', v_missing;
  END IF;

  ------------------------------------------- 4. seeding is never destructive
  SELECT * INTO v_rule FROM public.consolidation_elimination_rules LIMIT 1;
  IF v_rule.id IS NOT NULL THEN
    PERFORM public._consolidation_seed_default_rules(v_rule.group_id);
    IF (SELECT tolerance_amount FROM public.consolidation_elimination_rules WHERE id = v_rule.id)
         IS DISTINCT FROM v_rule.tolerance_amount THEN
      RAISE EXCEPTION 'reseeding must never overwrite a policy someone already set';
    END IF;

    ------------------------------- 5. an edit marks the row as customised ---
    UPDATE public.consolidation_elimination_rules
       SET is_system_default = true
     WHERE id = v_rule.id;
    SELECT is_system_default INTO v_flag
      FROM public.consolidation_elimination_rules WHERE id = v_rule.id;
    IF v_flag THEN
      RAISE EXCEPTION 'a user edit must flip a rule out of system-default state';
    END IF;
  END IF;

  RAISE NOTICE 'Step 7.3 default elimination policy invariants: OK';
END $$;

ROLLBACK;
