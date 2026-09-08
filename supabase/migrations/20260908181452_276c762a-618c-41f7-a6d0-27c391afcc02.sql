CREATE OR REPLACE FUNCTION public.upsert_organization_invitation(
  p_organization_id uuid,
  p_email text,
  p_role app_role,
  p_user_type text DEFAULT 'internal'::text,
  p_permission_group_ids uuid[] DEFAULT NULL::uuid[],
  p_invited_by uuid DEFAULT NULL::uuid,
  p_expires_days integer DEFAULT 7,
  p_employee_id uuid DEFAULT NULL::uuid,
  p_branch_ids uuid[] DEFAULT NULL::uuid[],
  p_primary_branch_id uuid DEFAULT NULL::uuid,
  p_branch_scope branch_scope_mode DEFAULT 'assigned'::branch_scope_mode
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
  v_branches uuid[] := COALESCE(p_branch_ids, ARRAY[]::uuid[]);
  v_existing record;
  v_member_user_id uuid;
  v_token text;
  v_new_id uuid;
  v_resolved_employee_id uuid := p_employee_id;
  v_business_id uuid;
  v_bad_branch uuid;
  v_bad_group uuid;
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

  -- Only the recorded owner may create another administrator.
  IF p_role = 'admin'::public.app_role
     AND NOT public.has_role(v_caller, p_organization_id, 'owner'::public.app_role) THEN
    RAISE EXCEPTION 'Only the institution owner can invite an administrator'
      USING ERRCODE = '42501';
  END IF;

  -- Staff invitations must carry real access.
  IF p_role <> 'admin'::public.app_role AND p_role <> 'owner'::public.app_role THEN
    IF COALESCE(array_length(v_groups, 1), 0) = 0 THEN
      RAISE EXCEPTION 'Select at least one access group for this invitation'
        USING ERRCODE = '22023';
    END IF;

    SELECT x INTO v_bad_group
    FROM unnest(v_groups) AS x
    WHERE NOT EXISTS (
      SELECT 1 FROM public.permission_groups g
       WHERE g.id = x AND g.organization_id = p_organization_id
    )
    LIMIT 1;
    IF v_bad_group IS NOT NULL THEN
      RAISE EXCEPTION 'Access group does not belong to this organization'
        USING ERRCODE = '22023';
    END IF;

    IF p_branch_scope IS DISTINCT FROM 'all'::public.branch_scope_mode
       AND COALESCE(array_length(v_branches, 1), 0) = 0
       AND p_primary_branch_id IS NULL THEN
      RAISE EXCEPTION 'Select at least one branch for this invitation'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF array_length(v_branches, 1) > 0 THEN
    SELECT x INTO v_bad_branch
    FROM unnest(v_branches) AS x
    WHERE NOT EXISTS (
      SELECT 1 FROM public.branches b WHERE b.id = x AND b.organization_id = p_organization_id
    )
    LIMIT 1;
    IF v_bad_branch IS NOT NULL THEN
      RAISE EXCEPTION 'Branch does not belong to this organization' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_primary_branch_id IS NOT NULL AND NOT (p_primary_branch_id = ANY(v_branches)) THEN
    v_branches := v_branches || p_primary_branch_id;
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
           branch_ids = CASE
             WHEN COALESCE(array_length(v_branches, 1), 0) = 0 THEN branch_ids
             ELSE v_branches
           END,
           primary_branch_id = COALESCE(p_primary_branch_id, primary_branch_id),
           branch_scope = COALESCE(p_branch_scope, branch_scope),
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
          'permission_group_ids', v_groups, 'branch_ids', v_branches,
          'branch_scope', p_branch_scope::text, 'reused', true
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
    invited_by, permission_group_ids, employee_id,
    branch_ids, primary_branch_id, branch_scope
  )
  VALUES (
    p_organization_id, v_email, p_role, p_user_type, v_token,
    now() + make_interval(days => p_expires_days),
    v_caller, v_groups, v_resolved_employee_id,
    v_branches, p_primary_branch_id, COALESCE(p_branch_scope, 'assigned'::public.branch_scope_mode)
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
        'permission_group_ids', v_groups, 'branch_ids', v_branches,
        'branch_scope', p_branch_scope::text, 'reused', false
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