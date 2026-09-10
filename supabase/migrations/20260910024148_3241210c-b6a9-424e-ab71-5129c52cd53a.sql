CREATE OR REPLACE FUNCTION public.mf_can_scoped(_business_id uuid, _branch_id uuid, _module text, _operation text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.mf_can(_business_id, _branch_id, _module, _operation);
$$;

REVOKE ALL ON FUNCTION public.mf_can_scoped(uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mf_can_scoped(uuid, uuid, text, text) TO authenticated, service_role;