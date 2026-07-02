
DROP VIEW IF EXISTS public.sms_webhook_health;

CREATE VIEW public.sms_webhook_health
WITH (security_invoker = true) AS
SELECT
  organization_id,
  business_id,
  MAX(CASE WHEN direction = 'inbound' THEN created_at END) AS last_inbound_at,
  MAX(CASE WHEN direction = 'outbound' AND status IN ('delivered','failed','undelivered') THEN created_at END) AS last_status_callback_at,
  COUNT(*) FILTER (WHERE direction = 'inbound' AND created_at > now() - interval '24 hours') AS inbound_24h,
  COUNT(*) FILTER (WHERE direction = 'outbound' AND created_at > now() - interval '24 hours') AS outbound_24h
FROM public.sms_log
GROUP BY organization_id, business_id;

GRANT SELECT ON public.sms_webhook_health TO authenticated;
