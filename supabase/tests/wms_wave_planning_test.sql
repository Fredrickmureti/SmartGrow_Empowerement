-- pgTAP — ADR-0112 wave planning, readiness and release.
--
-- Invariants under test:
--   L1. The lifecycle expresses planning: `wms_wave_state` carries
--       planned / ready / suspended / completed / archived, and the wave is
--       a real spine (`wms_tasks.wave_id`, `wms_loading_manifests.wave_id`
--       are foreign keys, not JSON metadata).
--   S1. Waving is a strategy executed in SQL: `wms_wave_strategies` exists,
--       is RLS-protected, is seeded per warehouse, and drives
--       `wms_plan_waves`.
--   R1. Readiness is one server verdict: `wms_wave_readiness` scores every
--       dimension, maps each through `wms_wave_policies.readiness_rules`,
--       and `wms_evaluate_wave` persists it on the wave.
--   R2. The button and the rule cannot diverge: `release_pick_wave` gates on
--       the same verdict, and `p_force` is the single audited override.
--   C1. `wms_wave_capacity` forecasts the shift from operator minutes.
--   G1. Every wave RPC is SECURITY DEFINER and asserts business access, so
--       the tower cannot read across tenants.
--
-- Structural pinning (function-body introspection) is deliberate: exercising
-- a live wave needs the full WMS fixture (warehouse, locations, stock,
-- operators, shifts, orders), which the suite does not own.
--
-- Run with:  select * from runtests('public'::name);

BEGIN;

SELECT plan(36);

-- ---------------------------------------------------------------- L1
SELECT ok(
  (SELECT count(*) FROM unnest(enum_range(NULL::public.wms_wave_state)) s
    WHERE s::text IN ('planned','ready','suspended','completed','archived')) = 5,
  'wms_wave_state carries the planning lifecycle, not just execution'
);

SELECT has_column('public', 'wms_tasks', 'wave_id', 'tasks hang off the wave spine');
SELECT has_column('public', 'wms_loading_manifests', 'wave_id', 'manifests hang off the wave spine');

SELECT ok(
  (SELECT count(*) FROM pg_constraint
    WHERE conrelid = 'public.wms_tasks'::regclass
      AND contype = 'f'
      AND confrelid = 'public.wms_pick_waves'::regclass) = 1,
  'wms_tasks.wave_id is a real foreign key to wms_pick_waves'
);

SELECT ok(
  (SELECT count(*) FROM pg_constraint
    WHERE conrelid = 'public.wms_loading_manifests'::regclass
      AND contype = 'f'
      AND confrelid = 'public.wms_pick_waves'::regclass) = 1,
  'wms_loading_manifests.wave_id is a real foreign key to wms_pick_waves'
);

SELECT has_column('public', 'wms_pick_waves', 'readiness', 'the verdict is persisted on the wave');
SELECT has_column('public', 'wms_pick_waves', 'readiness_checked_at', 'the verdict carries its own freshness');
SELECT has_column('public', 'wms_pick_waves', 'strategy_id', 'a wave remembers the strategy that produced it');
SELECT has_column('public', 'wms_pick_waves', 'row_version', 'lifecycle transitions are optimistically concurrent');

-- ---------------------------------------------------------------- S1
SELECT has_table('public', 'wms_wave_strategies', 'strategy table exists');

SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.wms_wave_strategies'::regclass),
  'wms_wave_strategies has RLS enabled'
);

SELECT ok(
  (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'wms_wave_strategies') > 0,
  'wms_wave_strategies carries at least one policy'
);

SELECT has_column('public', 'wms_wave_strategies', 'sequence', 'strategies are ordered, so evaluation is deterministic');
SELECT has_column('public', 'wms_wave_strategies', 'criteria', 'grouping rules are data, not code');

SELECT has_function('public', 'wms_plan_waves', 'the planner exists');
SELECT has_function('public', 'wms_seed_default_wave_strategies', 'default strategies are provisioned, never assumed');

SELECT ok(
  (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'wms_plan_waves' LIMIT 1)
    LIKE '%wms_wave_strategies%',
  'wms_plan_waves reads the strategy table rather than hardcoding a rule'
);

-- Planning proposes; it touches neither stock nor tasks.
SELECT ok(
  (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'wms_plan_waves' LIMIT 1)
    NOT LIKE '%INSERT INTO public.wms_tasks%',
  'planning creates no tasks — release does'
);

SELECT ok(
  (SELECT count(*) FROM public.warehouses w
    WHERE NOT EXISTS (
      SELECT 1 FROM public.wms_wave_strategies s WHERE s.warehouse_id = w.id
    )) = 0,
  'every warehouse has at least one wave strategy — the engine is never inert'
);

-- ---------------------------------------------------------------- R1
SELECT has_function('public', 'wms_wave_readiness', 'the readiness scorer exists');
SELECT has_function('public', 'wms_evaluate_wave', 'the readiness persister exists');
SELECT has_column('public', 'wms_wave_policies', 'readiness_rules', 'block/warn/ignore is configuration, not code');
SELECT has_column('public', 'wms_wave_policies', 'allow_force', 'override permission is a policy decision');

SELECT ok(
  (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'wms_wave_readiness' LIMIT 1)
    LIKE '%readiness_rules%',
  'readiness maps each dimension through the policy'
);

-- Every dimension the tower renders must be scored by the server.
SELECT ok(
  (SELECT bool_and(
     (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'wms_wave_readiness' LIMIT 1)
     LIKE '%' || d || '%')
   FROM unnest(ARRAY[
     'stock', 'labour', 'departure', 'exceptions',
     'quality', 'freeze', 'congestion'
   ]) AS d),
  'readiness scores all seven dimensions server-side'
);

SELECT ok(
  (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'wms_evaluate_wave' LIMIT 1)
    LIKE '%wms_wave_readiness%',
  'evaluate delegates scoring — there is exactly one scorer'
);

-- ---------------------------------------------------------------- R2
SELECT has_function('public', 'release_pick_wave', 'release RPC exists');

SELECT ok(
  (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'release_pick_wave' LIMIT 1)
    LIKE '%wms_wave_readiness%',
  'release gates on the same verdict the supervisor sees'
);

SELECT ok(
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'release_pick_wave'
      AND pg_get_function_identity_arguments(p.oid) LIKE '%p_force boolean%') = 1,
  'p_force is the single, explicit override on one release overload'
);

SELECT ok(
  (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'release_pick_wave' LIMIT 1)
    LIKE '%wms_tasks%',
  'release generates the work the wave implies, in one transaction'
);

-- ---------------------------------------------------------------- C1
SELECT has_function('public', 'wms_wave_capacity', 'capacity forecast exists');

SELECT ok(
  (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'wms_wave_capacity' LIMIT 1)
    LIKE '%wms_labour%',
  'capacity is derived from the labour module, not guessed'
);

-- ---------------------------------------------------------------- G1
SELECT ok(
  (SELECT bool_and(p.prosecdef)
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'wms_plan_waves', 'wms_evaluate_wave', 'wms_wave_readiness',
        'wms_transition_wave', 'release_pick_wave', 'wms_wave_capacity',
        'wms_wave_health', 'wms_wave_board', 'wms_wave_demand',
        'wms_seed_default_wave_strategies')),
  'every wave RPC is SECURITY DEFINER'
);

SELECT ok(
  (SELECT bool_and(p.prosrc LIKE '%_wms_assert_business_access%')
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'wms_plan_waves', 'wms_evaluate_wave', 'wms_wave_capacity',
        'wms_wave_health', 'wms_wave_board', 'wms_wave_demand')),
  'every wave read/plan RPC asserts tenant access before answering'
);

SELECT has_function('public', 'wms_transition_wave', 'the lifecycle has exactly one write path');

SELECT ok(
  (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'wms_transition_wave' LIMIT 1)
    LIKE '%row_version%',
  'lifecycle transitions are guarded by optimistic concurrency'
);

SELECT * FROM finish();
ROLLBACK;
