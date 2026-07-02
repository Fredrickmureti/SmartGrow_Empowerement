-- Phase 2 — device_assignments RLS regression test.
-- Static catalog assertions (no fixture seeding) so it runs in any DB:
--   1. RLS is enabled on public.device_assignments.
--   2. SELECT/INSERT/UPDATE/DELETE policies all exist and are org-scoped.
--   3. The mirror trigger from pos_hardware_configs is present.
--   4. The anon role has no policy that would allow direct access.
\set ON_ERROR_STOP on

-- (1) RLS enabled
DO $$
DECLARE rls_on boolean;
BEGIN
  SELECT relrowsecurity INTO rls_on
  FROM pg_class
  WHERE oid = 'public.device_assignments'::regclass;
  IF NOT rls_on THEN
    RAISE EXCEPTION 'device_assignments: RLS is NOT enabled';
  END IF;
END $$;

-- (2) One policy per command, all scoped via user_roles
DO $$
DECLARE
  cmds text[] := ARRAY['SELECT','INSERT','UPDATE','DELETE'];
  c text;
  pol_count int;
  scoped_count int;
  missing text[] := ARRAY[]::text[];
BEGIN
  FOREACH c IN ARRAY cmds LOOP
    SELECT count(*) INTO pol_count
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'device_assignments'
      AND cmd = c;
    IF pol_count = 0 THEN
      missing := array_append(missing, c);
    END IF;

    SELECT count(*) INTO scoped_count
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'device_assignments'
      AND cmd = c
      AND (
        COALESCE(qual, '')       LIKE '%user_roles%'
        OR COALESCE(with_check,'') LIKE '%user_roles%'
      );
    IF scoped_count = 0 THEN
      RAISE EXCEPTION 'device_assignments: % policy is not org-scoped via user_roles', c;
    END IF;
  END LOOP;
  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'device_assignments: missing policies for %', missing;
  END IF;
END $$;

-- (3) Mirror trigger from pos_hardware_configs must exist
DO $$
DECLARE trg_count int;
BEGIN
  SELECT count(*) INTO trg_count
  FROM pg_trigger
  WHERE tgrelid = 'public.pos_hardware_configs'::regclass
    AND tgname = 'pos_hw_config_mirror'
    AND NOT tgisinternal;
  IF trg_count = 0 THEN
    RAISE EXCEPTION 'pos_hw_config_mirror trigger missing on pos_hardware_configs';
  END IF;
END $$;

-- (4) anon must have NO permissive policy on device_assignments
DO $$
DECLARE anon_pols int;
BEGIN
  SELECT count(*) INTO anon_pols
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'device_assignments'
    AND 'anon' = ANY (roles);
  IF anon_pols > 0 THEN
    RAISE EXCEPTION 'device_assignments: % policy(s) grant access to anon — must be zero', anon_pols;
  END IF;
END $$;