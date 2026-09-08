REVOKE ALL ON FUNCTION public.tg_protect_organization_owner_role() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.tg_sync_organization_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.owner_user_id IS NULL THEN
    RAISE EXCEPTION 'An organization must always have an owner.' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.owner_user_id IS NOT DISTINCT FROM OLD.owner_user_id THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.organization_id = NEW.id
       AND ur.user_id = NEW.owner_user_id
       AND ur.is_active = true
  ) THEN
    RAISE EXCEPTION 'The new owner must already be an active member of this organization.'
      USING ERRCODE = '42501';
  END IF;

  -- Step the outgoing owner down first so the single-owner index never trips.
  IF TG_OP = 'UPDATE' AND OLD.owner_user_id IS NOT NULL THEN
    UPDATE public.user_roles
       SET role = 'internal'::public.app_role, updated_at = now()
     WHERE organization_id = NEW.id
       AND user_id = OLD.owner_user_id
       AND role = 'owner'::public.app_role;
  END IF;

  UPDATE public.user_roles
     SET role = 'owner'::public.app_role, is_active = true, updated_at = now()
   WHERE organization_id = NEW.id
     AND user_id = NEW.owner_user_id
     AND role IS DISTINCT FROM 'owner'::public.app_role;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_sync_organization_owner() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sync_organization_owner ON public.organizations;
CREATE TRIGGER sync_organization_owner
AFTER INSERT OR UPDATE OF owner_user_id ON public.organizations
FOR EACH ROW EXECUTE FUNCTION public.tg_sync_organization_owner();