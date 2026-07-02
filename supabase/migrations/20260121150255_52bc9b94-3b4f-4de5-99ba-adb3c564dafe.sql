-- Schedule recurring invoice processing daily at 6 AM UTC
SELECT cron.schedule(
  'process-recurring-invoices-daily',
  '0 6 * * *',
  $$SELECT net.http_post(
    url:='https://jkszmrroyjfdwokbkzis.supabase.co/functions/v1/process-recurring-invoices',
    headers:='{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imprc3ptcnJveWpmZHdva2JremlzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4MzkwMzEsImV4cCI6MjA4MzQxNTAzMX0.iJjPAh8zaed1XbgKnRZp63JLNU37Z72CJPHlSnEPaQc"}'::jsonb,
    body:='{"source": "cron"}'::jsonb
  ) as request_id$$
);

-- Schedule overdue invoice updates daily at 7 AM UTC
SELECT cron.schedule(
  'update-overdue-invoices-daily',
  '0 7 * * *',
  $$SELECT net.http_post(
    url:='https://jkszmrroyjfdwokbkzis.supabase.co/functions/v1/update-overdue-invoices',
    headers:='{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imprc3ptcnJveWpmZHdva2JremlzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4MzkwMzEsImV4cCI6MjA4MzQxNTAzMX0.iJjPAh8zaed1XbgKnRZp63JLNU37Z72CJPHlSnEPaQc"}'::jsonb,
    body:='{"source": "cron"}'::jsonb
  ) as request_id$$
);

-- Schedule automation processing every 15 minutes
SELECT cron.schedule(
  'process-scheduled-automations',
  '*/15 * * * *',
  $$SELECT net.http_post(
    url:='https://jkszmrroyjfdwokbkzis.supabase.co/functions/v1/process-scheduled-automations',
    headers:='{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imprc3ptcnJveWpmZHdva2JremlzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4MzkwMzEsImV4cCI6MjA4MzQxNTAzMX0.iJjPAh8zaed1XbgKnRZp63JLNU37Z72CJPHlSnEPaQc"}'::jsonb,
    body:='{"source": "cron"}'::jsonb
  ) as request_id$$
);