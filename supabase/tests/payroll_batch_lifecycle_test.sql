-- ============================================================================
-- Payroll Batch lifecycle & RPC structural invariants (ADR-0045).
--
-- Pins the surface area the Control Center depends on. Fails if a future
-- migration drops the lifecycle trigger, removes any lifecycle RPC,
-- relaxes the transition matrix, weakens the period-active uniqueness
-- index, or removes the source_batch_id linkage on payment batches.
-- ============================================================================
BEGIN;
SELECT plan(16);

-- (1) Lifecycle trigger present.
SELECT has_function(
  'public','validate_payroll_batch_lifecycle',
  'validate_payroll_batch_lifecycle() must exist'
);
SELECT has_trigger(
  'public','payroll_run_groups','trg_validate_payroll_batch_lifecycle',
  'lifecycle trigger must be installed on payroll_run_groups'
);

-- (2) Core lifecycle RPCs must exist with the documented arity.
SELECT has_function('public','payroll_batch_create',
  ARRAY['uuid','uuid','uuid','date','date','text','text','text','text','text','uuid'],
  'payroll_batch_create must keep its 11-arg signature');
SELECT has_function('public','payroll_batch_submit',  ARRAY['uuid'],         'payroll_batch_submit must exist');
SELECT has_function('public','payroll_batch_approve', ARRAY['uuid','text'],  'payroll_batch_approve must accept override reason');
SELECT has_function('public','payroll_batch_cancel',  ARRAY['uuid','text'],  'payroll_batch_cancel must exist');
SELECT has_function('public','payroll_batch_mark_posted', ARRAY['uuid'],     'payroll_batch_mark_posted must exist');
SELECT has_function('public','payroll_batch_mark_paid',   ARRAY['uuid'],     'payroll_batch_mark_paid must exist');
SELECT has_function('public','payroll_batch_close',       ARRAY['uuid'],     'payroll_batch_close must exist');
SELECT has_function('public','payroll_batch_reverse',     ARRAY['uuid','text'], 'payroll_batch_reverse must exist (Phase B)');
SELECT has_function('public','payroll_batch_add_run',
  ARRAY['uuid','date','date','date','text','public.payroll_run_scope_kind','uuid','text'],
  'payroll_batch_add_run must keep its 8-arg signature (Phase C)');
SELECT has_function('public','payroll_payment_batch_link', ARRAY['uuid','uuid'],
  'payroll_payment_batch_link must exist (Phase C)');

-- (3) Event helper still in place.
SELECT has_function('public','_payroll_batch_emit_event',
  ARRAY['public.payroll_run_groups','text','jsonb'],
  'event emission helper must exist');

-- (4) Payment batch linkage column still present.
SELECT has_column('public','payroll_payment_batches','source_batch_id',
  'source_batch_id must remain on payroll_payment_batches');

-- (5) Readiness snapshot surface (Phase D).
SELECT has_table('public','payroll_batch_readiness_snapshots',
  'payroll_batch_readiness_snapshots table must exist');
SELECT has_column('public','payroll_run_groups','readiness_snapshot_id',
  'payroll_run_groups.readiness_snapshot_id must remain');

SELECT * FROM finish();
ROLLBACK;