
SELECT cron.schedule(
  'attendance-missed-checkout-15min',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://jkszmrroyjfdwokbkzis.supabase.co/functions/v1/attendance-missed-checkout',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imprc3ptcnJveWpmZHdva2JremlzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4MzkwMzEsImV4cCI6MjA4MzQxNTAzMX0.iJjPAh8zaed1XbgKnRZp63JLNU37Z72CJPHlSnEPaQc"}'::jsonb,
    body := concat('{"time":"', now(), '"}')::jsonb
  );
  $$
);
