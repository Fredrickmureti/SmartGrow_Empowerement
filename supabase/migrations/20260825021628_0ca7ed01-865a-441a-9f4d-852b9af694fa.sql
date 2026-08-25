-- Default stage for new opportunities: a lead with no stage is invisible on the
-- kanban board, which is how an "orphan" lead can exist while the stat cards
-- still count it. Big-system behaviour (Odoo/HubSpot/Salesforce) is that a new
-- opportunity always enters the first open stage of the pipeline.
CREATE OR REPLACE FUNCTION public._crm_lead_default_stage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stage uuid;
BEGIN
  IF NEW.stage_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT s.id INTO v_stage
  FROM public.crm_stages s
  WHERE s.organization_id = NEW.organization_id
    AND coalesce(s.is_active, true) = true
    AND coalesce(s.is_won, false) = false
    AND coalesce(s.is_lost, false) = false
    AND (s.business_id IS NULL OR s.business_id = NEW.business_id)
    AND (s.branch_id IS NULL OR s.branch_id = NEW.branch_id)
  ORDER BY (s.business_id IS NOT NULL) DESC, (s.branch_id IS NOT NULL) DESC, s.sequence NULLS LAST, s.created_at
  LIMIT 1;

  NEW.stage_id := v_stage;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public._crm_lead_default_stage() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS crm_leads_default_stage ON public.crm_leads;
CREATE TRIGGER crm_leads_default_stage
BEFORE INSERT ON public.crm_leads
FOR EACH ROW EXECUTE FUNCTION public._crm_lead_default_stage();

-- Backfill: place existing stage-less active opportunities into the first open
-- stage. Runs as a governed writer so the lifecycle guard and history trigger
-- treat it as a system transition.
DO $$
DECLARE
  r record;
  v_stage uuid;
BEGIN
  PERFORM set_config('app.crm_lead_writer', '1', true);
  FOR r IN
    SELECT id, organization_id, business_id, branch_id
    FROM public.crm_leads
    WHERE stage_id IS NULL
      AND coalesce(is_active, true) = true
      AND status NOT IN ('won','lost')
  LOOP
    SELECT s.id INTO v_stage
    FROM public.crm_stages s
    WHERE s.organization_id = r.organization_id
      AND coalesce(s.is_active, true) = true
      AND coalesce(s.is_won, false) = false
      AND coalesce(s.is_lost, false) = false
      AND (s.business_id IS NULL OR s.business_id = r.business_id)
      AND (s.branch_id IS NULL OR s.branch_id = r.branch_id)
    ORDER BY (s.business_id IS NOT NULL) DESC, (s.branch_id IS NOT NULL) DESC, s.sequence NULLS LAST, s.created_at
    LIMIT 1;

    IF v_stage IS NOT NULL THEN
      UPDATE public.crm_leads SET stage_id = v_stage WHERE id = r.id;
    END IF;
  END LOOP;
  PERFORM set_config('app.crm_lead_writer', '', true);
END $$;