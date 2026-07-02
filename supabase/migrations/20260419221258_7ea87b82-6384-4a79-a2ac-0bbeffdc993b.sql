-- Phase D: Schema tightening + Phase E: reset_my_workspace RPC

ALTER TABLE public.businesses
  ALTER COLUMN base_currency SET DEFAULT 'USD';

UPDATE public.businesses SET base_currency = 'USD' WHERE base_currency IS NULL;
UPDATE public.businesses SET country = 'US' WHERE country IS NULL;

ALTER TABLE public.businesses
  ALTER COLUMN base_currency SET NOT NULL,
  ALTER COLUMN country SET NOT NULL;

-- Trigger: every active business must have at least one active branch.
CREATE OR REPLACE FUNCTION public.enforce_business_has_active_branch()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  remaining_active INTEGER;
  biz_active BOOLEAN;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    SELECT is_active INTO biz_active FROM public.businesses WHERE id = OLD.business_id;
    IF biz_active IS NOT TRUE THEN RETURN OLD; END IF;
    SELECT COUNT(*) INTO remaining_active FROM public.branches
     WHERE business_id = OLD.business_id AND is_active = true AND id <> OLD.id;
    IF remaining_active = 0 THEN
      RAISE EXCEPTION 'Cannot remove the last active branch of an active company (business_id=%).', OLD.business_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF (TG_OP = 'UPDATE') AND OLD.is_active = true AND NEW.is_active = false THEN
    SELECT is_active INTO biz_active FROM public.businesses WHERE id = NEW.business_id;
    IF biz_active IS NOT TRUE THEN RETURN NEW; END IF;
    SELECT COUNT(*) INTO remaining_active FROM public.branches
     WHERE business_id = NEW.business_id AND is_active = true AND id <> NEW.id;
    IF remaining_active = 0 THEN
      RAISE EXCEPTION 'Cannot deactivate the last active branch of an active company (business_id=%).', NEW.business_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_business_has_active_branch ON public.branches;
CREATE TRIGGER trg_enforce_business_has_active_branch
  BEFORE UPDATE OR DELETE ON public.branches
  FOR EACH ROW EXECUTE FUNCTION public.enforce_business_has_active_branch();

-- reset_my_workspace(): owner-only nuclear reset of caller's workspace.
CREATE OR REPLACE FUNCTION public.reset_my_workspace(
  org_id UUID,
  confirmation_phrase TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller_id UUID := auth.uid();
  caller_role TEXT;
  org_name TEXT;
  org_slug TEXT;
BEGIN
  IF caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT ur.role::TEXT INTO caller_role
    FROM public.user_roles ur
   WHERE ur.user_id = caller_id
     AND ur.organization_id = org_id
     AND ur.is_active = true
   LIMIT 1;

  IF caller_role IS NULL OR caller_role NOT IN ('owner','super_admin') THEN
    RAISE EXCEPTION 'Only the workspace owner can reset the workspace' USING ERRCODE = '42501';
  END IF;

  SELECT name, slug INTO org_name, org_slug FROM public.organizations WHERE id = org_id;
  IF org_name IS NULL THEN
    RAISE EXCEPTION 'Workspace not found' USING ERRCODE = 'P0002';
  END IF;

  IF confirmation_phrase IS DISTINCT FROM org_name THEN
    RAISE EXCEPTION 'Confirmation phrase must exactly match the workspace name "%"', org_name
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.admin_audit_log (action_type, admin_user_id, target_org_id, target_entity_type, target_entity_id, details)
  VALUES (
    'workspace_reset', caller_id, org_id, 'organization', org_id,
    jsonb_build_object('workspace_name', org_name, 'workspace_slug', org_slug, 'reset_at', now())
  );

  DELETE FROM public.organizations WHERE id = org_id;

  RETURN jsonb_build_object(
    'success', true,
    'workspace_name', org_name,
    'message', 'Workspace and all associated data deleted. Sign out and sign up again to start fresh.'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reset_my_workspace(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reset_my_workspace(UUID, TEXT) TO authenticated;

COMMENT ON FUNCTION public.reset_my_workspace(UUID, TEXT) IS
'Owner-only nuclear reset: deletes the entire workspace and every cascading record. Audited.';