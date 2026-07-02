-- Repair broken cron jobs for nightly integrity checks.
-- Previous schedule had a literal '<YOUR_SERVICE_ROLE_KEY>' placeholder, causing
-- silent nightly failures. Reschedule with the project anon key (the function
-- itself uses SUPABASE_SERVICE_ROLE_KEY via env for any privileged work).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'nightly-integrity-check') THEN
    PERFORM cron.unschedule('nightly-integrity-check');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'check-accounting-integrity-nightly') THEN
    PERFORM cron.unschedule('check-accounting-integrity-nightly');
  END IF;
END$$;

SELECT cron.schedule(
  'nightly-integrity-check',
  '15 2 * * *',
  $$
  SELECT net.http_post(
    url := 'https://jkszmrroyjfdwokbkzis.supabase.co/functions/v1/nightly-integrity-check',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imprc3ptcnJveWpmZHdva2JremlzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4MzkwMzEsImV4cCI6MjA4MzQxNTAzMX0.iJjPAh8zaed1XbgKnRZp63JLNU37Z72CJPHlSnEPaQc'
    ),
    body := jsonb_build_object('triggered_at', now()::text)
  );
  $$
);

SELECT cron.schedule(
  'check-accounting-integrity-nightly',
  '0 2 * * *',
  $$
  SELECT net.http_post(
    url := 'https://jkszmrroyjfdwokbkzis.supabase.co/functions/v1/check-accounting-integrity',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imprc3ptcnJveWpmZHdva2JremlzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4MzkwMzEsImV4cCI6MjA4MzQxNTAzMX0.iJjPAh8zaed1XbgKnRZp63JLNU37Z72CJPHlSnEPaQc'
    ),
    body := jsonb_build_object('triggered_at', now()::text)
  );
  $$
);

-- Seed the drift report table with one immediate run so we can verify it works.
SELECT net.http_post(
  url := 'https://jkszmrroyjfdwokbkzis.supabase.co/functions/v1/nightly-integrity-check',
  headers := jsonb_build_object(
    'Content-Type','application/json',
    'Authorization','Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imprc3ptcnJveWpmZHdva2JremlzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4MzkwMzEsImV4cCI6MjA4MzQxNTAzMX0.iJjPAh8zaed1XbgKnRZp63JLNU37Z72CJPHlSnEPaQc'
  ),
  body := '{"manual_seed":true}'::jsonb
);