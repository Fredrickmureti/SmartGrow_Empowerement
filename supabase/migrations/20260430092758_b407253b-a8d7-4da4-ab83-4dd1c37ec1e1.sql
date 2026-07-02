
-- 1. Backfill: for any enabled rule with `recipient_type = 'internal'` and
-- zero recipients, add a default admin-role recipient marked as fallback so
-- internal alerts (low_stock_alert, out_of_stock, etc.) have a reachable
-- target out of the box.
INSERT INTO public.sms_event_rule_recipients (rule_id, recipient_kind, role, is_fallback)
SELECT sr.id, 'role', 'admin'::app_role, true
FROM public.sms_event_rules sr
LEFT JOIN public.sms_event_rule_recipients srr ON srr.rule_id = sr.id
WHERE sr.is_enabled = true
  AND sr.recipient_type = 'internal'
GROUP BY sr.id
HAVING count(srr.id) = 0;

-- 2. Reset stuck outbox rows so the dispatcher retries them now that
-- service-role auth at send-sms is fixed.
UPDATE public.sms_event_outbox
SET status = 'queued',
    attempts = 0,
    last_error = NULL,
    next_attempt_at = now()
WHERE status IN ('processing', 'failed')
   OR (status = 'queued' AND last_error = 'Invalid token');
