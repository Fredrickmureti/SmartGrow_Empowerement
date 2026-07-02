
CREATE OR REPLACE FUNCTION public.enforce_user_role_owner_integrity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_remaining_owners int;
  v_org_id uuid;
  v_was_owner boolean;
BEGIN
  v_org_id := OLD.organization_id;

  -- Governance plane (ADR-0019): allow platform_delete_organization /
  -- reset_organization_data to cascade through this trigger.
  IF public._is_teardown_for_org(v_org_id) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

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

  -- Governance plane bypass (ADR-0019).
  IF public._is_teardown_for_org(v_org_id) THEN
    RETURN COALESCE(NEW, OLD);
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
