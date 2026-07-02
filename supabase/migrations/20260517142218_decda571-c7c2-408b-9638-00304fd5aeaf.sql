
CREATE OR REPLACE FUNCTION public._assert_org_member(p_org uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.user_business_access WHERE organization_id = p_org AND user_id = auth.uid()) THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.organizations WHERE id = p_org AND owner_user_id = auth.uid()) THEN
    RETURN;
  END IF;
  RAISE EXCEPTION 'Not a member of organization %', p_org USING ERRCODE = '42501';
END;
$$;
