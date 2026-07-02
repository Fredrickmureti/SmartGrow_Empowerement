-- ─────────────────────────────────────────────────────────────────────────
-- Orphan-identity GC: deleting a tenant cascades to tenancy, not to the
-- human's identity — UNLESS the human has no other tenancy and no platform
-- role, in which case the auth.users row should be reaped too. Otherwise
-- that email is permanently locked out (the bug devmuret@gmail.com hit).
-- ─────────────────────────────────────────────────────────────────────────

-- 1. Helper: is this auth user fully orphaned (no remaining tenancy + no
--    platform role + no pending platform-admin invitation)? Used by both
--    the platform-delete flow and the user-driven reset flow.
CREATE OR REPLACE FUNCTION public.is_orphan_identity(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p_user_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = p_user_id AND is_active = true
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.platform_admins
      WHERE user_id = p_user_id AND is_active = true
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.platform_admin_invitations pai
      JOIN auth.users u ON lower(u.email) = lower(pai.email)
      WHERE u.id = p_user_id
        AND pai.status = 'pending'
        AND pai.expires_at > now()
    );
$$;

REVOKE ALL ON FUNCTION public.is_orphan_identity(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_orphan_identity(uuid) TO service_role;

-- 2. Extend reset_my_signup so that when the post-clean state is fully
--    orphaned, it stamps a flag on auth.users that the self-reap edge
--    function will pick up. We do NOT call gotrue from SQL — only mark
--    intent + log. The edge function performs the actual deleteUser.
CREATE OR REPLACE FUNCTION public.reset_my_signup()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_email TEXT;
  v_orphan_org UUID;
  v_orgs_deleted INTEGER := 0;
  v_should_reap_identity BOOLEAN := false;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = v_user_id AND is_active = true) THEN
    RAISE EXCEPTION 'Platform admin accounts cannot be reset via this RPC';
  END IF;

  SELECT email INTO v_email FROM auth.users WHERE id = v_user_id;

  -- Delete sole-owned orgs that were created during the broken signup.
  FOR v_orphan_org IN
    SELECT ur.organization_id
    FROM public.user_roles ur
    WHERE ur.user_id = v_user_id
      AND ur.is_active = true
      AND NOT EXISTS (
        SELECT 1 FROM public.user_roles ur2
        WHERE ur2.organization_id = ur.organization_id
          AND ur2.user_id <> v_user_id
          AND ur2.is_active = true
      )
  LOOP
    DELETE FROM public.organizations WHERE id = v_orphan_org;
    v_orgs_deleted := v_orgs_deleted + 1;
  END LOOP;

  -- Wipe pending signup metadata so the user can restart cleanly.
  UPDATE auth.users
  SET raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object(
    'onboarding_completed', false,
    'pending_company_name', NULL,
    'pending_country',      NULL,
    'pending_currency',     NULL,
    'pending_business_type', NULL,
    'pending_selected_apps', NULL,
    'pending_team_invitees', NULL
  )
  WHERE id = v_user_id;

  -- After cleanup, is this identity now fully orphan? If yes, signal the
  -- self-reap edge function to delete the auth.users row so the email is
  -- freed up for a fresh signup.
  v_should_reap_identity := public.is_orphan_identity(v_user_id);

  INSERT INTO public.signup_cleanup_log(reaped_user_id, reaped_email, reason, metadata)
  VALUES (v_user_id, v_email,
          CASE WHEN v_should_reap_identity
               THEN 'manual_reset_orphan_identity'
               ELSE 'manual_reset' END,
          jsonb_build_object(
            'orgs_deleted', v_orgs_deleted,
            'identity_reap_signaled', v_should_reap_identity
          ));

  RETURN jsonb_build_object(
    'orgs_deleted', v_orgs_deleted,
    'email', v_email,
    'should_reap_identity', v_should_reap_identity
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.reset_my_signup() TO authenticated;

-- 3. Extend platform_delete_organization so it returns the list of member
--    user_ids whose ONLY tenancy was the deleted org. The clear-org-data
--    edge function will iterate that list and call gotrue deleteUser for
--    each — Odoo / Xero / QuickBooks behavior.
CREATE OR REPLACE FUNCTION public.platform_delete_organization(
  p_org_id uuid,
  p_confirmation_token text
)
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

  -- Snapshot the set of users that had ANY role (active or not) in this
  -- org BEFORE we delete. After the cascading delete we re-evaluate each
  -- one against is_orphan_identity.
  SELECT COALESCE(array_agg(DISTINCT user_id), ARRAY[]::uuid[])
  INTO v_member_ids
  FROM public.user_roles
  WHERE organization_id = p_org_id;

  v_reset := public.reset_organization_data(p_org_id, 'RESET-' || p_org_id::text);

  PERFORM set_config('app.reset_in_progress', p_org_id::text, true);

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

  -- Re-evaluate each former member: if they no longer have ANY active
  -- tenancy and are not a platform admin, mark them for identity reap.
  -- We do not delete the auth.users row here — Postgres can't call gotrue.
  -- The edge function picks this list up and runs auth.admin.deleteUser.
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