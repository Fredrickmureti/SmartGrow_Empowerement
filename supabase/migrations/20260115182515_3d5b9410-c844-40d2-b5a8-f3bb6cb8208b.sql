-- Drop and recreate the function to handle slug uniqueness internally
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
  final_slug TEXT;
  slug_exists BOOLEAN;
  attempts INTEGER := 0;
  max_attempts INTEGER := 10;
BEGIN
  -- Get the current user's ID
  calling_user_id := auth.uid();
  
  IF calling_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  -- Generate unique slug (check all organizations, not just user-visible ones)
  final_slug := org_slug;
  
  LOOP
    SELECT EXISTS (
      SELECT 1 FROM public.organizations WHERE slug = final_slug
    ) INTO slug_exists;
    
    EXIT WHEN NOT slug_exists;
    
    attempts := attempts + 1;
    IF attempts >= max_attempts THEN
      RAISE EXCEPTION 'Could not generate a unique organization URL. Please try a different name.';
    END IF;
    
    -- Append random suffix
    final_slug := org_slug || '-' || substr(md5(random()::text), 1, 4);
  END LOOP;
  
  -- Insert organization with unique slug
  INSERT INTO public.organizations (name, slug)
  VALUES (org_name, final_slug)
  RETURNING * INTO new_org;
  
  -- Insert owner role for the current user
  INSERT INTO public.user_roles (user_id, organization_id, role)
  VALUES (calling_user_id, new_org.id, 'owner');
  
  RETURN new_org;
END;
$$;