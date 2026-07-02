-- Allow reset_my_workspace (and other org-deletion paths) to bypass the
-- owner-immutability trigger when the entire organization is being torn down.
-- Without this, ON DELETE CASCADE from organizations -> user_roles trips the
-- "Cannot remove the last active owner" guard.

CREATE OR REPLACE FUNCTION public.enforce_owner_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_protected_owner uuid;
  v_active_owner_count int;
  v_caller uuid := auth.uid();
BEGIN
  -- Bypass for platform admin, ownership transfer RPC, or full workspace reset.
  IF public.is_platform_admin(v_caller)
     OR current_setting('app.allow_owner_transfer', true) = 'on'
     OR current_setting('app.reset_in_progress', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT owner_user_id INTO v_protected_owner
  FROM public.organizations
  WHERE id = COALESCE(NEW.organization_id, OLD.organization_id);

  -- If the organization no longer exists, this is a cascade from org DELETE — allow it.
  IF v_protected_owner IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP IN ('UPDATE','DELETE') THEN
    IF OLD.user_id = v_protected_owner AND OLD.role = 'owner' THEN
      RAISE EXCEPTION 'The organization owner cannot be modified. Use Transfer Ownership instead.';
    END IF;

    IF OLD.user_id = v_caller AND TG_OP = 'UPDATE' THEN
      IF NEW.role IS DISTINCT FROM OLD.role
         OR NEW.is_active IS DISTINCT FROM OLD.is_active THEN
        RAISE EXCEPTION 'You cannot change your own role or active status.';
      END IF;
    END IF;

    IF OLD.role = 'owner'
       AND OLD.is_active = true
       AND (TG_OP = 'DELETE'
            OR NEW.is_active = false
            OR NEW.role <> 'owner') THEN
      SELECT COUNT(*) INTO v_active_owner_count
      FROM public.user_roles
      WHERE organization_id = OLD.organization_id
        AND role = 'owner'
        AND is_active = true
        AND id <> OLD.id;
      IF v_active_owner_count = 0 THEN
        RAISE EXCEPTION 'Cannot remove the last active owner of the organization.';
      END IF;
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

-- Update reset_my_workspace to set the bypass flag for the duration of the txn.
CREATE OR REPLACE FUNCTION public.reset_my_workspace(org_id uuid, confirmation_phrase text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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

  -- Bypass owner-immutability trigger for the cascade tear-down of this txn.
  PERFORM set_config('app.reset_in_progress', 'on', true);

  DELETE FROM public.organizations WHERE id = org_id;

  RETURN jsonb_build_object(
    'success', true,
    'workspace_name', org_name,
    'message', 'Workspace and all associated data deleted. Sign out and sign up again to start fresh.'
  );
END;
$function$;