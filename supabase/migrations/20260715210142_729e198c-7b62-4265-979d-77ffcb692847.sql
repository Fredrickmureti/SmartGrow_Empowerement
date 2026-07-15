
-- Defect 1: disambiguate CTE columns that shadowed the RETURNS TABLE user_id
CREATE OR REPLACE FUNCTION public.get_linkable_users_for_employee(p_org_id uuid, p_employee_id uuid)
 RETURNS TABLE(user_id uuid, display_name text, email_masked text, linkability text, block_reason text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;

  IF NOT public.user_has_module_permission(v_caller, p_org_id, 'hr', 'write') THEN
    RAISE EXCEPTION 'forbidden: hr.write required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH owner_row AS (
    SELECT owner_user_id FROM public.organizations WHERE id = p_org_id
  ),
  active_roles AS (
    SELECT ur.user_id       AS candidate_user_id,
           ur.role::text     AS role,
           ur.user_type::text AS user_type
    FROM public.user_roles ur
    WHERE ur.organization_id = p_org_id
      AND ur.is_active = true
  ),
  top_role AS (
    SELECT DISTINCT ON (candidate_user_id)
           candidate_user_id, role, user_type
    FROM active_roles
    ORDER BY candidate_user_id,
             CASE role
               WHEN 'super_admin' THEN 3
               WHEN 'owner'       THEN 2
               WHEN 'admin'       THEN 1
               ELSE 0
             END DESC
  ),
  candidates AS (
    SELECT DISTINCT candidate_user_id FROM active_roles
  ),
  linked_elsewhere AS (
    SELECT e.user_id AS linked_user_id
    FROM public.employees e
    WHERE e.organization_id = p_org_id
      AND e.user_id IS NOT NULL
      AND e.id <> p_employee_id
  ),
  pa AS (
    SELECT pa2.user_id AS admin_user_id FROM public.platform_admins pa2
  )
  SELECT
    c.candidate_user_id AS user_id,
    COALESCE(NULLIF(p.full_name, ''), split_part(p.email, '@', 1))::text AS display_name,
    CASE
      WHEN p.email IS NULL OR p.email = '' THEN ''
      ELSE substring(p.email FROM 1 FOR 1) || '***@' || split_part(p.email, '@', 2)
    END::text AS email_masked,
    CASE
      WHEN (SELECT owner_user_id FROM owner_row) = c.candidate_user_id       THEN 'blocked'
      WHEN c.candidate_user_id IN (SELECT admin_user_id FROM pa)              THEN 'blocked'
      WHEN tr.role IN ('owner','admin','super_admin')                         THEN 'blocked'
      WHEN tr.user_type = 'internal'                                          THEN 'blocked'
      WHEN c.candidate_user_id = v_caller                                     THEN 'blocked'
      WHEN c.candidate_user_id IN (SELECT linked_user_id FROM linked_elsewhere) THEN 'already_linked'
      ELSE 'eligible'
    END::text AS linkability,
    CASE
      WHEN (SELECT owner_user_id FROM owner_row) = c.candidate_user_id       THEN 'Workspace owner'
      WHEN c.candidate_user_id IN (SELECT admin_user_id FROM pa)              THEN 'Platform administrator'
      WHEN tr.role IN ('owner','admin','super_admin')                         THEN 'Active ' || tr.role || ' — change role in Team & Permissions first'
      WHEN tr.user_type = 'internal'                                          THEN 'Internal user — change to portal in Team & Permissions first'
      WHEN c.candidate_user_id = v_caller                                     THEN 'This is your own account'
      WHEN c.candidate_user_id IN (SELECT linked_user_id FROM linked_elsewhere) THEN 'Already linked to another employee'
      ELSE NULL
    END::text AS block_reason
  FROM candidates c
  LEFT JOIN top_role tr ON tr.candidate_user_id = c.candidate_user_id
  LEFT JOIN public.profiles p ON p.user_id = c.candidate_user_id;
END;
$function$;


-- Defect 2: honour the permission_group_ids NOT NULL DEFAULT '{}' by coalescing NULL inputs.
CREATE OR REPLACE FUNCTION public.upsert_organization_invitation(
  p_organization_id uuid,
  p_email text,
  p_role app_role,
  p_user_type text DEFAULT 'internal'::text,
  p_permission_group_ids uuid[] DEFAULT NULL::uuid[],
  p_invited_by uuid DEFAULT NULL::uuid,
  p_expires_days integer DEFAULT 7
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
           -- If caller passed NULL, keep existing groups; otherwise replace with (possibly empty) provided list.
           permission_group_ids = CASE
             WHEN p_permission_group_ids IS NULL THEN permission_group_ids
             ELSE v_groups
           END,
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
    v_caller, v_groups
  )
  RETURNING id INTO v_new_id;

  RETURN jsonb_build_object(
    'status', 'created',
    'invitation_id', v_new_id,
    'token', v_token
  );
END;
$function$;
