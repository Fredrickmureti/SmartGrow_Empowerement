-- ============================================================
-- Signup Saga + Platform-Admin/Tenant Separation
-- ============================================================
-- Goal:
--   1) Reap orphaned signups so corrupted accounts heal automatically.
--   2) Provide self-serve "reset my signup" RPC the UI can call.
--   3) Tag organizations created by platform admins for clean audit
--      separation when the platform is sold/transferred.
-- ============================================================

-- ---------- 1. Forensics table for cleanup runs ----------
CREATE TABLE IF NOT EXISTS public.signup_cleanup_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reaped_user_id UUID NOT NULL,
  reaped_email TEXT,
  reason TEXT NOT NULL,             -- 'unverified_expired' | 'verified_no_workspace_expired' | 'manual_reset'
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.signup_cleanup_log ENABLE ROW LEVEL SECURITY;

-- Only platform admins can read the cleanup log; nobody can write directly
-- (the SECURITY DEFINER function owns inserts).
CREATE POLICY "Platform admins can view cleanup log"
  ON public.signup_cleanup_log
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.platform_admins pa
      WHERE pa.user_id = auth.uid() AND pa.is_active = true
    )
  );

CREATE INDEX IF NOT EXISTS idx_signup_cleanup_log_created_at
  ON public.signup_cleanup_log(created_at DESC);

-- ---------- 2. Add provenance flag on organizations ----------
-- Lets ownership-transfer logic know which orgs were created by the
-- current platform owner under the escape hatch path so they can be
-- excluded from a sale.
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS created_by_platform_admin BOOLEAN NOT NULL DEFAULT false;

-- ---------- 3. Orphan reaper ----------
-- Deletes auth.users rows that never completed provisioning. Two buckets:
--   a) Unverified > 24h           → user never clicked the email link.
--   b) Verified > 2h with pending_company_name set, no user_roles, and
--      not a platform_admin       → workspace setup never finished.
-- Skips users with raw_user_meta_data->>'do_not_reap' = 'true' (manual hold).
CREATE OR REPLACE FUNCTION public.cleanup_orphan_signups()
RETURNS TABLE(reaped_count INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_count INTEGER := 0;
  v_row RECORD;
BEGIN
  -- Bucket A: unverified > 24h
  FOR v_row IN
    SELECT u.id, u.email, u.created_at
    FROM auth.users u
    WHERE u.email_confirmed_at IS NULL
      AND u.created_at < now() - interval '24 hours'
      AND COALESCE(u.raw_user_meta_data->>'do_not_reap', 'false') <> 'true'
      AND NOT EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = u.id)
  LOOP
    INSERT INTO public.signup_cleanup_log(reaped_user_id, reaped_email, reason, metadata)
    VALUES (v_row.id, v_row.email, 'unverified_expired',
            jsonb_build_object('created_at', v_row.created_at));
    DELETE FROM auth.users WHERE id = v_row.id;
    v_count := v_count + 1;
  END LOOP;

  -- Bucket B: verified > 2h with pending company but no workspace and not a platform admin
  FOR v_row IN
    SELECT u.id, u.email, u.created_at
    FROM auth.users u
    WHERE u.email_confirmed_at IS NOT NULL
      AND u.created_at < now() - interval '2 hours'
      AND (u.raw_user_meta_data->>'pending_company_name') IS NOT NULL
      AND COALESCE(u.raw_user_meta_data->>'do_not_reap', 'false') <> 'true'
      AND NOT EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM public.user_roles ur  WHERE ur.user_id = u.id AND ur.is_active = true)
  LOOP
    INSERT INTO public.signup_cleanup_log(reaped_user_id, reaped_email, reason, metadata)
    VALUES (v_row.id, v_row.email, 'verified_no_workspace_expired',
            jsonb_build_object('created_at', v_row.created_at));
    DELETE FROM auth.users WHERE id = v_row.id;
    v_count := v_count + 1;
  END LOOP;

  RETURN QUERY SELECT v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_orphan_signups() FROM PUBLIC, anon, authenticated;

-- ---------- 4. Self-serve reset for the CURRENT user ----------
-- Lets a stuck user wipe their own pending signup state and any
-- half-created workspaces they sole-own, so they can restart from /signup
-- without contacting support. Hard-guards: never touches platform admins,
-- never touches orgs with other active members.
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
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Refuse to reset platform admins — they have no "signup" to reset.
  IF EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = v_user_id AND is_active = true) THEN
    RAISE EXCEPTION 'Platform admin accounts cannot be reset via this RPC';
  END IF;

  SELECT email INTO v_email FROM auth.users WHERE id = v_user_id;

  -- Delete sole-owned orgs that were created during the broken signup.
  -- "Sole-owned" = the only active member is the caller.
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

  -- Audit
  INSERT INTO public.signup_cleanup_log(reaped_user_id, reaped_email, reason, metadata)
  VALUES (v_user_id, v_email, 'manual_reset',
          jsonb_build_object('orgs_deleted', v_orgs_deleted));

  RETURN jsonb_build_object('orgs_deleted', v_orgs_deleted, 'email', v_email);
END;
$$;

GRANT EXECUTE ON FUNCTION public.reset_my_signup() TO authenticated;

-- ---------- 5. Schedule the reaper every 15 minutes ----------
-- Idempotent: unschedule any existing job with the same name first.
DO $$
BEGIN
  PERFORM cron.unschedule('cleanup-orphan-signups');
EXCEPTION WHEN OTHERS THEN
  -- Job didn't exist yet — fine.
  NULL;
END $$;

SELECT cron.schedule(
  'cleanup-orphan-signups',
  '*/15 * * * *',
  $$ SELECT public.cleanup_orphan_signups(); $$
);