-- Regression guard for the Employee identity lifecycle wiring:
--   * the 5 new lifecycle event types
--   * organization_invitations.employee_id FK
--   * the 5 identity RPCs still have their expected signatures
--   * the RPC bodies still emit into employee_lifecycle_events
--
-- Schema-shape tests only; no fixture inserts. Runtime behaviour is
-- covered by employee_user_access_status_derived_test.sql.

BEGIN;
SELECT plan(9);

-- 1..5 enum values
SELECT is(
  (SELECT COUNT(*)::int FROM pg_enum e
     JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'employee_lifecycle_event_type'
      AND e.enumlabel IN ('user_invited','user_invitation_revoked',
                          'user_invitation_accepted','user_linked','user_unlinked')),
  5,
  'all five identity lifecycle event types exist on the enum'
);

-- 2. Invitation → Employee FK
SELECT isnt_empty(
  $$SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
    WHERE c.contype = 'f'
      AND t.relname = 'organization_invitations'
      AND pg_get_constraintdef(c.oid) ILIKE '%(employee_id)%REFERENCES%employees%ON DELETE SET NULL%'$$,
  'organization_invitations.employee_id → employees(id) ON DELETE SET NULL'
);

-- 3. Partial unique index enforcing one open invite per employee
SELECT isnt_empty(
  $$SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename  = 'organization_invitations'
       AND indexdef ILIKE '%UNIQUE%'
       AND indexdef ILIKE '%organization_id%'
       AND indexdef ILIKE '%employee_id%'
       AND indexdef ILIKE '%accepted_at IS NULL%'$$,
  'partial unique index (organization_id, employee_id) WHERE accepted_at IS NULL'
);

-- 4. Function signatures
SELECT has_function('public','upsert_organization_invitation',
  ARRAY['uuid','text','app_role','text','uuid[]','uuid','integer','uuid'],
  'upsert_organization_invitation now takes p_employee_id');

SELECT has_function('public','revoke_organization_invitation',
  ARRAY['uuid'],
  'revoke_organization_invitation(uuid) exists');

-- 5..8 RPC bodies must contain identity event emits
SELECT is(
  (SELECT (pg_get_functiondef(p.oid) ILIKE '%employee_lifecycle_events%'
        AND pg_get_functiondef(p.oid) ILIKE '%user_invited%')::int
     FROM pg_proc p WHERE p.proname='upsert_organization_invitation'
       AND p.pronamespace='public'::regnamespace),
  1, 'upsert_organization_invitation emits user_invited events');

SELECT is(
  (SELECT (pg_get_functiondef(p.oid) ILIKE '%employee_lifecycle_events%'
        AND pg_get_functiondef(p.oid) ILIKE '%user_invitation_accepted%')::int
     FROM pg_proc p WHERE p.proname='accept_organization_invitation_atomic'
       AND p.pronamespace='public'::regnamespace),
  1, 'accept_organization_invitation_atomic emits user_invitation_accepted');

SELECT is(
  (SELECT (pg_get_functiondef(p.oid) ILIKE '%employee_lifecycle_events%'
        AND pg_get_functiondef(p.oid) ILIKE '%user_linked%')::int
     FROM pg_proc p WHERE p.proname='link_employee_to_user'
       AND p.pronamespace='public'::regnamespace),
  1, 'link_employee_to_user emits user_linked');

SELECT is(
  (SELECT (pg_get_functiondef(p.oid) ILIKE '%employee_lifecycle_events%'
        AND pg_get_functiondef(p.oid) ILIKE '%user_unlinked%')::int
     FROM pg_proc p WHERE p.proname='unlink_employee_from_user'
       AND p.pronamespace='public'::regnamespace),
  1, 'unlink_employee_from_user emits user_unlinked');

SELECT * FROM finish();
ROLLBACK;
