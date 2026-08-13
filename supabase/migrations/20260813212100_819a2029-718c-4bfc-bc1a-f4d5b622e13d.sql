REVOKE ALL ON FUNCTION public._landed_cost_post_apply(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._landed_cost_post_apply(uuid, uuid) TO service_role;