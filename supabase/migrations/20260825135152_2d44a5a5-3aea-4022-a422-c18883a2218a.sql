DROP FUNCTION IF EXISTS public.project_add_member(uuid, uuid, text, numeric);

REVOKE ALL ON FUNCTION public.project_add_member(uuid, uuid, text, numeric, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.project_add_member(uuid, uuid, text, numeric, boolean, boolean) TO authenticated;