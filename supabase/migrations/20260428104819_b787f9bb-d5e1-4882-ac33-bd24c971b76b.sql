
-- ============================================================================
-- STAGE 1: Bypass app-dependency guard during tenant-wide deletion
-- ============================================================================
CREATE OR REPLACE FUNCTION public.block_app_uninstall_if_dependents_active()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  active_dependent TEXT;
  v_org uuid;
  v_reset_marker text;
  v_tenant_delete_marker text;
BEGIN
  v_org := COALESCE(OLD.organization_id, NEW.organization_id);
  -- Bypass during tenant-wide reset or tenant deletion. Both GUCs are
  -- transaction-local and cannot be forged by tenant users — they are set
  -- by SECURITY DEFINER functions (reset_organization_data,
  -- platform_delete_organization) that already enforce platform-admin /
  -- owner authorization.
  v_reset_marker := current_setting('app.reset_in_progress', true);
  v_tenant_delete_marker := current_setting('app.tenant_delete', true);
  IF v_reset_marker = v_org::text OR v_tenant_delete_marker = v_org::text THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    SELECT app_id INTO active_dependent
    FROM public.organization_installed_apps
    WHERE organization_id = OLD.organization_id
      AND is_active = true
      AND app_id <> OLD.app_id
      AND app_id IN (SELECT app_id FROM public.app_dependencies WHERE depends_on_app_id = OLD.app_id)
    LIMIT 1;
    IF active_dependent IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot uninstall %: app % depends on it. Uninstall % first.',
        OLD.app_id, active_dependent, active_dependent;
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.is_active = false AND OLD.is_active = true THEN
    SELECT app_id INTO active_dependent
    FROM public.organization_installed_apps
    WHERE organization_id = NEW.organization_id
      AND is_active = true
      AND app_id <> NEW.app_id
      AND app_id IN (SELECT app_id FROM public.app_dependencies WHERE depends_on_app_id = NEW.app_id)
    LIMIT 1;
    IF active_dependent IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot disable %: app % depends on it. Disable % first.',
        NEW.app_id, active_dependent, active_dependent;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- Mark the tenant-delete path so the guard (and any future org-cascade guards)
-- can bypass themselves. Transaction-local: auto-cleared at COMMIT/ROLLBACK.
CREATE OR REPLACE FUNCTION public.platform_delete_organization(p_org_id uuid, p_confirmation_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_expected_token text := 'DELETE-' || p_org_id::text;
  v_org_name text;
  v_reset jsonb;
  v_counts jsonb := '{}'::jsonb;
  n bigint;
  v_member_ids uuid[];
  v_orphan_member_ids uuid[] := ARRAY[]::uuid[];
  v_uid uuid;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501';
  END IF;

  IF NOT public.is_platform_admin(v_user) THEN
    RAISE EXCEPTION 'Platform admin access required' USING ERRCODE='42501';
  END IF;

  IF p_confirmation_token IS DISTINCT FROM v_expected_token THEN
    RAISE EXCEPTION 'Invalid confirmation token' USING ERRCODE='22023';
  END IF;

  SELECT name INTO v_org_name
  FROM public.organizations
  WHERE id = p_org_id;

  IF v_org_name IS NULL THEN
    RAISE EXCEPTION 'Organization not found' USING ERRCODE='P0002';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT user_id), ARRAY[]::uuid[])
  INTO v_member_ids
  FROM public.user_roles
  WHERE organization_id = p_org_id;

  v_reset := public.reset_organization_data(p_org_id, 'RESET-' || p_org_id::text);

  -- Privileged markers: reset + tenant-delete. Both are transaction-local.
  PERFORM set_config('app.reset_in_progress', p_org_id::text, true);
  PERFORM set_config('app.tenant_delete',     p_org_id::text, true);

  WITH d AS (DELETE FROM public.webhook_events WHERE organization_id = p_org_id RETURNING 1)
  SELECT count(*) INTO n FROM d;
  v_counts := v_counts || jsonb_build_object('webhook_events', n);

  WITH d AS (DELETE FROM public.platform_admin_alerts WHERE organization_id = p_org_id RETURNING 1)
  SELECT count(*) INTO n FROM d;
  v_counts := v_counts || jsonb_build_object('platform_admin_alerts', n);

  WITH d AS (DELETE FROM public.je_number_sequences WHERE organization_id = p_org_id RETURNING 1)
  SELECT count(*) INTO n FROM d;
  v_counts := v_counts || jsonb_build_object('je_number_sequences', n);

  INSERT INTO public.admin_audit_log (action_type, admin_user_id, target_org_id, target_entity_type, target_entity_id, details)
  VALUES (
    'platform_organization_delete',
    v_user,
    p_org_id,
    'organization',
    p_org_id,
    jsonb_build_object(
      'organization_name', v_org_name,
      'deleted_at', now(),
      'reset_result', v_reset,
      'platform_leftovers', v_counts
    )
  );

  DELETE FROM public.organizations WHERE id = p_org_id;

  FOREACH v_uid IN ARRAY v_member_ids LOOP
    IF v_uid IS NOT NULL AND public.is_orphan_identity(v_uid) THEN
      v_orphan_member_ids := array_append(v_orphan_member_ids, v_uid);
      INSERT INTO public.signup_cleanup_log(reaped_user_id, reaped_email, reason, metadata)
      SELECT v_uid, u.email,
             'workspace_deleted_no_remaining_tenancy',
             jsonb_build_object(
               'deleted_org_id', p_org_id,
               'deleted_org_name', v_org_name,
               'signaled_by', v_user,
               'identity_reap_signaled', true
             )
      FROM auth.users u WHERE u.id = v_uid;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'organization_id', p_org_id,
    'organization_name', v_org_name,
    'reset_result', v_reset,
    'platform_leftovers', v_counts,
    'former_member_user_ids', v_member_ids,
    'orphan_member_user_ids', v_orphan_member_ids
  );
END;
$function$;

-- ============================================================================
-- STAGE 2: Expand storage-paths helper to cover all tenant buckets
-- ============================================================================
CREATE OR REPLACE FUNCTION public.list_org_storage_paths(org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_receipts text[];
  v_doc_pdfs text[];
  v_documents text[];
  v_employee_docs text[];
  v_employee_avatars text[];
  v_org_assets text[];
  v_product_images text[];
  v_sign_documents text[];
  v_signatures text[];
  v_custom_field_attachments text[];
BEGIN
  PERFORM public._assert_reset_permission(org_id);

  SELECT coalesce(array_agg(DISTINCT receipt_url) FILTER (WHERE receipt_url IS NOT NULL AND receipt_url <> ''), ARRAY[]::text[])
    INTO v_receipts
  FROM expenses WHERE organization_id=org_id;

  SELECT coalesce(array_agg(DISTINCT file_path) FILTER (WHERE file_path IS NOT NULL AND file_path <> ''), ARRAY[]::text[])
    INTO v_doc_pdfs
  FROM documents WHERE organization_id=org_id;

  -- Per-bucket conventions: paths are stored in *_url or file_path columns,
  -- or follow the folder convention `<org_id>/…`. The edge function uses
  -- the folder-based bulk list as a fallback; here we return known explicit
  -- paths that have been persisted in tenant rows.
  v_documents                := v_doc_pdfs;  -- documents bucket shares file_path
  v_employee_docs            := ARRAY[]::text[];
  v_employee_avatars         := ARRAY[]::text[];
  v_org_assets               := ARRAY[]::text[];
  v_product_images           := ARRAY[]::text[];
  v_sign_documents           := ARRAY[]::text[];
  v_signatures               := ARRAY[]::text[];
  v_custom_field_attachments := ARRAY[]::text[];

  -- Each bucket row is org-scoped via folder prefix `<org_id>/`. The edge
  -- function lists the prefix directly from storage.objects and purges it
  -- wholesale — SQL only needs to signal *which buckets* to sweep.
  RETURN jsonb_build_object(
    'receipts',                  v_receipts,
    'document_pdfs',             v_doc_pdfs,
    'documents',                 v_documents,
    'employee_documents',        v_employee_docs,
    'employee_avatars',          v_employee_avatars,
    'organization_assets',       v_org_assets,
    'product_images',            v_product_images,
    'sign_documents',            v_sign_documents,
    'signatures',                v_signatures,
    'custom_field_attachments',  v_custom_field_attachments,
    'folder_prefix',             org_id::text || '/'
  );
END;
$function$;

-- ============================================================================
-- STAGE 3: Scheduled-deletion job ledger + executor + cron
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.organization_deletion_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  organization_name text,
  kind            text NOT NULL CHECK (kind IN ('scheduled','immediate')),
  status          text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','running','succeeded','failed')),
  attempts        int NOT NULL DEFAULT 0,
  error_text      text,
  requested_by    uuid,
  scheduled_for   timestamptz,
  started_at      timestamptz,
  finished_at     timestamptz,
  storage_cleanup_pending boolean NOT NULL DEFAULT true,
  result          jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_org_deletion_jobs_status
  ON public.organization_deletion_jobs (status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_org_deletion_jobs_org
  ON public.organization_deletion_jobs (organization_id);

ALTER TABLE public.organization_deletion_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Platform admins can view deletion jobs" ON public.organization_deletion_jobs;
CREATE POLICY "Platform admins can view deletion jobs"
ON public.organization_deletion_jobs
FOR SELECT
TO authenticated
USING (public.is_platform_admin(auth.uid()));

DROP POLICY IF EXISTS "Platform admins can insert deletion jobs" ON public.organization_deletion_jobs;
CREATE POLICY "Platform admins can insert deletion jobs"
ON public.organization_deletion_jobs
FOR INSERT
TO authenticated
WITH CHECK (public.is_platform_admin(auth.uid()));

-- No UPDATE/DELETE policy: jobs are immutable from the app layer; the executor
-- uses SECURITY DEFINER to mutate them.

CREATE OR REPLACE FUNCTION public.execute_due_scheduled_organization_deletions()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org RECORD;
  v_job_id uuid;
  v_result jsonb;
  v_processed int := 0;
  v_succeeded int := 0;
  v_failed int := 0;
  v_jobs jsonb := '[]'::jsonb;
BEGIN
  FOR v_org IN
    SELECT id, name, deletion_requested_by, scheduled_deletion_at
      FROM public.organizations
     WHERE scheduled_deletion_at IS NOT NULL
       AND scheduled_deletion_at <= now()
       AND deletion_cancelled_at IS NULL
     ORDER BY scheduled_deletion_at ASC
     LIMIT 50
  LOOP
    v_processed := v_processed + 1;

    INSERT INTO public.organization_deletion_jobs
      (organization_id, organization_name, kind, status, attempts,
       requested_by, scheduled_for, started_at)
    VALUES
      (v_org.id, v_org.name, 'scheduled', 'running', 1,
       v_org.deletion_requested_by, v_org.scheduled_deletion_at, now())
    RETURNING id INTO v_job_id;

    BEGIN
      -- platform_delete_organization requires auth.uid() = platform admin.
      -- This executor runs in the cron/service-role context where auth.uid()
      -- is NULL, so we inline the delete here under the same privileges
      -- (the function is SECURITY DEFINER owned by the postgres superuser).
      PERFORM public._execute_organization_delete(v_org.id);

      UPDATE public.organization_deletion_jobs
         SET status='succeeded',
             finished_at=now(),
             result=jsonb_build_object('organization_name', v_org.name)
       WHERE id = v_job_id;

      INSERT INTO public.admin_audit_log
        (action_type, admin_user_id, target_org_id, target_entity_type, target_entity_id, details)
      VALUES
        ('organization_deletion_executed', v_org.deletion_requested_by, v_org.id,
         'organization', v_org.id,
         jsonb_build_object('organization_name', v_org.name, 'job_id', v_job_id,
                            'scheduled_for', v_org.scheduled_deletion_at));

      v_succeeded := v_succeeded + 1;
      v_jobs := v_jobs || jsonb_build_object('job_id', v_job_id, 'org_id', v_org.id, 'status', 'succeeded');

    EXCEPTION WHEN OTHERS THEN
      UPDATE public.organization_deletion_jobs
         SET status='failed',
             finished_at=now(),
             error_text=SQLERRM
       WHERE id = v_job_id;

      INSERT INTO public.admin_audit_log
        (action_type, admin_user_id, target_org_id, target_entity_type, target_entity_id, details)
      VALUES
        ('organization_deletion_failed', v_org.deletion_requested_by, v_org.id,
         'organization', v_org.id,
         jsonb_build_object('organization_name', v_org.name, 'job_id', v_job_id,
                            'error', SQLERRM));

      v_failed := v_failed + 1;
      v_jobs := v_jobs || jsonb_build_object('job_id', v_job_id, 'org_id', v_org.id, 'status', 'failed', 'error', SQLERRM);
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'processed', v_processed,
    'succeeded', v_succeeded,
    'failed',    v_failed,
    'jobs',      v_jobs,
    'ran_at',    now()
  );
END;
$function$;

-- Internal helper that runs the actual delete without requiring auth.uid().
-- Mirrors platform_delete_organization but is only callable from the executor
-- (no GRANT to authenticated/anon). NOT SECURITY INVOKER — must be DEFINER so
-- RLS + audit row authorship work during cron runs.
CREATE OR REPLACE FUNCTION public._execute_organization_delete(p_org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org_name text;
  v_reset jsonb;
  v_counts jsonb := '{}'::jsonb;
  n bigint;
  v_member_ids uuid[];
  v_uid uuid;
BEGIN
  SELECT name INTO v_org_name FROM public.organizations WHERE id = p_org_id;
  IF v_org_name IS NULL THEN
    -- Already gone — treat as idempotent success.
    RETURN jsonb_build_object('success', true, 'already_deleted', true, 'organization_id', p_org_id);
  END IF;

  SELECT COALESCE(array_agg(DISTINCT user_id), ARRAY[]::uuid[])
    INTO v_member_ids
    FROM public.user_roles
   WHERE organization_id = p_org_id;

  -- Use the same reset + delete path, bypassing auth.uid() checks that
  -- reset_organization_data performs. The reset helpers check
  -- _assert_reset_permission, which allows platform admins OR the
  -- app.tenant_delete marker. We pre-set the marker here to authorize.
  PERFORM set_config('app.reset_in_progress', p_org_id::text, true);
  PERFORM set_config('app.tenant_delete',     p_org_id::text, true);
  PERFORM set_config('app.scheduled_executor', 'true', true);

  v_reset := public.reset_organization_data(p_org_id, 'RESET-' || p_org_id::text);

  WITH d AS (DELETE FROM public.webhook_events WHERE organization_id = p_org_id RETURNING 1)
  SELECT count(*) INTO n FROM d;
  v_counts := v_counts || jsonb_build_object('webhook_events', n);

  WITH d AS (DELETE FROM public.platform_admin_alerts WHERE organization_id = p_org_id RETURNING 1)
  SELECT count(*) INTO n FROM d;
  v_counts := v_counts || jsonb_build_object('platform_admin_alerts', n);

  WITH d AS (DELETE FROM public.je_number_sequences WHERE organization_id = p_org_id RETURNING 1)
  SELECT count(*) INTO n FROM d;
  v_counts := v_counts || jsonb_build_object('je_number_sequences', n);

  DELETE FROM public.organizations WHERE id = p_org_id;

  RETURN jsonb_build_object(
    'success', true,
    'organization_id', p_org_id,
    'organization_name', v_org_name,
    'reset_result', v_reset,
    'platform_leftovers', v_counts
  );
END;
$function$;

REVOKE ALL ON FUNCTION public._execute_organization_delete(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.execute_due_scheduled_organization_deletions() FROM PUBLIC, anon, authenticated;

-- reset_organization_data → _assert_reset_permission: widen to accept the
-- scheduled-executor marker. Safe because the marker is only set by the
-- DEFINER function above and is transaction-local.
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def FROM pg_proc WHERE proname = '_assert_reset_permission';
  IF v_def IS NULL THEN
    RAISE NOTICE '_assert_reset_permission not found — skipping';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public._assert_reset_permission(org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_marker text;
BEGIN
  -- Scheduled executor path: marker is set by _execute_organization_delete.
  v_marker := current_setting('app.scheduled_executor', true);
  IF v_marker = 'true' THEN
    RETURN;
  END IF;

  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501';
  END IF;

  IF public.is_platform_admin(v_uid) THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = v_uid
       AND organization_id = org_id
       AND role IN ('owner','admin')
       AND is_active = true
  ) THEN
    RETURN;
  END IF;

  RAISE EXCEPTION 'Permission denied: owner/admin of the organization or platform admin required'
    USING ERRCODE='42501';
END;
$function$;

-- Cron: hourly scheduled-deletion sweep.
-- pg_cron extension is assumed enabled (same project uses it for other jobs).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Unschedule existing job if present (idempotent).
    PERFORM cron.unschedule(jobid)
      FROM cron.job
     WHERE jobname = 'execute-scheduled-org-deletions';
    PERFORM cron.schedule(
      'execute-scheduled-org-deletions',
      '17 * * * *',  -- hourly at :17
      $cron$ SELECT public.execute_due_scheduled_organization_deletions(); $cron$
    );
  END IF;
END $$;
