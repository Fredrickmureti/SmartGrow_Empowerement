-- Create a security definer function to check if user has a specific role in an organization
CREATE OR REPLACE FUNCTION public.has_org_role(_user_id uuid, _organization_id uuid, _role app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND organization_id = _organization_id
      AND role = _role
      AND is_active = true
  )
$$;

-- Create a function to check if user has any of the specified roles in an organization
CREATE OR REPLACE FUNCTION public.has_any_org_role(_user_id uuid, _organization_id uuid, _roles app_role[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND organization_id = _organization_id
      AND role = ANY(_roles)
      AND is_active = true
  )
$$;

-- Create a function to get user's role in an organization
CREATE OR REPLACE FUNCTION public.get_user_org_role(_user_id uuid, _organization_id uuid)
RETURNS app_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role
  FROM public.user_roles
  WHERE user_id = _user_id
    AND organization_id = _organization_id
    AND is_active = true
  LIMIT 1
$$;

-- Drop existing policies that might conflict
DROP POLICY IF EXISTS "Owners can update member roles" ON public.user_roles;
DROP POLICY IF EXISTS "Admins can update non-admin member roles" ON public.user_roles;
DROP POLICY IF EXISTS "Owners and admins can deactivate members" ON public.user_roles;

-- Create RLS policy for owners to update roles (except promoting to owner)
CREATE POLICY "Owners can update member roles"
ON public.user_roles
FOR UPDATE
TO authenticated
USING (
  public.has_org_role(auth.uid(), organization_id, 'owner')
  AND user_id != auth.uid()  -- Cannot update own role
)
WITH CHECK (
  role != 'owner'  -- Cannot promote anyone to owner
  AND role != 'super_admin'  -- Cannot promote to super_admin
);

-- Create RLS policy for admins to update roles (only staff/viewer/accountant)
CREATE POLICY "Admins can update non-admin member roles"
ON public.user_roles
FOR UPDATE
TO authenticated
USING (
  public.has_org_role(auth.uid(), organization_id, 'admin')
  AND user_id != auth.uid()  -- Cannot update own role
  AND NOT public.has_any_org_role(user_id, organization_id, ARRAY['owner'::app_role, 'admin'::app_role])  -- Cannot update owners or other admins
)
WITH CHECK (
  role IN ('accountant', 'staff', 'viewer')  -- Can only set to these roles
);