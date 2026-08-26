
REVOKE ALL ON FUNCTION public._timesheet_can_approve(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._timesheet_can_approve(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public._timesheet_can_approve(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public._timesheet_can_approve(uuid, uuid) TO service_role;
