
-- Phase D/E/F supporting RPCs and indexes
-- 1. Index for tenant-admin pending approvals query
CREATE INDEX IF NOT EXISTS idx_approval_requests_org_entity_status
  ON public.approval_requests (organization_id, entity_type, status);

-- 2. RPC: approve an app_access request
--    Grants the requesting user the system permission group named after the app.
--    Falls back to a no-op if the org doesn't have a matching system group.
CREATE OR REPLACE FUNCTION public.approve_app_access_request(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request RECORD;
  v_group_id uuid;
  v_app_id text;
BEGIN
  -- Caller must be admin or owner of the org owning the request
  SELECT ar.* INTO v_request
  FROM public.approval_requests ar
  WHERE ar.id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'REQUEST_NOT_FOUND';
  END IF;

  IF v_request.entity_type <> 'app_access' THEN
    RAISE EXCEPTION 'INVALID_REQUEST_TYPE';
  END IF;

  IF v_request.status <> 'pending' THEN
    RAISE EXCEPTION 'REQUEST_ALREADY_RESOLVED';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = auth.uid()
       AND organization_id = v_request.organization_id
       AND role IN ('owner','admin')
       AND is_active = true
  ) THEN
    RAISE EXCEPTION 'UNAUTHORIZED: only owners or admins can approve app access requests';
  END IF;

  v_app_id := v_request.entity_reference;

  -- Find the system permission group for this app within the org.
  -- System groups are seeded per-app and named after the app id (e.g. "payroll_user").
  SELECT id INTO v_group_id
  FROM public.permission_groups
  WHERE organization_id = v_request.organization_id
    AND is_system = true
    AND lower(name) LIKE lower(v_app_id) || '%'
  ORDER BY created_at
  LIMIT 1;

  -- If a matching system group exists, add the user to it
  IF v_group_id IS NOT NULL AND v_request.requested_by IS NOT NULL THEN
    INSERT INTO public.member_permission_groups (
      organization_id, group_id, user_id, granted_by
    )
    VALUES (
      v_request.organization_id, v_group_id, v_request.requested_by, auth.uid()
    )
    ON CONFLICT DO NOTHING;
  END IF;

  -- Mark approved
  UPDATE public.approval_requests
     SET status = 'approved',
         completed_at = now()
   WHERE id = p_request_id;

  -- Audit history
  INSERT INTO public.approval_history (
    request_id, action, actor_id, notes
  )
  VALUES (
    p_request_id,
    'approved',
    auth.uid(),
    CASE WHEN v_group_id IS NULL
         THEN 'Approved without auto-grant: no matching permission group found for ' || v_app_id
         ELSE 'Approved and granted access via permission group'
    END
  );

  RETURN jsonb_build_object(
    'request_id', p_request_id,
    'app_id', v_app_id,
    'group_granted', v_group_id IS NOT NULL,
    'group_id', v_group_id
  );
END;
$$;

-- 3. RPC: deny an app_access request
CREATE OR REPLACE FUNCTION public.deny_app_access_request(
  p_request_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request RECORD;
BEGIN
  SELECT ar.* INTO v_request
  FROM public.approval_requests ar
  WHERE ar.id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'REQUEST_NOT_FOUND';
  END IF;

  IF v_request.entity_type <> 'app_access' THEN
    RAISE EXCEPTION 'INVALID_REQUEST_TYPE';
  END IF;

  IF v_request.status <> 'pending' THEN
    RAISE EXCEPTION 'REQUEST_ALREADY_RESOLVED';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = auth.uid()
       AND organization_id = v_request.organization_id
       AND role IN ('owner','admin')
       AND is_active = true
  ) THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  UPDATE public.approval_requests
     SET status = 'denied',
         completed_at = now(),
         notes = COALESCE(p_reason, notes)
   WHERE id = p_request_id;

  INSERT INTO public.approval_history (request_id, action, actor_id, notes)
  VALUES (p_request_id, 'denied', auth.uid(), p_reason);

  RETURN jsonb_build_object('request_id', p_request_id, 'status', 'denied');
END;
$$;

-- 4. RPC: extend an app trial (platform admin only)
CREATE OR REPLACE FUNCTION public.extend_app_trial(
  p_org_id uuid,
  p_app_id text,
  p_extra_days int
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trial RECORD;
  v_is_platform_admin boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.platform_admins WHERE user_id = auth.uid() AND is_active = true
  ) INTO v_is_platform_admin;

  IF NOT v_is_platform_admin THEN
    RAISE EXCEPTION 'UNAUTHORIZED: platform admin only';
  END IF;

  IF p_extra_days <= 0 OR p_extra_days > 365 THEN
    RAISE EXCEPTION 'INVALID_DAYS: 1..365 allowed';
  END IF;

  SELECT * INTO v_trial
  FROM public.app_trial_status
  WHERE organization_id = p_org_id AND app_id = p_app_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Create a fresh trial of p_extra_days
    INSERT INTO public.app_trial_status (organization_id, app_id, status, expires_at)
    VALUES (p_org_id, p_app_id, 'active', now() + (p_extra_days || ' days')::interval);
  ELSE
    UPDATE public.app_trial_status
       SET expires_at = COALESCE(expires_at, now()) + (p_extra_days || ' days')::interval,
           status = CASE WHEN status IN ('expired','cancelled') THEN 'active' ELSE status END,
           updated_at = now()
     WHERE id = v_trial.id;
  END IF;

  RETURN jsonb_build_object('org_id', p_org_id, 'app_id', p_app_id, 'extra_days', p_extra_days);
END;
$$;

-- 5. RPC: get_recent_plan_change_summary - returns one-time post-upgrade banner data
CREATE OR REPLACE FUNCTION public.get_recent_plan_change_summary(p_org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan_name text;
  v_trials_converted int;
  v_addons int;
  v_readonly_apps text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = auth.uid() AND organization_id = p_org_id AND is_active = true
  ) THEN
    RETURN NULL;
  END IF;

  SELECT psp.name INTO v_plan_name
    FROM public.organizations o
    JOIN public.platform_subscription_plans psp ON psp.id = o.subscription_plan_id
   WHERE o.id = p_org_id;

  -- Trials converted in the last 24 hours via convert_app_trials_on_plan_change
  SELECT COUNT(*) INTO v_trials_converted
    FROM public.app_trial_status
   WHERE organization_id = p_org_id
     AND status = 'converted'
     AND COALESCE(converted_at, updated_at) >= now() - interval '24 hours';

  -- Currently installed apps that are NOT in plan AND NOT in active trial AND NOT overridden
  -- (these would become read-only / billed as add-ons after a downgrade)
  SELECT COUNT(*) INTO v_addons
    FROM public.organization_installed_apps oia
   WHERE oia.organization_id = p_org_id
     AND oia.is_active = true
     AND NOT EXISTS (
       SELECT 1 FROM public.plan_app_access paa
        JOIN public.organizations o ON o.subscription_plan_id = paa.plan_id
        WHERE o.id = p_org_id AND paa.app_id = oia.app_id AND paa.is_enabled = true
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.app_trial_status ats
        WHERE ats.organization_id = p_org_id AND ats.app_id = oia.app_id AND ats.status = 'active'
     );

  -- Apps now in read-only state (lifecycle_state = 'readonly')
  SELECT COALESCE(array_agg(app_id), ARRAY[]::text[]) INTO v_readonly_apps
    FROM public.organization_installed_apps
   WHERE organization_id = p_org_id AND lifecycle_state = 'readonly';

  RETURN jsonb_build_object(
    'plan_name', v_plan_name,
    'trials_converted', v_trials_converted,
    'addon_apps', v_addons,
    'readonly_apps', v_readonly_apps
  );
END;
$$;

-- 6. Grant override access RPC (platform admin only) — wraps org_entitlement_overrides
CREATE OR REPLACE FUNCTION public.grant_app_override(
  p_org_id uuid,
  p_app_id text,
  p_reason text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_admins WHERE user_id = auth.uid() AND is_active = true
  ) THEN
    RAISE EXCEPTION 'UNAUTHORIZED: platform admin only';
  END IF;

  INSERT INTO public.org_entitlement_overrides (
    organization_id, override_type, key, override_value, reason, granted_by, expires_at, is_active
  )
  VALUES (
    p_org_id, 'app', p_app_id, jsonb_build_object('granted', true), p_reason, auth.uid(), p_expires_at, true
  )
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object('org_id', p_org_id, 'app_id', p_app_id, 'expires_at', p_expires_at);
END;
$$;

-- 7. Revoke override
CREATE OR REPLACE FUNCTION public.revoke_app_override(p_org_id uuid, p_app_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_admins WHERE user_id = auth.uid() AND is_active = true
  ) THEN
    RAISE EXCEPTION 'UNAUTHORIZED: platform admin only';
  END IF;

  UPDATE public.org_entitlement_overrides
     SET is_active = false, updated_at = now()
   WHERE organization_id = p_org_id
     AND override_type = 'app'
     AND key = p_app_id
     AND is_active = true;

  RETURN jsonb_build_object('org_id', p_org_id, 'app_id', p_app_id, 'revoked', true);
END;
$$;
