-- =====================================================================
-- Identity lifecycle hardening: prevent admin demotion via HR workflows,
-- centralize employee↔user linking through one audited RPC, add recovery
-- path for workspace owners, and audit every identity change.
-- =====================================================================

-- ---------- 1. Audit log table ----------
CREATE TABLE IF NOT EXISTS public.identity_change_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  target_user_id uuid,
  target_employee_id uuid,
  actor_user_id uuid,
  source text NOT NULL,                 -- 'accept_invitation','link_employee_to_user','restore_owner_role','direct_sql', etc.
  action text NOT NULL,                 -- 'role_change','user_type_change','employee_link','employee_unlink','owner_restore'
  old_role text,
  new_role text,
  old_user_type text,
  new_user_type text,
  old_employee_user_id uuid,
  new_employee_user_id uuid,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.identity_change_audit_log TO authenticated;
GRANT ALL ON public.identity_change_audit_log TO service_role;

ALTER TABLE public.identity_change_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org admins read identity audit"
  ON public.identity_change_audit_log FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.organization_id = identity_change_audit_log.organization_id
        AND ur.is_active = true
        AND ur.role IN ('owner','admin','super_admin')
    )
  );

CREATE INDEX IF NOT EXISTS idx_identity_audit_org ON public.identity_change_audit_log (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_identity_audit_target ON public.identity_change_audit_log (target_user_id);


-- ---------- 2. Trigger: prevent demotion of privileged users ----------
CREATE OR REPLACE FUNCTION public.prevent_privileged_user_demotion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_owner uuid;
  v_active_admin_count int;
  v_is_platform_admin boolean := false;
BEGIN
  -- Bypass when a privileged RPC has explicitly opted in.
  IF current_setting('app.allow_persona_change', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF NEW.role IS NOT DISTINCT FROM OLD.role
     AND NEW.user_type IS NOT DISTINCT FROM OLD.user_type
     AND NEW.is_active IS NOT DISTINCT FROM OLD.is_active THEN
    RETURN NEW;
  END IF;

  SELECT owner_user_id INTO v_owner FROM public.organizations WHERE id = OLD.organization_id;

  SELECT EXISTS (
    SELECT 1 FROM public.platform_admins
     WHERE user_id = OLD.user_id AND is_active = true
  ) INTO v_is_platform_admin;

  -- Workspace owner row may never be demoted, deactivated, or persona-flipped.
  IF OLD.user_id = v_owner AND OLD.role = 'owner' THEN
    IF NEW.role <> 'owner'
       OR COALESCE(NEW.user_type,'internal') = 'portal'
       OR NEW.is_active = false THEN
      RAISE EXCEPTION 'Cannot demote, deactivate, or convert the workspace owner''s role. Use Transfer Ownership instead.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- Any privileged → portal transition is forbidden outside the persona-change RPC.
  IF OLD.role IN ('owner','admin','super_admin')
     AND COALESCE(OLD.user_type,'internal') = 'internal'
     AND (NEW.role = 'portal' OR COALESCE(NEW.user_type,'internal') = 'portal') THEN
    RAISE EXCEPTION 'Cannot convert an internal privileged user (%) into a portal user via this path. Use the explicit Demote action.', OLD.role
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Platform admins must never be downgraded to portal in any tenant.
  IF v_is_platform_admin
     AND (NEW.role = 'portal' OR COALESCE(NEW.user_type,'internal') = 'portal') THEN
    RAISE EXCEPTION 'Cannot convert a platform administrator into a portal user.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Last-admin guard: refuse if this update would leave the org with zero active admins/owners.
  IF OLD.role IN ('owner','admin','super_admin')
     AND OLD.is_active = true
     AND (NEW.role NOT IN ('owner','admin','super_admin') OR NEW.is_active = false) THEN
    SELECT COUNT(*) INTO v_active_admin_count
      FROM public.user_roles
     WHERE organization_id = OLD.organization_id
       AND id <> OLD.id
       AND is_active = true
       AND role IN ('owner','admin','super_admin');
    IF v_active_admin_count = 0 THEN
      RAISE EXCEPTION 'Cannot demote the last active administrator of this workspace.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_privileged_user_demotion ON public.user_roles;
CREATE TRIGGER trg_prevent_privileged_user_demotion
  BEFORE UPDATE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_privileged_user_demotion();


-- ---------- 3. Trigger: AFTER write on user_roles → audit ----------
CREATE OR REPLACE FUNCTION public.audit_user_roles_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.role IS NOT DISTINCT FROM OLD.role
     AND NEW.user_type IS NOT DISTINCT FROM OLD.user_type
     AND NEW.is_active IS NOT DISTINCT FROM OLD.is_active THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.identity_change_audit_log (
    organization_id, target_user_id, actor_user_id, source, action,
    old_role, new_role, old_user_type, new_user_type, reason
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    COALESCE(NEW.user_id, OLD.user_id),
    auth.uid(),
    COALESCE(current_setting('app.identity_change_source', true), 'direct_sql'),
    CASE
      WHEN TG_OP = 'INSERT' THEN 'role_assigned'
      WHEN NEW.role IS DISTINCT FROM OLD.role THEN 'role_change'
      WHEN NEW.user_type IS DISTINCT FROM OLD.user_type THEN 'user_type_change'
      WHEN NEW.is_active IS DISTINCT FROM OLD.is_active THEN 'activation_change'
      ELSE 'other'
    END,
    OLD.role::text, NEW.role::text,
    OLD.user_type, NEW.user_type,
    NULLIF(current_setting('app.identity_change_reason', true), '')
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_user_roles ON public.user_roles;
CREATE TRIGGER trg_audit_user_roles
  AFTER INSERT OR UPDATE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.audit_user_roles_change();


-- ---------- 4. employees.user_id audit ----------
CREATE OR REPLACE FUNCTION public.audit_employee_user_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.user_id IS NOT DISTINCT FROM OLD.user_id THEN RETURN NEW; END IF;
  INSERT INTO public.identity_change_audit_log (
    organization_id, target_user_id, target_employee_id, actor_user_id,
    source, action, old_employee_user_id, new_employee_user_id, reason
  ) VALUES (
    NEW.organization_id, COALESCE(NEW.user_id, OLD.user_id), NEW.id, auth.uid(),
    COALESCE(current_setting('app.identity_change_source', true), 'direct_sql'),
    CASE WHEN NEW.user_id IS NULL THEN 'employee_unlink' ELSE 'employee_link' END,
    OLD.user_id, NEW.user_id,
    NULLIF(current_setting('app.identity_change_reason', true), '')
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_employee_user_link ON public.employees;
CREATE TRIGGER trg_audit_employee_user_link
  AFTER UPDATE OF user_id ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.audit_employee_user_link();


-- ---------- 5. Partial unique index on user_roles ----------
CREATE UNIQUE INDEX IF NOT EXISTS uniq_user_roles_active_user_org
  ON public.user_roles (user_id, organization_id) WHERE is_active = true;


-- ---------- 6. Invitation guard: reject demoting invitations ----------
CREATE OR REPLACE FUNCTION public.prevent_invitation_demoting_admin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_target_user uuid;
  v_existing_role text;
BEGIN
  IF NEW.accepted_at IS NOT NULL THEN RETURN NEW; END IF;

  SELECT id INTO v_target_user FROM auth.users WHERE lower(email) = lower(NEW.email) LIMIT 1;
  IF v_target_user IS NULL THEN RETURN NEW; END IF;

  SELECT role::text INTO v_existing_role
    FROM public.user_roles
   WHERE user_id = v_target_user
     AND organization_id = NEW.organization_id
     AND is_active = true
   LIMIT 1;

  IF v_existing_role IS NULL THEN RETURN NEW; END IF;

  IF v_existing_role IN ('owner','admin','super_admin')
     AND (NEW.user_type = 'portal' OR NEW.role::text = 'portal') THEN
    RAISE EXCEPTION '% is already an internal % in this workspace — a portal invitation would demote them. Use the Team page to change their role explicitly.', NEW.email, v_existing_role
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_invitation_demoting_admin ON public.organization_invitations;
CREATE TRIGGER trg_prevent_invitation_demoting_admin
  BEFORE INSERT OR UPDATE ON public.organization_invitations
  FOR EACH ROW EXECUTE FUNCTION public.prevent_invitation_demoting_admin();


-- ---------- 7. Single RPC for employee↔user linking ----------
CREATE OR REPLACE FUNCTION public.link_employee_to_user(
  p_employee_id uuid,
  p_user_id uuid,
  p_force boolean DEFAULT false
)
RETURNS TABLE(was_changed boolean, employee_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_org_id uuid;
  v_business_id uuid;
  v_prev_user uuid;
  v_caller_admin boolean;
  v_target_role text;
  v_owner_user uuid;
  v_target_is_platform_admin boolean;
  v_other_employee uuid;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_employee_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'employee_id and user_id are required';
  END IF;

  SELECT organization_id, business_id, user_id
    INTO v_org_id, v_business_id, v_prev_user
    FROM public.employees WHERE id = p_employee_id;
  IF v_org_id IS NULL THEN RAISE EXCEPTION 'Employee not found'; END IF;

  -- Caller must be owner/admin/super_admin in the employee's org
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = v_caller AND organization_id = v_org_id
       AND is_active = true AND role IN ('owner','admin','super_admin')
  ) INTO v_caller_admin;
  IF NOT v_caller_admin THEN
    RAISE EXCEPTION 'Only workspace administrators can link employee records.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Already correctly linked? idempotent no-op.
  IF v_prev_user = p_user_id THEN
    was_changed := false; employee_id := p_employee_id; RETURN NEXT; RETURN;
  END IF;

  -- Target must not already be linked to a different employee in this org.
  SELECT id INTO v_other_employee
    FROM public.employees
   WHERE organization_id = v_org_id
     AND user_id = p_user_id
     AND id <> p_employee_id
   LIMIT 1;
  IF v_other_employee IS NOT NULL THEN
    RAISE EXCEPTION 'That user is already linked to another employee record (%) in this workspace.', v_other_employee
      USING ERRCODE = 'unique_violation';
  END IF;

  SELECT owner_user_id INTO v_owner_user FROM public.organizations WHERE id = v_org_id;

  SELECT role::text INTO v_target_role
    FROM public.user_roles
   WHERE user_id = p_user_id AND organization_id = v_org_id AND is_active = true
   LIMIT 1;

  SELECT EXISTS(
    SELECT 1 FROM public.platform_admins WHERE user_id = p_user_id AND is_active = true
  ) INTO v_target_is_platform_admin;

  -- Owner / platform-admin links require force=true AND an explicit confirmation.
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

  was_changed := true; employee_id := p_employee_id; RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.link_employee_to_user(uuid, uuid, boolean) TO authenticated;


CREATE OR REPLACE FUNCTION public.unlink_employee_from_user(p_employee_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_org_id uuid;
  v_prev uuid;
  v_owner uuid;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT organization_id, user_id INTO v_org_id, v_prev FROM public.employees WHERE id = p_employee_id;
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
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.unlink_employee_from_user(uuid) TO authenticated;


-- Backwards-compat: link_self_as_employee already only ever inserts for the caller, leave as-is.


-- ---------- 8. Recovery RPC: restore owner role ----------
CREATE OR REPLACE FUNCTION public.restore_owner_role(p_org_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_owner uuid;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT owner_user_id INTO v_owner FROM public.organizations WHERE id = p_org_id;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Organization not found'; END IF;
  IF v_owner <> v_caller THEN
    RAISE EXCEPTION 'Only the workspace owner can restore their own owner role.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM set_config('app.allow_persona_change','on', true);
  PERFORM set_config('app.identity_change_source','restore_owner_role', true);

  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = v_caller AND organization_id = p_org_id) THEN
    UPDATE public.user_roles
       SET role = 'owner', user_type = 'internal', is_active = true, updated_at = now()
     WHERE user_id = v_caller AND organization_id = p_org_id;
  ELSE
    INSERT INTO public.user_roles (user_id, organization_id, role, user_type, is_active)
    VALUES (v_caller, p_org_id, 'owner', 'internal', true);
  END IF;

  PERFORM set_config('app.allow_persona_change','', true);
  PERFORM set_config('app.identity_change_source','', true);
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.restore_owner_role(uuid) TO authenticated;


-- ---------- 9. resolve_my_employee: prefer last_org_id ----------
CREATE OR REPLACE FUNCTION public.resolve_my_employee()
RETURNS TABLE(employee_id uuid, organization_id uuid, business_id uuid, is_linked boolean, can_self_link boolean)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org_id uuid;
  v_last uuid;
  v_emp record;
  v_is_admin boolean := false;
  v_org_has_any_employee boolean := false;
BEGIN
  IF v_user IS NULL THEN RETURN; END IF;

  SELECT last_org_id INTO v_last FROM public.profiles WHERE user_id = v_user LIMIT 1;

  IF v_last IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = v_user AND organization_id = v_last AND is_active = true
  ) THEN
    v_org_id := v_last;
  ELSE
    SELECT ur.organization_id INTO v_org_id
      FROM public.user_roles ur
     WHERE ur.user_id = v_user AND ur.is_active = true
     ORDER BY CASE ur.role
                WHEN 'super_admin' THEN 0
                WHEN 'owner' THEN 1
                WHEN 'admin' THEN 2
                ELSE 3
              END, ur.created_at ASC
     LIMIT 1;
  END IF;

  IF v_org_id IS NULL THEN RETURN; END IF;

  SELECT e.id, e.organization_id, e.business_id INTO v_emp
    FROM public.employees e
   WHERE e.user_id = v_user AND e.organization_id = v_org_id
   LIMIT 1;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = v_user AND ur.organization_id = v_org_id
       AND ur.is_active = true AND ur.role IN ('owner','admin','super_admin')
  ) INTO v_is_admin;

  SELECT EXISTS (
    SELECT 1 FROM public.employees e WHERE e.organization_id = v_org_id
  ) INTO v_org_has_any_employee;

  employee_id     := v_emp.id;
  organization_id := COALESCE(v_emp.organization_id, v_org_id);
  business_id     := v_emp.business_id;
  is_linked       := v_emp.id IS NOT NULL;
  can_self_link   := v_is_admin AND NOT v_org_has_any_employee AND v_emp.id IS NULL;

  RETURN NEXT;
END;
$$;