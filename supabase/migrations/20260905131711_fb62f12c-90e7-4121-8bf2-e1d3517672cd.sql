-- ============================================================
-- Wave 0: repair invitation RPCs (missing from live DB) and
-- fix session permission serialization.
-- ============================================================

CREATE OR REPLACE FUNCTION public.upsert_organization_invitation(
  p_organization_id uuid,
  p_email text,
  p_role app_role,
  p_user_type text DEFAULT 'internal'::text,
  p_permission_group_ids uuid[] DEFAULT NULL::uuid[],
  p_invited_by uuid DEFAULT NULL::uuid,
  p_expires_days integer DEFAULT 7,
  p_employee_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := COALESCE(p_invited_by, auth.uid());
  v_email  text := lower(trim(p_email));
  v_groups uuid[] := COALESCE(p_permission_group_ids, ARRAY[]::uuid[]);
  v_existing record;
  v_member_user_id uuid;
  v_token text;
  v_new_id uuid;
  v_resolved_employee_id uuid := p_employee_id;
  v_business_id uuid;
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

  IF v_resolved_employee_id IS NULL THEN
    SELECT e.id INTO v_resolved_employee_id
      FROM public.employees e
     WHERE e.organization_id = p_organization_id
       AND (lower(e.work_email) = v_email OR lower(e.email) = v_email)
     ORDER BY (lower(e.work_email) = v_email) DESC
     LIMIT 1;
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
           permission_group_ids = CASE
             WHEN p_permission_group_ids IS NULL THEN permission_group_ids
             ELSE v_groups
           END,
           invited_by = COALESCE(invited_by, v_caller),
           employee_id = COALESCE(employee_id, v_resolved_employee_id)
     WHERE id = v_existing.id;

    IF v_resolved_employee_id IS NOT NULL THEN
      SELECT business_id INTO v_business_id FROM public.employees WHERE id = v_resolved_employee_id;
      INSERT INTO public.employee_lifecycle_events (
        organization_id, business_id, employee_id, event_type,
        actor_user_id, source_table, source_id, summary, payload
      ) VALUES (
        p_organization_id, v_business_id, v_resolved_employee_id, 'user_invited',
        v_caller, 'organization_invitations', v_existing.id,
        'Invitation refreshed for ' || v_email,
        jsonb_build_object(
          'email', v_email, 'role', p_role::text, 'user_type', p_user_type,
          'permission_group_ids', v_groups, 'reused', true
        )
      );
    END IF;

    RETURN jsonb_build_object(
      'status', 'reused',
      'invitation_id', v_existing.id,
      'token', v_existing.token
    );
  END IF;

  v_token := gen_random_uuid()::text;
  INSERT INTO public.organization_invitations (
    organization_id, email, role, user_type, token, expires_at,
    invited_by, permission_group_ids, employee_id
  )
  VALUES (
    p_organization_id, v_email, p_role, p_user_type, v_token,
    now() + make_interval(days => p_expires_days),
    v_caller, v_groups, v_resolved_employee_id
  )
  RETURNING id INTO v_new_id;

  IF v_resolved_employee_id IS NOT NULL THEN
    SELECT business_id INTO v_business_id FROM public.employees WHERE id = v_resolved_employee_id;
    INSERT INTO public.employee_lifecycle_events (
      organization_id, business_id, employee_id, event_type,
      actor_user_id, source_table, source_id, summary, payload
    ) VALUES (
      p_organization_id, v_business_id, v_resolved_employee_id, 'user_invited',
      v_caller, 'organization_invitations', v_new_id,
      'Invitation sent to ' || v_email,
      jsonb_build_object(
        'email', v_email, 'role', p_role::text, 'user_type', p_user_type,
        'permission_group_ids', v_groups, 'reused', false
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'status', 'created',
    'invitation_id', v_new_id,
    'token', v_token
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.upsert_organization_invitation(uuid, text, app_role, text, uuid[], uuid, integer, uuid) TO authenticated;


CREATE OR REPLACE FUNCTION public.accept_organization_invitation_atomic(
  p_invitation_id uuid, p_user_id uuid, p_permission_group_ids uuid[] DEFAULT NULL::uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_inv record;
  v_existing_role record;
  v_had_existing_role boolean := false;
  v_existing_is_privileged boolean := false;
  v_privileged constant text[] := ARRAY['owner','admin','super_admin'];
  v_linked_employee_id uuid;
  v_employee_linked boolean := false;
  v_group_ids uuid[];
  v_group_id uuid;
  v_default_group_name text;
  v_is_portal boolean;
  v_business_id uuid;
  v_target_employee_id uuid;
BEGIN
  SELECT id, organization_id, email, role, user_type, accepted_at, expires_at,
         employee_id,
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

  v_had_existing_role := FOUND;
  v_existing_is_privileged := v_had_existing_role AND v_existing_role.role = ANY (v_privileged);

  IF v_existing_is_privileged AND v_is_portal THEN
    RETURN jsonb_build_object(
      'ok', false, 'code', 'would_demote_admin',
      'existing_role', v_existing_role.role
    );
  END IF;

  IF v_had_existing_role THEN
    UPDATE user_roles
       SET role = v_inv.role, user_type = v_inv.user_type,
           is_active = true, updated_at = now()
     WHERE id = v_existing_role.id;
  ELSE
    INSERT INTO user_roles (user_id, organization_id, role, user_type, is_active)
    VALUES (p_user_id, v_inv.organization_id, v_inv.role, v_inv.user_type, true);
  END IF;

  IF NOT v_existing_is_privileged THEN
    PERFORM set_config('app.identity_change_source','accept_organization_invitation_atomic', true);

    IF v_inv.employee_id IS NOT NULL THEN
      UPDATE employees
         SET user_id = p_user_id
       WHERE id = v_inv.employee_id
         AND organization_id = v_inv.organization_id
         AND user_id IS NULL
      RETURNING id INTO v_linked_employee_id;
    END IF;

    IF v_linked_employee_id IS NULL THEN
      UPDATE employees
         SET user_id = p_user_id
       WHERE organization_id = v_inv.organization_id
         AND lower(email) = lower(v_inv.email)
         AND user_id IS NULL
      RETURNING id INTO v_linked_employee_id;
    END IF;

    PERFORM set_config('app.identity_change_source','', true);

    IF v_linked_employee_id IS NOT NULL THEN
      v_employee_linked := true;
    END IF;
  END IF;

  IF NOT v_is_portal THEN
    IF NOT v_existing_is_privileged THEN
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

  UPDATE organization_invitations SET accepted_at = now() WHERE id = v_inv.id;

  PERFORM record_invitation_link_outcome(
    v_inv.organization_id, p_user_id, v_inv.email, v_employee_linked, v_linked_employee_id
  );

  v_target_employee_id := COALESCE(v_inv.employee_id, v_linked_employee_id);
  IF v_target_employee_id IS NOT NULL THEN
    SELECT business_id INTO v_business_id FROM public.employees WHERE id = v_target_employee_id;
    INSERT INTO public.employee_lifecycle_events (
      organization_id, business_id, employee_id, event_type,
      actor_user_id, source_table, source_id, summary, payload
    ) VALUES (
      v_inv.organization_id, v_business_id, v_target_employee_id, 'user_invitation_accepted',
      p_user_id, 'organization_invitations', v_inv.id,
      'Invitation accepted by ' || v_inv.email,
      jsonb_build_object('email', v_inv.email, 'role', v_inv.role::text, 'user_type', v_inv.user_type)
    );
    IF v_employee_linked THEN
      INSERT INTO public.employee_lifecycle_events (
        organization_id, business_id, employee_id, event_type,
        actor_user_id, source_table, source_id, summary, payload
      ) VALUES (
        v_inv.organization_id, v_business_id, v_linked_employee_id, 'user_linked',
        p_user_id, 'employees', v_linked_employee_id,
        'User account linked via invitation acceptance',
        jsonb_build_object('target_user_id', p_user_id, 'via', 'invitation')
      );
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'organization_id', v_inv.organization_id,
    'role', v_inv.role,
    'user_type', v_inv.user_type,
    'employee_linked', v_employee_linked,
    'linked_employee_id', v_linked_employee_id
  );
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.identity_change_source','', true);
  RAISE;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.accept_organization_invitation_atomic(uuid, uuid, uuid[]) TO authenticated, service_role;


-- Seat-limit pre-check used by the invite dialog.
CREATE OR REPLACE FUNCTION public.check_user_invite_allowed(p_organization_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_limit integer;
  v_active integer;
  v_pending integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'Authentication required');
  END IF;

  IF NOT public.is_org_admin(auth.uid(), p_organization_id) THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'Only owners and admins can invite users');
  END IF;

  v_limit := public.get_effective_user_limit(p_organization_id);
  IF v_limit IS NULL THEN
    RETURN jsonb_build_object('allowed', true, 'reason', '');
  END IF;

  SELECT COUNT(DISTINCT user_id) INTO v_active
  FROM public.user_roles
  WHERE organization_id = p_organization_id AND is_active = true;

  SELECT COUNT(*) INTO v_pending
  FROM public.organization_invitations
  WHERE organization_id = p_organization_id
    AND accepted_at IS NULL
    AND expires_at > now();

  IF (v_active + v_pending) >= v_limit THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', format(
        'Your plan allows %s users. You currently have %s member(s) and %s pending invitation(s).',
        v_limit, v_active, v_pending
      )
    );
  END IF;

  RETURN jsonb_build_object('allowed', true, 'reason', '');
END;
$function$;

GRANT EXECUTE ON FUNCTION public.check_user_invite_allowed(uuid) TO authenticated;


-- Session payload must carry every action flag, not just CRUD.
CREATE OR REPLACE FUNCTION public.get_user_session_data(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  result jsonb;
  org_array jsonb := '[]'::jsonb;
  org_row record;
  user_count int;
  storage_used numeric;
  org_entry jsonb;
  role_row record;
  group_rules jsonb;
BEGIN
  FOR org_row IN
    SELECT o.id, o.name, o.slug, o.logo_url,
           o.is_suspended, o.suspended_at, o.suspended_reason
    FROM organizations o
    JOIN user_roles ur ON ur.organization_id = o.id
    WHERE ur.user_id = p_user_id AND ur.is_active = true
    ORDER BY o.created_at ASC
  LOOP
    SELECT ur.id AS role_id, ur.role, COALESCE(ur.user_type, 'internal') AS user_type
    INTO role_row
    FROM user_roles ur
    WHERE ur.user_id = p_user_id AND ur.organization_id = org_row.id AND ur.is_active = true
    LIMIT 1;

    SELECT COUNT(DISTINCT user_id) INTO user_count
    FROM user_roles WHERE organization_id = org_row.id AND is_active = true;

    BEGIN
      SELECT COALESCE(public.get_org_storage_usage_mb(org_row.id), 0) INTO storage_used;
    EXCEPTION WHEN OTHERS THEN
      storage_used := 0;
    END;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'module', pgr.module,
      'can_read', pgr.can_read,
      'can_create', pgr.can_create,
      'can_write', pgr.can_write,
      'can_delete', pgr.can_delete,
      'can_approve', COALESCE(pgr.can_approve, false),
      'can_post', COALESCE(pgr.can_post, false),
      'can_pay', COALESCE(pgr.can_pay, false),
      'can_export', COALESCE(pgr.can_export, false),
      'admin_override', COALESCE(pgr.admin_override, false)
    )), '[]'::jsonb) INTO group_rules
    FROM public.member_permission_groups mpg
    JOIN public.permission_group_rules pgr ON pgr.permission_group_id = mpg.permission_group_id
    WHERE mpg.user_id = p_user_id AND mpg.organization_id = org_row.id;

    org_entry := jsonb_build_object(
      'id', org_row.id, 'name', org_row.name, 'slug', org_row.slug,
      'logo_url', org_row.logo_url,
      'is_suspended', org_row.is_suspended,
      'suspended_at', org_row.suspended_at,
      'suspended_reason', org_row.suspended_reason,
      'role', COALESCE(role_row.role::text, 'staff'),
      'role_id', role_row.role_id,
      'user_type', role_row.user_type,
      'usage_counters', jsonb_build_object(
        'users_count', user_count,
        'storage_used_mb', storage_used
      ),
      'permission_group_rules', group_rules
    );

    org_array := org_array || jsonb_build_array(org_entry);
  END LOOP;

  result := jsonb_build_object(
    'user_id', p_user_id,
    'organizations', org_array,
    'fetched_at', now()
  );
  RETURN result;
END
$function$;