-- 1. Branch scope on scheduled deliveries -------------------------------
ALTER TABLE public.scheduled_reports
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;

ALTER TABLE public.report_generation_logs
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS scheduled_reports_branch_idx
  ON public.scheduled_reports(branch_id) WHERE branch_id IS NOT NULL;

COMMENT ON COLUMN public.scheduled_reports.branch_id IS
  'Optional branch scope for the delivered report. NULL means the whole business. The processor threads this into the ledger engines so a scheduled PDF matches the on-screen run.';

-- 2. Archive retention ---------------------------------------------------
CREATE OR REPLACE FUNCTION public.cleanup_report_generation_logs(_retention_days integer DEFAULT 400)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  removed integer;
BEGIN
  IF _retention_days < 30 THEN
    RAISE EXCEPTION 'report delivery history must be kept for at least 30 days (got %)', _retention_days;
  END IF;

  DELETE FROM public.report_generation_logs
   WHERE created_at < now() - make_interval(days => _retention_days);

  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_report_generation_logs(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_report_generation_logs(integer) TO service_role;

SELECT cron.schedule(
  'cleanup-report-generation-logs-daily',
  '35 3 * * *',
  $cron$ SELECT public.cleanup_report_generation_logs(400); $cron$
)
WHERE NOT EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'cleanup-report-generation-logs-daily'
);