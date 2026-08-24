CREATE OR REPLACE FUNCTION public._crm_lead_assignee_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.assigned_to IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.assigned_to IS NOT DISTINCT FROM NEW.assigned_to
     AND OLD.organization_id IS NOT DISTINCT FROM NEW.organization_id THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.user_id = NEW.assigned_to
      AND ur.organization_id = NEW.organization_id
      AND COALESCE(ur.is_active, true)
  ) THEN
    RAISE EXCEPTION 'Assignee % is not an active member of this organization', NEW.assigned_to
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS crm_leads_assignee_guard ON public.crm_leads;
CREATE TRIGGER crm_leads_assignee_guard
  BEFORE INSERT OR UPDATE OF assigned_to, organization_id ON public.crm_leads
  FOR EACH ROW EXECUTE FUNCTION public._crm_lead_assignee_guard();

REVOKE ALL ON FUNCTION public._crm_lead_assignee_guard() FROM PUBLIC, anon, authenticated;