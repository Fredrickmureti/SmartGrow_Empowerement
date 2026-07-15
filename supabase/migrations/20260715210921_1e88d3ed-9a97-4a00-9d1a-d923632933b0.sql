
-- =========================================================================
-- Part A1: Extend the employee_lifecycle_event_type enum.
-- =========================================================================
ALTER TYPE public.employee_lifecycle_event_type ADD VALUE IF NOT EXISTS 'user_invited';
ALTER TYPE public.employee_lifecycle_event_type ADD VALUE IF NOT EXISTS 'user_invitation_revoked';
ALTER TYPE public.employee_lifecycle_event_type ADD VALUE IF NOT EXISTS 'user_invitation_accepted';
ALTER TYPE public.employee_lifecycle_event_type ADD VALUE IF NOT EXISTS 'user_linked';
ALTER TYPE public.employee_lifecycle_event_type ADD VALUE IF NOT EXISTS 'user_unlinked';

-- =========================================================================
-- Part A2: Explicit invitation -> employee FK.
-- =========================================================================
ALTER TABLE public.organization_invitations
  ADD COLUMN IF NOT EXISTS employee_id uuid NULL
    REFERENCES public.employees(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_org_invitations_open_per_employee
  ON public.organization_invitations (organization_id, employee_id)
  WHERE accepted_at IS NULL AND employee_id IS NOT NULL;

-- Backfill (best-effort: only rows where the email uniquely maps to one employee).
WITH candidates AS (
  SELECT i.id AS invitation_id, e.id AS employee_id
    FROM public.organization_invitations i
    JOIN public.employees e
      ON e.organization_id = i.organization_id
     AND (
          lower(e.work_email) = lower(i.email)
       OR lower(e.email)      = lower(i.email)
     )
   WHERE i.employee_id IS NULL
),
unambiguous AS (
  SELECT invitation_id, (array_agg(DISTINCT employee_id))[1] AS employee_id
    FROM candidates
   GROUP BY invitation_id
  HAVING COUNT(DISTINCT employee_id) = 1
)
UPDATE public.organization_invitations i
   SET employee_id = u.employee_id
  FROM unambiguous u
 WHERE i.id = u.invitation_id;

-- =========================================================================
-- Part B1: Derived user_access_status compute function.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.compute_employee_user_access_status(p_employee_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_org uuid;
  v_user uuid;
  v_email text;
  v_work_email text;
  v_has_open_invite boolean;
BEGIN
  SELECT organization_id, user_id, email, work_email
    INTO v_org, v_user, v_email, v_work_email
    FROM public.employees
   WHERE id = p_employee_id;

  IF v_org IS NULL THEN
    RETURN 'none';
  END IF;

  IF v_user IS NOT NULL THEN
    RETURN 'active';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.organization_invitations i
     WHERE i.organization_id = v_org
       AND i.accepted_at IS NULL
       AND i.expires_at > now()
       AND (
            i.employee_id = p_employee_id
         OR (i.employee_id IS NULL AND (
               lower(i.email) = lower(COALESCE(v_work_email, ''))
            OR lower(i.email) = lower(COALESCE(v_email, ''))
         ))
       )
  ) INTO v_has_open_invite;

  IF v_has_open_invite THEN
    RETURN 'invited';
  END IF;
  RETURN 'none';
END;
$$;

-- =========================================================================
-- Part B2: Triggers that keep user_access_status in sync.
-- =========================================================================
CREATE OR REPLACE FUNCTION public._employees_user_access_status_biu()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.user_id IS NOT NULL THEN
    NEW.user_access_status := 'active';
    RETURN NEW;
  END IF;

  IF NEW.id IS NULL THEN
    NEW.user_access_status := 'none';
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.organization_invitations i
     WHERE i.organization_id = NEW.organization_id
       AND i.accepted_at IS NULL
       AND i.expires_at > now()
       AND (
            i.employee_id = NEW.id
         OR (i.employee_id IS NULL AND (
               lower(i.email) = lower(COALESCE(NEW.work_email, ''))
            OR lower(i.email) = lower(COALESCE(NEW.email, ''))
         ))
       )
  ) THEN
    NEW.user_access_status := 'invited';
  ELSE
    NEW.user_access_status := 'none';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS _employees_user_access_status_biu ON public.employees;
CREATE TRIGGER _employees_user_access_status_biu
BEFORE INSERT OR UPDATE OF user_id, email, work_email, organization_id
ON public.employees
FOR EACH ROW EXECUTE FUNCTION public._employees_user_access_status_biu();

CREATE OR REPLACE FUNCTION public._invitations_touch_employee_access_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_row public.organization_invitations := COALESCE(NEW, OLD);
BEGIN
  IF NEW IS NOT NULL AND NEW.employee_id IS NOT NULL THEN
    UPDATE public.employees SET user_access_status =
      public.compute_employee_user_access_status(id)
      WHERE id = NEW.employee_id;
  END IF;
  IF OLD IS NOT NULL AND OLD.employee_id IS NOT NULL
     AND (NEW IS NULL OR NEW.employee_id IS DISTINCT FROM OLD.employee_id) THEN
    UPDATE public.employees SET user_access_status =
      public.compute_employee_user_access_status(id)
      WHERE id = OLD.employee_id;
  END IF;

  UPDATE public.employees e
     SET user_access_status = public.compute_employee_user_access_status(e.id)
   WHERE e.organization_id = v_row.organization_id
     AND e.user_id IS NULL
     AND (
          lower(e.work_email) = lower(v_row.email)
       OR lower(e.email)      = lower(v_row.email)
     );

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS _invitations_touch_employee_access_status ON public.organization_invitations;
CREATE TRIGGER _invitations_touch_employee_access_status
AFTER INSERT OR UPDATE OF accepted_at, expires_at, employee_id, email
   OR DELETE
ON public.organization_invitations
FOR EACH ROW EXECUTE FUNCTION public._invitations_touch_employee_access_status();

-- =========================================================================
-- Part B3: Backfill user_access_status for every existing employee.
-- =========================================================================
UPDATE public.employees e
   SET user_access_status = public.compute_employee_user_access_status(e.id);

-- =========================================================================
-- Part A3: RPCs.
-- =========================================================================
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
END;
$function$;


CREATE OR REPLACE FUNCTION public.link_employee_to_user(
  p_employee_id uuid, p_user_id uuid, p_force boolean DEFAULT false
)
RETURNS TABLE(was_changed boolean, employee_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_org_id uuid;
  v_business_id uuid;
  v_prev_user uuid;
  v_lifecycle text;
  v_caller_admin boolean;
  v_owner_user uuid;
  v_target_is_platform_admin boolean;
  v_other_employee uuid;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_employee_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'employee_id and user_id are required';
  END IF;

  SELECT organization_id, business_id, user_id, lifecycle_status::text
    INTO v_org_id, v_business_id, v_prev_user, v_lifecycle
    FROM public.employees WHERE id = p_employee_id;
  IF v_org_id IS NULL THEN RAISE EXCEPTION 'Employee not found'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = v_caller AND organization_id = v_org_id
       AND is_active = true AND role IN ('owner','admin','super_admin')
  ) INTO v_caller_admin;
  IF NOT v_caller_admin THEN
    RAISE EXCEPTION 'Only workspace administrators can link employee records.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_prev_user = p_user_id THEN
    was_changed := false; employee_id := p_employee_id; RETURN NEXT; RETURN;
  END IF;

  IF v_lifecycle = 'draft' AND NOT p_force THEN
    RAISE EXCEPTION 'You are about to link a draft employee to a user account. Promote the draft first, or re-submit with confirm=true.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT id INTO v_other_employee
    FROM public.employees
   WHERE organization_id = v_org_id AND user_id = p_user_id AND id <> p_employee_id
   LIMIT 1;
  IF v_other_employee IS NOT NULL THEN
    RAISE EXCEPTION 'That user is already linked to another employee record (%) in this workspace.', v_other_employee
      USING ERRCODE = 'unique_violation';
  END IF;

  SELECT owner_user_id INTO v_owner_user FROM public.organizations WHERE id = v_org_id;
  SELECT EXISTS(
    SELECT 1 FROM public.platform_admins WHERE user_id = p_user_id AND is_active = true
  ) INTO v_target_is_platform_admin;

  IF p_user_id = v_owner_user AND NOT p_force THEN
    RAISE EXCEPTION 'You are about to link the workspace owner to an employee record. Re-submit with confirm=true.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_target_is_platform_admin AND NOT p_force THEN
    RAISE EXCEPTION 'You are about to link a platform administrator to an employee record. Re-submit with confirm=true.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_user_id = v_caller AND NOT p_force THEN
    RAISE EXCEPTION 'You are about to link your own account to an employee record. Re-submit with confirm=true.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM set_config('app.identity_change_source','link_employee_to_user', true);
  PERFORM set_config('app.identity_change_reason',
    CASE WHEN p_force THEN 'forced by admin' ELSE 'standard' END, true);

  UPDATE public.employees SET user_id = p_user_id WHERE id = p_employee_id;

  PERFORM set_config('app.identity_change_source','', true);
  PERFORM set_config('app.identity_change_reason','', true);

  INSERT INTO public.employee_lifecycle_events (
    organization_id, business_id, employee_id, event_type,
    actor_user_id, source_table, source_id, summary, payload
  ) VALUES (
    v_org_id, v_business_id, p_employee_id, 'user_linked',
    v_caller, 'employees', p_employee_id,
    CASE WHEN p_force THEN 'User account linked (forced)' ELSE 'User account linked' END,
    jsonb_build_object('target_user_id', p_user_id, 'forced', p_force,
                       'previous_user_id', v_prev_user)
  );

  was_changed := true; employee_id := p_employee_id; RETURN NEXT;
END;
$function$;


CREATE OR REPLACE FUNCTION public.unlink_employee_from_user(p_employee_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_org_id uuid;
  v_business_id uuid;
  v_prev uuid;
  v_owner uuid;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT organization_id, business_id, user_id
    INTO v_org_id, v_business_id, v_prev
    FROM public.employees WHERE id = p_employee_id;
  IF v_org_id IS NULL THEN RAISE EXCEPTION 'Employee not found'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = v_caller AND organization_id = v_org_id
       AND is_active = true AND role IN ('owner','admin','super_admin')
  ) THEN
    RAISE EXCEPTION 'Only workspace administrators can unlink employee records.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_prev IS NULL THEN RETURN false; END IF;

  SELECT owner_user_id INTO v_owner FROM public.organizations WHERE id = v_org_id;
  IF v_prev = v_owner THEN
    RAISE EXCEPTION 'Cannot unlink the workspace owner''s employee record. Transfer ownership first.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  PERFORM set_config('app.identity_change_source','unlink_employee_from_user', true);
  UPDATE public.employees SET user_id = NULL WHERE id = p_employee_id;
  PERFORM set_config('app.identity_change_source','', true);

  INSERT INTO public.employee_lifecycle_events (
    organization_id, business_id, employee_id, event_type,
    actor_user_id, source_table, source_id, summary, payload
  ) VALUES (
    v_org_id, v_business_id, p_employee_id, 'user_unlinked',
    v_caller, 'employees', p_employee_id,
    'User account unlinked',
    jsonb_build_object('former_user_id', v_prev)
  );

  RETURN true;
END;
$function$;


CREATE OR REPLACE FUNCTION public.revoke_organization_invitation(p_invitation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_inv record;
  v_business_id uuid;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT id, organization_id, email, role, user_type, employee_id, accepted_at
    INTO v_inv
    FROM public.organization_invitations
   WHERE id = p_invitation_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'already_accepted');
  END IF;

  IF NOT (public.has_role(v_caller, v_inv.organization_id, 'owner'::public.app_role)
       OR public.has_role(v_caller, v_inv.organization_id, 'admin'::public.app_role)) THEN
    RAISE EXCEPTION 'Only org owners/admins can revoke invitations' USING ERRCODE = '42501';
  END IF;

  UPDATE public.organization_invitations
     SET expires_at = now() - interval '1 second'
   WHERE id = v_inv.id;

  IF v_inv.employee_id IS NOT NULL THEN
    SELECT business_id INTO v_business_id FROM public.employees WHERE id = v_inv.employee_id;
    INSERT INTO public.employee_lifecycle_events (
      organization_id, business_id, employee_id, event_type,
      actor_user_id, source_table, source_id, summary, payload
    ) VALUES (
      v_inv.organization_id, v_business_id, v_inv.employee_id, 'user_invitation_revoked',
      v_caller, 'organization_invitations', v_inv.id,
      'Invitation revoked for ' || v_inv.email,
      jsonb_build_object('email', v_inv.email, 'role', v_inv.role::text, 'user_type', v_inv.user_type)
    );
  END IF;

  RETURN jsonb_build_object('ok', true, 'invitation_id', v_inv.id);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.revoke_organization_invitation(uuid) TO authenticated;
