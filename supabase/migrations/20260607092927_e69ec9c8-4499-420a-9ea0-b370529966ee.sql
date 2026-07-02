
-- 1) Server-authoritative linkage resolver --------------------------------
CREATE OR REPLACE FUNCTION public.resolve_my_employee()
RETURNS TABLE (
  employee_id uuid,
  organization_id uuid,
  business_id uuid,
  is_linked boolean,
  can_self_link boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org_id uuid;
  v_emp record;
  v_is_admin boolean := false;
  v_org_has_any_employee boolean := false;
BEGIN
  IF v_user IS NULL THEN
    RETURN;
  END IF;

  -- Resolve the user's active org (owner/admin first; otherwise any role)
  SELECT ur.organization_id
    INTO v_org_id
    FROM public.user_roles ur
   WHERE ur.user_id = v_user
     AND ur.is_active = true
   ORDER BY CASE ur.role
              WHEN 'super_admin' THEN 0
              WHEN 'owner' THEN 1
              WHEN 'admin' THEN 2
              ELSE 3
            END,
            ur.created_at ASC
   LIMIT 1;

  IF v_org_id IS NULL THEN
    RETURN;
  END IF;

  -- Resolve employee by (user_id, organization_id) — business scoping is
  -- intentionally NOT applied here; consumers can narrow client-side.
  SELECT e.id, e.organization_id, e.business_id
    INTO v_emp
    FROM public.employees e
   WHERE e.user_id = v_user
     AND e.organization_id = v_org_id
   LIMIT 1;

  -- Admin gate mirrors link_self_as_employee role check
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = v_user
       AND ur.organization_id = v_org_id
       AND ur.is_active = true
       AND ur.role IN ('owner','admin','super_admin')
  ) INTO v_is_admin;

  SELECT EXISTS (
    SELECT 1 FROM public.employees e
     WHERE e.organization_id = v_org_id
  ) INTO v_org_has_any_employee;

  employee_id     := v_emp.id;
  organization_id := COALESCE(v_emp.organization_id, v_org_id);
  business_id     := v_emp.business_id;
  is_linked       := v_emp.id IS NOT NULL;
  -- Only an admin/owner whose org has no employee at all may self-link.
  can_self_link   := v_is_admin AND NOT v_org_has_any_employee AND v_emp.id IS NULL;

  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_my_employee() TO authenticated;

-- 2) Onboarding parent auto-complete trigger -------------------------------
CREATE OR REPLACE FUNCTION public.employee_onboarding_autocomplete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total int;
  v_done int;
BEGIN
  IF NEW.employee_onboarding_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*), COUNT(*) FILTER (WHERE is_completed = true)
    INTO v_total, v_done
    FROM public.employee_onboarding_items
   WHERE employee_onboarding_id = NEW.employee_onboarding_id;

  IF v_total > 0 AND v_done = v_total THEN
    UPDATE public.employee_onboarding
       SET status = 'completed',
           completed_at = COALESCE(completed_at, now()),
           updated_at = now()
     WHERE id = NEW.employee_onboarding_id
       AND status IS DISTINCT FROM 'completed';
  ELSIF v_done < v_total AND v_total > 0 THEN
    -- If admin un-ticks an item, reopen the parent
    UPDATE public.employee_onboarding
       SET status = CASE WHEN status = 'completed' THEN 'in_progress' ELSE status END,
           completed_at = CASE WHEN status = 'completed' THEN NULL ELSE completed_at END,
           updated_at = now()
     WHERE id = NEW.employee_onboarding_id
       AND status = 'completed';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_employee_onboarding_autocomplete
  ON public.employee_onboarding_items;
CREATE TRIGGER trg_employee_onboarding_autocomplete
  AFTER UPDATE OF is_completed ON public.employee_onboarding_items
  FOR EACH ROW EXECUTE FUNCTION public.employee_onboarding_autocomplete();
