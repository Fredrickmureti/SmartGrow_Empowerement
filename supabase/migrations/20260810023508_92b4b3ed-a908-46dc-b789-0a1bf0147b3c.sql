CREATE OR REPLACE FUNCTION public.fetch_collector_assignments_with_names(_org_id uuid)
RETURNS TABLE (
  id uuid,
  contact_id uuid,
  collector_user_id uuid,
  active boolean,
  assigned_at timestamptz,
  collector_name text,
  collector_email text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    ca.id,
    ca.contact_id,
    ca.collector_user_id,
    ca.active,
    ca.assigned_at,
    COALESCE(au.raw_user_meta_data->>'full_name', split_part(au.email, '@', 1), 'Unknown') AS collector_name,
    au.email AS collector_email
  FROM public.collector_assignments ca
  JOIN auth.users au ON au.id = ca.collector_user_id
  WHERE ca.organization_id = _org_id
    AND ca.active = true
    AND public.is_org_member(auth.uid(), _org_id);
$$;

GRANT EXECUTE ON FUNCTION public.fetch_collector_assignments_with_names(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.fetch_org_members(_org_id uuid)
RETURNS TABLE (
  user_id uuid,
  full_name text,
  email text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    ur.user_id,
    COALESCE(au.raw_user_meta_data->>'full_name', split_part(au.email, '@', 1), 'Unknown') AS full_name,
    au.email
  FROM public.user_roles ur
  JOIN auth.users au ON au.id = ur.user_id
  WHERE ur.organization_id = _org_id
    AND ur.is_active = true
    AND public.is_org_member(auth.uid(), _org_id)
  ORDER BY full_name;
$$;

GRANT EXECUTE ON FUNCTION public.fetch_org_members(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';