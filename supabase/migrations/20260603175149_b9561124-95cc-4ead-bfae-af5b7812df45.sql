CREATE OR REPLACE FUNCTION public.has_dashboard_permissions(
  _user_id uuid,
  _perms text[],
  _business_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb := '{}'::jsonb;
  perm text;
BEGIN
  IF _perms IS NULL OR array_length(_perms, 1) IS NULL THEN
    RETURN result;
  END IF;

  FOREACH perm IN ARRAY _perms LOOP
    result := result || jsonb_build_object(
      perm,
      COALESCE(public.has_dashboard_permission(_user_id, perm, _business_id), false)
    );
  END LOOP;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.has_dashboard_permissions(uuid, text[], uuid) TO authenticated;

COMMENT ON FUNCTION public.has_dashboard_permissions(uuid, text[], uuid) IS
'Batch wrapper around has_dashboard_permission. Returns {perm: bool} jsonb for the given perms; semantics are identical to calling the singular function per perm. Used by useDashboardScope to avoid N sequential round-trips on cold dashboard load.';