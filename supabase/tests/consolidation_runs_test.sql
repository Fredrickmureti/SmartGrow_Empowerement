-- Brick 8 — consolidation runs: the reporting record.
--
-- Scope of this suite: the invariants that hold without seeding a whole group
-- of companies — privilege surface, the run guard's state machine, the freeze
-- of a run's basis, and the refusal paths of the three lifecycle functions
-- reachable by argument validation. Scenario coverage that needs member
-- ledgers (translation, eliminations, unmapped refusal) lives in
-- `consolidation_scenarios_test.sql`, which already seeds that fixture; this
-- file deliberately does not re-seed it, so it stays cheap to run.

BEGIN;
SELECT plan(24);

-- ── (A) The lifecycle functions exist and run as the caller ──────────
SELECT ok(
  (SELECT NOT p.prosecdef
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = fname),
  format('public.%I must be SECURITY INVOKER — a run may never see more than its caller', fname)
) FROM unnest(ARRAY[
  'consolidation_create_run','consolidation_finalize_run','consolidation_supersede_run'
]) AS fname;

SELECT ok(
  (SELECT p.proconfig @> ARRAY['search_path=public']
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = fname),
  format('public.%I must pin search_path', fname)
) FROM unnest(ARRAY[
  'consolidation_create_run','consolidation_finalize_run','consolidation_supersede_run'
]) AS fname;

-- ── (B) No anonymous reach into the reporting record ─────────────────
SELECT ok(
  NOT has_table_privilege('anon', 'public.' || tname, 'SELECT'),
  format('anon must not read public.%I', tname)
) FROM unnest(ARRAY[
  'consolidation_runs','consolidation_run_lines',
  'consolidation_run_members','consolidation_run_rates'
]) AS tname;

SELECT ok(
  relrowsecurity,
  format('public.%I must have row level security enabled', relname)
) FROM pg_class
 WHERE relname IN (
   'consolidation_runs','consolidation_run_lines',
   'consolidation_run_members','consolidation_run_rates'
 )
   AND relnamespace = 'public'::regnamespace;

SELECT ok(
  NOT has_function_privilege('anon', p.oid, 'EXECUTE'),
  format('anon must not execute public.%I', p.proname)
) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN (
     'consolidation_create_run','consolidation_finalize_run','consolidation_supersede_run'
   );

-- ── (C) The run guard is attached and owns the state machine ─────────
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.consolidation_runs'::regclass
       AND NOT t.tgisinternal
       AND t.tgname = 'consolidation_runs_guard'
  ),
  'consolidation_runs must carry its immutability guard trigger'
);

SELECT ok(
  pg_get_functiondef('public._consolidation_run_guard'::regproc)
    ~ 'draft.*final.*superseded',
  'The guard must allow only draft → final and → superseded'
);

SELECT ok(
  pg_get_functiondef('public._consolidation_run_guard'::regproc)
    ~ 'presentation_currency IS DISTINCT FROM OLD.presentation_currency',
  'A run''s presentation currency is fixed at creation'
);

SELECT ok(
  pg_get_functiondef('public._consolidation_run_guard'::regproc)
    ~ 'period_start IS DISTINCT FROM OLD.period_start',
  'A run''s period is fixed at creation'
);

-- ── (D) Refusal paths that need no fixture ───────────────────────────
SELECT throws_ok(
  $$SELECT public.consolidation_create_run(NULL, '2026-01-01', '2026-01-31')$$,
  NULL,
  NULL,
  'Creating a run without a group is refused'
);

SELECT throws_ok(
  $$SELECT public.consolidation_create_run(gen_random_uuid(), '2026-02-28', '2026-02-01')$$,
  NULL,
  NULL,
  'A run whose end precedes its start is refused'
);

SELECT throws_ok(
  $$SELECT public.consolidation_finalize_run(gen_random_uuid())$$,
  '42501',
  NULL,
  'Finalizing a run that is not visible to the caller is refused, not silently ignored'
);

SELECT throws_ok(
  $$SELECT public.consolidation_supersede_run(gen_random_uuid())$$,
  '42501',
  NULL,
  'Superseding a run that is not visible to the caller is refused'
);

-- ── (E) The freeze is real: detail hangs off the run and nothing else ─
SELECT ok(
  EXISTS (
    SELECT 1 FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage k USING (constraint_name, table_schema)
    WHERE tc.table_schema = 'public'
      AND tc.table_name = tname
      AND tc.constraint_type = 'FOREIGN KEY'
      AND k.column_name = 'run_id'
  ),
  format('public.%I must belong to a run', tname)
) FROM unnest(ARRAY[
  'consolidation_run_lines','consolidation_run_members','consolidation_run_rates'
]) AS tname;

SELECT ok(
  EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'consolidation_run_lines'
       AND column_name = 'member_contributions'
  ),
  'A stored line must carry the member contributions behind it, so drill-down needs no recomputation'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'consolidation_run_rates'
       AND column_name IN ('closing_rate','average_rate','historical_rate')
  ),
  'A run must freeze the FX basis it translated at'
);

-- ── (F) Creation snapshots the engine, it does not reimplement it ────
SELECT ok(
  pg_get_functiondef('public.consolidation_create_run'::regproc) ~ fn,
  format('consolidation_create_run must source its figures from %s', fn)
) FROM unnest(ARRAY[
  'resolve_consolidation_scope',
  'consolidation_member_translation_rates',
  'get_consolidated_statement_lines_eliminated',
  'get_consolidated_trial_balance_translated',
  'consolidation_eliminations_balance'
]) AS fn;

SELECT ok(
  pg_get_functiondef('public.consolidation_create_run'::regproc) ~ 'is_period_locked',
  'A run may not be created over a member''s closed period'
);

SELECT ok(
  pg_get_functiondef('public.consolidation_finalize_run'::regproc)
    ~ 'consolidation_unmapped_accounts',
  'Finalizing must refuse while a member account is unmapped'
);

SELECT ok(
  pg_get_functiondef('public.consolidation_finalize_run'::regproc) ~ 'is_balanced',
  'Finalizing must refuse an unbalanced elimination set'
);

SELECT ok(
  pg_get_functiondef('public.consolidation_finalize_run'::regproc)
    ~ 'superseded_by_run_id',
  'Finalizing must supersede the previous final run for the same group and period'
);

SELECT * FROM finish();
ROLLBACK;
