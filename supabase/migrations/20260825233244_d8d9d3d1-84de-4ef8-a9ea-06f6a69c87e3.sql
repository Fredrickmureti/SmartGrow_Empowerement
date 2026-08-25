CREATE OR REPLACE FUNCTION public._project_milestone_lifecycle_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  -- Set to 'on' (transaction-local) by the milestone lifecycle / billing RPCs.
  v_privileged boolean := COALESCE(current_setting('app.project_milestone_privileged', true), 'off') = 'on';
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT v_privileged AND (COALESCE(NEW.is_reached, false) OR COALESCE(NEW.is_invoiced, false)) THEN
      RAISE EXCEPTION 'milestone_lifecycle_requires_rpc' USING ERRCODE = '42501',
        HINT = 'Create the milestone open, then call complete_project_milestone.';
    END IF;
    RETURN NEW;
  END IF;

  IF v_privileged THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.is_reached, false) IS DISTINCT FROM COALESCE(OLD.is_reached, false)
     OR NEW.reached_at IS DISTINCT FROM OLD.reached_at THEN
    RAISE EXCEPTION 'milestone_completion_requires_rpc' USING ERRCODE = '42501',
      HINT = 'Call complete_project_milestone(milestone_id, reached).';
  END IF;

  IF COALESCE(NEW.is_invoiced, false) IS DISTINCT FROM COALESCE(OLD.is_invoiced, false)
     OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN
    RAISE EXCEPTION 'milestone_billing_requires_rpc' USING ERRCODE = '42501',
      HINT = 'Call invoice_project_milestone(milestone_id).';
  END IF;

  IF COALESCE(OLD.is_invoiced, false)
     AND NEW.billing_amount IS DISTINCT FROM OLD.billing_amount THEN
    RAISE EXCEPTION 'milestone_already_invoiced' USING ERRCODE = '42501',
      HINT = 'Credit the invoice instead of changing the billed amount.';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_project_milestones_lifecycle_guard ON public.project_milestones;
CREATE TRIGGER trg_project_milestones_lifecycle_guard
BEFORE INSERT OR UPDATE ON public.project_milestones
FOR EACH ROW EXECUTE FUNCTION public._project_milestone_lifecycle_guard();