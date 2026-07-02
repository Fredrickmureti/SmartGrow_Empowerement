
-- ============================================================
-- PHASE E: Tenant write-lock enforcement (DB-level)
-- Locks writes on tables when the owning organization is
-- suspended OR pending deletion. Bypassable via session GUC
-- for platform-admin and automated cleanup contexts.
-- ============================================================

-- 1. Core assertion helper
CREATE OR REPLACE FUNCTION public.assert_org_not_locked(_org_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bypass text;
  v_suspended boolean;
  v_pending_deletion timestamptz;
BEGIN
  IF _org_id IS NULL THEN
    RETURN;
  END IF;

  -- Bypass for platform-admin / cleanup / reset flows
  BEGIN
    v_bypass := current_setting('app.bypass_org_lock', true);
  EXCEPTION WHEN OTHERS THEN
    v_bypass := NULL;
  END;
  IF v_bypass = 'on' OR v_bypass = 'true' THEN
    RETURN;
  END IF;

  -- Also honor existing tenant-delete / reset GUCs
  BEGIN
    IF current_setting('app.tenant_delete', true) IN ('on','true')
       OR current_setting('app.reset_in_progress', true) IN ('on','true') THEN
      RETURN;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  SELECT is_suspended, scheduled_deletion_at
    INTO v_suspended, v_pending_deletion
  FROM public.organizations
  WHERE id = _org_id;

  IF v_suspended IS TRUE THEN
    RAISE EXCEPTION 'Organization is suspended; writes are disabled.'
      USING ERRCODE = 'P0001', HINT = 'Contact platform admin to unsuspend.';
  END IF;

  IF v_pending_deletion IS NOT NULL AND v_pending_deletion <= now() + INTERVAL '365 days' THEN
    -- Pending deletion => read-only grace period
    RAISE EXCEPTION 'Organization is pending deletion; writes are disabled during grace period.'
      USING ERRCODE = 'P0001', HINT = 'Cancel scheduled deletion to restore write access.';
  END IF;
END;
$$;

-- 2. Generic trigger function — uses NEW.organization_id (or OLD on DELETE)
CREATE OR REPLACE FUNCTION public.enforce_org_write_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    BEGIN
      EXECUTE format('SELECT ($1).%I::uuid', 'organization_id') INTO v_org USING OLD;
    EXCEPTION WHEN OTHERS THEN
      v_org := NULL;
    END;
  ELSE
    BEGIN
      EXECUTE format('SELECT ($1).%I::uuid', 'organization_id') INTO v_org USING NEW;
    EXCEPTION WHEN OTHERS THEN
      v_org := NULL;
    END;
  END IF;

  PERFORM public.assert_org_not_locked(v_org);

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- 3. Attach dynamically to all public tables with organization_id column.
--    Skip ledger/cleanup tables that must remain writable by the delete pipeline.
DO $$
DECLARE
  r record;
  skip_tables text[] := ARRAY[
    'organizations',
    'organization_deletion_jobs',
    'audit_logs',
    'platform_admin_alerts'
  ];
BEGIN
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND c.column_name = 'organization_id'
      AND t.table_type = 'BASE TABLE'
      AND NOT (c.table_name = ANY(skip_tables))
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_enforce_org_write_lock ON public.%I;', r.table_name
    );
    EXECUTE format($f$
      CREATE TRIGGER trg_enforce_org_write_lock
      BEFORE INSERT OR UPDATE OR DELETE ON public.%I
      FOR EACH ROW EXECUTE FUNCTION public.enforce_org_write_lock();
    $f$, r.table_name);
  END LOOP;
END $$;

-- 4. Ensure platform-admin functions that do housekeeping set the bypass GUC.
--    Update internal cleanup path to flip bypass for its txn.
CREATE OR REPLACE FUNCTION public._execute_organization_delete(_org_id uuid, _job_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Bypass write-lock triggers & app-dep triggers for this transaction
  PERFORM set_config('app.bypass_org_lock', 'on', true);
  PERFORM set_config('app.tenant_delete', 'on', true);
  PERFORM set_config('app.reset_in_progress', 'on', true);

  UPDATE public.organization_deletion_jobs
     SET status = 'running',
         started_at = COALESCE(started_at, now()),
         attempts = attempts + 1
   WHERE id = _job_id;

  -- Perform the hard delete via existing platform function
  PERFORM public.platform_delete_organization(_org_id);

  UPDATE public.organization_deletion_jobs
     SET status = 'completed',
         finished_at = now()
   WHERE id = _job_id;
EXCEPTION WHEN OTHERS THEN
  UPDATE public.organization_deletion_jobs
     SET status = 'failed',
         error_text = SQLERRM,
         finished_at = now()
   WHERE id = _job_id;
  RAISE;
END;
$$;

-- 5. Expose a read-only RPC for the admin UI to fetch deletion jobs
CREATE OR REPLACE FUNCTION public.get_organization_deletion_jobs(_org_id uuid DEFAULT NULL)
RETURNS SETOF public.organization_deletion_jobs
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT j.*
  FROM public.organization_deletion_jobs j
  WHERE public.is_platform_admin(auth.uid())
    AND (_org_id IS NULL OR j.organization_id = _org_id)
  ORDER BY j.created_at DESC
  LIMIT 200;
$$;

GRANT EXECUTE ON FUNCTION public.get_organization_deletion_jobs(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assert_org_not_locked(uuid) TO authenticated;
