CREATE OR REPLACE FUNCTION public._crm_emit_lead_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
      'business_id',    NEW.business_id,
      'branch_id',      NEW.branch_id,
      'from_branch_id', NEW.from_branch_id,
      'to_branch_id',   NEW.to_branch_id,
      'event',          NEW.event,
      'from_status',    NEW.from_status,
      'to_status',      NEW.to_status,
      'from_stage_id',  NEW.from_stage_id,
      'to_stage_id',    NEW.to_stage_id,
      'from_value',     NEW.from_value,
      'to_value',       NEW.to_value,
      'from_assignee',  NEW.from_assignee,
      'to_assignee',    NEW.to_assignee,
      'reason',         NEW.reason,
      'metadata',       NEW.metadata),
    'crm.lead:' || NEW.lead_id::text || ':' || NEW.event || ':'
      || extract(epoch from NEW.occurred_at)::text,
    NEW.actor_user_id,
    'crm',
    'server')
  ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN NEW;
END;
$$;

INSERT INTO public.business_event_topics (topic_prefix, producer_domain, consumer_domains, handler_scope, description)
VALUES ('crm.lead.branch_transferred', 'crm', '{}', 'server', 'Opportunity transferred to another branch')
ON CONFLICT (topic_prefix) DO NOTHING;