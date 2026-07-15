-- Regression guard for upsert_organization_invitation.
--
-- Historically the RPC inserted p_permission_group_ids verbatim, so a NULL
-- input violated organization_invitations.permission_group_ids NOT NULL
-- DEFAULT '{}'. The invite flow legitimately passes NULL for "assign groups
-- later" and portal invitations (the default "Internal Users" system group
-- is applied inside accept_organization_invitation_atomic).
--
-- The fix coalesces NULL → ARRAY[]::uuid[] before both INSERT and UPDATE.

BEGIN;
SELECT plan(4);

-- 1. Function signature matches what the client calls.
SELECT has_function(
  'public',
  'upsert_organization_invitation',
  ARRAY['uuid','text','app_role','text','uuid[]','uuid','integer'],
  'upsert_organization_invitation signature is stable'
);

-- 2. Column invariant we rely on — NOT NULL DEFAULT '{}'.
SELECT col_not_null(
  'public','organization_invitations','permission_group_ids',
  'permission_group_ids is NOT NULL'
);

SELECT col_default_is(
  'public','organization_invitations','permission_group_ids','{}'::uuid[],
  'permission_group_ids defaults to empty uuid[]'
);

-- 3. Body must contain the COALESCE that turns NULL inputs into an empty
--    array before it hits the NOT NULL column. Regex tolerates whitespace.
SELECT is(
  (SELECT (pg_get_functiondef(p.oid) ~*
           'COALESCE\s*\(\s*p_permission_group_ids\s*,\s*ARRAY\s*\[\s*\]\s*::\s*uuid\s*\[\s*\]\s*\)')::int
     FROM pg_proc p
    WHERE p.proname = 'upsert_organization_invitation'
      AND p.pronamespace = 'public'::regnamespace),
  1,
  'RPC coalesces NULL permission_group_ids to empty uuid[] before writing'
);

SELECT * FROM finish();
ROLLBACK;
