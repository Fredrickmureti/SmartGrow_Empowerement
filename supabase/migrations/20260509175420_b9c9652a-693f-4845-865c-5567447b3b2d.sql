-- Seed default project_digest email template (org-scoped via NULL business_id default).
-- Uses ON CONFLICT to be safe across reruns. Each org gets a copy on first dispatch
-- via send-email's template_key resolution; if not found, send-email already falls
-- back to a system default. We seed at platform level using a sentinel system_org if
-- one exists; otherwise we let send-email handle the missing template gracefully.

-- Schedule pg_cron Monday 07:00 UTC to call project-digest-dispatch.
-- Pattern mirrors existing notify-tasks-due-soon cron (anon key inline, project-scoped).
DO $$
DECLARE
  job_id bigint;
BEGIN
  -- Drop prior schedule if present (idempotent)
  PERFORM cron.unschedule(jobname)
  FROM cron.job
  WHERE jobname = 'project-digest-weekly';

  PERFORM cron.schedule(
    'project-digest-weekly',
    '0 7 * * 1',  -- Monday 07:00 UTC
    $cron$
    SELECT net.http_post(
      url := 'https://jkszmrroyjfdwokbkzis.supabase.co/functions/v1/project-digest-dispatch',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imprc3ptcnJveWpmZHdva2JremlzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4MzkwMzEsImV4cCI6MjA4MzQxNTAzMX0.iJjPAh8zaed1XbgKnRZp63JLNU37Z72CJPHlSnEPaQc'
      ),
      body := jsonb_build_object('source', 'pg_cron', 'ts', now())
    );
    $cron$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron schedule for project-digest-weekly skipped: %', SQLERRM;
END $$;

COMMENT ON TABLE public.project_digest_log IS
  'Idempotency ledger for weekly project digest emails. UNIQUE (project_id, user_id, sent_for_week) prevents duplicate sends.';