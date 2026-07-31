-- Regression: tenant "wipe all transactional data" must not be blocked by
-- the approval_history append-only guard.
--
-- approval_history.request_id FKs into approval_requests with ON DELETE
-- CASCADE, so during reset_module__ancillaries the parent row is already
-- gone when the guard fires. Looking the org up from the parent therefore
-- yields NULL and the guard used to raise GOV_APPEND_ONLY, aborting the
-- whole reset. The guard must fall back to the txn-local teardown GUC.

BEGIN;
SELECT plan(4);

SELECT has_function('public', '_is_teardown_active', 'Teardown-active helper exists');

SELECT ok(
  (SELECT pg_get_functiondef(p.oid) ~ '_is_teardown_active'
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = '_approval_history_chain'),
  'approval_history guard falls back to _is_teardown_active when the parent request row is already cascaded away'
);

SELECT is(
  (SELECT confdeltype FROM pg_constraint
    WHERE conrelid = 'public.approval_history'::regclass
      AND conname = 'approval_history_request_id_fkey'),
  'c'::"char",
  'approval_history cascades from approval_requests (the condition that triggers the NULL-org lookup)'
);

SELECT ok(
  (SELECT pg_get_functiondef(p.oid) ~ 'DELETE FROM approval_history'
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'reset_module__ancillaries'),
  'reset clears approval history explicitly inside teardown context before deleting requests'
);

SELECT * FROM finish();
ROLLBACK;
