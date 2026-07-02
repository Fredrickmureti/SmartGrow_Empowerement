
SELECT cron.schedule(
  'notify-tasks-due-soon-hourly',
  '15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://jkszmrroyjfdwokbkzis.supabase.co/functions/v1/notify-tasks-due-soon',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imprc3ptcnJveWpmZHdva2JremlzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4MzkwMzEsImV4cCI6MjA4MzQxNTAzMX0.iJjPAh8zaed1XbgKnRZp63JLNU37Z72CJPHlSnEPaQc"}'::jsonb,
    body := concat('{"time":"', now(), '"}')::jsonb
  );
  $$
);
