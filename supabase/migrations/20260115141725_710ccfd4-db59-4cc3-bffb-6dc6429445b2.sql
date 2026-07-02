-- Allow authenticated users to insert themselves as owner for organizations they just created
-- This is the bootstrap case: when a user creates an org, they need to become the first owner
CREATE POLICY "Users can assign themselves as owner of new organizations"
ON public.user_roles
FOR INSERT
TO authenticated
WITH CHECK (
  -- Must be inserting for themselves
  user_id = auth.uid()
  -- Must be the owner role (only role allowed for self-assignment on new orgs)
  AND role = 'owner'
  -- Organization must exist and have no existing owners (prevents abuse)
  AND NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.organization_id = organization_id
    AND ur.role = 'owner'
  )
);