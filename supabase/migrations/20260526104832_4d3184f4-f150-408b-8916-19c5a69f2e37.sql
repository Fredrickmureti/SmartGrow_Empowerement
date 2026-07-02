
CREATE TABLE IF NOT EXISTS public.onboarding_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid,
  UNIQUE (organization_id, kind)
);

ALTER TABLE public.onboarding_suggestions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "onboarding_suggestions_read"  ON public.onboarding_suggestions;
DROP POLICY IF EXISTS "onboarding_suggestions_write" ON public.onboarding_suggestions;

CREATE POLICY "onboarding_suggestions_read"
  ON public.onboarding_suggestions FOR SELECT TO authenticated
  USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

CREATE POLICY "onboarding_suggestions_write"
  ON public.onboarding_suggestions FOR UPDATE TO authenticated
  USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())))
  WITH CHECK (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

CREATE OR REPLACE FUNCTION public.seed_app_data(p_org_id uuid, p_app_id text)
 RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_business RECORD;
  v_hr_manager_group_id uuid;
  v_internal_group_id uuid;
  v_owner_user_id uuid;
  v_first_business_id uuid;
BEGIN
  SELECT id INTO v_internal_group_id
    FROM public.permission_groups
   WHERE organization_id = p_org_id AND name = 'Internal User' AND is_system = true LIMIT 1;

  IF p_app_id IN ('employees','hr') THEN
    FOR v_business IN
      SELECT id FROM public.businesses WHERE organization_id = p_org_id AND is_active = true
    LOOP
      INSERT INTO public.departments (organization_id, business_id, name, is_active)
      VALUES
        (p_org_id, v_business.id, 'Human Resources', true),
        (p_org_id, v_business.id, 'Administration',  true),
        (p_org_id, v_business.id, 'Operations',      true)
      ON CONFLICT (business_id, lower(name)) DO NOTHING;
    END LOOP;

    SELECT id INTO v_hr_manager_group_id
      FROM public.permission_groups
     WHERE organization_id = p_org_id AND name = 'HR Manager' LIMIT 1;
    IF v_hr_manager_group_id IS NULL THEN
      INSERT INTO public.permission_groups (organization_id, name, description, is_system, is_active)
      VALUES (p_org_id, 'HR Manager', 'Manage employees, departments, and HR records', true, true)
      RETURNING id INTO v_hr_manager_group_id;
    END IF;
    INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
    VALUES
      (v_hr_manager_group_id, 'employees', true, true, true, true),
      (v_hr_manager_group_id, 'hr',        true, true, true, true)
    ON CONFLICT (permission_group_id, module) DO NOTHING;

    IF v_internal_group_id IS NOT NULL THEN
      INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
      VALUES (v_internal_group_id, 'employees', true, false, false, false)
      ON CONFLICT (permission_group_id, module) DO NOTHING;
    END IF;

    SELECT o.owner_user_id INTO v_owner_user_id FROM public.organizations o WHERE o.id = p_org_id;
    SELECT id INTO v_first_business_id
      FROM public.businesses
     WHERE organization_id = p_org_id AND is_active = true
     ORDER BY created_at ASC LIMIT 1;

    IF v_owner_user_id IS NOT NULL AND v_first_business_id IS NOT NULL THEN
      INSERT INTO public.onboarding_suggestions (organization_id, kind, payload)
      VALUES (
        p_org_id, 'link_owner_as_employee',
        jsonb_build_object('owner_user_id', v_owner_user_id, 'business_id', v_first_business_id)
      )
      ON CONFLICT (organization_id, kind) DO NOTHING;
    END IF;
  END IF;

  IF p_app_id IN ('time-off','hr') THEN
    INSERT INTO public.leave_types (organization_id, name, code, color, requires_approval, is_paid, is_active, max_consecutive_days)
    VALUES
      (p_org_id, 'Annual Leave',       'AL', '#3B82F6', true,  true,  true, 30),
      (p_org_id, 'Sick Leave',          'SL', '#EF4444', true,  true,  true, 10),
      (p_org_id, 'Maternity Leave',     'ML', '#EC4899', true,  true,  true, 90),
      (p_org_id, 'Paternity Leave',     'PL', '#8B5CF6', true,  true,  true, 14),
      (p_org_id, 'Unpaid Leave',        'UL', '#6B7280', true,  false, true, 30),
      (p_org_id, 'Compassionate Leave', 'CL', '#F59E0B', true,  true,  true, 5)
    ON CONFLICT DO NOTHING;

    SELECT id INTO v_hr_manager_group_id
      FROM public.permission_groups
     WHERE organization_id = p_org_id AND name = 'HR Manager' LIMIT 1;
    IF v_hr_manager_group_id IS NULL THEN
      INSERT INTO public.permission_groups (organization_id, name, description, is_system, is_active)
      VALUES (p_org_id, 'HR Manager', 'Manage employees, leave, and HR records', true, true)
      RETURNING id INTO v_hr_manager_group_id;
    END IF;
    INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
    VALUES (v_hr_manager_group_id, 'leave', true, true, true, true)
    ON CONFLICT (permission_group_id, module) DO NOTHING;

    IF v_internal_group_id IS NOT NULL THEN
      INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
      VALUES (v_internal_group_id, 'leave', true, true, false, false)
      ON CONFLICT (permission_group_id, module) DO NOTHING;
    END IF;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_employee_ownership_integrity()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_owner_user_id uuid;
  v_target_user_id uuid;
  v_org_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_target_user_id := OLD.user_id;
    v_org_id := OLD.organization_id;
  ELSE
    v_target_user_id := COALESCE(OLD.user_id, NEW.user_id);
    v_org_id := OLD.organization_id;
  END IF;

  IF v_target_user_id IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

  SELECT owner_user_id INTO v_owner_user_id FROM public.organizations WHERE id = v_org_id;
  IF v_owner_user_id IS NULL OR v_owner_user_id <> v_target_user_id THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Cannot delete the workspace owner''s employee record. Transfer ownership first.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.is_active = false AND OLD.is_active = true THEN
    RAISE EXCEPTION 'Cannot deactivate the workspace owner''s employee record. Transfer ownership first.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'Cannot change the user link on the workspace owner''s employee record. Transfer ownership first.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_employee_ownership_integrity ON public.employees;
CREATE TRIGGER trg_enforce_employee_ownership_integrity
  BEFORE UPDATE OR DELETE ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.enforce_employee_ownership_integrity();

CREATE OR REPLACE FUNCTION public.enforce_user_role_owner_integrity()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_remaining_owners int;
  v_org_id uuid;
  v_was_owner boolean;
BEGIN
  v_org_id := OLD.organization_id;
  v_was_owner := (OLD.role = 'owner' AND OLD.is_active = true);

  IF TG_OP = 'UPDATE' THEN
    IF NEW.role = 'owner' AND NEW.is_active = true THEN RETURN NEW; END IF;
  END IF;

  IF NOT v_was_owner THEN RETURN COALESCE(NEW, OLD); END IF;

  SELECT COUNT(*) INTO v_remaining_owners
    FROM public.user_roles
   WHERE organization_id = v_org_id AND role = 'owner' AND is_active = true
     AND user_id <> OLD.user_id;

  IF v_remaining_owners = 0 THEN
    RAISE EXCEPTION 'Cannot remove, deactivate, or demote the last active owner of this workspace. Assign another owner first.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_user_role_owner_integrity ON public.user_roles;
CREATE TRIGGER trg_enforce_user_role_owner_integrity
  BEFORE UPDATE OR DELETE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_user_role_owner_integrity();

CREATE OR REPLACE FUNCTION public.prevent_employee_self_privilege_escalation()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_is_admin boolean;
BEGIN
  IF v_caller IS NULL OR OLD.user_id IS NULL OR OLD.user_id <> v_caller THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE organization_id = OLD.organization_id
       AND user_id = v_caller AND is_active = true
       AND role IN ('owner','admin','super_admin')
  ) INTO v_is_admin;

  IF v_is_admin THEN RETURN NEW; END IF;

  IF NEW.is_active        IS DISTINCT FROM OLD.is_active        OR
     NEW.user_id          IS DISTINCT FROM OLD.user_id          OR
     NEW.organization_id  IS DISTINCT FROM OLD.organization_id  OR
     NEW.business_id      IS DISTINCT FROM OLD.business_id      OR
     NEW.employment_type  IS DISTINCT FROM OLD.employment_type  OR
     NEW.basic_salary     IS DISTINCT FROM OLD.basic_salary     OR
     NEW.employee_number  IS DISTINCT FROM OLD.employee_number  OR
     NEW.position         IS DISTINCT FROM OLD.position         OR
     NEW.hire_date        IS DISTINCT FROM OLD.hire_date THEN
    RAISE EXCEPTION 'You can only edit your profile details. Contact an HR admin to change employment fields.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_prevent_employee_self_privilege_escalation ON public.employees;
CREATE TRIGGER trg_prevent_employee_self_privilege_escalation
  BEFORE UPDATE ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.prevent_employee_self_privilege_escalation();

CREATE OR REPLACE FUNCTION public.link_self_as_employee()
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_org_id uuid;
  v_business_id uuid;
  v_email text;
  v_first text;
  v_last text;
  v_emp_number text;
  v_emp_id uuid;
  v_existing uuid;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;

  SELECT o.id INTO v_org_id
    FROM public.organizations o
    JOIN public.user_roles ur ON ur.organization_id = o.id
   WHERE ur.user_id = v_user AND ur.is_active = true
     AND ur.role IN ('owner','admin','super_admin')
   ORDER BY o.created_at ASC LIMIT 1;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Only workspace owners or admins can self-link as an employee.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT id INTO v_business_id
    FROM public.businesses
   WHERE organization_id = v_org_id AND is_active = true
   ORDER BY created_at ASC LIMIT 1;

  IF v_business_id IS NULL THEN
    RAISE EXCEPTION 'No active business found for this workspace.';
  END IF;

  SELECT id INTO v_existing FROM public.employees
   WHERE organization_id = v_org_id AND user_id = v_user LIMIT 1;
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  SELECT email INTO v_email FROM auth.users WHERE id = v_user;
  SELECT
    COALESCE(NULLIF(split_part(p.full_name, ' ', 1), ''), 'Owner'),
    NULLIF(regexp_replace(COALESCE(p.full_name, ''), '^\S+\s*', ''), '')
    INTO v_first, v_last
  FROM public.profiles p WHERE p.user_id = v_user;

  v_first := COALESCE(v_first, 'Owner');
  SELECT public.get_next_employee_number(v_org_id, v_business_id) INTO v_emp_number;

  INSERT INTO public.employees (
    organization_id, business_id, employee_number,
    first_name, last_name, email, user_id,
    position, hire_date, employment_type, is_active
  ) VALUES (
    v_org_id, v_business_id, COALESCE(v_emp_number, 'EMP-0001'),
    v_first, v_last, v_email, v_user,
    'Owner / Founder', CURRENT_DATE, 'full_time', true
  ) RETURNING id INTO v_emp_id;

  UPDATE public.onboarding_suggestions
     SET status = 'accepted', resolved_at = now(), resolved_by = v_user
   WHERE organization_id = v_org_id AND kind = 'link_owner_as_employee';

  RETURN v_emp_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.link_self_as_employee() TO authenticated;
