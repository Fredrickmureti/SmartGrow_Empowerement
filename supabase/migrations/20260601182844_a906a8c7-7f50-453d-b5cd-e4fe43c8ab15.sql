-- Keep the workspace (organization) name and its headquarters (primary/first-created)
-- business name in sync, in both directions. The HQ business is defined as the
-- earliest-created business in the organization (the one created during onboarding).

-- 1) When the HQ business is renamed, update the workspace name to match.
CREATE OR REPLACE FUNCTION public.sync_org_name_from_primary_business()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_primary_business_id uuid;
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    SELECT id INTO v_primary_business_id
      FROM public.businesses
     WHERE organization_id = NEW.organization_id
     ORDER BY created_at ASC
     LIMIT 1;

    -- Only the HQ/primary business drives the workspace name.
    IF v_primary_business_id = NEW.id THEN
      UPDATE public.organizations
         SET name = NEW.name
       WHERE id = NEW.organization_id
         AND name IS DISTINCT FROM NEW.name;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- 2) When the workspace is renamed, update the HQ business name to match.
CREATE OR REPLACE FUNCTION public.sync_primary_business_name_from_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_primary_business_id uuid;
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    SELECT id INTO v_primary_business_id
      FROM public.businesses
     WHERE organization_id = NEW.id
     ORDER BY created_at ASC
     LIMIT 1;

    IF v_primary_business_id IS NOT NULL THEN
      UPDATE public.businesses
         SET name = NEW.name
       WHERE id = v_primary_business_id
         AND name IS DISTINCT FROM NEW.name;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_org_name_from_primary_business ON public.businesses;
CREATE TRIGGER trg_sync_org_name_from_primary_business
AFTER UPDATE OF name ON public.businesses
FOR EACH ROW
EXECUTE FUNCTION public.sync_org_name_from_primary_business();

DROP TRIGGER IF EXISTS trg_sync_primary_business_name_from_org ON public.organizations;
CREATE TRIGGER trg_sync_primary_business_name_from_org
AFTER UPDATE OF name ON public.organizations
FOR EACH ROW
EXECUTE FUNCTION public.sync_primary_business_name_from_org();

-- 3) Backfill: align every workspace name with its HQ business name so existing
--    mismatches (e.g. workspace "Finance" vs business "FINATIQ MOTORS WORLD")
--    are corrected. The HQ business is the source of truth here because users
--    actively rename their company in business settings.
UPDATE public.organizations o
   SET name = hq.name
  FROM (
    SELECT DISTINCT ON (organization_id)
           organization_id, name
      FROM public.businesses
     ORDER BY organization_id, created_at ASC
  ) hq
 WHERE hq.organization_id = o.id
   AND o.name IS DISTINCT FROM hq.name;