REVOKE ALL ON FUNCTION public.timesheet_effective_settings(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.timesheet_effective_settings(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.timesheet_effective_settings(uuid, uuid) TO authenticated, service_role;