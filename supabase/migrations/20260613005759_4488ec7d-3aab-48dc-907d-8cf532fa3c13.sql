
-- ============================================================================
-- 0) Fix the portal-group contradiction in the atomic accept RPC.
--    The previous version assigned the "Portal User" system group to portal
--    invitees, but `prevent_portal_group_assignment` forbids any group for
--    portal members. Skip group assignment for portal users entirely.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.accept_organization_invitation_atomic(
  p_invitation_id uuid,
  p_user_id uuid,
  p_permission_group_ids uuid[] DEFAULT NULL::uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_inv record;
  v_existing_role record;
  v_privileged constant text[] := ARRAY['owner','admin','super_admin'];
  v_linked_employee_id uuid;
  v_employee_linked boolean := false;
  v_group_ids uuid[];
  v_group_id uuid;
  v_default_group_name text;
  v_is_portal boolean;
BEGIN
  SELECT id, organization_id, email, role, user_type, accepted_at, expires_at,
         COALESCE(permission_group_ids, ARRAY[]::uuid[]) AS permission_group_ids
    INTO v_inv
    FROM organization_invitations
   WHERE id = p_invitation_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invitation_not_found');
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'already_accepted');
  END IF;
  IF v_inv.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'expired');
  END IF;

  v_is_portal := (v_inv.role::text = 'portal' OR v_inv.user_type = 'portal');

  SELECT id, role::text AS role, user_type
    INTO v_existing_role
    FROM user_roles
   WHERE user_id = p_user_id
     AND organization_id = v_inv.organization_id
   LIMIT 1;

  IF FOUND
     AND v_existing_role.role = ANY (v_privileged)
     AND v_is_portal THEN
    RETURN jsonb_build_object(
      'ok', false, 'code', 'would_demote_admin',
      'existing_role', v_existing_role.role
    );
  END IF;

  -- Upsert role
  IF FOUND THEN
    UPDATE user_roles
       SET role = v_inv.role,
           user_type = v_inv.user_type,
           is_active = true,
           updated_at = now()
     WHERE id = v_existing_role.id;
  ELSE
    INSERT INTO user_roles (user_id, organization_id, role, user_type, is_active)
    VALUES (p_user_id, v_inv.organization_id, v_inv.role, v_inv.user_type, true);
  END IF;

  -- Auto-link employee row (only for non-privileged users)
  IF NOT FOUND OR NOT (v_existing_role.role = ANY (v_privileged)) THEN
    UPDATE employees
       SET user_id = p_user_id, user_access_status = 'active'
     WHERE organization_id = v_inv.organization_id
       AND lower(email) = lower(v_inv.email)
       AND user_id IS NULL
    RETURNING id INTO v_linked_employee_id;

    IF v_linked_employee_id IS NOT NULL THEN
      v_employee_linked := true;
    END IF;
  END IF;

  -- Permission groups: portal users do not receive groups (the
  -- prevent_portal_group_assignment trigger enforces this). Only assign
  -- groups for internal members.
  IF NOT v_is_portal THEN
    IF NOT (FOUND AND v_existing_role.role = ANY (v_privileged)) THEN
      DELETE FROM member_permission_groups
       WHERE organization_id = v_inv.organization_id
         AND user_id = p_user_id;
    END IF;

    v_group_ids := COALESCE(p_permission_group_ids, v_inv.permission_group_ids);

    IF v_group_ids IS NOT NULL AND array_length(v_group_ids, 1) > 0 THEN
      FOREACH v_group_id IN ARRAY v_group_ids LOOP
        INSERT INTO member_permission_groups (organization_id, user_id, permission_group_id)
        VALUES (v_inv.organization_id, p_user_id, v_group_id)
        ON CONFLICT DO NOTHING;
      END LOOP;
    ELSE
      v_default_group_name := 'Internal Users';
      SELECT id INTO v_group_id
        FROM permission_groups
       WHERE organization_id = v_inv.organization_id
         AND name = v_default_group_name
         AND is_system = true
       LIMIT 1;
      IF v_group_id IS NULL THEN
        SELECT id INTO v_group_id
          FROM permission_groups
         WHERE organization_id = v_inv.organization_id
           AND name = 'Internal User'
           AND is_system = true
         LIMIT 1;
      END IF;
      IF v_group_id IS NOT NULL THEN
        INSERT INTO member_permission_groups (organization_id, user_id, permission_group_id)
        VALUES (v_inv.organization_id, p_user_id, v_group_id)
        ON CONFLICT DO NOTHING;
      END IF;
    END IF;
  END IF;

  -- Mark invitation accepted
  UPDATE organization_invitations
     SET accepted_at = now()
   WHERE id = v_inv.id;

  -- Diagnostic onboarding_attempts row
  PERFORM record_invitation_link_outcome(
    v_inv.organization_id, p_user_id, v_inv.email, v_employee_linked, v_linked_employee_id
  );

  RETURN jsonb_build_object(
    'ok', true,
    'organization_id', v_inv.organization_id,
    'role', v_inv.role,
    'user_type', v_inv.user_type,
    'employee_linked', v_employee_linked,
    'linked_employee_id', v_linked_employee_id
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.accept_organization_invitation_atomic(uuid, uuid, uuid[]) TO service_role;

-- ============================================================================
-- 1) Idempotent invitation creator
-- ============================================================================
CREATE OR REPLACE FUNCTION public.upsert_organization_invitation(
  p_organization_id uuid,
  p_email           text,
  p_role            public.app_role,
  p_user_type       text DEFAULT 'internal',
  p_permission_group_ids uuid[] DEFAULT NULL,
  p_invited_by      uuid DEFAULT NULL,
  p_expires_days    integer DEFAULT 7
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := COALESCE(p_invited_by, auth.uid());
  v_email  text := lower(trim(p_email));
  v_existing record;
  v_member_user_id uuid;
  v_token text;
  v_new_id uuid;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.has_role(v_caller, p_organization_id, 'owner'::public.app_role)
       OR public.has_role(v_caller, p_organization_id, 'admin'::public.app_role)) THEN
    RAISE EXCEPTION 'Only org owners/admins can invite' USING ERRCODE = '42501';
  END IF;
  IF v_email IS NULL OR v_email = '' OR position('@' in v_email) = 0 THEN
    RAISE EXCEPTION 'Valid email is required' USING ERRCODE = '22023';
  END IF;

  SELECT ur.user_id INTO v_member_user_id
    FROM public.user_roles ur
    JOIN public.profiles p ON p.user_id = ur.user_id
   WHERE ur.organization_id = p_organization_id
     AND ur.is_active = true
     AND lower(p.email) = v_email
   LIMIT 1;

  IF v_member_user_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'already_member', 'user_id', v_member_user_id);
  END IF;

  SELECT id, token, expires_at, role, user_type, accepted_at
    INTO v_existing
    FROM public.organization_invitations
   WHERE organization_id = p_organization_id
     AND lower(email) = v_email
     AND accepted_at IS NULL
   LIMIT 1;

  IF v_existing.id IS NOT NULL THEN
    UPDATE public.organization_invitations
       SET expires_at = now() + make_interval(days => p_expires_days),
           role       = p_role,
           user_type  = p_user_type,
           permission_group_ids = COALESCE(p_permission_group_ids, permission_group_ids),
           invited_by = COALESCE(invited_by, v_caller)
     WHERE id = v_existing.id;

    RETURN jsonb_build_object(
      'status', 'reused',
      'invitation_id', v_existing.id,
      'token', v_existing.token
    );
  END IF;

  v_token := gen_random_uuid()::text;
  INSERT INTO public.organization_invitations (
    organization_id, email, role, user_type, token, expires_at,
    invited_by, permission_group_ids
  )
  VALUES (
    p_organization_id, v_email, p_role, p_user_type, v_token,
    now() + make_interval(days => p_expires_days),
    v_caller, p_permission_group_ids
  )
  RETURNING id INTO v_new_id;

  RETURN jsonb_build_object(
    'status', 'created',
    'invitation_id', v_new_id,
    'token', v_token
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_organization_invitation(uuid, text, public.app_role, text, uuid[], uuid, integer) TO authenticated, service_role;

-- ============================================================================
-- 2) Invited-user resume resolver
-- ============================================================================
CREATE OR REPLACE FUNCTION public.resume_my_invitation()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_email text;
  v_inv record;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthenticated');
  END IF;

  SELECT email INTO v_email FROM public.profiles WHERE user_id = v_user;
  IF v_email IS NULL THEN
    v_email := lower(coalesce((auth.jwt() ->> 'email')::text, ''));
  ELSE
    v_email := lower(v_email);
  END IF;

  IF v_email IS NULL OR v_email = '' THEN
    RETURN jsonb_build_object('status', 'no_email');
  END IF;

  SELECT id, token, organization_id, role, user_type, expires_at
    INTO v_inv
    FROM public.organization_invitations
   WHERE lower(email) = v_email
     AND accepted_at IS NULL
     AND expires_at > now()
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_inv.id IS NULL THEN
    RETURN jsonb_build_object('status', 'none');
  END IF;

  RETURN jsonb_build_object(
    'status', 'pending',
    'invitation_id', v_inv.id,
    'token', v_inv.token,
    'organization_id', v_inv.organization_id,
    'role', v_inv.role,
    'user_type', v_inv.user_type,
    'expires_at', v_inv.expires_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.resume_my_invitation() TO authenticated, service_role;

-- ============================================================================
-- 3) Repair the currently stuck Fredrick / Victor state.
-- ============================================================================
DO $$
DECLARE
  v_result jsonb;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.organization_invitations
     WHERE id = 'ffd76884-b601-4015-b425-01f817425e3e'
       AND accepted_at IS NULL
  ) AND EXISTS (
    SELECT 1 FROM auth.users WHERE id = 'd455281c-61d2-46f7-94e4-c056447ee1f5'
  ) THEN
    SELECT public.accept_organization_invitation_atomic(
      'ffd76884-b601-4015-b425-01f817425e3e'::uuid,
      'd455281c-61d2-46f7-94e4-c056447ee1f5'::uuid,
      NULL
    ) INTO v_result;
    RAISE NOTICE 'Repaired stuck invitation: %', v_result;
  END IF;
END;
$$;
