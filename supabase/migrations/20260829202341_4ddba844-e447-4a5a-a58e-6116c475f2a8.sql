CREATE OR REPLACE FUNCTION public.__replay_exec(p_sql text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  EXECUTE p_sql;
END;
$$;

REVOKE ALL ON FUNCTION public.__replay_exec(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.__replay_exec(text) TO service_role;