-- pgTAP — Phase A: dispatch relieves inventory.
--
-- Invariant under test: the moment a loading manifest departs, the stock it
-- carries must leave the books. Before Phase A the manifest FSM flipped state
-- and marked license plates 'shipped' without ever posting a stock movement,
-- so a warehouse that dispatched through the Loading Bay reported inventory it
-- no longer physically held.
--
-- These checks are structural (function-body introspection + signature shape)
-- rather than data-driven, because exercising a real dispatch requires a full
-- org/warehouse/wave/carton/LPN fixture that the other WMS suites already own.
-- Structural pinning is what stops a future migration from silently reverting
-- the ledger hook.
--
-- Run with:  select * from runtests('public'::name);  (after `create extension pgtap;`)

BEGIN;

SELECT plan(10);

-- ------------------------------------------------------------------
-- I1. The FSM is the single authoritative transition entry point.
-- ------------------------------------------------------------------
SELECT has_function(
  'public', 'wms_transition_manifest',
  ARRAY['uuid','wms_manifest_state','integer','text','jsonb'],
  'wms_transition_manifest is the authoritative manifest FSM'
);

-- ------------------------------------------------------------------
-- I2. Dispatching relieves inventory through the ledger-correct primitive.
--     wms_lpn_dispatch posts transfer_out movements and clears stock_quants;
--     the FSM must call it rather than reimplementing stock relief.
-- ------------------------------------------------------------------
SELECT ok(
  pg_get_functiondef('public.wms_transition_manifest(uuid,wms_manifest_state,integer,text,jsonb)'::regprocedure)
    LIKE '%wms_lpn_dispatch%',
  'wms_transition_manifest calls wms_lpn_dispatch on departure'
);

-- ------------------------------------------------------------------
-- I3. Relief is scoped to the dispatched edge, not close or cancel.
-- ------------------------------------------------------------------
SELECT ok(
  pg_get_functiondef('public.wms_transition_manifest(uuid,wms_manifest_state,integer,text,jsonb)'::regprocedure)
    ~ 'IF p_to_state = ''dispatched''[\s\S]{0,2000}wms_lpn_dispatch',
  'stock relief is gated on the dispatched transition'
);

-- ------------------------------------------------------------------
-- I4. Idempotency: an already-shipped plate must be skipped so a replayed
--     offline mutation cannot double-deduct.
-- ------------------------------------------------------------------
SELECT ok(
  pg_get_functiondef('public.wms_transition_manifest(uuid,wms_manifest_state,integer,text,jsonb)'::regprocedure)
    LIKE '%IS DISTINCT FROM ''shipped''%',
  'already-shipped license plates are skipped (no double deduction)'
);

-- ------------------------------------------------------------------
-- I5. Relief failures must NOT be swallowed. A BEGIN/EXCEPTION wrapper around
--     the dispatch call would let goods ship with an unbalanced ledger.
-- ------------------------------------------------------------------
SELECT ok(
  pg_get_functiondef('public.wms_transition_manifest(uuid,wms_manifest_state,integer,text,jsonb)'::regprocedure)
    !~ 'wms_lpn_dispatch[\s\S]{0,400}EXCEPTION\s+WHEN\s+OTHERS[\s\S]{0,200}RAISE\s+WARNING',
  'stock relief errors abort the dispatch instead of warning'
);

-- ------------------------------------------------------------------
-- I6. wms_lpn_dispatch itself still writes the ledger.
-- ------------------------------------------------------------------
SELECT ok(
  pg_get_functiondef('public.wms_lpn_dispatch(uuid,integer,text)'::regprocedure) LIKE '%stock_movements%',
  'wms_lpn_dispatch posts stock_movements'
);

SELECT ok(
  pg_get_functiondef('public.wms_lpn_dispatch(uuid,integer,text)'::regprocedure) LIKE '%transfer_out%',
  'wms_lpn_dispatch posts transfer_out movements'
);

SELECT ok(
  pg_get_functiondef('public.wms_lpn_dispatch(uuid,integer,text)'::regprocedure) LIKE '%stock_quants%',
  'wms_lpn_dispatch clears the source quants'
);

-- ------------------------------------------------------------------
-- I7. Legacy wrappers are delegates, not a second implementation. Two
--     independent dispatch paths is how the ledger gap appeared in the first
--     place.
-- ------------------------------------------------------------------
SELECT ok(
  pg_get_functiondef('public.dispatch_loading_manifest(uuid,timestamptz)'::regprocedure)
    LIKE '%wms_transition_manifest%',
  'dispatch_loading_manifest delegates to the FSM'
);

SELECT ok(
  pg_get_functiondef('public.close_loading_manifest(uuid)'::regprocedure)
    LIKE '%wms_transition_manifest%',
  'close_loading_manifest delegates to the FSM'
);

SELECT * FROM finish();
ROLLBACK;
