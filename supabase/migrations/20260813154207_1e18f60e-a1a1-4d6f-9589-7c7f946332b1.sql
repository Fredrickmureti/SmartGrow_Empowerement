CREATE OR REPLACE FUNCTION public.landed_cost_selftest_run(p_business uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_actor::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  r := public.landed_cost_selftest(p_business, p_actor);
  PERFORM set_config('role', 'none', true);
  RETURN r;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.landed_cost_selftest_run(uuid, uuid) TO postgres, authenticated, service_role;