-- pgTAP — Phase C (proof of dispatch) + Phase D (carrier abstraction).
--
-- Invariants under test:
--   C1. Proof rows exist, are RLS-protected, and are written only through
--       `wms_capture_dispatch_proof` (SECURITY DEFINER).
--   C2. The FSM — not the client — refuses `closed → dispatched` without
--       proof when the warehouse requires it (`WMS_PROOF_REQUIRED`).
--   C3. Capture is idempotent per manifest, and the seal recorded on the
--       paperwork is propagated to the trailer visit so the seal on the
--       truck cannot diverge from the seal on the document.
--   D1. Tracking identity is allocated by an RPC, is idempotent, and the
--       carrier's kind is a bounded vocabulary.
--
-- Structural pinning (function-body introspection) for the same reason as
-- the Phase A suite: exercising a live dispatch needs the full WMS fixture.
--
-- Run with:  select * from runtests('public'::name);

BEGIN;

SELECT plan(14);

-- ---------------------------------------------------------------- C1
SELECT has_table('public', 'wms_dispatch_proofs', 'proof table exists');

SELECT ok(
  (SELECT relrowsecurity FROM pg_class
    WHERE oid = 'public.wms_dispatch_proofs'::regclass),
  'wms_dispatch_proofs has RLS enabled'
);

SELECT ok(
  (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'wms_dispatch_proofs') > 0,
  'wms_dispatch_proofs carries at least one policy'
);

SELECT has_function(
  'public', 'wms_capture_dispatch_proof',
  'capture RPC exists'
);

SELECT ok(
  (SELECT p.prosecdef FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'wms_capture_dispatch_proof'
    LIMIT 1),
  'wms_capture_dispatch_proof is SECURITY DEFINER'
);

-- ---------------------------------------------------------------- C2
SELECT ok(
  (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'wms_transition_manifest'
    LIMIT 1) LIKE '%WMS_PROOF_REQUIRED%',
  'the manifest FSM refuses departure without proof (WMS_PROOF_REQUIRED)'
);

SELECT ok(
  (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'wms_transition_manifest'
    LIMIT 1) LIKE '%wms_dispatch_proofs%',
  'the FSM reads proof state itself rather than trusting a caller flag'
);

SELECT has_column(
  'public', 'warehouses', 'require_dispatch_proof',
  'enforcement is a warehouse setting, not a hardcoded rule'
);

-- ---------------------------------------------------------------- C3
SELECT ok(
  (SELECT count(*) FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'wms_dispatch_proofs'
      AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%manifest_id%') > 0,
  'one proof row per manifest — capture is idempotent'
);

SELECT ok(
  (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'wms_capture_dispatch_proof'
    LIMIT 1) LIKE '%seal_out%',
  'the captured seal propagates to the trailer visit'
);

SELECT has_function(
  'public', 'wms_manifest_proof_status',
  'the server exposes the proof verdict so clients never re-derive it'
);

-- ---------------------------------------------------------------- D1
SELECT has_function(
  'public', 'wms_allocate_tracking_number', ARRAY['uuid','uuid'],
  'tracking allocation RPC exists with the adapter-shaped signature'
);

SELECT has_column(
  'public', 'wms_loading_manifests', 'tracking_number',
  'the manifest carries the shipping contract'
);

SELECT ok(
  (SELECT count(*) FROM pg_constraint
    WHERE conrelid = 'public.carriers'::regclass
      AND conname = 'carriers_carrier_kind_check') = 1,
  'carrier_kind is a bounded vocabulary'
);

SELECT * FROM finish();
ROLLBACK;
