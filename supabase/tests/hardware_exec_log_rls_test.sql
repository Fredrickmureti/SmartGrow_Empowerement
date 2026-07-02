-- hardware_exec_log RLS regression test (static catalog assertions).
--   1. RLS enabled.
--   2. SELECT/INSERT policies exist and are scoped via user_roles → organization_id.
--   3. WITH CHECK on INSERT pins actor_user_id to auth.uid().
--   4. The retention cleanup function exists and is SECURITY DEFINER with a pinned search_path.
--   5. The pg_cron job 'cleanup-hardware-exec-log-daily' is scheduled.
\set ON_ERROR_STOP on

-- (1) RLS enabled
DO $$
DECLARE rls_on boolean;
BEGIN
  SELECT relrowsecurity INTO rls_on
  FROM pg_class WHERE oid = 'public.hardware_exec_log'::regclass;
  IF NOT rls_on THEN
    RAISE EXCEPTION 'hardware_exec_log: RLS is NOT enabled';
  END IF;
END $$;

-- (2) SELECT and INSERT policies present, both reference user_roles for org scoping
DO $$
DECLARE
  sel_count int;
  ins_count int;
  scoped_sel int;
  scoped_ins int;
BEGIN
  SELECT count(*) INTO sel_count
  FROM pg_policies
  WHERE schemaname='public' AND tablename='hardware_exec_log' AND cmd='SELECT';
  IF sel_count = 0 THEN
    RAISE EXCEPTION 'hardware_exec_log: missing SELECT policy';
  END IF;

  SELECT count(*) INTO ins_count
  FROM pg_policies
  WHERE schemaname='public' AND tablename='hardware_exec_log' AND cmd='INSERT';
  IF ins_count = 0 THEN
    RAISE EXCEPTION 'hardware_exec_log: missing INSERT policy';
  END IF;

  SELECT count(*) INTO scoped_sel
  FROM pg_policies
  WHERE schemaname='public' AND tablename='hardware_exec_log' AND cmd='SELECT'
    AND qual ILIKE '%user_roles%' AND qual ILIKE '%organization_id%';
  IF scoped_sel = 0 THEN
    RAISE EXCEPTION 'hardware_exec_log: SELECT policy is not org-scoped via user_roles';
  END IF;

  SELECT count(*) INTO scoped_ins
  FROM pg_policies
  WHERE schemaname='public' AND tablename='hardware_exec_log' AND cmd='INSERT'
    AND with_check ILIKE '%user_roles%' AND with_check ILIKE '%organization_id%';
  IF scoped_ins = 0 THEN
    RAISE EXCEPTION 'hardware_exec_log: INSERT WITH CHECK is not org-scoped via user_roles';
  END IF;
END $$;

-- (3) INSERT WITH CHECK pins actor_user_id to auth.uid()
DO $$
DECLARE pinned int;
BEGIN
  SELECT count(*) INTO pinned
  FROM pg_policies
  WHERE schemaname='public' AND tablename='hardware_exec_log' AND cmd='INSERT'
    AND with_check ILIKE '%actor_user_id%' AND with_check ILIKE '%auth.uid()%';
  IF pinned = 0 THEN
    RAISE EXCEPTION 'hardware_exec_log: INSERT WITH CHECK does not pin actor_user_id to auth.uid()';
  END IF;
END $$;

-- (4) Retention function exists, is SECURITY DEFINER, search_path pinned
DO $$
DECLARE
  prosec boolean;
  pcfg text[];
BEGIN
  SELECT p.prosecdef, p.proconfig INTO prosec, pcfg
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='cleanup_old_hardware_exec_log';
  IF prosec IS NULL THEN
    RAISE EXCEPTION 'cleanup_old_hardware_exec_log: function missing';
  END IF;
  IF NOT prosec THEN
    RAISE EXCEPTION 'cleanup_old_hardware_exec_log: must be SECURITY DEFINER';
  END IF;
  IF pcfg IS NULL OR NOT (pcfg && ARRAY['search_path=public']) THEN
    RAISE EXCEPTION 'cleanup_old_hardware_exec_log: search_path is not pinned to public';
  END IF;
END $$;

-- (5) pg_cron job scheduled
DO $$
DECLARE jc int;
BEGIN
  SELECT count(*) INTO jc FROM cron.job WHERE jobname='cleanup-hardware-exec-log-daily';
  IF jc = 0 THEN
    RAISE EXCEPTION 'cleanup-hardware-exec-log-daily: pg_cron job not scheduled';
  END IF;
END $$;

SELECT 'hardware_exec_log RLS + retention test: OK' AS result;