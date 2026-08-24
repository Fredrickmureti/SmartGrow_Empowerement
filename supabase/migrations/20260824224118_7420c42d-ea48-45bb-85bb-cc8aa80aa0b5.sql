CREATE OR REPLACE FUNCTION public._crm_emit_lead_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.business_event_outbox (
    org_id, event_type, source_doc_type, source_doc_id, payload,
    idempotency_key, actor_user_id, source, handler_scope)
  VALUES (
    NEW.organization_id,
    'crm.lead.' || NEW.event,
    'crm_lead',
    NEW.lead_id,
    jsonb_build_object(
      'business_id',   NEW.business_id,
      'event',         NEW.event,
      'from_status',   NEW.from_status,
      'to_status',     NEW.to_status,
      'from_stage_id', NEW.from_stage_id,
      'to_stage_id',   NEW.to_stage_id,
      'from_value',    NEW.from_value,
      'to_value',      NEW.to_value,
      'from_assignee', NEW.from_assignee,
      'to_assignee',   NEW.to_assignee,
      'reason',        NEW.reason,
      'metadata',      NEW.metadata),
    'crm.lead:' || NEW.lead_id::text || ':' || NEW.event || ':'
      || extract(epoch from NEW.occurred_at)::text,
    NEW.actor_user_id,
    'crm',
    'server')
  ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS crm_lead_history_emit_event ON public.crm_lead_history;
CREATE TRIGGER crm_lead_history_emit_event
AFTER INSERT ON public.crm_lead_history
FOR EACH ROW EXECUTE FUNCTION public._crm_emit_lead_event();