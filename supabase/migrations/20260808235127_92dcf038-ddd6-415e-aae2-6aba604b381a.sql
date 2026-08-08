SELECT cron.unschedule('expire-overdue-proformas')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'expire-overdue-proformas');

SELECT cron.schedule(
  'expire-overdue-proformas',
  '15 1 * * *',
  $$SELECT public.expire_overdue_proformas();$$
);