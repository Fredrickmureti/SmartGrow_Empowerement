-- Replace the hand-maintained audit_logs_action_check enum with a permissive
-- regex check. The previous CHECK had drifted from the trigger code: the SoD
-- governance trigger (and many other emitters: leave.approve_level1, *.approve,
-- employee_terminated, sod.self_action_*, etc.) write action values that the
-- enum rejected, causing the entire enclosing transaction to roll back. That
-- in turn made accept-invitation return 500 for every second-member acceptance
-- since the membership insert fires promote_governance_mode_on_member_add()
-- which emits 'sod.governance_mode_changed'.
--
-- New shape: any lowercase snake_case identifier, optionally namespaced with
-- dots (e.g. 'sod.governance_mode_changed', 'leave.approve_level1',
-- 'employee.pii.read'). 1-100 chars. Still rejects garbage / SQL injection
-- shaped strings, but never blocks a legitimate audit emit again.

ALTER TABLE public.audit_logs
  DROP CONSTRAINT IF EXISTS audit_logs_action_check;

ALTER TABLE public.audit_logs
  ADD CONSTRAINT audit_logs_action_check
  CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$' AND length(action) BETWEEN 1 AND 100);