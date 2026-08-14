-- pgTAP — Phase 3: every wms_tasks mutator is guarded by an optimistic lock.
--
-- Invariant under test: a mutator of a putaway task must (a) accept the version
-- the operator was looking at, (b) lock the row it validates against, and
-- (c) bump the version so the next action is forced to re-read.
--
-- Before Phase 3 both putaway mutators read the task with a plain
-- `SELECT ... INTO` and took no version, so two concurrent partial putaways
-- could each validate their quantity against the same stale
-- `wms_tasks.quantity` and store more than the task held.
--
-- Checks are structural (signature shape + function-body introspection),
-- matching wms_dispatch_relieves_inventory_test.sql: exercising a real split
-- needs a full org/warehouse/LPN/quant fixture that other suites already own,
-- while structural pinning is what stops a migration silently reverting this.
--
-- Run with:  select * from runtests('public'::name);  (after `create extension pgtap;`)

BEGIN;

SELECT plan(11);

-- ------------------------------------------------------------------
-- I1. Signatures carry an expected version.
-- ------------------------------------------------------------------
SELECT has_function(
  'public', 'wms_split_putaway_task',
  ARRAY['uuid','integer','numeric','uuid','text'],
  'wms_split_putaway_task takes (task, row_version, quantity, location, reason)'
);

SELECT has_function(
  'public', 'wms_reassign_putaway_task',
  ARRAY['uuid','integer','uuid','text'],
  'wms_reassign_putaway_task takes (task, row_version, location, reason)'
);

SELECT has_function(
  'public', 'wms_transition_task',
  ARRAY['uuid','wms_task_state','integer','uuid','text','jsonb'],
  'wms_transition_task remains the authoritative task FSM'
);

-- ------------------------------------------------------------------
-- I2. The un-versioned legacy signatures are gone — an overload would let a
--     stale client keep calling the unguarded path.
-- ------------------------------------------------------------------
SELECT hasnt_function(
  'public', 'wms_split_putaway_task', ARRAY['uuid','numeric','uuid','text'],
  'the un-versioned split overload no longer exists'
);

SELECT hasnt_function(
  'public', 'wms_reassign_putaway_task', ARRAY['uuid','uuid','text'],
  'the un-versioned reassign overload no longer exists'
);

-- ------------------------------------------------------------------
-- I3. The task row is locked before it is validated.
-- ------------------------------------------------------------------
SELECT ok(
  pg_get_functiondef('public.wms_split_putaway_task(uuid,integer,numeric,uuid,text)'::regprocedure)
    ~ 'FROM public\.wms_tasks WHERE id = p_task_id FOR UPDATE',
  'split locks the task row (FOR UPDATE)'
);

SELECT ok(
  pg_get_functiondef('public.wms_reassign_putaway_task(uuid,integer,uuid,text)'::regprocedure)
    ~ 'FROM public\.wms_tasks WHERE id = p_task_id FOR UPDATE',
  'reassign locks the task row (FOR UPDATE)'
);

-- ------------------------------------------------------------------
-- I4. A version mismatch aborts with the serialization-failure code the
--     client maps to "someone else updated this task".
-- ------------------------------------------------------------------
SELECT ok(
  pg_get_functiondef('public.wms_split_putaway_task(uuid,integer,numeric,uuid,text)'::regprocedure)
    ~ 'row_version <> p_row_version[\s\S]{0,300}wms_task_stale',
  'split rejects a stale version'
);

SELECT ok(
  pg_get_functiondef('public.wms_reassign_putaway_task(uuid,integer,uuid,text)'::regprocedure)
    ~ 'row_version <> p_row_version[\s\S]{0,300}wms_task_stale',
  'reassign rejects a stale version'
);

-- ------------------------------------------------------------------
-- I5. Each successful mutation bumps the version.
-- ------------------------------------------------------------------
SELECT ok(
  pg_get_functiondef('public.wms_split_putaway_task(uuid,integer,numeric,uuid,text)'::regprocedure)
    LIKE '%row_version = v_task.row_version + 1%',
  'split bumps row_version'
);

SELECT ok(
  pg_get_functiondef('public.wms_reassign_putaway_task(uuid,integer,uuid,text)'::regprocedure)
    LIKE '%row_version = v_task.row_version + 1%',
  'reassign bumps row_version'
);

SELECT * FROM finish();
ROLLBACK;
