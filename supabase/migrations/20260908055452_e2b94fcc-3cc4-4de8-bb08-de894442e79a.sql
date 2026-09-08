CREATE OR REPLACE FUNCTION public.tg_protect_organization_owner_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_owner uuid;
  v_row public.user_roles;
BEGIN
  v_row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;

  SELECT o.owner_user_id INTO v_owner
    FROM public.organizations o
   WHERE o.id = COALESCE(OLD.organization_id, v_row.organization_id);

  IF v_owner IS NULL OR OLD.user_id IS DISTINCT FROM v_owner THEN
    RETURN v_row;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Cannot remove the organization owner''s membership. Transfer ownership first.'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.is_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Cannot deactivate the organization owner. Transfer ownership first.'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.role IS DISTINCT FROM 'owner'::public.app_role THEN
    RAISE EXCEPTION 'Cannot change the organization owner''s role. Transfer ownership first.'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'Cannot reassign the organization owner''s membership row.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS protect_organization_owner_role ON public.user_roles;
CREATE TRIGGER protect_organization_owner_role
BEFORE UPDATE OR DELETE ON public.user_roles
FOR EACH ROW EXECUTE FUNCTION public.tg_protect_organization_owner_role();