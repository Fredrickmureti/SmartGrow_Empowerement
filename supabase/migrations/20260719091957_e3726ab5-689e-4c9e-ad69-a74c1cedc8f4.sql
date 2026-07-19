CREATE OR REPLACE FUNCTION public._pos_payment_session_emit(p_topic text, p_session pos_payment_sessions, p_payload jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path = public
AS $function$
BEGIN
  INSERT INTO public.business_event_outbox
    (org_id, branch_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key, actor_user_id, source)
  VALUES
    (p_session.organization_id, p_session.branch_id, p_topic,
     'pos_payment_session', p_session.id, p_payload,
     p_topic || ':' || p_session.id::text || ':' || COALESCE((p_payload->>'idempotency_key'), gen_random_uuid()::text),
     auth.uid(), 'pos');
END $function$;