-- ============================================================
-- Tenant lifecycle: scheduled deletion (Odoo/QBO/Xero pattern)
-- Suspend → Schedule deletion (grace) → Auto purge (or cancel)
-- ============================================================

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS scheduled_deletion_at  timestamptz,
  ADD COLUMN IF NOT EXISTS deletion_grace_days    integer,
  ADD COLUMN IF NOT EXISTS deletion_requested_by  uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS deletion_reason        text,
  ADD COLUMN IF NOT EXISTS deletion_cancelled_at  timestamptz;

CREATE INDEX IF NOT EXISTS idx_organizations_scheduled_deletion
  ON public.organizations (scheduled_deletion_at)
  WHERE scheduled_deletion_at IS NOT NULL;

COMMENT ON COLUMN public.organizations.scheduled_deletion_at IS
  'When set, this organization is queued for permanent deletion at this timestamp. process_scheduled_organization_deletions() runs daily to purge.';

-- ============================================================
-- schedule_organization_deletion
-- Platform-admin only. Suspends the org and starts the grace window.
-- ============================================================
CREATE OR REPLACE FUNCTION public.schedule_organization_deletion(
  p_org_id      uuid,
  p_grace_days  integer DEFAULT 15,
  p_reason      text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org_name text;
  v_when timestamptz;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501';
  END IF;
  IF NOT public.is_platform_admin(v_user) THEN
    RAISE EXCEPTION 'Platform admin access required' USING ERRCODE='42501';
  END IF;
  IF p_grace_days IS NULL OR p_grace_days < 0 OR p_grace_days > 365 THEN
    RAISE EXCEPTION 'Grace period must be between 0 and 365 days' USING ERRCODE='22023';
  END IF;

  SELECT name INTO v_org_name FROM public.organizations WHERE id = p_org_id;
  IF v_org_name IS NULL THEN
    RAISE EXCEPTION 'Organization not found' USING ERRCODE='P0002';
  END IF;

  v_when := now() + (p_grace_days || ' days')::interval;

  UPDATE public.organizations SET
    is_suspended           = true,
    suspended_at           = COALESCE(suspended_at, now()),
    suspended_reason       = COALESCE(suspended_reason, COALESCE(p_reason, 'Scheduled for deletion')),
    scheduled_deletion_at  = v_when,
    deletion_grace_days    = p_grace_days,
    deletion_requested_by  = v_user,
    deletion_reason        = p_reason,
    deletion_cancelled_at  = NULL,
    updated_at             = now()
  WHERE id = p_org_id;

  INSERT INTO public.admin_audit_log
    (action_type, admin_user_id, target_org_id, target_entity_type, target_entity_id, details)
  VALUES (
    'organization_deletion_scheduled',
    v_user,
    p_org_id,
    'organization',
    p_org_id,
    jsonb_build_object(
      'organization_name', v_org_name,
      'grace_days',        p_grace_days,
      'scheduled_for',     v_when,
      'reason',            p_reason
    )
  );

  RETURN jsonb_build_object(
    'success',                true,
    'organization_id',        p_org_id,
    'organization_name',      v_org_name,
    'scheduled_deletion_at',  v_when,
    'grace_days',             p_grace_days
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.schedule_organization_deletion(uuid, integer, text) TO authenticated;

-- ============================================================
-- cancel_scheduled_organization_deletion
-- Platform-admin only. Clears the schedule. Suspension stays unless explicitly lifted.
-- ============================================================
CREATE OR REPLACE FUNCTION public.cancel_scheduled_organization_deletion(
  p_org_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org_name text;
  v_was_scheduled timestamptz;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501';
  END IF;
  IF NOT public.is_platform_admin(v_user) THEN
    RAISE EXCEPTION 'Platform admin access required' USING ERRCODE='42501';
  END IF;

  SELECT name, scheduled_deletion_at
    INTO v_org_name, v_was_scheduled
  FROM public.organizations WHERE id = p_org_id;

  IF v_org_name IS NULL THEN
    RAISE EXCEPTION 'Organization not found' USING ERRCODE='P0002';
  END IF;

  UPDATE public.organizations SET
    scheduled_deletion_at  = NULL,
    deletion_grace_days    = NULL,
    deletion_cancelled_at  = now(),
    updated_at             = now()
  WHERE id = p_org_id;

  INSERT INTO public.admin_audit_log
    (action_type, admin_user_id, target_org_id, target_entity_type, target_entity_id, details)
  VALUES (
    'organization_deletion_cancelled',
    v_user,
    p_org_id,
    'organization',
    p_org_id,
    jsonb_build_object(
      'organization_name', v_org_name,
      'was_scheduled_for', v_was_scheduled
    )
  );

  RETURN jsonb_build_object('success', true, 'organization_id', p_org_id, 'cancelled_at', now());
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_scheduled_organization_deletion(uuid) TO authenticated;

-- ============================================================
-- process_scheduled_organization_deletions
-- Platform-admin / service-role sweep called by the daily cron.
-- Purges every org whose grace window has elapsed.
-- ============================================================
CREATE OR REPLACE FUNCTION public.process_scheduled_organization_deletions()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  r RECORD;
  v_purged int := 0;
  v_failed int := 0;
  v_results jsonb := '[]'::jsonb;
  v_one jsonb;
BEGIN
  -- Allow platform admin OR service-role context (cron runs without auth.uid).
  IF v_user IS NOT NULL AND NOT public.is_platform_admin(v_user) THEN
    RAISE EXCEPTION 'Platform admin access required' USING ERRCODE='42501';
  END IF;

  FOR r IN
    SELECT id, name
      FROM public.organizations
     WHERE scheduled_deletion_at IS NOT NULL
       AND scheduled_deletion_at <= now()
     ORDER BY scheduled_deletion_at ASC
     LIMIT 50
  LOOP
    BEGIN
      v_one := public.platform_delete_organization(r.id, 'DELETE-' || r.id::text);
      v_purged := v_purged + 1;
      v_results := v_results || jsonb_build_object('org_id', r.id, 'name', r.name, 'status', 'deleted');
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      v_results := v_results || jsonb_build_object(
        'org_id', r.id, 'name', r.name, 'status', 'failed', 'error', SQLERRM
      );
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'purged',  v_purged,
    'failed',  v_failed,
    'details', v_results,
    'ran_at',  now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.process_scheduled_organization_deletions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_scheduled_organization_deletions() TO authenticated, service_role;

COMMENT ON FUNCTION public.process_scheduled_organization_deletions() IS
  'Daily cron: purges all organizations whose grace window has elapsed. Idempotent. Returns per-org status.';
