CREATE OR REPLACE FUNCTION public.enforce_employee_user_link_write_source()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source text := current_setting('app.identity_change_source', true);
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    IF COALESCE(v_source, '') NOT IN (
      'accept_organization_invitation_atomic',
      'link_employee_to_user',
      'unlink_employee_from_user',
      'link_self_as_employee'
    ) THEN
      RAISE EXCEPTION 'employees.user_id may only be changed through the employee identity lifecycle RPCs'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_employee_user_link_write_source ON public.employees;
CREATE TRIGGER trg_enforce_employee_user_link_write_source
BEFORE UPDATE OF user_id ON public.employees
FOR EACH ROW
EXECUTE FUNCTION public.enforce_employee_user_link_write_source();

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

  IF FOUND AND v_existing_role.role = ANY (v_privileged) AND v_is_portal THEN
    RETURN jsonb_build_object(
      'ok', false, 'code', 'would_demote_admin',
      'existing_role', v_existing_role.role
    );
  END IF;

  IF FOUND THEN
    UPDATE user_roles
       SET role = v_inv.role, user_type = v_inv.user_type,
           is_active = true, updated_at = now()
     WHERE id = v_existing_role.id;
  ELSE
    INSERT INTO user_roles (user_id, organization_id, role, user_type, is_active)
    VALUES (p_user_id, v_inv.organization_id, v_inv.role, v_inv.user_type, true);
  END IF;

  IF NOT FOUND OR NOT (v_existing_role.role = ANY (v_privileged)) THEN
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