REVOKE ALL ON public.branch_operational_days FROM anon, authenticated;
REVOKE ALL ON public.branch_day_events FROM anon, authenticated;
GRANT SELECT ON public.branch_operational_days TO authenticated;
GRANT SELECT ON public.branch_day_events TO authenticated;
GRANT ALL ON public.branch_operational_days TO service_role;
GRANT ALL ON public.branch_day_events TO service_role;