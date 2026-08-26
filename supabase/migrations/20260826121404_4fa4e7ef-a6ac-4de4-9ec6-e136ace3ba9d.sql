REVOKE ALL ON FUNCTION public.guard_timesheet_self_approval() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_timesheet_self_approval() TO service_role;

REVOKE ALL ON FUNCTION public.tg_business_event_outbox_react_timesheet() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tg_business_event_outbox_react_timesheet() TO service_role;