SELECT cron.schedule(
  'snapshot-project-burndown-daily',
  '30 2 * * *',
  $$ SELECT public.snapshot_all_active_burndowns(); $$
);