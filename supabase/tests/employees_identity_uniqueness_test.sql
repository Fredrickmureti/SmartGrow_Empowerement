-- HR Stabilization — Employee identity & uniqueness regression guards.
--
-- Asserts the invariants the architecture audit committed to:
--   1. work_email is unique per organization, drafts exempt.
--   2. personal email is NOT unique (shared mailboxes, rehires).
--   3. user_id is unique per (organization, business), drafts exempt.
--   4. national_id is unique per organization (where present).
--
-- These tests are intentionally schema-shape only — they query the
-- pg_indexes catalog rather than inserting fixture rows so they remain
-- fast and side-effect free in CI.

BEGIN;
SELECT plan(6);

-- 1. work_email unique index exists, scoped to org, drafts excluded.
SELECT isnt_empty(
  $$SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename  = 'employees'
      AND indexdef ILIKE '%work_email%'
      AND indexdef ILIKE '%organization_id%'
      AND indexdef ILIKE '%UNIQUE%'
      AND indexdef ILIKE '%lifecycle_status%'$$,
  'work_email has a partial unique index on (organization_id, lower(work_email)) excluding draft rows'
);

-- 2. personal email is intentionally NOT unique.
SELECT is(
  (SELECT count(*)::int FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename  = 'employees'
      AND indexdef ILIKE '%UNIQUE%'
      AND indexdef ~* '\(email\)'
      AND indexdef !~* 'work_email'),
  0,
  'personal `email` must NOT have a single-column unique index (shared mailboxes/rehires allowed)'
);

-- 3. user_id unique per (org, business), drafts exempt.
SELECT isnt_empty(
  $$SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename  = 'employees'
      AND indexdef ILIKE '%user_id%'
      AND indexdef ILIKE '%organization_id%'
      AND indexdef ILIKE '%business_id%'
      AND indexdef ILIKE '%UNIQUE%'
      AND indexdef ILIKE '%lifecycle_status%'$$,
  'user_id partial unique on (organization_id, business_id, user_id) excluding draft rows'
);

-- 4. national_id unique per org (NULLs allowed).
SELECT isnt_empty(
  $$SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename  = 'employees'
      AND indexdef ILIKE '%national_id%'
      AND indexdef ILIKE '%organization_id%'
      AND indexdef ILIKE '%UNIQUE%'$$,
  'national_id has a partial unique index per organization'
);

-- 5. lifecycle_status / is_active trigger mirror still in place.
SELECT isnt_empty(
  $$SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'employees'
      AND NOT t.tgisinternal
      AND pg_get_triggerdef(t.oid) ILIKE '%lifecycle_status%'$$,
  'lifecycle_status → is_active mirror trigger exists on employees'
);

-- 6. v_employees_canonical exposes the lifecycle bucket helpers.
SELECT bag_has(
  $$SELECT column_name::text FROM information_schema.columns
    WHERE table_schema='public' AND table_name='v_employees_canonical'$$,
  $$VALUES ('lifecycle_status'),('is_operationally_active'),('is_directory_visible'),('lifecycle_bucket')$$,
  'v_employees_canonical projects the lifecycle decision columns'
);

SELECT * FROM finish();
ROLLBACK;
