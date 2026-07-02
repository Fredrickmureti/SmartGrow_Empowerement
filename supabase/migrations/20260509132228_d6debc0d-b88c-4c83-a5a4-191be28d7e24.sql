-- Schedule daily generation of recurring project tasks at 02:15 UTC.
-- The edge function is idempotent on (recurrence_parent_id, scheduled_for).
SELECT cron.unschedule('generate-recurring-tasks-daily') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'generate-recurring-tasks-daily'
);

SELECT cron.schedule(
  'generate-recurring-tasks-daily',
  '15 2 * * *',
  $$
  SELECT net.http_post(
    url := 'https://jkszmrroyjfdwokbkzis.supabase.co/functions/v1/generate-recurring-tasks',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imprc3ptcnJveWpmZHdva2JremlzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4MzkwMzEsImV4cCI6MjA4MzQxNTAzMX0.iJjPAh8zaed1XbgKnRZp63JLNU37Z72CJPHlSnEPaQc"}'::jsonb,
    body := concat('{"time":"', now(), '"}')::jsonb
  );
  $$
);