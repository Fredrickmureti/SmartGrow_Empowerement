-- Runtime guard: employees.user_access_status must be derived by the DB
-- from (employees.user_id, organization_invitations), not by the client.
--
-- The test creates a scratch org + business + employee, then walks
-- through the four transitions the trigger network must handle:
--   none  → invited (pending invite arrives)
--   invited → active (user_id set)
--   active → invited (user_id nulled while invite still open)
--   invited → none (invite accepted/expires without a linked employee)

BEGIN;
SELECT plan(6);

-- Fixture ids so every assertion targets the same rows.
DO $$
DECLARE
  v_org uuid := gen_random_uuid();
  v_biz uuid := gen_random_uuid();
  v_emp uuid := gen_random_uuid();
  v_user uuid := gen_random_uuid();
BEGIN
  PERFORM set_config('test.org_id', v_org::text, true);
  PERFORM set_config('test.biz_id', v_biz::text, true);
  PERFORM set_config('test.emp_id', v_emp::text, true);
  PERFORM set_config('test.user_id', v_user::text, true);

  INSERT INTO public.organizations (id, name, owner_user_id)
  VALUES (v_org, 'idlifecycle test org', v_user);

  -- Insert a minimal employee. lifecycle-status trigger + user_access_status
  -- trigger should give us user_access_status = 'none'.
  INSERT INTO public.employees (id, organization_id, business_id, first_name, last_name,
                                work_email, email, lifecycle_status)
  VALUES (v_emp, v_org, v_biz, 'Ida', 'Lifecycle',
          'ida.lifecycle@example.test', 'ida.lifecycle@example.test', 'active');
END$$;

-- 1. Newly inserted employee with no user, no invite → 'none'.
SELECT is(
  (SELECT user_access_status FROM public.employees
    WHERE id = current_setting('test.emp_id')::uuid),
  'none',
  'fresh employee has user_access_status = none'
);

-- 2. Open invitation with matching employee_id flips status to 'invited'.
INSERT INTO public.organization_invitations
  (organization_id, email, role, user_type, token, expires_at, employee_id, permission_group_ids)
VALUES (
  current_setting('test.org_id')::uuid,
  'ida.lifecycle@example.test',
  'internal'::public.app_role,
  'internal',
  gen_random_uuid()::text,
  now() + interval '7 days',
  current_setting('test.emp_id')::uuid,
  ARRAY[]::uuid[]
);

SELECT is(
  (SELECT user_access_status FROM public.employees
    WHERE id = current_setting('test.emp_id')::uuid),
  'invited',
  'open invitation with FK → invited'
);

-- 3. Setting user_id flips to 'active'.
UPDATE public.employees
   SET user_id = current_setting('test.user_id')::uuid
 WHERE id = current_setting('test.emp_id')::uuid;

SELECT is(
  (SELECT user_access_status FROM public.employees
    WHERE id = current_setting('test.emp_id')::uuid),
  'active',
  'user_id set → active'
);

-- 4. Nulling user_id while the invite is still open → 'invited' again.
UPDATE public.employees SET user_id = NULL
 WHERE id = current_setting('test.emp_id')::uuid;

SELECT is(
  (SELECT user_access_status FROM public.employees
    WHERE id = current_setting('test.emp_id')::uuid),
  'invited',
  'user_id cleared but invite still open → invited'
);

-- 5. Accepting the invitation (accepted_at set) removes it from the
--    "open" set; with user_id still NULL the derived status is 'none'.
UPDATE public.organization_invitations SET accepted_at = now()
 WHERE organization_id = current_setting('test.org_id')::uuid
   AND employee_id     = current_setting('test.emp_id')::uuid;

SELECT is(
  (SELECT user_access_status FROM public.employees
    WHERE id = current_setting('test.emp_id')::uuid),
  'none',
  'invitation accepted without user_id → back to none'
);

-- 6. The BEFORE trigger + compute function are attached.
SELECT isnt_empty(
  $$SELECT 1 FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'employees'
      AND t.tgname  = '_employees_user_access_status_biu'$$,
  '_employees_user_access_status_biu trigger is installed'
);

SELECT * FROM finish();
ROLLBACK;
