
CREATE OR REPLACE FUNCTION public._organization_invitation_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_owner  uuid;
BEGIN
  -- Only validate live (unaccepted) invitations for internal staff.
  IF NEW.accepted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.user_type, 'internal') <> 'internal' THEN
    RETURN NEW;
  END IF;

  -- Administrator invitations may only be issued by the recorded owner.
  IF NEW.role IN ('admin'::public.app_role, 'owner'::public.app_role) AND v_caller IS NOT NULL THEN
    SELECT o.owner_user_id INTO v_owner
      FROM public.organizations o
     WHERE o.id = NEW.organization_id;
    IF v_owner IS DISTINCT FROM v_caller THEN
      RAISE EXCEPTION 'Only the institution owner can invite an administrator.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Every other staff invitation must carry at least one access group,
  -- otherwise the accepted account would have no effective permissions.
  IF NEW.role NOT IN ('admin'::public.app_role, 'owner'::public.app_role) THEN
    IF NEW.permission_group_ids IS NULL
       OR array_length(NEW.permission_group_ids, 1) IS NULL THEN
      RAISE EXCEPTION 'Select at least one access group for this invitation.'
        USING ERRCODE = '22023';
    END IF;

    IF NEW.branch_scope IN ('assigned'::public.branch_scope_mode,
                            'own_portfolio'::public.branch_scope_mode)
       AND (NEW.branch_ids IS NULL OR array_length(NEW.branch_ids, 1) IS NULL) THEN
      RAISE EXCEPTION 'Select at least one branch for this invitation.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS organization_invitations_guard ON public.organization_invitations;
CREATE TRIGGER organization_invitations_guard
BEFORE INSERT OR UPDATE ON public.organization_invitations
FOR EACH ROW EXECUTE FUNCTION public._organization_invitation_guard();
