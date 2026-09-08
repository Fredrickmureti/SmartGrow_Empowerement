-- 1. Role authority: owner + admin are blanket authorities.
CREATE OR REPLACE FUNCTION public.user_has_module_permission(_user_id uuid, _org_id uuid, _module text, _operation text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _user_type text;
  _role text;
  _exists boolean;
  _group_grants boolean := false;
  _mod text := CASE
    WHEN _module = 'hr'         THEN 'employees'
    WHEN _module = 'timesheets' THEN 'attendance'
    ELSE _module
  END;
  _lending_mods constant text[] := ARRAY[
    'clients','loan_products','applications','loans','repayments','collections'
  ];
  _fin_mods constant text[] := ARRAY['accounting','treasury'];
BEGIN
  SELECT true, ur.user_type, ur.role::text INTO _exists, _user_type, _role
  FROM public.user_roles ur
  WHERE ur.user_id = _user_id
    AND ur.organization_id = _org_id
    AND ur.is_active = true
  LIMIT 1;

  IF _exists IS NOT TRUE THEN RETURN false; END IF;
  IF _user_type = 'portal' THEN RETURN false; END IF;

  -- Recorded ownership is a blanket authority.
  IF EXISTS (
    SELECT 1 FROM public.organizations o
     WHERE o.id = _org_id AND o.owner_user_id = _user_id
  ) THEN
    RETURN true;
  END IF;

  -- The owner and admin role labels are blanket authorities too. Segregation of
  -- duties is enforced separately by governance_assert_not_self, so this does
  -- not let an administrator bypass approvals.
  IF _role IN ('owner','admin') THEN
    RETURN true;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.member_permission_groups mpg
    JOIN public.permission_group_rules pgr ON pgr.permission_group_id = mpg.permission_group_id
    WHERE mpg.user_id = _user_id
      AND mpg.organization_id = _org_id
      AND (
        pgr.module = _mod
        OR (pgr.module = 'lending'    AND _mod = ANY(_lending_mods))
        OR (pgr.module = 'financials' AND _mod = ANY(_fin_mods))
      )
      AND CASE _operation
        WHEN 'read'    THEN pgr.can_read
        WHEN 'create'  THEN pgr.can_create
        WHEN 'write'   THEN pgr.can_write
        WHEN 'delete'  THEN pgr.can_delete
        WHEN 'approve' THEN pgr.can_approve
        WHEN 'post'    THEN pgr.can_post
        WHEN 'pay'     THEN pgr.can_pay
        WHEN 'close'   THEN pgr.can_close
        WHEN 'reverse' THEN pgr.can_reverse
        WHEN 'export'  THEN pgr.can_export
        ELSE false
      END
  ) INTO _group_grants;

  RETURN _group_grants;
END;
$function$;

-- 2. Helper: resolve (creating if needed) the default access group for a role.
CREATE OR REPLACE FUNCTION public.resolve_default_permission_group(_org_id uuid, _role text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_group_id uuid;
  v_module text;
  v_baseline constant text[] := ARRAY['clients','loans','repayments','collections','reports','contacts'];
BEGIN
  IF _role IN ('owner','admin','super_admin') THEN
    SELECT id INTO v_group_id
      FROM public.permission_groups
     WHERE organization_id = _org_id
       AND is_system = true
       AND is_deprecated = false
       AND name = 'Institution Admin'
     LIMIT 1;
    IF v_group_id IS NOT NULL THEN RETURN v_group_id; END IF;
  END IF;

  SELECT id INTO v_group_id
    FROM public.permission_groups
   WHERE organization_id = _org_id
     AND is_deprecated = false
     AND name IN ('Internal Users','Internal User')
   LIMIT 1;
  IF v_group_id IS NOT NULL THEN RETURN v_group_id; END IF;

  INSERT INTO public.permission_groups (organization_id, name, description, is_system)
  VALUES (_org_id, 'Internal Users',
          'Default group for invited staff — view-only baseline until an administrator refines it.',
          true)
  RETURNING id INTO v_group_id;

  FOREACH v_module IN ARRAY v_baseline LOOP
    INSERT INTO public.permission_group_rules (permission_group_id, module, can_read)
    VALUES (v_group_id, v_module, true)
    ON CONFLICT DO NOTHING;
  END LOOP;

  RETURN v_group_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_default_permission_group(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_default_permission_group(uuid, text) TO service_role;

-- 3. Invitation acceptance: never leave a member with zero access groups.
CREATE OR REPLACE FUNCTION public.accept_organization_invitation_atomic(p_invitation_id uuid, p_user_id uuid, p_permission_group_ids uuid[] DEFAULT NULL::uuid[])
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
  v_is_portal boolean;
  v_business_id uuid;
  v_target_employee_id uuid;
  v_branch_id uuid;
  v_branch_business_id uuid;
BEGIN
  SELECT id, organization_id, email, role, user_type, accepted_at, expires_at,
         employee_id,
         COALESCE(permission_group_ids, ARRAY[]::uuid[]) AS permission_group_ids,
         COALESCE(branch_ids, ARRAY[]::uuid[]) AS branch_ids,
         primary_branch_id,
         COALESCE(branch_scope, 'assigned'::public.branch_scope_mode) AS branch_scope
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
        INSERT INTO member_permission_groups (organization_id, user_id, permission_group_id, branch_scope)
        VALUES (v_inv.organization_id, p_user_id, v_group_id, v_inv.branch_scope)
        ON CONFLICT DO NOTHING;
      END LOOP;
    ELSE
      -- No explicit groups: resolve a real default for the invited role,
      -- creating the institution's default staff group when absent. Previously
      -- this looked for a hardcoded name that did not exist, silently leaving
      -- the new member with no access at all.
      v_group_id := public.resolve_default_permission_group(
        v_inv.organization_id, v_inv.role::text
      );
      IF v_group_id IS NOT NULL THEN
        INSERT INTO member_permission_groups (organization_id, user_id, permission_group_id, branch_scope)
        VALUES (v_inv.organization_id, p_user_id, v_group_id, v_inv.branch_scope)
        ON CONFLICT DO NOTHING;
      END IF;
    END IF;

    -- Apply branch assignments captured on the invitation
    IF array_length(v_inv.branch_ids, 1) > 0 THEN
      FOREACH v_branch_id IN ARRAY v_inv.branch_ids LOOP
        SELECT b.business_id INTO v_branch_business_id
          FROM public.branches b
         WHERE b.id = v_branch_id AND b.organization_id = v_inv.organization_id;

        IF v_branch_business_id IS NOT NULL THEN
          INSERT INTO public.user_branch_assignments (
            user_id, organization_id, business_id, branch_id,
            is_primary, can_view, can_manage, assigned_by
          ) VALUES (
            p_user_id, v_inv.organization_id, v_branch_business_id, v_branch_id,
            (v_inv.primary_branch_id IS NOT NULL AND v_branch_id = v_inv.primary_branch_id),
            true, false, v_inv.employee_id
          )
          ON CONFLICT DO NOTHING;
        END IF;
      END LOOP;
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
      jsonb_build_object('email', v_inv.email, 'role', v_inv.role::text, 'user_type', v_inv.user_type,
                         'branch_ids', v_inv.branch_ids, 'branch_scope', v_inv.branch_scope::text)
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
    'linked_employee_id', v_linked_employee_id,
    'branch_ids', v_inv.branch_ids
  );
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.identity_change_source','', true);
  RAISE;
END;
$function$;