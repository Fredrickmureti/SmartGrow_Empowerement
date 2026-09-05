-- Wave 2: branch scope becomes first-class

DO $$ BEGIN
  CREATE TYPE public.branch_scope_mode AS ENUM ('all','assigned','own_portfolio');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.member_permission_groups
  ADD COLUMN IF NOT EXISTS branch_scope public.branch_scope_mode NOT NULL DEFAULT 'assigned';

ALTER TABLE public.organization_invitations
  ADD COLUMN IF NOT EXISTS branch_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  ADD COLUMN IF NOT EXISTS primary_branch_id uuid,
  ADD COLUMN IF NOT EXISTS branch_scope public.branch_scope_mode NOT NULL DEFAULT 'assigned';

-- Branches a user may operate in (union of user + employee assignments)
CREATE OR REPLACE FUNCTION public.user_assigned_branch_ids(_user_id uuid, _org_id uuid)
RETURNS TABLE(branch_id uuid)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT uba.branch_id
  FROM public.user_branch_assignments uba
  WHERE uba.user_id = _user_id
    AND uba.organization_id = _org_id
    AND uba.can_view = true
  UNION
  SELECT eba.branch_id
  FROM public.employee_branch_assignments eba
  JOIN public.employees e ON e.id = eba.employee_id
  WHERE e.user_id = _user_id
    AND eba.organization_id = _org_id
    AND (eba.effective_to IS NULL OR eba.effective_to >= CURRENT_DATE)
    AND (eba.effective_from IS NULL OR eba.effective_from <= CURRENT_DATE);
$$;

-- Effective branch scope for a user in an org (widest granted by their groups)
CREATE OR REPLACE FUNCTION public.user_branch_scope(_user_id uuid, _org_id uuid)
RETURNS public.branch_scope_mode
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _role public.app_role;
  _scope public.branch_scope_mode;
BEGIN
  SELECT ur.role INTO _role
  FROM public.user_roles ur
  WHERE ur.user_id = _user_id AND ur.organization_id = _org_id AND ur.is_active = true
  LIMIT 1;

  IF _role IN ('super_admin','owner','admin') THEN
    RETURN 'all'::public.branch_scope_mode;
  END IF;

  SELECT CASE
           WHEN bool_or(mpg.branch_scope = 'all') THEN 'all'
           WHEN bool_or(mpg.branch_scope = 'assigned') THEN 'assigned'
           ELSE 'own_portfolio'
         END::public.branch_scope_mode
    INTO _scope
  FROM public.member_permission_groups mpg
  WHERE mpg.user_id = _user_id AND mpg.organization_id = _org_id;

  RETURN COALESCE(_scope, 'assigned'::public.branch_scope_mode);
END;
$$;

-- Branch-aware permission check. NULL branch => org-wide check (back-compat).
CREATE OR REPLACE FUNCTION public.user_has_module_permission_in_branch(
  _user_id uuid, _org_id uuid, _branch_id uuid, _module text, _operation text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _scope public.branch_scope_mode;
BEGIN
  IF NOT public.user_has_module_permission(_user_id, _org_id, _module, _operation) THEN
    RETURN false;
  END IF;

  IF _branch_id IS NULL THEN
    RETURN true;
  END IF;

  -- Branch must belong to the same organization
  IF NOT EXISTS (
    SELECT 1 FROM public.branches b
    WHERE b.id = _branch_id AND b.organization_id = _org_id
  ) THEN
    RETURN false;
  END IF;

  _scope := public.user_branch_scope(_user_id, _org_id);

  IF _scope = 'all' THEN
    RETURN true;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.user_assigned_branch_ids(_user_id, _org_id) ab
    WHERE ab.branch_id = _branch_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.user_assigned_branch_ids(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_branch_scope(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_has_module_permission_in_branch(uuid, uuid, uuid, text, text) TO authenticated;

-- Session data: expose allowed branches + branch scope per organization
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
  v_scope public.branch_scope_mode;
  v_branches jsonb;
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
      'can_close', COALESCE(pgr.can_close, false),
      'can_reverse', COALESCE(pgr.can_reverse, false),
      'can_admin_override', COALESCE(pgr.can_admin_override, false)
    )), '[]'::jsonb) INTO group_rules
    FROM public.member_permission_groups mpg
    JOIN public.permission_group_rules pgr ON pgr.permission_group_id = mpg.permission_group_id
    WHERE mpg.user_id = p_user_id AND mpg.organization_id = org_row.id;

    v_scope := public.user_branch_scope(p_user_id, org_row.id);

    IF v_scope = 'all' THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', b.id, 'name', b.name, 'code', b.code, 'business_id', b.business_id,
        'is_headquarters', b.is_headquarters
      ) ORDER BY b.is_headquarters DESC, b.name), '[]'::jsonb)
        INTO v_branches
      FROM public.branches b
      WHERE b.organization_id = org_row.id AND b.is_active = true;
    ELSE
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', b.id, 'name', b.name, 'code', b.code, 'business_id', b.business_id,
        'is_headquarters', b.is_headquarters
      ) ORDER BY b.is_headquarters DESC, b.name), '[]'::jsonb)
        INTO v_branches
      FROM public.branches b
      JOIN public.user_assigned_branch_ids(p_user_id, org_row.id) ab ON ab.branch_id = b.id
      WHERE b.organization_id = org_row.id AND b.is_active = true;
    END IF;

    org_entry := jsonb_build_object(
      'id', org_row.id, 'name', org_row.name, 'slug', org_row.slug,
      'logo_url', org_row.logo_url,
      'is_suspended', org_row.is_suspended,
      'suspended_at', org_row.suspended_at,
      'suspended_reason', org_row.suspended_reason,
      'role', COALESCE(role_row.role::text, 'staff'),
      'role_id', role_row.role_id,
      'user_type', role_row.user_type,
      'branch_scope', v_scope::text,
      'allowed_branches', COALESCE(v_branches, '[]'::jsonb),
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

-- Invitations carry branch scope
CREATE OR REPLACE FUNCTION public.upsert_organization_invitation(
  p_organization_id uuid, p_email text, p_role app_role,
  p_user_type text DEFAULT 'internal'::text,
  p_permission_group_ids uuid[] DEFAULT NULL::uuid[],
  p_invited_by uuid DEFAULT NULL::uuid,
  p_expires_days integer DEFAULT 7,
  p_employee_id uuid DEFAULT NULL::uuid,
  p_branch_ids uuid[] DEFAULT NULL::uuid[],
  p_primary_branch_id uuid DEFAULT NULL::uuid,
  p_branch_scope public.branch_scope_mode DEFAULT 'assigned'::public.branch_scope_mode
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
           branch_ids = CASE WHEN p_branch_ids IS NULL AND p_primary_branch_id IS NULL
                             THEN branch_ids ELSE v_branches END,
           primary_branch_id = COALESCE(p_primary_branch_id, primary_branch_id),
           branch_scope = p_branch_scope,
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
          'permission_group_ids', v_groups, 'branch_ids', v_branches, 'reused', true
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
    v_branches, p_primary_branch_id, p_branch_scope
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
        'permission_group_ids', v_groups, 'branch_ids', v_branches, 'reused', false
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
