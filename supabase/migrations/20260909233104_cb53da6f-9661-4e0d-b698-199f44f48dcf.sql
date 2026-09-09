GRANT SELECT ON public.branch_operational_days TO authenticated;
GRANT SELECT ON public.branch_day_events TO authenticated;
GRANT ALL ON public.branch_operational_days TO service_role;
GRANT ALL ON public.branch_day_events TO service_role;

DROP INDEX IF EXISTS public.idx_branch_operational_days_open;
CREATE UNIQUE INDEX branch_operational_days_one_open_per_branch
  ON public.branch_operational_days (branch_id)
  WHERE status = 'open';