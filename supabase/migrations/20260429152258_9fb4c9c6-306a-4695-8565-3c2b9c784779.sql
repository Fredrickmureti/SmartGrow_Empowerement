
REVOKE ALL ON FUNCTION public.sms_event_rule_enabled(uuid, public.sms_event_type) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sms_enqueue_event(uuid, uuid, public.sms_event_type, text, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sms_event_rule_enabled(uuid, public.sms_event_type) TO service_role;
GRANT EXECUTE ON FUNCTION public.sms_enqueue_event(uuid, uuid, public.sms_event_type, text, uuid, uuid, jsonb) TO service_role;
