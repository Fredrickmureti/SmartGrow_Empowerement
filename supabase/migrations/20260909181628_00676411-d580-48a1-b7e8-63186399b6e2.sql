ALTER FUNCTION public.branch_day_events_append_only() SECURITY INVOKER;
REVOKE ALL ON FUNCTION public.branch_day_events_append_only() FROM PUBLIC, anon, authenticated;