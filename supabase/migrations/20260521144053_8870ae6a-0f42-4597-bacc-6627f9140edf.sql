
-- Hardware exec log retention: prune rows older than 30 days, scheduled daily.

CREATE OR REPLACE FUNCTION public.cleanup_old_hardware_exec_log()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM public.hardware_exec_log
   WHERE created_at < now() - interval '30 days';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_old_hardware_exec_log() FROM PUBLIC;

-- Schedule daily at 03:17 UTC. Unschedule first for idempotency.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-hardware-exec-log-daily') THEN
    PERFORM cron.unschedule('cleanup-hardware-exec-log-daily');
  END IF;
  PERFORM cron.schedule(
    'cleanup-hardware-exec-log-daily',
    '17 3 * * *',
    $cron$ SELECT public.cleanup_old_hardware_exec_log(); $cron$
  );
END $$;
