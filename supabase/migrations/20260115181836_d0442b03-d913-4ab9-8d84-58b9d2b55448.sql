-- Create atomic organization creation function that bypasses RLS timing issues
CREATE OR REPLACE FUNCTION public.create_organization_with_owner(
  org_name TEXT,
  org_slug TEXT
)
RETURNS public.organizations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_org public.organizations;
  calling_user_id uuid;
BEGIN
  -- Get the current user's ID
  calling_user_id := auth.uid();
  
  IF calling_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  -- Insert organization
  INSERT INTO public.organizations (name, slug)
  VALUES (org_name, org_slug)
  RETURNING * INTO new_org;
  
  -- Insert owner role for the current user
  INSERT INTO public.user_roles (user_id, organization_id, role)
  VALUES (calling_user_id, new_org.id, 'owner');
  
  RETURN new_org;
END;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION public.create_organization_with_owner(TEXT, TEXT) TO authenticated;