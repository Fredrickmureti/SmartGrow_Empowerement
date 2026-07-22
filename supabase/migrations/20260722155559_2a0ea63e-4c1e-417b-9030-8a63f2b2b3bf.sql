
-- Extend payroll_run_jobs with observability + heartbeat columns.
ALTER TABLE public.payroll_run_jobs
  ADD COLUMN IF NOT EXISTS phase text,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS progress_current integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS progress_total integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz;

-- Ensure REPLICA IDENTITY FULL so realtime carries full old/new rows.
ALTER TABLE public.payroll_run_jobs REPLICA IDENTITY FULL;

-- Make sure realtime publication includes this table (idempotent).
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.payroll_run_jobs;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;

-- Stale-job sweeper: any 'running' job whose heartbeat is older than 5 minutes
-- is presumed dead (edge function killed, isolate recycled). Flip to 'failed'
-- with a structured reason so the UI shows an actionable state instead of
-- hanging indefinitely.
CREATE OR REPLACE FUNCTION public.payroll_sweep_stale_jobs()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE public.payroll_run_jobs
     SET status = 'failed',
         finished_at = now(),
         error_code = 'WORKER_STALE',
         error_message = 'Payroll worker went silent for more than 5 minutes. The run was marked failed automatically; retry when you are ready.',
         updated_at = now()
   WHERE status = 'running'
     AND COALESCE(heartbeat_at, started_at, created_at) < now() - interval '5 minutes';
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

REVOKE ALL ON FUNCTION public.payroll_sweep_stale_jobs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payroll_sweep_stale_jobs() TO service_role;

-- Register a per-minute cron sweep (safe if pg_cron isn't installed).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('payroll-sweep-stale-jobs')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'payroll-sweep-stale-jobs');
    PERFORM cron.schedule(
      'payroll-sweep-stale-jobs',
      '* * * * *',
      $cron$SELECT public.payroll_sweep_stale_jobs();$cron$
    );
  END IF;
END $$;

-- Cancellation RPC. Sets the flag; the worker checks it between employees.
CREATE OR REPLACE FUNCTION public.payroll_request_cancel(p_job_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.payroll_run_jobs
     SET cancel_requested_at = now(),
         updated_at = now()
   WHERE id = p_job_id
     AND status IN ('queued','running')
     AND organization_id IN (
       SELECT organization_id FROM public.user_business_access WHERE user_id = auth.uid()
     );
END;
$$;

REVOKE ALL ON FUNCTION public.payroll_request_cancel(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payroll_request_cancel(uuid) TO authenticated;
