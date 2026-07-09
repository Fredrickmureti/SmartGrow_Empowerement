-- Physical Count governance compatibility wrappers
-- The prior migration updated the newer overloads but left legacy overloads in place.
-- PostgREST can route calls without p_allow_self / p_tolerance_override_reason to those stale overloads,
-- so all legacy signatures now delegate into the governed implementations.

CREATE OR REPLACE FUNCTION public.physical_count_submit(
  p_count_id uuid,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN public.physical_count_submit(p_count_id, p_user_id, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.physical_count_approve(
  p_count_id uuid,
  p_user_id uuid,
  p_allow_self boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN public.physical_count_approve(p_count_id, p_user_id, p_allow_self, NULL::text);
END;
$$;

CREATE OR REPLACE FUNCTION public.physical_count_post(
  p_count_id uuid,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN public.physical_count_post(p_count_id, p_user_id, false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.physical_count_submit(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.physical_count_approve(uuid, uuid, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.physical_count_post(uuid, uuid) TO authenticated, service_role;