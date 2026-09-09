REVOKE ALL ON FUNCTION public.mf_open_group_meeting(uuid, date, time, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mf_complete_group_meeting(uuid, text, time, time, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mf_open_group_meeting(uuid, date, time, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mf_complete_group_meeting(uuid, text, time, time, uuid) TO authenticated, service_role;