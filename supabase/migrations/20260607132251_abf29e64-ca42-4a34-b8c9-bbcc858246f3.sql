
-- ============================================================================
-- 1. Resolver rewrite: employee record is the source of truth
-- ============================================================================
CREATE OR REPLACE FUNCTION public.resolve_my_employee()
RETURNS TABLE(employee_id uuid, organization_id uuid, business_id uuid, is_linked boolean, can_self_link boolean)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_emp record;
  v_org_id uuid;
  v_last uuid;
  v_is_admin boolean := false;
  v_org_has_any_employee boolean := false;
BEGIN
  IF v_user IS NULL THEN RETURN; END IF;

  -- STEP 1: Employee record is the source of truth for "linked".
  -- We do NOT require a user_roles row here; the auto-membership trigger
  -- keeps user_roles in sync, but a missing/inactive row must never make
  -- a real employee linkage disappear.
  BEGIN
    SELECT e.id, e.organization_id, e.business_id
      INTO v_emp
      FROM public.employees e
     WHERE e.user_id = v_user
       AND e.is_active = true
     ORDER BY e.hire_date DESC NULLS LAST, e.created_at DESC
     LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_emp := NULL;
  END;

  IF v_emp.id IS NOT NULL THEN
    employee_id     := v_emp.id;
    organization_id := v_emp.organization_id;
    business_id     := v_emp.business_id;
    is_linked       := true;
    can_self_link   := false;
    RETURN NEXT;
    RETURN;
  END IF;

  -- STEP 2: Unlinked user. Compute can_self_link from membership.
  BEGIN
    SELECT last_org_id INTO v_last FROM public.profiles WHERE user_id = v_user LIMIT 1;
  EXCEPTION WHEN OTHERS THEN v_last := NULL;
  END;

  BEGIN
    IF v_last IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.user_roles
       WHERE user_id = v_user AND organization_id = v_last AND is_active = true
    ) THEN
      v_org_id := v_last;
    ELSE
      SELECT ur.organization_id INTO v_org_id
        FROM public.user_roles ur
       WHERE ur.user_id = v_user AND ur.is_active = true
       ORDER BY CASE ur.role::text
                  WHEN 'super_admin' THEN 0
                  WHEN 'owner' THEN 1
                  WHEN 'admin' THEN 2
                  ELSE 3
                END, ur.created_at ASC
       LIMIT 1;
    END IF;
  EXCEPTION WHEN OTHERS THEN v_org_id := NULL;
  END;

  IF v_org_id IS NULL THEN RETURN; END IF;

  BEGIN
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles ur
       WHERE ur.user_id = v_user AND ur.organization_id = v_org_id
         AND ur.is_active = true AND ur.role IN ('owner','admin','super_admin')
    ) INTO v_is_admin;
    SELECT EXISTS (
      SELECT 1 FROM public.employees e WHERE e.organization_id = v_org_id
    ) INTO v_org_has_any_employee;
  EXCEPTION WHEN OTHERS THEN v_is_admin := false;
  END;

  employee_id     := NULL;
  organization_id := v_org_id;
  business_id     := NULL;
  is_linked       := false;
  can_self_link   := v_is_admin AND NOT v_org_has_any_employee;
  RETURN NEXT;
EXCEPTION WHEN OTHERS THEN RETURN;
END;
$function$;

-- ============================================================================
-- 2. Trigger: keep user_roles in sync with employees.user_id
-- ============================================================================
CREATE OR REPLACE FUNCTION public.employees_sync_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Only upsert when there is no active membership already. We never
  -- downgrade an existing privileged role; we only ensure SOME active
  -- membership exists so resolve_my_employee + permission helpers work.
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = NEW.user_id
       AND organization_id = NEW.organization_id
       AND is_active = true
  ) THEN
    -- Profiles is required by user_roles_profiles_fk. Create a stub if missing.
    INSERT INTO public.profiles (user_id)
    VALUES (NEW.user_id)
    ON CONFLICT (user_id) DO NOTHING;

    INSERT INTO public.user_roles (user_id, organization_id, role, user_type, is_active)
    VALUES (NEW.user_id, NEW.organization_id, 'portal'::public.app_role, 'portal', true)
    ON CONFLICT (user_id, organization_id) DO UPDATE
      SET is_active = true,
          updated_at = now();
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS employees_sync_membership_aiu ON public.employees;
CREATE TRIGGER employees_sync_membership_aiu
  AFTER INSERT OR UPDATE OF user_id ON public.employees
  FOR EACH ROW
  WHEN (NEW.user_id IS NOT NULL)
  EXECUTE FUNCTION public.employees_sync_membership();

-- ============================================================================
-- 3. Trigger: enforce employees.business_id.organization_id = employees.organization_id
-- ============================================================================
CREATE OR REPLACE FUNCTION public.employees_check_business_org()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_biz_org uuid;
BEGIN
  IF NEW.business_id IS NULL OR NEW.organization_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT organization_id INTO v_biz_org FROM public.businesses WHERE id = NEW.business_id;
  IF v_biz_org IS NULL THEN
    RAISE EXCEPTION 'employees.business_id % does not exist', NEW.business_id;
  END IF;
  IF v_biz_org <> NEW.organization_id THEN
    RAISE EXCEPTION 'employees.business_id % belongs to organization %, not %',
      NEW.business_id, v_biz_org, NEW.organization_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS employees_check_business_org_biu ON public.employees;
CREATE TRIGGER employees_check_business_org_biu
  BEFORE INSERT OR UPDATE OF business_id, organization_id ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.employees_check_business_org();

-- ============================================================================
-- 4. Tighten link_employee_to_user and link_self_as_employee
-- ============================================================================
CREATE OR REPLACE FUNCTION public.link_employee_to_user(p_employee_id uuid, p_user_id uuid, p_force boolean DEFAULT false)
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
  v_caller_admin boolean;
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
  -- Trigger employees_sync_membership_aiu now ensures user_roles is in sync.

  PERFORM set_config('app.identity_change_source','', true);
  PERFORM set_config('app.identity_change_reason','', true);

  was_changed := true; employee_id := p_employee_id; RETURN NEXT;
END;
$function$;

-- link_self_as_employee: trigger will create user_roles, but the function
-- already runs the membership upsert via that path. Keep behavior identical
-- aside from the trigger handling membership.

-- ============================================================================
-- 5. Backfill: linked employees with no active membership
-- ============================================================================
INSERT INTO public.profiles (user_id)
SELECT DISTINCT e.user_id
  FROM public.employees e
  LEFT JOIN public.profiles p ON p.user_id = e.user_id
 WHERE e.user_id IS NOT NULL AND p.user_id IS NULL
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO public.user_roles (user_id, organization_id, role, user_type, is_active)
SELECT DISTINCT e.user_id, e.organization_id, 'portal'::public.app_role, 'portal', true
  FROM public.employees e
 WHERE e.user_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = e.user_id
        AND ur.organization_id = e.organization_id
        AND ur.is_active = true
   )
ON CONFLICT (user_id, organization_id) DO UPDATE
  SET is_active = true,
      updated_at = now();

-- ============================================================================
-- 6. Invariants view (CI-monitored)
-- ============================================================================
CREATE OR REPLACE VIEW public.v_identity_invariants_violations
WITH (security_invoker = true) AS
  SELECT
    'linked_employee_missing_active_membership'::text AS violation,
    e.id AS employee_id,
    e.user_id,
    e.organization_id,
    e.business_id
  FROM public.employees e
  WHERE e.user_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.user_roles ur
       WHERE ur.user_id = e.user_id
         AND ur.organization_id = e.organization_id
         AND ur.is_active = true
    )
  UNION ALL
  SELECT
    'employee_business_org_mismatch'::text,
    e.id, e.user_id, e.organization_id, e.business_id
  FROM public.employees e
  JOIN public.businesses b ON b.id = e.business_id
  WHERE b.organization_id <> e.organization_id
  UNION ALL
  SELECT
    'multiple_employees_for_one_user_in_org'::text,
    e.id, e.user_id, e.organization_id, e.business_id
  FROM public.employees e
  WHERE e.user_id IS NOT NULL
    AND (
      SELECT count(*) FROM public.employees e2
       WHERE e2.user_id = e.user_id AND e2.organization_id = e.organization_id
    ) > 1;

GRANT SELECT ON public.v_identity_invariants_violations TO authenticated;
GRANT SELECT ON public.v_identity_invariants_violations TO service_role;
