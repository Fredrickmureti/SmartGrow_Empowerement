-- Fix: prevent_last_business_removal must not block business cascades
-- triggered by deleting the parent organization itself.
--
-- Strategy: if the organization row no longer exists at the moment the
-- trigger runs (i.e. it was deleted earlier in the same statement /
-- transaction via ON DELETE CASCADE), skip the "last active business"
-- guard. The guard only makes sense while the workspace still exists.

CREATE OR REPLACE FUNCTION public.prevent_last_business_removal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  remaining_count integer;
  v_org_id uuid;
  v_org_exists boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_org_id := OLD.organization_id;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Only fire when transitioning from active -> inactive/archived
    IF (COALESCE(OLD.is_active, true) = true)
       AND (
         COALESCE(NEW.is_active, true) = false
         OR (NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL)
       )
    THEN
      v_org_id := OLD.organization_id;
    ELSE
      RETURN NEW;
    END IF;
  END IF;

  -- If the parent organization is gone (cascade-delete from organizations),
  -- the workspace itself is being torn down. Don't block the cascade.
  SELECT EXISTS (
    SELECT 1 FROM public.organizations WHERE id = v_org_id
  ) INTO v_org_exists;

  IF NOT v_org_exists THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    ELSE
      RETURN NEW;
    END IF;
  END IF;

  -- Count OTHER active, non-archived businesses in this workspace
  SELECT COUNT(*) INTO remaining_count
    FROM public.businesses
   WHERE organization_id = v_org_id
     AND id <> COALESCE(OLD.id, NEW.id)
     AND COALESCE(is_active, true) = true
     AND archived_at IS NULL;

  IF remaining_count = 0 THEN
    RAISE EXCEPTION
      'A workspace must always have at least one active company. Create another company before removing this one.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$;