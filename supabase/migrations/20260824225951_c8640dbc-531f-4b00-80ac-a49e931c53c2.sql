ALTER TABLE public.crm_activities
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION public._crm_activity_branch_from_lead()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_branch uuid;
  v_business uuid;
BEGIN
  SELECT l.branch_id, l.business_id INTO v_branch, v_business
    FROM public.crm_leads l WHERE l.id = NEW.lead_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CRM: activity references unknown lead %', NEW.lead_id USING ERRCODE = '23503';
  END IF;

  IF NEW.business_id IS DISTINCT FROM v_business THEN
    RAISE EXCEPTION 'CRM: activity business % does not match lead business %', NEW.business_id, v_business
      USING ERRCODE = '23514';
  END IF;

  NEW.branch_id := v_branch;
  RETURN NEW;
END;
$function$;

UPDATE public.crm_activities a
   SET branch_id = l.branch_id
  FROM public.crm_leads l
 WHERE l.id = a.lead_id AND a.branch_id IS DISTINCT FROM l.branch_id;

CREATE INDEX IF NOT EXISTS idx_crm_activities_branch ON public.crm_activities (business_id, branch_id);

DROP TRIGGER IF EXISTS crm_activities_branch_from_lead ON public.crm_activities;
CREATE TRIGGER crm_activities_branch_from_lead
  BEFORE INSERT OR UPDATE OF lead_id, branch_id, business_id ON public.crm_activities
  FOR EACH ROW EXECUTE FUNCTION public._crm_activity_branch_from_lead();