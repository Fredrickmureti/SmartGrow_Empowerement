-- Drop the existing restrictive delete policy
DROP POLICY IF EXISTS "Users can delete draft estimates" ON public.estimates;

-- Create a new policy that allows:
-- 1. Any user to delete draft estimates in their org
-- 2. Admins (admin, owner, super_admin) to delete any estimate in their org
CREATE POLICY "Users can delete estimates" ON public.estimates
FOR DELETE
USING (
  organization_id IN (SELECT get_user_organizations(auth.uid()))
  AND (
    status = 'draft'
    OR EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE ur.user_id = auth.uid()
      AND ur.organization_id = estimates.organization_id
      AND ur.role IN ('admin', 'owner', 'super_admin')
      AND ur.is_active = true
    )
  )
);