CREATE OR REPLACE FUNCTION public._crm_lead_history_record()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_reason text := nullif(btrim(coalesce(current_setting('app.crm_lead_reason', true), '')), '');
  v_events text[] := ARRAY[]::text[];
  v_e text;
BEGIN
  IF OLD.is_active AND NOT NEW.is_active THEN
    v_events := array_append(v_events, 'archived');
  ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
    IF NEW.status = 'won' THEN
      v_events := array_append(v_events, 'won');
    ELSIF NEW.status = 'lost' THEN
      v_events := array_append(v_events, 'lost');
    ELSIF OLD.status IN ('won','lost') THEN
      v_events := array_append(v_events, 'reopened');
    ELSIF OLD.status = 'new' AND NEW.status = 'qualified' AND OLD.stage_id IS NOT DISTINCT FROM NEW.stage_id THEN
      v_events := array_append(v_events, 'qualified');
    ELSIF OLD.status = 'new' AND NEW.status = 'qualified' THEN
      v_events := array_append(v_events, 'stage_changed');
    ELSE
      v_events := array_append(v_events, 'stage_changed');
    END IF;
  ELSIF OLD.stage_id IS DISTINCT FROM NEW.stage_id THEN
    v_events := array_append(v_events, 'stage_changed');
  END IF;

  IF OLD.assigned_to IS DISTINCT FROM NEW.assigned_to THEN
    v_events := array_append(v_events, 'reassigned');
  END IF;
  IF coalesce(OLD.expected_revenue, 0) IS DISTINCT FROM coalesce(NEW.expected_revenue, 0) THEN
    v_events := array_append(v_events, 'revalued');
  END IF;

  IF array_length(v_events, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  FOREACH v_e IN ARRAY v_events LOOP
    INSERT INTO public.crm_lead_history (
      organization_id, business_id, lead_id, event,
      from_status, to_status, from_stage_id, to_stage_id,
      from_value, to_value, from_assignee, to_assignee,
      reason, metadata, actor_user_id, occurred_at)
    VALUES (
      NEW.organization_id, NEW.business_id, NEW.id, v_e,
      OLD.status, NEW.status, OLD.stage_id, NEW.stage_id,
      OLD.expected_revenue, NEW.expected_revenue, OLD.assigned_to, NEW.assigned_to,
      v_reason,
      jsonb_build_object(
        'type', NEW.type,
        'probability', NEW.probability,
        'is_active', NEW.is_active,
        'lost_reason_id', NEW.lost_reason_id,
        'expected_close_date', NEW.expected_close_date),
      auth.uid(), clock_timestamp());
  END LOOP;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS crm_leads_history_record ON public.crm_leads;
CREATE TRIGGER crm_leads_history_record
AFTER UPDATE ON public.crm_leads
FOR EACH ROW EXECUTE FUNCTION public._crm_lead_history_record();