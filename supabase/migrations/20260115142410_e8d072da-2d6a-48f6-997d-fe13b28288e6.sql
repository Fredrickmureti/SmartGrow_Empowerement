-- Drop the buggy policy that has incorrect column reference
DROP POLICY IF EXISTS "Users can assign themselves as owner of new organizations" ON public.user_roles;

-- Create corrected policy with explicit reference to NEW row (user_roles.organization_id)
CREATE POLICY "Users can self-assign as owner of new organizations"
ON public.user_roles
FOR INSERT
TO authenticated
WITH CHECK (
  -- Must be inserting for themselves
  user_id = auth.uid()
  -- Must be the owner role
  AND role = 'owner'
  -- No existing owner for THIS specific organization
  AND NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.organization_id = user_roles.organization_id
    AND ur.role = 'owner'
  )
);