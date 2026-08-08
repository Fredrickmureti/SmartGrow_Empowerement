SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'expire-stale-estimates';

SELECT cron.schedule(
  'expire-stale-estimates',
  '15 1 * * *',
  $$SELECT public.expire_stale_estimates();$$
);