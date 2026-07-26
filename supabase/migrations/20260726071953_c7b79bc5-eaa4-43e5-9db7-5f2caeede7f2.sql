-- Expire stale hardware jobs every minute instead of once a day.
-- Jobs whose deadline has passed were left "queued" for hours, so the
-- device page could never tell a live queue from an abandoned one.
select cron.schedule(
  'edge_jobs_expire_stale_minutely',
  '* * * * *',
  $$SELECT public.edge_jobs_expire_stale();$$
);

-- One-off cleanup of the jobs that already blew their deadline.
select public.edge_jobs_expire_stale();