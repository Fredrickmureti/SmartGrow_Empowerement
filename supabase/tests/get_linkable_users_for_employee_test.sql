-- Regression guard for get_linkable_users_for_employee.
--
-- Historically this function raised
--   "column reference \"user_id\" is ambiguous"
-- because two internal CTEs projected a column literally named `user_id`,
-- shadowing the RETURNS TABLE(user_id …) output column inside `IN (SELECT
-- user_id FROM …)` predicates. The fix renames CTE columns to
-- `linked_user_id` and `admin_user_id`.
--
-- These tests are schema-shape only: we don't fabricate an authenticated
-- caller (SECURITY DEFINER + auth.uid()), we assert that the function
-- definition remains structurally correct so the ambiguity cannot come back.

BEGIN;
SELECT plan(4);

-- 1. Function exists with the exact signature the app calls.
SELECT has_function(
  'public',
  'get_linkable_users_for_employee',
  ARRAY['uuid','uuid'],
  'get_linkable_users_for_employee(uuid, uuid) is present'
);

-- 2. Return columns are stable — the outer contract UI/RPC depends on.
SELECT bag_has(
  $$SELECT unnest(proargnames)::text
      FROM pg_proc
     WHERE proname = 'get_linkable_users_for_employee'
       AND pronamespace = 'public'::regnamespace$$,
  $$VALUES ('p_org_id'),('p_employee_id'),
           ('user_id'),('display_name'),('email_masked'),
           ('linkability'),('block_reason')$$,
  'function preserves its parameter + return column contract'
);

-- 3. Body must no longer contain the ambiguous CTE column names.
--    (Regex is anchored on the exact strings that used to collide.)
SELECT is(
  (SELECT (pg_get_functiondef(p.oid) ~ '\mSELECT\s+user_id\s+FROM\s+(pa|linked_elsewhere)\M')::int
     FROM pg_proc p
    WHERE p.proname = 'get_linkable_users_for_employee'
      AND p.pronamespace = 'public'::regnamespace),
  0,
  'no unqualified `SELECT user_id FROM pa|linked_elsewhere` remains (ambiguity guard)'
);

-- 4. Body references the renamed columns, proving the fix is in place.
SELECT is(
  (SELECT ((pg_get_functiondef(p.oid) ILIKE '%linked_user_id%')
        AND (pg_get_functiondef(p.oid) ILIKE '%admin_user_id%'))::int
     FROM pg_proc p
    WHERE p.proname = 'get_linkable_users_for_employee'
      AND p.pronamespace = 'public'::regnamespace),
  1,
  'renamed CTE columns linked_user_id / admin_user_id are present'
);

SELECT * FROM finish();
ROLLBACK;
